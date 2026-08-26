// functions/api/podcast-archive.js
//
// Weekly snapshot of the "Podcast Episodes" playlist. Spotify's live API gives
// zero identifying data once an episode is delisted (see /api/playlist's
// droppedItems) — no id, no name, nothing to recover after the fact. This
// endpoint walks the full playlist on a schedule (see
// .github/workflows/podcast-archive.yml) and records what's actually there
// into data/podcast-archive.json, keyed by id, so the NEXT time something
// disappears we still have its name/show/url from the last run that saw it,
// plus a lastSeenAt/missingSince window bounding when it vanished.
//
// Storage follows the same pattern as episode-note.js / episode-date.js: a
// JSON file committed to the repo, read/written via the GitHub Contents API.

const PODCAST_PLAYLIST_ID = "2tHrihmpYzDbJ8rit7HtFR";

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// Unauthenticated read — lets the frontend (or a human) inspect the archive.
export async function onRequestGet({ env }) {
  try {
    const cfg = getGithubConfig(env);
    const file = await githubReadJson(cfg, { allowMissing: true });
    const archive = (file.data && typeof file.data === "object") ? file.data : {};

    return json({ ok: true, archive }, 200);
  } catch (err) {
    return json({
      ok: false,
      error: "Archive read failed",
      message: String(err?.message || err),
      details: err?.details || null
    }, 500);
  }
}

// Auth-gated: runs the actual snapshot. Triggered weekly by GitHub Actions,
// or by hand via curl -X POST -H "X-Auth: <AUTH secret>".
export async function onRequestPost({ env, request }) {
  try {
    enforceAuth(env, request);

    const token = await getUserAccessToken(env);
    const liveItems = await fetchAllPlaylistItems(token, PODCAST_PLAYLIST_ID);

    const cfg = getGithubConfig(env);
    const file = await githubReadJson(cfg, { allowMissing: true });
    const archive = (file.data && typeof file.data === "object") ? file.data : {};

    const now = new Date().toISOString();
    const liveIds = new Set();
    let added = 0, updated = 0, reappeared = 0, newlyMissing = 0;

    for (const it of liveItems) {
      if (!it.id) continue;
      liveIds.add(it.id);

      const existing = archive[it.id];
      if (!existing) {
        archive[it.id] = {
          type: it.type,
          name: it.name,
          artistsOrShow: it.artists || [],
          image: it.image || null,
          url: it.url || null,
          durationMs: it.durationMs || null,
          releaseDate: it.releaseDate || null,
          releaseDatePrecision: it.releaseDatePrecision || null,
          addedAt: it.addedAt || null,
          firstSeenAt: now,
          lastSeenAt: now,
          missingSince: null
        };
        added++;
      } else {
        if (existing.missingSince) reappeared++;
        existing.type = it.type;
        existing.name = it.name;
        existing.artistsOrShow = it.artists || [];
        existing.image = it.image || existing.image || null;
        existing.url = it.url || existing.url || null;
        existing.durationMs = it.durationMs || existing.durationMs || null;
        existing.releaseDate = it.releaseDate || existing.releaseDate || null;
        existing.releaseDatePrecision = it.releaseDatePrecision || existing.releaseDatePrecision || null;
        existing.addedAt = it.addedAt || existing.addedAt || null;
        existing.lastSeenAt = now;
        existing.missingSince = null;
        updated++;
      }
    }

    // Anything archived before that isn't in this run's live set just
    // disappeared sometime between its lastSeenAt and now.
    for (const [id, entry] of Object.entries(archive)) {
      if (!liveIds.has(id) && !entry.missingSince) {
        entry.missingSince = now;
        newlyMissing++;
      }
    }

    const changed = added > 0 || newlyMissing > 0 || reappeared > 0;

    let commit = null;
    if (changed) {
      const parts = [];
      if (added) parts.push(`${added} added`);
      if (newlyMissing) parts.push(`${newlyMissing} newly missing`);
      if (reappeared) parts.push(`${reappeared} reappeared`);
      const write = await githubWriteJson(cfg, archive, {
        sha: file.sha || null,
        message: `Podcast archive snapshot: ${parts.join(", ")}`
      });
      commit = { sha: write.commitSha || null };
    }

    return json({
      ok: true,
      liveItemCount: liveItems.length,
      archivedCount: Object.keys(archive).length,
      added,
      updated,
      reappeared,
      newlyMissing,
      changed,
      commit
    }, 200);
  } catch (err) {
    const status = Number(err?.status) || 500;
    return json({
      ok: false,
      error: status === 401 || status === 403 ? "Unauthorized" : "Archive snapshot failed",
      message: String(err?.message || err),
      details: err?.details || null,
      stack: String(err?.stack || "")
    }, status);
  }
}

/* =========================
   AUTH — same shared secret as episode notes/dates
========================= */
function enforceAuth(env, request) {
  const expected = String(env.AUTH || "").trim();
  if (!expected) {
    const e = new Error("Server missing AUTH secret.");
    e.status = 500;
    throw e;
  }
  const provided = String(request.headers.get("X-Auth") || "").trim();
  if (!provided) {
    const e = new Error("Missing X-Auth header.");
    e.status = 401;
    throw e;
  }
  if (provided !== expected) {
    const e = new Error("Invalid auth token.");
    e.status = 403;
    throw e;
  }
}

