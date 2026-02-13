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
     * CONFIG
     ***********************/
    const PODCAST_PLAYLIST_ID = "2tHrihmpYzDbJ8rit7HtFR";

    const OTHERS_PLAYLIST_IDS = [
      "71z6BdHlnfNj4DKRhuu1Fk",
      "7jYNznHoIYgJBzwT5jpoOe",
      "41PZG18MrSTagagiIaiG4X",
      "37i9dQZF1DX5mB2C8gBeUM",
      "37i9dQZF1EQnsJ0xmvpihE"
    ];

    const MAX_PLAYLISTS = clampInt(body?.maxPlaylists, 1, 200, 120);

    // ✅ This still exists, but now ONLY used for lightweight/bounded calls if you want them later.
    // Metrics use full pagination (see HARD_CAP_ITEMS_PER_PLAYLIST).
    const MAX_TRACKS_PER_PLAYLIST = clampInt(body?.maxTracksPerPlaylist, 1, 500, 250);

    // ✅ Safety cap for *full* pagination in metrics (prevents runaway)
    const HARD_CAP_ITEMS_PER_PLAYLIST = clampInt(body?.hardCapItemsPerPlaylist, 500, 20000, 10000);

    const NOT_PUBLIC_PREFIXES = ["NP:", "[Not Public]"];
    const NOT_PUBLIC_TAG = "#notpublic";

    // Only hard-allowlist things you *know* work for your token
    const ALLOWLIST_IDS = new Set([
      PODCAST_PLAYLIST_ID,
      ...OTHERS_PLAYLIST_IDS
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
      if (ALLOWLIST_IDS.has(p.id)) return true;

      // Keep only your public playlists (same as your current rules)
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
        "top artists "
      ];
      if (strong.some(k => name.includes(k))) return true;

      const yearMatch = name.match(/\b(2020|2021|2022|2023|2024|2025|2026|2027|2028|2029|2030)\b/);
      if (yearMatch && (name.includes("top") || name.includes("wrapped") || name.includes("year"))) return true;

      return false;
    }

    const podcastPlaylist = normalized.find(p => p.id === PODCAST_PLAYLIST_ID) || null;
    const othersPlaylists = normalized.filter(p => OTHERS_PLAYLIST_IDS.includes(p.id));

    const candidates = normalized.filter(p =>
      p.id !== PODCAST_PLAYLIST_ID &&
      !OTHERS_PLAYLIST_IDS.includes(p.id)
    );

    const yearSummaryPlaylists = candidates
      .filter(isYearSummaryPlaylist)
      .slice(0, 12);

    const yearIds = new Set(yearSummaryPlaylists.map(p => p.id));
    const normal = candidates.filter(p => !yearIds.has(p.id));

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
     * METRICS (✅ FIXED: FULL PAGINATION for durations)
     ***********************/
    const seenSongKeys = new Set();
    let totalSongs = 0;
    let totalSongMs = 0;

    function songKeyFromTrack(obj) {
      // Prefer stable track id. Fallback for local/null ids.
      const id = obj?.id ? String(obj.id) : "";
      if (id) return `id:${id}`;

      const name = String(obj?.name || "").trim().toLowerCase();
      const artists = Array.isArray(obj?.artists)
        ? obj.artists.map(a => String(a?.name || "").trim().toLowerCase()).filter(Boolean).join("|")
        : "";
      const ms = Number(obj?.duration_ms) || 0;

      return `local:${name}::${artists}::${ms}`;
    }

    // ✅ Fetch ALL items for song metrics (bounded only by HARD_CAP_ITEMS_PER_PLAYLIST)
    for (const p of normal) {
      const items = await fetchPlaylistItemsAll(
        accessToken,
        p.id,
        HARD_CAP_ITEMS_PER_PLAYLIST
      );

      for (const it of items) {
        const obj = it?.track;
        if (!obj || obj.type !== "track") continue;

        const ms = Number(obj.duration_ms);
        if (!Number.isFinite(ms)) continue;

        const key = songKeyFromTrack(obj);
        if (seenSongKeys.has(key)) continue;

        seenSongKeys.add(key);
        totalSongs += 1;
        totalSongMs += ms;
      }
    }

    // Podcast metrics (also full pagination, bounded by HARD_CAP_ITEMS_PER_PLAYLIST)
    const seenEpKeys = new Set();
    let podcastEpisodes = 0;
    let podcastMs = 0;

    if (podcastPlaylist) {
      const items = await fetchPlaylistItemsAll(
        accessToken,
        podcastPlaylist.id,
        HARD_CAP_ITEMS_PER_PLAYLIST
      );

      for (const it of items) {
        const obj = it?.track;
        if (!obj || obj.type !== "episode") continue;

        const ms = Number(obj.duration_ms);
        if (!Number.isFinite(ms)) continue;

        const id = obj?.id ? String(obj.id) : "";
        const key = id ? `id:${id}` : `local:${String(obj?.name || "").trim().toLowerCase()}::${ms}`;
        if (seenEpKeys.has(key)) continue;

        seenEpKeys.add(key);
        podcastEpisodes += 1;
        podcastMs += ms;
      }
    }

    /***********************
     * RESPONSE
     ***********************/
    const resp = {
      lastUpdated: new Date().toISOString(),

      totals: {
        playlists: normal.length,
        songs: totalSongs,
        songMs: totalSongMs,
        podcastEpisodes,
        podcastMs
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
        uniqueSongKeys: seenSongKeys.size,
        hardCapItemsPerPlaylist: HARD_CAP_ITEMS_PER_PLAYLIST
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

// Old bounded helper (kept, in case you still want it elsewhere)
async function fetchPlaylistItemsBounded(token, playlistId, max) {
  let out = [];
  let next = `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/tracks?limit=100`;
  while (next && out.length < max) {
    const r = await fetch(next, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const d = await r.json().catch(() => ({}));
    out.push(...(d.items || []));
    next = d.next;
  }
  return out.slice(0, max);
}

// ✅ NEW: full pagination for metrics (with hard safety cap + reduced fields payload)
async function fetchPlaylistItemsAll(token, playlistId, hardCap) {
  let out = [];
  let offset = 0;

  // Reduce payload size to what metrics need
  const FIELDS = "items(track(id,name,type,duration_ms,artists(name))),next";

  while (out.length < hardCap) {
    const url =
      `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/tracks` +
      `?limit=100&offset=${offset}&fields=${encodeURIComponent(FIELDS)}`;

    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`Failed playlist items fetch (${playlistId}) HTTP ${r.status}: ${txt.slice(0, 180)}`);
    }

    const d = await r.json().catch(() => ({}));
    const items = Array.isArray(d?.items) ? d.items : [];

    out.push(...items);

    // Spotify will return fewer than limit when exhausted
    if (!items.length || !d?.next) break;

    offset += items.length;
    if (items.length < 100) break;
  }

  return out.slice(0, hardCap);
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
