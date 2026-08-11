# Spotify-Tracking Single-User Website

A personal, live-updating browser for Spotify playlists and podcast episodes. The front end is a static page; all Spotify calls happen server-side through **Cloudflare Pages Functions**, so access tokens never touch the browser. Lightweight content (episode notes, external video links) is stored as JSON in this repo and edited through the GitHub API — git doubles as the database.

## What it does

- Pulls a curated view of your Spotify library live - pulled easily from the [Spotify Web API](https://developer.spotify.com/documentation/web-api), with playlists grouped into sections (Daily Mix, Top, etc), a podcast episodes playlist, and a set of highlighted "created by others" playlists.
- Shows headline totals: number of playlists, total songs, and an approximate listening time. Exact per-playlist durations are computed on demand.
- Lets you open a playlist and list its tracks and podcast episodes — episode titles link straight to the episode on Spotify, and episodes are enriched by release date and artwork so they can be sorted by date added or date released. Shows that Spotify mirrors from elsewhere (e.g. YouTube channels re-published as podcasts) sometimes report a release date that's really just a re-sync timestamp rather than the true publish date; episodes where that's detectably wrong (release date after the date it was added to the playlist) are left out of release-date sorting rather than showing a bogus date.
- Supports **timestamped notes per podcast episode**, saved back into the repo so they persist and are versioned.
- Keeps a short list of **external video links** (with auto-fetched title and thumbnail), capped to the most recent few.

Only your public playlists are shown. Playlists are excluded by default if they aren't yours, are private, start with a `NP:` / `[Not Public]` prefix, or carry a `#notpublic` tag in the description — with an explicit allowlist so chosen playlists always appear.

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
| `functions/api/token-health.js` | Checks the Spotify refresh token is still valid; emails an alert if it's dead |
| `data/*.json` | Persisted content, committed by the functions above |
| `.github/workflows/workflow.yml` | Logs a note whenever anything under `data/**` changes |
| `.github/workflows/token-health-check.yml` | Daily cron that calls `/api/token-health` |

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
| `CRON_SECRET` | Shared secret required to call `/api/token-health` (sent as the `x-cron-secret` header) |
| `RESEND_API_KEY` | API key from [resend.com](https://resend.com), used to send the dead-token alert email |
| `ALERT_EMAIL` | Address the dead-token alert is sent to |
| `RESEND_FROM` | Optional, defaults to `onboarding@resend.dev` (Resend's shared test sender — only deliverable to the account owner's own address unless you verify a custom domain) |

> **Heads-up on `GITHUB_PATH`:** it's read by both `episode-note.js` (which needs `data/episode-notes.json`) and the generic `save.js` (which falls back to `data/content.json`). If you use both features, point `GITHUB_PATH` at the notes file and pass an explicit path/payload to `/api/save` so they don't collide.

### 3. Mint your refresh token (one time)

After the first deploy with the Spotify secrets set, visit:

```
https://<your-domain>/api/auth/start
```

Authorize the app. The callback page prints a `SPOTIFY_REFRESH_TOKEN` — save it as a secret in Cloudflare, then redeploy.

> 🔒 **Security:** once the token is saved, delete `functions/api/auth/start.js` and `functions/api/auth/callback.js` and redeploy. They exist only to mint the token and shouldn't stay live. (If Spotify doesn't return a refresh token because you've authorized before, revoke the app under Spotify → Account → Apps and retry.)

### 4. Alert on a dead Spotify token

Spotify refresh tokens can be revoked or stop working (e.g. if you re-authorize the app, revoke access under Spotify → Account → Apps, or the app itself gets removed). `/api/token-health` checks this on a schedule and emails you if it dies, since otherwise the site just fails silently until someone notices.

1. Create a free account at [resend.com](https://resend.com) and grab an API key.
2. Set these Cloudflare Pages env vars: `RESEND_API_KEY`, `ALERT_EMAIL` (where the alert goes), and `CRON_SECRET` (any random string — shared with the GitHub Action below).
3. In the GitHub repo, add two **Actions secrets**: `SITE_URL` (e.g. `https://your-domain.com`) and `CRON_SECRET` (same value as the Cloudflare one).
4. `.github/workflows/token-health-check.yml` runs daily and calls the endpoint — it also fails visibly in the Actions tab if the token is dead, in addition to the email.

You can trigger it manually any time from the Actions tab (`Spotify Token Health Check` → `Run workflow`) to confirm it's wired up.

## How content editing works

The note and video endpoints read the current JSON file from the repo via the GitHub Contents API, apply the change, and commit it back. Because each edit is a real commit, content is versioned and the `On Content Update` workflow fires on any push under `data/**` (currently it just logs the change — a hook for future automation).

Write operations are gated: notes and videos require the `X-Auth` header to match `AUTH`; `/api/save` requires `x-admin-key` to match `ADMIN_KEY`. Read operations are public.

## Notes

- No secrets are committed — every credential is read from the environment at runtime.
- The `*-test.js` endpoints only report which env vars are present (never their values) and can be deleted once everything works.

## License

No license file is included yet. If you'd like others to reuse this, consider adding one (e.g. MIT); until then, default copyright applies.
