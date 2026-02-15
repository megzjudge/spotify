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

    // limit here means "how many normalized items to return" (bounded)
    // We'll page Spotify (max 100 per request) until we hit this.
    const limit = clampInt(body.limit, 0, 500, 200);

    // NEW: offset support (for worker pagination)
    // offset is the starting Spotify offset for playlist tracks endpoint.
    const offset = clampInt(body.offset, 0, 1000000, 0);

    if (!playlistId) {
      return json({ error: "Missing playlistId" }, 400);
    }

    const token = await getUserAccessToken(env);

    // Fetch /me (to label owners)
    const me = await fetchMe(token);
    const myUserId = me?.id || null;

    // Fetch playlist meta
    const pl = await fetchPlaylist(token, playlistId);
    const playlist = normalizePlaylist(pl, myUserId);

    // Items
    const { items, nextOffset, hasMore } =
      limit === 0
        ? { items: [], nextOffset: null, hasMore: false }
        : await fetchPlaylistItemsBounded(token, playlistId, limit, offset);

    let normalizedItems = items.map(normalizeItem).filter(Boolean);

    // ✅ ENRICH: playlist-items often omit episode artwork.
    const missingEpIds = normalizedItems
      .filter((x) => x.type === "episode" && !x.image && x.id)
      .map((x) => x.id);

    if (missingEpIds.length) {
      const eps = await fetchEpisodesByIds(token, missingEpIds);

      const idToImg = new Map(
        (eps || []).map((ep) => [ep?.id, pickFirstImageUrl(ep?.images) || null])
      );

      normalizedItems = normalizedItems.map((x) => {
        if (x.type !== "episode" || x.image || !x.id) return x;
        const img = idToImg.get(x.id) || null;
        return img ? { ...x, image: img } : x;
      });
    }

    // ✅ ENRICH: add release_date (publish date) for episodes
    // Many playlist item objects don't include the episode's release_date. Fetch episodes in batches and merge.
    const missingReleaseEpIds = normalizedItems
      .filter((x) => x.type === "episode" && !x.releaseDate && !x.release_date && x.id)
      .map((x) => x.id);

    if (missingReleaseEpIds.length) {
      const eps = await fetchEpisodesByIds(token, missingReleaseEpIds);
      const idToRelease = new Map((eps || []).map((ep) => [ep?.id, ep?.release_date || null]));

      normalizedItems = normalizedItems.map((x) => {
        if (x.type !== "episode" || !x.id) return x;
        const rel = idToRelease.get(x.id) || null;
        if (!rel) return x;
        // set both camelCase and snake_case to make frontend robust
        return { ...x, releaseDate: rel, release_date: rel };
      });
    }

    return json(
      {
        playlist,
        items: normalizedItems,

        // NEW: worker-friendly paging hints
        nextOffset,
        hasMore
      },
      200
    );
  } catch (err) {
    return json(
      {
        error: "Playlist fetch failed",
        message: String(err?.message || err),
        status: err?.status || null,
        details: err?.details || null,
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
    throw new Error(
      "Missing Spotify OAuth secrets (SPOTIFY_PROFILE, SPOTIFY_KEY, SPOTIFY_REFRESH_TOKEN)."
    );
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
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {}

  if (!res.ok || !data?.access_token) {
    const e = new Error(`Failed to refresh access token (${res.status})`);
    e.status = res.status;
    e.details = { endpoint: "token", body: data || text };
    throw e;
  }

  return data.access_token;
}

/* =========================
   SPOTIFY API (with rich errors)
========================= */
async function fetchJsonOrThrow(url, token, label) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    const e = new Error(`${label} failed (${res.status})`);
    e.status = res.status;
    e.details = { endpoint: url, body: data || text };
    throw e;
  }

  return data;
}

async function fetchMe(token) {
  return fetchJsonOrThrow("https://api.spotify.com/v1/me", token, "/me");
}

async function fetchPlaylist(token, playlistId) {
  return fetchJsonOrThrow(
    `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}`,
    token,
    "playlist meta"
  );
}

/**
 * Fetch up to maxItems starting at startOffset.
 * Returns raw playlist track objects as Spotify returns them.
 *
 * Also returns nextOffset/hasMore to support client-side paging.
 */
async function fetchPlaylistItemsBounded(token, playlistId, maxItems, startOffset) {
  let items = [];
  let offset = startOffset;

  // Spotify supports limit up to 100 per call for playlist tracks.
  // We'll request min(100, remaining) until:
  // - no next page
  // - we reached maxItems
  // - Spotify returns fewer than requested (end)
  let hasMore = true;
  let nextOffset = null;

  while (hasMore && items.length < maxItems) {
    const remaining = maxItems - items.length;
    const pageLimit = Math.min(100, remaining);

    const url =
      `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/tracks` +
      `?limit=${pageLimit}&offset=${offset}`;

    const data = await fetchJsonOrThrow(url, token, "playlist items");

    const pageItems = Array.isArray(data.items) ? data.items : [];
    items = items.concat(pageItems);

    // Spotify gives next as a URL or null
    if (data.next) {
      offset += pageItems.length || pageLimit;
      hasMore = true;
      nextOffset = offset;
    } else {
      hasMore = false;
      nextOffset = null;
    }

    // If Spotify gave us fewer than requested, stop
    if (pageItems.length < pageLimit) {
      hasMore = false;
      nextOffset = null;
    }
  }

  return { items, nextOffset, hasMore };
}

// ✅ Episode enrichment lookup (50 ids per request)
async function fetchEpisodesByIds(token, ids) {
  const clean = (ids || [])
    .map((x) => String(x || "").trim())
    .filter(Boolean);

  if (!clean.length) return [];

  const out = [];
  for (let i = 0; i < clean.length; i += 50) {
    const chunk = clean.slice(i, i + 50);
    const url = `https://api.spotify.com/v1/episodes?ids=${encodeURIComponent(chunk.join(","))}`;
    const data = await fetchJsonOrThrow(url, token, "episodes lookup");
    out.push(...(data.episodes || []));
  }
  return out;
}

/* =========================
   NORMALIZATION
========================= */

function pickFirstImageUrl(images) {
  if (!Array.isArray(images) || !images.length) return null;
  return images?.[0]?.url || null;
}

function normalizePlaylist(p, myUserId) {
  const ownerId = p.owner?.id || null;
  const ownerIsMe = myUserId ? ownerId === myUserId : false;
  const ownerLabel = ownerIsMe ? "by me" : "by others";

  return {
    id: p.id,
    name: p.name,
    image: pickFirstImageUrl(p.images) || null,
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
      addedAt: it.added_at || null,
      image: pickFirstImageUrl(obj.album?.images) || null
    };
  }

  if (type === "episode") {
    const episodeImage =
      pickFirstImageUrl(obj.images) ||
      pickFirstImageUrl(obj.show?.images) ||
      null;

    return {
      type: "episode",
      id: obj.id,
      name: obj.name,
      artists: obj.show?.name ? [obj.show.name] : [],
      url,
      durationMs,
      addedAt: it.added_at || null,
      image: episodeImage
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
