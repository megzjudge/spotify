// functions/api/github-test.js

export async function onRequestGet({ env, request }) {
  try {
    const path = env.GITHUB_TEST_PATH || "data/github-test.json";
    const { token, owner, repo, branch } = requireGitHubEnv(env);

    const read = await ghReadJson({ token, owner, repo, branch, path });

    const now = new Date().toISOString();
    const nextObj = {
      ok: true,
      touchedAt: now,
      prev: read.data && typeof read.data === "object" ? read.data : null
    };

    const write = await ghWriteJson({
      token, owner, repo, branch, path,
      obj: nextObj,
      sha: read.sha,
      message: `GitHub test write ${now}`
    });

    return json({
      ok: true,
      path,
      branch,
      wrote: true,
      commit: {
        sha: write?.commit?.sha || null,
        url: write?.commit?.html_url || null
      }
    }, 200);
  } catch (err) {
    return json({
      ok: false,
      error: String(err?.message || err),
      status: err?.status || null,
      details: err?.details || null
    }, 500);
  }
}

function requireGitHubEnv(env) {
  const token = env.GITHUB_TOKEN;
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || "main";
  if (!token || !owner || !repo) {
    const e = new Error("Missing GitHub env vars: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO (optional GITHUB_BRANCH).");
    e.status = 500;
    throw e;
  }
  return { token, owner, repo, branch };
}

function ghPath(p) {
  return String(p || "").split("/").map(encodeURIComponent).join("/");
}

async function ghReadJson({ token, owner, repo, branch, path }) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${ghPath(path)}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "cf-pages-functions"
    }
  });

  if (res.status === 404) return { data: {}, sha: null };

  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    const e = new Error(`GitHub read failed (${res.status}). ${(payload && payload.message) ? payload.message : text}`);
    e.status = res.status;
    e.details = payload || text;
    throw e;
  }

  const contentB64 = String(payload?.content || "").replace(/\n/g, "");
  const sha = payload?.sha || null;
  const jsonText = contentB64 ? b64ToUtf8(contentB64) : "{}";

  let data = {};
  try { data = JSON.parse(jsonText || "{}"); } catch { data = {}; }

  return { data, sha };
}

async function ghWriteJson({ token, owner, repo, branch, path, obj, sha, message }) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${ghPath(path)}`;
  const body = {
    message: message || `Update ${path}`,
    content: utf8ToB64(JSON.stringify(obj, null, 2) + "\n"),
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

  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    const e = new Error(`GitHub write failed (${res.status}). ${(payload && payload.message) ? payload.message : text}`);
    e.status = res.status;
    e.details = payload || text;
    throw e;
  }

  return payload;
}

function b64ToUtf8(b64) {
  const bin = atob(String(b64 || ""));
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
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
