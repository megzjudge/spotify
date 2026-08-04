// functions/api/token-health.js
//
// Checks whether SPOTIFY_REFRESH_TOKEN can still mint an access token.
// Meant to be hit on a schedule (see .github/workflows/token-health-check.yml)
// since Cloudflare Pages Functions have no native cron trigger of their own.
// On failure, emails ALERT_EMAIL via Resend and returns 500 so the calling
// workflow also shows red.

export async function onRequestGet(context) {
  return handle(context);
}

export async function onRequestPost(context) {
  return handle(context);
}

async function handle({ request, env }) {
  const secret = request.headers.get("x-cron-secret");
  if (!env.CRON_SECRET || secret !== env.CRON_SECRET) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  const clientId = env.SPOTIFY_PROFILE || null;
  const clientSecret = env.SPOTIFY_KEY || null;
  const refreshToken = env.SPOTIFY_REFRESH_TOKEN || null;

  if (!clientId || !clientSecret || !refreshToken) {
    const missing = [
      !clientId && "SPOTIFY_PROFILE",
      !clientSecret && "SPOTIFY_KEY",
      !refreshToken && "SPOTIFY_REFRESH_TOKEN"
    ].filter(Boolean);
    const detail = `Missing Spotify OAuth env vars: ${missing.join(", ")}`;
    await sendAlert(env, detail);
    return json({ ok: false, alive: false, error: detail }, 500);
  }

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${clientId}:${clientSecret}`),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken
    })
  });

  const text = await res.text().catch(() => "");
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { rawText: text }; }

  if (!res.ok || !data?.access_token) {
    const detail = data?.error_description || data?.error || text || `HTTP ${res.status}`;
    await sendAlert(env, detail);
    return json({ ok: false, alive: false, error: detail }, 500);
  }

  return json({ ok: true, alive: true, checkedAt: new Date().toISOString() });
}

async function sendAlert(env, detail) {
  const apiKey = env.RESEND_API_KEY;
  const to = env.ALERT_EMAIL;
  const from = env.RESEND_FROM || "onboarding@resend.dev";

  if (!apiKey || !to) return; // nothing to send with — check response body is the fallback signal

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to,
      subject: "Spotify refresh token is dead",
      text:
        `The Spotify refresh token for your tracking site stopped working.\n\n` +
        `Error: ${detail}\n\n` +
        `Fix: re-run the OAuth flow at https://<your-domain>/api/auth/start ` +
        `(you'll need to temporarily restore functions/api/auth/start.js and callback.js ` +
        `if you already deleted them per the README), then update SPOTIFY_REFRESH_TOKEN ` +
        `in Cloudflare Pages env vars and redeploy.\n\n` +
        `Checked at: ${new Date().toISOString()}`
    })
  }).catch(() => {}); // best-effort — don't let an email failure mask the real alert in the response body
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
