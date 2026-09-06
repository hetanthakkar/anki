"use client";

import { useState } from "react";

import { loadAnkiCore } from "@/lib/anki-core";

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; version: string; scheduler: boolean; collection: string }
  | { kind: "error"; message: string };

export function CoreSmoke() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const run = async () => {
    setStatus({ kind: "loading" });
    try {
      const core = await loadAnkiCore();
      setStatus({
        kind: "ready",
        version: core.anki_core_version(),
        scheduler: core.scheduler_core_available(),
        collection: core.collection_scheduler_smoke(),
      });
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 24 }}>
      <h1>Anki core smoke test</h1>
      <p>This route tests the real Rust collection and scheduler compiled to WebAssembly.</p>
      <button type="button" onClick={() => void run()} disabled={status.kind === "loading"}>
        {status.kind === "loading" ? "Running…" : "Run core test"}
      </button>

      {status.kind === "ready" ? (
        <pre>{JSON.stringify(status, null, 2)}</pre>
      ) : null}
      {status.kind === "error" ? <pre>{status.message}</pre> : null}
    </main>
  );
}
