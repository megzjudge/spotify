# Spotify-Tracking Single-User Website

A personal, live-updating browser for Spotify playlists and podcast episodes. The front end is a static page; all Spotify calls happen server-side through **Cloudflare Pages Functions**, so access tokens never touch the browser. Lightweight content (episode notes, external video links) is stored as JSON in this repo and edited through the GitHub API — git doubles as the database.

## What it does

- Pulls a curated view of your Spotify library live - pulled easily from the [Spotify Web API](https://developer.spotify.com/documentation/web-api), with playlists grouped into sections (Daily Mix, Top, etc), a featured podcast playlist, and a set of highlighted "created by others" playlists.
- Shows headline totals: number of playlists, total songs, and an approximate listening time. Exact per-playlist durations are computed on demand.
- Lets you open a playlist and list its tracks and podcast episodes, with episodes enriched by release date and artwork for reliable sorting.
- Supports **timestamped notes per podcast episode**, saved back into the repo so they persist and are versioned.
- Keeps a short list of **external video links** (with auto-fetched title and thumbnail), capped to the most recent few.

Only your public playlists are shown. Playlists are excluded if they aren't yours, are private, start with a `NP:` / `[Not Public]` prefix, or carry a `#notpublic` tag in the description — with an explicit allowlist so chosen playlists always appear.

## Architecture

```
Browser (index.html + script.js)
        │  fetch()
        ▼
Cloudflare Pages Functions  (functions/api/*)
        │                        │
        ▼                        ▼
  Spotify Web API          GitHub Contents API
  (live playlist data)     (read/write data/*.json)
```

Everything runs at the edge on Cloudflare's Workers runtime. Access tokens are minted from a stored refresh token and cached in memory per function instance, so repeated requests don't re-hit Spotify's token endpoint.

## Project layout

| Path | Purpose |
|---|---|
| `index.html`, `styles.css`, `script.js` | The static front end (vanilla JS, no framework, no build step) |
| `functions/api/auth/start.js` | One-time: redirects to Spotify to authorize and begin the OAuth flow |
| `functions/api/auth/callback.js` | One-time: exchanges the code for a **refresh token** to copy into your secrets |
| `functions/api/refresh.js` | Builds the homepage payload — playlists, sections, totals |
| `functions/api/playlist.js` | Returns the items of one playlist (tracks + episodes, paginated) |
| `functions/api/playlist-duration.js` | Sums exact track durations (ms) for one playlist |
| `functions/api/episode-note.js` | Read/write timestamped episode notes (`data/episode-notes.json`) |
| `functions/api/external-videos.js` | List/add external video links (`data/external-videos.json`) |
| `functions/api/save.js` | Generic "commit JSON to the repo" endpoint |
| `functions/api/*-test.js` | Diagnostic endpoints for checking env wiring (safe to remove) |
| `data/*.json` | Persisted content, committed by the functions above |
| `.github/workflows/workflow.yml` | Logs a note whenever anything under `data/**` changes |

## Setup

This is built to deploy on **Cloudflare Pages**. Connect the repo in the Cloudflare dashboard (or `wrangler pages deploy .`) — no build command, output directory is the repo root, and the `functions/` directory is picked up automatically.

### 1. Create a Spotify app

In the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), create an app and add your callback as a redirect URI:

```
https://<your-domain>/api/auth/callback
```

Note the **Client ID** and **Client Secret**.

### 2. Set environment variables (Cloudflare Pages → Settings → Environment variables)

| Variable | What it is |
|---|---|
| `SPOTIFY_PROFILE` | Spotify app **Client ID** |
| `SPOTIFY_KEY` | Spotify app **Client Secret** |
| `SPOTIFY_REFRESH_TOKEN` | Minted in step 3 (leave empty until then) |
| `GITHUB_TOKEN` | Fine-grained PAT with **Contents: read & write** on this repo |
| `GITHUB_OWNER` | Repo owner (e.g. `megzjudge`) |
| `GITHUB_REPO` | Repo name (e.g. `spotify`) |
| `GITHUB_BRANCH` | Optional, defaults to `main` |
| `GITHUB_PATH` | Path for episode notes — set to `data/episode-notes.json` |
| `GITHUB_EXTERNAL_PATH` | Optional, defaults to `data/external-videos.json` |
| `AUTH` | Shared secret required to **write** notes/videos (sent as the `X-Auth` header) |
| `ADMIN_KEY` | Shared secret for `/api/save` (sent as the `x-admin-key` header) |

> **Heads-up on `GITHUB_PATH`:** it's read by both `episode-note.js` (which needs `data/episode-notes.json`) and the generic `save.js` (which falls back to `data/content.json`). If you use both features, point `GITHUB_PATH` at the notes file and pass an explicit path/payload to `/api/save` so they don't collide.

### 3. Mint your refresh token (one time)

After the first deploy with the Spotify secrets set, visit:

```
https://<your-domain>/api/auth/start
```

Authorize the app. The callback page prints a `SPOTIFY_REFRESH_TOKEN` — save it as a secret in Cloudflare, then redeploy.

> 🔒 **Security:** once the token is saved, delete `functions/api/auth/start.js` and `functions/api/auth/callback.js` and redeploy. They exist only to mint the token and shouldn't stay live. (If Spotify doesn't return a refresh token because you've authorized before, revoke the app under Spotify → Account → Apps and retry.)

## How content editing works

The note and video endpoints read the current JSON file from the repo via the GitHub Contents API, apply the change, and commit it back. Because each edit is a real commit, content is versioned and the `On Content Update` workflow fires on any push under `data/**` (currently it just logs the change — a hook for future automation).

Write operations are gated: notes and videos require the `X-Auth` header to match `AUTH`; `/api/save` requires `x-admin-key` to match `ADMIN_KEY`. Read operations are public.

## Notes

- No secrets are committed — every credential is read from the environment at runtime.
- The `*-test.js` endpoints only report which env vars are present (never their values) and can be deleted once everything works.

## License

No license file is included yet. If you'd like others to reuse this, consider adding one (e.g. MIT); until then, default copyright applies.
