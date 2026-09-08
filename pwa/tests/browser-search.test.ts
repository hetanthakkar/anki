import assert from "node:assert/strict";
import { before, test } from "node:test";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Database } from "@sqlite.org/sqlite-wasm";
import { browserSearch, quoteSearch } from "../src/lib/db/browser-search";
import type { SearchContext } from "../src/lib/db/browser-search";

let db: Database;
const dayStart = 1_800_000_000;
const context: SearchContext = {
  today: 100, dayStart, now: dayStart + 3600, currentDeckId: 1,
  decks: [{ id: 1, name: 'French "A"' }, { id: 2, name: 'French "A"::Verbs' }, { id: 3, name: "Other" }],
  notetypes: [{ id: 1, name: "Basic" }, { id: 2, name: "Cloze" }],
};
const recent = dayStart * 1000 + 100;
before(async () => {
  const sqlite = await sqlite3InitModule(); db = new sqlite.oo1.DB(":memory:", "c");
  db.exec(`CREATE TABLE notes (id, mid, mod, flds, tags, sfld);
    CREATE TABLE cards (id, nid, did, ord, type, queue, due, odue, flags);
    CREATE TABLE revlog (id, cid, ease);`);
  db.exec({ sql: "INSERT INTO notes VALUES (1,1,?,'Bonjour',' french verbs ','Bonjour'),(2,2,?,'Paris','','Paris')", bind: [dayStart + 1, dayStart - 86400] });
  const cards = [
    [1, 1, 1, 0, 2, 2, 100, 0, 9], // Red, with an unrelated high flag bit.
    [2, 1, 2, 1, 2, 2, 99, 0, 2],
    [3, 2, 3, 0, 0, 0, 1, 0, 0],
    [4, 2, 3, 0, 1, 1, dayStart + 7200, 0, 3],
    [5, 2, 3, 1, 2, -1, 99, 0, 4],
    [6, 2, 3, 2, 3, -2, dayStart - 1, 0, 5],
    [7, 2, 3, 3, 3, -3, dayStart - 1, 0, 6],
    [8, 2, 3, 4, 1, 3, 100, 0, 7],
    [9, 2, 3, 5, 2, 2, 555, 100, 0], // Original due date of a filtered card.
    [recent, 1, 1, 0, 0, 0, 2, 0, 0],
  ];
  for (const row of cards) db.exec({ sql: "INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?)", bind: row });
  for (const row of [[dayStart * 1000 - 100, 1, 3], [recent + 1, 1, 1], [recent + 2, 2, 3], [recent + 3, 3, 0]]) {
    db.exec({ sql: "INSERT INTO revlog VALUES (?,?,?)", bind: row });
  }
});
function find(query: string): number[] {
  const search = browserSearch(query, context);
  const count = Number(db.selectValue(`SELECT count(*) FROM cards c JOIN notes n ON c.nid = n.id WHERE ${search.sql}`, search.bind.length ? search.bind : undefined));
  const rows = db.selectObjects(`SELECT c.id FROM cards c JOIN notes n ON c.nid = n.id WHERE ${search.sql} ORDER BY c.id`, search.bind).map((row) => Number(row.id));
  assert.equal(rows.length, count);
  return rows;
}
test("an unfiltered search counts and returns every card", () => {
  assert.equal(find("").length, 10);
});
test("sidebar due filters distinguish today, overdue, future learning, and inactive cards", () => {
  assert.deepEqual(find("prop:due=0"), [1, 4, 8, 9]);
  assert.deepEqual(find("is:due -prop:due=0"), [2]);
  assert.deepEqual(find("prop:due<0"), [2]);
});
test("today activity uses study-day cutoffs and excludes manual logs from reviews", () => {
  assert.deepEqual(find("added:1"), [recent]);
  assert.deepEqual(find("edited:1"), [1, 2, recent]);
  assert.deepEqual(find("rated:1"), [1, 2]);
  assert.deepEqual(find("introduced:1"), [2]);
  assert.deepEqual(find("resched:1"), [3]);
  assert.deepEqual(find("rated:1:1"), [1]);
  assert.deepEqual(find("-introduced:1"), [1, 3, 4, 5, 6, 7, 8, 9, recent]);
});
test("all flags and states are searchable, including both buried queues", () => {
  for (let flag = 1; flag <= 7; flag++) assert.equal(find(`flag:${flag}`).length, 1);
  assert.deepEqual(find("flag:0"), [3, 9, recent]);
  assert.deepEqual(find("is:new"), [3, recent]);
  assert.deepEqual(find("is:learn"), [4, 6, 7, 8]);
  assert.deepEqual(find("is:review"), [1, 2, 5, 6, 7, 9]);
  assert.deepEqual(find("is:suspended"), [5]);
  assert.deepEqual(find("is:buried"), [6, 7]);
});
test("deck and card filters constrain the same card, with subdecks and quoted names", () => {
  assert.deepEqual(find(`deck:${quoteSearch('French "A"')}`), [1, 2, recent]);
  assert.deepEqual(find("deck:current"), [1, 2, recent]);
  assert.deepEqual(find("did:2 flag:1"), []);
  assert.deepEqual(find("mid:1 card:2"), [2]);
  assert.deepEqual(find('note:"Basic" tag:verbs -flag:1'), [2, recent]);
  assert.deepEqual(find("tag:none is:new"), [3]);
  assert.deepEqual(find("Bonjour tag:french"), [1, 2, recent]);
});
test("invalid syntax reports errors and query values cannot become SQL", () => {
  for (const query of ['deck:"unfinished', "flag:8", "prop:due=0;DROP", "is:invalid", "madeup:value"]) assert.throws(() => find(query));
  assert.deepEqual(find(`tag:${quoteSearch("' OR 1=1 --")}`), []);
  assert.throws(() => browserSearch("deck:current", { ...context, currentDeckId: null }), /Open a deck/);
});
