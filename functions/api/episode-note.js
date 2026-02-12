// functions/api/episode-note.js

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestGet({ env, request }) {
  try {
    const url = new URL(request.url);
    const episodeId = String(url.searchParams.get("episodeId") || "").trim();
    if (!episodeId) return json({ error: "Missing episodeId" }, 400);

    const path = env.GITHUB_NOTES_PATH || "episode-notes.json";
    const { data } = await readJsonFileFromGitHub(env, path);
    const all = data && typeof data === "object" ? data : {};
    const notes = Array.isArray(all[episodeId]) ? all[episodeId] : [];

    return json({ episodeId, notes }, 200);
  } catch (err) {
    return json(
      { error: "Episode note read failed", message: String(err?.message || err), stack: String(err?.stack || "") },
      500
    );
  }
}

export async function onRequestPost({ env, request }) {
  try {
    const body = await request.json().catch(() => ({}));

    const episodeId = String(body.episodeId || "").trim();
    if (!episodeId) return json({ error: "Missing episodeId" }, 400);

    // If body.notes present: replace array for that episodeId (best for your UI save button)
    const replaceNotes = Array.isArray(body.notes) ? body.notes : null;

    // If body.t/body.n present: append a single row
    const t = body.t != null ? String(body.t).trim() : "";
    const n = body.n != null ? String(body.n).trim() : "";
    const wantsAppend = !replaceNotes && (t || n);

    const path = env.GITHUB_NOTES_PATH || "episode-notes.json";
    const { data: existing, sha } = await readJsonFileFromGitHub(env, path);

    const all = existing && typeof existing === "object" ? existing : {};
    const current = Array.isArray(all[episodeId]) ? all[episodeId] : [];

    let next = current;

    if (replaceNotes) {
      // sanitize + clamp
      next = replaceNotes
        .map((row) => ({
          t: normalizeTimestamp(row?.t),
          n: String(row?.n ?? "").slice(0, 5000),
          ts: row?.ts ? String(row.ts) : new Date().toISOString()
        }))
        .filter((row) => row.t || row.n)
        .slice(0, 500);
    } else if (wantsAppend) {
      next = current
        .concat([
          {
            t: normalizeTimestamp(t) || "00:00:00",
            n: String(n).slice(0, 5000),
            ts: new Date().toISOString()
          }
        ])
        .slice(0, 500);
    } else {
      return json({ error: "Provide either {notes:[...]} or {t,n} to append." }, 400);
    }

    all[episodeId] = next;

    const message = `Update episode notes: ${episodeId}`;
    const res = await writeJsonFileToGitHub(env, path, all, sha, message);

    return json(
      {
        ok: true,
        episodeId,
        notes: next,
        commit: {
          sha: res?.commit?.sha || null,
          url: res?.commit?.html_url || null
        }
      },
      200
    );
  } catch (err) {
    return json(
      { error: "Episode note write failed", message: String(err?.message || err), stack: String(err?.stack || "") },
      500
    );
  }
}

export async function onRequestDelete({ env, request }) {
  try {
    const body = await request.json().catch(() => ({}));

    const episodeId = String(body.episodeId || "").trim();
    const index = Number(body.index);

    if (!episodeId) return json({ error: "Missing episodeId" }, 400);
    if (!Number.isFinite(index) || index < 0) return json({ error: "Missing/invalid index" }, 400);

    const path = env.GITHUB_NOTES_PATH || "episode-notes.json";
    const { data: existing, sha } = await readJsonFileFromGitHub(env, path);

    const all = existing && typeof existing === "object" ? existing : {};
    const current = Array.isArray(all[episodeId]) ? all[episodeId] : [];

    if (!current.length) return json({ ok: true, episodeId, notes: [] }, 200);
    if (index >= current.length) return json({ error: "Index out of range" }, 400);

    current.splice(index, 1);
    all[episodeId] = current;

    const message = `Delete episode note: ${episodeId} @ ${index}`;
    const res = await writeJsonFileToGitHub(env, path, all, sha, message);

    return json(
      {
        ok: true,
        episodeId,
        notes: current,
        commit: { sha: res?.commit?.sha || null, url: res?.commit?.html_url || null }
      },
      200
    );
  } catch (err) {
    return json(
      { error: "Episode note delete failed", message: String(err?.message || err), stack: String(err?.stack || "") },
      500
    );
  }
}

/* =========================
   GitHub helpers
========================= */

function requireGitHubEnv(env) {
  const token = env.GITHUB_TOKEN;
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || "main";
  if (!token || !owner || !repo) {
    throw new Error("Missing GitHub secrets (GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO).");
  }
  return { token, owner, repo, branch };
}

// Preserve slashes, encode each path segment safely for GitHub Contents API.
function ghPath(p) {
  return String(p || "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
}

async function readJsonFileFromGitHub(env, path) {
  const { token, owner, repo, branch } = requireGitHubEnv(env);

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${ghPath(path)}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "cf-pages-functions"
    }
  });

  // If file doesn't exist yet, return empty object without sha
  if (res.status === 404) {
    return { data: {}, sha: null };
  }

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GitHub read failed (${res.status}). ${payload?.message || ""}`);
  }

  const contentB64 = String(payload?.content || "");
  const sha = payload?.sha || null;

  const text = contentB64 ? b64ToUtf8(contentB64) : "{}";
  let data = {};
  try {
    data = JSON.parse(text || "{}");
  } catch {
    data = {};
  }

  return { data, sha };
}

async function writeJsonFileToGitHub(env, path, obj, sha, message) {
  const { token, owner, repo, branch } = requireGitHubEnv(env);

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${ghPath(path)}`;
  const body = {
    message: message || "Update episode notes",
    content: utf8ToB64(JSON.stringify(obj, null, 2)),
    branch
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "cf-pages-functions"
    },
    body: JSON.stringify(body)
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GitHub write failed (${res.status}). ${payload?.message || ""}`);
  }
  return payload;
}

/* =========================
   Utilities
========================= */

function normalizeTimestamp(s) {
  const raw = String(s || "").trim();
  if (!raw) return "";

  // allow "MM:SS" or "HH:MM:SS"
  const parts = raw.split(":").map((x) => x.trim());
  if (parts.length === 2) {
    const mm = clampInt(parts[0], 0, 9999, 0);
    const ss = clampInt(parts[1], 0, 59, 0);
    return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }
  if (parts.length === 3) {
    const hh = clampInt(parts[0], 0, 9999, 0);
    const mm = clampInt(parts[1], 0, 59, 0);
    const ss = clampInt(parts[2], 0, 59, 0);
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }

  // if weird, just return trimmed raw (UI can still display)
  return raw.slice(0, 32);
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
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
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Accept"
  };
}

function b64ToUtf8(b64) {
  // GitHub content may include newlines; strip them
  const clean = String(b64 || "").replace(/\n/g, "");
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
