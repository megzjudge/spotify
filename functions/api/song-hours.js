export async function onRequest(ctx) {
  const { env } = ctx;

  const exactRaw = await env.SPOTIFY_CACHE.get("songMsExact");
  const exactObj = exactRaw ? JSON.parse(exactRaw) : null;

  // Optional: expose whether a job is running
  const running = (await env.SPOTIFY_CACHE.get("songMsExactRunning")) === "1";

  return new Response(JSON.stringify({
    ok: true,
    exactMs: exactObj?.ms ?? null,
    updatedAt: exactObj?.updatedAt ?? null,
    running
  }), { headers: { "content-type": "application/json" }});
}
