// functions/api/episode-date.js
//
// Manual release-date overrides for podcast episodes. Spotify sometimes reports
// a release_date that's really a mirror/re-sync timestamp rather than the true
// original publish date (After Skool, Wendover Productions, etc.) — this lets
// the site owner correct those by hand. Overrides are stored in the repo the
// same way episode notes are (read/write via the GitHub Contents API), keyed
// by episode ID.

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestGet({ env }) {
  try {
    const cfg = getGithubConfig(env);
    const file = await githubReadJson(cfg, { allowMissing: true });
    const overrides = (file.data && typeof file.data === "object") ? file.data : {};

    return json({ ok: true, overrides }, 200);
  } catch (err) {
    return json({
      ok: false,
      error: "Episode date read failed",
      message: String(err?.message || err),
      details: err?.details || null,
      stack: String(err?.stack || "")
    }, 500);
  }
}

export async function onRequestPost({ env, request }) {
  try {
    enforceAuth(env, request);

    const body = await request.json().catch(() => ({}));
    const episodeId = String(body.episodeId || "").trim();
    if (!episodeId) return json({ ok: false, error: "Missing episodeId" }, 400);

    const releaseDate = normalizeDate(body.releaseDate);

    const cfg = getGithubConfig(env);
    const file = await githubReadJson(cfg, { allowMissing: true });
    const all = (file.data && typeof file.data === "object") ? file.data : {};

    let msg;
    if (!releaseDate) {
      // Empty/missing releaseDate clears the override, reverting to Spotify's own date.
      delete all[episodeId];
      msg = `Clear episode date override: ${episodeId}`;
    } else {
      const precision = normalizePrecision(body.releaseDatePrecision, releaseDate);
      all[episodeId] = { releaseDate, releaseDatePrecision: precision };
      msg = `Set episode date override: ${episodeId} -> ${releaseDate}`;
    }

    const write = await githubWriteJson(cfg, all, { sha: file.sha || null, message: msg });

    return json({
      ok: true,
      episodeId,
      override: all[episodeId] || null,
      commit: { sha: write.commitSha || null }
    }, 200);
  } catch (err) {
    const status = Number(err?.status) || 500;

    return json({
      ok: false,
      error: status === 401 || status === 403 ? "Unauthorized" : "Episode date write failed",
      message: String(err?.message || err),
      details: err?.details || null,
      stack: String(err?.stack || "")
    }, status);
  }
}

/* =========================
   AUTH (POST-only) — same shared secret as episode notes
========================= */

function enforceAuth(env, request) {
  const expected = String(env.AUTH || "").trim();
  if (!expected) {
    const e = new Error("Server missing AUTH secret.");
    e.status = 500;
    e.details = { missing: ["AUTH"] };
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
   GitHub helpers
========================= */

function getGithubConfig(env) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || "main";
  const token = env.GITHUB_TOKEN;

  // Own file, separate from episode notes' GITHUB_PATH — defaults so no new
  // secret is required, but can be overridden the same way external-videos.js does.
  const path = env.GITHUB_DATES_PATH || "data/episode-date-overrides.json";

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

  if (allowMissing && res.status === 404) {
    return { data: {}, sha: null };
  }

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

/* =========================
   Utilities
========================= */

// Accepts "YYYY", "YYYY-MM", or "YYYY-MM-DD"; anything else is rejected (empty override).
function normalizeDate(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(s)) return "";
  return s;
}

function normalizePrecision(raw, releaseDate) {
  const allowed = new Set(["day", "month", "year"]);
  const p = String(raw || "").trim().toLowerCase();
  if (allowed.has(p)) return p;

  const parts = releaseDate.split("-");
  if (parts.length === 3) return "day";
  if (parts.length === 2) return "month";
  return "year";
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
