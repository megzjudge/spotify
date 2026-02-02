// spotify-refresh-token.mjs
// Node 18+ recommended.

import http from "node:http";
import { URL } from "node:url";
import { Buffer } from "node:buffer";

const CLIENT_ID = process.env.SPOTIFY_PROFILE;     // client id
const CLIENT_SECRET = process.env.SPOTIFY_KEY;     // client secret

// Must EXACTLY match one Redirect URI in Spotify app settings
const REDIRECT_URI = "http://localhost:8787/callback";

// Scopes you likely need for private/collab playlists
const SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative"
].join(" ");

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing env vars. Set SPOTIFY_PROFILE (client id) and SPOTIFY_KEY (client secret).");
  process.exit(1);
}

function b64(str) {
  return Buffer.from(str, "utf8").toString("base64");
}

function html(msg) {
  return `<!doctype html><meta charset="utf-8"><pre style="white-space:pre-wrap;font:14px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace">${msg}</pre>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, REDIRECT_URI);

    if (u.pathname === "/") {
      // Kick off the auth redirect
      const state = Math.random().toString(36).slice(2);
      const authUrl = new URL("https://accounts.spotify.com/authorize");
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", CLIENT_ID);
      authUrl.searchParams.set("scope", SCOPES);
      authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("show_dialog", "true");

      res.writeHead(302, { Location: authUrl.toString() });
      res.end();
      return;
    }

    if (u.pathname === "/callback") {
      const code = u.searchParams.get("code");
      const error = u.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(html(`Spotify returned error: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(html("No code found in callback URL."));
        return;
      }

      // Exchange code for tokens
      const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization": `Basic ${b64(`${CLIENT_ID}:${CLIENT_SECRET}`)}`
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI
        })
      });

      const tokenText = await tokenRes.text();
      let tokenJson = null;
      try { tokenJson = JSON.parse(tokenText); } catch {}

      if (!tokenRes.ok) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(html(`Token exchange failed (${tokenRes.status}).\n\n${tokenText}`));
        return;
      }

      const refreshToken = tokenJson?.refresh_token;
      if (!refreshToken) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html(
          "Success, but no refresh_token returned.\n\n" +
          "This usually means you didn't request the right scopes, or you previously authorized and Spotify didn't return one.\n\n" +
          tokenText
        ));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html(
        "✅ Refresh token minted.\n\n" +
        "Add this to Cloudflare Pages secrets as SPOTIFY_REFRESH_TOKEN:\n\n" +
        refreshToken +
        "\n\n(You can close this tab and stop the script.)"
      ));

      // Optional: stop server automatically after success
      setTimeout(() => server.close(), 250);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/html" });
    res.end(html(String(e?.stack || e)));
  }
});

server.listen(8787, () => {
  console.log("Open this in your browser:");
  console.log("  http://localhost:8787/");
});
