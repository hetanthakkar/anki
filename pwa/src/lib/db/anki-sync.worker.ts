/// <reference lib="webworker" />

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Database } from "@sqlite.org/sqlite-wasm";

type SyncRequest =
  | { id: number; type: "prepareUpload" }
  | { id: number; type: "replaceCollection"; bytes: ArrayBuffer };

type SyncResponse = {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
};

type SyncSqlite = {
  installOpfsSAHPoolVfs(options: { directory: string }): Promise<{
    OpfsSAHPoolDb: new(path: string) => Database;
  }>;
  oo1: { DB: new(filename?: string, flags?: string) => Database };
  wasm: {
    allocFromTypedArray(bytes: Uint8Array): number;
    dealloc(pointer: number): void;
  };
  capi: {
    SQLITE_DONE: number;
    sqlite3_deserialize(db: number, schema: string, data: number, size: number, bufferSize: number, flags: number): number;
    sqlite3_backup_init(destination: number, destinationName: string, source: number, sourceName: string): number;
    sqlite3_backup_step(backup: number, pages: number): number;
    sqlite3_backup_finish(backup: number): number;
    sqlite3_errcode(db: number): number;
    sqlite3_js_db_export(db: number): Uint8Array;
  };
};

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const MAX_COLLECTION_BYTES = 300 * 1024 * 1024;

function disableProxyBasedOpfsVfses() {
  const sqliteGlobal = globalThis as typeof globalThis & {
    sqlite3ApiConfig?: { disable: { vfs: Record<string, boolean> } };
  };
  sqliteGlobal.sqlite3ApiConfig = {
    disable: { vfs: { opfs: true, "opfs-wl": true } }
  };
}

async function openCollection() {
  disableProxyBasedOpfsVfses();
  const sqlite3 = await sqlite3InitModule() as unknown as SyncSqlite;
  const sahPool = await sqlite3.installOpfsSAHPoolVfs({ directory: ".anki-pwa-v2" });
  const database = new sahPool.OpfsSAHPoolDb("/collection.anki2");
  return { sqlite3, database };
}

function requireSchema11(database: Database) {
  const version = Number(database.selectValue("PRAGMA user_version") ?? 0);
  if (version !== 11) throw new Error(`Expected Anki schema 11, found schema ${version}`);
  for (const table of ["col", "notes", "cards", "revlog", "graves"]) {
    const exists = Number(database.selectValue(
      "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?", [table]
    ) ?? 0);
    if (!exists) throw new Error(`Anki collection is missing the ${table} table`);
  }
}

function clearObjectUsns(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  for (const item of Object.values(record)) {
    if (item && typeof item === "object" && !Array.isArray(item) && "usn" in item) {
      (item as Record<string, unknown>).usn = 0;
    }
  }
  return record;
}

function preparedJson(database: Database, column: "models" | "decks" | "dconf") {
  const raw = String(database.selectValue(`SELECT ${column} FROM col WHERE id = 1`) ?? "{}");
  return JSON.stringify(clearObjectUsns(JSON.parse(raw)));
}

function preparedTags(database: Database) {
  const raw = String(database.selectValue("SELECT tags FROM col WHERE id = 1") ?? "{}");
  const tags = JSON.parse(raw) as Record<string, unknown>;
  for (const key of Object.keys(tags)) tags[key] = 0;
  return JSON.stringify(tags);
}

function prepareUpload(database: Database, sqlite3: SyncSqlite) {
  requireSchema11(database);
  const notes = Number(database.selectValue("SELECT count(*) FROM notes") ?? 0);
  const cards = Number(database.selectValue("SELECT count(*) FROM cards") ?? 0);
  const reviews = Number(database.selectValue("SELECT count(*) FROM revlog") ?? 0);
  const currentUsn = Number(database.selectValue("SELECT usn FROM col WHERE id = 1") ?? -1);
  const uploadUsn = Number.isInteger(currentUsn) ? Math.max(0, currentUsn + 1) : 0;
  const syncTime = Date.now();

  database.exec("BEGIN IMMEDIATE");
  try {
    // Mirror Anki's before_upload() cleanup on a transaction-only snapshot.
    // The transaction is rolled back after sqlite3_js_db_export(), so normal
    // local editing state is not changed if the network upload later fails.
    database.exec("DELETE FROM graves");
    database.exec("UPDATE notes SET usn = 0 WHERE usn = -1");
    database.exec("UPDATE cards SET usn = 0 WHERE usn = -1");
    database.exec("UPDATE revlog SET usn = 0 WHERE usn = -1");
    database.exec({
      sql: "UPDATE col SET models = ?, decks = ?, dconf = ?, tags = ?, usn = ?, mod = ?, scm = ?, ls = ? WHERE id = 1",
      bind: [
        preparedJson(database, "models"),
        preparedJson(database, "decks"),
        preparedJson(database, "dconf"),
        preparedTags(database),
        uploadUsn,
        syncTime,
        syncTime,
        syncTime
      ]
    });

    const bytes = sqlite3.capi.sqlite3_js_db_export(database.pointer).slice();
    return { bytes: bytes.buffer as ArrayBuffer, notes, cards, reviews };
  } finally {
    database.exec("ROLLBACK");
  }
}

