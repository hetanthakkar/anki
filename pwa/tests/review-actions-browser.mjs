// Run only against a fresh Chrome profile and a dedicated test origin.
// Usage: npm run test:review-actions-browser -- <CDP port> <PWA URL>
import assert from "node:assert/strict";

const [port = "9244", origin = "http://127.0.0.1:3024/"] = process.argv.slice(2);
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
async function key(key, options = {}) {
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', " + JSON.stringify({ key, ...options }) + "))");
}
async function addBasic(front, back) {
  await evaluate("document.querySelector('button[aria-label=\"Add card\"]').click()");
  await until("document.querySelector('#note-field-0')");
  await setValue("#note-field-0", front);
  await setValue("#note-field-1", back);
  await evaluate("document.querySelector('.form-panel').requestSubmit()");
  await until("document.body.innerText.includes('Study now')");
}

try {
  await until("document.querySelector('.storage-banner')");
  await evaluate("document.querySelector('button[aria-label=\"Add deck\"]').click()");
  await until("document.querySelector('#deck-name')");
  await setValue("#deck-name", "Review actions test");
  await evaluate("document.querySelector('.form-panel').requestSubmit()");
  await until("document.body.innerText.includes('Review actions test') && document.body.innerText.includes('Study now')");
  await addBasic("First question", "First answer");
  await addBasic("Second question", "Second answer");
  await addBasic("Third question", "Third answer");
  await addBasic("Fourth question", "Fourth answer");
  await addBasic("Fifth question", "Fifth answer");
  await addBasic("Sixth question", "Sixth answer");

  await click("Study now");
  await until("document.querySelector('.review-toolbar') && document.querySelector('.study-card-frame')");
  assert.match(await evaluate("document.querySelector('.review-toolbar').innerText"), /Undo.*Replay.*Edit.*More/s);

  await key("1", { ctrlKey: true });
  await until("[...document.querySelectorAll('.review-toolbar button')].some((button) => button.textContent.includes('More') && button.disabled)");
  await until("[...document.querySelectorAll('.review-toolbar button')].some((button) => button.textContent.includes('More') && !button.disabled)");
  await key("m");
  await until("[...document.querySelectorAll('.review-toolbar button')].some((button) => button.textContent.includes('More') && button.disabled)");
  await until("[...document.querySelectorAll('.review-toolbar button')].some((button) => button.textContent.includes('More') && !button.disabled)");
  await evaluate("[...document.querySelectorAll('.review-toolbar button')].find((button) => button.textContent.includes('More')).click()");
  await until("document.querySelector('.review-dialog--more')");
  assert.match(await evaluate("document.querySelector('.review-dialog').innerText"), /Red.*Unmark note.*Bury card.*Suspend note.*Set due date.*Card info/s);
  assert.equal(await evaluate("document.querySelector('.review-flags button[aria-label=\"Red\"]').getAttribute('aria-pressed')"), "true");
  await key("Escape");
  await until("!document.querySelector('.review-dialog')");

  await key("e");
  await until("document.querySelector('.review-dialog--edit')");
  await setValue("#review-field-0", "First question edited");
  await setValue("#review-tags", "marked edited-in-review");
  await evaluate("document.querySelector('.review-edit-form').requestSubmit()");
  await until("!document.querySelector('.review-dialog') && document.querySelector('.study-card-frame').getAttribute('srcdoc').includes('First question edited')");

  await key("i");
  await until("document.querySelector('.review-dialog--info')");
  assert.match(await evaluate("document.querySelector('.review-card-info').innerText"), /Review actions test.*Basic.*Card 1.*Card ID.*edited-in-review/is);
  await key("Escape");

  await key(" ");
  await until("document.querySelector('.study-card--flipped')");
  await key("3");
  await until("document.querySelector('.study-card-frame').getAttribute('srcdoc').includes('Second question') && !document.querySelector('.study-card--flipped')");
  await until("[...document.querySelectorAll('.review-toolbar button')].some((button) => button.textContent.includes('Undo') && !button.disabled)");
  await key("z");
  await until("document.querySelector('.study-card-frame').getAttribute('srcdoc').includes('First question edited')");
  assert.match(await evaluate("document.querySelector('.review-session-heading').innerText"), /^Take a moment to recall\s+0 reviews completed$/);

  await key("-");
  await until("document.querySelector('.study-card-frame').getAttribute('srcdoc').includes('Second question')");
  await key("@");
  await until("document.querySelector('.study-card-frame').getAttribute('srcdoc').includes('Third question')");
  await key("d");
  await until("document.querySelector('.review-dialog--due')");
  await setValue("#review-due-days", "2");
  await evaluate("document.querySelector('.review-due-form').requestSubmit()");
  await until("document.querySelector('.study-card-frame').getAttribute('srcdoc').includes('Fourth question')");
  await key("=");
  await until("document.querySelector('.study-card-frame').getAttribute('srcdoc').includes('Fifth question')");
  await key("!");
  await until("document.querySelector('.study-card-frame')?.getAttribute('srcdoc').includes('Sixth question')");
  await key(" ");
  await until("document.querySelector('.study-card--flipped')");
  await key("3");
  await until("document.body.innerText.includes('all caught up') && document.body.innerText.includes('Undo last review')");
  await key("z");
  await until("document.querySelector('.study-card-frame')?.getAttribute('srcdoc').includes('Sixth question')");
  await evaluate("window.confirm = () => true");
  await evaluate("[...document.querySelectorAll('.review-toolbar button')].find((button) => button.textContent.includes('More')).click()");
  await until("document.querySelector('.review-dialog--more')");
  await evaluate("[...document.querySelectorAll('.review-action-grid button')].find((button) => button.textContent.includes('Reset card')).click()");
  await until("!document.querySelector('.review-dialog') && [...document.querySelectorAll('.review-toolbar button')].some((button) => button.textContent.includes('More') && !button.disabled)");
  await evaluate("[...document.querySelectorAll('.review-toolbar button')].find((button) => button.textContent.includes('More')).click()");
  await until("document.querySelector('.review-dialog--more')");
  await evaluate("[...document.querySelectorAll('.review-action-grid button')].find((button) => button.textContent.includes('Delete note')).click()");
  await until("document.body.innerText.includes('all caught up')");

  console.log(JSON.stringify({ toolbar: true, flags: true, marked: true, edit: true, info: true, answerKeys: true,
    undo: true, buryCard: true, suspendCard: true, dueDate: true, buryNote: true, suspendNote: true,
    reset: true, deleteNote: true, escape: true }));
} finally {
  socket.close();
}
