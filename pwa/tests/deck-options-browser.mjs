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
    + " if (input.isContentEditable) { input.focus(); input.textContent = " + JSON.stringify(value) + ";"
    + " input.dispatchEvent(new InputEvent('input', { bubbles: true })); return; }"
    + " const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;"
    + " Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, " + JSON.stringify(value) + ");"
    + " input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); })()");
}
async function openDeckAction(name, action) {
  await until("[...document.querySelectorAll('.deck-row .deck-name')].some((label) => label.textContent.trim() === " + JSON.stringify(name) + ")");
  await evaluate("(() => { const row = [...document.querySelectorAll('.deck-row')].find((item) => item.querySelector('.deck-name').textContent.trim() === "
    + JSON.stringify(name) + "); row.querySelector('.deck-row-actions summary').click(); })()");
  await until("[...document.querySelectorAll('.deck-row-menu button')].some((button) => button.textContent.trim() === " + JSON.stringify(action) + ")");
  await evaluate("[...document.querySelectorAll('.deck-row-menu button')].find((button) => button.textContent.trim() === "
    + JSON.stringify(action) + ").click()");
}
async function addCard(deckName, front, back) {
  await openDeckAction(deckName, "Add card");
  await until("document.querySelector('#note-field-0')");
  await setValue("#note-field-0", front);
  await setValue("#note-field-1", back);
  await evaluate("document.querySelector('.form-panel').requestSubmit()");
  await until("document.querySelector('.deck-list')");
}
async function toggleOption(label) {
  await evaluate("[...document.querySelectorAll('.deck-option-toggles label')].find((row) => row.querySelector('strong').textContent === "
    + JSON.stringify(label) + ").click()");
}
async function studyDeck(name) {
  await until("[...document.querySelectorAll('.deck-row .deck-name')].some((label) => label.textContent.trim() === " + JSON.stringify(name) + ")");
  await evaluate("[...document.querySelectorAll('.deck-row')].find((row) => row.querySelector('.deck-name').textContent.trim() === "
    + JSON.stringify(name) + ").querySelector('.deck-study-button').click()");
  await until("document.querySelector('.study-card-frame') || document.querySelector('.congratulations')");
}

