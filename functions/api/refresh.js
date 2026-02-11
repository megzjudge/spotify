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

    const YEAR_SUMMARY_PLAYLIST_IDS = [
      "37i9dQZEVXcXHWVVT0lfDq"
    ];

    const MAX_PLAYLISTS = clampInt(body?.maxPlaylists, 1, 200, 120);
    const MAX_TRACKS_PER_PLAYLIST = clampInt(body?.maxTracksPerPlaylist, 1, 500, 250);

    const NOT_PUBLIC_PREFIXES = ["NP:", "[Not Public]"];
    const NOT_PUBLIC_TAG = "#notpublic";

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

    const seen = new Set(playlistsRaw.map(p => p?.id).filter(Boolean));
    for (const id of ALLOWLIST_IDS) {
      if (!id || seen.has(id)) continue;
      try {
        const p = await fetchPlaylist(accessToken, id);
        playlistsRaw.push(p);
      } catch {}
    }

    /***********************
     * FILTER PLAYLISTS
     ***********************/
    const filtered = playlistsRaw.filter(p => {
      if (!p?.id) return false;
      if (ALLOWLIST_IDS.has(p.id)) return true;

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
    const othersPlaylists = normalized.filter(p => OTHERS_PLAYLIST_IDS.includes(p.id));
    const yearSummaryPlaylists = normalized.filter(p => YEAR_SUMMARY_PLAYLIST_IDS.includes(p.id));

    const normal = normalized.filter(p =>
      p.id !== PODCAST_PLAYLIST_ID &&
      !OTHERS_PLAYLIST_IDS.includes(p.id) &&
      !YEAR_SUMMARY_PLAYLIST_IDS.includes(p.id)
    );

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
     * METRICS (FIXED)
     ***********************/
    let totalSongs = 0;
    let totalSongMs = 0;

    for (const p of normal) {
      const items = await fetchPlaylistItemsBounded(
        accessToken,
        p.id,
        MAX_TRACKS_PER_PLAYLIST
      );

      for (const it of items) {
        const obj = it?.track;
        if (!obj || obj.type !== "track") continue;

        const ms = Number(obj.duration_ms);
        if (!Number.isFinite(ms)) continue;

        totalSongs += 1;
        totalSongMs += ms;
      }
    }

    let podcastEpisodes = 0;
    let podcastMs = 0;

    if (podcastPlaylist) {
      const items = await fetchPlaylistItemsBounded(
        accessToken,
        podcastPlaylist.id,
        MAX_TRACKS_PER_PLAYLIST
      );

      for (const it of items) {
        const obj = it?.track;
        if (!obj || obj.type !== "episode") continue;

        const ms = Number(obj.duration_ms);
        if (!Number.isFinite(ms)) continue;

        podcastEpisodes += 1;
        podcastMs += ms;
      }
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

      sections: { dailyMix, top, other },
      othersPlaylists,
      yearSummaryPlaylists,
      podcastPlaylist
    });

  } catch (err) {
    return json({
      error: "Refresh failed",
      message: String(err?.message || err),
      stack: String(err?.stack || "")
    }, 500);
  }
}

/* =========================
   HELPERS (unchanged)
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

  const data = await res.json();
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
  const r = await fetch(`https://api.spotify.com/v1/playlists/${id}`, {
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
    const d = await r.json();
    out.push(...(d.items || []));
    next = d.next;
  }
  return out.slice(0, limit);
}

async function fetchPlaylistItemsBounded(token, playlistId, max) {
  let out = [];
  let next = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;
  while (next && out.length < max) {
    const r = await fetch(next, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const d = await r.json();
    out.push(...(d.items || []));
    next = d.next;
  }
  return out.slice(0, max);
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
    ownerLabel: ownerIsMe ? "by me" : (p.owner?.display_name ? `by ${p.owner.display_name}` : "by others")
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
    "Access-Control-Allow-Headers": "Content-Type,Accept"
  };
}
