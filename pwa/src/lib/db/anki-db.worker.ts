/// <reference lib="webworker" />

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Database, Sqlite3Static, SqlValue } from "@sqlite.org/sqlite-wasm";
import { unzipSync } from "fflate";
import { Rating, State, default_w, fsrs } from "ts-fsrs";
import type { CardInput, Grade, RecordLogItem, StepUnit } from "ts-fsrs";

import { clozeOrdinals, renderAnkiCard } from "../anki/template";
import type { AnkiNotetype } from "../anki/template";
import { buildCollectionPackage } from "../anki/export-colpkg";
import type { BackupMediaFile } from "../anki/export-colpkg";
import { importApkg } from "../anki/import-apkg";
import type { ImportMediaStore } from "../anki/import-apkg";
import { readApkg } from "../anki/apkg";
import { mediaReferences } from "../anki/media-references";
import { deckScopeIds, deleteDeck as deleteStoredDeck, moveCard as moveStoredCard, renameDeck as renameStoredDeck } from "./deck-management";
import type {
  AnswerCardResult,
  BrowseNotesResult,
  BrowserOptions,
  BrowserResults,
  BrowserMetadata,
  BrowserCard,
  BrowserNote,
  CardState,
  CollectionBackupResult,
  CollectionRestoreResult,
  CollectionStats,
  DbRequest,
  DbResponse,
  DeckSummary,
  DeckOptions,
  DeckOptionsInput,
  DeckPresetSummary,
  LocalCollectionInfo,
  MediaCleanupResult,
  MediaOverview,
  NoteTypeDetails,
  NoteTypeField,
  NoteTypeInput,
  NoteTypeSummary,
  NoteTypeTemplate,
  ReviewRating,
  StudyCard
} from "./types";

import { browserSearch } from "./browser-search";

const SCHEMA_VERSION = 11;
const BASIC_NOTETYPE_ID = 1_600_000_000_000;
const CLOZE_NOTETYPE_ID = 1_600_000_000_001;
const REVERSED_NOTETYPE_ID = 1_600_000_000_002;
const OPTIONAL_REVERSED_NOTETYPE_ID = 1_600_000_000_003;
const TYPING_NOTETYPE_ID = 1_600_000_000_004;
const IMAGE_OCCLUSION_NOTETYPE_ID = 1_600_000_000_005;
const DEFAULT_DECK_ID = 1;
const FIELD_SEPARATOR = "\u001f";
const REQUEST_RETENTION = 0.9;
const DEFAULT_MEDIA_DIRECTORY = "anki-pwa-media-v2";
const MEDIA_DIRECTORY_POINTER = "anki-pwa-media-active-v1";


type AnkiDeck = {
  id: number;
  name: string;
  mod: number;
  usn: number;
  dyn: number;
  conf: number;
  [key: string]: unknown;
};

type StoredCardData = {
  s?: number;
  d?: number;
  dr?: number;
  decay?: number;
  lrt?: number;
};

let db: Database | null = null;
let sqliteRuntime: Sqlite3Static | null = null;
let initPromise: Promise<LocalCollectionInfo> | null = null;
const memoryMedia = new Map<string, Uint8Array>();
let activeMediaDirectory: string | null = null;

type ReviewUndo = {
  cardId: number;
  reviewId: number;
  card: {
    mod: number; usn: number; type: number; queue: number; due: number; ivl: number; factor: number;
    reps: number; lapses: number; left: number; odue: number; odid: number; flags: number; data: string;
  };
  siblings: Array<{ id: number; mod: number; usn: number; queue: number }>;
  leechNote: { id: number; tags: string; mod: number; usn: number } | null;
};

let lastReviewUndo: ReviewUndo | null = null;

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

function disableProxyBasedOpfsVfses() {
  const sqliteGlobal = globalThis as typeof globalThis & {
    sqlite3ApiConfig?: { disable: { vfs: Record<string, boolean> } };
  };

  // Next/Webpack's URL shim drops query parameters added after construction.
  // The proxy VFSes require one on their nested worker, so use the bundler-safe
  // SAH-pool VFS instead.
  sqliteGlobal.sqlite3ApiConfig = {
    disable: { vfs: { opfs: true, "opfs-wl": true } }
  };
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function collectionCreationSeconds() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return Math.floor(start.getTime() / 1000);
}

function defaultDeck(mod: number): AnkiDeck {
  return {
    id: DEFAULT_DECK_ID,
    name: "Default",
    mod,
    usn: -1,
    lrnToday: [0, 0],
    revToday: [0, 0],
    newToday: [0, 0],
    timeToday: [0, 0],
    collapsed: false,
    browserCollapsed: false,
    desc: "",
    dyn: 0,
    conf: 1,
    extendNew: 0,
    extendRev: 0
  };
}

function basicNotetype(mod: number): AnkiNotetype {
  return {
    id: BASIC_NOTETYPE_ID,
    name: "Basic",
    type: 0,
    mod,
    usn: -1,
    sortf: 0,
    originalStockKind: 1,
    did: null,
    tmpls: [
      {
        name: "Card 1",
        ord: 0,
        qfmt: "{{Front}}",
        afmt: "{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}",
        bqfmt: "",
        bafmt: "",
        did: null,
        bfont: "Arial",
        bsize: 12
      }
    ],
    flds: [
      { name: "Front", ord: 0, sticky: false, rtl: false, font: "Arial", size: 20 },
      { name: "Back", ord: 1, sticky: false, rtl: false, font: "Arial", size: 20 }
    ],
    css: ".card { font-family: Arial; font-size: 20px; text-align: center; color: black; background: white; }",
    latexPre: "",
    latexPost: "",
    latexsvg: false,
    req: [[0, "any", [0]]]
  };
}

function reversedNotetype(mod: number): AnkiNotetype {
  const notetype = basicNotetype(mod);
  return {
    ...notetype,
    id: REVERSED_NOTETYPE_ID,
    name: "Basic (and reversed card)",
    originalStockKind: 2,
    tmpls: [
      ...notetype.tmpls,
      {
        name: "Card 2",
        ord: 1,
        qfmt: "{{Back}}",
        afmt: "{{FrontSide}}\n\n<hr id=answer>\n\n{{Front}}",
        bqfmt: "",
        bafmt: "",
        did: null,
        bfont: "Arial",
        bsize: 12
      }
    ],
    req: [[0, "any", [0]], [1, "any", [1]]]
  };
}

function optionalReversedNotetype(mod: number): AnkiNotetype {
  const notetype = reversedNotetype(mod);
  return {
    ...notetype,
    id: OPTIONAL_REVERSED_NOTETYPE_ID,
    name: "Basic (optional reversed card)",
    originalStockKind: 3,
    flds: [...notetype.flds, { name: "Add Reverse", ord: 2, sticky: false, rtl: false, font: "Arial", size: 20 }],
    tmpls: notetype.tmpls.map((template, index) => index === 1
      ? { ...template, qfmt: "{{#Add Reverse}}{{Back}}{{/Add Reverse}}" }
      : template),
    req: [[0, "any", [0]], [1, "all", [1, 2]]]
  };
}

function typingNotetype(mod: number): AnkiNotetype {
  const notetype = basicNotetype(mod);
  return {
    ...notetype,
    id: TYPING_NOTETYPE_ID,
    name: "Basic (type in the answer)",
    originalStockKind: 4,
    tmpls: [{
      ...notetype.tmpls[0],
      qfmt: "{{Front}}\n\n{{type:Back}}",
      afmt: "{{Front}}\n\n<hr id=answer>\n\n{{type:Back}}"
    }]
  };
}

function clozeNotetype(mod: number): AnkiNotetype {
  return {
    id: CLOZE_NOTETYPE_ID,
    name: "Cloze",
    type: 1,
    mod,
    usn: -1,
    sortf: 0,
    originalStockKind: 5,
    did: null,
    tmpls: [
      {
        name: "Cloze",
        ord: 0,
        qfmt: "{{cloze:Text}}",
        afmt: "{{cloze:Text}}<br>{{Back Extra}}",
        bqfmt: "",
        bafmt: "",
        did: null,
        bfont: "Arial",
        bsize: 12
      }
    ],
    flds: [
      { name: "Text", ord: 0, sticky: false, rtl: false, font: "Arial", size: 20 },
      { name: "Back Extra", ord: 1, sticky: false, rtl: false, font: "Arial", size: 20 }
    ],
    css: ".card { font-family: Arial; font-size: 20px; text-align: center; color: black; background: white; } .cloze { font-weight: bold; color: #1f6fd1; }",
    latexPre: "",
    latexPost: "",
    latexsvg: false,
    req: [[0, "any", [0]]]
  };
}

function imageOcclusionNotetype(mod: number): AnkiNotetype {
  return {
    id: IMAGE_OCCLUSION_NOTETYPE_ID,
    name: "Image Occlusion",
    type: 1,
    mod,
    usn: -1,
    sortf: 0,
    did: null,
    originalStockKind: 6,
    tmpls: [{
      name: "Image Occlusion",
      ord: 0,
      qfmt: "{{#Header}}<div>{{Header}}</div>{{/Header}}\n<div style=\"display:none\">{{cloze:Occlusion}}</div>\n<div id=\"image-occlusion-container\">{{Image}}<canvas id=\"image-occlusion-canvas\"></canvas></div>",
      afmt: "{{FrontSide}}\n{{#Back Extra}}<div>{{Back Extra}}</div>{{/Back Extra}}",
      bqfmt: "",
      bafmt: "",
      did: null,
      bfont: "Arial",
      bsize: 12
    }],
    flds: [
      { name: "Occlusion", ord: 0, tag: 0, sticky: false, rtl: false, font: "Arial", size: 20 },
      { name: "Image", ord: 1, tag: 1, sticky: false, rtl: false, font: "Arial", size: 20 },
      { name: "Header", ord: 2, tag: 2, sticky: false, rtl: false, font: "Arial", size: 20 },
      { name: "Back Extra", ord: 3, tag: 3, sticky: false, rtl: false, font: "Arial", size: 20 },
      { name: "Comments", ord: 4, tag: 4, sticky: false, rtl: false, font: "Arial", size: 20 }
    ],
    css: "#image-occlusion-canvas{--inactive-shape-color:#ffeba2;--active-shape-color:#ff8e8e;--inactive-shape-border:1px #212121;--active-shape-border:1px #212121;--highlight-shape-color:#ff8e8e00;--highlight-shape-border:1px #ff8e8e}.card{font-family:Arial;font-size:20px;text-align:center;color:black;background-color:white}",
    latexPre: "",
    latexPost: "",
    latexsvg: false,
    req: [[0, "any", [0]]]
  };
}

function defaultDeckConfig(mod: number) {
  return {
    1: {
      id: 1,
      mod,
      name: "Default",
      usn: -1,
      maxTaken: 60,
      autoplay: true,
      timer: 0,
      replayq: true,
      dyn: false,
      fsrsParams6: [...default_w],
      desiredRetention: REQUEST_RETENTION,
      newGatherPriority: 0,
      newSortOrder: 0,
      reviewOrder: 0,
      newMix: 0,
      interdayLearningMix: 0,
      buryInterdayLearning: false,
      stopTimerOnAnswer: false,
      secondsToShowQuestion: 0,
      secondsToShowAnswer: 0,
      questionAction: 0,
      answerAction: 0,
      new: { bury: false, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 0], order: 1, perDay: 20 },
      rev: { bury: false, ease4: 1.3, ivlFct: 1, maxIvl: 36500, perDay: 200, hardFactor: 1.2 },
      lapse: { delays: [10], leechAction: 1, leechFails: 8, minInt: 1, mult: 0 }
    }
  };
}

async function initialize(): Promise<LocalCollectionInfo> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    disableProxyBasedOpfsVfses();
    const sqlite3 = await sqlite3InitModule();
    sqliteRuntime = sqlite3;

    let database: Database;
    let persistent = false;

    try {
      // V2 intentionally leaves the earlier prototype database intact. This
      // file uses Anki's collection schema instead of the prototype tables.
      const sahPool = await sqlite3.installOpfsSAHPoolVfs({ directory: ".anki-pwa-v2" });
      database = new sahPool.OpfsSAHPoolDb("/collection.anki2");
      persistent = true;
    } catch (error) {
      console.warn("[sqlite] OPFS storage is unavailable; using an in-memory collection", error);
      database = new sqlite3.oo1.DB(":memory:", "c");
    }

    db = database;
    createAnkiSchema(database);
    ensureFsrsConfiguration(database);

    return {
      sqliteVersion: sqlite3.version.libVersion,
      schemaVersion: SCHEMA_VERSION,
      persistent,
      crossOriginIsolated: globalThis.crossOriginIsolated
    };
  })();

  return initPromise;
}

function ensureFsrsConfiguration(database: Database) {
  const conf = JSON.parse(String(database.selectValue("SELECT conf FROM col WHERE id = 1") ?? "{}")) as Record<string, unknown>;
  const deckConfigs = JSON.parse(String(database.selectValue("SELECT dconf FROM col WHERE id = 1") ?? "{}")) as Record<string, Record<string, unknown>>;
  const models = JSON.parse(String(database.selectValue("SELECT models FROM col WHERE id = 1") ?? "{}")) as Record<string, AnkiNotetype>;
  const defaultConfig = deckConfigs["1"];
  let changed = false;

  if (conf.fsrs !== true) {
    conf.fsrs = true;
    changed = true;
  }
  if (conf.fsrsShortTermWithStepsEnabled !== true) {
    conf.fsrsShortTermWithStepsEnabled = true;
    changed = true;
  }
  if (defaultConfig && !Array.isArray(defaultConfig.fsrsParams6)) {
    defaultConfig.fsrsParams6 = [...default_w];
    defaultConfig.desiredRetention = REQUEST_RETENTION;
    changed = true;
  }
  if (!models[String(BASIC_NOTETYPE_ID)]) {
    models[String(BASIC_NOTETYPE_ID)] = basicNotetype(nowSeconds());
    changed = true;
  }
  if (!models[String(CLOZE_NOTETYPE_ID)]) {
    models[String(CLOZE_NOTETYPE_ID)] = clozeNotetype(nowSeconds());
    changed = true;
  }
  for (const notetype of [reversedNotetype(nowSeconds()), optionalReversedNotetype(nowSeconds()),
    typingNotetype(nowSeconds()), imageOcclusionNotetype(nowSeconds())]) {
    const alreadyPresent = Object.values(models).some((model) => Number(model.originalStockKind) === Number(notetype.originalStockKind));
    if (alreadyPresent) continue;
    while (models[String(notetype.id)]) notetype.id += 1;
    models[String(notetype.id)] = notetype;
    changed = true;
  }

  if (changed) {
    database.transaction("IMMEDIATE", (transaction) => {
      transaction.exec({
        sql: "UPDATE col SET conf = ?, dconf = ?, models = ?, mod = ?, usn = -1 WHERE id = 1",
        bind: [JSON.stringify(conf), JSON.stringify(deckConfigs), JSON.stringify(models), nowSeconds()]
      });
    });
  }
}

function createAnkiSchema(database: Database) {
  const exists = Number(
    database.selectValue("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'col'") ?? 0
  );
  if (exists) return;

  const mod = nowSeconds();
  const now = Date.now();
  const decks = { [DEFAULT_DECK_ID]: defaultDeck(mod) };
  const models = {
    [BASIC_NOTETYPE_ID]: basicNotetype(mod),
    [CLOZE_NOTETYPE_ID]: clozeNotetype(mod),
    [REVERSED_NOTETYPE_ID]: reversedNotetype(mod),
    [OPTIONAL_REVERSED_NOTETYPE_ID]: optionalReversedNotetype(mod),
    [TYPING_NOTETYPE_ID]: typingNotetype(mod),
    [IMAGE_OCCLUSION_NOTETYPE_ID]: imageOcclusionNotetype(mod)
  };

  database.transaction("IMMEDIATE", (transaction) => {
    transaction.exec(`
      CREATE TABLE col (
        id integer PRIMARY KEY, crt integer NOT NULL, mod integer NOT NULL,
        scm integer NOT NULL, ver integer NOT NULL, dty integer NOT NULL,
        usn integer NOT NULL, ls integer NOT NULL, conf text NOT NULL,
        models text NOT NULL, decks text NOT NULL, dconf text NOT NULL, tags text NOT NULL
      );
      CREATE TABLE notes (
        id integer PRIMARY KEY, guid text NOT NULL, mid integer NOT NULL,
        mod integer NOT NULL, usn integer NOT NULL, tags text NOT NULL,
        flds text NOT NULL, sfld integer NOT NULL, csum integer NOT NULL,
        flags integer NOT NULL, data text NOT NULL
      );
      CREATE TABLE cards (
        id integer PRIMARY KEY, nid integer NOT NULL, did integer NOT NULL,
        ord integer NOT NULL, mod integer NOT NULL, usn integer NOT NULL,
        type integer NOT NULL, queue integer NOT NULL, due integer NOT NULL,
        ivl integer NOT NULL, factor integer NOT NULL, reps integer NOT NULL,
        lapses integer NOT NULL, left integer NOT NULL, odue integer NOT NULL,
        odid integer NOT NULL, flags integer NOT NULL, data text NOT NULL
      );
      CREATE TABLE revlog (
        id integer PRIMARY KEY, cid integer NOT NULL, usn integer NOT NULL,
        ease integer NOT NULL, ivl integer NOT NULL, lastIvl integer NOT NULL,
        factor integer NOT NULL, time integer NOT NULL, type integer NOT NULL
      );
      CREATE TABLE graves (usn integer NOT NULL, oid integer NOT NULL, type integer NOT NULL);
      CREATE INDEX ix_notes_usn ON notes (usn);
      CREATE INDEX ix_cards_usn ON cards (usn);
      CREATE INDEX ix_revlog_usn ON revlog (usn);
      CREATE INDEX ix_cards_nid ON cards (nid);
      CREATE INDEX ix_cards_sched ON cards (did, queue, due);
      CREATE INDEX ix_revlog_cid ON revlog (cid);
      CREATE INDEX ix_notes_csum ON notes (csum);
      PRAGMA user_version = 11;
    `);
    transaction.exec({
      sql: `INSERT INTO col
        (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags)
        VALUES (1, ?, ?, ?, ?, 0, -1, 0, ?, ?, ?, ?, '{}')`,
      bind: [
        collectionCreationSeconds(),
        mod,
        now,
        SCHEMA_VERSION,
        JSON.stringify({ fsrs: true, fsrsShortTermWithStepsEnabled: true }),
        JSON.stringify(models),
        JSON.stringify(decks),
        JSON.stringify(defaultDeckConfig(mod))
      ]
    });
  });
}

