"use client";

import { useEffect, useState } from "react";

import {
  clearAnkiWebAuth,
  loadAnkiWebAuth,
  loginAnkiWeb,
  uploadToAnkiWeb
} from "@/lib/anki/ankiweb-sync";
import type { AnkiWebAuth, AnkiWebUploadResult } from "@/lib/anki/ankiweb-sync";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "AnkiWeb sync failed.";
}

export function AnkiWebSync({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const [auth, setAuth] = useState<AnkiWebAuth | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnkiWebUploadResult | null>(null);

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
      setProgress("");
    });
  };

  const sync = () => {
    if (!auth || busy) return;
    if (!window.confirm(
      "Upload this device's full collection to AnkiWeb? This replaces the collection currently stored on AnkiWeb. Media from this device will also be uploaded."
    )) return;

    void run(async () => {
      const uploaded = await uploadToAnkiWeb(auth, setProgress);
      setResult(uploaded);
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
          <p className="muted">Upload this local collection and its media to your AnkiWeb account.</p>
        </div>

        {!auth ? (
          <form className="form-panel" onSubmit={signIn}>
            <label htmlFor="ankiweb-username">AnkiWeb email</label>
            <input id="ankiweb-username" type="email" autoComplete="username" value={username}
              onChange={(event) => setUsername(event.target.value)} disabled={busy} />
            <label htmlFor="ankiweb-password">Password</label>
            <input id="ankiweb-password" type="password" autoComplete="current-password" value={password}
              onChange={(event) => setPassword(event.target.value)} disabled={busy} />
            <p className="muted backup-help">Your password is sent only to AnkiWeb during sign-in and is not saved. The returned sync key is stored on this device.</p>
            {error && <p className="form-error" role="alert">{error}</p>}
            {busy && <p role="status" aria-live="polite">{progress}</p>}
            <button className="primary-button" type="submit" disabled={busy || !username.trim() || !password}>
              {busy ? "Signing in…" : "Sign in to AnkiWeb"}
            </button>
          </form>
        ) : (
          <>
            <p className="muted">Signed in as <strong>{auth.username}</strong>.</p>
            <p className="form-error">Collection sync is intentionally one-way in this first version: uploading replaces your AnkiWeb collection. It does not download or merge AnkiWeb card changes back into this PWA.</p>
            {error && <p className="form-error" role="alert">{error}</p>}
            {busy && <p role="status" aria-live="polite">{progress}</p>}
            {result && <p className="backup-result" role="status" aria-live="polite">
              Synced to AnkiWeb · {result.notes} notes · {result.cards} cards · {result.reviews} reviews · {result.media} media files
            </p>}
            <div className="top-actions">
              <button className="primary-button" type="button" disabled={busy} onClick={sync}>
                {busy ? "Syncing…" : "Upload to AnkiWeb"}
              </button>
              <button className="secondary-button" type="button" disabled={busy} onClick={signOut}>Sign out</button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
