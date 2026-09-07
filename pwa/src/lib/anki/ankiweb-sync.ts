"use client";

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { Zippable } from "fflate";

import {
  prepareCollectionForAnkiWeb,
  replaceCollectionFromAnkiWeb
} from "@/lib/db/client";

const AUTH_STORAGE_KEY = "anki-pwa-ankiweb-auth-v1";
const MEDIA_STATE_PREFIX = "anki-pwa-ankiweb-media-v1:";
const MEDIA_DIRECTORY = "anki-pwa-media-v2";
const MEDIA_MAX_BATCH_FILES = 25;
const MEDIA_TARGET_BATCH_BYTES = Math.floor(2.5 * 1024 * 1024);
const MEDIA_MAX_FILE_BYTES = 100 * 1024 * 1024;
const MEDIA_CLIENT_VERSION = "anki-pwa/0.1";

type MediaFile = { name: string; bytes: Uint8Array };
type MediaUpload = { name: string; bytes?: Uint8Array };
type MediaChange = [string, number, string];
type MediaSyncState = { lastUsn: number; hashes: Record<string, string> };

export type AnkiWebAuth = {
  username: string;
  hostKey: string;
};

export type AnkiWebSyncResult = {
  notes: number;
  cards: number;
  reviews: number;
  media: number;
};

function sessionKey() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 16);
}

function arrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function requestAnkiWeb(
  scope: "sync" | "msync",
  method: string,
  body: Uint8Array,
  hostKey = "",
  session = sessionKey()
) {
  const response = await fetch("/api/ankiweb", {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-anki-scope": scope,
      "x-anki-method": method,
      "x-anki-host-key": hostKey,
      "x-anki-session-key": session
    },
    body: arrayBuffer(body),
    cache: "no-store"
  });

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) {
    const message = strFromU8(bytes).trim();
    throw new Error(message || `AnkiWeb returned HTTP ${response.status}`);
  }
  return bytes;
}

function jsonBytes(value: unknown) {
  return strToU8(JSON.stringify(value));
}

function mediaResult<T>(bytes: Uint8Array): T {
  const result = JSON.parse(strFromU8(bytes)) as { data?: T; err?: string };
  if (result.err) throw new Error(result.err);
  if (result.data === undefined) throw new Error("AnkiWeb returned an invalid media-sync response");
  return result.data;
}

function validMediaName(name: string) {
  return Boolean(name)
    && name !== "."
    && name !== ".."
    && new TextEncoder().encode(name).byteLength <= 255
    && !/[\\/\u0000-\u001f\u007f]/.test(name);
}

function safeMediaName(input: string) {
  const name = input.normalize("NFC");
  if (!validMediaName(name)) throw new Error("AnkiWeb returned an invalid media filename");
  return name;
}

async function mediaDirectory() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(MEDIA_DIRECTORY, { create: true });
}

async function readLocalMedia() {
  const directory = await mediaDirectory();
  const files = new Map<string, Uint8Array>();
  const entries = (directory as FileSystemDirectoryHandle & {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  }).entries();
  for await (const [rawName, handle] of entries) {
    if (handle.kind !== "file") continue;
    const name = safeMediaName(rawName);
    const file = await (handle as FileSystemFileHandle).getFile();
    files.set(name, new Uint8Array(await file.arrayBuffer()));
  }
  return files;
}