function collection(): Database {
  if (!db) throw new Error("Database failed to initialize");
  return db;
}

function readDecks(database = collection()): Record<string, AnkiDeck> {
  const json = String(database.selectValue("SELECT decks FROM col WHERE id = 1") ?? "{}");
  return JSON.parse(json) as Record<string, AnkiDeck>;
}

type DeckConfigRecord = Record<string, unknown>;

function readDeckConfigs(database = collection()): Record<string, DeckConfigRecord> {
  const json = String(database.selectValue("SELECT dconf FROM col WHERE id = 1") ?? "{}");
  return JSON.parse(json) as Record<string, DeckConfigRecord>;
}

function readCollectionConfig(database = collection()): Record<string, unknown> {
  return JSON.parse(String(database.selectValue("SELECT conf FROM col WHERE id = 1") ?? "{}")) as Record<string, unknown>;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function configuredSteps(value: unknown, fallback: number[]) {
  if (!Array.isArray(value)) return fallback;
  const steps = value.map(Number);
  return steps.every((step) => Number.isFinite(step) && step > 0 && step <= 43_200) ? steps : fallback;
}

const newGatherOrders = ["deck", "ascending", "descending", "randomNotes", "randomCards", "deckRandomNotes"] as const;
const newSortOrders = ["template", "gather", "templateRandom", "randomNote", "randomCard"] as const;
const mixOrders = ["mix", "after", "before"] as const;
const reviewOrders = ["due", "dueDeck", "deckDue", "intervalAscending", "intervalDescending", "easeAscending", "easeDescending",
  "retrievabilityAscending", "random", "added", "reverseAdded", "retrievabilityDescending", "relativeOverdueness"] as const;
const newGatherValues: Record<(typeof newGatherOrders)[number], number> = { deck: 0, ascending: 1, descending: 2, randomNotes: 3, randomCards: 4, deckRandomNotes: 5 };
const newSortValues: Record<(typeof newSortOrders)[number], number> = { template: 0, gather: 1, templateRandom: 2, randomNote: 3, randomCard: 4 };
const reviewOrderValues: Record<(typeof reviewOrders)[number], number> = { due: 0, dueDeck: 1, deckDue: 2, intervalAscending: 3,
  intervalDescending: 4, easeAscending: 5, easeDescending: 6, retrievabilityAscending: 7, random: 8, added: 9,
  reverseAdded: 10, retrievabilityDescending: 11, relativeOverdueness: 12 };

function enumFromNumber<const T extends readonly string[]>(values: T, value: unknown, fallback: T[number]): T[number] {
  const found = values[Number(value)];
  return found ?? fallback;
}

function validatedEnum<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new Error(`${label} is invalid`);
  return value as T[number];
}

function deckConfigFor(database: Database, deck: AnkiDeck) {
  const configs = readDeckConfigs(database);
  return configs[String(deck.conf)] ?? configs[String(DEFAULT_DECK_ID)]
    ?? defaultDeckConfig(nowSeconds())[DEFAULT_DECK_ID];
}

function deckOptionsFor(database: Database, deck: AnkiDeck): DeckOptions {
  const config = deckConfigFor(database, deck);
  const newOptions = recordValue(config.new);
  const reviewOptions = recordValue(config.rev);
  const lapseOptions = recordValue(config.lapse);
  const desiredRetention = boundedNumber(config.desiredRetention, REQUEST_RETENTION, 0.7, 0.99);
  const collectionConfig = readCollectionConfig(database);
  return {
    deckId: deck.id,
    presetId: Number(deck.conf),
    deckName: deck.name,
    presetName: String(config.name || "Default"),
    usingDefaultPreset: Number(deck.conf) === DEFAULT_DECK_ID,
    newCardsPerDay: Math.round(boundedNumber(newOptions.perDay, 20, 0, 9_999)),
    maximumReviewsPerDay: Math.round(boundedNumber(reviewOptions.perDay, 200, 0, 9_999)),
    desiredRetentionPercent: Math.round(desiredRetention * 1_000) / 10,
    maximumIntervalDays: Math.round(boundedNumber(reviewOptions.maxIvl, 36_500, 1, 36_500)),
    learningStepsMinutes: configuredSteps(newOptions.delays, [1, 10]),
    relearningStepsMinutes: configuredSteps(lapseOptions.delays, [10]),
    newCardGatherOrder: enumFromNumber(newGatherOrders, config.newGatherPriority, "deck"),
    newCardSortOrder: enumFromNumber(newSortOrders, config.newSortOrder, "template"),
    newCardReviewOrder: enumFromNumber(mixOrders, config.newMix, "mix"),
    interdayLearningReviewOrder: enumFromNumber(mixOrders, config.interdayLearningMix, "mix"),
    reviewOrder: enumFromNumber(reviewOrders, config.reviewOrder, "due"),
    buryNewSiblings: Boolean(newOptions.bury),
    buryReviewSiblings: Boolean(reviewOptions.bury),
    buryInterdayLearningSiblings: Boolean(config.buryInterdayLearning),
    leechThreshold: Math.round(boundedNumber(lapseOptions.leechFails, 8, 0, 99)),
    leechAction: Number(lapseOptions.leechAction) === 0 ? "suspend" : "tag",
    minimumLapseIntervalDays: Math.round(boundedNumber(lapseOptions.minInt, 1, 1, 36_500)),
    maximumAnswerSeconds: Math.round(boundedNumber(config.maxTaken, 60, 1, 3_600)),
    showAnswerTimer: Number(config.timer) !== 0,
    stopTimerOnAnswer: Boolean(config.stopTimerOnAnswer),
    fsrsWeights: Array.isArray(config.fsrsParams6) && config.fsrsParams6.length === default_w.length
      ? config.fsrsParams6.map(Number) : [...default_w],
    newCardInsertOrder: Number(newOptions.order) === 0 ? "random" : "sequential",
    secondsToShowQuestion: boundedNumber(config.secondsToShowQuestion, 0, 0, 3_600),
    secondsToShowAnswer: boundedNumber(config.secondsToShowAnswer, 0, 0, 3_600),
    questionTimeAction: Number(config.questionAction) === 1 ? "reminder" : "showAnswer",
    answerTimeAction: (["bury", "again", "good", "hard", "reminder"] as const)[Number(config.answerAction)] ?? "bury",
    newCardsIgnoreReviewLimit: Boolean(collectionConfig.newCardsIgnoreReviewLimit),
    limitsStartFromTop: Boolean(collectionConfig.applyAllParentLimits)
  };
}

function validatedDeckOptions(input: DeckOptionsInput): DeckOptionsInput {
  const integer = (value: unknown, label: string, minimum: number, maximum: number) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
      throw new Error(`${label} must be a whole number from ${minimum} to ${maximum}`);
    }
    return number;
  };
  const steps = (value: unknown, label: string) => {
    if (!Array.isArray(value) || value.length > 10) throw new Error(`${label} must contain at most 10 steps`);
    return value.map((step) => integer(step, label, 1, 43_200));
  };
  const boolean = (value: unknown, label: string) => {
    if (typeof value !== "boolean") throw new Error(`${label} must be enabled or disabled`);
    return value;
  };
  const decimal = (value: unknown, label: string, minimum: number, maximum: number) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number < minimum || number > maximum) {
      throw new Error(`${label} must be from ${minimum} to ${maximum}`);
    }
    return Math.round(number * 10) / 10;
  };
  const desiredRetentionPercent = Number(input.desiredRetentionPercent);
  if (!Number.isFinite(desiredRetentionPercent) || desiredRetentionPercent < 70 || desiredRetentionPercent > 99) {
    throw new Error("Desired retention must be from 70% to 99%");
  }
  return {
    newCardsPerDay: integer(input.newCardsPerDay, "New cards per day", 0, 9_999),
    maximumReviewsPerDay: integer(input.maximumReviewsPerDay, "Maximum reviews per day", 0, 9_999),
    desiredRetentionPercent: Math.round(desiredRetentionPercent * 10) / 10,
    maximumIntervalDays: integer(input.maximumIntervalDays, "Maximum interval", 1, 36_500),
    learningStepsMinutes: steps(input.learningStepsMinutes, "Learning steps"),
    relearningStepsMinutes: steps(input.relearningStepsMinutes, "Relearning steps"),
    newCardGatherOrder: validatedEnum(input.newCardGatherOrder, newGatherOrders, "New card gather order"),
    newCardSortOrder: validatedEnum(input.newCardSortOrder, newSortOrders, "New card sort order"),
    newCardReviewOrder: validatedEnum(input.newCardReviewOrder, mixOrders, "New card/review order"),
    interdayLearningReviewOrder: validatedEnum(input.interdayLearningReviewOrder, mixOrders, "Interday learning order"),
    reviewOrder: validatedEnum(input.reviewOrder, reviewOrders, "Review order"),
    buryNewSiblings: boolean(input.buryNewSiblings, "Bury new siblings"),
    buryReviewSiblings: boolean(input.buryReviewSiblings, "Bury review siblings"),
    buryInterdayLearningSiblings: boolean(input.buryInterdayLearningSiblings, "Bury interday-learning siblings"),
    leechThreshold: integer(input.leechThreshold, "Leech threshold", 0, 99),
    leechAction: validatedEnum(input.leechAction, ["tag", "suspend"] as const, "Leech action"),
    minimumLapseIntervalDays: integer(input.minimumLapseIntervalDays, "Minimum lapse interval", 1, 36_500),
    maximumAnswerSeconds: integer(input.maximumAnswerSeconds, "Maximum answer time", 1, 3_600),
    showAnswerTimer: boolean(input.showAnswerTimer, "Show answer timer"),
    stopTimerOnAnswer: boolean(input.stopTimerOnAnswer, "Stop timer on answer"),
    fsrsWeights: Array.isArray(input.fsrsWeights) && input.fsrsWeights.length === default_w.length
      && input.fsrsWeights.every((weight) => Number.isFinite(Number(weight))) ? input.fsrsWeights.map(Number)
      : (() => { throw new Error(`FSRS parameters must contain ${default_w.length} numbers`); })(),
    newCardInsertOrder: validatedEnum(input.newCardInsertOrder, ["sequential", "random"] as const, "New card insertion order"),
    secondsToShowQuestion: decimal(input.secondsToShowQuestion, "Question time", 0, 3_600),
    secondsToShowAnswer: decimal(input.secondsToShowAnswer, "Answer time", 0, 3_600),
    questionTimeAction: validatedEnum(input.questionTimeAction, ["showAnswer", "reminder"] as const, "Question time action"),
    answerTimeAction: validatedEnum(input.answerTimeAction, ["bury", "again", "hard", "good", "reminder"] as const, "Answer time action"),
    newCardsIgnoreReviewLimit: boolean(input.newCardsIgnoreReviewLimit, "New cards ignore review limit"),
    limitsStartFromTop: boolean(input.limitsStartFromTop, "Limits start from top")
  };
}

function stepUnits(minutes: number[]): StepUnit[] {
  return minutes.map((step) => `${step}m` as StepUnit);
}

function schedulerForDeck(database: Database, deckId: number) {
  const deck = readDecks(database)[String(deckId)];
  if (!deck || deck.dyn !== 0) throw new Error("Deck not found");
  const config = deckConfigFor(database, deck);
  const options = deckOptionsFor(database, deck);
  return {
    scheduler: fsrs({
      request_retention: options.desiredRetentionPercent / 100,
      maximum_interval: options.maximumIntervalDays,
      w: options.fsrsWeights,
      enable_fuzz: true,
      enable_short_term: true,
      learning_steps: stepUnits(options.learningStepsMinutes),
      relearning_steps: stepUnits(options.relearningStepsMinutes)
    }),
    options
  };
}

function deckActivityToday(database: Database, deckIds: number[]) {
  const placeholders = deckIds.map(() => "?").join(",");
  const creation = Number(database.selectValue("SELECT crt FROM col WHERE id = 1") ?? collectionCreationSeconds());
  const start = (creation + collectionDay(database) * 86_400) * 1_000;
  const introduced = Number(database.selectValue(
    `SELECT count(*) FROM cards c
     WHERE c.did IN (${placeholders})
       AND (SELECT min(first.id) FROM revlog first WHERE first.cid = c.id) >= ?`,
    [...deckIds, start]
  ) ?? 0);
  const reviews = Number(database.selectValue(
    `SELECT count(DISTINCT r.cid) FROM revlog r JOIN cards c ON c.id = r.cid
     WHERE c.did IN (${placeholders}) AND r.id >= ?
       AND (SELECT min(first.id) FROM revlog first WHERE first.cid = r.cid) < ?`,
    [...deckIds, start, start]
  ) ?? 0);
  return { introduced, reviews };
}

function uniqueDeckConfigId(configs: Record<string, DeckConfigRecord>) {
  let id = Date.now();
  while (configs[String(id)]) id += 1;
  return id;
}

async function getDeckOptions(deckId: number): Promise<DeckOptions> {
  await initialize();
  const database = collection();
  const deck = readDecks(database)[String(deckId)];
  if (!deck || deck.dyn !== 0) throw new Error("Deck not found");
  return deckOptionsFor(database, deck);
}

async function listDeckPresets(): Promise<DeckPresetSummary[]> {
  await initialize();
  const database = collection();
  const configs = readDeckConfigs(database);
  const decks = Object.values(readDecks(database));
  return Object.entries(configs).map(([key, config]) => {
    const id = Number(config.id ?? key);
    return { id, name: String(config.name || `Preset ${id}`), useCount: decks.filter((deck) => Number(deck.conf) === id).length,
      isDefault: id === DEFAULT_DECK_ID };
  }).sort((left, right) => left.isDefault ? -1 : right.isDefault ? 1 : left.name.localeCompare(right.name));
}

async function applyDeckPreset(deckId: number, presetId: number): Promise<DeckOptions> {
  await initialize();
  const database = collection();
  const decks = readDecks(database);
  const deck = decks[String(deckId)];
  if (!deck || deck.dyn !== 0) throw new Error("Deck not found");
  if (!readDeckConfigs(database)[String(presetId)]) throw new Error("Preset not found");
  deck.conf = presetId;
  deck.mod = nowSeconds();
  deck.usn = -1;
  database.transaction("IMMEDIATE", (transaction) => {
    transaction.exec({ sql: "UPDATE col SET decks = ? WHERE id = 1", bind: [JSON.stringify(decks)] });
    touchCollection(transaction);
  });
  return deckOptionsFor(database, deck);
}

async function applyDeckPresetToSubdecks(deckId: number, presetId: number): Promise<DeckOptions> {
  await initialize();
  const database = collection();
  const decks = readDecks(database);
  const deck = decks[String(deckId)];
  if (!deck || deck.dyn !== 0) throw new Error("Deck not found");
  if (!readDeckConfigs(database)[String(presetId)]) throw new Error("Preset not found");
  const mod = nowSeconds();
  for (const candidate of Object.values(decks)) {
    if (candidate.dyn === 0 && (candidate.id === deckId || candidate.name.startsWith(`${deck.name}::`))) {
      candidate.conf = presetId;
      candidate.mod = mod;
      candidate.usn = -1;
    }
  }
  database.transaction("IMMEDIATE", (transaction) => {
    transaction.exec({ sql: "UPDATE col SET decks = ? WHERE id = 1", bind: [JSON.stringify(decks)] });
    touchCollection(transaction);
  });
  return deckOptionsFor(database, deck);
}

function presetName(nameInput: string) {
  const name = nameInput.trim().replace(/[\u0000-\u001f\u007f]/g, "");
  if (!name || name.length > 100) throw new Error("Preset name must be from 1 to 100 characters");
  return name;
}

async function createDeckPreset(nameInput: string, sourcePresetId: number): Promise<DeckPresetSummary> {
  await initialize();
  const database = collection();
  const configs = readDeckConfigs(database);
  const source = configs[String(sourcePresetId)];
  if (!source) throw new Error("Preset not found");
  const name = presetName(nameInput);
  if (Object.values(configs).some((config) => String(config.name).toLocaleLowerCase() === name.toLocaleLowerCase())) {
    throw new Error("A preset already has that name");
  }
  const id = uniqueDeckConfigId(configs);
  configs[String(id)] = { ...JSON.parse(JSON.stringify(source)) as DeckConfigRecord, id, name, mod: nowSeconds(), usn: -1,
    ankiPwaSharedPreset: true };
  delete configs[String(id)].ankiPwaDeckId;
  database.transaction("IMMEDIATE", (transaction) => {
    transaction.exec({ sql: "UPDATE col SET dconf = ? WHERE id = 1", bind: [JSON.stringify(configs)] });
    touchCollection(transaction);
  });
  return { id, name, useCount: 0, isDefault: false };
}

