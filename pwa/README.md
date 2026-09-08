# Anki PWA

A frontend-only Next.js PWA with an on-device Anki-format collection. No hosted database, backend, or paid service is needed for local study and imports.

## Current milestone

- Next.js App Router PWA shell
- installable web app manifest
- offline service worker
- SQLite WASM in a dedicated worker
- persistent Origin Private File System (OPFS) collection storage when supported
- initial decks / notes / cards / review-log schema
- deck browser wired to the local collection
- deck management with rename/delete, hierarchical subdecks, parent-deck study/counts, and moving cards between decks
- Browse with Cards/Notes views, sortable results, saved searches, and filters for study-day activity, flags, card state, decks, note types/templates, and tags; rich-text/cloze note editing, media insertion, card moves, suspension, and burial
- deck/note creation with dynamic note-type fields
- Basic, Cloze and custom-template review with local images/audio
- all six stock Anki note types: Basic, reversed, optional reversed, type-in-answer, Cloze, and Image Occlusion
- local note-type management: create/clone/delete custom note types; safely edit/reorder fields and templates; edit card CSS; and preview cards before saving
- FSRS scheduling and local review history
- reviewer actions for note editing, flags, marking, bury/suspend, due dates, reset, card info, deletion, audio replay, and single-review undo, with Anki-style keyboard controls
- local `.apkg` import with legacy and modern (Zstd/protobuf) package support
- AnkiWeb shared-deck search launcher and local `.apkg` import
- full `.colpkg` collection backup/restore with staged replacement, scheduling history, note types, deck options, and media
- local media audit and removal of unreferenced files
- Anki-style deck-option presets with shared editing, clone/rename/delete, recursive subdeck application, and configurable daily limits, FSRS parameters, learning steps, display order, sibling burying, leeches, timers, and auto advance
- collection/deck statistics with review activity, retention, streaks, answer breakdown, card states, seven-day forecast, and maturity intervals
- persisted device settings for theme, interface density, reduced motion, language/region formatting, review progress/interval visibility, keyboard answering, and card audio
- keyboard-visible skip navigation, semantic charts, labelled controls, and live status messages across the primary study flow

## Configure a deck

Open a deck and select **Options**. You can set daily new/review limits, desired FSRS retention and parameters, maximum intervals, learning/relearning steps, new/review ordering, sibling burying, lapse/leech behavior, review timers, and auto advance. Steps are entered as whole minutes separated by spaces.

Saving while a deck uses the default preset creates a new preset for that deck. Editing a custom preset updates every deck using it. Presets can be added, renamed, deleted, assigned to one deck, or applied recursively to a deck and all its subdecks. Select **Restore defaults** to return only the current deck to the default preset.

## Import a deck

On the Decks screen, select **Import**, choose an `.apkg`, then select **Import deck**.

To find a public deck, select **Shared**, enter a search, and choose **Search AnkiWeb**. Results open on AnkiWeb so your AnkiWeb login remains private and its anonymous-search limit is not shared by a proxy server. Download the `.apkg`, return to this PWA, and choose **Open Import**. The package goes directly from AnkiWeb to your device.

- Notes, cards, tags, templates, CSS, and packaged media are imported locally.
- Scheduling/history are kept by default. Uncheck the option to start imported cards as new.
- Notes already present with the same Anki GUID are skipped, including changed notes. Re-importing is not an update/merge operation.
- Existing notes, cards and presets are not overwritten. Conflicting IDs are remapped; conflicting media filenames are renamed and their references updated.
- Cards return to their original decks when imported from filtered decks. Day-based due dates are adjusted to the local collection's creation date.
- Imports are limited to 500 MiB per package/database, 64 MiB per media file, 512 MiB expanded data and 50,000 ZIP entries. Larger decks should be split/exported in smaller batches in Anki.
- Database changes are transactional. A failed import rolls them back and removes newly written media. Closing the tab mid-import can leave unused media, but cannot partially commit notes/cards. Keep the tab open until completion.

Image Occlusion creation supports Anki-compatible rectangular masks, including “Hide all, guess one”. Imported rectangle, ellipse, and polygon masks are rendered during review. Anki's advanced polygon/text mask editor is not available yet.

## Back up, restore, and manage media

Open **Settings → Collection transfer** to download a complete `.colpkg` backup. It can be imported into Anki Desktop and includes cards, scheduling history, note types, deck configuration, and media.

**Restore full backup** intentionally replaces—not merges—the current PWA collection. The package is validated and prepared in an isolated SQLite collection and a new media directory before the active data is switched. Download a backup first. PWA-created schema-11 backups restore their deck configuration exactly; modern desktop `.colpkg` files are converted into the PWA collection format and retain their supported notes, cards, history, templates, and media.

