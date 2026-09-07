/// <reference lib="webworker" />

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { Rating, State, default_w, fsrs } from "ts-fsrs";
import type { CardInput, Grade, RecordLogItem, StepUnit } from "ts-fsrs";

import { clozeOrdinals, renderAnkiCard } from "../anki/template";
import type { AnkiNotetype } from "../anki/template";
import { buildCollectionPackage } from "../anki/export-colpkg";
import type { BackupMediaFile } from "../anki/export-colpkg";
import { importApkg } from "../anki/import-apkg";
import type { ImportMediaStore } from "../anki/import-apkg";
import { deckScopeIds, deleteDeck as deleteStoredDeck, moveCard as moveStoredCard, renameDeck as renameStoredDeck } from "./deck-management";
import type {
  BrowseNotesResult,
  BrowserCard,
  BrowserNote,
  CardState,
  CollectionBackupResult,
  CollectionStats,
  DbRequest,
  DbResponse,
  DeckSummary,
  DeckOptions,
  DeckOptionsInput,
  LocalCollectionInfo,
  NoteTypeSummary,
  ReviewRating,
  StudyCard
} from "./types";

const SCHEMA_VERSION = 11;
const BASIC_NOTETYPE_ID = 1_600_000_000_000;
const CLOZE_NOTETYPE_ID = 1_600_000_000_001;
const REVERSED_NOTETYPE_ID = 1_600_000_000_002;
const OPTIONAL_REVERSED_NOTETYPE_ID = 1_600_000_000_003;
const TYPING_NOTETYPE_ID = 1_600_000_000_004;
const IMAGE_OCCLUSION_NOTETYPE_ID = 1_600_000_000_005;
const DEFAULT_DECK_ID = 1;
const FIELD_SEPARATOR = "\u001f";
const LEARNING_STEPS = ["1m", "10m"] as const;
const RELEARNING_STEPS = ["10m"] as const;
const REQUEST_RETENTION = 0.9;


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
  return {
    deckId: deck.id,
    deckName: deck.name,
    presetName: String(config.name || "Default"),
    usingDefaultPreset: Number(deck.conf) === DEFAULT_DECK_ID,
    newCardsPerDay: Math.round(boundedNumber(newOptions.perDay, 20, 0, 9_999)),
    maximumReviewsPerDay: Math.round(boundedNumber(reviewOptions.perDay, 200, 0, 9_999)),
    desiredRetentionPercent: Math.round(desiredRetention * 1_000) / 10,
    maximumIntervalDays: Math.round(boundedNumber(reviewOptions.maxIvl, 36_500, 1, 36_500)),
    learningStepsMinutes: configuredSteps(newOptions.delays, [1, 10]),
    relearningStepsMinutes: configuredSteps(lapseOptions.delays, [10])
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
    relearningStepsMinutes: steps(input.relearningStepsMinutes, "Relearning steps")
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
  const storedWeights = config.fsrsParams6;
  const weights = Array.isArray(storedWeights) && storedWeights.length > 0
    && storedWeights.every((weight) => Number.isFinite(Number(weight)))
    ? storedWeights.map(Number) : [...default_w];
  return {
    scheduler: fsrs({
      request_retention: options.desiredRetentionPercent / 100,
      maximum_interval: options.maximumIntervalDays,
      w: weights,
      enable_fuzz: true,
      enable_short_term: true,
      learning_steps: stepUnits(options.learningStepsMinutes),
      relearning_steps: stepUnits(options.relearningStepsMinutes)
    }),
    options
  };
}

function startOfTodayMilliseconds() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

