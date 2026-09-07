"use client";

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { Zippable } from "fflate";

import { exportCollection, replaceLocalCollection } from "@/lib/db/client";

const CLIENT_VERSION = "Anki PWA 0.1";
const MEDIA_BATCH_SIZE = 25;
const MAX_MEDIA_CHANGE_PAGES = 10_000;

export const ANKIWEB_HOST_KEY_STORAGE = "anki-pwa-ankiweb-host-key";
export const ANKIWEB_ACCOUNT_STORAGE = "anki-pwa-ankiweb-account";

type SyncService = "sync" | "msync";
type MediaFile = { name: string; bytes: Uint8Array };
type RemoteMedia = { usn: number; sha1: string };
type MediaUploadChange = { name: string; bytes: Uint8Array | null };

type UploadResult = {
  notes: number;
  cards: number;
  reviews: number;
  media: number;
};

type DownloadResult = {
  media: number;
};

function ownedBuffer(bytes: Uint8Array) {
  return bytes.slice().buffer as ArrayBuffer;
}

function jsonBytes(value: unknown) {
  return strToU8(JSON.stringify(value));
}

async function ankiRequest(service: SyncService, method: string, hostKey: string | null, data: Uint8Array, media = false) {
  const form = new FormData();
  form.set("c", "0");
  if (hostKey) form.set("k", hostKey);
  if (media) form.set("v", CLIENT_VERSION);
  form.set("data", new Blob([ownedBuffer(data)], { type: "application/octet-stream" }), "data");

  const response = await fetch(`/api/ankiweb?service=${encodeURIComponent(service)}&method=${encodeURIComponent(method)}`, {
    method: "POST",
    body: form,
    cache: "no-store"
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) {
    const detail = strFromU8(bytes).trim();
    throw new Error(detail || `AnkiWeb returned HTTP ${response.status}`);
  }
  return bytes;
}

function parseJson<T>(bytes: Uint8Array): T {
  try {
    return JSON.parse(strFromU8(bytes)) as T;
  } catch {
    throw new Error("AnkiWeb returned an invalid response");
  }
}

function parseMediaResult<T>(bytes: Uint8Array): T {
  const response = parseJson<{ data?: T; err?: string }>(bytes);
  if (response.err) throw new Error(response.err);
  if (!("data" in response)) throw new Error("AnkiWeb returned an invalid media response");
  return response.data as T;
}

function validDatabase(bytes: Uint8Array) {
  return bytes.length >= 16 && strFromU8(bytes.subarray(0, 16)) === "SQLite format 3\0";
}

function readCollectionPackage(bytes: ArrayBuffer) {
  const archive = unzipSync(new Uint8Array(bytes));
  const database = archive["collection.anki2"];
  if (!database || !validDatabase(database)) throw new Error("The local Anki database could not be prepared for sync");

  const manifestBytes = archive.media;
  const manifest = manifestBytes ? parseJson<Record<string, string>>(manifestBytes) : {};
  const media = Object.entries(manifest).map(([archiveName, filename]): MediaFile => {
    const file = archive[archiveName];
    if (!file) throw new Error(`Backup media is missing: ${filename}`);
    return { name: filename.normalize("NFC"), bytes: file };
  });
  return { database, media };
}

async function mediaBegin(hostKey: string) {
  const response = await ankiRequest("msync", "begin", hostKey, jsonBytes({ v: CLIENT_VERSION }), true);
  return parseMediaResult<{ usn: number; sk: string }>(response);
}

async function remoteMediaState(hostKey: string) {
  await mediaBegin(hostKey);
  const files = new Map<string, RemoteMedia>();
  let lastUsn = 0;

  for (let page = 0; page < MAX_MEDIA_CHANGE_PAGES; page += 1) {
    const response = await ankiRequest("msync", "mediaChanges", hostKey, jsonBytes({ lastUsn }), true);
    const changes = parseMediaResult<Array<[string, number, string]>>(response);
    if (!changes.length) return files;

    let nextUsn = lastUsn;
    for (const [name, usn, sha1] of changes) {
      files.set(name.normalize("NFC"), { usn: Number(usn), sha1: String(sha1 ?? "") });
      nextUsn = Math.max(nextUsn, Number(usn));
    }
    if (nextUsn <= lastUsn) throw new Error("AnkiWeb media sync did not advance");
    lastUsn = nextUsn;
  }

  throw new Error("AnkiWeb returned too many media change pages");
}

function mediaUploadZip(changes: MediaUploadChange[]) {
  const archive: Zippable = {};
  const manifest: Array<[string, string | null]> = [];
  changes.forEach((change, index) => {
    if (change.bytes === null) {
      manifest.push([change.name, null]);
      return;
    }
    const archiveName = String(index);
    archive[archiveName] = [change.bytes, { level: 0 }];
    manifest.push([change.name, archiveName]);
  });
  archive._meta = [jsonBytes(manifest), { level: 0 }];
  return zipSync(archive, { level: 0 });
}

async function uploadMediaChanges(hostKey: string, changes: MediaUploadChange[], progress: (message: string) => void) {
  let processed = 0;
  for (let offset = 0; offset < changes.length; offset += MEDIA_BATCH_SIZE) {
    const batch = changes.slice(offset, offset + MEDIA_BATCH_SIZE);
    progress(`Uploading media ${Math.min(offset + batch.length, changes.length)} of ${changes.length}…`);
    const response = await ankiRequest("msync", "uploadChanges", hostKey, mediaUploadZip(batch), true);
    const [accepted] = parseMediaResult<[number, number]>(response);
    if (Number(accepted) !== batch.length) throw new Error("AnkiWeb did not accept the complete media batch");
    processed += batch.length;
  }
  return processed;
}

function mediaDownloadFiles(zipBytes: Uint8Array) {
  const archive = unzipSync(zipBytes);
  const metaBytes = archive._meta;
  if (!metaBytes) throw new Error("AnkiWeb returned a malformed media archive");
  const manifest = parseJson<Record<string, string>>(metaBytes);
  return Object.entries(manifest).map(([archiveName, filename]): MediaFile => {
    const bytes = archive[archiveName];
    if (!bytes) throw new Error(`AnkiWeb media archive is missing ${filename}`);
    return { name: filename.normalize("NFC"), bytes };
  });
}

async function downloadAllMedia(hostKey: string, progress: (message: string) => void) {
  progress("Reading AnkiWeb media index…");
  const remote = await remoteMediaState(hostKey);
  const names = [...remote.entries()].filter(([, value]) => value.sha1).map(([name]) => name).sort();
  const files: MediaFile[] = [];
  for (let offset = 0; offset < names.length; offset += MEDIA_BATCH_SIZE) {
    const batch = names.slice(offset, offset + MEDIA_BATCH_SIZE);
    progress(`Downloading media ${Math.min(offset + batch.length, names.length)} of ${names.length}…`);
    const response = await ankiRequest("msync", "downloadFiles", hostKey, jsonBytes({ files: batch }), true);
    files.push(...mediaDownloadFiles(response));
  }
  return files;
}

async function replacePersistentMedia(files: MediaFile[], progress: (message: string) => void) {
  if (!navigator.storage?.getDirectory) throw new Error("Persistent browser storage is required to download from AnkiWeb");
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry("anki-pwa-media-v2", { recursive: true });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
  }
  const directory = await root.getDirectoryHandle("anki-pwa-media-v2", { create: true });
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    progress(`Saving media ${index + 1} of ${files.length}…`);
    const handle = await directory.getFileHandle(file.name, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(ownedBuffer(file.bytes));
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
  }
}

