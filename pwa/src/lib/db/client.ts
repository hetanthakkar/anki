"use client";

import type {
  AnswerCardResult,
  ApkgImportResult,
  BrowseNotesResult,
  BrowserOptions,
  BrowserResults,
  BrowserMetadata,
  BrowserCard,
  CollectionBackupResult,
  CollectionRestoreResult,
  CollectionStats,
  DbCommand,
  DbRequest,
  DbResponse,
  DeckSummary,
  DeckPresetSummary,
  DeckOptions,
  DeckOptionsInput,
  LocalCollectionInfo,
  MediaCleanupResult,
  MediaOverview,
  NoteTypeDetails,
  NoteTypeInput,
  NoteTypeSummary,
  ReviewRating,
  StudyCard
} from "./types";

let worker: Worker | null = null;
let requestId = 0;
const pending = new Map<number, {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  progress?: (message: string) => void;
}>();

function getWorker(): Worker {
  if (typeof window === "undefined") {
    throw new Error("The local collection is only available in the browser");
  }

  if (!worker) {
    worker = new Worker(new URL("./anki-db.worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event: MessageEvent<DbResponse>) => {
      const response = event.data;
      const waiter = pending.get(response.id);
      if (!waiter) return;

      if (response.progress !== undefined) {
        waiter.progress?.(response.progress);
        return;
      }

      pending.delete(response.id);
      if (response.ok) {
        waiter.resolve(response.result);
      } else {
        waiter.reject(new Error(response.error ?? "Unknown SQLite worker error"));
      }
    });

    worker.addEventListener("error", (event) => {
      const error = new Error(event.message || "SQLite worker crashed");
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      worker?.terminate();
      worker = null;
    });
  }

  return worker;
}

function request<T>(command: DbCommand, transfer: Transferable[] = [], progress?: (message: string) => void): Promise<T> {
  const id = ++requestId;
  const message: DbRequest = { ...command, id };

  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      progress
    });
    try {
      getWorker().postMessage(message, transfer);
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
}

export function initLocalCollection() {
  return request<LocalCollectionInfo>({ type: "init" });
}

export function listDecks() {
  return request<DeckSummary[]>({ type: "listDecks" });
}

export function listNotetypes() {
  return request<NoteTypeSummary[]>({ type: "listNotetypes" });
}

export function listNoteTypeDetails() {
  return request<NoteTypeDetails[]>({ type: "listNoteTypeDetails" });
}

export function createNoteType(name: string, kind: "standard" | "cloze", sourceId: number | null) {
  return request<NoteTypeDetails>({ type: "createNoteType", name, kind, sourceId });
}

export function updateNoteType(noteType: NoteTypeInput) {
  return request<NoteTypeDetails>({ type: "updateNoteType", noteType });
}

export function deleteNoteType(noteTypeId: number) {
  return request<void>({ type: "deleteNoteType", noteTypeId });
}

export function createDeck(name: string) {
  return request<DeckSummary>({ type: "createDeck", name });
}

export function renameDeck(deckId: number, name: string) {
  return request<void>({ type: "renameDeck", deckId, name });
}

export function deleteDeck(deckId: number) {
  return request<void>({ type: "deleteDeck", deckId });
}

export function getDeckOptions(deckId: number) {
  return request<DeckOptions>({ type: "getDeckOptions", deckId });
}

export function saveDeckOptions(deckId: number, options: DeckOptionsInput) {
  return request<DeckOptions>({ type: "saveDeckOptions", deckId, options });
}

export function resetDeckOptions(deckId: number) {
  return request<DeckOptions>({ type: "resetDeckOptions", deckId });
}

export function listDeckPresets() {
  return request<DeckPresetSummary[]>({ type: "listDeckPresets" });
}

export function applyDeckPreset(deckId: number, presetId: number) {
  return request<DeckOptions>({ type: "applyDeckPreset", deckId, presetId });
}

export function applyDeckPresetToSubdecks(deckId: number, presetId: number) {
  return request<DeckOptions>({ type: "applyDeckPresetToSubdecks", deckId, presetId });
}

