// functions/api/playlist.js

/* =========================
   Exports: Cloudflare Pages Functions
   ========================= */
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

    // how many normalized items to return (bounded)
    const limit = clampInt(body.limit, 0, 500, 200);

    // offset support (for worker pagination)
    const offset = clampInt(body.offset, 0, 1000000, 0);

    if (!playlistId) {
      return json({ error: "Missing playlistId" }, 400);
    }

    const token = await getUserAccessToken(env);

    // Fetch /me (to label owners)
    const me = await fetchMe(token);
    const myUserId = me?.id || null;

    // Fetch playlist meta (cached)
    const pl = await fetchPlaylist(token, playlistId);
    const playlist = normalizePlaylist(pl, myUserId);

    // Items (may be paged)
    const { items, nextOffset, hasMore } =
      limit === 0
        ? { items: [], nextOffset: null, hasMore: false }
        : await fetchPlaylistItemsBounded(token, playlistId, limit, offset);

    let normalizedItems = items.map(normalizeItem).filter(Boolean);

    // ENRICH: episodes sometimes miss images; lookup in batches
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

    return json(
      {
        playlist,
        items: normalizedItems,
        // worker-friendly paging hints
        nextOffset,
        hasMore
      },
      200
    );
  } catch (err) {
    // surface rich error info
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
   Simple in-memory caches (per worker instance)
   - TOKEN_CACHE reduces token endpoint calls
   - PLAYLIST_META_CACHE reduces repeated meta lookups
========================= */
const TOKEN_CACHE = { token: null, expiresAt: 0 }; // epoch ms
const PLAYLIST_META_CACHE = new Map(); // key -> { data, expiresAt }

/* =========================
   AUTH: cached refresh-token flow
   - Accepts common env names; logs presence for debugging
========================= */
async function getUserAccessToken(env) {
  const now = Date.now();

  // return cached token if still valid (60s safety margin)
  if (TOKEN_CACHE.token && TOKEN_CACHE.expiresAt - 60000 > now) {
    return TOKEN_CACHE.token;
  }

  // resolve env names (accept a few variants)
  const clientId = env.SPOTIFY_PROFILE || env.SPOTIFY_CLIENT_ID || null;
  const clientSecret = env.SPOTIFY_KEY || env.SPOTIFY_CLIENT_SECRET || null;
  const refreshToken =
    env.SPOTIFY_REFRESH_TOKEN || env.SPOTIFY_RT || env.SPOTIFY_REFRESH || null;

  const present = {
    SPOTIFY_PROFILE: !!env.SPOTIFY_PROFILE,
    SPOTIFY_CLIENT_ID: !!env.SPOTIFY_CLIENT_ID,
    SPOTIFY_KEY: !!env.SPOTIFY_KEY,
    SPOTIFY_CLIENT_SECRET: !!env.SPOTIFY_CLIENT_SECRET,
    SPOTIFY_REFRESH_TOKEN: !!env.SPOTIFY_REFRESH_TOKEN
  };
  console.info("getUserAccessToken: env keys present:", present);

  if (!clientId || !clientSecret || !refreshToken) {
    const err = new Error(
      "Missing Spotify OAuth secrets (expected SPOTIFY_PROFILE or SPOTIFY_CLIENT_ID, SPOTIFY_KEY or SPOTIFY_CLIENT_SECRET, and SPOTIFY_REFRESH_TOKEN)."
    );
    err.details = { envPresent: present };
    console.error("getUserAccessToken: missing env", err.details);
    throw err;
  }

  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
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

  const tokenText = await tokenRes.text().catch(() => "");
  let tokenData = {};
  try {
    tokenData = tokenText ? JSON.parse(tokenText) : {};
  } catch (e) {
    tokenData = { rawText: tokenText };
  }

  console.info(
    "getUserAccessToken: token endpoint status:",
    tokenRes.status,
    "bodyPreview:",
    typeof tokenText === "string" ? tokenText.slice(0, 1000) : tokenText
  );

  if (!tokenRes.ok || !tokenData?.access_token) {
    const e = new Error(`Failed to refresh access token (${tokenRes.status})`);
    e.status = tokenRes.status;
    e.details = { endpoint: "token", body: tokenData || tokenText };
    console.error("getUserAccessToken: token refresh failed:", e.details);
    throw e;
  }

  // cache using expires_in from Spotify (seconds)
  const expiresIn = Number(tokenData.expires_in) || 3600;
  TOKEN_CACHE.token = tokenData.access_token;
  TOKEN_CACHE.expiresAt = Date.now() + expiresIn * 1000;

  console.info("getUserAccessToken: cached token (expires_in seconds):", expiresIn);
  return TOKEN_CACHE.token;
}

/* =========================
   Robust JSON fetch with retries/backoff
   - respects Retry-After header when present
   - retries on 429 and 5xx
========================= */
async function fetchJsonWithRetries(url, token, label, { maxRetries = 3, baseDelay = 400 } = {}) {
  let attempt = 0;

  while (true) {
    attempt++;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const text = await res.text().catch(() => "");
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}

    // success path
    if (res.ok) {
      return data;
    }

    // try to parse Retry-After header
    const retryAfterRaw = res.headers && typeof res.headers.get === "function"
      ? res.headers.get("Retry-After") || null
      : null;

    let retryAfterMs = null;
    if (retryAfterRaw) {
      if (/^\d+$/.test(retryAfterRaw.trim())) {
        retryAfterMs = Number(retryAfterRaw.trim()) * 1000;
      } else {
        const parsed = Date.parse(retryAfterRaw);
        if (!isNaN(parsed)) retryAfterMs = parsed - Date.now();
      }
    }

    const status = res.status || 0;
    const isRetryable = status === 429 || (status >= 500 && status < 600);

    // no more retries or not retryable -> throw rich error
    if (!isRetryable || attempt > maxRetries) {
      const e = new Error(`${label} failed (${status})`);
      e.status = status;
      e.details = { endpoint: url, body: data || text, retryAfter: retryAfterRaw ?? null };
      throw e;
    }

    // compute delay: prefer Retry-After if provided, otherwise exponential backoff with jitter
    const delayMs = retryAfterMs != null
      ? Math.max(0, retryAfterMs)
      : Math.round(baseDelay * Math.pow(2, attempt - 1) * (0.8 + Math.random() * 0.4));

    console.warn(
      `${label} (${status}) - attempt ${attempt}/${maxRetries}, retrying in ${delayMs}ms`,
      { endpoint: url, retryAfter: retryAfterRaw, bodyPreview: typeof text === "string" ? text.slice(0, 200) : text }
    );

    await new Promise((r) => setTimeout(r, delayMs));
    // retry loop
  }
}

