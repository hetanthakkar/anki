import assert from "node:assert/strict";
import test from "node:test";

import { mediaReferences } from "../src/lib/anki/media-references";

test("finds local Anki media in fields, templates, and CSS", () => {
  assert.deepEqual([...mediaReferences(
    '[sound:hello%20there.mp3]<img src="diagram.png"><video poster=cover.jpg>',
    '.card { background: url("font.woff2"); }',
    '<img src="https://example.com/remote.png"><img src="data:image/png;base64,x">'
  )].sort(), ["cover.jpg", "diagram.png", "font.woff2", "hello there.mp3"]);
});

test("ignores unsafe and external media references", () => {
  assert.deepEqual([...mediaReferences('[sound:../bad.mp3]<img src="/root.png">url(#mask)')], []);
});
