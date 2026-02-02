// functions/api/refresh.js
export async function onRequestPost({ env, request }) {
  try {
    let body = {};
    try { body = await request.json(); } catch {}

    const token = await getUserAccessToken(env);

    // =========================
    // CONFIG / RULES
    // =========================
    const MAX_PLAYLISTS = clampInt(body?.maxPlaylists, 1, 200, 80);
    const MAX_TRACKS_PER_PLAYLIST = clampInt(body?.maxTracksPerPlaylist, 1, 500, 200);

    const PODCAST_PLAYLIST_ID = env.SPOTIFY_PODCAST_PLAYLIST_ID || null;

    const NOT_PUBLIC_PREFIXES = ["NP:", "[Not Public]"];
    const NOT_PUBLIC_TAG = "#notpublic";

    const SPECIAL_PLAYLIST_NAMES = [
      "Your Top Songs 2025"
    ];

    // =========================
    // Fetch user + playlists
    // =========================
    const me = await fetchMe(token);
    const myUserId = me?.id || null;

    const playlistsRaw = await fetchMyPlaylists(token, MAX_PLAYLISTS);

    // =========================
    // Filter playlists
    // =========================
    const filtered = playlistsRaw.filter((p) => {
      // Always include the podcast playlist, even if private
      if (PODCAST_PLAYLIST_ID && p.id === PODCAST_PLAYLIST_ID) {
        return true;
      }

      // Exclude all other private playlists
      if (p.public === false) return false;

      // Exclude explicit "Not Public" naming rules
      const name = (p.name || "").trim();
      const desc = (p.description || "").toLowerCase();

      if (NOT_PUBLIC_PREFIXES.some((pre) => name.startsWith(pre))) return false;
      if (desc.includes(NOT_PUBLIC_TAG)) return false;

      return true;
    });

    // =========================
    // Normalize metadata
    // =========================
    const normalized = filtered.map((p) =>
      normalizePlaylistMeta(p, myUserId)
    );

    // =========================
    // Specials (right menu)
    // =========================
    const specials = normalized.filter((p) => {
      if (SPECIAL_PLAYLIST_NAMES.includes(p.name)) return true;
      if (p.ownerIsMe === false) return true; // created by others
      return false;
    });

    // Normal playlists exclude specials
    const normal = normalized.filter(
      (p) => !specials.some((s) => s.id === p.id)
    );

    // =========================
    // Sections (your playlists)
    // =========================
    const dailyMix = normal.filter(
      (p) => p.ownerIsMe && p.name.startsWith("Daily Mix:")
    );

    const top = normal.filter(
      (p) => p.ownerIsMe && p.name.startsWith("Top")
    );

    const other = normal.filter(
      (p) =>
        !dailyMix.some((x) => x.id === p.id) &&
        !top.some((x) => x.id === p.id)
    );

    // =========================
    // Podcast playlist (by ID)
    // =========================
    const podcast = PODCAST_PLAYLIST_ID
      ? normal.find((p) => p.id === PODCAST_PLAYLIST_ID)
      : null;

    const songPlaylists = podcast
      ? normal.filter((p) => p.id !== podcast.id)
      : normal;

    // =========================
    // Metrics
    // =========================
    const totalSongs = sum(songPlaylists.map((p) => p.totalTracks || 0));
    const podcastEpisodes = podcast?.totalTracks ?? 0;

    let totalSongMs = 0;
    for (const p of songPlaylists) {
      const items = await fetchPlaylistItemsBounded(
        token,
        p.id,
        MAX_TRACKS_PER_PLAYLIST
      );
      totalSongMs += sum(items.map(msFromItem));
    }

    let podcastMs = 0;
    if (podcast) {
      const items = await fetchPlaylistItemsBounded(
        token,
        podcast.id,
        MAX_TRACKS_PER_PLAYLIST
      );
      podcastMs = sum(items.map(msFromItem));
    }

    // =========================
    // Response
    // =========================
    return json(
      {
        lastUpdated: new Date().toISOString(),
        totalPlaylists: normal.length,
        metrics: {
          totalSongs,
          totalSongMs,
          podcastEpisodes,
          podcastMs
        },
        sections: {
          all: normal,
          dailyMix,
          top,
          other
        },
        specials
      },
      200
    );
  } catch (err) {
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

/* =========================
   AUTH
========================= */
async function getUserAccessToken(env) {
  const clientId = env.SPOTIFY_PROFILE;
  const clientSecret = env.SPOTIFY_KEY;
  const refreshToken = env.SPOTIFY_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing Spotify secrets");
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

  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}

  if (!res.ok) {
    throw new Error(
      `Token refresh failed (${res.status}): ${data?.error_description || text}`
    );
  }
  if (!data?.access_token) {
    throw new Error("No access_token returned");
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
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`Fetch me failed (${res.status}): ${text}`);
  return data;
}

async function fetchMyPlaylists(token, limit) {
  let items = [];
  let next = "https://api.spotify.com/v1/me/playlists?limit=50";

  while (next && items.length < limit) {
    const res = await fetch(next, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (!res.ok) throw new Error(`Playlists fetch failed (${res.status}): ${text}`);

    items = items.concat(data?.items || []);
    next = data?.next || null;
  }

  return items.slice(0, limit);
}

async function fetchPlaylistItemsBounded(token, playlistId, maxItems) {
  let items = [];
  let next = `https://api.spotify.com/v1/playlists/${encodeURIComponent(
    playlistId
  )}/tracks?limit=100`;

  while (next && items.length < maxItems) {
    const res = await fetch(next, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (!res.ok) {
      throw new Error(
        `Playlist items failed (${playlistId}) (${res.status}): ${text}`
      );
    }

    items = items.concat(data?.items || []);
    next = data?.next || null;
  }

  return items.slice(0, maxItems);
}

/* =========================
   NORMALIZATION / METRICS
========================= */
function normalizePlaylistMeta(p, myUserId) {
  const ownerId = p.owner?.id || null;
  const ownerName = p.owner?.display_name || ownerId || "";
  const ownerIsMe = myUserId ? ownerId === myUserId : null;

  return {
    id: p.id,
    name: p.name,
    image: p.images?.[0]?.url || null,
    url: p.external_urls?.spotify || null,
    totalTracks: p.tracks?.total ?? 0,
    ownerLabel: ownerName ? `by ${ownerName}` : "",
    ownerIsMe
  };
}

function msFromItem(it) {
  const obj = it?.track;
  if (!obj) return 0;
  return Number(obj.duration_ms) || 0;
}

function sum(arr) {
  let s = 0;
  for (const n of arr) s += Number(n) || 0;
  return s;
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/* =========================
   RESPONSE
========================= */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}