The **Media library** reports local storage, referenced files, and unused files. Its cleanup action removes only media with no reference in a note field, card template, or card CSS.

## Private cloud sync

Cloud sync is an explicit whole-collection upload/download, not merge sync. The `.colpkg` snapshot contains the decks, cards, media, review history, and the data used by statistics. Each cloud upload also stores the device preferences and Browse saved searches in a separate private Supabase record; downloading applies them after the collection restore.

Run `supabase/migrations/20260907_add_anki_user_data_sync.sql` in the Supabase SQL Editor after the existing snapshot migrations before using this version of cloud sync. Upload and download replace their respective cloud/local state, so use one device at a time until merge sync exists.

This is not full Anki feature parity: add-ons, AnkiWeb sync, script-dependent templates, and Anki's FSRS optimizer/simulator and easy-day load balancing are not supported. Imported cards initially use the default PWA preset and can be assigned to another preset. Some advanced template filters and MathJax are not rendered. Keep an external backup of important collections.

When the app reports **Temporary storage fallback**, imported data will not survive a reload. Browser/site-data clearing can also remove persistent OPFS data.

## Run

Use Node.js 22.15+ and install dependencies with `npm --prefix pwa ci`.

From the repository root:

```bash
just pwa-dev
just pwa-check
just pwa-build
```

If `just` is unavailable, the equivalent commands are `npm --prefix pwa run dev`, `npm --prefix pwa run typecheck`, `npm --prefix pwa test`, and `npm --prefix pwa run build`.

Open `http://localhost:3000`.

For a production-like PWA test:

```bash
just pwa-build
npm --prefix pwa start
```

The SQLite worker needs the COOP/COEP response headers configured in `next.config.mjs`. They are required for the cross-origin-isolated browser environment used by SQLite's OPFS implementation.

## Architecture

```text
Next.js UI
   |
   v
Typed worker RPC
   |
   v
SQLite WASM worker
   |
   v
OPFS .anki-pwa-v2 (collection) + active anki-pwa-media-* directory (media)
```

The browser worker owns the database. React components do not run SQLite queries directly.

Import tests use the repository's original `.apkg` fixtures plus generated schema-18 packages. They cover scheduling, duplicate handling, ID/media collisions, corrupted archives, failed media writes and database rollback. The restore smoke test exports a full backup, changes the collection, restores it, and confirms replacement behavior.

For the browser smoke test, start a production PWA on a dedicated test origin and open it in a **fresh Chrome profile** with remote debugging enabled. Run `just pwa-test-browser 9230 http://127.0.0.1:3002/ legacy` (or `modern`). Without `just`, use `npm --prefix pwa run test:browser -- 9230 http://127.0.0.1:3002/ modern`. The test adds a small synthetic deck, imports it twice, checks invalid-package handling, then reloads and reviews offline. Never point it at your real collection.

Run `just pwa-test-browse 9241 http://127.0.0.1:3021/` against a fresh test profile. The browse smoke test covers note/tag editing, rich formatting, card status changes, card moves, subdeck creation/rename, recursive deck deletion, flags, saved-search persistence, Cards/Notes views, sorting, and mobile layout. Search tests also check study-day cutoffs, review-history filters, due dates, quoted names, and combined filters against SQLite. The reviewer smoke test (`just pwa-test-review-actions`) covers its action toolbar, dialogs, note editing, flags, marking, answering and undo, burial, suspension, due dates, and keyboard controls. The note-type smoke test (`npm --prefix pwa run test:notetype-browser -- 9237 http://127.0.0.1:3017/`) covers custom type creation, field/template editing, sandboxed previews, cloning, and deletion. The statistics smoke test reviews a card and checks the collection and deck metrics, forecast, and maturity panels. Run `just pwa-test-restore 9250 http://127.0.0.1:3002/` to validate full backup replacement. The deck-options smoke test checks runtime ordering, daily limits, learning steps, timer/auto-advance behavior, expanded scheduler-option persistence, shared preset management, recursive subdeck application, and restoring defaults. The settings smoke test verifies persistence, appearance changes, reduced motion, review visibility controls, keyboard reviewing, and restoring defaults. The shared-deck UI smoke test verifies that the search form targets AnkiWeb directly and does not consume AnkiWeb's anonymous search limit.

## Next milestones

1. More complete template rendering.
2. Further investigation of AnkiWeb interoperability. Shared-deck discovery links to AnkiWeb; account sync is not supported.
