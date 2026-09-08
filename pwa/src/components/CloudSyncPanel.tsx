"use client";

import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";

import { exportCollection, restoreCollection } from "@/lib/db/client";
import { APP_PREFERENCES_KEY, loadPreferences, normalizePreferences, savePreferences } from "@/lib/preferences";
import { supabaseBrowserClient } from "@/lib/supabase/browser";

const SNAPSHOT_BUCKET = "anki-sync";
const MAX_SNAPSHOT_BYTES = 500 * 1024 * 1024;
const SNAPSHOT_PART_BYTES = 5 * 1024 * 1024;
const SAVED_SEARCHES_KEY = "anki.browser.saved-searches";
const SIGN_IN_NOTICE = "Sign in to create a private cloud snapshot.";

type CloudSnapshot = {
  snapshot_path: string;
  version: number;
  size_bytes: number;
  part_count: number;
  updated_at: string;
};

type SavedSearch = { name: string; query: string };

type CloudUserData = {
  preferences: unknown;
  saved_searches: unknown;
};

type Props = {
  embedded?: boolean;
  onBusyChange: (busy: boolean) => void;
  onRestored: () => Promise<void>;
};

function message(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const parts = [record.message, record.error, record.details, record.hint, record.code, record.statusCode]
      .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
      .map(String);
    if (parts.length) return [...new Set(parts)].join(" · ");
    try {
      const serialized = JSON.stringify(record);
      if (serialized && serialized !== "{}") return serialized;
    } catch {
      // Fall through to a safe generic error below.
    }
    return "Cloud sync returned an unknown error.";
  }
  return String(error);
}

function snapshotPath(userId: string) {
  return `${userId}/snapshots/${crypto.randomUUID()}`;
}

function partPath(path: string, part: number) {
  return `${path}/part-${String(part).padStart(4, "0")}.colpkg`;
}

