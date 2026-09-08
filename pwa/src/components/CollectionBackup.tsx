"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { exportCollection, getMediaOverview, removeUnusedMedia, restoreCollection } from "@/lib/db/client";
import type { CollectionBackupResult, CollectionRestoreResult, MediaOverview } from "@/lib/db/types";

const MAX_FILE_BYTES = 500 * 1024 * 1024;

function downloadBackup(result: CollectionBackupResult) {
  const url = URL.createObjectURL(new Blob([result.bytes], { type: "application/x-colpkg" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = result.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function CollectionBackup({ afterBackup, persistent, onBusyChange, onRestored }: {
  afterBackup?: ReactNode;
  persistent: boolean;
  onBusyChange: (busy: boolean) => void;
  onRestored?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CollectionBackupResult | null>(null);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreConfirmed, setRestoreConfirmed] = useState(false);
  const [restoreResult, setRestoreResult] = useState<CollectionRestoreResult | null>(null);
  const [media, setMedia] = useState<MediaOverview | null>(null);
  const [mediaNotice, setMediaNotice] = useState<string | null>(null);

  const refreshMedia = async () => setMedia(await getMediaOverview());
  useEffect(() => { void refreshMedia().catch(() => {}); }, []);

  const createBackup = async () => {
    if (busy) return;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    setResult(null);
    setProgress("Preparing backup…");
    try {
      const backup = await exportCollection(setProgress);
      downloadBackup(backup);
      setResult(backup);
    } catch (error) {
      setError(error instanceof Error ? error.message : "The collection could not be backed up.");
    } finally {
      setBusy(false);
      onBusyChange(false);
      setProgress("");
    }
  };

  const restore = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!restoreFile || !restoreConfirmed || busy) return;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    setRestoreResult(null);
    setProgress("Opening backup…");
    try {
      if (!/\.colpkg$/i.test(restoreFile.name)) throw new Error("Choose a full collection backup (.colpkg), not a deck package (.apkg).");
      if (!restoreFile.size || restoreFile.size > MAX_FILE_BYTES) throw new Error("Choose a non-empty .colpkg file no larger than 500 MiB.");
      const restored = await restoreCollection(await restoreFile.arrayBuffer(), setProgress);
      await onRestored?.();
      await refreshMedia();
      setRestoreResult(restored);
      setRestoreFile(null);
      setRestoreConfirmed(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : "The collection could not be restored.");
    } finally {
      setBusy(false);
      onBusyChange(false);
      setProgress("");
    }
  };

  const cleanMedia = async () => {
    if (busy || !media?.unusedFiles) return;
    if (!window.confirm(`Remove ${media.unusedFiles} unused media ${media.unusedFiles === 1 ? "file" : "files"}? This cannot be undone.`)) return;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    setMediaNotice(null);
    setProgress("Checking media…");
    try {
      const removed = await removeUnusedMedia(setProgress);
      await refreshMedia();
      setMediaNotice(`Removed ${removed.files} unused ${removed.files === 1 ? "file" : "files"}.`);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unused media could not be removed.");
    } finally {
      setBusy(false);
      onBusyChange(false);
      setProgress("");
    }
  };

  return (
    <section className="collection-tools">
      <section className="collection-subsection backup-panel" aria-busy={busy}>
        <div>
          <h2>Collection transfer</h2>
          <p className="muted">Download a complete, portable snapshot of your decks, cards, review history, note types, and media.</p>
        </div>
        {!persistent && <p className="form-error" role="alert">This collection is using temporary storage. Download a backup before closing or reloading the app.</p>}
        <p className="muted backup-help">The .colpkg works as a full backup and can be imported into Anki Desktop. It includes scheduling and media; nothing is uploaded.</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        {busy && <p role="status" aria-live="polite">{progress}</p>}
        {result && <p className="backup-result" role="status" aria-live="polite">
          Backup downloaded · {result.notes} notes · {result.cards} cards · {result.reviews} reviews · {result.media} media files
        </p>}
        <button className="primary-button" type="button" disabled={busy} onClick={() => void createBackup()}>
          {busy ? "Working…" : "Download full backup (.colpkg)"}
        </button>
      </section>

      {afterBackup}

      <details className="collection-disclosure collection-restore">
        <summary><span>Restore full backup</span><small>Replace this device from a .colpkg</small></summary>
        <form className="restore-panel" onSubmit={(event) => void restore(event)} aria-busy={busy}>
          <p className="muted">Replace this PWA’s collection with a .colpkg backup. Cards, history, note types, and media are replaced together.</p>
          <p className="restore-warning">Download a backup above before restoring. This action cannot merge two full collections.</p>
          <label htmlFor="colpkg-file">Collection backup (.colpkg, up to 500 MiB)</label>
          <input id="colpkg-file" type="file" accept=".colpkg" disabled={busy} onChange={(event) => {
            setRestoreFile(event.target.files?.[0] ?? null);
            setRestoreResult(null);
            setError(null);
          }} />
          <label className="checkbox-label" htmlFor="restore-confirmed">
            <input id="restore-confirmed" type="checkbox" disabled={busy} checked={restoreConfirmed}
              onChange={(event) => setRestoreConfirmed(event.target.checked)} />
            I have a backup and understand this replaces my current collection.
          </label>
          {restoreResult && <p className="backup-result" role="status" aria-live="polite">Restored {restoreResult.notes} notes · {restoreResult.cards} cards · {restoreResult.reviews} reviews · {restoreResult.media} media files</p>}
          <button className="danger-button" type="submit" disabled={busy || !restoreFile || !restoreConfirmed}>
            {busy ? "Restoring…" : "Restore collection"}
          </button>
        </form>
      </details>

      <details className="collection-disclosure">
        <summary><span>Media library</span><small>{media ? `${media.files} files · ${formatBytes(media.bytes)}` : "Checking local media…"}</small></summary>
        <section className="media-manager" aria-labelledby="media-manager-heading">
          <h2 className="sr-only" id="media-manager-heading">Media library</h2>
          <p className="muted">Media is stored locally with this collection and included in full backups.</p>
          {media ? <dl className="media-summary">
            <div><dt>Stored</dt><dd>{media.files} files · {formatBytes(media.bytes)}</dd></div>
            <div><dt>In use</dt><dd>{media.referencedFiles} files referenced by cards or templates</dd></div>
            <div><dt>Unused</dt><dd>{media.unusedFiles} files · {formatBytes(media.unusedBytes)}</dd></div>
          </dl> : <p className="muted">Checking local media…</p>}
          {mediaNotice && <p className="backup-result" role="status">{mediaNotice}</p>}
          <button className="secondary-button" type="button" disabled={busy || !media?.unusedFiles} onClick={() => void cleanMedia()}>
            {media?.unusedFiles ? `Remove ${media.unusedFiles} unused ${media.unusedFiles === 1 ? "file" : "files"}` : "No unused media"}
          </button>
        </section>
      </details>
    </section>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MiB`;
}
