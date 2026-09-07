// Run only against a fresh Chrome profile and a dedicated test origin.
// Usage: npm run test:stats-browser -- <CDP port> <PWA URL>
import assert from "node:assert/strict";

const [port = "9235", origin = "http://127.0.0.1:3015/"] = process.argv.slice(2);
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
    + " const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype"
    + " : input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;"
    + " Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, " + JSON.stringify(value) + ");"
    + " input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); })()");
}

try {
  await until("document.querySelector('.storage-banner')");
  assert.equal(await evaluate("[...document.querySelectorAll('.deck-row')].some((row) => row.textContent.includes('Stats browser test'))"), false,
    "Use a fresh test profile/origin, not an existing collection.");

  await evaluate("document.querySelector('button[aria-label=\"Add deck\"]').click()");
  await until("document.querySelector('#deck-name')");
  await setValue("#deck-name", "Stats browser test");
  await evaluate("document.querySelector('.form-panel').requestSubmit()");
  await until("document.body.innerText.includes('Stats browser test') && document.body.innerText.includes('Study now')");
  await evaluate("document.querySelector('button[aria-label=\"Add card\"]').click()");
  await until("document.querySelector('#note-field-0')");
  await setValue("#note-field-0", "Statistics question");
  await setValue("#note-field-1", "Statistics answer");
  await evaluate("document.querySelector('.form-panel').requestSubmit()");
  await until("document.body.innerText.includes('1 card total')");

  await click("Study now");
  await until("document.querySelector('.study-card-frame')");
  await evaluate("document.querySelector('.study-card-prompt').click()");
  await until("document.querySelector('.answer-btn-label')");
  await evaluate("[...document.querySelectorAll('.answer-btn')].find((button) => button.querySelector('.answer-btn-label').textContent === 'Good').click()");
  await until("document.body.innerText.includes('all caught up')");
  await click("Back to deck");
  await until("document.body.innerText.includes('Study now')");
  await evaluate("document.querySelector('button[aria-label=\"Back\"]').click()");
  await until("document.querySelector('.deck-list')");

  await click("Stats");
  await until("document.querySelector('.stats-summary-grid')");
  const summary = await evaluate("[...document.querySelectorAll('.stats-summary')].map((card) => card.innerText)");
  assert.match(summary.find((text) => text.startsWith("Reviews today")), /1/);
  assert.match(summary.find((text) => text.startsWith("30-day retention")), /100%/);
  assert.match(summary.find((text) => text.startsWith("Current streak")), /1/);
  assert.equal(await evaluate("document.querySelector('.stats-chart-day:last-child .stats-bar-value').textContent"), "1");
  assert.equal(await evaluate("[...document.querySelectorAll('.stats-answer')].find((row) => row.firstElementChild.textContent === 'Good').querySelector('strong').textContent"), "1");
  assert.equal(await evaluate("[...document.querySelectorAll('.stats-card-states > div')].find((row) => row.querySelector('dt').textContent === 'Learning').querySelector('dd').textContent"), "1");

  const deckValue = await evaluate("[...document.querySelector('#stats-deck').options].find((option) => option.textContent === 'Stats browser test').value");
  await setValue("#stats-deck", deckValue);
  await until("document.querySelector('.stats-scope')?.textContent === 'Stats browser test'");
  assert.match(await evaluate("document.body.innerText"), /1 answers/);

  console.log(JSON.stringify({ today: true, retention: true, streak: true, answers: true, cardStates: true, deckFilter: true }));
} finally {
  socket.close();
}
