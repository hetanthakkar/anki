"use client";

import { useEffect, useState } from "react";

import {
  clearAnkiWebAuth,
  downloadFromAnkiWeb,
  loadAnkiWebAuth,
  loginAnkiWeb,
  uploadToAnkiWeb
} from "@/lib/anki/ankiweb-sync";
import type { AnkiWebAuth, AnkiWebSyncResult } from "@/lib/anki/ankiweb-sync";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "AnkiWeb sync failed.";
}

export function AnkiWebSync({ persistent, onBusyChange }: {
  persistent: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const [auth, setAuth] = useState<AnkiWebAuth | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnkiWebSyncResult | null>(null);

  useEffect(() => {
    setAuth(loadAnkiWebAuth());
  }, []);

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    setResult(null);
    try {
      await work();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
      onBusyChange(false);
      setProgress("");
    }
  };

  const signIn = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      setProgress("Signing in to AnkiWeb…");
      const signedIn = await loginAnkiWeb(username, password);
      setAuth(signedIn);
      setPassword("");
    });
  };

  const upload = () => {
    if (!auth || busy || !persistent) return;
    if (!window.confirm(
      "Upload this device's full collection to AnkiWeb? This replaces the card collection currently stored on AnkiWeb. Media is merged separately."
    )) return;

    void run(async () => {
      setResult(await uploadToAnkiWeb(auth, setProgress));
    });
  };

  const download = () => {
    if (!auth || busy || !persistent) return;
    if (!window.confirm(
      "Download the full collection from AnkiWeb? This replaces the card collection on this device. Local/remote media is merged separately."
    )) return;

    void run(async () => {
      await downloadFromAnkiWeb(auth, setProgress);
      // The main collection worker was intentionally stopped while replacing
      // its OPFS database. Reload so every screen reopens the downloaded copy.
      window.location.reload();
    });
  };

  const signOut = () => {
    if (busy) return;
    clearAnkiWebAuth();
    setAuth(null);
    setUsername("");
    setPassword("");
    setError(null);
    setResult(null);
  };

  return (
    <section className="settings-list">
      <div className="panel backup-panel" aria-busy={busy}>
        <div>
          <h2>AnkiWeb</h2>
          <p className="muted">Sign in and move your full collection between this PWA and AnkiWeb. Media is merged in both directions.</p>
        </div>

        {!persistent && (
          <p className="form-error" role="alert">AnkiWeb collection sync requires persistent browser storage. Reload in a browser where OPFS is available.</p>
        )}

        {!auth ? (
          <form className="form-panel" onSubmit={signIn}>
            <label htmlFor="ankiweb-username">AnkiWeb email</label>
            <input id="ankiweb-username" type="email" autoComplete="username" value={username}
              onChange={(event) => setUsername(event.target.value)} disabled={busy} />
            <label htmlFor="ankiweb-password">Password</label>
            <input id="ankiweb-password" type="password" autoComplete="current-password" value={password}
              onChange={(event) => setPassword(event.target.value)} disabled={busy} />
            <p className="muted backup-help">Your password is sent only during sign-in and is not saved. The sync key returned by AnkiWeb is stored on this device.</p>
            {error && <p className="form-error" role="alert">{error}</p>}
            {busy && <p role="status" aria-live="polite">{progress}</p>}
            <button className="primary-button" type="submit" disabled={busy || !username.trim() || !password}>
              {busy ? "Signing in…" : "Sign in to AnkiWeb"}
            </button>
          </form>
        ) : (
          <>
            <p className="muted">Signed in as <strong>{auth.username}</strong>.</p>
            <p className="muted backup-help">Collection sync is a full one-way replacement per action, matching Anki's full-sync flow. Choose <strong>Upload</strong> when this device should win, or <strong>Download</strong> when AnkiWeb should win. Media changes are merged separately.</p>
            {error && <p className="form-error" role="alert">{error}</p>}
            {busy && <p role="status" aria-live="polite">{progress}</p>}
            {result && <p className="backup-result" role="status" aria-live="polite">
              Synced · {result.notes} notes · {result.cards} cards · {result.reviews} reviews · {result.media} media files
            </p>}
            <div className="top-actions">
              <button className="primary-button" type="button" disabled={busy || !persistent} onClick={upload}>
                {busy ? "Syncing…" : "Upload to AnkiWeb"}
              </button>
              <button className="secondary-button" type="button" disabled={busy || !persistent} onClick={download}>Download from AnkiWeb</button>
              <button className="secondary-button" type="button" disabled={busy} onClick={signOut}>Sign out</button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