function deckActivityToday(database: Database, deckIds: number[]) {
  const placeholders = deckIds.map(() => "?").join(",");
  const start = startOfTodayMilliseconds();
  const introduced = Number(database.selectValue(
    `SELECT count(*) FROM cards c
     WHERE c.did IN (${placeholders})
       AND (SELECT min(first.id) FROM revlog first WHERE first.cid = c.id) >= ?`,
    [...deckIds, start]
  ) ?? 0);
  const reviews = Number(database.selectValue(
    `SELECT count(*) FROM revlog r JOIN cards c ON c.id = r.cid
     WHERE c.did IN (${placeholders}) AND r.id >= ? AND r.type = 1`,
    [...deckIds, start]
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

async function saveDeckOptions(deckId: number, input: DeckOptionsInput): Promise<DeckOptions> {
  await initialize();
  const database = collection();
  const decks = readDecks(database);
  const deck = decks[String(deckId)];
  if (!deck || deck.dyn !== 0) throw new Error("Deck not found");
  const options = validatedDeckOptions(input);
  const configs = readDeckConfigs(database);
  const current = deckConfigFor(database, deck);
  const ownsCurrentPreset = Number(current.ankiPwaDeckId) === deckId;
  const configId = ownsCurrentPreset ? Number(deck.conf) : uniqueDeckConfigId(configs);
  const config = JSON.parse(JSON.stringify(current)) as DeckConfigRecord;
  const newOptions = recordValue(config.new);
  const reviewOptions = recordValue(config.rev);
  const lapseOptions = recordValue(config.lapse);
  const mod = nowSeconds();

  Object.assign(config, {
    id: configId,
    mod,
    usn: -1,
    name: `${deck.name.split("::").at(-1) ?? deck.name} options`,
    ankiPwaDeckId: deckId,
    desiredRetention: options.desiredRetentionPercent / 100,
    new: { ...newOptions, perDay: options.newCardsPerDay, delays: options.learningStepsMinutes },
    rev: { ...reviewOptions, perDay: options.maximumReviewsPerDay, maxIvl: options.maximumIntervalDays },
    lapse: { ...lapseOptions, delays: options.relearningStepsMinutes }
  });
  configs[String(configId)] = config;
  deck.conf = configId;
  deck.mod = mod;
  deck.usn = -1;

  database.transaction("IMMEDIATE", (transaction) => {
    transaction.exec({
      sql: "UPDATE col SET decks = ?, dconf = ? WHERE id = 1",
      bind: [JSON.stringify(decks), JSON.stringify(configs)]
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
  const counts = database.selectObject(
    `SELECT
       sum(CASE WHEN queue = 0 THEN 1 ELSE 0 END) AS new_count,
       sum(CASE WHEN (queue = 1 AND due <= ?) OR (queue = 3 AND due <= ?) THEN 1 ELSE 0 END) AS learning_count,
       sum(CASE WHEN queue = 2 AND due <= ? THEN 1 ELSE 0 END) AS review_count,
       count(*) AS total_cards
     FROM cards WHERE did IN (${placeholders})`,
    [now, today, today, ...scopeIds]
  );
  const options = deckOptionsFor(database, deck);
  const activity = deckActivityToday(database, scopeIds);
  const newRemaining = Math.max(0, options.newCardsPerDay - activity.introduced);
  const reviewRemaining = Math.max(0, options.maximumReviewsPerDay - activity.reviews);

  return {
    id: deck.id,
    name: deck.name,
    newCount: Math.min(Number(counts?.new_count ?? 0), newRemaining),
    learningCount: Number(counts?.learning_count ?? 0),
    reviewCount: Math.min(Number(counts?.review_count ?? 0), reviewRemaining),
    totalCards: Number(counts?.total_cards ?? 0)
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
    daily
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
    return await root.getDirectoryHandle("anki-pwa-media-v2", { create });
  } catch {
    return null;
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
  const directory = await root.getDirectoryHandle("anki-pwa-media-v2", { create: true });
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
  if (!readDecks(database)[String(deckId)]) throw new Error("Deck not found");
  if (!readNotetypes(database)[String(notetypeId)]) throw new Error("Note type not found");
  if (!ordinals.length) throw new Error("This note does not generate any cards");

  const checksum = await fieldChecksum(fields[0]);
  const noteId = uniqueId(database, "notes");
  const firstCardId = uniqueId(database, "cards", noteId + 1);
  const firstDue = Number(database.selectValue("SELECT coalesce(max(due), 0) + 1 FROM cards WHERE type = 0") ?? 1);
  const mod = nowSeconds();
  const guid = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  const cardIds = ordinals.map((_ordinal, index) => firstCardId + index);

  database.transaction("IMMEDIATE", (transaction) => {
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
        bind: [cardIds[index], noteId, deckId, ordinal, mod, firstDue + index]
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
    `SELECT id, nid, did, ord, type, queue, ivl, reps, lapses
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
        templateName: template?.name ?? `Card ${ordinal + 1}`,
        state: stateForCard(Number(card.type), Number(card.queue)),
        status: cardStatus(Number(card.queue)),
        intervalDays: Math.max(0, Number(card.ivl)),
        reviews: Math.max(0, Number(card.reps)),
        lapses: Math.max(0, Number(card.lapses))
      };
    });
    const preview = plainText(fields[0] ?? "").replace(/\s+/g, " ").slice(0, 240);
    return {
      id: noteId,
      notetypeId,
      notetypeName: notetype?.name ?? `Note type ${notetypeId}`,
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
  const total = Number(database.selectValue(`SELECT count(*) FROM notes n ${where}`, bind) ?? 0);
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

function learningStepsCompleted(state: State, left: number) {
  const remaining = Math.max(0, left % 1000);
  if (state === State.Learning) return Math.max(0, LEARNING_STEPS.length - remaining);
  if (state === State.Relearning) return Math.max(0, RELEARNING_STEPS.length - remaining);
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

function toFsrsCard(row: Record<string, unknown>, database: Database, now: Date): CardInput {
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
    learning_steps: learningStepsCompleted(state, Number(row.left)),
    reps: Math.max(0, Number(row.reps)),
    lapses: Math.max(0, Number(row.lapses)),
    state,
    last_review: lastReview
  };
}

function previewForCard(row: Record<string, unknown>, database: Database, now = new Date()) {
  const { scheduler } = schedulerForDeck(database, Number(row.did));
  scheduler.seed = `${String(row.id)}:${String(row.reps)}`;
  return scheduler.repeat(toFsrsCard(row, database, now), now);
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
  const newRemaining = Math.max(0, options.newCardsPerDay - activity.introduced);
  const reviewRemaining = Math.max(0, options.maximumReviewsPerDay - activity.reviews);

  const row = database.selectObject(
    `SELECT c.id, c.did, c.ord, c.type, c.queue, c.due, c.ivl, c.reps, c.lapses,
       c.left, c.data, n.mid, n.flds,
       (SELECT max(r.id) / 1000 FROM revlog r WHERE r.cid = c.id) AS last_review_seconds
     FROM cards c JOIN notes n ON n.id = c.nid
     WHERE c.did IN (${placeholders}) AND (
       (c.queue = 1 AND c.due <= ?) OR
       (c.queue = 3 AND c.due <= ?) OR
       (c.queue = 2 AND c.due <= ? AND ? > 0) OR
       (c.queue = 0 AND ? > 0)
     )
     ORDER BY CASE c.queue WHEN 1 THEN 0 WHEN 3 THEN 0 WHEN 2 THEN 1 ELSE 2 END, c.due, c.id
     LIMIT 1`,
    [...scopeIds, nowSeconds(), collectionDay(database), collectionDay(database), reviewRemaining, newRemaining]
  );
  if (!row) return null;

  const notetype = readNotetypes(database)[String(row.mid)];
  if (!notetype) throw new Error(`Note type ${String(row.mid)} is missing`);
  const rendered = renderAnkiCard(notetype, String(row.flds).split(FIELD_SEPARATOR), Number(row.ord));
  const question = await inlineMedia(rendered.questionHtml, rendered.css);
  const answer = await inlineMedia(rendered.answerHtml, question.css);
  const now = new Date();
  const preview = previewForCard(row, database, now);
  return {
    id: Number(row.id),
    deckId: Number(row.did),
    deckName: decks[String(row.did)]?.name ?? deck.name,
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

async function answerCard(cardId: number, rating: ReviewRating, timeMsInput: number): Promise<void> {
  await initialize();
  const database = collection();
  const card = database.selectObject(
    `SELECT c.id, c.did, c.type, c.queue, c.due, c.ivl, c.factor, c.reps, c.lapses,
       c.left, c.data,
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
  const result = configured.scheduler.next(toFsrsCard(card, database, now), now, rating as Grade);
  const type = result.card.state;
  const queue = result.card.state === State.Review ? 2 : 1;
  const due = result.card.state === State.Review
    ? today + result.card.scheduled_days
    : Math.floor(result.card.due.getTime() / 1000);
  const interval = result.card.state === State.Review
    ? result.card.scheduled_days
    : previousInterval;
  const factor = Number(card.factor) || 2500;
  const left = remainingSteps(result, configured.options);
  const loggedInterval = intervalForRevlog(result, now);
  const data: StoredCardData = {
    s: Number(result.card.stability.toFixed(4)),
    d: Number(result.card.difficulty.toFixed(3)),
    dr: configured.options.desiredRetentionPercent / 100,
    lrt: nowSecs
  };

  const reviewKind = previousType === 2 ? 1 : previousType === 3 ? 2 : 0;
  const reviewId = uniqueId(database, "revlog");
  const timeMs = Math.max(0, Math.min(60_000, Math.round(timeMsInput)));
  const lastInterval = previousQueue === 1
    ? -Math.max(1, Number(card.due) - Number(parseCardData(card.data).lrt ?? card.last_review_seconds ?? nowSecs))
    : previousInterval;

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
    touchCollection(transaction);
  });
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
      case "answerCard":
        result = await answerCard(request.cardId, request.rating, request.timeMs);
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
