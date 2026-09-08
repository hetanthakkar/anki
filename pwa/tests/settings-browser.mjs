// Run only against a fresh Chrome profile and a dedicated test origin.
// Usage: npm run test:settings-browser -- <CDP port> <PWA URL>
import assert from "node:assert/strict";

const [port = "9237", origin = "http://127.0.0.1:3017/"] = process.argv.slice(2);
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
    + " if (input.isContentEditable) { input.focus(); input.textContent = " + JSON.stringify(value) + ";"
    + " input.dispatchEvent(new InputEvent('input', { bubbles: true })); return; }"
    + " const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;"
    + " Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, " + JSON.stringify(value) + ");"
    + " input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); })()");
}
async function toggle(label) {
  await evaluate("[...document.querySelectorAll('.preference-toggle')].find((row) => row.querySelector('strong').textContent === "
    + JSON.stringify(label) + ").click()");
}

try {
  await until("document.querySelector('.storage-banner')");
  await click("Settings");
  await until("document.querySelector('.settings-page')");
  assert.match(await evaluate("document.body.innerText"), /Appearance.*Review.*Audio.*Collection/s);

  await setValue("#theme-preference", "dark");
  await setValue("#density-preference", "compact");
  await toggle("Reduce motion");
  await toggle("Show session progress");
  await toggle("Show next review times");
  await until("document.documentElement.dataset.theme === 'dark' && document.documentElement.dataset.density === 'compact' && document.documentElement.dataset.reduceMotion === 'true'");
  let stored = await evaluate("JSON.parse(localStorage.getItem('anki-pwa.preferences.v1'))");
  assert.equal(stored.theme, "dark");
  assert.equal(stored.density, "compact");
  assert.equal(stored.reduceMotion, true);
  assert.equal(stored.showReviewProgress, false);
  assert.equal(stored.showAnswerTimes, false);

  await command("Page.reload", { ignoreCache: true });
  await until("document.querySelector('.storage-banner') && document.documentElement.dataset.theme === 'dark'");
  assert.equal(await evaluate("document.documentElement.dataset.density"), "compact");
  assert.equal(await evaluate("document.documentElement.dataset.reduceMotion"), "true");
  await click("Settings");
  await until("document.querySelector('#theme-preference').value === 'dark'");
  assert.equal(await evaluate("document.querySelector('#density-preference').value"), "compact");
  assert.equal(await evaluate("[...document.querySelectorAll('.preference-toggle')].find((row) => row.querySelector('strong').textContent === 'Show session progress').querySelector('input').checked"), false);

  await click("Decks");
  await evaluate("document.querySelector('button[aria-label=\"Add deck\"]').click()");
  await until("document.querySelector('#deck-name')");
  await setValue("#deck-name", "Settings browser test");
  await evaluate("document.querySelector('.form-panel').requestSubmit()");
  await until("document.body.innerText.includes('Settings browser test') && document.body.innerText.includes('Study now')");
  await evaluate("document.querySelector('button[aria-label=\"Add card\"]').click()");
  await until("document.querySelector('#note-field-0')");
  await setValue("#note-field-0", "Keyboard question");
  await setValue("#note-field-1", "Keyboard answer");
  await evaluate("document.querySelector('.form-panel').requestSubmit()");
  await until("document.body.innerText.includes('1 card total')");
  await click("Study now");
  await until("document.querySelector('.study-card-frame')");
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }))");
  await until("document.querySelector('.study-card--flipped') && document.querySelector('.answer-buttons')");
  assert.equal(await evaluate("document.querySelector('.answer-btn-interval')"), null);
  assert.equal(await evaluate("document.querySelector('.review-stats-panel')"), null);
  assert.equal(await evaluate("document.querySelectorAll('.review-session-heading > span').length"), 1);
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: '3', code: 'Digit3' }))");
  await until("document.body.innerText.includes('all caught up')");
  await click("Back to deck");
  await evaluate("document.querySelector('button[aria-label=\"Back\"]').click()");
  await until("document.querySelector('.deck-list')");
  await click("Settings");
  await until("document.querySelector('.settings-page')");

  await click("Restore defaults");
  await until("document.documentElement.dataset.themePreference === 'system' && document.documentElement.dataset.density === 'comfortable'");
  stored = await evaluate("JSON.parse(localStorage.getItem('anki-pwa.preferences.v1'))");
  assert.equal(stored.showReviewProgress, true);
  assert.equal(stored.showAnswerTimes, true);
  assert.equal(stored.keyboardShortcuts, true);

  console.log(JSON.stringify({ settings: true, persistence: true, theme: true, density: true, motion: true,
    reviewVisibility: true, keyboardReview: true, reset: true }));
} finally {
  socket.close();
}