function snapshotParts(snapshot: Pick<CloudSnapshot, "snapshot_path" | "part_count">) {
  // Snapshots created by the original uploader were single objects. Keep them
  // readable while new uploads use small, reliable storage parts.
  if (snapshot.part_count === 1 && snapshot.snapshot_path.endsWith(".colpkg")) return [snapshot.snapshot_path];
  return Array.from({ length: snapshot.part_count }, (_value, part) => partPath(snapshot.snapshot_path, part));
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.ceil(bytes / 1024))} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MiB`;
}

function normalizeSavedSearches(value: unknown): SavedSearch[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.name !== "string" || typeof candidate.query !== "string") return [];
    const name = candidate.name.trim().slice(0, 100);
    const query = candidate.query.trim().slice(0, 1_000);
    return name ? [{ name, query }] : [];
  }).slice(0, 100);
}

function readLocalUserData() {
  let savedSearches: SavedSearch[] = [];
  try {
    savedSearches = normalizeSavedSearches(JSON.parse(localStorage.getItem(SAVED_SEARCHES_KEY) ?? "[]"));
  } catch {
    // A damaged saved-search entry should not block a collection upload.
  }
  return { preferences: loadPreferences(), saved_searches: savedSearches };
}

function applyCloudUserData(data: CloudUserData | null) {
  if (!data) return;
  const preferences = normalizePreferences(data.preferences);
  const savedSearches = normalizeSavedSearches(data.saved_searches);
  savePreferences(preferences);
  localStorage.setItem(SAVED_SEARCHES_KEY, JSON.stringify(savedSearches));
  // Storage events normally fire only in other tabs. Dispatch one here too so
  // the currently open Settings view adopts downloaded preferences immediately.
  window.dispatchEvent(new StorageEvent("storage", { key: APP_PREFERENCES_KEY }));
}

export function CloudSyncPanel({ embedded = false, onBusyChange, onRestored }: Props) {
  const [session, setSession] = useState<Session | null>(null);
  const [snapshot, setSnapshot] = useState<CloudSnapshot | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(SIGN_IN_NOTICE);
  const [error, setError] = useState<string | null>(null);

  const loadSnapshot = useCallback(async (activeSession: Session | null) => {
    if (!activeSession) {
      setSnapshot(null);
      return;
    }
    const { data, error: queryError } = await supabaseBrowserClient()
      .from("anki_collections")
      .select("snapshot_path, version, size_bytes, part_count, updated_at")
      .maybeSingle();
    if (queryError) throw queryError;
    setSnapshot(data as CloudSnapshot | null);
  }, []);

  useEffect(() => {
    const supabase = supabaseBrowserClient();
    let active = true;
    void supabase.auth.getSession().then(async ({ data, error: sessionError }) => {
      if (!active) return;
      if (sessionError) {
        setError(sessionError.message);
        return;
      }
      setSession(data.session);
      try {
        await loadSnapshot(data.session);
      } catch (loadError) {
        if (active) setError(`Cloud sync needs its database setup: ${message(loadError)}`);
      }
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return;
      setSession(nextSession);
      setError(null);
      void loadSnapshot(nextSession).catch((loadError) => {
        if (active) setError(`Cloud sync needs its database setup: ${message(loadError)}`);
      });
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [loadSnapshot]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      await work();
    } catch (runError) {
      setError(message(runError));
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  };

  const signIn = () => void run(async () => {
    const { error: signInError } = await supabaseBrowserClient().auth.signInWithPassword({ email, password });
    if (signInError) throw signInError;
    setPassword("");
    setNotice("Signed in. Checking your private cloud snapshot…");
  });

  const signUp = () => void run(async () => {
    const { data, error: signUpError } = await supabaseBrowserClient().auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}/` }
    });
    if (signUpError) throw signUpError;
    setPassword("");
    setNotice(data.session ? "Account created and signed in." : "Check your email to confirm this account, then sign in.");
  });

  const signOut = () => void run(async () => {
    const { error: signOutError } = await supabaseBrowserClient().auth.signOut();
    if (signOutError) throw signOutError;
    setNotice("Signed out. Your local collection remains on this device.");
  });

  const uploadSnapshot = () => void run(async () => {
    if (!session) throw new Error("Sign in before uploading.");
    setNotice("Preparing your encrypted-in-transit collection backup…");
    const backup = await exportCollection(setNotice);
    if (backup.bytes.byteLength > MAX_SNAPSHOT_BYTES) {
      throw new Error("This collection backup is larger than 500 MiB. Large cloud imports need the upcoming server sync.");
    }
    const path = snapshotPath(session.user.id);
    const partCount = Math.ceil(backup.bytes.byteLength / SNAPSHOT_PART_BYTES);
    const parts = Array.from({ length: partCount }, (_value, part) => partPath(path, part));
    const supabase = supabaseBrowserClient();
    const uploaded: string[] = [];
    try {
      for (const [part, partName] of parts.entries()) {
        const start = part * SNAPSHOT_PART_BYTES;
        const end = Math.min(start + SNAPSHOT_PART_BYTES, backup.bytes.byteLength);
        setNotice(`Uploading ${formatBytes(start)} of ${formatBytes(backup.bytes.byteLength)} (part ${part + 1} of ${partCount})…`);
        const { error: uploadError } = await supabase.storage
          .from(SNAPSHOT_BUCKET)
          .upload(partName, new Blob([backup.bytes.slice(start, end)], { type: "application/octet-stream" }), {
            contentType: "application/octet-stream",
            cacheControl: "no-store"
          });
        if (uploadError) throw uploadError;
        uploaded.push(partName);
      }
    } catch (uploadError) {
      if (uploaded.length) await supabase.storage.from(SNAPSHOT_BUCKET).remove(uploaded);
      throw uploadError;
    }
    const version = Date.now();
    const userData = readLocalUserData();
    const { error: userDataError } = await supabase.from("anki_user_data").upsert({
      owner_id: session.user.id,
      preferences: userData.preferences,
      saved_searches: userData.saved_searches,
      updated_at: new Date().toISOString()
    });
    if (userDataError) {
      await supabase.storage.from(SNAPSHOT_BUCKET).remove(uploaded);
      throw userDataError;
    }
    const { error: saveError } = await supabase.from("anki_collections").upsert({
      owner_id: session.user.id,
      snapshot_path: path,
      version,
      size_bytes: backup.bytes.byteLength,
      part_count: partCount,
      updated_at: new Date().toISOString()
    });
    if (saveError) {
      await supabase.storage.from(SNAPSHOT_BUCKET).remove(uploaded);
      throw saveError;
    }
    if (snapshot) await supabase.storage.from(SNAPSHOT_BUCKET).remove(snapshotParts(snapshot));
    await loadSnapshot(session);
    setNotice(`Uploaded ${backup.notes} notes, ${backup.cards} cards, ${backup.media} media files, settings, and saved searches.`);
  });

  const downloadSnapshot = () => void run(async () => {
    if (!session || !snapshot) throw new Error("There is no cloud snapshot to download.");
    if (!window.confirm("Replace this device's local collection with the cloud snapshot? Local changes not yet uploaded will be lost.")) return;
    if (!snapshot.size_bytes || snapshot.size_bytes > MAX_SNAPSHOT_BYTES || snapshot.part_count < 1) {
      throw new Error("The cloud snapshot is invalid or too large for local restore.");
    }
    const { data: cloudUserData, error: userDataError } = await supabaseBrowserClient()
      .from("anki_user_data")
      .select("preferences, saved_searches")
      .maybeSingle();
    if (userDataError) throw userDataError;
    const parts = snapshotParts(snapshot);
    const assembled = new Uint8Array(snapshot.size_bytes);
    let written = 0;
    for (const [part, partName] of parts.entries()) {
      setNotice(`Downloading ${formatBytes(written)} of ${formatBytes(snapshot.size_bytes)} (part ${part + 1} of ${parts.length})…`);
      const { data, error: downloadError } = await supabaseBrowserClient().storage
        .from(SNAPSHOT_BUCKET)
        .download(partName);
      if (downloadError) throw downloadError;
      const bytes = new Uint8Array(await data.arrayBuffer());
      if (!bytes.byteLength || written + bytes.byteLength > assembled.byteLength) throw new Error("The cloud snapshot parts are incomplete or invalid.");
      assembled.set(bytes, written);
      written += bytes.byteLength;
    }
    if (written !== assembled.byteLength) throw new Error("The cloud snapshot parts are incomplete or invalid.");
    const restored = await restoreCollection(assembled.buffer, setNotice);
    await onRestored();
    applyCloudUserData(cloudUserData as CloudUserData | null);
    setNotice(`Downloaded ${restored.notes} notes, ${restored.cards} cards, ${restored.media} media files, settings, and saved searches.`);
  });

  return (
    <section className={`cloud-sync ${embedded ? "collection-subsection" : "panel settings-section"}`} aria-labelledby="cloud-sync-settings">
      <div className={embedded ? "collection-subsection-heading" : "settings-section-heading"}>
        {!embedded && <span className="settings-section-icon" aria-hidden="true">☁</span>}
        <div><h2 id="cloud-sync-settings">Private cloud sync</h2><p>Keep your collection, settings, and saved searches available on your other devices.</p></div>
      </div>

      {!session ? <form className="cloud-auth-form" onSubmit={(event) => { event.preventDefault(); signIn(); }}>
        <label htmlFor="cloud-email"><span>Email</span><input id="cloud-email" type="email" autoComplete="email" required value={email} disabled={busy} onChange={(event) => setEmail(event.target.value)} /></label>
        <label htmlFor="cloud-password"><span>Password</span><input id="cloud-password" type="password" autoComplete="current-password" minLength={6} required value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} /></label>
        <div className="cloud-auth-actions">
          <button className="primary-button" type="submit" disabled={busy}>Sign in</button>
          <button className="secondary-button" type="button" disabled={busy || !email || password.length < 6} onClick={signUp}>Create account</button>
        </div>
      </form> : <div className="cloud-signed-in">
        <div><strong>{session.user.email ?? "Signed in"}</strong><span>{snapshot ? `Last cloud snapshot: ${new Date(snapshot.updated_at).toLocaleString()} · ${formatBytes(snapshot.size_bytes)}` : "No cloud snapshot yet."}</span></div>
        <button className="text-button" type="button" disabled={busy} onClick={signOut}>Sign out</button>
      </div>}

      {session && <div className="cloud-sync-actions">
        <button className="primary-button" type="button" disabled={busy} onClick={uploadSnapshot}>Upload this device</button>
        <button className="secondary-button" type="button" disabled={busy || !snapshot} onClick={downloadSnapshot}>Download to this device</button>
      </div>}

      <p className="cloud-sync-note">Upload replaces the prior cloud snapshot and saves this device’s settings/searches. Download replaces this device’s collection and applies those settings/searches. Use one device at a time until merge sync is added.</p>
      {(!session || notice !== SIGN_IN_NOTICE) && <p className="settings-saved" role="status" aria-live="polite">{notice}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}
