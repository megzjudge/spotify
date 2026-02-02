function html(msg) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><pre style="white-space:pre-wrap;font:14px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace">${msg}</pre>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

function b64(str) {
  // Pages/Workers runtime has btoa; this handles UTF-8 safely
  return btoa(unescape(encodeURIComponent(str)));
}

export async function onRequestGet({ env, request }) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) return html(`Spotify returned error: ${error}`);
  if (!code) return html("No code provided.");

  const clientId = env.SPOTIFY_PROFILE; // client_id
  const clientSecret = env.SPOTIFY_KEY; // client_secret

  if (!clientId || !clientSecret) {
    return html("Missing SPOTIFY_PROFILE or SPOTIFY_KEY in Cloudflare Pages environment variables.");
  }

  // Must EXACTLY match what you used in /api/auth/start and Spotify Dashboard redirect allowlist
  const REDIRECT_URI = "https://spotify.jdge.cc/api/auth/callback";

  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "authorization": `Basic ${b64(`${clientId}:${clientSecret}`)}`
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI
    })
  });

  const text = await tokenRes.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}

  if (!tokenRes.ok) {
    return html(`Token exchange failed (${tokenRes.status})\n\n${text}`);
  }

  const refreshToken = json && json.refresh_token;
  if (!refreshToken) {
    return html(
      "Success, but no refresh_token returned.\n\n" +
      "If you've previously authorized this app, Spotify sometimes won't re-issue a refresh token.\n" +
      "Fix: revoke the app in your Spotify account (Account → Apps) and run /api/auth/start again.\n\n" +
      text
    );
  }

  return html(
    "✅ Refresh token minted.\n\n" +
    "Save this in Cloudflare Pages → Environment Variables (Secrets):\n\n" +
    "SPOTIFY_REFRESH_TOKEN = " + refreshToken + "\n\n" +
    "IMPORTANT: After saving, delete /api/auth/start and /api/auth/callback from your repo and redeploy."
  );
}
