// functions/api/save.js

export async function onRequestPost(context) {
  const { request, env } = context;

  // Preserve slashes, encode each path segment safely for GitHub Contents API.
  function ghPath(p) {
    return String(p || "")
      .split("/")
      .map(encodeURIComponent)
      .join("/");
  }

  // ---- Simple auth gate (replace with Cloudflare Access if you prefer) ----
  const adminKey = request.headers.get("x-admin-key");
  if (env.ADMIN_KEY && adminKey !== env.ADMIN_KEY) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" }
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "Invalid JSON" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }

  // Your app decides what "data" looks like
  const newData = body?.data;
  if (newData == null) {
    return new Response(JSON.stringify({ ok: false, error: "Missing `data`" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }

  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || "main";
  const path = env.GITHUB_PATH || "data/content.json";

  if (!env.GITHUB_TOKEN || !owner || !repo) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Missing GitHub env vars",
        details: "Require GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO (and optional GITHUB_BRANCH, GITHUB_PATH)."
      }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  const ghBase = `https://api.github.com/repos/${owner}/${repo}/contents/${ghPath(path)}`;

  // 1) Read current file (to get sha)
  const readRes = await fetch(`${ghBase}?ref=${encodeURIComponent(branch)}`, {
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "pages-git-writer"
    }
  });

  let sha = null;
  if (readRes.status === 200) {
    const current = await readRes.json();
    sha = current.sha;
  } else if (readRes.status === 404) {
    // file doesn't exist yet — that's fine, we'll create it
    sha = null;
  } else {
    const errText = await readRes.text();
    return new Response(JSON.stringify({ ok: false, error: "GitHub read failed", details: errText }), {
      status: 502,
      headers: { "content-type": "application/json" }
    });
  }

  // 2) Commit new file content
  const contentString = JSON.stringify(newData, null, 2) + "\n";

  // UTF-8 safe base64
  const contentBase64 = btoa(unescape(encodeURIComponent(contentString)));

  const commitBody = {
    message: `Update ${path}`,
    content: contentBase64,
    branch,
    ...(sha ? { sha } : {})
  };

  const writeRes = await fetch(ghBase, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "pages-git-writer"
    },
    body: JSON.stringify(commitBody)
  });

  if (!writeRes.ok) {
    const errText = await writeRes.text();
    return new Response(JSON.stringify({ ok: false, error: "GitHub write failed", details: errText }), {
      status: 502,
      headers: { "content-type": "application/json" }
    });
  }

  const result = await writeRes.json();

  return new Response(
    JSON.stringify(
      {
        ok: true,
        committed: true,
        path,
        commit: result?.commit?.sha || null
      },
      null,
      2
    ),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}
