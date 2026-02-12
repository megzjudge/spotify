// functions/api/episode-note.js

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestGet({ env, request }) {
  try {
    const url = new URL(request.url);

    // ✅ NEW: summary mode (single file read, returns which episodes have non-empty notes)
    const summary = String(url.searchParams.get("summary") || "").trim() === "1";
    if (summary) {
      const cfg = getGithubConfig(env);
      const file = await githubReadJson(cfg, { allowMissing: true });
      const all = (file.data && typeof file.data === "object") ? file.data : {};

      const episodesWithNotes = [];
      for (const [episodeId, rows] of Object.entries(all)) {
        if (!episodeId) continue;
        if (!Array.isArray(rows) || !rows.length) continue;

        const hasText = rows.some((r) => String(r?.text || "").trim().length > 0);
        if (hasText) episodesWithNotes.push(String(episodeId));
      }

      return json({ ok: true, episodesWithNotes }, 200);
    }

    const episodeId = String(url.searchParams.get("episodeId") || "").trim();
    if (!episodeId) return json({ ok: false, error: "Missing episodeId" }, 400);

    const cfg = getGithubConfig(env);
    const file = await githubReadJson(cfg, { allowMissing: true });

    const all = (file.data && typeof file.data === "object") ? file.data : {};
    const raw = Array.isArray(all[episodeId]) ? all[episodeId] : [];

    const notes = raw
      .map((row) => ({
        timestamp: normalizeTimestamp(row?.timestamp ?? ""),
        text: String(row?.text ?? "").slice(0, 5000)
      }))
      .filter((r) => r.timestamp || r.text);

    return json({ ok: true, episodeId, notes }, 200);
  } catch (err) {
    return json({
      ok: false,
      error: "Episode note read failed",
      message: String(err?.message || err),
      details: err?.details || null,
      stack: String(err?.stack || "")
    }, 500);
  }
}

export async function onRequestPost({ env, request }) {
  try {
    // ✅ AUTH: require X-Auth header to match env.AUTH
    enforceAuth(env, request);

    const body = await request.json().catch(() => ({}));
    const episodeId = String(body.episodeId || "").trim();
    if (!episodeId) return json({ ok: false, error: "Missing episodeId" }, 400);

    const notesIn = Array.isArray(body.notes) ? body.notes : [];
    let notes = notesIn
      .map((n) => ({
        timestamp: normalizeTimestamp(n?.timestamp ?? "00:00:00"),
        text: String(n?.text ?? "").trim().slice(0, 5000)
      }))
      .filter((n) => n.timestamp || n.text)
      .slice(0, 500);

    if (!notes.length) notes = [{ timestamp: "00:00:00", text: "" }];

    const cfg = getGithubConfig(env);

    // Read current file (or create if missing)
    const file = await githubReadJson(cfg, { allowMissing: true });
    const all = (file.data && typeof file.data === "object") ? file.data : {};

    // Update
    all[episodeId] = notes;

    // Write back with sha (or create)
    const msg = `Update episode notes: ${episodeId}`;
    const write = await githubWriteJson(cfg, all, { sha: file.sha || null, message: msg });

    return json({
      ok: true,
      episodeId,
      notes,
      commit: { sha: write.commitSha || null }
    }, 200);

  } catch (err) {
    const status = Number(err?.status) || 500;

    return json({
      ok: false,
      error: status === 401 || status === 403 ? "Unauthorized" : "Episode note write failed",
      message: String(err?.message || err),
      details: err?.details || null,
      stack: String(err?.stack || "")
    }, status);
  }
}

/* =========================
   AUTH (POST-only)
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
   GitHub helpers (single canonical config)
========================= */

function getGithubConfig(env) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || "main";
  const token = env.GITHUB_TOKEN;

  // Canonical single path:
  const path = env.GITHUB_PATH; // MUST be "data/episode-notes.json"

  const missing = [];
  if (!token) missing.push("GITHUB_TOKEN");
  if (!owner) missing.push("GITHUB_OWNER");
  if (!repo) missing.push("GITHUB_REPO");
  if (!path) missing.push("GITHUB_PATH");

  if (missing.length) {
    const e = new Error(`Missing GitHub secrets: ${missing.join(", ")}`);
    e.details = { missing };
    throw e;
  }

  return { owner, repo, path, branch, token };
}

// Encode each segment, preserve slashes.
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

function normalizeTimestamp(s) {
  const raw = String(s || "").trim();
  if (!raw) return "00:00:00";

  const parts = raw.split(":").map((x) => x.trim()).filter(Boolean);

  if (parts.length === 1) {
    const ss = clampInt(parts[0], 0, 59, 0);
    return `00:00:${String(ss).padStart(2, "0")}`;
  }
  if (parts.length === 2) {
    const mm = clampInt(parts[0], 0, 999, 0);
    const ss = clampInt(parts[1], 0, 59, 0);
    return `00:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }

  const hh = clampInt(parts[0], 0, 999, 0);
  const mm = clampInt(parts[1], 0, 59, 0);
  const ss = clampInt(parts[2], 0, 59, 0);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
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
