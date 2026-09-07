import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFileSync } from "node:fs";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { strToU8, unzipSync } from "fflate";

import { readApkg } from "../src/lib/anki/apkg";
import { buildCollectionPackage } from "../src/lib/anki/export-colpkg";

let sqlite: Sqlite3Static;
before(async () => { sqlite = await sqlite3InitModule(); });

const schema = readFileSync(new URL("../../rslib/src/storage/schema11.sql", import.meta.url), "utf8");
const model = {
  id: 100,
  name: "Backup basic",
  type: 0,
  sortf: 0,
  flds: [{ name: "Front", ord: 0 }, { name: "Back", ord: 1 }],
  tmpls: [{ name: "Card 1", ord: 0, qfmt: "{{Front}}", afmt: "{{FrontSide}}<hr>{{Back}}" }],
  css: ".card { color: black; }"
};
const deck = { id: 200, name: "Backup deck", dyn: 0, conf: 1 };

function database() {
  const db = new sqlite.oo1.DB(":memory:", "c");
  db.exec(schema);
  db.exec({
    sql: "UPDATE col SET ver = 11, models = ?, decks = ?",
    bind: [JSON.stringify({ 100: model }), JSON.stringify({ 200: deck })]
  });
  db.exec({
    sql: "INSERT INTO notes VALUES (10, 'backup-guid', 100, 1, -1, ' saved ', ?, 'Question', 1, 0, '')",
    bind: ['Question\u001f<img src="diagram.png">']
  });
  db.exec("INSERT INTO cards VALUES (20, 10, 200, 0, 1, -1, 2, 2, 10, 7, 2500, 3, 0, 0, 0, 0, 0, '')");
  db.exec("INSERT INTO revlog VALUES (30, 20, -1, 3, 7, 3, 2500, 1000, 1)");
  return db;
}

function exportDb(db: Database) {
  return sqlite.capi.sqlite3_js_db_export(db.pointer!);
}

test("exports a complete legacy collection package with media", () => {
  const db = database();
  try {
    const image = strToU8("image bytes");
    const sound = strToU8("sound bytes");
    const bytes = buildCollectionPackage(exportDb(db), [
      { name: "diagram.png", bytes: image },
      { name: "caf\u00e9.mp3", bytes: sound }
    ]);
    const archive = unzipSync(bytes);
    assert.ok(archive["collection.anki2"]);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(archive.media)), {
      0: "diagram.png",
      1: "caf\u00e9.mp3"
    });
    assert.deepEqual(archive["0"], image);
    assert.deepEqual(archive["1"], sound);

    const parsed = readApkg(sqlite, bytes, true);
    assert.equal(parsed.notes.length, 1);
    assert.equal(parsed.cards.length, 1);
    assert.equal(parsed.reviews.length, 1);
    assert.equal(parsed.cards[0].reps, 3);
    assert.deepEqual(parsed.media.map((file) => file.name), ["diagram.png", "caf\u00e9.mp3"]);
  } finally {
    db.close();
  }
});

test("rejects invalid databases and unsafe or duplicate media names", () => {
  assert.throws(() => buildCollectionPackage(strToU8("not sqlite"), []), /could not be serialized/);
  const db = database();
  try {
    const bytes = exportDb(db);
    assert.throws(() => buildCollectionPackage(bytes, [{ name: "../image.png", bytes: strToU8("x") }]), /invalid media filename/);
    assert.throws(() => buildCollectionPackage(bytes, [
      { name: "caf\u00e9.png", bytes: strToU8("x") },
      { name: "cafe\u0301.png", bytes: strToU8("y") }
    ]), /duplicate media/);
  } finally {
    db.close();
  }
});