export async function loginAnkiWeb(username: string, password: string) {
  const account = username.trim();
  if (!account || !password) throw new Error("Enter your AnkiWeb email and password");
  const response = await ankiRequest("sync", "hostKey", null, jsonBytes({ u: account, p: password }));
  const result = parseJson<{ key?: string }>(response);
  if (!result.key) throw new Error("AnkiWeb login failed");
  return { hostKey: result.key, account };
}

export async function uploadToAnkiWeb(hostKey: string, progress: (message: string) => void): Promise<UploadResult> {
  progress("Creating local collection snapshot…");
  const backup = await exportCollection((message) => progress(message));
  const { database, media } = readCollectionPackage(backup.bytes);

  progress("Uploading collection to AnkiWeb…");
  const collectionResponse = await ankiRequest("sync", "upload", hostKey, database);
  const uploadMessage = strFromU8(collectionResponse).trim();
  if (uploadMessage !== "OK") throw new Error(uploadMessage || "AnkiWeb rejected the collection upload");

  progress("Comparing AnkiWeb media…");
  const remote = await remoteMediaState(hostKey);
  const localNames = new Set(media.map((file) => file.name));
  const changes: MediaUploadChange[] = media.map((file) => ({ name: file.name, bytes: file.bytes }));
  for (const [name, state] of remote) {
    if (state.sha1 && !localNames.has(name)) changes.push({ name, bytes: null });
  }
  if (changes.length) await uploadMediaChanges(hostKey, changes, progress);

  progress("AnkiWeb sync complete.");
  return { notes: backup.notes, cards: backup.cards, reviews: backup.reviews, media: media.length };
}

export async function downloadFromAnkiWeb(hostKey: string, persistent: boolean, progress: (message: string) => void): Promise<DownloadResult> {
  if (!persistent) throw new Error("Persistent browser storage is required before downloading from AnkiWeb");

  progress("Downloading collection from AnkiWeb…");
  const database = await ankiRequest("sync", "download", hostKey, jsonBytes({}));
  if (!validDatabase(database)) {
    const message = strFromU8(database).trim();
    throw new Error(message || "AnkiWeb did not return a valid collection database");
  }

  const media = await downloadAllMedia(hostKey, progress);
  progress("Replacing local collection…");
  await replaceLocalCollection(ownedBuffer(database));
  await replacePersistentMedia(media, progress);
  progress("AnkiWeb download complete.");
  return { media: media.length };
}
