// functions/api/playlist.js
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

export async function onRequestPost({ env, request }) {
  try {
    const body = await request.json().catch(() => ({}));
    const playlistId = String(body.playlistId || "").trim();
    const limit = clampInt(body.limit, 0, 500, 200);

    if (!playlistId) {
      return json({ error: "Missing playlistId" }, 400);
    }

    const token = await getUserAccessToken(env);
    const me = await fetchMe(token);
    const myUserId = me?.id || null;

    // Fetch playlist meta
    const pl = await fetchPlaylist(token, playlistId);
    const playlist = normalizePlaylist(pl, myUserId);

    // Items (optional)
    const items = limit === 0 ? [] : await fetchPlaylistItemsBounded(token, playlistId, limit);
    const normalizedItems = items.map(normalizeItem).filter(Boolean);

    return json(
      {
        playlist,
        items: normalizedItems
      },
      200
    );
  } catch (err) {
    return json(
      {
        error: "Playlist fetch failed",
        message: String(err?.message || err),
        stack: String(err?.stack || "")
      },
      500
    );
  }
}

/* =========================
   AUTH
========================= */
async function getUserAccessToken(env) {
  const clientId = env.SPOTIFY_PROFILE;
  const clientSecret = env.SPOTIFY_KEY;
  const refreshToken = env.SPOTIFY_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing Spotify OAuth secrets (SPOTIFY_PROFILE, SPOTIFY_KEY, SPOTIFY_REFRESH_TOKEN).");
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

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.access_token) {
    throw new Error(`Failed to refresh access token (${res.status})`);
  }

  return data.access_token;
}

/* =========================
   SPOTIFY API
========================= */
async function fetchMe(token) {
  const res = await fetch("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Failed to fetch /me (${res.status})`);
  return res.json();
}

async function fetchPlaylist(token, playlistId) {
  const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Failed to fetch playlist (${res.status})`);
  return res.json();
}

async function fetchPlaylistItemsBounded(token, playlistId, maxItems) {
  let items = [];
  let next = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;

  while (next && items.length < maxItems) {
    const res = await fetch(next, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error(`Failed to fetch playlist items (${res.status})`);
    const data = await res.json();
    items = items.concat(data.items || []);
    next = data.next;
  }

  return items.slice(0, maxItems);
}

/* =========================
   NORMALIZATION
========================= */
function normalizePlaylist(p, myUserId) {
  const ownerId = p.owner?.id || null;
  const ownerIsMe = myUserId ? ownerId === myUserId : false;

  let ownerLabel = "";
  if (p.owner?.display_name) {
    ownerLabel = ownerIsMe ? "by me" : "by others";
  } else {
    ownerLabel = ownerIsMe ? "by me" : "by others";
  }

  return {
    id: p.id,
    name: p.name,
    image: p.images?.[0]?.url || null,
    url: p.external_urls?.spotify || null,
    totalTracks: p.tracks?.total ?? null,
    ownerIsMe,
    ownerLabel
  };
}

// playlist items return { added_at, track: {...} } even for episodes (track.type === "episode")
function normalizeItem(it) {
  const obj = it?.track;
  if (!obj) return null;

  const type = obj.type; // "track" | "episode"
  const url = obj.external_urls?.spotify || null;
  const durationMs = Number(obj.duration_ms) || 0;

  if (type === "track") {
    return {
      type: "track",
      id: obj.id,
      name: obj.name,
      artists: (obj.artists || []).map((a) => a.name).filter(Boolean),
      url,
      durationMs,
      addedAt: it.added_at || null
    };
  }

  if (type === "episode") {
    return {
      type: "episode",
      id: obj.id,
      name: obj.name,
      artists: obj.show?.name ? [obj.show.name] : [],
      url,
      durationMs,
      addedAt: it.added_at || null
    };
  }

  return null;
}

/* =========================
   RESPONSE HELPERS
========================= */
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
    "Access-Control-Allow-Headers": "Content-Type,Accept"
  };
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
