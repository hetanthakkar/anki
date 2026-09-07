"use client";

import { useEffect, useState } from "react";

import {
  ANKIWEB_ACCOUNT_STORAGE,
  ANKIWEB_HOST_KEY_STORAGE,
  downloadFromAnkiWeb,
  loginAnkiWeb,
  uploadToAnkiWeb
} from "@/lib/ankiweb-sync";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function AnkiWebSync({ persistent, onBusyChange }: {
  persistent: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const [hostKey, setHostKey] = useState<string | null>(null);
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    setHostKey(window.localStorage.getItem(ANKIWEB_HOST_KEY_STORAGE));
    setAccount(window.localStorage.getItem(ANKIWEB_ACCOUNT_STORAGE) ?? "");
  }, []);

  const runBusy = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    setSuccess(null);
    try {
      await action();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
      onBusyChange(false);
      setProgress("");
    }
  };

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    await runBusy(async () => {
      setProgress("Signing in to AnkiWeb…");
      const auth = await loginAnkiWeb(account, password);
      window.localStorage.setItem(ANKIWEB_HOST_KEY_STORAGE, auth.hostKey);
      window.localStorage.setItem(ANKIWEB_ACCOUNT_STORAGE, auth.account);
      setHostKey(auth.hostKey);
      setAccount(auth.account);
      setPassword("");
      setSuccess("Connected to AnkiWeb.");
    });
  };

  const disconnect = () => {
    window.localStorage.removeItem(ANKIWEB_HOST_KEY_STORAGE);
    window.localStorage.removeItem(ANKIWEB_ACCOUNT_STORAGE);
    setHostKey(null);
    setAccount("");
    setPassword("");
    setProgress("");
    setError(null);
    setSuccess(null);
  };

  const upload = async () => {
    if (!hostKey) return;
    if (!window.confirm("Upload this device's entire collection and media to AnkiWeb? This is a one-way full sync and will replace the AnkiWeb collection.")) return;
    await runBusy(async () => {
      const result = await uploadToAnkiWeb(hostKey, setProgress);
      setSuccess(`Uploaded ${result.cards} cards, ${result.reviews} reviews, and ${result.media} media files to AnkiWeb.`);
    });
  };

  const download = async () => {
    if (!hostKey) return;
    if (!window.confirm("Download the entire AnkiWeb collection and media? This will replace the collection stored on this device.")) return;
    await runBusy(async () => {
      await downloadFromAnkiWeb(hostKey, persistent, setProgress);
      window.location.reload();
    });
  };

  return (
    <div className="panel form-panel" aria-busy={busy}>
      <div className="form-heading">
        <strong>AnkiWeb sync</strong>
        <span>Full collection and media sync</span>
      </div>

      {!hostKey ? (
        <form className="form-panel" onSubmit={(event) => void login(event)}>
          <label htmlFor="ankiweb-account">AnkiWeb email</label>
          <input id="ankiweb-account" type="email" autoComplete="username" value={account}
            onChange={(event) => setAccount(event.target.value)} placeholder="you@example.com" />
          <label htmlFor="ankiweb-password">Password</label>
          <input id="ankiweb-password" type="password" autoComplete="current-password" value={password}
            onChange={(event) => setPassword(event.target.value)} />
          <p className="muted">Your password is sent only for AnkiWeb login and is not stored. This device stores the returned sync key.</p>
          <button className="primary-button" type="submit" disabled={busy || !account.trim() || !password}>
            {busy ? "Connecting…" : "Connect AnkiWeb"}
          </button>
        </form>
      ) : (
        <>
          <p className="muted">Connected as <strong>{account || "AnkiWeb account"}</strong>.</p>
          <p className="muted">Choose one direction. This full sync does not merge simultaneous changes from both sides.</p>
          {!persistent && <p className="form-error" role="alert">Downloading requires persistent browser storage. Uploading still works.</p>}
          <div style={{ display: "grid", gap: 8 }}>
            <button className="primary-button" type="button" disabled={busy} onClick={() => void upload()}>
              Upload to AnkiWeb
            </button>
            <button className="secondary-button" type="button" disabled={busy || !persistent} onClick={() => void download()}>
              Download from AnkiWeb
            </button>
            <button className="secondary-button" type="button" disabled={busy} onClick={disconnect}>Disconnect</button>
          </div>
        </>
      )}

      {busy && progress && <p role="status" aria-live="polite">{progress}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {success && <p className="backup-result" role="status" aria-live="polite">{success}</p>}
    </div>
  );
}
