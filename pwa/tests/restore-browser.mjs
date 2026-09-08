// Run against a fresh Chrome profile and a dedicated PWA origin.
// Usage: npm run test:restore-browser -- <CDP port> <PWA URL>
import assert from "node:assert/strict";

const [port = "9250", origin = "http://127.0.0.1:3030/"] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const target = targets.find((candidate) => candidate.type === "page" && candidate.url === origin);
assert.ok(target, `Open ${origin} in a fresh Chrome profile with --remote-debugging-port=${port}`);
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
    if (await evaluate(`Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${expression}\n${await evaluate("document.body.innerText")}`);
}
async function click(label) {
  const encoded = JSON.stringify(label);
  await until(`[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === ${encoded} && !button.disabled)`);
  await evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === ${encoded} && !button.disabled).click()`);
}
async function setValue(selector, value) {
  await evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
}

try {
  await until("document.querySelector('.storage-banner')");
  await evaluate("document.querySelector('button[aria-label=\"Add deck\"]').click()");
  await until("document.querySelector('#deck-name')");
  await setValue("#deck-name", "Restored deck");
  await evaluate("document.querySelector('.form-panel').requestSubmit()");
  await until("document.body.innerText.includes('Restored deck')");
  await evaluate("document.querySelector('button[aria-label=\"Back\"]').click()");
  await until("document.querySelector('.deck-list')");

  await evaluate(`(() => { window.__restoreBackup = null; const original = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function() { if (!this.download.endsWith('.colpkg')) return original.call(this); fetch(this.href).then((response) => response.arrayBuffer()).then((buffer) => { window.__restoreBackup = [...new Uint8Array(buffer)]; }); }; })()`);
  await click("Settings");
  await until("document.body.innerText.includes('Restore full backup')");
  await click("Download full backup (.colpkg)");
  await until("window.__restoreBackup && document.body.innerText.includes('Backup downloaded')");
  await click("Decks");
  await evaluate("document.querySelector('button[aria-label=\"Add deck\"]').click()");
  await until("document.querySelector('#deck-name')");
  await setValue("#deck-name", "Temporary deck");
  await evaluate("document.querySelector('.form-panel').requestSubmit()");
  await until("document.body.innerText.includes('Temporary deck')");
  await evaluate("document.querySelector('button[aria-label=\"Back\"]').click()");
  await click("Settings");
  await until("document.querySelector('#colpkg-file')");
  await evaluate(`(() => { const file = new File([Uint8Array.from(window.__restoreBackup)], 'restore.colpkg', { type: 'application/x-colpkg' }); const transfer = new DataTransfer(); transfer.items.add(file); const input = document.querySelector('#colpkg-file'); Object.defineProperty(input, 'files', { value: transfer.files }); input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await evaluate("document.querySelector('#restore-confirmed').click()");
  await click("Restore collection");
  await until("document.body.innerText.includes('Restored 0 notes')");
  await click("Decks");
  await until("document.querySelector('.deck-list')");
  const body = await evaluate("document.body.innerText");
  assert.match(body, /Restored deck/);
  assert.doesNotMatch(body, /Temporary deck/);
  console.log(JSON.stringify({ backup: true, restore: true, replacement: true, mediaManager: true }));
} finally {
  socket.close();
}
