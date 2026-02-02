export async function onRequestGet({ env }) {
  const present = {
    SPOTIFY_PROFILE: !!env.SPOTIFY_PROFILE,
    SPOTIFY_KEY: !!env.SPOTIFY_KEY,
    SPOTIFY_REFRESH_TOKEN: !!env.SPOTIFY_REFRESH_TOKEN,
  };

  return new Response(JSON.stringify({ ok: true, present }, null, 2), {
    headers: { "content-type": "application/json" }
  });
}
