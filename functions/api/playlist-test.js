// functions/api/playlist-test.js

export async function onRequestGet({ env, request }) {
  try {
    const url = new URL(request.url);
    const playlistId = String(url.searchParams.get("playlistId") || "").trim();
    if (!playlistId) {
      return json({ ok: false, error: "Provide ?playlistId=..." }, 400);
    }

    const token = await getUserAccessToken(env);

    const pl = await fetchJson(`https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}`, token);

    return json({ ok: true, playlistId, name: pl?.name || null, owner: pl?.owner?.display_name || null }, 200);
  } catch (err) {
    return json({
      ok: false,
      error: String(err?.message || err),
      status: err?.status || null,
      details: err?.details || null
    }, 500);
  }
}

async function getUserAccessToken(env) {
  const clientId = env.SPOTIFY_PROFILE;
  const clientSecret = env.SPOTIFY_KEY;
  const refreshToken = env.SPOTIFY_REFRESH_TOKEN;

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

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok || !data?.access_token) {
    const e = new Error(`Token refresh failed (${res.status})`);
    e.status = res.status;
    e.details = data || text;
    throw e;
  }

  return data.access_token;
}

async function fetchJson(endpoint, token) {
  const res = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    const e = new Error(`Spotify request failed (${res.status})`);
    e.status = res.status;
    e.details = data || text;
    throw e;
  }
  return data;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