function validateDownloadedCollection(database: Database) {
  requireSchema11(database);
  const integrity = String(database.selectValue("PRAGMA integrity_check") ?? "");
  if (integrity.toLowerCase() !== "ok") throw new Error("The AnkiWeb collection failed SQLite integrity validation");
  const colRows = Number(database.selectValue("SELECT count(*) FROM col") ?? 0);
  if (colRows !== 1) throw new Error("The AnkiWeb collection metadata is invalid");
}

function replaceCollection(target: Database, sqlite3: SyncSqlite, input: ArrayBuffer) {
  const bytes = new Uint8Array(input);
  if (!bytes.length || bytes.byteLength > MAX_COLLECTION_BYTES) throw new Error("The AnkiWeb collection has an invalid size");
  if (new TextDecoder().decode(bytes.subarray(0, 16)) !== "SQLite format 3\0") {
    throw new Error("AnkiWeb did not return an Anki SQLite collection");
  }

  const source = new sqlite3.oo1.DB(":memory:", "c");
  const pointer = sqlite3.wasm.allocFromTypedArray(bytes);
  try {
    source.checkRc(sqlite3.capi.sqlite3_deserialize(
      source.pointer, "main", pointer, bytes.byteLength, bytes.byteLength, 0
    ));
    validateDownloadedCollection(source);

    const backup = sqlite3.capi.sqlite3_backup_init(target.pointer, "main", source.pointer, "main");
    if (!backup) {
      target.checkRc(sqlite3.capi.sqlite3_errcode(target.pointer));
      throw new Error("Could not start SQLite collection replacement");
    }
    let stepRc: number;
    let finishRc: number;
    try {
      stepRc = sqlite3.capi.sqlite3_backup_step(backup, -1);
    } finally {
      finishRc = sqlite3.capi.sqlite3_backup_finish(backup);
    }
    if (stepRc !== sqlite3.capi.SQLITE_DONE) target.checkRc(stepRc);
    target.checkRc(finishRc);

    // Official Anki sets last-sync to the downloaded collection modification
    // time before reopening it.
    target.exec("UPDATE col SET ls = mod WHERE id = 1");
    requireSchema11(target);
    return {
      notes: Number(target.selectValue("SELECT count(*) FROM notes") ?? 0),
      cards: Number(target.selectValue("SELECT count(*) FROM cards") ?? 0),
      reviews: Number(target.selectValue("SELECT count(*) FROM revlog") ?? 0)
    };
  } finally {
    source.close();
    sqlite3.wasm.dealloc(pointer);
  }
}

async function handle(request: SyncRequest) {
  let database: Database | null = null;
  try {
    const opened = await openCollection();
    database = opened.database;
    const result = request.type === "prepareUpload"
      ? prepareUpload(database, opened.sqlite3)
      : replaceCollection(database, opened.sqlite3, request.bytes);
    database.close();
    database = null;

    const response: SyncResponse = { id: request.id, ok: true, result };
    if (request.type === "prepareUpload") {
      workerScope.postMessage(response, [(result as { bytes: ArrayBuffer }).bytes]);
    } else {
      workerScope.postMessage(response);
    }
  } catch (error) {
    try { database?.close(); } catch { /* best effort */ }
    workerScope.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    } satisfies SyncResponse);
  }
}

workerScope.addEventListener("message", (event: MessageEvent<SyncRequest>) => {
  void handle(event.data);
});