async function renameDeckPreset(presetId: number, nameInput: string): Promise<void> {
  await initialize();
  const database = collection();
  const configs = readDeckConfigs(database);
  const config = configs[String(presetId)];
  if (!config) throw new Error("Preset not found");
  const name = presetName(nameInput);
  if (Object.values(configs).some((candidate) => candidate !== config && String(candidate.name).toLocaleLowerCase() === name.toLocaleLowerCase())) {
    throw new Error("A preset already has that name");
  }
  config.name = name;
  config.mod = nowSeconds();
  config.usn = -1;
  database.transaction("IMMEDIATE", (transaction) => {
    transaction.exec({ sql: "UPDATE col SET dconf = ? WHERE id = 1", bind: [JSON.stringify(configs)] });
    touchCollection(transaction);
  });
}

async function deleteDeckPreset(presetId: number): Promise<void> {
  await initialize();
  if (presetId === DEFAULT_DECK_ID) throw new Error("The default preset cannot be deleted");
  const database = collection();
  const configs = readDeckConfigs(database);
  if (!configs[String(presetId)]) throw new Error("Preset not found");
  const decks = readDecks(database);
  for (const deck of Object.values(decks)) {
    if (Number(deck.conf) === presetId) {
      deck.conf = DEFAULT_DECK_ID;
      deck.mod = nowSeconds();
      deck.usn = -1;
    }
  }
  delete configs[String(presetId)];
  database.transaction("IMMEDIATE", (transaction) => {
    transaction.exec({ sql: "UPDATE col SET decks = ?, dconf = ? WHERE id = 1", bind: [JSON.stringify(decks), JSON.stringify(configs)] });
    touchCollection(transaction);
  });
}

async function saveDeckOptions(deckId: number, input: DeckOptionsInput): Promise<DeckOptions> {
  await initialize();
  const database = collection();
  const decks = readDecks(database);
  const deck = decks[String(deckId)];
  if (!deck || deck.dyn !== 0) throw new Error("Deck not found");
  const options = validatedDeckOptions(input);
  const configs = readDeckConfigs(database);
  const current = deckConfigFor(database, deck);
  const configId = Number(deck.conf) === DEFAULT_DECK_ID ? uniqueDeckConfigId(configs) : Number(deck.conf);
  const config = JSON.parse(JSON.stringify(current)) as DeckConfigRecord;
  const newOptions = recordValue(config.new);
  const reviewOptions = recordValue(config.rev);
  const lapseOptions = recordValue(config.lapse);
  const mod = nowSeconds();
  const collectionConfig = readCollectionConfig(database);

  Object.assign(config, {
    id: configId,
    mod,
    usn: -1,
    name: Number(deck.conf) === DEFAULT_DECK_ID ? `${deck.name.split("::").at(-1) ?? deck.name} options` : String(current.name),
    ankiPwaSharedPreset: true,
    desiredRetention: options.desiredRetentionPercent / 100,
    fsrsParams6: options.fsrsWeights,
    newGatherPriority: newGatherValues[options.newCardGatherOrder],
    newSortOrder: newSortValues[options.newCardSortOrder],
    reviewOrder: reviewOrderValues[options.reviewOrder],
    newMix: mixOrders.indexOf(options.newCardReviewOrder),
    interdayLearningMix: mixOrders.indexOf(options.interdayLearningReviewOrder),
    buryInterdayLearning: options.buryInterdayLearningSiblings,
    maxTaken: options.maximumAnswerSeconds,
    timer: options.showAnswerTimer ? 1 : 0,
    stopTimerOnAnswer: options.stopTimerOnAnswer,
    secondsToShowQuestion: options.secondsToShowQuestion,
    secondsToShowAnswer: options.secondsToShowAnswer,
    questionAction: options.questionTimeAction === "reminder" ? 1 : 0,
    answerAction: ({ bury: 0, again: 1, good: 2, hard: 3, reminder: 4 } as const)[options.answerTimeAction],
    new: { ...newOptions, perDay: options.newCardsPerDay, delays: options.learningStepsMinutes, bury: options.buryNewSiblings,
      order: options.newCardInsertOrder === "random" ? 0 : 1 },
    rev: { ...reviewOptions, perDay: options.maximumReviewsPerDay, maxIvl: options.maximumIntervalDays, bury: options.buryReviewSiblings },
    lapse: { ...lapseOptions, delays: options.relearningStepsMinutes, leechFails: options.leechThreshold,
      leechAction: options.leechAction === "suspend" ? 0 : 1, minInt: options.minimumLapseIntervalDays }
  });
  delete config.ankiPwaDeckId;
  configs[String(configId)] = config;
  deck.conf = configId;
  deck.mod = mod;
  deck.usn = -1;
  collectionConfig.newCardsIgnoreReviewLimit = options.newCardsIgnoreReviewLimit;
  collectionConfig.applyAllParentLimits = options.limitsStartFromTop;

  database.transaction("IMMEDIATE", (transaction) => {
    transaction.exec({
      sql: "UPDATE col SET decks = ?, dconf = ?, conf = ? WHERE id = 1",
      bind: [JSON.stringify(decks), JSON.stringify(configs), JSON.stringify(collectionConfig)]
    });
    touchCollection(transaction);
  });
  return deckOptionsFor(database, deck);
}

async function resetDeckOptions(deckId: number): Promise<DeckOptions> {
  await initialize();
  const database = collection();
  const decks = readDecks(database);
  const deck = decks[String(deckId)];
  if (!deck || deck.dyn !== 0) throw new Error("Deck not found");
  const configs = readDeckConfigs(database);
  const previousId = Number(deck.conf);
  const previous = configs[String(previousId)];
  deck.conf = DEFAULT_DECK_ID;
  deck.mod = nowSeconds();
  deck.usn = -1;
  if (Number(previous?.ankiPwaDeckId) === deckId
    && !Object.values(decks).some((candidate) => candidate.id !== deckId && Number(candidate.conf) === previousId)) {
    delete configs[String(previousId)];
  }
  database.transaction("IMMEDIATE", (transaction) => {
    transaction.exec({
      sql: "UPDATE col SET decks = ?, dconf = ? WHERE id = 1",
      bind: [JSON.stringify(decks), JSON.stringify(configs)]
    });
    touchCollection(transaction);
  });
  return deckOptionsFor(database, deck);
}

function readNotetypes(database = collection()): Record<string, AnkiNotetype> {
  const json = String(database.selectValue("SELECT models FROM col WHERE id = 1") ?? "{}");
  return JSON.parse(json) as Record<string, AnkiNotetype>;
}

function collectionDay(database = collection()) {
  const creation = Number(database.selectValue("SELECT crt FROM col WHERE id = 1") ?? collectionCreationSeconds());
  return Math.max(0, Math.floor((nowSeconds() - creation) / 86_400));
}

function touchCollection(database: Database) {
  database.exec({
    // scm tracks schema changes, not ordinary collection edits.
    sql: "UPDATE col SET mod = ?, usn = -1 WHERE id = 1",
    bind: [nowSeconds()]
  });
}

function unburyCardsForNewDay(database: Database) {
  const today = collectionDay(database);
  const conf = JSON.parse(String(database.selectValue("SELECT conf FROM col WHERE id = 1") ?? "{}")) as Record<string, unknown>;
  if (Number(conf.lastUnburied) === today) return;
  conf.lastUnburied = today;
  database.transaction("IMMEDIATE", (transaction) => {
    transaction.exec({
      sql: `UPDATE cards SET queue = CASE type WHEN 0 THEN 0 WHEN 2 THEN 2 ELSE 1 END,
            mod = ?, usn = -1 WHERE queue IN (-2, -3)`,
      bind: [nowSeconds()]
    });
    transaction.exec({ sql: "UPDATE col SET conf = ? WHERE id = 1", bind: [JSON.stringify(conf)] });
    touchCollection(transaction);
  });
}

function deckSummary(deck: AnkiDeck, database = collection()): DeckSummary {
  const today = collectionDay(database);
  const now = nowSeconds();
  const decks = readDecks(database);
  const scopeIds = deckScopeIds(decks, deck.id);
  const placeholders = scopeIds.map(() => "?").join(",");
  const cards = database.selectObjects(`SELECT did, queue, due FROM cards WHERE did IN (${placeholders})`, scopeIds);
  const options = deckOptionsFor(database, deck);
  const activity = deckActivityToday(database, scopeIds);
  const newRemaining = Math.max(0, options.newCardsPerDay - activity.introduced);
  const reviewRemaining = Math.max(0, options.maximumReviewsPerDay - activity.reviews);
  const limitCache = new Map<string, boolean>();
  const newCount = cards.filter((card) => Number(card.queue) === 0
    && withinDailyLimits(database, decks, deck.id, Number(card.did), "new", limitCache)).length;
  const reviewCount = cards.filter((card) => Number(card.queue) === 2 && Number(card.due) <= today
    && withinDailyLimits(database, decks, deck.id, Number(card.did), "review", limitCache)).length;
  const interdayReviewCount = cards.filter((card) => Number(card.queue) === 3 && Number(card.due) <= today
    && withinDailyLimits(database, decks, deck.id, Number(card.did), "review", limitCache)).length;
  const learningCount = cards.filter((card) => (Number(card.queue) === 1 && Number(card.due) <= now)
    || (Number(card.queue) === 3 && Number(card.due) <= today)).length;
  const availableNew = options.newCardsIgnoreReviewLimit ? newRemaining
    : Math.min(newRemaining, Math.max(0, reviewRemaining - Math.min(reviewRemaining, interdayReviewCount + reviewCount)));

  return {
    id: deck.id,
    name: deck.name,
    newCount: Math.min(newCount, availableNew),
    learningCount,
    reviewCount: Math.min(reviewCount, reviewRemaining),
    totalCards: cards.length
  };
}

async function listDecks(): Promise<DeckSummary[]> {
  await initialize();
  const database = collection();
  unburyCardsForNewDay(database);
  return Object.values(readDecks(database))
    .filter((deck) => deck.dyn === 0)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    .map((deck) => deckSummary(deck, database));
}

async function listNotetypes(): Promise<NoteTypeSummary[]> {
  await initialize();
  return Object.values(readNotetypes())
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    .map((notetype) => {
      const imageOcclusion = Number(notetype.originalStockKind) === 6;
      const tagged = (tag: number, fallback: number) => {
        const index = notetype.flds.findIndex((field) => Number(field.tag) === tag);
        return index >= 0 ? index : fallback;
      };
      return {
      id: notetype.id,
      name: notetype.name,
      kind: imageOcclusion ? "image-occlusion" as const : notetype.type === 1 ? "cloze" as const : "standard" as const,
      fields: notetype.flds
        .map((field, index) => ({ name: field.name, ordinal: field.ord ?? index }))
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((field) => field.name),
      ...(imageOcclusion ? { imageOcclusionFields: {
        occlusions: tagged(0, 0), image: tagged(1, 1), header: tagged(2, 2),
        backExtra: tagged(3, 3), comments: tagged(4, 4)
      } } : {})
    };
    });
}

function noteTypeKind(notetype: AnkiNotetype): NoteTypeDetails["kind"] {
  if (Number(notetype.originalStockKind) === 6) return "image-occlusion";
  return notetype.type === 1 ? "cloze" : "standard";
}

function orderedFields(notetype: AnkiNotetype) {
  return notetype.flds.map((field, index) => ({ field, ordinal: Number(field.ord ?? index) }))
    .sort((left, right) => left.ordinal - right.ordinal);
}

function orderedTemplates(notetype: AnkiNotetype) {
  return notetype.tmpls.map((template, index) => ({ template, ordinal: Number(template.ord ?? index) }))
    .sort((left, right) => left.ordinal - right.ordinal);
}

function noteTypeDetailsFor(database: Database, notetype: AnkiNotetype): NoteTypeDetails {
  const noteCount = Number(database.selectValue("SELECT count(*) FROM notes WHERE mid = ?", [notetype.id]) ?? 0);
  const cardCount = Number(database.selectValue(
    "SELECT count(*) FROM cards WHERE nid IN (SELECT id FROM notes WHERE mid = ?)", [notetype.id]
  ) ?? 0);
  return {
    id: Number(notetype.id),
    name: String(notetype.name),
    kind: noteTypeKind(notetype),
    fields: orderedFields(notetype).map(({ field, ordinal }) => ({
      name: String(field.name), sourceOrdinal: ordinal, rtl: Boolean(field.rtl),
      font: String(field.font ?? "Arial"), size: Math.round(boundedNumber(field.size, 20, 8, 96))
    })),
    templates: orderedTemplates(notetype).map(({ template, ordinal }) => ({
      name: String(template.name), sourceOrdinal: ordinal, qfmt: String(template.qfmt), afmt: String(template.afmt),
      deckId: Number.isInteger(Number(template.did)) && Number(template.did) > 0 ? Number(template.did) : null
    })),
    css: String(notetype.css ?? ""),
    noteCount,
    cardCount,
    canDelete: ![BASIC_NOTETYPE_ID, CLOZE_NOTETYPE_ID].includes(Number(notetype.id))
      && noteTypeKind(notetype) !== "image-occlusion"
  };
}

async function listNoteTypeDetails(): Promise<NoteTypeDetails[]> {
  await initialize();
  const database = collection();
  return Object.values(readNotetypes(database))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }))
    .map((notetype) => noteTypeDetailsFor(database, notetype));
}

function cleanedNoteTypeName(value: unknown, label: string) {
  const name = String(value ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, "");
  if (!name || name.length > 100) throw new Error(`${label} must be from 1 to 100 characters`);
  return name;
}

function uniqueNotetypeId(models: Record<string, AnkiNotetype>) {
  let id = Date.now();
  while (models[String(id)]) id += 1;
  return id;
}

function validateNoteTypeInput(previous: AnkiNotetype, input: NoteTypeInput) {
  const name = cleanedNoteTypeName(input.name, "Note type name");
  if (!Array.isArray(input.fields) || input.fields.length < 1 || input.fields.length > 100) {
    throw new Error("A note type must have from 1 to 100 fields");
  }
  const oldFields = new Set(orderedFields(previous).map(({ ordinal }) => ordinal));
  const usedFields = new Set<number>();
  const fields = input.fields.map((field, index) => {
    const fieldName = cleanedNoteTypeName(field.name, "Field name");
    const sourceOrdinal = field.sourceOrdinal === null ? null : Number(field.sourceOrdinal);
    if (sourceOrdinal !== null && (!Number.isInteger(sourceOrdinal) || !oldFields.has(sourceOrdinal) || usedFields.has(sourceOrdinal))) {
      throw new Error("Each existing field can only be used once");
    }
    if (sourceOrdinal !== null) usedFields.add(sourceOrdinal);
    const font = String(field.font ?? "Arial").trim().slice(0, 100) || "Arial";
    const size = Math.round(boundedNumber(field.size, 20, 8, 96));
    return { name: fieldName, sourceOrdinal, rtl: Boolean(field.rtl), font, size, ord: index };
  });
  if (new Set(fields.map((field) => field.name.toLocaleLowerCase())).size !== fields.length) {
    throw new Error("Field names must be unique");
  }

  const isCloze = previous.type === 1;
  if (!Array.isArray(input.templates) || input.templates.length < 1 || input.templates.length > 100) {
    throw new Error("A note type must have from 1 to 100 card templates");
  }
  if (isCloze && input.templates.length !== 1) throw new Error("Cloze note types use one card template");
  const oldTemplates = new Set(orderedTemplates(previous).map(({ ordinal }) => ordinal));
  const usedTemplates = new Set<number>();
  const templates = input.templates.map((template, index) => {
    const templateName = cleanedNoteTypeName(template.name, "Template name");
    const sourceOrdinal = template.sourceOrdinal === null ? null : Number(template.sourceOrdinal);
    if (sourceOrdinal !== null && (!Number.isInteger(sourceOrdinal) || !oldTemplates.has(sourceOrdinal) || usedTemplates.has(sourceOrdinal))) {
      throw new Error("Each existing template can only be used once");
    }
    if (sourceOrdinal !== null) usedTemplates.add(sourceOrdinal);
    const qfmt = String(template.qfmt ?? "");
    const afmt = String(template.afmt ?? "");
    if (qfmt.length > 100_000 || afmt.length > 100_000) throw new Error("Template content is too large");
    const deckId = template.deckId === null ? null : Number(template.deckId);
    if (deckId !== null && (!Number.isInteger(deckId) || deckId < 1)) throw new Error("Template deck is invalid");
    return { name: templateName, sourceOrdinal, qfmt, afmt, deckId, ord: index };
  });
  if (new Set(templates.map((template) => template.name.toLocaleLowerCase())).size !== templates.length) {
    throw new Error("Template names must be unique");
  }
  const css = String(input.css ?? "");
  if (css.length > 100_000) throw new Error("Styling is too large");
  return { name, fields, templates, css };
}

