/// <reference lib="webworker" />

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

function disableProxyBasedOpfsVfses() {
  const sqliteGlobal = globalThis as typeof globalThis & {
    sqlite3ApiConfig?: { disable: { vfs: Record<string, boolean> } };
  };
  sqliteGlobal.sqlite3ApiConfig = {
    disable: { vfs: { opfs: true, "opfs-wl": true } }
  };
}

workerScope.addEventListener("message", (event: MessageEvent<ArrayBuffer>) => {
  void (async () => {
    try {
      const bytes = new Uint8Array(event.data);
      if (bytes.length < 16 || new TextDecoder().decode(bytes.subarray(0, 16)) !== "SQLite format 3\0") {
        throw new Error("AnkiWeb returned an invalid SQLite collection");
      }

      disableProxyBasedOpfsVfses();
      const sqlite3 = await sqlite3InitModule();
      const pool = await sqlite3.installOpfsSAHPoolVfs({ directory: ".anki-pwa-v2" });
      pool.importDb("/collection.anki2", bytes);
      workerScope.postMessage({ ok: true });
    } catch (error) {
      workerScope.postMessage({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  })();
});
