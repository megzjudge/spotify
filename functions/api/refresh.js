// functions/api/refresh.js
export async function onRequestPost({ env, request }) {
  try {
    let body = {};
    try { body = await request.json(); } catch {}

    const accessToken = await getUserAccessToken(env);

    /***********************
     * CONFIG (EDIT HERE)
     ***********************/

    // HARD-CODED private podcast playlist ID (allowed even if private)
    const PODCAST_PLAYLIST_ID = "2tHrihmpYzDbJ8rit7HtFR";

    // Safety limits
    const MAX_PLAYLISTS = clampInt(body?.maxPlaylists, 1, 200, 80);
    const MAX_TRACKS_PER_PLAYLIST = clampInt(body?.maxTracksPerPlaylist, 1, 500, 200);

    // Naming-based exclusions
    const NOT_PUBLIC_PREFIXES = ["NP:", "[Not Public]"];
    const NOT_PUBLIC_TAG = "#notpublic";

    // Spotify-created / special playlists
    const SPECIAL_PLAYLIST_NAMES = [
      "Your Top Songs 2025"
    ];

    /***********************
     * FETCH USER + PLAYLISTS
     ***********************/
    const me = await fetchMe(accessToken);
    const myUserId = me?.id || null;

    const playlistsRaw = await fetchMyPlaylists(accessToken, MAX_PLAYLISTS);

    /***********************
     * FILTER PLAYLISTS
     ***********************/
    const filtered = playlistsRaw.filter((p) => {
      // Always include the podcast playlist, even if private
      if (p.id === PODCAST_PLAYLIST_ID) return true;

      // Exclude private playlists by default
      if (p.public === false) return false;

      // Exclude naming/description rules
      const name = (p.name || "").trim();
      const desc = (p.description || "").toLowerCase();

      if (NOT_PUBLIC_PREFIXES.some((pre) => name.startsWith(pre))) return false;
      if (desc.includes(NOT_PUBLIC_TAG)) return false;

      return true;
    });

    /***********************
     * NORMALIZE PLAYLIST META
     ***********************/
    const normalized = filtered.map((p) =>
      normalizePlaylistMeta(p, myUserId)
    );

    /***********************
     * SPECIALS (RIGHT MENU)
     ***********************/
    const specials = normalized.filter((p) => {
      if (SPECIAL_PLAYLIST_NAMES.includes(p.name)) return true;
      if (p.ownerIsMe === false) return true; // created by others
      return false;
    });

    const normal = normalized.filter(
      (p) => !specials.some((s) => s.id === p.id)
    );

    /***********************
     * SECTIONS (YOUR PLAYLISTS)
     ***********************/
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

    /***********************
     * PODCAST PLAYLIST
     ***********************/
    const podcast = normal.find((p) => p.id === PODCAST_PLAYLIST_ID) || null;

    const songPlaylists = podcast
      ? normal.filter((p) => p.id !== podcast.id)
      : normal;

    /***********************
     * METRICS
     ***********************/
    const totalSongs = sum(songPlaylists.map((p) => p.totalTracks || 0));
    const podcastEpisodes = podcast?.totalTracks ?? 0;

    let totalSongMs = 0;
    for (const p of songPlaylists) {
      const items = await fetchPlaylistItemsBounded(
        accessToken,
        p.id,
        MAX_TRACKS_PER_PLAYLIST
      );
      totalSongMs += sum(items.map(msFromItem));
    }

    let podcastMs = 0;
    if (podcast) {
      const items = await fetchPlaylistItemsBounded(
        accessToken,
        podcast.id,
        MAX_TRACKS_PER_PLAYLIST
      );
      podcastMs = sum(items.map(msFromItem));
    }

    /***********************
     * RESPONSE
     ***********************/
    return json({
      lastUpdated: new Date().toISOString(),

      totals: {
        playlists: normal.length,
        songs: totalSongs,
        songMs: totalSongMs,
        podcastEpisodes,
        podcastMs
      },

      sections: {
        dailyMix,
        top,
        other
      },

      specials
    });

  } catch (err) {
    return json(
      {
        error: "Refresh failed",
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
    throw new Error("Missing Spotify OAuth secrets");
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

  const data = await res.json();
  if (!res.ok || !data?.access_token) {
    throw new Error("Failed to refresh Spotify access token");
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
  if (!res.ok) throw new Error("Failed to fetch user profile");
  return res.json();
}

async function fetchMyPlaylists(token, limit) {
  let items = [];
  let next = "https://api.spotify.com/v1/me/playlists?limit=50";

  while (next && items.length < limit) {
    const res = await fetch(next, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error("Failed to fetch playlists");
    const data = await res.json();
    items = items.concat(data.items || []);
    next = data.next;
  }

  return items.slice(0, limit);
}

async function fetchPlaylistItemsBounded(token, playlistId, maxItems) {
  let items = [];
  let next = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;

  while (next && items.length < maxItems) {
    const res = await fetch(next, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error(`Failed to fetch tracks for ${playlistId}`);
    const data = await res.json();
    items = items.concat(data.items || []);
    next = data.next;
  }

  return items.slice(0, maxItems);
}

/* =========================
   NORMALIZATION
========================= */
function normalizePlaylistMeta(p, myUserId) {
  const ownerId = p.owner?.id || null;
  const ownerIsMe = myUserId ? ownerId === myUserId : null;

  return {
    id: p.id,
    name: p.name,
    image: p.images?.[0]?.url || null,
    url: p.external_urls?.spotify || null,
    totalTracks: p.tracks?.total ?? 0,
    ownerIsMe
  };
}

function msFromItem(it) {
  const obj = it?.track;
  if (!obj) return 0;
  return Number(obj.duration_ms) || 0;
}

function sum(arr) {
  return arr.reduce((a, b) => a + (Number(b) || 0), 0);
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
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}
