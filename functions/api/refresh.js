// functions/api/refresh.js

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestPost({ env, request }) {
  try {
    let body = {};
    try { body = await request.json(); } catch {}

    const accessToken = await getUserAccessToken(env);

    /***********************
     * CONFIG (EDIT HERE)
     ***********************/
    const PODCAST_PLAYLIST_ID = "2tHrihmpYzDbJ8rit7HtFR";

    const OTHERS_PLAYLIST_IDS = [
      "71z6BdHlnfNj4DKRhuu1Fk",
      "7jYNznHoIYgJBzwT5jpoOe",
      "41PZG18MrSTagagiIaiG4X",
      "37i9dQZF1DX5mB2C8gBeUM",
      "37i9dQZF1EQnsJ0xmvpihE"
    ];

    const YEAR_SUMMARY_PLAYLIST_IDS = [
      "37i9dQZEVXcXHWVVT0lfDq" // 2025
    ];

    const MAX_PLAYLISTS = clampInt(body?.maxPlaylists, 1, 200, 120);
    const MAX_TRACKS_PER_PLAYLIST = clampInt(body?.maxTracksPerPlaylist, 1, 500, 250);

    const NOT_PUBLIC_PREFIXES = ["NP:", "[Not Public]"];
    const NOT_PUBLIC_TAG = "#notpublic";

    const ALLOWLIST_IDS = new Set(
      [
        PODCAST_PLAYLIST_ID,
        ...OTHERS_PLAYLIST_IDS,
        ...YEAR_SUMMARY_PLAYLIST_IDS
      ].filter(Boolean)
    );

    /***********************
     * FETCH USER + PLAYLISTS
     ***********************/
    const me = await fetchMe(accessToken);
    const myUserId = me?.id || null;
    if (!myUserId) throw new Error("Could not resolve /me id from Spotify.");

    // 1) Load library playlists (/me/playlists)
    let playlistsRaw = await fetchMyPlaylists(accessToken, MAX_PLAYLISTS);

    // 2) IMPORTANT: explicitly fetch allowlisted playlists by ID
    // because /me/playlists may not include them unless followed/saved.
    const seen = new Set((playlistsRaw || []).map(p => p?.id).filter(Boolean));
    for (const id of ALLOWLIST_IDS) {
      if (!id || seen.has(id)) continue;
      try {
        const pl = await fetchPlaylist(accessToken, id);
        if (pl?.id) {
          playlistsRaw.push(pl);
          seen.add(pl.id);
        }
      } catch {
        // ignore individual failures; UI will just show missing
      }
    }

    /***********************
     * FILTER PLAYLISTS
     ***********************/
    const filtered = playlistsRaw.filter((p) => {
      if (!p?.id) return false;

      // Always include allowlisted playlists (podcast / others / year-summary)
      if (ALLOWLIST_IDS.has(p.id)) return true;

      // Exclude anything not owned by you
      const ownerId = p.owner?.id || null;
      if (ownerId !== myUserId) return false;

      // Exclude private playlists by default
      if (p.public === false) return false;

      // Exclude "Not Public" rules
      const name = (p.name || "").trim();
      const desc = String(p.description || "").toLowerCase();

      if (NOT_PUBLIC_PREFIXES.some((pre) => name.startsWith(pre))) return false;
      if (desc.includes(NOT_PUBLIC_TAG)) return false;

      return true;
    });

    /***********************
     * NORMALIZE PLAYLIST META
     ***********************/
    const normalized = filtered.map((p) => normalizePlaylistMeta(p, myUserId));

    /***********************
     * SPECIAL BUCKETS
     ***********************/
    const podcastPlaylist = normalized.find((p) => p.id === PODCAST_PLAYLIST_ID) || null;

    const othersPlaylists = normalized.filter((p) => OTHERS_PLAYLIST_IDS.includes(p.id));
    const yearSummaryPlaylists = normalized.filter((p) => YEAR_SUMMARY_PLAYLIST_IDS.includes(p.id));

    /***********************
     * NORMAL LIBRARY (YOUR PLAYLISTS)
     ***********************/
    const normal = normalized.filter((p) => {
      if (p.id === PODCAST_PLAYLIST_ID) return false;
      if (OTHERS_PLAYLIST_IDS.includes(p.id)) return false;
      if (YEAR_SUMMARY_PLAYLIST_IDS.includes(p.id)) return false;
      return true;
    });

    /***********************
     * SECTIONS (YOUR PLAYLISTS)
     ***********************/
    const dailyMix = normal.filter((p) => p.ownerIsMe && (p.name || "").startsWith("Daily Mix:"));
    const top = normal.filter((p) => p.ownerIsMe && (p.name || "").startsWith("Top"));

    const other = normal.filter((p) => {
      if (dailyMix.some((x) => x.id === p.id)) return false;
      if (top.some((x) => x.id === p.id)) return false;
      return true;
    });

    /***********************
     * METRICS
     ***********************/
    const totalSongs = sum(normal.map((p) => p.totalTracks || 0));

    let totalSongMs = 0;
    for (const p of normal) {
      const items = await fetchPlaylistItemsBounded(accessToken, p.id, MAX_TRACKS_PER_PLAYLIST);
      totalSongMs += sum(items.map(msFromItem));
    }

    const podcastEpisodes = podcastPlaylist?.totalTracks ?? 0;

    let podcastMs = 0;
    if (podcastPlaylist) {
      const items = await fetchPlaylistItemsBounded(accessToken, podcastPlaylist.id, MAX_TRACKS_PER_PLAYLIST);
      podcastMs = sum(items.map(msFromItem));
    }

    /***********************
     * RESPONSE
     ***********************/
    return json(
      {
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

        othersPlaylists,
        yearSummaryPlaylists,
        podcastPlaylist
      },
      200
    );

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
    throw new Error(`Failed to refresh Spotify access token (${res.status}).`);
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
  if (!res.ok) throw new Error(`Failed to fetch user profile (${res.status}).`);
  return res.json();
}

async function fetchPlaylist(token, playlistId) {
  const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Failed to fetch playlist ${playlistId} (${res.status}).`);
  return res.json();
}

async function fetchMyPlaylists(token, limit) {
  let items = [];
  let next = "https://api.spotify.com/v1/me/playlists?limit=50";

  while (next && items.length < limit) {
    const res = await fetch(next, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error(`Failed to fetch playlists (${res.status}).`);
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
    if (!res.ok) throw new Error(`Failed to fetch tracks for ${playlistId} (${res.status}).`);
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
  const ownerName = p.owner?.display_name || null;
  const ownerIsMe = ownerId && myUserId ? ownerId === myUserId : false;

  return {
    id: p.id,
    name: p.name,
    image: p.images?.[0]?.url || null,
    url: p.external_urls?.spotify || null,
    totalTracks: p.tracks?.total ?? 0,

    ownerIsMe,
    ownerId,
    ownerName,
    ownerLabel: ownerIsMe ? "by me" : (ownerName ? `by ${ownerName}` : "by others")
  };
}

function msFromItem(it) {
  const obj = it?.track;
  if (!obj) return 0;
  const ms = Number(obj.duration_ms);
  return Number.isFinite(ms) ? ms : 0;
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
