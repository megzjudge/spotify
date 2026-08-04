// functions/api/refresh.js

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestPost(context) {
  const { env, request } = context;

  try {
    let body = {};
    try { body = await request.json(); } catch {}

    const accessToken = await getUserAccessToken(env);

    /***********************
     * CONFIG
     ***********************/
    const PODCAST_PLAYLIST_ID = "2tHrihmpYzDbJ8rit7HtFR";

    const OTHERS_PLAYLIST_IDS = [
      "41PZG18MrSTagagiIaiG4X",
      "71z6BdHlnfNj4DKRhuu1Fk",
      "7jYNznHoIYgJBzwT5jpoOe",
      "4OXFjf05aU4K1B17AmA7ew"
    ];

    const HIDE_PLAYLIST_IDS = new Set([
      // "PUT_PLAYLIST_ID_HERE",
    ]);

    const MAX_PLAYLISTS = clampInt(body?.maxPlaylists, 1, 200, 120);

    const NOT_PUBLIC_PREFIXES = ["NP:", "[Not Public]"];
    const NOT_PUBLIC_TAG = "#notpublic";

    // Hard allowlist for “must show”
    const ALLOWLIST_IDS = new Set([
      PODCAST_PLAYLIST_ID,
      ...OTHERS_PLAYLIST_IDS
    ]);

    /***********************
     * USER + PLAYLISTS
     ***********************/
    // /me and /me/playlists don't depend on each other — run them together
    // instead of paying two sequential round-trips to Spotify.
    const [me, playlistsRaw0] = await Promise.all([
      fetchMe(accessToken),
      fetchMyPlaylists(accessToken, MAX_PLAYLISTS)
    ]);
    const myUserId = me?.id;
    if (!myUserId) throw new Error("Could not resolve Spotify user ID.");

    let playlistsRaw = playlistsRaw0;

    // Ensure allowlisted playlists are included even if not returned in /me/playlists.
    // These lookups are independent of each other, so fire them in parallel.
    const seen = new Set(playlistsRaw.map(p => p?.id).filter(Boolean));
    const missingAllowlistIds = [...ALLOWLIST_IDS].filter(id => id && !seen.has(id));
    const fetchedAllowlisted = await Promise.all(
      missingAllowlistIds.map(id => fetchPlaylist(accessToken, id).catch(() => null))
    );
    for (const p of fetchedAllowlisted) {
      if (p) playlistsRaw.push(p);
    }

    /***********************
     * FILTER PLAYLISTS
     ***********************/
    const filtered = playlistsRaw.filter(p => {
      if (!p?.id) return false;

      if (HIDE_PLAYLIST_IDS.has(p.id)) return false;

      // keep allowlisted playlists even if not "mine"
      if (ALLOWLIST_IDS.has(p.id)) return true;

      // Keep only your public playlists
      if (p.owner?.id !== myUserId) return false;
      if (p.public === false) return false;

      const name = (p.name || "").trim();
      const desc = String(p.description || "").toLowerCase();

      if (NOT_PUBLIC_PREFIXES.some(pre => name.startsWith(pre))) return false;
      if (desc.includes(NOT_PUBLIC_TAG)) return false;

      return true;
    });

    const normalized = filtered.map(p => normalizePlaylistMeta(p, myUserId));

    const podcastPlaylist = normalized.find(p => p.id === PODCAST_PLAYLIST_ID) || null;

    // Resolve each "others" playlist independently and in parallel — Promise.all
    // keeps them in OTHERS_PLAYLIST_IDS order regardless of which resolves first.
    const uniqueOthersIds = [...new Set(OTHERS_PLAYLIST_IDS)];
    const othersResolved = await Promise.all(
      uniqueOthersIds.map(async id => {
        const fromNorm = normalized.find(p => p.id === id);
        const fromRaw = playlistsRaw.find(p => p?.id === id);
        if (fromNorm) return fromNorm;
        if (fromRaw) return normalizePlaylistMeta(fromRaw, myUserId);

        try {
          const p = await fetchPlaylist(accessToken, id);
          return normalizePlaylistMeta(p, myUserId);
        } catch {
          return null;
        }
      })
    );
    const othersPlaylists = othersResolved.filter(Boolean);

    const candidates = normalized.filter(p =>
      p.id !== PODCAST_PLAYLIST_ID &&
      !OTHERS_PLAYLIST_IDS.includes(p.id)
    );

    const normal = candidates;

    /***********************
     * SECTIONS
     ***********************/
    const dailyMix = normal.filter(p => (p.name || "").startsWith("Daily Mix:"));
    const top = normal.filter(p => (p.name || "").startsWith("Top"));
    const other = normal.filter(p =>
      !dailyMix.some(x => x.id === p.id) &&
      !top.some(x => x.id === p.id)
    );

    /***********************
     * METRICS
     *
     * ✅ totals.songs is metadata-based (fast)
     * ✅ totals.songMsApprox is immediate
     * ✅ exact hours are computed client-side by your Web Worker using /api/playlist
     ***********************/
    const totalSongs = normal.reduce((acc, p) => acc + (Number(p.totalTracks) || 0), 0);

    const APPROX_MIN_PER_SONG = 3;
    const songMsApprox = totalSongs * APPROX_MIN_PER_SONG * 60_000;

    // Provide the exact playlist IDs the worker should compute from:
    const computePlaylistIds = normal.map(p => p.id).filter(Boolean);

    const resp = {
      lastUpdated: new Date().toISOString(),

      totals: {
        playlists: normal.length,
        songs: totalSongs,

        songMsApprox,

        // server no longer pretends to compute exact
        songMsExact: null,
        songMsExactUpdatedAt: null,
        songHoursStatus: "approx",

        // kept for backward compatibility
        songMs: null,

        // NEW: worker input
        songCompute: {
          playlistIds: computePlaylistIds,
          avgMinutesPerSong: APPROX_MIN_PER_SONG
        },

        podcastEpisodes: null,
        podcastMs: null
      },

      sections: { dailyMix, top, other },
      othersPlaylists,
      podcastPlaylist
    };

    if (body?.debug) {
      resp.debug = {
        fetchedPlaylists: playlistsRaw.length,
        filteredPlaylists: normalized.length,
        hideIdsCount: HIDE_PLAYLIST_IDS.size,
        allowlist: Array.from(ALLOWLIST_IDS)
      };
    }

    return json(resp);

  } catch (err) {
    return json({
      error: "Refresh failed",
      message: String(err?.message || err),
      stack: String(err?.stack || "")
    }, 500);
  }
}

