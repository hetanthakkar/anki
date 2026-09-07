export const runtime = "nodejs";

const ALLOWED_METHODS: Record<string, Set<string>> = {
  sync: new Set(["hostKey", "upload", "download"]),
  msync: new Set(["begin", "mediaChanges", "uploadChanges", "downloadFiles"])
};

const ANKIWEB_SYNC_ORIGIN = "https://sync.ankiweb.net";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const service = url.searchParams.get("service") ?? "";
  const method = url.searchParams.get("method") ?? "";
  if (!ALLOWED_METHODS[service]?.has(method)) {
    return new Response("Unsupported AnkiWeb sync endpoint", { status: 400 });
  }

  try {
    const incoming = await request.formData();
    const outgoing = new FormData();
    for (const [name, value] of incoming.entries()) {
      if (typeof value === "string") {
        outgoing.append(name, value);
      } else {
        outgoing.append(name, new Blob([await value.arrayBuffer()], { type: value.type || "application/octet-stream" }), value.name || "data");
      }
    }

    const upstream = await fetch(`${ANKIWEB_SYNC_ORIGIN}/${service}/${method}`, {
      method: "POST",
      body: outgoing,
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(120_000)
    });
    const body = await upstream.arrayBuffer();
    const headers = new Headers({ "cache-control": "no-store" });
    const contentType = upstream.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    return new Response(body, { status: upstream.status, headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "AnkiWeb request failed";
    return new Response(message, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
