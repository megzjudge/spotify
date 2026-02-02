// functions/api/refresh.js
// Cloudflare Pages Function: POST /api/refresh
//
// Uses refresh token -> access token, then fetches playlists + tracks.
// IMPORTANT: bounded by defaults to avoid function timeouts.
// You can target a single playlist by passing { playlistId: "..." } in POST JSON.

export async function onRequestPost(context) {
  const { env, request } = context;

  try {
    // Parse optional request body
    let body = {};
    try { body = await request.json(); } catch {}

    const lastScanAt = body?.lastUpdated || null;

    // SAFETY LIMITS (avoid timeouts)
    const playlistId = body?.playlistId || null;
    const maxPlaylists = clampInt(body?.maxPlaylists, 1, 50, 10); // default 10
    const maxTracksPerPlaylist = clampInt(body?.maxTracksPerPlaylist, 1, 200, 100); // default 100
    const includeTrackDetails = body?.includeTrackDetails !== false; // default true

    const token = await getUserAccessToken(env);

    let playlists = [];

    if (playlistId) {
      // One-playlist mode (recommended)
      const p = await fetchPlaylist(token, playlistId);
      const items = await fetchPlaylistItemsBounded(token, playlistId, maxTracksPerPlaylist);
      playlists = [normalizePlaylist(p, items, lastScanAt, includeTrackDetails)];
    } else {
      // Multi-playlist mode (bounded)
      const all = await fetchMyPlaylists(token, maxPlaylists);
      // Fetch tracks with small concurrency to avoid spiking duration
      playlists = await mapWithConcurrency(all, 3, async (p) => {
        const items = await fetchPlaylistItemsBounded(token, p.id, maxTracksPerPlaylist);
        return normalizePlaylist(p, items, lastScanAt, includeTrackDetails);
      });
    }

    const totalNewTracks = playlists.reduce((sum, p) => sum + (p.newTracksCount || 0), 0);

    return json(
      {
        lastUpdated: new Date().toISOString(),
        totalPlaylists: playlists.length,
        totalNewTracks,
        playlists
      },
      200
    );
  } catch (err) {
    // Always return useful JSON so you don't need logs
    return json(
      {
        error: "Refresh failed",
        message: String(err?.message || err),
        detail: String(err?.stack || "")
      },
      500
    );
  }
}

/* ---------------------------
   Token
--------------------------- */

async function getUserAccessToken(env) {
  const clientId = env.SPOTIFY_PROFILE;
  const clientSecret = env.SPOTIFY_KEY;
  const refreshToken = env.SPOTIFY_REFRESH_TOKEN;

  if (!clientId || !clientSecret) {
    throw new Error("Missing SPOTIFY_PROFILE (client id) or SPOTIFY_KEY (client secret)");
  }
  if (!refreshToken) {
    throw new Error("Missing SPOTIFY_REFRESH_TOKEN (refresh token)");
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

  const text = await safeText(res);
  let data = null;
  try { data = JSON.parse(text); } catch {}

  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status}): ${data?.error_description || data?.error || text}`);
  }
  if (!data?.access_token) {
    throw new Error("Token refresh succeeded but no access_token returned");
  }
  return data.access_token;
}

/* ---------------------------
   Spotify API calls
--------------------------- */

async function fetchMyPlaylists(token, limit) {
  // We page until we reach limit
  let items = [];
  let next = `https://api.spotify.com/v1/me/playlists?limit=50`;

  while (next && items.length < limit) {
    const res = await fetch(next, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const { ok, text, json } = await readJsonOrText(res);

    if (!ok) {
      throw new Error(`My playlists fetch failed (${res.status}): ${text}`);
    }

    items = items.concat(json?.items || []);
    next = json?.next || null;
  }

  return items.slice(0, limit);
}

async function fetchPlaylist(token, playlistId) {
  const url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const { ok, text, json } = await readJsonOrText(res);
  if (!ok) throw new Error(`Playlist fetch failed (${res.status}): ${text}`);
  return json;
}

async function fetchPlaylistItemsBounded(token, playlistId, maxItems) {
  // Bounded: only fetch enough pages to reach maxItems
  let items = [];
  let next = `https://api.spotify.com/v1/playlists/${encodeURIComponent(
    playlistId
  )}/tracks?limit=100`;

  while (next && items.length < maxItems) {
    const res = await fetch(next, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const { ok, text, json } = await readJsonOrText(res);

    if (!ok) {
      throw new Error(`Playlist items failed (${playlistId}) (${res.status}): ${text}`);
    }

    items = items.concat(json?.items || []);
    next = json?.next || null;
  }

  return items.slice(0, maxItems);
}

/* ---------------------------
   Normalization
--------------------------- */

function normalizePlaylist(playlist, rawItems, lastScanAtIso, includeTrackDetails) {
  const lastScanAt = lastScanAtIso ? new Date(lastScanAtIso) : null;

  const newItems = [];

  for (const it of rawItems) {
    const addedAt = it.added_at ? new Date(it.added_at) : null;

    if (
      lastScanAt &&
      addedAt &&
      !isNaN(addedAt.getTime()) &&
      addedAt <= lastScanAt
    ) {
      continue;
    }

    const obj = it.track; // track OR episode
    if (!obj) continue;

    const type = obj.type; // "track" or "episode"
    const url = obj.external_urls?.spotify || null;

    if (!includeTrackDetails) {
      // lightweight mode
      newItems.push({ type, id: obj.id, url, addedAt: it.added_at });
      continue;
    }

    if (type === "track") {
      newItems.push({
        type: "track",
        id: obj.id,
        name: obj.name,
        artists: (obj.artists || []).map((a) => a.name),
        url,
        addedAt: it.added_at
      });
    } else if (type === "episode") {
      newItems.push({
        type: "episode",
        id: obj.id,
        name: obj.name,
        artists: obj.show?.name ? [obj.show.name] : [],
        url,
        addedAt: it.added_at
      });
    }
  }

  return {
    id: playlist.id,
    name: playlist.name,
    url: playlist.external_urls?.spotify,
    image: playlist.images?.[0]?.url || null,
    totalTracks: playlist.tracks?.total ?? null,
    newTracksCount: newItems.length,
    newTracks: newItems
  };
}

/* ---------------------------
   Helpers
--------------------------- */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Accept"
    }
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Accept"
    }
  });
}

async function safeText(res) {
  try { return await res.text(); } catch { return ""; }
}

async function readJsonOrText(res) {
  const text = await safeText(res);
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, text, json };
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

async function mapWithConcurrency(list, concurrency, fn) {
  const out = new Array(list.length);
  let i = 0;

  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= list.length) return;
      out[idx] = await fn(list[idx], idx);
    }
  }

  const workers = [];
  for (let w = 0; w < concurrency; w++) workers.push(worker());
  await Promise.all(workers);
  return out;
}
