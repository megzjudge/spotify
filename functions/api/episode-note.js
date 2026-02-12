// functions/api/episode-note.js
//
// GET  /api/episode-note?episodeId=xxx
// POST /api/episode-note { episodeId, notes:[{timestamp,text}] }
//
// Stores notes in a JSON file in GitHub (Contents API).
// File format (recommended):
// {
//   "episodeNotes": {
//     "<episodeId>": [ { "timestamp":"00:00:00", "text":"..." }, ... ]
//   }
// }

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestGet({ env, request }) {
  try {
    const url = new URL(request.url);
    const episodeId = String(url.searchParams.get("episodeId") || "").trim();
    if (!episodeId) return json({ ok: false, error: "Missing episodeId" }, 400);

    const cfg = getGithubConfig(env);
    const file = await githubReadJson(cfg, { allowMissing: true });

    const root = (file.data && typeof file.data === "object") ? file.data : {};
    const episodeNotes =
      (root.episodeNotes && typeof root.episodeNotes === "object") ? root.episodeNotes : {};

    const raw = Array.isArray(episodeNotes[episodeId]) ? episodeNotes[episodeId] : [];
    const notes = raw
      .map((n) => ({
        timestamp: normalizeTimestamp(n?.timestamp ?? "00:00:00"),
        text: String(n?.text ?? "").slice(0, 5000)
      }))
      .filter((n) => n.timestamp || n.text);

    return json({ ok: true, episodeId, notes }, 200);
  } catch (err) {
    return json(
      {
        ok: false,
        error: "Episode note read failed",
        message: String(err?.message || err),
        details: err?.details || null,
        stack: String(err?.stack || "")
      },
      500
    );
  }
}

export async function onRequestPost({ env, request }) {
  try {
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

    // 1) Read current file (or create if missing)
    const file = await githubReadJson(cfg, { allowMissing: true });

    const base = (file.data && typeof file.data === "object") ? file.data : {};
    const episodeNotes =
      (base.episodeNotes && typeof base.episodeNotes === "object") ? base.episodeNotes : {};

    // 2) Update entry
    episodeNotes[episodeId] = notes;

    const next = { ...base, episodeNotes };

    // 3) Write back
    const msg = `Update episode notes: ${episodeId}`;
    const write = await githubWriteJson(cfg, next, {
      sha: file.sha || null,
      message: msg
    });

    return json(
      {
        ok: true,
        episodeId,
        notes,
        commit: {
          sha: write?.commitSha || null,
          url: write?.commitUrl || null
        }
      },
      200
    );
  } catch (err) {
    return json(
      {
        ok: false,
        error: "Episode note write failed",
        message: String(err?.message || err),
        details: err?.details || null,
        stack: String(err?.stack || "")
      },
      500
    );
  }
}

/* =========================
   GitHub helpers
========================= */

function getGithubConfig(env) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const path = env.GITHUB_PATH; // you set: "data/episode-notes.json"
  const branch = env.GITHUB_BRANCH || "main";
  const token = env.GITHUB_TOKEN;

  const missing = [];
  if (!owner) missing.push("GITHUB_OWNER");
  if (!repo) missing.push("GITHUB_REPO");
  if (!path) missing.push("GITHUB_PATH");
  if (!token) missing.push("GITHUB_TOKEN");

  if (missing.length) {
    const e = new Error(`Missing GitHub secrets: ${missing.join(", ")}`);
    e.details = { missing };
    throw e;
  }

  return { owner, repo, path: String(path).replace(/^\/+/, ""), branch, token };
}

// Preserve slashes; encode each segment only.
function ghPath(p) {
  return String(p || "")
    .replace(/^\/+/, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
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
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    const e = new Error(`GitHub read failed (${res.status})`);
    e.details = { endpoint: url, body: payload || text };
    throw e;
  }

  const contentB64 = payload?.content;
  const sha = payload?.sha || null;

  if (!contentB64) return { data: {}, sha };

  const raw = b64ToUtf8(contentB64);

  let jsonData = {};
  try {
    jsonData = raw ? JSON.parse(raw) : {};
  } catch {
    const e = new Error("GitHub file is not valid JSON");
    e.details = { path: cfg.path };
    throw e;
  }

  return { data: jsonData, sha };
}

async function githubWriteJson(cfg, obj, { sha = null, message = "Update JSON" } = {}) {
  const url = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${ghPath(cfg.path)}`;

  const payload = {
    message,
    content: utf8ToB64(JSON.stringify(obj, null, 2) + "\n"),
    branch: cfg.branch
  };
  if (sha) payload.sha = sha;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "cf-pages-functions"
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    const e = new Error(`GitHub write failed (${res.status})`);
    e.details = { endpoint: url, body: data || text };
    throw e;
  }

  return {
    commitSha: data?.commit?.sha || null,
    commitUrl: data?.commit?.html_url || null
  };
}

/* =========================
   Base64 UTF-8 helpers (Workers-safe)
========================= */

function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(String(str || ""));
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function b64ToUtf8(b64) {
  const clean = String(b64 || "").replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* =========================
   Timestamp normalization
========================= */

function normalizeTimestamp(s) {
  // Accept "SS", "MM:SS", "HH:MM:SS" -> return "HH:MM:SS"
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

/* =========================
   Response helpers
========================= */

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
    "Access-Control-Allow-Headers": "Content-Type,Accept"
  };
}