/* =========================
   SPOTIFY: token + full playlist walk
========================= */
async function getUserAccessToken(env) {
  const clientId = env.SPOTIFY_PROFILE || env.SPOTIFY_CLIENT_ID || null;
  const clientSecret = env.SPOTIFY_KEY || env.SPOTIFY_CLIENT_SECRET || null;
  const refreshToken = env.SPOTIFY_REFRESH_TOKEN || env.SPOTIFY_RT || env.SPOTIFY_REFRESH || null;

  if (!clientId || !clientSecret || !refreshToken) {
    const e = new Error("Missing Spotify OAuth secrets.");
    e.status = 500;
    throw e;
  }

  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${clientId}:${clientSecret}`),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken })
  });

  const data = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !data?.access_token) {
    const e = new Error(`Failed to refresh access token (${tokenRes.status})`);
    e.status = tokenRes.status;
    throw e;
  }
  return data.access_token;
}

async function fetchJsonWithRetries(url, token, label, { maxRetries = 3, baseDelay = 400 } = {}) {
  let attempt = 0;
  while (true) {
    attempt++;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const text = await res.text().catch(() => "");
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}

    if (res.ok) return data;

    const status = res.status || 0;
    const isRetryable = status === 429 || (status >= 500 && status < 600);
    if (!isRetryable || attempt > maxRetries) {
      const e = new Error(`${label} failed (${status})`);
      e.status = status;
      e.details = { endpoint: url, body: data || text };
      throw e;
    }

    const retryAfterRaw = res.headers?.get?.("Retry-After") || null;
    const delayMs = retryAfterRaw && /^\d+$/.test(retryAfterRaw.trim())
      ? Number(retryAfterRaw.trim()) * 1000
      : Math.round(baseDelay * Math.pow(2, attempt - 1) * (0.8 + Math.random() * 0.4));
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

// Walks the entire playlist (no per-call cap — this runs server-side on a
// schedule, not per page-load) using Spotify's own `next` cursor throughout,
// same fix as /api/playlist's fetchPlaylistItemsBounded.
async function fetchAllPlaylistItems(token, playlistId) {
  const out = [];
  let url =
    `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/tracks` +
    `?limit=100&offset=0&market=from_token`;

  while (url) {
    const data = await fetchJsonWithRetries(url, token, "playlist items", { maxRetries: 3 });
    const pageItems = Array.isArray(data.items) ? data.items : [];
    for (const it of pageItems) {
      const norm = normalizeItem(it);
      if (norm) out.push(norm);
    }
    url = data.next || null;
  }
  return out;
}

function pickFirstImageUrl(images) {
  return Array.isArray(images) && images.length ? (images[0]?.url || null) : null;
}

function normalizeItem(it) {
  const obj = it?.track;
  if (!obj) return null;

  const type = obj.type;
  const url = obj.external_urls?.spotify || null;
  const durationMs = Number(obj.duration_ms) || 0;

  if (type === "track") {
    return {
      id: obj.id,
      type: "track",
      name: obj.name,
      artists: (obj.artists || []).map((a) => a.name).filter(Boolean),
      url,
      durationMs,
      addedAt: it.added_at || null,
      releaseDate: null,
      releaseDatePrecision: null,
      image: pickFirstImageUrl(obj.album?.images)
    };
  }

  if (type === "episode") {
    return {
      id: obj.id,
      type: "episode",
      name: obj.name,
      artists: obj.show?.name ? [obj.show.name] : [],
      url,
      durationMs,
      addedAt: it.added_at || null,
      releaseDate: obj.release_date || null,
      releaseDatePrecision: obj.release_date_precision || null,
      image: pickFirstImageUrl(obj.images) || pickFirstImageUrl(obj.show?.images)
    };
  }

  return null;
}

/* =========================
   GitHub Contents API (same pattern as episode-date.js)
========================= */
function getGithubConfig(env) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || "main";
  const token = env.GITHUB_TOKEN;
  const path = env.GITHUB_ARCHIVE_PATH || "data/podcast-archive.json";

  const missing = [];
  if (!token) missing.push("GITHUB_TOKEN");
  if (!owner) missing.push("GITHUB_OWNER");
  if (!repo) missing.push("GITHUB_REPO");
  if (missing.length) {
    const e = new Error(`Missing GitHub secrets: ${missing.join(", ")}`);
    e.details = { missing };
    throw e;
  }
  return { owner, repo, path, branch, token };
}

function ghPath(p) {
  return String(p || "").split("/").map(encodeURIComponent).join("/");
}

async function githubReadJson(cfg, { allowMissing = false } = {}) {
  const url = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${ghPath(cfg.path)}?ref=${encodeURIComponent(cfg.branch)}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "cf-pages-functions"
    }
  });

  if (allowMissing && res.status === 404) return { data: {}, sha: null };

  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    const e = new Error(`GitHub read failed (${res.status})`);
    e.details = { endpoint: url, body: payload || text };
    throw e;
  }

  const contentB64 = String(payload?.content || "");
  const sha = payload?.sha || null;
  const raw = contentB64 ? b64ToUtf8(contentB64) : "{}";

  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {
    const e = new Error("GitHub file is not valid JSON");
    e.details = { path: cfg.path };
    throw e;
  }
  return { data, sha };
}

async function githubWriteJson(cfg, obj, { sha = null, message = "Update JSON" } = {}) {
  const url = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${ghPath(cfg.path)}`;

  const body = {
    message,
    content: utf8ToB64(JSON.stringify(obj, null, 2) + "\n"),
    branch: cfg.branch
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "cf-pages-functions"
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    const e = new Error(`GitHub write failed (${res.status})`);
    e.details = { endpoint: url, body: payload || text };
    throw e;
  }
  return { commitSha: payload?.commit?.sha || null };
}

function b64ToUtf8(b64) {
  const clean = String(b64 || "").replace(/\s+/g, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(String(str || ""));
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8" }
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Accept,X-Auth"
  };
}