async function createNoteType(nameInput: string, kind: "standard" | "cloze", sourceId: number | null): Promise<NoteTypeDetails> {
  await initialize();
  const database = collection();
  const models = readNotetypes(database);
  const name = cleanedNoteTypeName(nameInput, "Note type name");
  if (Object.values(models).some((model) => model.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    throw new Error("A note type already has that name");
  }
  const source = sourceId === null ? models[String(kind === "cloze" ? CLOZE_NOTETYPE_ID : BASIC_NOTETYPE_ID)] : models[String(sourceId)];
  if (!source || noteTypeKind(source) === "image-occlusion" || (kind === "cloze") !== (source.type === 1)) {
    throw new Error("Choose a compatible note type to clone");
  }
  const id = uniqueNotetypeId(models);
  const model = JSON.parse(JSON.stringify(source)) as AnkiNotetype;
  model.id = id;
  model.name = name;
  model.mod = nowSeconds();
  model.usn = -1;
  delete model.originalStockKind;
  models[String(id)] = model;
  database.transaction("IMMEDIATE", (transaction) => {
    transaction.exec({ sql: "UPDATE col SET models = ?, scm = ? WHERE id = 1", bind: [JSON.stringify(models), Date.now()] });
    touchCollection(transaction);
  });
  return noteTypeDetailsFor(database, model);
}

async function updateNoteType(input: NoteTypeInput): Promise<NoteTypeDetails> {
  await initialize();
  const database = collection();
  const models = readNotetypes(database);
  const previous = models[String(input.id)];
  if (!previous) throw new Error("Note type not found");
  if (noteTypeKind(previous) === "image-occlusion") throw new Error("Image Occlusion note types cannot be edited here");
  const next = validateNoteTypeInput(previous, input);
  if (Object.values(models).some((model) => model !== previous && model.name.toLocaleLowerCase() === next.name.toLocaleLowerCase())) {
    throw new Error("A note type already has that name");
  }
  const mod = nowSeconds();
  const model: AnkiNotetype = {
    ...previous,
    name: next.name,
    mod,
    usn: -1,
    flds: next.fields.map((field) => {
      const original = field.sourceOrdinal === null ? {} : orderedFields(previous).find(({ ordinal }) => ordinal === field.sourceOrdinal)?.field ?? {};
      return { ...original, name: field.name, ord: field.ord, rtl: field.rtl, font: field.font, size: field.size };
    }),
    tmpls: next.templates.map((template) => {
      const original = template.sourceOrdinal === null ? {} : orderedTemplates(previous).find(({ ordinal }) => ordinal === template.sourceOrdinal)?.template ?? {};
      return { ...original, name: template.name, ord: template.ord, qfmt: template.qfmt, afmt: template.afmt,
        did: template.deckId ?? null };
    }),
    css: next.css
  };
  delete model.req;

  const oldFieldIndexes = new Map(orderedFields(previous).map(({ ordinal }, index) => [ordinal, index]));
  const oldToNewTemplate = new Map(next.templates.flatMap((template) => template.sourceOrdinal === null ? [] : [[template.sourceOrdinal, template.ord]]));
  const noteRows = database.selectObjects("SELECT id, flds FROM notes WHERE mid = ? ORDER BY id", [previous.id]);
  const noteUpdates = await Promise.all(noteRows.map(async (note) => {
    const oldValues = String(note.flds).split(FIELD_SEPARATOR);
    const fields = next.fields.map((field) => field.sourceOrdinal === null ? "" : oldValues[oldFieldIndexes.get(field.sourceOrdinal) ?? -1] ?? "");
    return { id: Number(note.id), fields, checksum: await fieldChecksum(fields[0] ?? "") };
  }));
  const cards = noteUpdates.length
    ? database.selectObjects(`SELECT id, nid, did, ord FROM cards WHERE nid IN (${noteUpdates.map(() => "?").join(",")}) ORDER BY id`, noteUpdates.map((note) => note.id))
    : [];
  const cardsByNote = new Map<number, Record<string, unknown>[]>();
  for (const card of cards) {
    const noteCards = cardsByNote.get(Number(card.nid)) ?? [];
    noteCards.push(card);
    cardsByNote.set(Number(card.nid), noteCards);
  }
  let nextCardId = uniqueId(database, "cards", Date.now());
  let nextDue = Number(database.selectValue("SELECT coalesce(max(due), 0) + 1 FROM cards WHERE type = 0") ?? 1);
  const cardDeletes: number[] = [];
  const cardMoves: Array<{ id: number; ord: number }> = [];
  const cardAdds: Array<{ id: number; noteId: number; deckId: number; ord: number; due: number }> = [];
  for (const note of noteUpdates) {
    const desired = new Set(desiredOrdinals(model, note.fields));
    const existing = cardsByNote.get(note.id) ?? [];
    const retained = new Set<number>();
    for (const card of existing) {
      const target = oldToNewTemplate.get(Number(card.ord));
      if (target === undefined || !desired.has(target) || retained.has(target)) {
        cardDeletes.push(Number(card.id));
      } else {
        retained.add(target);
        if (target !== Number(card.ord)) cardMoves.push({ id: Number(card.id), ord: target });
      }
    }
    const deckId = Number(existing[0]?.did ?? model.did ?? DEFAULT_DECK_ID);
    for (const ordinal of desired) {
      if (retained.has(ordinal)) continue;
      cardAdds.push({ id: nextCardId++, noteId: note.id, deckId, ord: ordinal, due: nextDue++ });
    }
  }
  models[String(model.id)] = model;
  database.transaction("IMMEDIATE", (transaction) => {
    for (const note of noteUpdates) {
      transaction.exec({ sql: "UPDATE notes SET mod = ?, usn = -1, flds = ?, sfld = ?, csum = ? WHERE id = ?",
        bind: [mod, note.fields.join(FIELD_SEPARATOR), plainText(note.fields[0] ?? ""), note.checksum, note.id] });
    }
    for (const cardId of cardDeletes) {
      transaction.exec({ sql: "INSERT INTO graves (usn, oid, type) VALUES (-1, ?, 0)", bind: [cardId] });
      transaction.exec({ sql: "DELETE FROM revlog WHERE cid = ?", bind: [cardId] });
      transaction.exec({ sql: "DELETE FROM cards WHERE id = ?", bind: [cardId] });
    }
    for (const card of cardMoves) transaction.exec({ sql: "UPDATE cards SET ord = ?, mod = ?, usn = -1 WHERE id = ?", bind: [card.ord, mod, card.id] });
    for (const card of cardAdds) transaction.exec({
      sql: "INSERT INTO cards (id,nid,did,ord,mod,usn,type,queue,due,ivl,factor,reps,lapses,left,odue,odid,flags,data) VALUES (?,?,?,?,?,-1,0,0,?,0,0,0,0,0,0,0,0,'')",
      bind: [card.id, card.noteId, card.deckId, card.ord, mod, card.due]
    });
    transaction.exec({ sql: "UPDATE col SET models = ?, scm = ? WHERE id = 1", bind: [JSON.stringify(models), Date.now()] });
    touchCollection(transaction);
  });
  return noteTypeDetailsFor(database, model);
}

async function deleteNoteType(noteTypeId: number): Promise<void> {
  await initialize();
  const database = collection();
  const models = readNotetypes(database);
  const notetype = models[String(noteTypeId)];
  if (!notetype) throw new Error("Note type not found");
  if (!noteTypeDetailsFor(database, notetype).canDelete) throw new Error("This built-in note type cannot be deleted");
  const noteIds = database.selectObjects("SELECT id FROM notes WHERE mid = ?", [noteTypeId]).map((row) => Number(row.id));
  const cardIds = noteIds.length ? database.selectObjects(`SELECT id FROM cards WHERE nid IN (${noteIds.map(() => "?").join(",")})`, noteIds).map((row) => Number(row.id)) : [];
  delete models[String(noteTypeId)];
  database.transaction("IMMEDIATE", (transaction) => {
    for (const cardId of cardIds) transaction.exec({ sql: "INSERT INTO graves (usn, oid, type) VALUES (-1, ?, 0)", bind: [cardId] });
    for (const noteId of noteIds) transaction.exec({ sql: "INSERT INTO graves (usn, oid, type) VALUES (-1, ?, 1)", bind: [noteId] });
    if (noteIds.length) {
      transaction.exec({ sql: `DELETE FROM revlog WHERE cid IN (SELECT id FROM cards WHERE nid IN (${noteIds.map(() => "?").join(",")}))`, bind: noteIds });
      transaction.exec({ sql: `DELETE FROM cards WHERE nid IN (${noteIds.map(() => "?").join(",")})`, bind: noteIds });
      transaction.exec({ sql: `DELETE FROM notes WHERE id IN (${noteIds.map(() => "?").join(",")})`, bind: noteIds });
    }
    transaction.exec({ sql: "UPDATE col SET models = ?, scm = ? WHERE id = 1", bind: [JSON.stringify(models), Date.now()] });
    touchCollection(transaction);
  });
}

function localDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateSerial(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function reviewStreak(dayKeys: string[], todayKey: string) {
  const days = new Set(dayKeys.filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key)).map(dateSerial));
  const ordered = [...days].sort((left, right) => left - right);
  let longest = 0;
  let run = 0;
  let previous: number | null = null;
  for (const day of ordered) {
    run = previous !== null && day === previous + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = day;
  }

  let cursor = dateSerial(todayKey);
  if (!days.has(cursor)) cursor -= 1;
  let current = 0;
  while (days.has(cursor)) {
    current += 1;
    cursor -= 1;
  }
  return { current, longest };
}

async function getCollectionStats(deckId: number | null): Promise<CollectionStats> {
  await initialize();
  const database = collection();
  const decks = readDecks(database);
  let scopeIds: number[] | null = null;
  let scopeName = "Entire collection";
  if (deckId !== null) {
    const deck = decks[String(deckId)];
    if (!deck || deck.dyn !== 0) throw new Error("Deck not found");
    scopeIds = deckScopeIds(decks, deckId);
    scopeName = deck.name;
  }
  const condition = scopeIds ? `c.did IN (${scopeIds.map(() => "?").join(",")})` : "1 = 1";
  const scopeBind = scopeIds ?? [];

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 29);
  const reviewDays = database.selectObjects(
    `SELECT date(r.id / 1000, 'unixepoch', 'localtime') AS day,
       count(*) AS reviews, coalesce(sum(r.time), 0) AS time_ms,
       sum(CASE WHEN r.ease = 1 THEN 1 ELSE 0 END) AS again_count,
       sum(CASE WHEN r.ease = 2 THEN 1 ELSE 0 END) AS hard_count,
       sum(CASE WHEN r.ease = 3 THEN 1 ELSE 0 END) AS good_count,
       sum(CASE WHEN r.ease = 4 THEN 1 ELSE 0 END) AS easy_count
     FROM revlog r JOIN cards c ON c.id = r.cid
     WHERE r.id >= ? AND ${condition}
     GROUP BY day ORDER BY day`,
    [start.getTime(), ...scopeBind]
  );
  const allDaysSql = `SELECT DISTINCT date(r.id / 1000, 'unixepoch', 'localtime') AS day
     FROM revlog r JOIN cards c ON c.id = r.cid
     WHERE r.id > 0 AND ${condition} ORDER BY day`;
  const allDays = (
    scopeBind.length
      ? database.selectObjects(allDaysSql, scopeBind)
      : database.selectObjects(allDaysSql)
  ).map((row) => String(row.day));

  const answers = { again: 0, hard: 0, good: 0, easy: 0 };
  let periodReviews = 0;
  let periodTime = 0;
  const byDay = new Map<string, { reviews: number; timeMs: number }>();
  for (const row of reviewDays) {
    const reviews = Number(row.reviews ?? 0);
    const timeMs = Number(row.time_ms ?? 0);
    periodReviews += reviews;
    periodTime += timeMs;
    answers.again += Number(row.again_count ?? 0);
    answers.hard += Number(row.hard_count ?? 0);
    answers.good += Number(row.good_count ?? 0);
    answers.easy += Number(row.easy_count ?? 0);
    byDay.set(String(row.day), { reviews, timeMs });
  }

  const today = new Date();
  const todayKey = localDateKey(today);
  const todayStats = byDay.get(todayKey) ?? { reviews: 0, timeMs: 0 };
  const daily = [];
  for (let offset = 13; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    const key = localDateKey(date);
    daily.push({ date: key, ...(byDay.get(key) ?? { reviews: 0, timeMs: 0 }) });
  }

  const cardCountsSql = `SELECT count(*) AS total,
       sum(CASE WHEN c.queue = 0 THEN 1 ELSE 0 END) AS new_cards,
       sum(CASE WHEN c.queue IN (1, 3) THEN 1 ELSE 0 END) AS learning_cards,
       sum(CASE WHEN c.queue = 2 THEN 1 ELSE 0 END) AS review_cards,
       sum(CASE WHEN c.queue = -1 THEN 1 ELSE 0 END) AS suspended_cards,
       sum(CASE WHEN c.queue IN (-2, -3) THEN 1 ELSE 0 END) AS buried_cards
     FROM cards c WHERE ${condition}`;
  const cardCounts = scopeBind.length
    ? database.selectObject(cardCountsSql, scopeBind)
    : database.selectObject(cardCountsSql);
  const streak = reviewStreak(allDays, todayKey);
  const collectionCreation = Number(database.selectValue("SELECT crt FROM col WHERE id = 1") ?? collectionCreationSeconds());
  const todayDue = Math.max(0, Math.floor((today.getTime() / 1000 - collectionCreation) / 86_400));
  const forecast = Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(today);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + offset);
    const due = todayDue + offset;
    const dueCards = database.selectValue(`SELECT count(*) FROM cards c WHERE ${condition} AND c.queue IN (1,2,3) AND (
      (c.queue IN (2,3) AND c.due <= ?) OR (c.queue = 1 AND c.due <= ?)
    )`, [...scopeBind, due, date.getTime() / 1000]);
    return { date: localDateKey(date), due: Number(dueCards ?? 0) };
  });
  const maturity = scopeBind.length
    ? database.selectObject(`SELECT sum(CASE WHEN c.queue = 2 AND c.ivl < 21 THEN 1 ELSE 0 END) AS young,
        sum(CASE WHEN c.queue = 2 AND c.ivl >= 21 THEN 1 ELSE 0 END) AS mature,
        avg(CASE WHEN c.queue = 2 THEN c.ivl END) AS average_interval FROM cards c WHERE ${condition}`, scopeBind)
    : database.selectObject(`SELECT sum(CASE WHEN c.queue = 2 AND c.ivl < 21 THEN 1 ELSE 0 END) AS young,
        sum(CASE WHEN c.queue = 2 AND c.ivl >= 21 THEN 1 ELSE 0 END) AS mature,
        avg(CASE WHEN c.queue = 2 THEN c.ivl END) AS average_interval FROM cards c`);
  return {
    scopeName,
    today: todayStats,
    last30Days: {
      reviews: periodReviews,
      timeMs: periodTime,
      retentionPercent: periodReviews
        ? Math.round(((periodReviews - answers.again) / periodReviews) * 1_000) / 10
        : null,
      answers
    },
    streak,
    cards: {
      total: Number(cardCounts?.total ?? 0),
      new: Number(cardCounts?.new_cards ?? 0),
      learning: Number(cardCounts?.learning_cards ?? 0),
      review: Number(cardCounts?.review_cards ?? 0),
      suspended: Number(cardCounts?.suspended_cards ?? 0),
      buried: Number(cardCounts?.buried_cards ?? 0)
    },
    daily,
    forecast,
    maturity: {
      young: Number(maturity?.young ?? 0),
      mature: Number(maturity?.mature ?? 0),
      averageIntervalDays: maturity?.average_interval === null || maturity?.average_interval === undefined
        ? null : Math.round(Number(maturity.average_interval) * 10) / 10
    }
  };
}

async function createDeck(nameInput: string): Promise<DeckSummary> {
  await initialize();
  const database = collection();
  const name = nameInput.trim();
  if (!name) throw new Error("Deck name cannot be empty");

  const decks = readDecks(database);
  if (Object.values(decks).some((deck) => deck.name.localeCompare(name, undefined, { sensitivity: "base" }) === 0)) {
    throw new Error("A deck with that name already exists");
  }

  let id = Date.now();
  while (decks[String(id)]) id += 1;
  const deck = { ...defaultDeck(nowSeconds()), id, name };
  decks[String(id)] = deck;

  database.transaction("IMMEDIATE", (transaction) => {
    transaction.exec({ sql: "UPDATE col SET decks = ? WHERE id = 1", bind: [JSON.stringify(decks)] });
    touchCollection(transaction);
  });
  return deckSummary(deck, database);
}

function plainText(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .trim();
}

