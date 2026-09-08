// Run only against a fresh Chrome profile and a dedicated test origin.
// Usage: npm run test:notetype-browser -- <CDP port> <PWA URL>
import assert from "node:assert/strict";

const [port = "9237", origin = "http://127.0.0.1:3017/"] = process.argv.slice(2);
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
  const text = JSON.stringify(label);
  await until(`[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === ${text} && !button.disabled)`);
  await evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === ${text} && !button.disabled).click()`);
}
async function setValue(selector, value) {
  await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event('input', { bubbles: true })); })()`);
}

try {
  await until("document.querySelector('.storage-banner')");
  await click("Settings");
  await until("document.querySelector('.settings-page')");
  await click("Open manager");
  await until("document.querySelector('.note-type-manager')");
  await evaluate("window.prompt = () => 'Managed standard'");
  await click("New standard");
  await until("document.querySelector('.note-type-intro h2')?.textContent === 'Managed standard'");
  await click("Add field");
  await until("document.querySelectorAll('.note-type-field-row').length === 3");
  await evaluate("(() => { const input = document.querySelectorAll('.note-type-field-row')[2].querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Extra'); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await click("Add card template");
  await until("document.querySelectorAll('.note-type-template-tabs > div').length === 2");
  await setValue("#template-name", "Extra card");
  await setValue("#template-front", "{{Extra}}");
  await setValue("#template-back", "{{FrontSide}}<hr id=answer>{{Front}}");
  await click("Save note type");
  await until("document.querySelector('.form-success')?.textContent.includes('saved')");
  assert.equal(await evaluate("document.querySelectorAll('.note-type-field-row').length"), 3);
  assert.equal(await evaluate("document.querySelectorAll('.note-type-template-tabs > div').length"), 2);
  assert.equal(await evaluate("document.querySelector('.note-type-preview-frame').getAttribute('sandbox')"), "");

  await evaluate("window.prompt = () => 'Managed clone'");
  await click("Clone");
  await until("document.querySelector('.note-type-intro h2')?.textContent === 'Managed clone'");
  await evaluate("window.confirm = () => true");
  await click("Delete");
  await until("!document.body.innerText.includes('Managed clone')");
  assert.equal(await evaluate("document.body.innerText.includes('Managed standard')"), true);
  console.log(JSON.stringify({ noteTypeCreate: true, fields: true, templates: true, preview: true, clone: true, delete: true }));
} finally {
  socket.close();
}
