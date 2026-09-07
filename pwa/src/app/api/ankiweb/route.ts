import { gzipSync } from "node:zlib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ENDPOINT = "https://sync.ankiweb.net";
const MAX_REQUEST_BYTES = 512 * 1024 * 1024;

const METHODS: Record<string, Set<string>> = {
  sync: new Set(["hostKey", "upload", "download"]),
  msync: new Set(["begin", "mediaChanges", "uploadChanges", "downloadFiles", "mediaSanity"])
};

function header(request: Request, name: string) {
  return request.headers.get(name)?.trim() ?? "";
}

export async function POST(request: Request) {
  const scope = header(request, "x-anki-scope");
  const method = header(request, "x-anki-method");
  const hostKey = header(request, "x-anki-host-key");
  const sessionKey = header(request, "x-anki-session-key") || crypto.randomUUID().replaceAll("-", "").slice(0, 16);

  if (!METHODS[scope]?.has(method)) {
    return new Response("Unsupported AnkiWeb sync endpoint", { status: 400 });
  }

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_REQUEST_BYTES) {
    return new Response("Sync payload is too large", { status: 413 });
  }

  try {
    // The PWA stores Anki's schema-11 database, so use sync protocol v10.
    // v10 is the official multipart+gzip transport for schema 11; using it
    // avoids converting the collection to schema 18 or shipping zstd code to
    // this route.
    const compressed = Uint8Array.from(gzipSync(body));
    const form = new FormData();
    form.set("c", "1");
    if (hostKey) form.set("k", hostKey);
    form.set("s", sessionKey);
    form.set("data", new Blob([compressed], { type: "application/octet-stream" }), "data");

    const upstream = await fetch(`${ENDPOINT}/${scope}/${method}`, {
      method: "POST",
      body: form,
      redirect: "follow",
      cache: "no-store"
    });
    const responseBody = await upstream.arrayBuffer();

    return new Response(responseBody, {
      status: upstream.status,
      headers: {
        "cache-control": "no-store",
        "content-type": upstream.headers.get("content-type") ?? "application/octet-stream"
      }
    });
  } catch (error) {
    console.error("[ankiweb] sync proxy failed", error);
    return new Response("Could not reach AnkiWeb", { status: 502 });
  }
}
