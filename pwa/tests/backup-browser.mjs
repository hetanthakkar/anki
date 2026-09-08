// Run only against a fresh Chrome profile and a dedicated test origin.
// Usage: npm run test:backup-browser -- <CDP port> <PWA URL>
import assert from "node:assert/strict";
import { unzipSync } from "fflate";

const [port = "9233", origin = "http://127.0.0.1:3002/"] = process.argv.slice(2);
const targets = await (await fetch("http://127.0.0.1:" + port + "/json")).json();
const target = targets.find((candidate) => candidate.type === "page" && candidate.url === origin);
assert.ok(target, "Open " + origin + " in a fresh Chrome profile with --remote-debugging-port=" + port);
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let id = 0;
const pending = new Map();
socket.onmessage = (event) => {
  const response = JSON.parse(event.data);
  const handler = pending.get(response.id);
  if (handler) { pending.delete(response.id); handler(response); }
};
function command(method, params = {}) {
  const requestId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(requestId, (reply) => reply.error ? reject(new Error(JSON.stringify(reply.error))) : resolve(reply.result));
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
}
async function evaluate(expression) {
  const reply = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails));
  return reply.result?.value;
}
async function until(expression) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await evaluate("Boolean(" + expression + ")")) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out: " + expression + "\n" + await evaluate("document.body.innerText"));
}
async function click(label) {
  const encoded = JSON.stringify(label);
  await until("[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === " + encoded + " && !button.disabled)");
  await evaluate("[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === " + encoded + " && !button.disabled).click()");
}
async function setValue(selector, value) {
  await evaluate("(() => { const input = document.querySelector(" + JSON.stringify(selector) + ");"
    + " const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;"
    + " Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, " + JSON.stringify(value) + ");"
    + " input.dispatchEvent(new Event('input', { bubbles: true })); })()");
}

try {
  await until("document.querySelector('.storage-banner')");
  assert.equal(await evaluate("[...document.querySelectorAll('.deck-row')].some((row) => row.textContent.includes('Backup browser test'))"), false,
    "Use a fresh test profile/origin, not an existing collection.");

  await evaluate("document.querySelector('button[aria-label=\"Add deck\"]').click()");
  await until("document.querySelector('#deck-name')");
  await setValue("#deck-name", "Backup browser test");
  await evaluate("document.querySelector('.form-panel').requestSubmit()");
  await until("document.body.innerText.includes('Backup browser test') && document.body.innerText.includes('Study now')");
  await evaluate("document.querySelector('button[aria-label=\"Add card\"]').click()");
  await until("document.querySelector('#note-field-0')");
  await setValue("#note-field-0", "Saved question");
  await setValue("#note-field-1", "Saved answer");
  await evaluate("document.querySelector('.form-panel').requestSubmit()");
  await until("document.body.innerText.includes('1 card total')");

  await evaluate("document.querySelector('button[aria-label=\"Back\"]').click()");
  await until("document.querySelector('.deck-list')");
  await evaluate("(() => { window.__ankiBackup = null; const original = HTMLAnchorElement.prototype.click;"
    + " HTMLAnchorElement.prototype.click = function() { if (!this.download.endsWith('.colpkg')) return original.call(this);"
    + " const filename = this.download; fetch(this.href).then((response) => Promise.all([response.arrayBuffer(), response.headers.get('content-type')]))"
    + " .then(([buffer, type]) => { window.__ankiBackup = { filename, type, bytes: [...new Uint8Array(buffer)] }; })"
    + " .catch((error) => { window.__ankiBackup = { error: String(error) }; }); }; })()");
  await click("Settings");
  await until("document.body.innerText.includes('Collection backup')");
  await click("Download backup");
  await until("window.__ankiBackup && document.body.innerText.includes('Backup downloaded')");

  const download = await evaluate("window.__ankiBackup");
  assert.equal(download.error, undefined);
  assert.match(download.filename, /^anki-pwa-backup-.*\.colpkg$/);
  assert.match(download.type, /application\/x-colpkg/);
  const archive = unzipSync(Uint8Array.from(download.bytes));
  assert.equal(new TextDecoder().decode(archive["collection.anki2"].subarray(0, 16)), "SQLite format 3\0");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(archive.media)), {});
  assert.match(await evaluate("document.body.innerText"), /1 notes .* 1 cards/);

  console.log(JSON.stringify({ settings: true, downloaded: true, collection: true, scheduling: true, mediaManifest: true }));
} finally {
  socket.close();
}