async function writeLocalMedia(nameInput: string, bytes: Uint8Array) {
  const name = safeMediaName(nameInput);
  if (!bytes.length) throw new Error(`AnkiWeb returned empty media: ${name}`);
  if (bytes.byteLength > MEDIA_MAX_FILE_BYTES) throw new Error(`AnkiWeb media is too large: ${name}`);
  const directory = await mediaDirectory();
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

async function removeLocalMedia(nameInput: string) {
  const name = safeMediaName(nameInput);
  const directory = await mediaDirectory();
  try {
    await directory.removeEntry(name);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
  }
}

async function sha1(bytes: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", arrayBuffer(bytes)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function mediaHashes(files: Map<string, Uint8Array>) {
  const hashes: Record<string, string> = {};
  for (const [name, bytes] of files) hashes[name] = await sha1(bytes);
  return hashes;
}

function mediaStateKey(auth: AnkiWebAuth) {
  return `${MEDIA_STATE_PREFIX}${auth.username.trim().toLowerCase()}`;
}

function loadMediaState(auth: AnkiWebAuth): MediaSyncState {
  try {
    const raw = localStorage.getItem(mediaStateKey(auth));
    if (!raw) return { lastUsn: 0, hashes: {} };
    const parsed = JSON.parse(raw) as Partial<MediaSyncState>;
    const lastUsn = Number(parsed.lastUsn);
    return {
      lastUsn: Number.isInteger(lastUsn) && lastUsn >= 0 ? lastUsn : 0,
      hashes: parsed.hashes && typeof parsed.hashes === "object" ? parsed.hashes : {}
    };
  } catch {
    return { lastUsn: 0, hashes: {} };
  }
}

function saveMediaState(auth: AnkiWebAuth, state: MediaSyncState) {
  try {
    localStorage.setItem(mediaStateKey(auth), JSON.stringify(state));
  } catch {
    // Do not leave a stale USN behind if the checksum index exceeds browser
    // storage quota. Starting at USN 0 next time is slower but correct.
    localStorage.removeItem(mediaStateKey(auth));
  }
}

function clearMediaState(auth?: AnkiWebAuth | null) {
  if (auth) localStorage.removeItem(mediaStateKey(auth));
}

function mediaUploadZip(files: MediaUpload[]) {
  const archive: Zippable = {};
  const meta: Array<[string, string | null]> = [];
  files.forEach((file, index) => {
    const name = safeMediaName(file.name);
    if (file.bytes) {
      if (!file.bytes.length || file.bytes.byteLength > MEDIA_MAX_FILE_BYTES) {
        throw new Error(`Media cannot be synced because its size is unsupported: ${name}`);
      }
      const entry = String(index);
      archive[entry] = [file.bytes, { level: 0 }];
      meta.push([name, entry]);
    } else {
      meta.push([name, null]);
    }
  });
  archive._meta = [strToU8(JSON.stringify(meta)), { level: 0 }];
  return zipSync(archive, { level: 0 });
}

function mediaDownloadFiles(zipBytes: Uint8Array) {
  const archive = unzipSync(zipBytes);
  const metaBytes = archive._meta;
  if (!metaBytes) throw new Error("AnkiWeb returned a malformed media archive");
  const meta = JSON.parse(strFromU8(metaBytes)) as Record<string, string>;
  return Object.entries(meta).map(([entry, rawName]): MediaFile => {
    const bytes = archive[entry];
    if (!bytes) throw new Error("AnkiWeb returned an incomplete media archive");
    return { name: safeMediaName(rawName), bytes };
  });
}

function nextUploadBatch(names: string[], offset: number, local: Map<string, Uint8Array>) {
  const batch: string[] = [];
  let bytes = 0;
  for (let index = offset; index < names.length && batch.length < MEDIA_MAX_BATCH_FILES; index += 1) {
    if (batch.length && bytes > MEDIA_TARGET_BATCH_BYTES) break;
    const name = names[index];
    const data = local.get(name);
    if (data && data.byteLength > MEDIA_MAX_FILE_BYTES) {
      throw new Error(`Media cannot be synced because it exceeds 100 MiB: ${name}`);
    }
    batch.push(name);
    bytes += data?.byteLength ?? 0;
  }
  return batch;
}

async function syncMedia(auth: AnkiWebAuth, session: string, progress: (message: string) => void) {
  progress("Checking AnkiWeb media…");
  const begin = mediaResult<{ usn: number }>(
    await requestAnkiWeb("msync", "begin", jsonBytes({ v: MEDIA_CLIENT_VERSION }), auth.hostKey, session)
  );
  const serverUsn = Math.max(0, Number(begin.usn) || 0);
  const state = loadMediaState(auth);
  if (state.lastUsn > serverUsn) {
    state.lastUsn = 0;
    state.hashes = {};
  }

  let local = await readLocalMedia();
  let hashes = await mediaHashes(local);
  let cursor = state.lastUsn;

  if (cursor !== serverUsn) {
    progress("Downloading AnkiWeb media changes…");
    for (;;) {
      const changes = mediaResult<MediaChange[]>(
        await requestAnkiWeb("msync", "mediaChanges", jsonBytes({ lastUsn: cursor }), auth.hostKey, session)
      );
      if (!Array.isArray(changes) || !changes.length) {
        cursor = Math.max(cursor, serverUsn);
        break;
      }

      const downloads: Array<{ name: string; sha1: string }> = [];
      for (const change of changes) {
        if (!Array.isArray(change) || change.length < 3) throw new Error("AnkiWeb returned an invalid media change");
        const name = safeMediaName(String(change[0]));
        const usn = Number(change[1]);
        const remoteHash = String(change[2] ?? "");
        if (!Number.isInteger(usn) || usn < 0) throw new Error("AnkiWeb returned an invalid media USN");

        const localHash = hashes[name] ?? "";
        const previousHash = state.hashes[name] ?? "";
        const localPending = localHash !== previousHash;

        if (remoteHash === localHash) {
          if (remoteHash) state.hashes[name] = remoteHash;
          else delete state.hashes[name];
        } else if (!remoteHash) {
          if (localPending && localHash) {
            // A locally-added/replaced file wins over a remote deletion, which
            // matches Anki's media conflict rule. Leave it pending for upload.
            delete state.hashes[name];
          } else {
            await removeLocalMedia(name);
            local.delete(name);
            delete hashes[name];
            delete state.hashes[name];
          }
        } else {
          // For two different non-empty versions, Anki favours the server.
          downloads.push({ name, sha1: remoteHash });
          state.hashes[name] = remoteHash;
        }
        cursor = Math.max(cursor, usn);
      }

      for (let offset = 0; offset < downloads.length; offset += MEDIA_MAX_BATCH_FILES) {
        const batch = downloads.slice(offset, offset + MEDIA_MAX_BATCH_FILES);
        const wanted = new Map(batch.map((file) => [file.name, file.sha1]));
        const downloaded = mediaDownloadFiles(
          await requestAnkiWeb("msync", "downloadFiles", jsonBytes({ files: batch.map((file) => file.name) }), auth.hostKey, session)
        );
        for (const file of downloaded) {
          const expected = wanted.get(file.name);
          if (!expected || await sha1(file.bytes) !== expected) {
            throw new Error(`AnkiWeb media checksum mismatch: ${file.name}`);
          }
          await writeLocalMedia(file.name, file.bytes);
          local.set(file.name, file.bytes);
          hashes[file.name] = expected;
          wanted.delete(file.name);
        }
        if (wanted.size) throw new Error("AnkiWeb did not return all requested media files");
      }
    }
  }

  // Re-read after remote changes so external filesystem changes are not missed.
  local = await readLocalMedia();
  hashes = await mediaHashes(local);
  const names = new Set([...Object.keys(state.hashes), ...Object.keys(hashes)]);
  const pending = [...names]
    .filter((name) => (hashes[name] ?? "") !== (state.hashes[name] ?? ""))
    .sort((left, right) => left.localeCompare(right));

  let finalUsn = Math.max(cursor, serverUsn);
  let offset = 0;
  while (offset < pending.length) {
    const namesBatch = nextUploadBatch(pending, offset, local);
    if (!namesBatch.length) throw new Error("Could not create an AnkiWeb media upload batch");
    progress(`Uploading media ${offset + 1}–${Math.min(offset + namesBatch.length, pending.length)} of ${pending.length}…`);
    const uploads: MediaUpload[] = namesBatch.map((name) => ({ name, bytes: local.get(name) }));
    const reply = mediaResult<[number, number]>(
      await requestAnkiWeb("msync", "uploadChanges", mediaUploadZip(uploads), auth.hostKey, session)
    );
    const processed = Number(reply?.[0]);
    const currentUsn = Number(reply?.[1]);
    if (!Array.isArray(reply) || processed !== namesBatch.length || !Number.isInteger(currentUsn)) {
      throw new Error("AnkiWeb did not accept all media files in the upload batch");
    }
    finalUsn = Math.max(finalUsn, currentUsn);
    for (const name of namesBatch) {
      const hash = hashes[name];
      if (hash) state.hashes[name] = hash;
      else delete state.hashes[name];
    }
    offset += namesBatch.length;
  }

  const sanity = mediaResult<string>(
    await requestAnkiWeb("msync", "mediaSanity", jsonBytes({ local: local.size }), auth.hostKey, session)
  );
  if (sanity !== "OK") {
    clearMediaState(auth);
    throw new Error("AnkiWeb media sanity check failed. Run sync again to rebuild the media index.");
  }

  state.lastUsn = finalUsn;
  saveMediaState(auth, state);
  return local.size;
}

export function loadAnkiWebAuth(): AnkiWebAuth | null {
  try {
    const stored = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as Partial<AnkiWebAuth>;
    if (!parsed.username || !parsed.hostKey) return null;
    return { username: parsed.username, hostKey: parsed.hostKey };
  } catch {
    return null;
  }
}

export function clearAnkiWebAuth() {
  const auth = loadAnkiWebAuth();
  clearMediaState(auth);
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

export async function loginAnkiWeb(username: string, password: string): Promise<AnkiWebAuth> {
  const normalizedUsername = username.trim();
  if (!normalizedUsername || !password) throw new Error("Enter your AnkiWeb email and password");

  const bytes = await requestAnkiWeb("sync", "hostKey", jsonBytes({ u: normalizedUsername, p: password }));
  let key: string;
  try {
    key = String((JSON.parse(strFromU8(bytes)) as { key?: string }).key ?? "");
  } catch {
    key = "";
  }
  if (!key) throw new Error("AnkiWeb login failed. Check your email and password.");

  const auth = { username: normalizedUsername, hostKey: key };
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(auth));
  return auth;
}

export async function uploadToAnkiWeb(
  auth: AnkiWebAuth,
  progress: (message: string) => void
): Promise<AnkiWebSyncResult> {
  progress("Preparing collection for AnkiWeb…");
  const snapshot = await prepareCollectionForAnkiWeb();
  const session = sessionKey();

  progress("Uploading collection to AnkiWeb…");
  const uploadResponse = strFromU8(
    await requestAnkiWeb("sync", "upload", new Uint8Array(snapshot.bytes), auth.hostKey, session)
  ).trim();
  if (uploadResponse !== "OK") {
    throw new Error(uploadResponse || "AnkiWeb did not accept the collection upload");
  }

  const media = await syncMedia(auth, session, progress);
  progress("AnkiWeb sync complete");
  return { notes: snapshot.notes, cards: snapshot.cards, reviews: snapshot.reviews, media };
}

export async function downloadFromAnkiWeb(
  auth: AnkiWebAuth,
  progress: (message: string) => void
): Promise<AnkiWebSyncResult> {
  const session = sessionKey();
  progress("Downloading collection from AnkiWeb…");
  const downloaded = await requestAnkiWeb("sync", "download", jsonBytes({}), auth.hostKey, session);
  const collectionBytes = arrayBuffer(downloaded);

  progress("Replacing local collection…");
  const counts = await replaceCollectionFromAnkiWeb(collectionBytes);
  const media = await syncMedia(auth, session, progress);
  progress("AnkiWeb sync complete");
  return { ...counts, media };
}
