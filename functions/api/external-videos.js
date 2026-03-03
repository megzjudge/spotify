export async function onRequestGet({ env }) {
  const cfg = getGithubConfig(env);
  const file = await githubReadJson(cfg, { allowMissing: true });
  const data = file.data || { videos: [] };
  return json({ ok: true, videos: data.videos || [] });
}

export async function onRequestPost({ env, request }) {
  enforceAuth(env, request);
  
  const body = await request.json().catch(() => ({}));
  const url = String(body.url || "").trim();
  if (!url) return json({ ok: false, error: "Missing url" }, 400);

  // Fetch page metadata (title + og:image)
  const meta = await fetchPageMetadata(url);
  const video = {
    url,
    title: meta.title || "Untitled",
    image: meta.image || null,
    addedAt: new Date().toISOString()
  };

  const cfg = getGithubConfig(env);
  const file = await githubReadJson(cfg, { allowMissing: true });
  const data = file.data || { videos: [] };
  data.videos.unshift(video); // Add to top
  data.videos = data.videos.slice(0, 10); // Keep last 10

  await githubWriteJson(cfg, data, { message: `Add video: ${video.title}` });
  return json({ ok: true, video });
}

async function fetchPageMetadata(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await res.text();
    
    // Extract title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : null;

    // Extract Open Graph image
    const ogMatch = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
    const image = ogMatch ? ogMatch[1] : null;

    return { title, image };
  } catch {
    return { title: "Could not load page", image: null };
  }
}

function getGithubConfig(env) {
  return {
    owner: env.GITHUB_OWNER,
    repo: env.GITHUB_REPO,
    branch: env.GITHUB_BRANCH || "main",
    path: env.GITHUB_EXTERNAL_PATH || "data/external-videos.json",
    token: env.GITHUB_TOKEN
  };
}

// Reuse existing auth/github helpers from episode-note.js
function enforceAuth(env, request) { /* copy from episode-note.js */ }
async function githubReadJson(cfg, opts) { /* copy from episode-note.js */ }
async function githubWriteJson(cfg, obj, opts) { /* copy from episode-note.js */ }
function json(obj, status = 200) { /* copy from episode-note.js */ }
