// Run only against a fresh Chrome profile and a dedicated test origin.
// Usage: npm run test:deck-options-browser -- <CDP port> <PWA URL>
import assert from "node:assert/strict";

const [port = "9236", origin = "http://127.0.0.1:3016/"] = process.argv.slice(2);
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
async function addCard(front, back) {
  await evaluate("document.querySelector('button[aria-label=\"Add card\"]').click()");
  await until("document.querySelector('#note-field-0')");
  await setValue("#note-field-0", front);
  await setValue("#note-field-1", back);
  await evaluate("document.querySelector('.form-panel').requestSubmit()");
  await until("document.querySelector('.deck-overview')");
}

try {
  await until("document.querySelector('.storage-banner')");
  assert.equal(await evaluate("[...document.querySelectorAll('.deck-row')].some((row) => row.textContent.includes('Options browser test'))"), false,
    "Use a fresh test profile/origin, not an existing collection.");

  await evaluate("document.querySelector('button[aria-label=\"Add deck\"]').click()");
  await until("document.querySelector('#deck-name')");
  await setValue("#deck-name", "Options browser test");
  await evaluate("document.querySelector('.form-panel').requestSubmit()");
  await until("document.querySelector('.deck-overview')");
  await addCard("Options question one", "Options answer one");
  await addCard("Options question two", "Options answer two");
  await until("document.body.innerText.includes('2 cards total')");

  await click("Options");
  await until("document.querySelector('#new-cards-per-day')");
  assert.equal(await evaluate("document.querySelector('#new-cards-per-day').value"), "20");
  assert.equal(await evaluate("document.querySelector('#reviews-per-day').value"), "200");
  assert.equal(await evaluate("document.querySelector('#desired-retention').value"), "90");
  assert.equal(await evaluate("document.querySelector('#learning-steps').value"), "1 10");

  await setValue("#new-cards-per-day", "1");
  await setValue("#reviews-per-day", "25");
  await setValue("#desired-retention", "95");
  await setValue("#maximum-interval", "30");
  await setValue("#learning-steps", "2 20");
  await setValue("#relearning-steps", "15");
  await click("Save options");
  await until("document.querySelector('.form-success')?.textContent.includes('saved')");
  assert.equal(await evaluate("document.querySelector('.options-badge').textContent.trim()"), "Custom");

  await evaluate("document.querySelector('button[aria-label=\"Back\"]').click()");
  await until("document.querySelector('.deck-overview')");
  assert.equal(await evaluate("document.querySelector('.count-grid > div:first-child strong').textContent"), "1");

  await click("Study now");
  await until("document.querySelector('.study-card-frame')");
  await evaluate("document.querySelector('.study-card-prompt').click()");
  await until("document.querySelector('.study-card--flipped')");
  await until("document.querySelector('.answer-btn-label')");
  assert.equal(await evaluate("[...document.querySelectorAll('.answer-btn')].find((button) => button.querySelector('.answer-btn-label').textContent === 'Good').querySelector('.answer-btn-interval').textContent"), "20m");
  await evaluate("[...document.querySelectorAll('.answer-btn')].find((button) => button.querySelector('.answer-btn-label').textContent === 'Good').click()");
  await until("document.body.innerText.includes('all caught up')");

  await click("Back to deck");
  await until("document.querySelector('.deck-overview')");
  await click("Options");
  await until("document.querySelector('#new-cards-per-day')");
  assert.equal(await evaluate("document.querySelector('#new-cards-per-day').value"), "1");
  assert.equal(await evaluate("document.querySelector('#reviews-per-day').value"), "25");
  assert.equal(await evaluate("document.querySelector('#desired-retention').value"), "95");
  assert.equal(await evaluate("document.querySelector('#maximum-interval').value"), "30");
  assert.equal(await evaluate("document.querySelector('#learning-steps').value"), "2 20");
  assert.equal(await evaluate("document.querySelector('#relearning-steps').value"), "15");

  await click("Restore defaults");
  await until("document.querySelector('.form-success')?.textContent.includes('restored')");
  assert.equal(await evaluate("document.querySelector('.options-badge').textContent.trim()"), "Default");
  assert.equal(await evaluate("document.querySelector('#new-cards-per-day').value"), "20");

  await evaluate("document.querySelector('button[aria-label=\"Back\"]').click()");
  await until("document.querySelector('.deck-overview')");
  assert.equal(await evaluate("document.querySelector('.count-grid > div:first-child strong').textContent"), "1");

  console.log(JSON.stringify({
    persisted: true,
    dailyLimit: true,
    learningSteps: true,
    retention: true,
    maximumInterval: true,
    reset: true
  }));
} finally {
  socket.close();
}

