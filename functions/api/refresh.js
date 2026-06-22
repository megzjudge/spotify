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
      "4OXFjf05aU4K1B17AmA7ew",
      "37i9dQZF1DX5mB2C8gBeUM"
    ];

    const YEAR_SUMMARY_PLAYLIST_IDS = [
      "37i9dQZEVXd4WLIGflDMQQ"
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
      ...OTHERS_PLAYLIST_IDS,
      ...YEAR_SUMMARY_PLAYLIST_IDS
    ]);

    /***********************
     * USER + PLAYLISTS
     ***********************/
    const me = await fetchMe(accessToken);
    const myUserId = me?.id;
    if (!myUserId) throw new Error("Could not resolve Spotify user ID.");

    let playlistsRaw = await fetchMyPlaylists(accessToken, MAX_PLAYLISTS);

    // Ensure allowlisted playlists are included even if not returned in /me/playlists
    const seen = new Set(playlistsRaw.map(p => p?.id).filter(Boolean));
    for (const id of ALLOWLIST_IDS) {
      if (!id || seen.has(id)) continue;
      try {
        const p = await fetchPlaylist(accessToken, id);
        playlistsRaw.push(p);
      } catch {
        // ignore
      }
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

    /***********************
     * YEAR SUMMARY DISCOVERY
     * Spotify Wrapped / "Your Top Songs 20XX" playlists are Spotify-owned,
     * so discover them from the raw library list before the owner filter.
     ***********************/
    function isYearSummaryPlaylist(p) {
      const name = String(p?.name || "").toLowerCase().trim();
      if (!name) return false;

      const strong = [
        "wrapped",
        "year in review",
        "your top songs",
        "your top artists",
        "top songs ",
        "top artists ",
        "on repeat",
        "repeat rewind"
      ];
      if (strong.some(k => name.includes(k))) return true;

      const yearMatch = name.match(/\b(2020|2021|2022|2023|2024|2025|2026|2027|2028|2029|2030)\b/);
      if (yearMatch && (name.includes("top") || name.includes("wrapped") || name.includes("year"))) return true;

      return false;
    }

    const yearSummaryPlaylists = [];
    const yearSeen = new Set();

    for (const id of YEAR_SUMMARY_PLAYLIST_IDS) {
      if (yearSeen.has(id)) continue;

      const fromRaw = playlistsRaw.find(p => p?.id === id);
      let meta = null;

      if (fromRaw) {
        meta = normalizePlaylistMeta(fromRaw, myUserId);
      } else {
        try {
          const p = await fetchPlaylist(accessToken, id);
          meta = normalizePlaylistMeta(p, myUserId);
        } catch {
          // ignore
        }
      }

      if (meta) {
        yearSummaryPlaylists.push(meta);
        yearSeen.add(id);
      }
    }

    for (const p of playlistsRaw) {
      if (!p?.id || yearSeen.has(p.id) || !isYearSummaryPlaylist(p)) continue;
      yearSummaryPlaylists.push(normalizePlaylistMeta(p, myUserId));
      yearSeen.add(p.id);
      if (yearSummaryPlaylists.length >= 12) break;
    }

    const yearIds = new Set(yearSummaryPlaylists.map(p => p.id));

    const podcastPlaylist = normalized.find(p => p.id === PODCAST_PLAYLIST_ID) || null;

    const othersPlaylists = [];
    const othersSeen = new Set();

    for (const id of OTHERS_PLAYLIST_IDS) {
      if (othersSeen.has(id)) continue;

      const fromNorm = normalized.find(p => p.id === id);
      const fromRaw = playlistsRaw.find(p => p?.id === id);
      let meta = fromNorm || (fromRaw ? normalizePlaylistMeta(fromRaw, myUserId) : null);

      if (!meta) {
        try {
          const p = await fetchPlaylist(accessToken, id);
          meta = normalizePlaylistMeta(p, myUserId);
        } catch {
          // ignore
        }
      }

      if (meta) {
        othersPlaylists.push(meta);
        othersSeen.add(id);
      }
    }

    const candidates = normalized.filter(p =>
      p.id !== PODCAST_PLAYLIST_ID &&
      !OTHERS_PLAYLIST_IDS.includes(p.id) &&
      !yearIds.has(p.id)
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
      yearSummaryPlaylists,
      podcastPlaylist
    };

    if (body?.debug) {
      resp.debug = {
        fetchedPlaylists: playlistsRaw.length,
        filteredPlaylists: normalized.length,
        yearSummaryMatched: yearSummaryPlaylists.map(p => ({ id: p.id, name: p.name })),
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

async function fetchMyPlaylists(token, limit) {
  let out = [];
  let next = "https://api.spotify.com/v1/me/playlists?limit=50";
  while (next && out.length < limit) {
    const r = await fetch(next, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const d = await r.json().catch(() => ({}));
    out.push(...(d.items || []));
    next = d.next;
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
