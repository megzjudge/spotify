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

    const token = await getAppToken(env);

    // 1) Get playlists for user (PUBLIC playlists only with client credentials)
    const playlists = await fetchAllUserPlaylists(token, env.SPOTIFY_USER);

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
      { error: "Refresh failed", detail: String(err?.message || err) },
      500
    );
  }
}

async function getAppToken(env) {
  const clientId = env.SPOTIFY_PROFILE; // Client ID
  const clientSecret = env.SPOTIFY_KEY; // Client Secret

  if (!clientId || !clientSecret) {
    throw new Error("Missing SPOTIFY_PROFILE (client id) or SPOTIFY_KEY (client secret)");
  }

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${clientId}:${clientSecret}`),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  if (!res.ok) throw new Error(`Token request failed: ${res.status} ${await safeText(res)}`);

  const data = await res.json();
  return data.access_token;
}

async function fetchAllUserPlaylists(token, userId) {
  if (!userId) throw new Error("Missing SPOTIFY_USER (spotify user id)");

  let items = [];
  let next = `https://api.spotify.com/v1/users/${encodeURIComponent(userId)}/playlists?limit=50`;

  while (next) {
    const res = await fetch(next, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      throw new Error(`User playlists fetch failed: ${res.status} ${await safeText(res)}`);
    }

    const data = await res.json();
    items = items.concat(data.items || []);
    next = data.next;
  }

  // You can filter here if you only want certain playlists:
  // return items.filter(p => p.name?.includes("Finished"))
  return items;
}

async function fetchAllPlaylistItems(token, playlistId) {
  let items = [];
  let next = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&market=from_token`;

  while (next) {
    const res = await fetch(next, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      throw new Error(`Playlist items fetch failed (${playlistId}): ${res.status} ${await safeText(res)}`);
    }

    const data = await res.json();
    items = items.concat(data.items || []);
    next = data.next;
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
