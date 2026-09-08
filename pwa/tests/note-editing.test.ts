import assert from "node:assert/strict";
import test from "node:test";

import { nextClozeNumber } from "../src/lib/note-editing";

test("cloze numbering starts at one for a new note", () => {
  assert.equal(nextClozeNumber(["", "Text"]), 1);
});

test("cloze numbering accounts for all fields, repeated numbers, and formatting", () => {
  assert.equal(nextClozeNumber(["{{c2::<b>Paris</b>}} {{c2::France}}", "{{c7::Europe::continent}}"]), 8);
});

test("ordinary numbers and malformed cloze syntax do not allocate a number", () => {
  assert.equal(nextClozeNumber(["2026 {c8::text} {{cat::text}}"]), 1);
});
