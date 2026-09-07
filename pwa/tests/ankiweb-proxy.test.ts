import assert from "node:assert/strict";
import test from "node:test";

import { POST } from "../src/app/api/ankiweb/route";

test("AnkiWeb proxy rejects endpoints outside the sync allowlist", async () => {
  const response = await POST(new Request("http://localhost/api/ankiweb?service=sync&method=deleteEverything", {
    method: "POST",
    body: new FormData()
  }));
  assert.equal(response.status, 400);
});

test("AnkiWeb proxy forwards an allowed multipart sync request", async () => {
  const originalFetch = globalThis.fetch;
  let target = "";
  let forwarded: FormData | null = null;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    target = String(input);
    forwarded = init?.body as FormData;
    return new Response(new TextEncoder().encode('{"key":"test-key"}'), { status: 200 });
  }) as typeof fetch;

  try {
    const form = new FormData();
    form.set("c", "0");
    form.set("data", new Blob([JSON.stringify({ u: "user@example.com", p: "secret" })]), "data");
    const response = await POST(new Request("http://localhost/api/ankiweb?service=sync&method=hostKey", {
      method: "POST",
      body: form
    }));

    assert.equal(response.status, 200);
    assert.equal(target, "https://sync.ankiweb.net/sync/hostKey");
    assert.ok(forwarded);
    assert.equal(forwarded.get("c"), "0");
    const data = forwarded.get("data");
    assert.ok(data instanceof Blob);
    assert.deepEqual(JSON.parse(await data.text()), { u: "user@example.com", p: "secret" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
