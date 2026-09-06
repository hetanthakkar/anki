# Anki PWA

A minimal browser/PWA migration layer for Anki.

The goal is not to redesign Anki's behavior or introduce a new flashcard model. Anki remains the source of truth for card rendering, collection semantics, scheduling, and review behavior. The PWA layer should replace only native platform boundaries that cannot run in a browser, then apply a small visual theme override.

## Current milestone

This branch is intentionally UI-only.

- Next.js App Router PWA shell
- installable web app manifest
- offline service worker/app shell
- AnkiMobile-style screen structure and controls using dummy data
- separate Magoosh-inspired CSS override layer
- no custom database schema
- no custom scheduler
- no custom spaced-repetition implementation

## Run

```bash
cd pwa
npm install
npm run dev
```

Open `http://localhost:3000`.

For a production-like PWA test:

```bash
npm run build
npm start
```

## Migration rule

When functionality is connected, prefer existing Anki code over recreating it:

```text
Next.js/PWA shell
      |
      +--> existing Anki reviewer/card web code where browser-compatible
      |
      +--> thin browser/WASM bridge
                |
                v
          Anki Rust core
          - scheduler
          - FSRS integration
          - queue/state transitions
          - collection behavior
                |
                v
          browser SQLite/OPFS adapter
          using Anki's collection schema
```

### Reviewer

Anki already ships browser-oriented reviewer code under `ts/reviewer/`. That code should be reused/adapted instead of recreating card rendering behavior in React.

### Scheduling

The PWA must preserve Anki's V3 scheduling flow:

1. request queued cards
2. use Anki's current scheduling states/context
3. map Again/Hard/Good/Easy to Anki's ratings
4. build the answer with Anki's scheduler
5. apply `answer_card`
6. persist the resulting card/review state
7. request the next queued card

The current UI buttons are placeholders only; scheduling is not implemented yet.

### Browser storage

Do not introduce a separate PWA-specific decks/notes/cards schema. The browser version should preserve Anki's collection format and adapt the native SQLite/filesystem boundary to browser persistence (OPFS).

## Next technical milestone

Attempt the smallest possible browser build of Anki's Rust collection/scheduler code. The current repository pins `rusqlite` 0.36, so browser compilation will require testing/updating the SQLite FFI/platform layer and feature-gating native-only dependencies. Only if a piece of native infrastructure cannot be made browser-compatible should it receive a browser adapter; scheduling rules themselves should not be rewritten.
