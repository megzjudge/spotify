// functions/api/playlist-duration.js

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestPost({ env, request }) {
  try {
    let body = {};
    try { body = await request.json(); } catch {}

    const playlistId = String(body?.playlistId || "").trim();
    if (!playlistId) return json({ error: "Missing playlistId" }, 400);

    // Optional safety cap (can set high; it won’t blow subrequests because it's one playlist per request)
    const MAX_ITEMS = clampInt(body?.maxItems, 1, 5000, 5000);

    const token = await getUserAccessToken(env);

    // Fetch all items for this playlist (paginated)
    const items = await fetchPlaylistItemsAll(token, playlistId, MAX_ITEMS);

    // Sum only tracks (exclude episodes)
    let totalMs = 0;
    let trackCount = 0;

    for (const it of items) {
      const t = it?.track;
      if (!t || t.type !== "track") continue;
      const ms = Number(t.duration_ms);
      if (!Number.isFinite(ms)) continue;
      totalMs += ms;
      trackCount += 1;
    }

    return json({
      playlistId,
      trackCount,
      totalMs
    });

  } catch (err) {
    return json({
      error: "Playlist duration failed",
      message: String(err?.message || err),
      stack: String(err?.stack || "")
    }, 500);
  }
}

/* =========================
   HELPERS
========================= */

async function getUserAccessToken(env) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${env.SPOTIFY_PROFILE}:${env.SPOTIFY_KEY}`),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: env.SPOTIFY_REFRESH_TOKEN
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.access_token) {
    throw new Error("Failed to refresh Spotify access token.");
  }
  return data.access_token;
}

async function fetchPlaylistItemsAll(token, playlistId, max) {
  let out = [];
  let next = `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/tracks?limit=100`;

  while (next && out.length < max) {
    const r = await fetch(next, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(`Spotify playlist tracks fetch failed (HTTP ${r.status})`);
    }
    out.push(...(d.items || []));
    next = d.next;
  }

  return out.slice(0, max);
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Accept,X-Auth"
  };
}
