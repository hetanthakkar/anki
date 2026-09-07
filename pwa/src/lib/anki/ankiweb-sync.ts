"use client";

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { Zippable } from "fflate";

import { exportCollection } from "@/lib/db/client";

const AUTH_STORAGE_KEY = "anki-pwa-ankiweb-auth-v1";
const MEDIA_BATCH_SIZE = 25;

type MediaFile = { name: string; bytes: Uint8Array };

export type AnkiWebAuth = {
  username: string;
  hostKey: string;
};

export type AnkiWebUploadResult = {
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

function mediaFromBackup(archive: Record<string, Uint8Array>) {
  const manifestBytes = archive.media;
  if (!manifestBytes) return [];
  const manifest = JSON.parse(strFromU8(manifestBytes)) as Record<string, string>;
  return Object.entries(manifest).map(([entry, name]): MediaFile => {
    const bytes = archive[entry];
    if (!bytes) throw new Error(`Backup media entry ${entry} is missing`);
    return { name: name.normalize("NFC"), bytes };
  });
}

function mediaUploadZip(files: MediaFile[]) {
  const archive: Zippable = {};
  const meta: Array<[string, string | null]> = [];
  files.forEach((file, index) => {
    const entry = String(index);
    archive[entry] = [file.bytes, { level: 0 }];
    meta.push([file.name, entry]);
  });
  archive._meta = [strToU8(JSON.stringify(meta)), { level: 0 }];
  return zipSync(archive, { level: 0 });
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
): Promise<AnkiWebUploadResult> {
  progress("Preparing local collection…");
  const backup = await exportCollection(progress);
  const archive = unzipSync(new Uint8Array(backup.bytes));
  const collection = archive["collection.anki2"];
  if (!collection?.length) throw new Error("The local Anki database is missing from the collection backup");

  const session = sessionKey();
  progress("Uploading collection to AnkiWeb…");
  const uploadResponse = strFromU8(
    await requestAnkiWeb("sync", "upload", collection, auth.hostKey, session)
  ).trim();
  if (uploadResponse !== "OK") {
    throw new Error(uploadResponse || "AnkiWeb did not accept the collection upload");
  }

  const media = mediaFromBackup(archive);
  for (let offset = 0; offset < media.length; offset += MEDIA_BATCH_SIZE) {
    const batch = media.slice(offset, offset + MEDIA_BATCH_SIZE);
    progress(`Uploading media ${offset + 1}–${Math.min(offset + batch.length, media.length)} of ${media.length}…`);
    const result = mediaResult<[number, number]>(
      await requestAnkiWeb("msync", "uploadChanges", mediaUploadZip(batch), auth.hostKey, session)
    );
    if (!Array.isArray(result) || Number(result[0]) !== batch.length) {
      throw new Error("AnkiWeb did not accept all media files in the upload batch");
    }
  }

  progress("AnkiWeb sync complete");
  return {
    notes: backup.notes,
    cards: backup.cards,
    reviews: backup.reviews,
    media: media.length
  };
}