/* =========================
   HELPERS
========================= */

// Reused across requests handled by the same warm isolate, same pattern as
// playlist.js's TOKEN_CACHE — skips a full Spotify token round-trip on every
// /api/refresh call.
const TOKEN_CACHE = { token: null, expiresAt: 0 };

async function getUserAccessToken(env) {
  const now = Date.now();
  if (TOKEN_CACHE.token && TOKEN_CACHE.expiresAt - 60000 > now) {
    return TOKEN_CACHE.token;
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
    throw new Error(`Missing Spotify OAuth env vars: ${missing.join(", ")}`);
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
    throw new Error(`Failed to refresh Spotify access token: ${detail}`);
  }

  const expiresIn = Number(data.expires_in) || 3600;
  TOKEN_CACHE.token = data.access_token;
  TOKEN_CACHE.expiresAt = Date.now() + expiresIn * 1000;

  return TOKEN_CACHE.token;
}

async function fetchMe(token) {
  const r = await fetch("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) throw new Error("Failed /me");
  return r.json();
}

async function fetchPlaylist(token, id) {
  const r = await fetch(`https://api.spotify.com/v1/playlists/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) throw new Error("Failed playlist fetch");
  return r.json();
}

async function fetchPlaylistsPage(token, offset, pageSize) {
  const r = await fetch(`https://api.spotify.com/v1/me/playlists?limit=${pageSize}&offset=${offset}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return r.json().catch(() => ({}));
}

async function fetchMyPlaylists(token, limit) {
  const pageSize = 50;

  // First page tells us the real total, so we know how many more pages are
  // needed — fetch those in parallel instead of following `next` one at a time.
  const first = await fetchPlaylistsPage(token, 0, pageSize);
  const out = [...(first.items || [])];
  const total = Math.min(Number(first.total) || out.length, limit);

  const remainingOffsets = [];
  for (let offset = pageSize; offset < total; offset += pageSize) {
    remainingOffsets.push(offset);
  }

  if (remainingOffsets.length) {
    const pages = await Promise.all(
      remainingOffsets.map(offset => fetchPlaylistsPage(token, offset, pageSize))
    );
    for (const d of pages) out.push(...(d.items || []));
  }

  return out.slice(0, limit);
}

function normalizePlaylistMeta(p, myUserId) {
  const ownerId = p.owner?.id || null;
  const ownerIsMe = ownerId === myUserId;
  return {
    id: p.id,
    name: p.name,
    image: p.images?.[0]?.url || null,
    url: p.external_urls?.spotify || null,
    totalTracks: p.tracks?.total ?? 0,
    ownerIsMe,
    ownerLabel: ownerIsMe
      ? "by me"
      : (p.owner?.display_name ? `by ${p.owner.display_name}` : "by others")
  };
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
