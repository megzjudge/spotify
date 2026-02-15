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
    const offset = clampInt(body.offset, 0, 1000000, 0);

    if (!playlistId) {
      return json({ error: "Missing playlistId" }, 400);
    }

    const token = await getUserAccessToken(env);

    const me = await fetchMe(token);
    const myUserId = me?.id || null;

    const pl = await fetchPlaylist(token, playlistId);
    const playlist = normalizePlaylist(pl, myUserId);

    const { items, nextOffset, hasMore } =
      limit === 0
        ? { items: [], nextOffset: null, hasMore: false }
        : await fetchPlaylistItemsBounded(token, playlistId, limit, offset);

    let normalizedItems = items.map(normalizeItem).filter(Boolean);

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
        nextOffset,
        hasMore
      },
      200
    );
  } catch (err) {
    // If the error object has a status (we set it below on some throws), use it.
    const status = err?.status && Number.isFinite(Number(err.status)) ? Number(err.status) : 500;

    // Log full error server-side (safe to remove in prod)
    console.error("playlist function error:", {
      message: String(err?.message || err),
      status: err?.status || null,
      details: err?.details || null,
      stack: String(err?.stack || "")
    });

    return json(
      {
        error: "Playlist fetch failed",
        message: String(err?.message || err),
        status: err?.status || null,
        details: err?.details || null
      },
      status
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

  // Helpful log to confirm presence of env (do NOT log raw secrets in prod)
  if (!clientId || !clientSecret || !refreshToken) {
    console.error("spotify env incomplete:", {
      hasClientId: !!clientId,
      hasClientSecret: !!clientSecret,
      hasRefreshToken: !!refreshToken
    });
    const e = new Error(
      "Missing Spotify OAuth secrets (SPOTIFY_PROFILE, SPOTIFY_KEY, SPOTIFY_REFRESH_TOKEN)."
    );
    e.status = 500;
    e.details = { missing: {
      SPOTIFY_PROFILE: !clientId,
      SPOTIFY_KEY: !clientSecret,
      SPOTIFY_REFRESH_TOKEN: !refreshToken
    }};
    throw e;
  }

  // Build Basic auth robustly (btoa or Buffer fallback)
  let basicAuth;
  try {
    if (typeof btoa === "function") {
      basicAuth = btoa(`${clientId}:${clientSecret}`);
    } else if (typeof Buffer !== "undefined") {
      basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    } else if (typeof globalThis?.TextEncoder === "function") {
      // last-resort fallback (shouldn't be needed)
      const utf8 = new TextEncoder().encode(`${clientId}:${clientSecret}`);
      basicAuth = Array.from(utf8).map((b) => String.fromCharCode(b)).join("");
      basicAuth = btoa(basicAuth);
    } else {
      basicAuth = btoa(`${clientId}:${clientSecret}`);
    }
  } catch (err) {
    const e = new Error("Failed to build Basic auth for Spotify token request.");
    e.status = 500;
    e.details = { cause: String(err?.message || err) };
    throw e;
  }

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + basicAuth,
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

/* rest of file unchanged... (fetchMe, fetchPlaylist, fetchPlaylistItemsBounded,
   fetchEpisodesByIds, normalization helpers, json(), corsHeaders(), clampInt()) */

function fetchMe(token) {
  return fetchJsonOrThrow("https://api.spotify.com/v1/me", token, "/me");
}

function fetchPlaylist(token, playlistId) {
  return fetchJsonOrThrow(
    `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}`,
    token,
    "playlist meta"
  );
}

/* ...keep your existing implementations for the remainder of file ... */

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

function normalizeItem(it) {
  const obj = it?.track;
  if (!obj) return null;

  const type = obj.type;
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
