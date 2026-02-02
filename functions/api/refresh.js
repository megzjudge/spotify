// functions/api/refresh.js

export async function onRequestPost(context) {
  try {
    const { env, request } = context;

    // Optional: client can send lastUpdated so we only return items added since last scan
    let lastScanAt = null;
    try {
      const body = await request.json();
      if (body?.lastUpdated) lastScanAt = body.lastUpdated;
    } catch {
      // no body is fine
    }

    const token = await getUserAccessToken(env);

    // 1) Get playlists for the authorized user
    const playlists = await fetchAllMyPlaylists(token);

    // 2) For each playlist, fetch items + normalize
    const normalized = [];
    for (const p of playlists) {
      const items = await fetchAllPlaylistItems(token, p.id);
      normalized.push(normalizePlaylist(p, items, lastScanAt));
    }

    const totalNewTracks = normalized.reduce(
      (sum, p) => sum + (p.newTracksCount || 0),
      0
    );

    const snapshot = {
      lastUpdated: new Date().toISOString(),
      totalPlaylists: normalized.length,
      totalNewTracks,
      playlists: normalized
    };

    return json(snapshot, 200);
  } catch (err) {
    console.error(err);
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

/**
 * Uses refresh token -> access token (user-scoped).
 * Requires secrets:
 *  - SPOTIFY_PROFILE (client id)
 *  - SPOTIFY_KEY (client secret)
 *  - SPOTIFY_REFRESH_TOKEN (refresh token)
 */
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
    // Spotify often returns: { error, error_description }
    throw new Error(data?.error_description || data?.error || `Token refresh failed: ${res.status} ${text}`);
  }

  if (!data?.access_token) {
    throw new Error("Token refresh succeeded but no access_token returned");
  }

  return data.access_token;
}

async function fetchAllMyPlaylists(token) {
  let items = [];
  let next = "https://api.spotify.com/v1/me/playlists?limit=50";

  while (next) {
    const res = await fetch(next, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const text = await safeText(res);
    let data = null;
    try { data = JSON.parse(text); } catch {}

    if (!res.ok) {
      throw new Error(`My playlists fetch failed: ${res.status} ${text}`);
    }

    items = items.concat(data?.items || []);
    next = data?.next;
  }

  return items;
}

async function fetchAllPlaylistItems(token, playlistId) {
  let items = [];
  let next = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&market=from_token`;

  while (next) {
    const res = await fetch(next, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const text = await safeText(res);
    let data = null;
    try { data = JSON.parse(text); } catch {}

    if (!res.ok) {
      throw new Error(`Playlist items fetch failed (${playlistId}): ${res.status} ${text}`);
    }

    items = items.concat(data?.items || []);
    next = data?.next;
  }

  return items;
}

// NOTE: Spotify returns items under it.track even when it is an "episode"
function normalizePlaylist(playlist, rawItems, lastScanAtIso) {
  const lastScanAt = lastScanAtIso ? new Date(lastScanAtIso) : null;

  const newItems = [];

  for (const it of rawItems) {
    const addedAt = it.added_at ? new Date(it.added_at) : null;
    if (lastScanAt && addedAt && !isNaN(addedAt.getTime()) && addedAt <= lastScanAt) continue;

    const obj = it.track; // track OR episode object
    if (!obj) continue;

    const type = obj.type; // "track" or "episode"
    const url = obj.external_urls?.spotify || null;

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

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Same-origin in Pages, but CORS headers don't hurt
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
  try {
    return await res.text();
  } catch {
    return "";
  }
}