/* =========================
   API wrappers (use fetchJsonWithRetries)
========================= */
async function fetchMe(token) {
  return fetchJsonWithRetries("https://api.spotify.com/v1/me", token, "/me", { maxRetries: 2 });
}

async function fetchPlaylist(token, playlistId) {
  const key = `pl:${playlistId}`;
  const cached = readPlaylistMetaCache(key);
  if (cached) return cached;

  const data = await fetchJsonWithRetries(
    `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}`,
    token,
    "playlist meta",
    { maxRetries: 3 }
  );

  cachePlaylistMeta(key, data, 60_000); // cache for 60s
  return data;
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

    const data = await fetchJsonWithRetries(url, token, "playlist items", { maxRetries: 3 });

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

// Episode enrichment lookup (50 ids per request)
async function fetchEpisodesByIds(token, ids) {
  const clean = (ids || []).map((x) => String(x || "").trim()).filter(Boolean);
  if (!clean.length) return [];

  const out = [];
  for (let i = 0; i < clean.length; i += 50) {
    const chunk = clean.slice(i, i + 50);
    const url = `https://api.spotify.com/v1/episodes?ids=${encodeURIComponent(chunk.join(","))}`;
    const data = await fetchJsonWithRetries(url, token, "episodes lookup", { maxRetries: 2 });
    out.push(...(data.episodes || []));
  }
  return out;
}

/* =========================
   Simple playlist meta cache helpers
========================= */
function cachePlaylistMeta(key, data, ttlMs = 60_000) {
  PLAYLIST_META_CACHE.set(key, { data, expiresAt: Date.now() + ttlMs });
}

function readPlaylistMetaCache(key) {
  const entry = PLAYLIST_META_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    PLAYLIST_META_CACHE.delete(key);
    return null;
  }
  return entry.data;
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
      releaseDate: obj.release_date || null,
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
