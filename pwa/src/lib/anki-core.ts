export type AnkiCoreModule = {
  default: () => Promise<unknown>;
  anki_core_version: () => string;
  scheduler_core_available: () => boolean;
  collection_scheduler_smoke: () => string;
};

let corePromise: Promise<AnkiCoreModule> | null = null;

export function loadAnkiCore(): Promise<AnkiCoreModule> {
  if (!corePromise) {
    corePromise = (async () => {
      const moduleUrl = "/wasm/anki-core/anki_pwa_wasm.js";
      const core = (await import(/* webpackIgnore: true */ moduleUrl)) as AnkiCoreModule;
      await core.default();
      return core;
    })();
  }

  return corePromise;
}
