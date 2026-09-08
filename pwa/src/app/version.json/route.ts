export const dynamic = "force-dynamic";
export const revalidate = 0;

// Deliberately dynamic and no-store: an installed PWA can compare this server
// build ID with the one embedded in its running bundle to recover from a stale
// service-worker shell after a deployment.
export function GET() {
  return Response.json(
    { id: process.env.NEXT_PUBLIC_APP_BUILD_ID ?? "development" },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