try {
  await until("document.querySelector('.storage-banner')");
  assert.equal(await evaluate("[...document.querySelectorAll('.deck-row')].some((row) => row.textContent.includes('Options browser test'))"), false,
    "Use a fresh test profile/origin, not an existing collection.");

  await evaluate("document.querySelector('button[aria-label=\"Add deck\"]').click()");
  await until("document.querySelector('#deck-name')");
  await setValue("#deck-name", "Options browser test");
  await evaluate("document.querySelector('.form-panel').requestSubmit()");
  await until("document.querySelector('.deck-list')");
  await addCard("Options browser test", "Options question one", "Options answer one");
  await addCard("Options browser test", "Options question two", "Options answer two");
  await until("document.body.innerText.includes('Options browser test')");

  await openDeckAction("Options browser test", "Manage");
  await until("document.querySelector('#subdeck-name')");
  await setValue("#subdeck-name", "Child");
  await click("Create subdeck");
  await until("document.querySelector('.deck-list')");

  await openDeckAction("Options browser test", "Options");
  await until("document.querySelector('#new-cards-per-day')");
  assert.equal(await evaluate("document.querySelector('#new-cards-per-day').value"), "20");
  assert.equal(await evaluate("document.querySelector('#reviews-per-day').value"), "200");
  assert.equal(await evaluate("document.querySelector('#desired-retention').value"), "90");
  assert.equal(await evaluate("document.querySelector('#learning-steps').value"), "1 10");
  assert.equal(await evaluate("document.querySelector('#new-gather-order').value"), "deck");
  assert.equal(await evaluate("document.querySelector('#review-order').value"), "due");
  assert.equal(await evaluate("document.querySelector('#leech-threshold').value"), "8");

  await setValue("#new-cards-per-day", "1");
  await setValue("#reviews-per-day", "25");
  await setValue("#desired-retention", "95");
  await setValue("#maximum-interval", "30");
  await setValue("#learning-steps", "2 20");
  await setValue("#relearning-steps", "15");
  await setValue("#new-gather-order", "descending");
  await setValue("#new-sort-order", "gather");
  await setValue("#new-insert-order", "random");
  await setValue("#new-review-order", "before");
  await setValue("#interday-review-order", "after");
  await setValue("#review-order", "intervalDescending");
  await setValue("#minimum-lapse-interval", "3");
  await setValue("#leech-threshold", "4");
  await setValue("#leech-action", "suspend");
  await setValue("#maximum-answer-seconds", "45");
  await setValue("#question-seconds", "0.2");
  await setValue("#question-time-action", "reminder");
  await setValue("#answer-seconds", "0.2");
  await setValue("#answer-time-action", "reminder");
  await toggleOption("New cards ignore review limit");
  await toggleOption("Limits start from top");
  await toggleOption("Bury new siblings");
  await toggleOption("Show on-screen timer");
  await click("Save options");
  await until("document.querySelector('.form-success')?.textContent.includes('saved')");
  assert.equal(await evaluate("document.querySelector('.options-badge').textContent.trim()"), "Custom");

  await evaluate("window.prompt = () => 'Reusable preset'");
  await click("Add");
  await until("document.querySelector('.form-success')?.textContent.includes('Created')");
  assert.equal(await evaluate("document.querySelector('.deck-options-intro h2').textContent"), "Reusable preset");
  await evaluate("window.prompt = () => 'Renamed preset'");
  await click("Rename");
  await until("document.querySelector('.form-success')?.textContent.includes('renamed')");
  assert.equal(await evaluate("document.querySelector('.deck-options-intro h2').textContent"), "Renamed preset");
  await click("Apply to subdecks");
  await until("document.querySelector('.form-success')?.textContent.includes('subdecks')");
  await evaluate("(() => { const select = document.querySelector('#deck-preset'); const option = [...select.options].find((item) => item.textContent.startsWith('Options browser test options '));"
    + " Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, option.value); select.dispatchEvent(new Event('change', { bubbles: true })); window.confirm = () => true; })()");
  await click("Delete");
  await until("document.querySelector('.form-success')?.textContent.includes('deleted')");

  await evaluate("document.querySelector('button[aria-label=\"Back\"]').click()");
  await until("document.querySelector('.deck-list')");
  await openDeckAction("↳ Child", "Options");
  await until("document.querySelector('.deck-options-intro h2')");
  assert.equal(await evaluate("document.querySelector('.deck-options-intro h2').textContent"), "Renamed preset");
  await evaluate("document.querySelector('button[aria-label=\"Back\"]').click()");
  await until("document.querySelector('.deck-list')");

  await studyDeck("Options browser test");
  assert.equal(await evaluate("document.querySelector('.study-card-frame').getAttribute('srcdoc').includes('Options question two')"), true);
  assert.ok(await evaluate("document.querySelector('.review-answer-timer').textContent"));
  await until("document.querySelector('.review-notice')?.textContent.includes('Auto advance reminder')");
  await evaluate("document.querySelector('.study-card-prompt').click()");
  await until("document.querySelector('.study-card--flipped')");
  await until("document.querySelector('.answer-btn-label')");
  assert.equal(await evaluate("[...document.querySelectorAll('.answer-btn')].find((button) => button.querySelector('.answer-btn-label').textContent === 'Good').querySelector('.answer-btn-interval').textContent"), "20m");
  await evaluate("[...document.querySelectorAll('.answer-btn')].find((button) => button.querySelector('.answer-btn-label').textContent === 'Good').click()");
  await until("document.body.innerText.includes('all caught up')");

  await click("Back to decks");
  await until("document.querySelector('.deck-list')");
  await openDeckAction("Options browser test", "Options");
  await until("document.querySelector('#new-cards-per-day')");
  assert.equal(await evaluate("document.querySelector('#new-cards-per-day').value"), "1");
  assert.equal(await evaluate("document.querySelector('#reviews-per-day').value"), "25");
  assert.equal(await evaluate("document.querySelector('#desired-retention').value"), "95");
  assert.equal(await evaluate("document.querySelector('#maximum-interval').value"), "30");
  assert.equal(await evaluate("document.querySelector('#learning-steps').value"), "2 20");
  assert.equal(await evaluate("document.querySelector('#relearning-steps').value"), "15");
  assert.equal(await evaluate("document.querySelector('#new-gather-order').value"), "descending");
  assert.equal(await evaluate("document.querySelector('#new-sort-order').value"), "gather");
  assert.equal(await evaluate("document.querySelector('#new-insert-order').value"), "random");
  assert.equal(await evaluate("document.querySelector('#new-review-order').value"), "before");
  assert.equal(await evaluate("document.querySelector('#interday-review-order').value"), "after");
  assert.equal(await evaluate("document.querySelector('#review-order').value"), "intervalDescending");
  assert.equal(await evaluate("document.querySelector('#minimum-lapse-interval').value"), "3");
  assert.equal(await evaluate("document.querySelector('#leech-threshold').value"), "4");
  assert.equal(await evaluate("document.querySelector('#leech-action').value"), "suspend");
  assert.equal(await evaluate("document.querySelector('#maximum-answer-seconds').value"), "45");
  assert.equal(await evaluate("document.querySelector('#question-seconds').value"), "0.2");
  assert.equal(await evaluate("document.querySelector('#question-time-action').value"), "reminder");
  assert.equal(await evaluate("document.querySelector('#answer-seconds').value"), "0.2");
  assert.equal(await evaluate("document.querySelector('#answer-time-action').value"), "reminder");
  assert.equal(await evaluate("[...document.querySelectorAll('.deck-option-toggles label')].find((row) => row.querySelector('strong').textContent === 'New cards ignore review limit').querySelector('input').checked"), true);
  assert.equal(await evaluate("[...document.querySelectorAll('.deck-option-toggles label')].find((row) => row.querySelector('strong').textContent === 'Limits start from top').querySelector('input').checked"), true);
  assert.equal(await evaluate("[...document.querySelectorAll('.deck-option-toggles label')].find((row) => row.querySelector('strong').textContent === 'Bury new siblings').querySelector('input').checked"), true);

  await click("Restore defaults");
  await until("document.querySelector('.form-success')?.textContent.includes('restored')");
  assert.equal(await evaluate("document.querySelector('.options-badge').textContent.trim()"), "Default");
  assert.equal(await evaluate("document.querySelector('#new-cards-per-day').value"), "20");

  await evaluate("document.querySelector('button[aria-label=\"Back\"]').click()");
  await until("document.querySelector('.deck-list')");
  assert.equal(await evaluate("[...document.querySelectorAll('.deck-row')].some((row) => row.textContent.includes('Options browser test'))"), true);

  console.log(JSON.stringify({
    persisted: true,
    dailyLimit: true,
    learningSteps: true,
    retention: true,
    maximumInterval: true,
    displayOrder: true,
    burying: true,
    lapsesAndLeeches: true,
    timer: true,
    autoAdvance: true,
    fsrsParameters: true,
    presetManagement: true,
    recursivePresetApplication: true,
    reset: true
  }));
} finally {
  socket.close();
}