function safeMediaFilename(filename: string) {
  const basename = filename.normalize("NFC").split(/[\\/]/).pop()?.trim() ?? "";
  const safe = basename.replace(/[\u0000-\u001f\u007f"'<>]/g, "_");
  if (!safe || safe === "." || safe === "..") throw new Error("Invalid media filename");
  return safe;
}

async function mediaDirectory(create: boolean) {
  if (!navigator.storage?.getDirectory) return null;
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(await currentMediaDirectoryName(root), { create });
  } catch {
    return null;
  }
}

function validMediaDirectoryName(name: string) {
  return name === DEFAULT_MEDIA_DIRECTORY || /^anki-pwa-media-restore-[a-z\d-]+$/.test(name);
}

async function currentMediaDirectoryName(root: FileSystemDirectoryHandle) {
  if (activeMediaDirectory) return activeMediaDirectory;
  try {
    const file = await (await root.getFileHandle(MEDIA_DIRECTORY_POINTER)).getFile();
    const value = (await file.text()).trim();
    if (validMediaDirectoryName(value)) {
      activeMediaDirectory = value;
      return value;
    }
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
  }
  activeMediaDirectory = DEFAULT_MEDIA_DIRECTORY;
  return activeMediaDirectory;
}

async function setCurrentMediaDirectory(root: FileSystemDirectoryHandle, name: string) {
  if (!validMediaDirectoryName(name)) throw new Error("Invalid media storage location");
  const handle = await root.getFileHandle(MEDIA_DIRECTORY_POINTER, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(name);
    await writable.close();
    activeMediaDirectory = name;
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

async function writeMediaDirectory(directory: FileSystemDirectoryHandle, files: Map<string, Uint8Array>, progress: (message: string) => void) {
  let count = 0;
  for (const [name, bytes] of files) {
    progress(`Saving media ${++count} of ${files.size}…`);
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(new Uint8Array(bytes));
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
  }
}

async function stagedMediaDirectory(files: Map<string, Uint8Array>, progress: (message: string) => void) {
  if (!navigator.storage?.getDirectory) return null;
  const root = await navigator.storage.getDirectory();
  const current = await currentMediaDirectoryName(root);
  const name = `anki-pwa-media-restore-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const directory = await root.getDirectoryHandle(name, { create: true });
  try {
    await writeMediaDirectory(directory, files, progress);
    return { root, name, previous: current };
  } catch (error) {
    await root.removeEntry(name, { recursive: true }).catch(() => {});
    throw error;
  }
}

async function storeMedia(filenameInput: string, bytes: ArrayBuffer) {
  const content = new Uint8Array(bytes);
  const requested = safeMediaFilename(filenameInput);
  const directory = await mediaDirectory(true);
  const existing = async (filename: string) => {
    const memory = memoryMedia.get(filename);
    if (memory) return memory;
    if (!directory) return undefined;
    try {
      const file = await (await directory.getFileHandle(filename)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return undefined;
      throw error;
    }
  };
  const equal = (left: Uint8Array, right: Uint8Array) => left.length === right.length
    && left.every((byte, index) => byte === right[index]);
  let filename = requested;
  let current = await existing(filename);
  if (current && !equal(current, content)) {
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", content))].slice(0, 8)
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const dot = requested.lastIndexOf(".");
    const stem = dot > 0 ? requested.slice(0, dot) : requested;
    const extension = dot > 0 ? requested.slice(dot) : "";
    let suffix = 0;
    do {
      filename = `${stem}-${hash}${suffix ? `-${suffix}` : ""}${extension}`;
      current = await existing(filename);
      suffix += 1;
    } while (current && !equal(current, content));
  }
  if (current) return filename;
  if (directory) {
    const handle = await directory.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(content);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
  } else {
    memoryMedia.set(filename, content.slice());
  }
  return filename;
}

async function importMediaStore(persistent: boolean): Promise<ImportMediaStore> {
  if (!persistent) return {
    read: async (name) => memoryMedia.get(name),
    write: async (name, bytes) => { memoryMedia.set(name, bytes.slice()); },
    remove: async (name) => { memoryMedia.delete(name); }
  };
  // Do not silently fall back to memory when persistent media storage fails.
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(await currentMediaDirectoryName(root), { create: true });
  return {
    read: async (name) => {
      try {
        const file = await (await directory.getFileHandle(name)).getFile();
        return new Uint8Array(await file.arrayBuffer());
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotFoundError") return undefined;
        throw error;
      }
    },
    write: async (name, bytes) => {
      const handle = await directory.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      try {
        await writable.write(new Uint8Array(bytes));
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => {});
        throw error;
      }
    },
    remove: async (name) => {
      try { await directory.removeEntry(name); }
      catch (error) { if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error; }
    }
  };
}

async function collectionMedia(progress: (message: string) => void) {
  const files = new Map<string, Uint8Array>();
  const directory = await mediaDirectory(false);
  if (directory) {
    let count = 0;
    const entries = (directory as FileSystemDirectoryHandle & {
      entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    }).entries();
    for await (const [name, handle] of entries) {
      if (handle.kind !== "file") continue;
      progress(`Reading media ${++count}…`);
      const file = await (handle as FileSystemFileHandle).getFile();
      files.set(name.normalize("NFC"), new Uint8Array(await file.arrayBuffer()));
    }
  }
  for (const [name, bytes] of memoryMedia) files.set(name.normalize("NFC"), bytes.slice());
  return [...files].sort(([left], [right]) => left.localeCompare(right))
    .map(([name, bytes]): BackupMediaFile => ({ name, bytes }));
}

function backupFilename() {
  const timestamp = new Date().toISOString().replace(/:\d\d\.\d\d\dZ$/, "Z").replaceAll(":", "-");
  return `anki-pwa-backup-${timestamp}.colpkg`;
}

async function exportCollection(progress: (message: string) => void): Promise<CollectionBackupResult> {
  const database = collection();
  if (!sqliteRuntime || !database.pointer) throw new Error("The local collection is not ready to export");
  progress("Reading local media…");
  const media = await collectionMedia(progress);
  progress("Creating collection snapshot…");
  const databaseBytes = sqliteRuntime.capi.sqlite3_js_db_export(database.pointer);
  progress("Compressing backup…");
  const packageBytes = buildCollectionPackage(databaseBytes, media);
  return {
    filename: backupFilename(),
    bytes: packageBytes.buffer,
    notes: Number(database.selectValue("SELECT count(*) FROM notes") ?? 0),
    cards: Number(database.selectValue("SELECT count(*) FROM cards") ?? 0),
    reviews: Number(database.selectValue("SELECT count(*) FROM revlog") ?? 0),
    media: media.length
  };
}

const COLLECTION_TABLES = ["col", "notes", "cards", "revlog", "graves"] as const;
type CollectionTable = (typeof COLLECTION_TABLES)[number];
type CollectionSnapshot = Record<CollectionTable, Array<Record<string, SqlValue>>>;

function collectionSnapshot(database: Database): CollectionSnapshot {
  return Object.fromEntries(COLLECTION_TABLES.map((table) => [table, database.selectObjects(`SELECT * FROM ${table}`)])) as CollectionSnapshot;
}

function replaceCollectionSnapshot(database: Database, snapshot: CollectionSnapshot) {
  database.transaction("IMMEDIATE", (transaction) => {
    // Deletion order keeps the operation compatible with foreign-key-enabled
    // SQLite builds, even though Anki's schema does not declare foreign keys.
    transaction.exec("DELETE FROM revlog; DELETE FROM cards; DELETE FROM notes; DELETE FROM graves; DELETE FROM col;");
    for (const table of COLLECTION_TABLES) {
      const rows = snapshot[table];
      if (!rows.length) continue;
      const columns = Object.keys(rows[0]);
      const statement = transaction.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
      try {
        for (const row of rows) statement.bind(columns.map((column) => row[column])).stepReset();
      } finally {
        statement.finalize();
      }
    }
  });
}

function memoryMediaStore(files: Map<string, Uint8Array>): ImportMediaStore {
  return {
    read: async (name) => files.get(name),
    write: async (name, bytes) => { files.set(name, bytes.slice()); },
    remove: async (name) => { files.delete(name); }
  };
}

function serializedCollectionSnapshot(bytes: Uint8Array): CollectionSnapshot {
  if (!sqliteRuntime) throw new Error("The local collection is not ready to restore");
  const source = new sqliteRuntime.oo1.DB(":memory:", "c");
  let pointer = 0;
  try {
    pointer = sqliteRuntime.wasm.allocFromTypedArray(bytes);
    const result = sqliteRuntime.capi.sqlite3_deserialize(source.pointer!, "main", pointer, bytes.length, bytes.length, 4);
    if (result !== 0) throw new Error("Could not open the collection backup database");
    source.exec("PRAGMA trusted_schema = OFF; PRAGMA query_only = ON");
    if (Number(source.selectValue("SELECT ver FROM col WHERE id = 1")) !== SCHEMA_VERSION) {
      throw new Error("This full backup uses a newer Anki database format. Export it as an .apkg, then import that deck package instead.");
    }
    return collectionSnapshot(source);
  } finally {
    source.close();
    if (pointer) sqliteRuntime.wasm.dealloc(pointer);
  }
}

/**
 * Replace this PWA's collection from a full Anki package. The archive is first
 * imported into an isolated in-memory collection and a separate media folder;
 * the user's active database/media pointer are only switched after both work.
 */
async function restoreCollection(bytes: ArrayBuffer, progress: (message: string) => void): Promise<CollectionRestoreResult> {
  const info = await initialize();
  const target = collection();
  if (!sqliteRuntime) throw new Error("The local collection is not ready to restore");
  if (!bytes.byteLength || bytes.byteLength > 500 * 1024 * 1024) throw new Error("Choose a non-empty .colpkg file no larger than 500 MiB");

  progress("Validating collection backup…");
  const stagedMedia = new Map<string, Uint8Array>();
  let mediaStage: Awaited<ReturnType<typeof stagedMediaDirectory>> = null;
  const previous = collectionSnapshot(target);
  const previousMediaName = activeMediaDirectory;
  try {
    const packageBytes = new Uint8Array(bytes);
    // readApkg validates ZIP limits, filenames, the media manifest, checksums,
    // and the Anki database before any active local state can change.
    const parsed = readApkg(sqliteRuntime, packageBytes, true);
    for (const file of parsed.media) stagedMedia.set(file.name.normalize("NFC"), file.bytes.slice());
    const archive = unzipSync(packageBytes);
    let replacement: CollectionSnapshot;
    if (!archive.meta && archive["collection.anki2"]) {
      // PWA-created backups use schema 11. Restoring that database directly
      // preserves empty decks, presets, collection configuration and graves.
      replacement = serializedCollectionSnapshot(archive["collection.anki2"]);
    } else {
      // Modern desktop packages use a different SQLite layout. Convert them
      // into the PWA's schema in isolation before replacing the active copy.
      const staged = new sqliteRuntime.oo1.DB(":memory:", "c");
      try {
        createAnkiSchema(staged);
        ensureFsrsConfiguration(staged);
        stagedMedia.clear();
        await importApkg(sqliteRuntime, staged, packageBytes, memoryMediaStore(stagedMedia), true, progress);
        replacement = collectionSnapshot(staged);
      } finally {
        staged.close();
      }
    }
    const result: CollectionRestoreResult = {
      notes: replacement.notes.length,
      cards: replacement.cards.length,
      reviews: replacement.revlog.length,
      media: stagedMedia.size
    };

    progress("Preparing replacement media…");
    mediaStage = info.persistent ? await stagedMediaDirectory(stagedMedia, progress) : null;
    progress("Replacing local collection…");
    replaceCollectionSnapshot(target, replacement);
    try {
      if (mediaStage) {
        await setCurrentMediaDirectory(mediaStage.root, mediaStage.name);
      } else {
        memoryMedia.clear();
        for (const [name, content] of stagedMedia) memoryMedia.set(name, content.slice());
      }
    } catch (error) {
      replaceCollectionSnapshot(target, previous);
      activeMediaDirectory = previousMediaName;
      throw new Error(`The collection was not replaced. ${error instanceof Error ? error.message : String(error)}`);
    }
    lastReviewUndo = null;

    // Do not delete the old media until the replacement is live. Failure to
    // clean it up only leaves harmless unused local storage, never breaks the
    // restored collection.
    if (mediaStage && mediaStage.previous !== mediaStage.name) {
      await mediaStage.root.removeEntry(mediaStage.previous, { recursive: true }).catch(() => {});
    }
    return result;
  } finally {
    // The active collection is untouched if validation or staging fails.
  }
}

function mediaReferenceSet(database = collection()) {
  const models = Object.values(readNotetypes(database));
  const values = [
    ...database.selectObjects("SELECT flds FROM notes NOT INDEXED").map((row) => String(row.flds)),
    ...models.flatMap((model) => [model.css, ...model.tmpls.flatMap((template) => [template.qfmt, template.afmt, String(template.bqfmt ?? ""), String(template.bafmt ?? "")])])
  ];
  return mediaReferences(...values);
}

async function getMediaOverview(): Promise<MediaOverview> {
  await initialize();
  const files = await collectionMedia(() => {});
  const references = mediaReferenceSet();
  const unused = files.filter((file) => !references.has(file.name));
  return {
    files: files.length,
    bytes: files.reduce((total, file) => total + file.bytes.length, 0),
    referencedFiles: files.length - unused.length,
    unusedFiles: unused.length,
    unusedBytes: unused.reduce((total, file) => total + file.bytes.length, 0)
  };
}

async function removeUnusedMedia(progress: (message: string) => void): Promise<MediaCleanupResult> {
  await initialize();
  const files = await collectionMedia(() => {});
  const references = mediaReferenceSet();
  const unused = files.filter((file) => !references.has(file.name));
  const directory = await mediaDirectory(false);
  let removedBytes = 0;
  for (const [index, file] of unused.entries()) {
    progress(`Removing unused media ${index + 1} of ${unused.length}…`);
    if (directory) {
      try { await directory.removeEntry(file.name); }
      catch (error) { if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error; }
    }
    memoryMedia.delete(file.name);
    removedBytes += file.bytes.length;
  }
  return { files: unused.length, bytes: removedBytes };
}

function mediaMimeType(filename: string) {
  const extension = filename.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = {
    avif: "image/avif", gif: "image/gif", jpg: "image/jpeg", jpeg: "image/jpeg",
    png: "image/png", svg: "image/svg+xml", webp: "image/webp",
    mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "video/mp4", oga: "audio/ogg",
    ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", webm: "audio/webm",
    woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf"
  };
  return types[extension ?? ""] ?? "application/octet-stream";
}

function base64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function mediaDataUrl(filenameInput: string) {
  let filename: string;
  try {
    filename = safeMediaFilename(decodeURIComponent(filenameInput.replaceAll("&amp;", "&")));
  } catch {
    return null;
  }

  let bytes = memoryMedia.get(filename);
  if (!bytes) {
    const directory = await mediaDirectory(false);
    if (!directory) return null;
    try {
      const file = await (await directory.getFileHandle(filename)).getFile();
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
  }
  return `data:${mediaMimeType(filename)};base64,${base64(bytes)}`;
}

async function inlineMedia(html: string, css: string) {
  const filenames = new Set<string>();
  for (const match of html.matchAll(/\[sound:([^\]]+)]/gi)) filenames.add(match[1]);
  for (const match of html.matchAll(/\b(?:src|poster)\s*=\s*["']([^"']+)["']/gi)) filenames.add(match[1]);
  for (const match of `${html}\n${css}`.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) filenames.add(match[1].trim());

  const urls = new Map<string, string>();
  for (const filename of filenames) {
    if (/^(?:data:|blob:|https?:|\/|#)/i.test(filename)) continue;
    const url = await mediaDataUrl(filename);
    if (url) urls.set(filename, url);
  }

  const inlineCssUrls = (value: string) => value.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (original, _quote: string, filename: string) => {
    const url = urls.get(filename.trim());
    return url ? `url(${url})` : original;
  });
  const renderedHtml = inlineCssUrls(html)
    .replace(/\[sound:([^\]]+)]/gi, (marker, filename: string) => {
      const url = urls.get(filename);
      return url
        ? `<audio class="anki-audio" controls preload="metadata" src="${url}"></audio>`
        : marker;
    })
    .replace(/\b(src|poster)\s*=\s*(["'])([^"']+)\2/gi, (attribute, name: string, quote: string, filename: string) => {
      const url = urls.get(filename);
      return url ? `${name}=${quote}${url}${quote}` : attribute;
    });
  const renderedCss = inlineCssUrls(css);

  return { html: renderedHtml, css: renderedCss };
}

async function fieldChecksum(value: string) {
  const bytes = new TextEncoder().encode(plainText(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  return digest.slice(0, 4).reduce((number, byte) => number * 256 + byte, 0);
}

function uniqueId(database: Database, table: "notes" | "cards" | "revlog", candidate = Date.now()) {
  const maximum = Number(database.selectValue(`SELECT max(id) FROM ${table}`) ?? 0);
  return Math.max(candidate, maximum + 1);
}

async function insertNote(deckId: number, notetypeId: number, fields: string[], ordinals: number[]): Promise<number[]> {
  await initialize();
  const database = collection();
  if (!fields[0]?.trim()) throw new Error("The first field cannot be empty");
  const deck = readDecks(database)[String(deckId)];
  if (!deck) throw new Error("Deck not found");
  if (!readNotetypes(database)[String(notetypeId)]) throw new Error("Note type not found");
  if (!ordinals.length) throw new Error("This note does not generate any cards");

  const checksum = await fieldChecksum(fields[0]);
  const noteId = uniqueId(database, "notes");
  const firstCardId = uniqueId(database, "cards", noteId + 1);
  const insertion = deckOptionsFor(database, deck).newCardInsertOrder;
  const maximumDue = Number(database.selectValue("SELECT coalesce(max(due), 0) FROM cards WHERE type = 0") ?? 0);
  const randomValue = crypto.getRandomValues(new Uint32Array(1))[0] / 0x1_0000_0000;
  const firstDue = insertion === "random" ? 1 + Math.floor(randomValue * (maximumDue + 1)) : maximumDue + 1;
  const mod = nowSeconds();
  const guid = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  const cardIds = ordinals.map((_ordinal, index) => firstCardId + index);

  database.transaction("IMMEDIATE", (transaction) => {
    if (insertion === "random") {
      transaction.exec({ sql: "UPDATE cards SET due = due + 1, mod = ?, usn = -1 WHERE type = 0 AND due >= ?", bind: [mod, firstDue] });
    }
    transaction.exec({
      sql: `INSERT INTO notes
        (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)
        VALUES (?, ?, ?, ?, -1, '', ?, ?, ?, 0, '')`,
      bind: [noteId, guid, notetypeId, mod, fields.join(FIELD_SEPARATOR), plainText(fields[0]), checksum]
    });
    ordinals.forEach((ordinal, index) => {
      transaction.exec({
        sql: `INSERT INTO cards
          (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data)
          VALUES (?, ?, ?, ?, ?, -1, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, '')`,
        bind: [cardIds[index], noteId, deckId, ordinal, mod, firstDue]
      });
    });
    touchCollection(transaction);
  });

  return cardIds;
}

async function addBasicNote(deckId: number, frontInput: string, backInput: string) {
  return insertNote(deckId, BASIC_NOTETYPE_ID, [frontInput.trim(), backInput.trim()], [0]);
}

async function addClozeNote(deckId: number, textInput: string, extraInput: string) {
  const text = textInput.trim();
  const ordinals = clozeOrdinals([text]);
  if (!ordinals.length) throw new Error("Add at least one cloze deletion, such as {{c1::answer}}");
  return insertNote(deckId, CLOZE_NOTETYPE_ID, [text, extraInput.trim()], ordinals);
}

function standardCardOrdinals(notetype: AnkiNotetype, fields: string[]) {
  return notetype.tmpls.flatMap((template, index) => {
    const ordinal = template.ord ?? index;
    const requirement = notetype.req?.find(([cardOrdinal]) => cardOrdinal === ordinal);
    if (requirement) {
      const [, kind, fieldOrdinals] = requirement;
      const present = fieldOrdinals.map((fieldOrdinal) => plainText(fields[fieldOrdinal] ?? "").trim().length > 0);
      const generates = kind === "all"
        ? present.every(Boolean)
        : kind === "none"
          ? present.every((value) => !value)
          : present.some(Boolean);
      return generates ? [ordinal] : [];
    }

    try {
      const question = renderAnkiCard(notetype, fields, ordinal).questionHtml;
      return plainText(question).trim() ? [ordinal] : [];
    } catch {
      return [];
    }
  });
}

async function addNoteForNotetype(deckId: number, notetypeId: number, fieldsInput: string[]) {
  await initialize();
  const notetype = readNotetypes()[String(notetypeId)];
  if (!notetype) throw new Error("Note type not found");
  const fields = notetype.flds.map((_field, index) => fieldsInput[index]?.trim() ?? "");
  const ordinals = notetype.type === 1 ? clozeOrdinals(fields) : standardCardOrdinals(notetype, fields);
  if (notetype.type === 1 && !ordinals.length) {
    throw new Error("Add at least one cloze deletion, such as {{c1::answer}}");
  }
  return insertNote(deckId, notetypeId, fields, ordinals);
}

const BROWSE_PAGE_SIZE = 50;

function cardStatus(queue: number): BrowserCard["status"] {
  if (queue === -1) return "suspended";
  if (queue === -2 || queue === -3) return "buried";
  return "active";
}

function storedTags(value: unknown) {
  return String(value ?? "").trim().split(/\s+/).filter(Boolean);
}

function normalizeTags(input: string[]) {
  const tags = [...new Set(input.flatMap((value) => value.split(/[\s,]+/))
    .map((value) => value.trim().replace(/[\u0000-\u001f\u007f]/g, ""))
    .filter(Boolean))];
  if (tags.some((tag) => tag.length > 100)) throw new Error("Tags must be 100 characters or shorter");
  if (tags.join(" ").length > 10_000) throw new Error("This note has too many tags");
  return tags;
}

function browserNotes(rows: Record<string, unknown>[], database: Database): BrowserNote[] {
  if (!rows.length) return [];
  const noteIds = rows.map((row) => Number(row.id));
  const placeholders = noteIds.map(() => "?").join(",");
  const cardRows = database.selectObjects(
    `SELECT id, nid, did, ord, type, queue, ivl, reps, lapses, due, odue, flags
     FROM cards WHERE nid IN (${placeholders}) ORDER BY nid, ord, id`,
    noteIds
  );
  const cardsByNote = new Map<number, Record<string, unknown>[]>();
  for (const card of cardRows) {
    const noteId = Number(card.nid);
    const cards = cardsByNote.get(noteId) ?? [];
    cards.push(card);
    cardsByNote.set(noteId, cards);
  }
  const decks = readDecks(database);
  const notetypes = readNotetypes(database);

  return rows.map((row) => {
    const noteId = Number(row.id);
    const notetypeId = Number(row.mid);
    const notetype = notetypes[String(notetypeId)];
    const fields = String(row.flds).split(FIELD_SEPARATOR);
    const fieldNames = notetype?.flds.map((field, index) => ({ name: field.name, ordinal: field.ord ?? index }))
      .sort((a, b) => a.ordinal - b.ordinal).map((field) => field.name)
      ?? fields.map((_field, index) => `Field ${index + 1}`);
    const cards = (cardsByNote.get(noteId) ?? []).map((card): BrowserCard => {
      const ordinal = Number(card.ord);
      const template = notetype?.tmpls.find((candidate, index) => (candidate.ord ?? index) === ordinal);
      const deckId = Number(card.did);
      return {
        id: Number(card.id),
        deckId,
        deckName: decks[String(deckId)]?.name ?? `Deck ${deckId}`,
        ordinal,
        flag: Number(card.flags) & 7,
        due: Number(card.odue) || Number(card.due),
        dueLabel: Number(card.type) === 0 ? `New #${card.due}`
          : Number(card.queue) === 1 || Number(card.queue) === 4 || (Number(card.queue) < 0 && Number(card.due) > 1_000_000_000)
            ? new Date((Number(card.odue) || Number(card.due)) * 1000).toLocaleString()
            : new Date((Number(database.selectValue("SELECT crt FROM col WHERE id = 1")) + (Number(card.odue) || Number(card.due)) * 86400) * 1000).toLocaleDateString(),
        templateName: template?.name ?? `Card ${ordinal + 1}`,
        state: stateForCard(Number(card.type), Number(card.queue)),
        status: cardStatus(Number(card.queue)),
        intervalDays: Math.max(0, Number(card.ivl)),
        reviews: Math.max(0, Number(card.reps)),
        lapses: Math.max(0, Number(card.lapses))
      };
    });
    const preview = plainText(String(row.sfld ?? fields[0] ?? "")).replace(/\s+/g, " ").slice(0, 240);
    return {
      id: noteId,
      notetypeId,
      notetypeName: notetype?.name ?? `Note type ${notetypeId}`,
      cloze: notetype?.type === 1,
      fieldNames,
      fields,
      tags: storedTags(row.tags),
      preview: preview || "(No text in first field)",
      modified: Number(row.mod),
      cards
    };
  });
}