export function createDeckPreset(name: string, sourcePresetId: number) {
  return request<DeckPresetSummary>({ type: "createDeckPreset", name, sourcePresetId });
}

export function renameDeckPreset(presetId: number, name: string) {
  return request<void>({ type: "renameDeckPreset", presetId, name });
}

export function deleteDeckPreset(presetId: number) {
  return request<void>({ type: "deleteDeckPreset", presetId });
}

export function addBasicNote(deckId: number, front: string, back: string) {
  return request<number[]>({ type: "addBasicNote", deckId, front, back });
}

export function addNote(deckId: number, notetypeId: number, fields: string[]) {
  return request<number[]>({ type: "addNote", deckId, notetypeId, fields });
}

export function addClozeNote(deckId: number, text: string, extra: string) {
  return request<number[]>({ type: "addClozeNote", deckId, text, extra });
}

export function storeMedia(filename: string, bytes: ArrayBuffer) {
  return request<string>({ type: "storeMedia", filename, bytes });
}

export function importApkg(bytes: ArrayBuffer, keepScheduling: boolean, progress?: (message: string) => void) {
  return request<ApkgImportResult>({ type: "importApkg", bytes, keepScheduling }, [bytes], progress);
}

export function exportCollection(progress?: (message: string) => void) {
  return request<CollectionBackupResult>({ type: "exportCollection" }, [], progress);
}

export function restoreCollection(bytes: ArrayBuffer, progress?: (message: string) => void) {
  return request<CollectionRestoreResult>({ type: "restoreCollection", bytes }, [bytes], progress);
}

export function getMediaOverview() {
  return request<MediaOverview>({ type: "getMediaOverview" });
}

export function removeUnusedMedia(progress?: (message: string) => void) {
  return request<MediaCleanupResult>({ type: "removeUnusedMedia" }, [], progress);
}

export function browseNotes(query: string, deckId: number | null, offset = 0) {
  return request<BrowseNotesResult>({ type: "browseNotes", query, deckId, offset });
}

export function updateNote(noteId: number, fields: string[], tags: string[]) {
  return request<void>({ type: "updateNote", noteId, fields, tags });
}

export function deleteNote(noteId: number) {
  return request<void>({ type: "deleteNote", noteId });
}

export function setCardStatus(cardId: number, status: BrowserCard["status"]) {
  return request<void>({ type: "setCardStatus", cardId, status });
}

export function moveCard(cardId: number, deckId: number) {
  return request<void>({ type: "moveCard", cardId, deckId });
}

export function getCollectionStats(deckId: number | null = null) {
  return request<CollectionStats>({ type: "getCollectionStats", deckId });
}

export function getNextCard(deckId: number) {
  return request<StudyCard | null>({ type: "getNextCard", deckId });
}

export function getStudyCard(cardId: number) {
  return request<StudyCard | null>({ type: "getStudyCard", cardId });
}

export function answerCard(cardId: number, rating: ReviewRating, timeMs: number) {
  return request<AnswerCardResult>({ type: "answerCard", cardId, rating, timeMs });
}

export function undoLastReview() {
  return request<number | null>({ type: "undoLastReview" });
}

export function setNoteStatus(noteId: number, status: "suspended" | "buried") {
  return request<void>({ type: "setNoteStatus", noteId, status });
}

export function setNoteMarked(noteId: number, marked: boolean) {
  return request<void>({ type: "setNoteMarked", noteId, marked });
}

export function resetCard(cardId: number) {
  return request<void>({ type: "resetCard", cardId });
}

export function setCardDue(cardId: number, days: number) {
  return request<void>({ type: "setCardDue", cardId, days });
}

export function browseCollection(options: BrowserOptions) {
  return request<BrowserResults>({ type: "browseCollection", options });
}

export function browserMetadata() {
  return request<BrowserMetadata>({ type: "browserMetadata" });
}

export function setCardFlag(cardId: number, flag: number) {
  return request<void>({ type: "setCardFlag", cardId, flag });
}
