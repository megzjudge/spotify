export async function onRequestGet({ env }) {
  const present = {
    SPOTIFY_PROFILE: !!env.SPOTIFY_PROFILE,
    SPOTIFY_KEY: !!env.SPOTIFY_KEY,
    SPOTIFY_REFRESH_TOKEN: !!env.SPOTIFY_REFRESH_TOKEN,
  };

  // Safe fingerprint only — never the full secret — so you can confirm the
  // deployed value actually matches what you last saved, without exposing it.
  const rt = env.SPOTIFY_REFRESH_TOKEN || "";
  const fingerprint = rt
    ? { length: rt.length, last6: rt.slice(-6), hasWhitespace: /\s/.test(rt) }
    : null;

  return new Response(JSON.stringify({ ok: true, present, refreshTokenFingerprint: fingerprint }, null, 2), {
    headers: { "content-type": "application/json" }
  });
}