async function browseNotes(queryInput: string, deckId: number | null, offsetInput: number): Promise<BrowseNotesResult> {
  await initialize();
  const database = collection();
  unburyCardsForNewDay(database);
  const query = queryInput.trim().slice(0, 200);
  const offset = Math.max(0, Math.min(100_000, Math.floor(offsetInput) || 0));
  const clauses: string[] = [];
  const bind: Array<string | number> = [];
  if (query) {
    clauses.push("(instr(lower(n.flds), lower(?)) > 0 OR instr(lower(n.tags), lower(?)) > 0 OR instr(lower(n.sfld), lower(?)) > 0)");
    bind.push(query, query, query);
  }
  if (deckId !== null) {
    const decks = readDecks(database);
    if (!decks[String(deckId)]) throw new Error("Deck not found");
    const scopeIds = deckScopeIds(decks, deckId);
    clauses.push(`EXISTS (SELECT 1 FROM cards filtered_card WHERE filtered_card.nid = n.id AND filtered_card.did IN (${scopeIds.map(() => "?").join(",")}))`);
    bind.push(...scopeIds);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = Number(database.selectValue(`SELECT count(*) FROM notes n ${where}`, bind.length ? bind : undefined) ?? 0);
  const rows = database.selectObjects(
    `SELECT n.id, n.mid, n.mod, n.tags, n.flds, n.sfld
     FROM notes n ${where} ORDER BY n.mod DESC, n.id DESC LIMIT ? OFFSET ?`,
    [...bind, BROWSE_PAGE_SIZE, offset]
  );
  return {
    notes: browserNotes(rows, database),
    total,
    offset,
    hasMore: offset + rows.length < total
  };
}

async function getBrowserMetadata(): Promise<BrowserMetadata> {
  await initialize();
  const database = collection();
  return {
    tags: [...new Set(database.selectObjects("SELECT DISTINCT tags FROM notes").flatMap((row) => storedTags(row.tags)))].sort((a, b) => a.localeCompare(b)),
    notetypes: Object.values(readNotetypes(database)).map((note) => ({
      id: Number(note.id), name: note.name,
      templates: note.tmpls.map((template, index) => ({ ordinal: template.ord ?? index, name: template.name }))
    }))
  };
}

async function browseCollection(options: BrowserOptions): Promise<BrowserResults> {
  await initialize();
  const database = collection();
  unburyCardsForNewDay(database);
  const decks = Object.values(readDecks(database)).map((deck) => ({ id: Number(deck.id), name: deck.name }));
  const notetypes = Object.values(readNotetypes(database));
  const creation = Number(database.selectValue("SELECT crt FROM col WHERE id = 1"));
  const today = collectionDay(database);
  const search = browserSearch(options.query, { today, dayStart: creation + today * 86400, now: nowSeconds(), decks,
    notetypes: notetypes.map((note) => ({ id: Number(note.id), name: note.name })), currentDeckId: options.currentDeckId });
  const mode = options.mode === "notes" ? "notes" : "cards";
  const offset = Math.max(0, Math.floor(options.offset) || 0);
  // Names live in collection JSON. Bind them in CASE expressions for global sorting before pagination.
  const sortBind: (string | number)[] = [];
  const nameCase = (column: string, entries: { id: number; name: string }[]) => {
    if (!entries.length) return "''";
    for (const entry of entries) sortBind.push(entry.id, entry.name);
    return `(CASE ${column} ${entries.map(() => "WHEN ? THEN ?").join(" ")} ELSE '' END)`;
  };
  let sort = "n.sfld COLLATE NOCASE";
  if (options.sort === "deck") sort = nameCase("c.did", decks) + " COLLATE NOCASE";
  else if (options.sort === "cardType") {
    const entries = notetypes.flatMap((note) => note.tmpls.map((template, index) => ({ mid: Number(note.id), ord: template.ord ?? index, name: template.name })));
    if (entries.length) {
      for (const entry of entries) sortBind.push(entry.mid, entry.ord, entry.name);
      sort = `(CASE ${entries.map(() => "WHEN n.mid = ? AND c.ord = ? THEN ?").join(" ")} ELSE '' END) COLLATE NOCASE`;
    }
  } else if (options.sort === "due") {
    const due = "(CASE WHEN c.odue != 0 THEN c.odue ELSE c.due END)";
    sort = `(CASE WHEN c.type = 0 THEN c.due WHEN ${due} > 1000000000 THEN ${due} ELSE ${creation} + ${due} * 86400 END)`;
  }
  const total = Number(database.selectValue(`SELECT count(${mode === "notes" ? "DISTINCT n.id" : "*"}) FROM cards c JOIN notes n ON n.id = c.nid WHERE ${search.sql}`, search.bind.length ? search.bind : undefined));
  const matches = database.selectObjects(
    `SELECT n.id, n.mid, n.mod, n.tags, n.flds, n.sfld, ${mode === "notes" ? "min(c.id)" : "c.id"} AS card_id
     FROM cards c JOIN notes n ON n.id = c.nid WHERE ${search.sql}
     ${mode === "notes" ? "GROUP BY n.id" : ""}
     ORDER BY ${sort} ${options.descending ? "DESC" : "ASC"}, card_id LIMIT ? OFFSET ?`,
    [...search.bind, ...sortBind, BROWSE_PAGE_SIZE, offset]
  );
  const notes = browserNotes(matches, database);
  return { total, hasMore: offset + matches.length < total,
    rows: matches.map((row, index) => ({ note: notes[index], card: notes[index].cards.find((card) => card.id === Number(row.card_id))! })) };
}

async function setExistingCardFlag(cardId: number, flag: number): Promise<void> {
  await initialize();
  if (!Number.isInteger(flag) || flag < 0 || flag > 7) throw new Error("Invalid flag");
  const database = collection();
  if (!database.selectValue("SELECT id FROM cards WHERE id = ?", [cardId])) throw new Error("Card not found");
  database.transaction("IMMEDIATE", (transaction) => {
    transaction.exec({ sql: "UPDATE cards SET flags = (flags & ~7) | ?, mod = ?, usn = -1 WHERE id = ?", bind: [flag, nowSeconds(), cardId] });
    touchCollection(transaction);
  });
}

function desiredOrdinals(notetype: AnkiNotetype, fields: string[]) {
  const ordinals = notetype.type === 1 ? clozeOrdinals(fields) : standardCardOrdinals(notetype, fields);
  return [...new Set(ordinals)].sort((a, b) => a - b);
}

async function updateExistingNote(noteId: number, fieldsInput: string[], tagsInput: string[]): Promise<void> {
  await initialize();
  const database = collection();
  const note = database.selectObject("SELECT id, mid FROM notes WHERE id = ?", [noteId]);
  if (!note) throw new Error("Note not found");
  const notetype = readNotetypes(database)[String(note.mid)];
  if (!notetype) throw new Error("Note type not found");
  if (fieldsInput.length !== notetype.flds.length) throw new Error("The note fields do not match its note type");
  const fields = fieldsInput.map((field) => String(field));
  if (!fields[0]?.trim()) throw new Error("The first field cannot be empty");
  const ordinals = desiredOrdinals(notetype, fields);
  if (!ordinals.length) throw new Error("This edit would remove every card generated by the note");
  const tags = normalizeTags(tagsInput);
  const checksum = await fieldChecksum(fields[0]);
  const existingCards = database.selectObjects("SELECT id, did, ord FROM cards WHERE nid = ? ORDER BY id", [noteId]);
  const existingOrdinals = new Set(existingCards.map((card) => Number(card.ord)));
  const removedCards = existingCards.filter((card) => !ordinals.includes(Number(card.ord)));
  const missingOrdinals = ordinals.filter((ordinal) => !existingOrdinals.has(ordinal));
  const deckId = Number(existingCards[0]?.did ?? notetype.did ?? DEFAULT_DECK_ID);
  const firstCardId = uniqueId(database, "cards", Date.now());
  const firstDue = Number(database.selectValue("SELECT coalesce(max(due), 0) + 1 FROM cards WHERE type = 0") ?? 1);
  const mod = nowSeconds();

  database.transaction("IMMEDIATE", (transaction) => {
    transaction.exec({
      sql: "UPDATE notes SET mod = ?, usn = -1, tags = ?, flds = ?, sfld = ?, csum = ? WHERE id = ?",
      bind: [mod, tags.length ? ` ${tags.join(" ")} ` : "", fields.join(FIELD_SEPARATOR), plainText(fields[0]), checksum, noteId]
    });
    for (const card of removedCards) {
      transaction.exec({ sql: "INSERT INTO graves (usn, oid, type) VALUES (-1, ?, 0)", bind: [Number(card.id)] });
      transaction.exec({ sql: "DELETE FROM revlog WHERE cid = ?", bind: [Number(card.id)] });
      transaction.exec({ sql: "DELETE FROM cards WHERE id = ?", bind: [Number(card.id)] });
    }
    missingOrdinals.forEach((ordinal, index) => transaction.exec({
      sql: `INSERT INTO cards
        (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data)
        VALUES (?, ?, ?, ?, ?, -1, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, '')`,
      bind: [firstCardId + index, noteId, deckId, ordinal, mod, firstDue + index]
    }));
    touchCollection(transaction);
  });
}

async function deleteExistingNote(noteId: number): Promise<void> {
  await initialize();
  const database = collection();
  if (!database.selectValue("SELECT 1 FROM notes WHERE id = ?", [noteId])) throw new Error("Note not found");
  const cardIds = database.selectObjects("SELECT id FROM cards WHERE nid = ?", [noteId]).map((row) => Number(row.id));
  database.transaction("IMMEDIATE", (transaction) => {
    for (const cardId of cardIds) {
      transaction.exec({ sql: "INSERT INTO graves (usn, oid, type) VALUES (-1, ?, 0)", bind: [cardId] });
    }
    transaction.exec({ sql: "INSERT INTO graves (usn, oid, type) VALUES (-1, ?, 1)", bind: [noteId] });
    transaction.exec({ sql: "DELETE FROM revlog WHERE cid IN (SELECT id FROM cards WHERE nid = ?)", bind: [noteId] });
    transaction.exec({ sql: "DELETE FROM cards WHERE nid = ?", bind: [noteId] });
    transaction.exec({ sql: "DELETE FROM notes WHERE id = ?", bind: [noteId] });
    touchCollection(transaction);
  });
}

async function setExistingCardStatus(cardId: number, status: BrowserCard["status"]): Promise<void> {
  await initialize();
  const database = collection();
  const card = database.selectObject("SELECT type, queue FROM cards WHERE id = ?", [cardId]);
  if (!card) throw new Error("Card not found");
  const queue = status === "suspended" ? -1 : status === "buried" ? -2
    : Number(card.type) === 0 ? 0 : Number(card.type) === 2 ? 2 : 1;
  if (queue === Number(card.queue)) return;
  database.transaction("IMMEDIATE", (transaction) => {
    transaction.exec({ sql: "UPDATE cards SET queue = ?, mod = ?, usn = -1 WHERE id = ?", bind: [queue, nowSeconds(), cardId] });
    if (status === "buried") {
      const conf = JSON.parse(String(transaction.selectValue("SELECT conf FROM col WHERE id = 1") ?? "{}")) as Record<string, unknown>;
      conf.lastUnburied = collectionDay(transaction);
      transaction.exec({ sql: "UPDATE col SET conf = ? WHERE id = 1", bind: [JSON.stringify(conf)] });
    }
    touchCollection(transaction);
  });
}

async function setExistingNoteStatus(noteId: number, status: "suspended" | "buried"): Promise<void> {
  await initialize();
  const database = collection();
  if (!database.selectValue("SELECT 1 FROM notes WHERE id = ?", [noteId])) throw new Error("Note not found");
  const queue = status === "suspended" ? -1 : -2;
  database.transaction("IMMEDIATE", (transaction) => {
    transaction.exec({ sql: "UPDATE cards SET queue = ?, mod = ?, usn = -1 WHERE nid = ?", bind: [queue, nowSeconds(), noteId] });
    if (status === "buried") {
      const conf = JSON.parse(String(transaction.selectValue("SELECT conf FROM col WHERE id = 1") ?? "{}")) as Record<string, unknown>;
      conf.lastUnburied = collectionDay(transaction);
      transaction.exec({ sql: "UPDATE col SET conf = ? WHERE id = 1", bind: [JSON.stringify(conf)] });
    }
    touchCollection(transaction);
  });
}

async function setExistingNoteMarked(noteId: number, marked: boolean): Promise<void> {
  await initialize();
  const database = collection();
  const note = database.selectObject("SELECT tags FROM notes WHERE id = ?", [noteId]);
  if (!note) throw new Error("Note not found");
  const tags = storedTags(note.tags).filter((tag) => tag.toLocaleLowerCase() !== "marked");
  if (marked) tags.push("marked");
  database.transaction("IMMEDIATE", (transaction) => {
    transaction.exec({ sql: "UPDATE notes SET tags = ?, mod = ?, usn = -1 WHERE id = ?", bind: [tags.length ? ` ${tags.join(" ")} ` : "", nowSeconds(), noteId] });
    touchCollection(transaction);
  });
}

async function resetExistingCard(cardId: number): Promise<void> {
  await initialize();
  const database = collection();
  if (!database.selectValue("SELECT 1 FROM cards WHERE id = ?", [cardId])) throw new Error("Card not found");
  const due = Number(database.selectValue("SELECT coalesce(max(due), 0) + 1 FROM cards WHERE type = 0") ?? 1);
  database.transaction("IMMEDIATE", (transaction) => {
    transaction.exec({
      sql: `UPDATE cards SET mod = ?, usn = -1, type = 0, queue = 0, due = ?, ivl = 0,
        factor = 0, reps = 0, lapses = 0, left = 0, odue = 0, odid = 0, data = '' WHERE id = ?`,
      bind: [nowSeconds(), due, cardId]
    });
    touchCollection(transaction);
  });
}

async function setExistingCardDue(cardId: number, daysInput: number): Promise<void> {
  await initialize();
  const database = collection();
  if (!Number.isInteger(daysInput) || daysInput < 0 || daysInput > 36_500) throw new Error("Due days must be between 0 and 36500");
  if (!database.selectValue("SELECT 1 FROM cards WHERE id = ?", [cardId])) throw new Error("Card not found");
  database.transaction("IMMEDIATE", (transaction) => {
    transaction.exec({
      sql: `UPDATE cards SET mod = ?, usn = -1, type = 2, queue = 2, due = ?, ivl = ?,
        factor = CASE WHEN factor > 0 THEN factor ELSE 2500 END, left = 0, odue = 0, odid = 0 WHERE id = ?`,
      bind: [nowSeconds(), collectionDay(transaction) + daysInput, Math.max(1, daysInput), cardId]
    });
    touchCollection(transaction);
  });
}

function stateForCard(type: number, queue: number): CardState {
  if (queue === 0 || type === 0) return "new";
  if (type === 3) return "relearning";
  if (queue === 1 || queue === 3 || type === 1) return "learning";
  return "review";
}

function parseCardData(value: unknown): StoredCardData {
  try {
    const parsed = JSON.parse(String(value || "{}")) as StoredCardData;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function fsrsState(type: number) {
  if (type === 1) return State.Learning;
  if (type === 2) return State.Review;
  if (type === 3) return State.Relearning;
  return State.New;
}

function learningStepsCompleted(state: State, left: number, options: DeckOptions) {
  const remaining = Math.max(0, left % 1000);
  if (state === State.Learning) return Math.max(0, options.learningStepsMinutes.length - remaining);
  if (state === State.Relearning) return Math.max(0, options.relearningStepsMinutes.length - remaining);
  return 0;
}

function dueDateForCard(row: Record<string, unknown>, database: Database) {
  const queue = Number(row.queue);
  const due = Number(row.due);
  if (queue === 1) return new Date(due * 1000);
  if (queue === 2 || queue === 3) {
    const creation = Number(database.selectValue("SELECT crt FROM col WHERE id = 1") ?? collectionCreationSeconds());
    return new Date((creation + due * 86_400) * 1000);
  }
  return new Date();
}

function toFsrsCard(row: Record<string, unknown>, database: Database, now: Date, options: DeckOptions): CardInput {
  const data = parseCardData(row.data);
  const state = fsrsState(Number(row.type));
  const lastReviewSeconds = Number(data.lrt ?? row.last_review_seconds ?? 0);
  const lastReview = lastReviewSeconds > 0 ? new Date(lastReviewSeconds * 1000) : undefined;
  const interval = Math.max(0, Number(row.ivl));
  const elapsedDays = lastReview
    ? Math.max(0, Math.round((now.getTime() - lastReview.getTime()) / 86_400_000))
    : 0;

  return {
    due: dueDateForCard(row, database),
    stability: state === State.New ? 0 : Math.max(0.1, Number(data.s) || interval || 1),
    difficulty: state === State.New ? 0 : Math.min(10, Math.max(1, Number(data.d) || 5)),
    elapsed_days: elapsedDays,
    scheduled_days: interval,
    learning_steps: learningStepsCompleted(state, Number(row.left), options),
    reps: Math.max(0, Number(row.reps)),
    lapses: Math.max(0, Number(row.lapses)),
    state,
    last_review: lastReview
  };
}

function previewForCard(row: Record<string, unknown>, database: Database, now = new Date()) {
  const { scheduler, options } = schedulerForDeck(database, Number(row.did));
  scheduler.seed = `${String(row.id)}:${String(row.reps)}`;
  return scheduler.repeat(toFsrsCard(row, database, now, options), now);
}

function intervalLabel(due: Date, now: Date) {
  const seconds = Math.max(1, Math.round((due.getTime() - now.getTime()) / 1000));
  if (seconds < 3_600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 86_400) return `${Math.max(1, Math.round(seconds / 3_600))}h`;

  const days = Math.max(1, Math.round(seconds / 86_400));
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.max(1, Math.round(days / 30))}mo`;
  return `${Math.max(1, Math.round(days / 365))}y`;
}

function shiftedDifficulty(difficulty: number) {
  return Math.round((((difficulty - 1) / 9) + 0.1) * 1000);
}

function intervalForRevlog(result: RecordLogItem, now: Date) {
  if (result.card.state === State.Review) return result.card.scheduled_days;
  return -Math.max(1, Math.round((result.card.due.getTime() - now.getTime()) / 1000));
}

function remainingSteps(result: RecordLogItem, options: DeckOptions) {
  if (result.card.state === State.Learning) {
    return Math.max(0, options.learningStepsMinutes.length - result.card.learning_steps);
  }
  if (result.card.state === State.Relearning) {
    return Math.max(0, options.relearningStepsMinutes.length - result.card.learning_steps);
  }
  return 0;
}

function studyDueLabel(row: Record<string, unknown>, database: Database) {
  if (Number(row.type) === 0) return `New #${String(row.due)}`;
  if (Number(row.queue) === 1 || Number(row.queue) === 4 || Number(row.due) > 1_000_000_000) {
    return new Date(Number(row.due) * 1000).toLocaleString();
  }
  const creation = Number(database.selectValue("SELECT crt FROM col WHERE id = 1") ?? collectionCreationSeconds());
  return new Date((creation + Number(row.due) * 86_400) * 1000).toLocaleDateString();
}

async function studyCardFromRow(row: Record<string, unknown>, database: Database): Promise<StudyCard> {
  const decks = readDecks(database);
  const notetype = readNotetypes(database)[String(row.mid)];
  if (!notetype) throw new Error(`Note type ${String(row.mid)} is missing`);
  const fields = String(row.flds).split(FIELD_SEPARATOR);
  const rendered = renderAnkiCard(notetype, fields, Number(row.ord));
  const question = await inlineMedia(rendered.questionHtml, rendered.css);
  const answer = await inlineMedia(rendered.answerHtml, question.css);
  const now = new Date();
  const preview = previewForCard(row, database, now);
  const options = deckOptionsFor(database, decks[String(row.did)]);
  const fieldNames = notetype.flds.map((field, index) => ({ name: field.name, ordinal: field.ord ?? index }))
    .sort((a, b) => a.ordinal - b.ordinal).map((field) => field.name);
  const template = notetype.tmpls.find((candidate, index) => (candidate.ord ?? index) === Number(row.ord));
  return {
    id: Number(row.id),
    noteId: Number(row.nid),
    deckId: Number(row.did),
    deckName: decks[String(row.did)]?.name ?? `Deck ${String(row.did)}`,
    notetypeName: notetype.name,
    cloze: notetype.type === 1,
    templateName: template?.name ?? `Card ${Number(row.ord) + 1}`,
    fieldNames,
    fields,
    tags: storedTags(row.tags),
    flag: Number(row.flags) & 7,
    reviews: Math.max(0, Number(row.reps)),
    lapses: Math.max(0, Number(row.lapses)),
    dueLabel: studyDueLabel(row, database),
    timer: { show: options.showAnswerTimer, maximumSeconds: options.maximumAnswerSeconds, stopOnAnswer: options.stopTimerOnAnswer,
      secondsToShowQuestion: options.secondsToShowQuestion, secondsToShowAnswer: options.secondsToShowAnswer,
      questionTimeAction: options.questionTimeAction, answerTimeAction: options.answerTimeAction },
    questionHtml: question.html,
    answerHtml: answer.html,
    cardCss: answer.css,
    state: stateForCard(Number(row.type), Number(row.queue)),
    intervalDays: Number(row.ivl),
    ...(rendered.typedAnswer ? { typedAnswer: rendered.typedAnswer } : {}),
    answerOptions: ([Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as const).map((rating) => ({
      rating: rating as ReviewRating,
      intervalLabel: intervalLabel(preview[rating].card.due, now)
    }))
  };
}

async function getStudyCard(cardId: number): Promise<StudyCard | null> {
  await initialize();
  const database = collection();
  const row = database.selectObject(
    `SELECT c.id, c.nid, c.did, c.ord, c.type, c.queue, c.due, c.ivl, c.factor, c.reps, c.lapses,
       c.left, c.data, c.flags, n.mid, n.flds, n.tags,
       (SELECT max(r.id) / 1000 FROM revlog r WHERE r.cid = c.id) AS last_review_seconds
     FROM cards c JOIN notes n ON n.id = c.nid WHERE c.id = ?`,
    [cardId]
  );
  return row ? studyCardFromRow(row, database) : null;
}

function stableDailyHash(value: number, today: number) {
  let hash = (value ^ Math.imul(today + 1, 2_654_435_761)) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 2_246_822_507) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 13), 3_266_489_909) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

function compareNumbers(left: number, right: number) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortNewCards(rows: Record<string, unknown>[], options: DeckOptions, decks: Record<string, AnkiDeck>, today: number) {
  const gather = [...rows].sort((left, right) => {
    const leftDeck = decks[String(left.did)]?.name ?? "";
    const rightDeck = decks[String(right.did)]?.name ?? "";
    const due = compareNumbers(Number(left.due), Number(right.due));
    if (options.newCardGatherOrder === "deck") return leftDeck.localeCompare(rightDeck) || due;
    if (options.newCardGatherOrder === "deckRandomNotes") return leftDeck.localeCompare(rightDeck)
      || compareNumbers(stableDailyHash(Number(left.nid), today), stableDailyHash(Number(right.nid), today));
    if (options.newCardGatherOrder === "descending") return -due;
    if (options.newCardGatherOrder === "randomNotes") return compareNumbers(stableDailyHash(Number(left.nid), today), stableDailyHash(Number(right.nid), today));
    if (options.newCardGatherOrder === "randomCards") return compareNumbers(stableDailyHash(Number(left.id), today), stableDailyHash(Number(right.id), today));
    return due;
  });
  const gatherIndex = new Map(gather.map((row, index) => [Number(row.id), index]));
  return gather.sort((left, right) => {
    const gathered = compareNumbers(gatherIndex.get(Number(left.id)) ?? 0, gatherIndex.get(Number(right.id)) ?? 0);
    const template = compareNumbers(Number(left.ord), Number(right.ord));
    const cardHash = compareNumbers(stableDailyHash(Number(left.id), today), stableDailyHash(Number(right.id), today));
    const noteHash = compareNumbers(stableDailyHash(Number(left.nid), today), stableDailyHash(Number(right.nid), today));
    if (options.newCardSortOrder === "template") return template || gathered;
    if (options.newCardSortOrder === "templateRandom") return template || cardHash;
    if (options.newCardSortOrder === "randomNote") return noteHash || template;
    if (options.newCardSortOrder === "randomCard") return cardHash;
    return gathered;
  });
}

function fsrsDifficulty(row: Record<string, unknown>) {
  return Number(parseCardData(row.data).d) || 5;
}

function retrievability(row: Record<string, unknown>, today: number) {
  const stability = Math.max(0.1, Number(parseCardData(row.data).s) || Number(row.ivl) || 1);
  const elapsed = Math.max(0, Number(row.ivl) + today - Number(row.due));
  return Math.pow(1 + (19 / 81) * elapsed / stability, -0.5);
}

function sortReviewCards(rows: Record<string, unknown>[], options: DeckOptions, decks: Record<string, AnkiDeck>, today: number) {
  return [...rows].sort((left, right) => {
    const due = compareNumbers(Number(left.due), Number(right.due));
    const deck = (decks[String(left.did)]?.name ?? "").localeCompare(decks[String(right.did)]?.name ?? "");
    const interval = compareNumbers(Number(left.ivl), Number(right.ivl));
    const difficulty = compareNumbers(fsrsDifficulty(left), fsrsDifficulty(right));
    const recall = compareNumbers(retrievability(left, today), retrievability(right, today));
    const added = compareNumbers(Number(left.nid), Number(right.nid)) || compareNumbers(Number(left.ord), Number(right.ord));
    const random = compareNumbers(stableDailyHash(Number(left.id), today), stableDailyHash(Number(right.id), today));
    const relativeOverdue = compareNumbers(
      (today - Number(right.due)) / Math.max(1, Number(right.ivl)),
      (today - Number(left.due)) / Math.max(1, Number(left.ivl))
    );
    switch (options.reviewOrder) {
      case "dueDeck": return due || deck || random;
      case "deckDue": return deck || due || random;
      case "intervalAscending": return interval || random;
      case "intervalDescending": return -interval || random;
      case "easeAscending": return -difficulty || random;
      case "easeDescending": return difficulty || random;
      case "retrievabilityAscending": return recall || random;
      case "retrievabilityDescending": return -recall || random;
      case "relativeOverdueness": return relativeOverdue || random;
      case "random": return random;
      case "added": return added;
      case "reverseAdded": return -added;
      default: return due || random;
    }
  });
}

function chooseMixed<T>(before: T[], after: T[], order: DeckOptions["newCardReviewOrder"], beforeSeen: number, afterSeen: number) {
  if (order === "before") return before[0] ?? after[0];
  if (order === "after") return after[0] ?? before[0];
  if (!before.length) return after[0];
  if (!after.length) return before[0];
  return beforeSeen <= afterSeen ? before[0] : after[0];
}

function withinDailyLimits(database: Database, decks: Record<string, AnkiDeck>, selectedDeckId: number, cardDeckId: number,
  kind: "new" | "review", cache: Map<string, boolean>) {
  const key = `${kind}:${cardDeckId}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const selected = decks[String(selectedDeckId)];
  const cardDeck = decks[String(cardDeckId)];
  if (!selected || !cardDeck) return false;
  const startFromTop = deckOptionsFor(database, selected).limitsStartFromTop;
  const ancestors = Object.values(decks).filter((candidate) => candidate.dyn === 0
    && (startFromTop || candidate.id === selectedDeckId || candidate.name.startsWith(`${selected.name}::`))
    && (cardDeck.name === candidate.name || cardDeck.name.startsWith(`${candidate.name}::`)));
  const allowed = ancestors.every((ancestor) => {
    const activity = deckActivityToday(database, deckScopeIds(decks, ancestor.id));
    const options = deckOptionsFor(database, ancestor);
    return kind === "new" ? activity.introduced < options.newCardsPerDay : activity.reviews < options.maximumReviewsPerDay;
  });
  cache.set(key, allowed);
  return allowed;
}

async function getNextCard(deckId: number): Promise<StudyCard | null> {
  await initialize();
  const database = collection();
  unburyCardsForNewDay(database);
  const decks = readDecks(database);
  const deck = decks[String(deckId)];
  if (!deck) throw new Error("Deck not found");
  const scopeIds = deckScopeIds(decks, deckId);
  const placeholders = scopeIds.map(() => "?").join(",");
  const options = deckOptionsFor(database, deck);
  const activity = deckActivityToday(database, scopeIds);
  const configuredNewRemaining = Math.max(0, options.newCardsPerDay - activity.introduced);
  const reviewRemaining = Math.max(0, options.maximumReviewsPerDay - activity.reviews);

  const rows = database.selectObjects(
    `SELECT c.id, c.nid, c.did, c.ord, c.type, c.queue, c.due, c.ivl, c.factor, c.reps, c.lapses,
       c.left, c.data, c.flags, n.mid, n.flds, n.tags,
       (SELECT max(r.id) / 1000 FROM revlog r WHERE r.cid = c.id) AS last_review_seconds
     FROM cards c JOIN notes n ON n.id = c.nid
     WHERE c.did IN (${placeholders}) AND (
       (c.queue = 1 AND c.due <= ?) OR
       (c.queue = 3 AND c.due <= ?) OR
       (c.queue = 2 AND c.due <= ?) OR
       c.queue = 0
     )`,
    [...scopeIds, nowSeconds(), collectionDay(database), collectionDay(database)]
  );
  if (!rows.length) return null;
  const today = collectionDay(database);
  const dailyLimitCache = new Map<string, boolean>();
  const intraday = rows.filter((row) => Number(row.queue) === 1)
    .sort((left, right) => compareNumbers(Number(left.due), Number(right.due)));
  if (intraday[0]) return studyCardFromRow(intraday[0], database);
  const interday = reviewRemaining > 0 ? rows.filter((row) => Number(row.queue) === 3
    && withinDailyLimits(database, decks, deckId, Number(row.did), "review", dailyLimitCache))
    .sort((left, right) => compareNumbers(Number(left.due), Number(right.due)))
    : [];
  const reviews = reviewRemaining > 0
    ? sortReviewCards(rows.filter((row) => Number(row.queue) === 2
      && withinDailyLimits(database, decks, deckId, Number(row.did), "review", dailyLimitCache)), options, decks, today) : [];
  const due = chooseMixed(interday, reviews, options.interdayLearningReviewOrder, activity.introduced, activity.reviews);
  const newRemaining = options.newCardsIgnoreReviewLimit ? configuredNewRemaining
    : Math.min(configuredNewRemaining, Math.max(0, reviewRemaining - Math.min(reviewRemaining, interday.length + reviews.length)));
  const newCards = newRemaining > 0
    ? sortNewCards(rows.filter((row) => Number(row.queue) === 0
      && withinDailyLimits(database, decks, deckId, Number(row.did), "new", dailyLimitCache)), options, decks, today) : [];
  const row = chooseMixed(newCards, due ? [due] : [], options.newCardReviewOrder, activity.introduced, activity.reviews);
  if (!row) return null;
  return studyCardFromRow(row, database);
}

function leechThresholdReached(lapses: number, threshold: number) {
  if (threshold <= 0 || lapses < threshold) return false;
  return (lapses - threshold) % Math.max(1, Math.ceil(threshold / 2)) === 0;
}

async function answerCard(cardId: number, rating: ReviewRating, timeMsInput: number): Promise<AnswerCardResult> {
  await initialize();
  const database = collection();
  const card = database.selectObject(
    `SELECT c.id, c.nid, c.did, c.mod, c.usn, c.type, c.queue, c.due, c.ivl, c.factor, c.reps, c.lapses,
       c.left, c.odue, c.odid, c.flags, c.data,
       (SELECT max(r.id) / 1000 FROM revlog r WHERE r.cid = c.id) AS last_review_seconds
     FROM cards c WHERE c.id = ?`,
    [cardId]
  );
  if (!card) throw new Error("Card not found");

  const previousType = Number(card.type);
  const previousQueue = Number(card.queue);
  const previousInterval = Number(card.ivl);
  const now = new Date();
  const nowSecs = Math.floor(now.getTime() / 1000);
  const today = collectionDay(database);
  const configured = schedulerForDeck(database, Number(card.did));
  configured.scheduler.seed = `${String(card.id)}:${String(card.reps)}`;
  const result = configured.scheduler.next(toFsrsCard(card, database, now, configured.options), now, rating as Grade);
  const type = result.card.state;
  let queue = result.card.state === State.Review ? 2 : 1;
  let interval = result.card.state === State.Review
    ? result.card.scheduled_days
    : previousInterval;
  if ((previousType === 2 || previousType === 3) && rating === Rating.Again && result.card.state === State.Review) {
    interval = Math.max(interval, configured.options.minimumLapseIntervalDays);
  }
  const due = result.card.state === State.Review
    ? today + interval
    : Math.floor(result.card.due.getTime() / 1000);
  const factor = Number(card.factor) || 2500;
  const left = remainingSteps(result, configured.options);
  const loggedInterval = result.card.state === State.Review ? interval : intervalForRevlog(result, now);
  const data: StoredCardData = {
    s: Number(result.card.stability.toFixed(4)),
    d: Number(result.card.difficulty.toFixed(3)),
    dr: configured.options.desiredRetentionPercent / 100,
    lrt: nowSecs
  };

  const reviewKind = previousType === 2 ? 1 : previousType === 3 ? 2 : 0;
  const reviewId = uniqueId(database, "revlog");
  const timeMs = Math.max(0, Math.min(configured.options.maximumAnswerSeconds * 1_000, Math.round(timeMsInput)));
  const lastInterval = previousQueue === 1
    ? -Math.max(1, Number(card.due) - Number(parseCardData(card.data).lrt ?? card.last_review_seconds ?? nowSecs))
    : previousInterval;

  const siblings = database.selectObjects(
    "SELECT id, mod, usn, type, queue FROM cards WHERE nid = ? AND id != ? AND queue >= 0",
    [Number(card.nid), cardId]
  ).filter((sibling) => {
    const siblingType = Number(sibling.type);
    const siblingQueue = Number(sibling.queue);
    if (previousQueue === 0) return siblingType === 0 && configured.options.buryNewSiblings;
    if (previousQueue === 2) return (siblingType === 0 && configured.options.buryNewSiblings)
      || (siblingType === 2 && configured.options.buryReviewSiblings);
    return (siblingType === 0 && configured.options.buryNewSiblings)
      || (siblingType === 2 && configured.options.buryReviewSiblings)
      || (siblingQueue === 3 && configured.options.buryInterdayLearningSiblings);
  });
  const leeched = (previousType === 2 || previousType === 3) && rating === Rating.Again
    && leechThresholdReached(result.card.lapses, configured.options.leechThreshold);
  const noteBeforeLeech = leeched
    ? database.selectObject("SELECT id, tags, mod, usn FROM notes WHERE id = ?", [Number(card.nid)]) : null;
  const suspended = leeched && configured.options.leechAction === "suspend";
  if (suspended) queue = -1;

  database.transaction("IMMEDIATE", (transaction) => {
    transaction.exec({
      sql: `UPDATE cards SET
        mod = ?, usn = -1, type = ?, queue = ?, due = ?, ivl = ?, factor = ?,
        reps = ?, lapses = ?, left = ?, data = ? WHERE id = ?`,
      bind: [
        nowSecs,
        type,
        queue,
        due,
        interval,
        factor,
        result.card.reps,
        result.card.lapses,
        left,
        JSON.stringify(data),
        cardId
      ]
    });
    transaction.exec({
      sql: `INSERT INTO revlog
        (id, cid, usn, ease, ivl, lastIvl, factor, time, type)
        VALUES (?, ?, -1, ?, ?, ?, ?, ?, ?)`,
      bind: [
        reviewId,
        cardId,
        rating,
        loggedInterval,
        lastInterval,
        shiftedDifficulty(result.card.difficulty),
        timeMs,
        reviewKind
      ]
    });
    for (const sibling of siblings) {
      transaction.exec({ sql: "UPDATE cards SET queue = -3, mod = ?, usn = -1 WHERE id = ?", bind: [nowSecs, Number(sibling.id)] });
    }
    if (siblings.length) {
      const conf = JSON.parse(String(transaction.selectValue("SELECT conf FROM col WHERE id = 1") ?? "{}")) as Record<string, unknown>;
      conf.lastUnburied = today;
      transaction.exec({ sql: "UPDATE col SET conf = ? WHERE id = 1", bind: [JSON.stringify(conf)] });
    }
    if (leeched && noteBeforeLeech) {
      const tags = storedTags(noteBeforeLeech.tags);
      if (!tags.some((tag) => tag.toLocaleLowerCase() === "leech")) tags.push("leech");
      transaction.exec({ sql: "UPDATE notes SET tags = ?, mod = ?, usn = -1 WHERE id = ?",
        bind: [tags.length ? ` ${tags.join(" ")} ` : "", nowSecs, Number(card.nid)] });
    }
    touchCollection(transaction);
  });
  lastReviewUndo = { cardId, reviewId, card: {
    mod: Number(card.mod), usn: Number(card.usn), type: Number(card.type), queue: Number(card.queue),
    due: Number(card.due), ivl: Number(card.ivl), factor: Number(card.factor), reps: Number(card.reps),
    lapses: Number(card.lapses), left: Number(card.left), odue: Number(card.odue), odid: Number(card.odid),
    flags: Number(card.flags), data: String(card.data ?? "")
  }, siblings: siblings.map((sibling) => ({ id: Number(sibling.id), mod: Number(sibling.mod), usn: Number(sibling.usn), queue: Number(sibling.queue) })),
  leechNote: noteBeforeLeech ? { id: Number(noteBeforeLeech.id), tags: String(noteBeforeLeech.tags ?? ""),
    mod: Number(noteBeforeLeech.mod), usn: Number(noteBeforeLeech.usn) } : null };
  return { leeched, suspended };
}

async function undoLastReview(): Promise<number | null> {
  await initialize();
  if (!lastReviewUndo) return null;
  const database = collection();
  const undo = lastReviewUndo;
  if (!database.selectValue("SELECT 1 FROM cards WHERE id = ?", [undo.cardId])
    || !database.selectValue("SELECT 1 FROM revlog WHERE id = ? AND cid = ?", [undo.reviewId, undo.cardId])) {
    lastReviewUndo = null;
    return null;
  }
  const card = undo.card;
  database.transaction("IMMEDIATE", (transaction) => {
    transaction.exec({
      sql: `UPDATE cards SET mod = ?, usn = ?, type = ?, queue = ?, due = ?, ivl = ?, factor = ?,
        reps = ?, lapses = ?, left = ?, odue = ?, odid = ?, flags = ?, data = ? WHERE id = ?`,
      bind: [card.mod, card.usn, card.type, card.queue, card.due, card.ivl, card.factor,
        card.reps, card.lapses, card.left, card.odue, card.odid, card.flags, card.data, undo.cardId]
    });
    transaction.exec({ sql: "DELETE FROM revlog WHERE id = ? AND cid = ?", bind: [undo.reviewId, undo.cardId] });
    for (const sibling of undo.siblings) {
      transaction.exec({ sql: "UPDATE cards SET mod = ?, usn = ?, queue = ? WHERE id = ?",
        bind: [sibling.mod, sibling.usn, sibling.queue, sibling.id] });
    }
    if (undo.leechNote) {
      transaction.exec({ sql: "UPDATE notes SET tags = ?, mod = ?, usn = ? WHERE id = ?",
        bind: [undo.leechNote.tags, undo.leechNote.mod, undo.leechNote.usn, undo.leechNote.id] });
    }
    touchCollection(transaction);
  });
  lastReviewUndo = null;
  return undo.cardId;
}

async function handleRequest(request: DbRequest) {
  try {
    let result: unknown;

    switch (request.type) {
      case "init":
        result = await initialize();
        break;
      case "listDecks":
        result = await listDecks();
        break;
      case "listNotetypes":
        result = await listNotetypes();
        break;
      case "listNoteTypeDetails":
        result = await listNoteTypeDetails();
        break;
      case "createNoteType":
        result = await createNoteType(request.name, request.kind, request.sourceId);
        break;
      case "updateNoteType":
        result = await updateNoteType(request.noteType);
        break;
      case "deleteNoteType":
        result = await deleteNoteType(request.noteTypeId);
        break;
      case "createDeck":
        result = await createDeck(request.name);
        break;
      case "renameDeck":
        await initialize();
        result = renameStoredDeck(collection(), request.deckId, request.name);
        break;
      case "deleteDeck":
        await initialize();
        result = deleteStoredDeck(collection(), request.deckId);
        break;
      case "getDeckOptions":
        result = await getDeckOptions(request.deckId);
        break;
      case "saveDeckOptions":
        result = await saveDeckOptions(request.deckId, request.options);
        break;
      case "resetDeckOptions":
        result = await resetDeckOptions(request.deckId);
        break;
      case "listDeckPresets":
        result = await listDeckPresets();
        break;
      case "applyDeckPreset":
        result = await applyDeckPreset(request.deckId, request.presetId);
        break;
      case "applyDeckPresetToSubdecks":
        result = await applyDeckPresetToSubdecks(request.deckId, request.presetId);
        break;
      case "createDeckPreset":
        result = await createDeckPreset(request.name, request.sourcePresetId);
        break;
      case "renameDeckPreset":
        result = await renameDeckPreset(request.presetId, request.name);
        break;
      case "deleteDeckPreset":
        result = await deleteDeckPreset(request.presetId);
        break;
      case "addBasicNote":
        result = await addBasicNote(request.deckId, request.front, request.back);
        break;
      case "addNote":
        result = await addNoteForNotetype(request.deckId, request.notetypeId, request.fields);
        break;
      case "addClozeNote":
        result = await addClozeNote(request.deckId, request.text, request.extra);
        break;
      case "storeMedia":
        result = await storeMedia(request.filename, request.bytes);
        break;
      case "importApkg": {
        const info = await initialize();
        result = await importApkg(sqliteRuntime!, collection(), new Uint8Array(request.bytes),
          await importMediaStore(info.persistent), request.keepScheduling, (progress) => {
            workerScope.postMessage({ id: request.id, ok: true, progress } satisfies DbResponse);
          });
        break;
      }
      case "exportCollection":
        result = await exportCollection((progress) => {
          workerScope.postMessage({ id: request.id, ok: true, progress } satisfies DbResponse);
        });
        break;
      case "restoreCollection":
        result = await restoreCollection(request.bytes, (progress) => {
          workerScope.postMessage({ id: request.id, ok: true, progress } satisfies DbResponse);
        });
        break;
      case "getMediaOverview":
        result = await getMediaOverview();
        break;
      case "removeUnusedMedia":
        result = await removeUnusedMedia((progress) => {
          workerScope.postMessage({ id: request.id, ok: true, progress } satisfies DbResponse);
        });
        break;
      case "browseCollection":
        result = await browseCollection(request.options);
        break;
      case "browserMetadata":
        result = await getBrowserMetadata();
        break;
      case "setCardFlag":
        result = await setExistingCardFlag(request.cardId, request.flag);
        break;
      case "browseNotes":
        result = await browseNotes(request.query, request.deckId, request.offset);
        break;
      case "updateNote":
        result = await updateExistingNote(request.noteId, request.fields, request.tags);
        break;
      case "deleteNote":
        result = await deleteExistingNote(request.noteId);
        break;
      case "setCardStatus":
        result = await setExistingCardStatus(request.cardId, request.status);
        break;
      case "moveCard":
        await initialize();
        result = moveStoredCard(collection(), request.cardId, request.deckId);
        break;
      case "getCollectionStats":
        result = await getCollectionStats(request.deckId);
        break;
      case "getNextCard":
        result = await getNextCard(request.deckId);
        break;
      case "getStudyCard":
        result = await getStudyCard(request.cardId);
        break;
      case "answerCard":
        result = await answerCard(request.cardId, request.rating, request.timeMs);
        break;
      case "undoLastReview":
        result = await undoLastReview();
        break;
      case "setNoteStatus":
        result = await setExistingNoteStatus(request.noteId, request.status);
        break;
      case "setNoteMarked":
        result = await setExistingNoteMarked(request.noteId, request.marked);
        break;
      case "resetCard":
        result = await resetExistingCard(request.cardId);
        break;
      case "setCardDue":
        result = await setExistingCardDue(request.cardId, request.days);
        break;
      default:
        throw new Error(`Unknown database request: ${(request as DbRequest).type}`);
    }

    const response: DbResponse = { id: request.id, ok: true, result };
    if (request.type === "exportCollection") {
      workerScope.postMessage(response, [(result as CollectionBackupResult).bytes]);
    } else {
      workerScope.postMessage(response);
    }
  } catch (error) {
    const response: DbResponse = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
    workerScope.postMessage(response);
  }
}

// An import awaits media I/O. Serialize RPCs so other operations cannot change
// IDs, filenames, or collection metadata between import planning and commit.
let requestQueue = Promise.resolve();
workerScope.addEventListener("message", (event: MessageEvent<DbRequest>) => {
  requestQueue = requestQueue.then(() => handleRequest(event.data));
});
