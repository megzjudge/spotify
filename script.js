// script.js

(() => {
  /***********************
   * CONFIG
   ***********************/
  const API_REFRESH = "/api/refresh";
  const API_PLAYLIST = "/api/playlist";
  const API_EPISODE_NOTE = "/api/episode-note";
  const API_EPISODE_DATE = "/api/episode-date";

  // ✅ IMPORTANT:
  // /api/song-hours does NOT exist as a Pages Function right now (GET falls back to HTML, POST is 405).
  // We used to compute exact song-hours client-side via a Worker; that caused failures (Worker fetch URL parsing).
  // Now we will compute an approximate song-hours value locally from the song count.

  const PODCAST_PLAYLIST_ID = "2tHrihmpYzDbJ8rit7HtFR";

  const OTHERS_PLAYLIST_IDS = [
    "41PZG18MrSTagagiIaiG4X",
    "71z6BdHlnfNj4DKRhuu1Fk",
    "7jYNznHoIYgJBzwT5jpoOe",
    "4OXFjf05aU4K1B17AmA7ew",
    "5ZmAXSBNOEXYLf1e2MiF1D"
  ];

  // ✅ Podcast paging config
  const PODCAST_PAGE_LIMIT = 200;

  // ✅ Safety cap so we never go crazy if an API bug loops pages.
  const PODCAST_MAX_ITEMS = 5000;

  // ✅ Playlist track paging config (regular, non-podcast playlists)
  const PLAYLIST_TRACKS_PAGE_LIMIT = 200;
  const PLAYLIST_TRACKS_MAX_ITEMS = 5000;

  // ✅ Notes auth (client-side) — stored per-session only.
  const SS_NOTES_AUTH_KEY = "spotify_notes_auth";

  /***********************
   * DOM
   ***********************/
  const refreshButton = document.getElementById("refreshButton");
  const refreshProgress = document.getElementById("refreshProgress");
  const refreshProgressBar = document.getElementById("refreshProgressBar");
  const refreshProgressLabel = document.getElementById("refreshProgressLabel");
  const appMain = document.getElementById("appMain");

  /***********************
   * STATE
   ***********************/
  const state = {
    snapshot: null,
    filter: "all",
    others: [],
    podcast: {
      tried: false,
      error: null,
      playlist: null,
      items: [],
      droppedItems: [],
      // sorting for podcast panel
      sortBy: "added", // "released" | "added"
      sortDir: "desc" // "asc" | "desc"
    },

    // song-hours: we keep small state but we no longer spawn a Worker
    songHours: {
      running: false,
      lastError: null
    },

    // playlistId -> boolean, whether a track was added to that playlist within
    // the last NEW_BADGE_DAYS days. Populated progressively in the background
    // (see checkPlaylistsForNewTracksInBackground) so refresh stays fast.
    playlistNewFlag: new Map(),

    // Episode notes
    episodeNotes: {
      cache: Object.create(null),
      openEpisodeId: null,
      openMode: null,
      episodesWithNotes: new Set(),
      // episodeId -> combined note text, bulk-loaded so the search bar can
      // match against notes the user hasn't opened yet in this session.
      allNotesText: Object.create(null)
    },

    // Manual release-date corrections (episodeId -> { releaseDate, releaseDatePrecision }),
    // applied on top of whatever Spotify reports. See applyPodcastDateOverrides.
    episodeDates: {
      overrides: Object.create(null)
    }
  };

  /***********************
   * UI Helpers
   ***********************/
  function setButtonLoading(isLoading) {
    if (!refreshButton) return;
    refreshButton.disabled = isLoading;
    refreshButton.classList.toggle("is-loading", isLoading);
    if (isLoading) startRefreshProgress(); else finishRefreshProgress();
  }

  // Spotify sync usually takes ~20-30s, so ease the bar toward 92% over that
  // window as a "this is roughly how long it takes" cue, then snap to 100%
  // whenever the request actually resolves (could be sooner or later).
  function startRefreshProgress() {
    if (!refreshProgress || !refreshProgressBar) return;
    if (refreshProgressLabel) refreshProgressLabel.hidden = false;
    refreshProgress.classList.add("is-active");
    refreshProgressBar.style.transition = "none";
    refreshProgressBar.style.width = "0%";
    void refreshProgressBar.offsetWidth; // force reflow so the transition below animates from 0%
    refreshProgressBar.style.transition = "width 26s cubic-bezier(0.1, 0.6, 0.2, 1)";
    refreshProgressBar.style.width = "92%";
  }

  function finishRefreshProgress() {
    if (!refreshProgress || !refreshProgressBar) return;
    refreshProgressBar.style.transition = "width 0.35s ease-out";
    refreshProgressBar.style.width = "100%";
    setTimeout(() => {
      refreshProgress.classList.remove("is-active");
      refreshProgressBar.style.transition = "none";
      refreshProgressBar.style.width = "0%";
      if (refreshProgressLabel) refreshProgressLabel.hidden = true;
    }, 450);
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // render note text where URLs become a clickable 🔗 emoji
  function renderTextWithLinkEmojis(raw) {
    const text = String(raw ?? "");
    const re = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
    let out = "";
    let last = 0;
    for (const m of text.matchAll(re)) {
      const url = m[0];
      const idx = m.index ?? 0;
      out += escapeHtml(text.slice(last, idx));
      const safeUrl = escapeHtml(url);
      out += `<a class="epnote-link-emoji" href="${safeUrl}" target="_blank" rel="noopener noreferrer" title="${safeUrl}" aria-label="Open link">🔗</a>`;
      last = idx + url.length;
    }
    out += escapeHtml(text.slice(last));
    return out.replace(/\n/g, "<br>");
  }

  function fmtHoursFromMs(ms) {
    const h = (Number(ms) || 0) / 3600000;
    return `${h.toFixed(h >= 10 ? 0 : 1)}h`;
  }

  function fmtDurationFromMs(ms) {
    const totalSec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h}h ${mm}m`;
  }

  function setStatus(msg) {
    const el = document.getElementById("statusMessage");
    if (!el) return;
    el.textContent = msg || "";
  }

  function clampInt(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
  }

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
    if (parts.length >= 3) {
      const hh = clampInt(parts[0], 0, 999, 0);
      const mm = clampInt(parts[1], 0, 59, 0);
      const ss = clampInt(parts[2], 0, 59, 0);
      return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
    }
    return "00:00:00";
  }

  function normalizeNotesArray(arr) {
    const src = Array.isArray(arr) ? arr : [];
    const out = src
      .map((n) => ({
        timestamp: normalizeTimestamp(n?.timestamp),
        text: String(n?.text || "").trim()
      }))
      .filter((n) => n.timestamp || n.text);
    return out.length ? out : [{ timestamp: "00:00:00", text: "" }];
  }

  function meaningfulNotes(arr) {
    const src = Array.isArray(arr) ? arr : [];
    return src.filter((n) => String(n?.text || "").trim().length > 0);
  }

  function blankUntilClick() {
    if (!appMain) return;
    appMain.innerHTML = `
      <p class="status" id="statusMessage">
        Click “Refresh from Spotify” to load current live podcasts on Spotify.
      </p>
    `;
  }

  function buildShell() {
    if (!appMain) return;
    appMain.innerHTML = `
      <p class="status" id="statusMessage"></p>

      <div class="app-grid">

        <!-- LEFT COLUMN -->
        <div class="col col-left">

          <section class="panel">
            <div class="panel-header">
              <h2 class="panel-title">Statistics</h2>
            </div>
            <div class="panel-body">
              <div class="stats-grid" id="statsGrid"></div>
            </div>
          </section>

          <section class="panel" style="margin-top:16px;">
            <div class="panel-header">
              <h2 class="panel-title">Others playlists</h2>
            </div>
            <div class="panel-body">
              <div class="cards cards-compact" id="othersCards"></div>
            </div>
          </section>

        </div>

        <!-- MIDDLE COLUMN -->
        <section class="panel col col-mid">
          <div class="panel-body col-scroll-body">
            <div class="filter-pills" id="filterPills"></div>

            <div class="subpanel subpanel-flex" style="margin-top:12px;">
              <div class="subpanel-header">
                <h2 class="panel-title">Playlists</h2>
                <div class="subpanel-count" id="playlistCount">–</div>
              </div>
              <div class="cards cards-scroll" id="playlistCards"></div>
            </div>
          </div>
        </section>

        <!-- RIGHT COLUMN -->
        <aside class="panel col col-right">
          <div class="panel-header">
            <h2 class="panel-title">Podcasts</h2>
          </div>
          <div class="panel-body col-scroll-body">

            <div class="podcast-head" id="podcastHead" hidden>
              <img class="podcast-thumb" id="podcastThumb" alt="">
              <div style="min-width:0">
                <div class="podcast-title" id="podcastTitle"></div>
                <div class="podcast-sub" id="podcastSub"></div>
              </div>
              <div id="podcastHeadControls" aria-hidden="false"></div>
            </div>

            <div class="podcast-search-wrap">
              <input
                type="search"
                id="podcastSearchInput"
                class="podcast-search-input"
                aria-label="Search podcast episodes by title, creator, date, or notes"
                autocomplete="off"
                spellcheck="false"
              >
            </div>

            <div class="podcast-empty" id="podcastEmpty"></div>
            <div class="podcast-error" id="podcastError" hidden></div>

            <!-- ✅ UL is the scroll container -->
            <ul class="podcast-list" id="podcastList"></ul>
          </div>
        </aside>

      </div>

      <!-- MODAL -->
      <div class="modal-backdrop" id="modalBackdrop" aria-hidden="true">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
          <div class="modal-top">
            <h3 class="modal-title" id="modalTitle">Playlist</h3>
            <button class="modal-close" id="modalCloseBtn" type="button">Close</button>
          </div>

          <div class="detail-head">
            <img class="detail-thumb" id="detailThumb" alt="">
            <div style="min-width:0">
              <a class="detail-title" id="detailTitle" href="#" target="_blank" rel="noopener noreferrer"></a>
              <p class="detail-sub" id="detailSub"></p>
            </div>
          </div>

          <p class="playlist-progress-label" id="playlistProgressLabel" hidden>Pulling live data from Spotify…</p>
          <div class="refresh-progress full-width" id="playlistProgress" aria-hidden="true">
            <div class="refresh-progress-bar" id="playlistProgressBar"></div>
          </div>

          <ul class="tracklist" id="tracklist"></ul>
        </div>
      </div>
    `;

    const backdrop = document.getElementById("modalBackdrop");
    const closeBtn = document.getElementById("modalCloseBtn");
    if (closeBtn) closeBtn.addEventListener("click", closeModal);
    if (backdrop) {
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) closeModal();
      });
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeModal();
    });
  }

  /***********************
   * Cards
   ***********************/
  function cardHtml(p) {
    const img = p.image || "https://spotify.jdge.cc/images/spotify_logo.png";
    const count = typeof p.totalTracks === "number" ? `${p.totalTracks} items` : "";
    const owner = p.ownerLabel ? ` • ${p.ownerLabel}` : "";
    const isNew = state.playlistNewFlag.get(p.id) === true;
    return `
      <div class="card" data-playlist-id="${escapeHtml(p.id)}">
        <span class="card-new-badge" data-card-new-badge title="A track was added within the last ${NEW_BADGE_DAYS} days" ${isNew ? "" : "hidden"}>New</span>
        <img class="thumb" src="${escapeHtml(img)}" alt="" loading="lazy" decoding="async">
        <div class="card-meta">
          <p class="card-title">${escapeHtml(p.name || "Untitled")}</p>
          <p class="card-sub">${escapeHtml(count)}${escapeHtml(owner)}</p>
        </div>
      </div>
    `;
  }

  function wireCardClicks(containerEl) {
    containerEl.querySelectorAll(".card[data-playlist-id]").forEach((el) => {
      el.addEventListener("click", async () => {
        const id = el.getAttribute("data-playlist-id");
        if (!id) return;
        await openPlaylistModal(id);
      });
    });
  }

  /***********************
   * Statistics
   ***********************/
  function computeSongCountFromSnapshot({ includeOthers = false } = {}) {
    const sections = state.snapshot?.sections || {};
    const getList = (k) => (Array.isArray(sections?.[k]) ? sections[k] : []);
    const core = [...getList("dailyMix"), ...getList("top"), ...getList("other")];
    const sumTracks = (arr) => arr.reduce((acc, p) => acc + (Number(p?.totalTracks) || 0), 0);
    let sum = sumTracks(core);
    if (includeOthers) sum += sumTracks(state.others || []);
    return sum;
  }

  function computePodcastStatsFromState() {
    const items = Array.isArray(state.podcast?.items) ? state.podcast.items : [];
    const episodes = items.length;
    const ms = items.reduce((acc, it) => acc + (Number(it?.durationMs) || 0), 0);
    return { episodes, ms };
  }

  function getSongHoursDisplay(totals) {
    const exact = totals?.songMsExact;
    const approx = totals?.songMsApprox;
    const status = String(totals?.songHoursStatus || "");

    if (typeof exact === "number") return { label: fmtHoursFromMs(exact), hint: "" };

    if (typeof approx === "number") {
      const approxLabel = `~${fmtHoursFromMs(approx)}`;
      const hint = status === "computing" ? ` (computing…)` : "";
      return { label: approxLabel, hint };
    }

    return { label: "–", hint: "" };
  }

  function renderStatistics() {
    const grid = document.getElementById("statsGrid");
    if (!grid) return;

    const totals = state.snapshot?.totals || {};
    const playlists = totals.playlists ?? "–";

    const computedSongs = computeSongCountFromSnapshot({ includeOthers: false });
    const songs = computedSongs > 0 ? computedSongs : totals.songs ?? "–";

    const songHours = getSongHoursDisplay(totals);

    const pod = computePodcastStatsFromState();
    const podEps = pod.episodes > 0 ? pod.episodes : totals.podcastEpisodes ?? "–";
    const podHours =
      pod.episodes > 0
        ? fmtHoursFromMs(pod.ms)
        : typeof totals.podcastMs === "number"
          ? fmtHoursFromMs(totals.podcastMs)
          : "–";

    grid.innerHTML = `
      <div class="stat-card span-2">
        <div class="stat-kicker">Total playlists</div>
        <div class="stat-big">${escapeHtml(String(playlists))}</div>
      </div>

      <div class="stat-card">
        <div class="stat-kicker">Total songs</div>
        <div class="stat-big">${escapeHtml(String(songs))}</div>
      </div>

      <div class="stat-card">
        <div class="stat-kicker">Total Song Hrs</div>
        <div class="stat-big">
          ${escapeHtml(String(songHours.label))}
          ${songHours.hint ? `<span class="stat-computing">${escapeHtml(songHours.hint)}</span>` : ""}
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-kicker">Podcast episodes</div>
        <div class="stat-big">${escapeHtml(String(podEps))}</div>
      </div>

      <div class="stat-card">
        <div class="stat-kicker">Podcast hrs</div>
        <div class="stat-big">${escapeHtml(String(podHours))}</div>
      </div>
    `;
  }

  /***********************
   * Song-hours: APPROXIMATE compute (no Worker)
   ***********************/
  function stopSongHoursWorker() {
    // No worker exists anymore. Just reset state bookkeeping.
    state.songHours.running = false;
    state.songHours.lastError = null;
  }

  // Compute an approximate total ms for songs using a conservative average track length.
  function computeApproxSongMs() {
    const totals = state.snapshot?.totals || {};
    // Prefer explicit totals.songs when available
    const songs = Number(totals?.songs) || computeSongCountFromSnapshot();
    // Average track length assumption: 3.5 minutes = 210,000 ms
    const AVG_MS = 210000;
    return Math.max(0, Math.floor(Number(songs) * AVG_MS));
  }

  function startSongHoursComputeClientSide() {
    if (!state.snapshot?.totals) return;

    // If we already have exact, don’t recompute
    if (typeof state.snapshot.totals.songMsExact === "number") return;

    try {
      const approxMs = computeApproxSongMs();
      state.snapshot.totals.songMsApprox = approxMs;
      state.snapshot.totals.songHoursStatus = "approx";
      // render immediately
      renderStatistics();
    } catch (err) {
      console.warn("approx song-hours compute failed:", err);
      state.songHours.lastError = String(err?.message || err);
      if (state.snapshot?.totals) state.snapshot.totals.songHoursStatus = "approx";
    }
  }

  /***********************
   * Filters + playlists
   ***********************/
  function getSection(name) {
    const sections = state.snapshot?.sections || {};
    const list = sections?.[name];
    return Array.isArray(list) ? list : [];
  }

  function getFilteredPlaylists() {
    const dailyMix = getSection("dailyMix");
    const top = getSection("top");
    const other = getSection("other");

    if (state.filter === "dailyMix") return dailyMix;
    if (state.filter === "top") return top;
    if (state.filter === "other") return other;
    return [...dailyMix, ...top, ...other];
  }

  function setFilter(next) {
    state.filter = next;
    renderFilterPills();
    renderPlaylists();
  }

  function parseSortDate(raw) {
    if (!raw) return null;
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : null;
  }

  function episodeReleaseSortKey(ep) {
    const raw = ep?.releaseDate ?? ep?.release_date;
    if (!raw) return null;

    const precision = ep?.releaseDatePrecision ?? ep?.release_date_precision ?? "day";
    const parts = String(raw).trim().split("-");
    const y = Number(parts[0]) || 0;
    let m = Number(parts[1]) || 0;
    let d = Number(parts[2]) || 0;

    // Spotify sometimes returns a placeholder/zero year (e.g. "0000-07-29") instead
    // of omitting release_date entirely for catalog entries with no known year.
    // Treat that the same as "no date" rather than sorting it as the oldest thing ever.
    if (!y) return null;

    if (precision === "year") {
      m = 1;
      d = 1;
    } else if (precision === "month") {
      d = 1;
    } else {
      if (!m) m = 1;
      if (!d) d = 1;
    }

    // Some shows (mirrored video podcasts — After Skool, Wendover Productions,
    // etc.) get a release_date from Spotify that's really a re-sync/ingestion
    // date rather than the true original publish date. That shows up as a
    // release date AFTER the episode was added to the playlist, which is
    // impossible for a real release. Treat that contradiction the same as
    // "no real date" instead of sorting it as if it just came out.
    const releaseMs = Date.UTC(y, m - 1, d);
    const addedMs = episodeAddedMs(ep);
    if (addedMs && releaseMs > addedMs) return null;

    return (y * 10000) + (m * 100) + d;
  }

  function episodeAddedMs(ep) {
    return parseSortDate(ep?.addedAt ?? ep?.added_at);
  }

  const NEW_BADGE_DAYS = 30;

  function isNewSince(ms, days = NEW_BADGE_DAYS) {
    if (!ms) return false;
    const cutoffMs = days * 24 * 60 * 60 * 1000;
    return Date.now() - ms <= cutoffMs;
  }

  function newBadgeHtml(ms) {
    return isNewSince(ms)
      ? `<span class="new-badge" title="Added within the last ${NEW_BADGE_DAYS} days">New</span>`
      : "";
  }

  function fmtEpisodeDisplayDate(raw, precision) {
    if (!raw) return "Unknown";
    const parts = String(raw).trim().split("-");
    const y = parts[0];
    const m = parts[1];
    const d = parts[2];

    // Same zero/placeholder-year guard as episodeReleaseSortKey.
    if (!Number(y)) return "Unknown";

    if (precision === "year" || (!m && !d)) return y;
    if (precision === "month" || !d) {
      const month = Number(m);
      if (month >= 1 && month <= 12) {
        return `${new Date(Date.UTC(y, month - 1, 1)).toLocaleDateString(undefined, { month: "short", year: "numeric" })}`;
      }
      return `${y}-${m}`;
    }

    const t = Date.parse(`${y}-${m}-${d}`);
    if (!Number.isFinite(t)) return String(raw);
    return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function fmtEpisodeAddedDisplayDate(ep) {
    const ms = episodeAddedMs(ep);
    if (!ms) return "Unknown";
    return new Date(ms).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric"
    });
  }

  function renderPodcastMetaIcons(it) {
    const releaseRaw = it?.releaseDate ?? it?.release_date;
    const releasePrecision = it?.releaseDatePrecision ?? it?.release_date_precision ?? "day";
    const releasedLabel = fmtEpisodeDisplayDate(releaseRaw, releasePrecision);
    const addedLabel = fmtEpisodeAddedDisplayDate(it);
    const isOverridden = !!it?.addedDateOverridden;
    const releasedTip = `Released: ${releasedLabel}`;
    const addedTip = `Added: ${addedLabel}${isOverridden ? " (manually corrected)" : ""}`;
    const episodeId = String(it?.id || "").trim();

    const editBtn = episodeId
      ? `<button type="button" class="pod-date-edit${isOverridden ? " is-overridden" : ""}" title="Correct date added" aria-label="Correct date added" data-epdate-edit="${escapeHtml(episodeId)}">✏️</button>`
      : "";

    return `
      <span class="pod-meta-emoji" tabindex="0" role="img" aria-label="${escapeHtml(addedTip)}" title="${escapeHtml(addedTip)}" data-tip="${escapeHtml(addedTip)}">➕</span>
      <span class="pod-meta-emoji" tabindex="0" role="img" aria-label="${escapeHtml(releasedTip)}" title="${escapeHtml(releasedTip)}" data-tip="${escapeHtml(releasedTip)}">📅</span>
      ${editBtn}
    `;
  }

  function episodeSortValue(ep) {
    const sortBy = state.podcast.sortBy || "released";
    return sortBy === "added" ? episodeAddedMs(ep) : episodeReleaseSortKey(ep);
  }

  // Default sort — clicking whichever button is already active reverts to this.
  const DEFAULT_PODCAST_SORT = { sortBy: "added", sortDir: "desc" };

  function setPodcastSort(by, dir) {
    if (!by) return;
    const field = by === "added" ? "added" : "released";
    const direction = dir === "asc" ? "asc" : "desc";

    const isSameAsCurrent = state.podcast.sortBy === field && state.podcast.sortDir === direction;
    if (isSameAsCurrent) {
      state.podcast.sortBy = DEFAULT_PODCAST_SORT.sortBy;
      state.podcast.sortDir = DEFAULT_PODCAST_SORT.sortDir;
      return;
    }

    state.podcast.sortBy = field;
    state.podcast.sortDir = direction;
  }

  function comparePodcastEpisodes(a, b) {
    const sortDir = state.podcast.sortDir === "asc" ? 1 : -1;
    const ta = episodeSortValue(a);
    const tb = episodeSortValue(b);
    const aVal = ta ?? (sortDir === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
    const bVal = tb ?? (sortDir === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
    if (aVal === bVal) return 0;
    return aVal < bVal ? -1 * sortDir : 1 * sortDir;
  }

  function podcastSortDirBtnClass(field, dir) {
    const active = state.podcast.sortBy === field && state.podcast.sortDir === dir;
    return `pod-sort-btn pod-sort-dir${active ? " active" : ""}`;
  }

  function renderPodcastSortControls() {
    const controlsEl = document.getElementById("podcastHeadControls");
    if (!controlsEl) return;

    controlsEl.innerHTML = `
      <div class="pod-sort-groups">
        <div class="pod-sort-group" title="Sort by date added to playlist">
          <span class="pod-sort-label" aria-hidden="true">➕</span>
          <button type="button" class="${podcastSortDirBtnClass("added", "asc")}" data-sort="added" data-dir="asc" aria-label="Date added, oldest first">▲</button>
          <button type="button" class="${podcastSortDirBtnClass("added", "desc")}" data-sort="added" data-dir="desc" aria-label="Date added, newest first">▼</button>
        </div>
        <div class="pod-sort-group" title="Sort by release date">
          <span class="pod-sort-label" aria-hidden="true">📅</span>
          <button type="button" class="${podcastSortDirBtnClass("released", "asc")}" data-sort="released" data-dir="asc" aria-label="Release date, oldest first">▲</button>
          <button type="button" class="${podcastSortDirBtnClass("released", "desc")}" data-sort="released" data-dir="desc" aria-label="Release date, newest first">▼</button>
        </div>
      </div>
    `;

    if (controlsEl.__sortBound) return;
    controlsEl.__sortBound = true;
    controlsEl.addEventListener("click", (e) => {
      const btn = e.target?.closest?.("button[data-sort][data-dir]");
      if (!btn) return;
      e.preventDefault();
      setPodcastSort(btn.getAttribute("data-sort"), btn.getAttribute("data-dir"));
      renderPodcastColumn();
    });
  }

  /***********************
   * Podcast search (title / creator / date / cloud notes)
   ***********************/
  function wirePodcastSearch() {
    const input = document.getElementById("podcastSearchInput");
    if (!input || input.__searchBound) return;
    input.__searchBound = true;
    input.addEventListener("input", () => renderPodcastColumn());
  }

  // Parses date-ish queries into { year, month, day } (month/day null when not
  // given). Accepts "2023", "2023-06", "2023-06-15", "2023/06/15", "2023 06 15",
  // and the run-together forms "202306" / "20230615". Returns null if the query
  // isn't date-shaped at all, so callers fall through to text matching.
  function parsePodcastDateQuery(q) {
    const trimmed = String(q || "").trim();
    if (!trimmed || !/^[\d\s./-]+$/.test(trimmed)) return null;

    const parts = trimmed.split(/[\s./-]+/).filter(Boolean);
    let year = null, month = null, day = null;

    if (parts.length === 1) {
      const digits = parts[0];
      if (digits.length === 4) {
        year = Number(digits);
      } else if (digits.length === 6) {
        year = Number(digits.slice(0, 4));
        month = Number(digits.slice(4, 6));
      } else if (digits.length === 8) {
        year = Number(digits.slice(0, 4));
        month = Number(digits.slice(4, 6));
        day = Number(digits.slice(6, 8));
      } else {
        return null;
      }
    } else if (parts.length === 2 && parts[0].length === 4) {
      year = Number(parts[0]);
      month = Number(parts[1]);
    } else if (parts.length === 3 && parts[0].length === 4) {
      year = Number(parts[0]);
      month = Number(parts[1]);
      day = Number(parts[2]);
    } else {
      return null;
    }

    if (!year || year < 1000) return null;
    if (month != null && (month < 1 || month > 12)) return null;
    if (day != null && (day < 1 || day > 31)) return null;

    return { year, month: month || null, day: day || null };
  }

  function episodeReleaseDateParts(ep) {
    const raw = ep?.releaseDate ?? ep?.release_date;
    if (!raw) return null;
    const precision = ep?.releaseDatePrecision ?? ep?.release_date_precision ?? "day";
    const parts = String(raw).trim().split("-");
    const y = Number(parts[0]) || 0;
    if (!y) return null;
    let m = parts[1] ? Number(parts[1]) : null;
    let d = parts[2] ? Number(parts[2]) : null;
    if (precision === "year") { m = null; d = null; }
    else if (precision === "month") { d = null; }
    return { y, m, d };
  }

  function episodeAddedDateParts(ep) {
    const ms = episodeAddedMs(ep);
    if (!ms) return null;
    const dt = new Date(ms);
    return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
  }

  function dateStructMatchesQuery(parts, parsed) {
    if (!parts || parts.y !== parsed.year) return false;
    if (parsed.month != null && parts.m !== parsed.month) return false;
    if (parsed.day != null && parts.d !== parsed.day) return false;
    return true;
  }

  function episodeDateMatchesQuery(ep, parsed) {
    if (!parsed) return false;
    return dateStructMatchesQuery(episodeReleaseDateParts(ep), parsed)
      || dateStructMatchesQuery(episodeAddedDateParts(ep), parsed);
  }

  // Prefers the fully-loaded per-episode cache (populated once someone opens
  // that episode's notes) and falls back to the bulk-loaded text.
  function episodeNotesSearchText(episodeId) {
    if (!episodeId) return "";
    const entry = state.episodeNotes.cache?.[episodeId];
    if (entry?.loadedSaved && Array.isArray(entry.savedNotes)) {
      return entry.savedNotes.map((n) => n?.text || "").join(" ");
    }
    return state.episodeNotes.allNotesText[episodeId] || "";
  }

  function podcastEpisodeMatchesSearch(ep, rawQuery) {
    const q = String(rawQuery || "").trim().toLowerCase();
    if (!q) return true;

    const title = String(ep?.name || "").toLowerCase();
    if (title.includes(q)) return true;

    const creator = (ep.artists || []).join(" ").toLowerCase();
    if (creator.includes(q)) return true;

    const parsedDate = parsePodcastDateQuery(q);
    if (parsedDate && episodeDateMatchesQuery(ep, parsedDate)) return true;

    const episodeId = String(ep?.id || "").trim();
    const notesText = episodeNotesSearchText(episodeId).toLowerCase();
    if (notesText.includes(q)) return true;

    return false;
  }

  function renderFilterPills() {
    const pills = document.getElementById("filterPills");
    if (!pills) return;

    const dailyMix = getSection("dailyMix");
    const top = getSection("top");
    const other = getSection("other");
    const allCount = dailyMix.length + top.length + other.length;

    const pill = (key, label, count) => `
      <button class="pill ${state.filter === key ? "active" : ""}" type="button" data-filter="${key}">
        <span class="pill-label">${escapeHtml(label)}</span>
        <span class="pill-count">${count}</span>
      </button>
    `;

    pills.innerHTML =
      pill("all", "All", allCount) +
      pill("dailyMix", "Daily Mix", dailyMix.length) +
      pill("top", "Top", top.length) +
      pill("other", "Other", other.length);

    pills.querySelectorAll("button[data-filter]").forEach((b) => {
      b.addEventListener("click", () => setFilter(b.getAttribute("data-filter")));
    });
  }

  function renderPlaylists() {
    const cards = document.getElementById("playlistCards");
    const count = document.getElementById("playlistCount");
    if (!cards || !count) return;

    const list = getFilteredPlaylists();
    cards.innerHTML = list.map(cardHtml).join("");
    count.textContent = String(list.length);
    wireCardClicks(cards);
  }

  /***********************
   * Manual panels (Others)
   ***********************/
  async function fetchPlaylistMeta(playlistId, ownerLabelFallback) {
    const res = await fetch(API_PLAYLIST, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ playlistId, limit: 0 })
    });

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}

    if (!res.ok || !data?.playlist) {
      console.error("Playlist meta API failure:", { status: res.status, data, text });
      return null;
    }

    const p = data.playlist;
    return {
      id: p.id || playlistId,
      name: p.name || "Untitled playlist",
      url: p.url || null,
      image: p.image || null,
      totalTracks: typeof p.totalTracks === "number" ? p.totalTracks : null,
      ownerLabel: p.ownerLabel || ownerLabelFallback
    };
  }

  async function loadOthersFallback() {
    // /api/refresh already includes othersPlaylists in the common case, so this
    // usually resolves from othersById with zero network calls. When it does need
    // to fall back, resolve the misses in parallel rather than one at a time.
    const othersById = new Map((state.others || []).map((p) => [p.id, p]));

    const resolved = await Promise.all(
      OTHERS_PLAYLIST_IDS.map((id) =>
        othersById.has(id) ? Promise.resolve(othersById.get(id)) : fetchPlaylistMeta(id, "by others")
      )
    );

    state.others = resolved.filter(Boolean);
  }

  function renderOthers() {
    const el = document.getElementById("othersCards");
    if (!el) return;

    el.innerHTML = state.others.length
      ? state.others.map(cardHtml).join("")
      : `<div class="muted-small">No “others” playlists added.</div>`;

    wireCardClicks(el);
  }

  /***********************
   * New-track badge (background check)
   ***********************/
  const NEW_TRACK_CHECK_CONCURRENCY = 4;
  const NEW_TRACK_CHECK_TAIL = 15; // trailing items inspected per playlist (new tracks are normally appended at the end)

  async function playlistHasRecentTrack(id, totalTracks) {
    const limit = NEW_TRACK_CHECK_TAIL;
    const offset = typeof totalTracks === "number" ? Math.max(0, totalTracks - limit) : 0;

    const res = await fetch(API_PLAYLIST, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ playlistId: id, limit, offset })
    });
    if (!res.ok) return false;

    const data = await res.json().catch(() => null);
    const items = Array.isArray(data?.items) ? data.items : [];
    return items.some((t) => {
      const ms = parseSortDate(t.addedAt);
      return ms != null && isNewSince(ms);
    });
  }

  function setCardNewBadge(playlistId, isNew) {
    document.querySelectorAll(`.card[data-playlist-id="${CSS.escape(playlistId)}"] [data-card-new-badge]`)
      .forEach((el) => { el.hidden = !isNew; });
  }

  // Runs after a refresh, a few playlists at a time, so the refresh itself stays fast.
  // Checks the tail of each playlist for tracks added within NEW_BADGE_DAYS and pops
  // the "New" corner badge onto that playlist's card as results come in.
  function checkPlaylistsForNewTracksInBackground() {
    const entries = [];
    const seen = new Set();
    const collect = (p) => {
      if (!p?.id || seen.has(p.id)) return;
      seen.add(p.id);
      entries.push({ id: p.id, totalTracks: typeof p.totalTracks === "number" ? p.totalTracks : null });
    };

    const sections = state.snapshot?.sections || {};
    (sections.dailyMix || []).forEach(collect);
    (sections.top || []).forEach(collect);
    (sections.other || []).forEach(collect);
    (state.others || []).forEach(collect);

    let cursor = 0;
    async function worker() {
      while (cursor < entries.length) {
        const entry = entries[cursor++];
        try {
          const isNew = await playlistHasRecentTrack(entry.id, entry.totalTracks);
          state.playlistNewFlag.set(entry.id, isNew);
          if (isNew) setCardNewBadge(entry.id, true);
        } catch (e) {
          console.warn("New-track check failed for playlist", entry.id, e);
        }
      }
    }

    const workers = Array.from({ length: NEW_TRACK_CHECK_CONCURRENCY }, worker);
    Promise.allSettled(workers);
  }

  /***********************
   * Episode Notes
   ***********************/
  function getEpisodeCacheEntry(episodeId) {
    if (!episodeId) return null;
    const c = state.episodeNotes.cache;

    if (!c[episodeId]) {
      c[episodeId] = {
        savedNotes: [{ timestamp: "00:00:00", text: "" }],
        draftNotes: [{ timestamp: "00:00:00", text: "" }],
        loadedSaved: false,
        saving: false,
        savedAt: null,
        error: null
      };
      return c[episodeId];
    }

    const entry = c[episodeId];

    if (Array.isArray(entry.notes) && !Array.isArray(entry.savedNotes)) {
      entry.savedNotes = normalizeNotesArray(entry.notes);
      entry.loadedSaved = !!entry.loaded;
      delete entry.notes;
      delete entry.loaded;
    }
    if (!Array.isArray(entry.savedNotes)) entry.savedNotes = [{ timestamp: "00:00:00", text: "" }];
    if (!Array.isArray(entry.draftNotes)) entry.draftNotes = [{ timestamp: "00:00:00", text: "" }];
    if (typeof entry.loadedSaved !== "boolean") entry.loadedSaved = false;

    return entry;
  }

  async function loadEpisodeNotesSummary() {
    try {
      const res = await fetch(`${API_EPISODE_NOTE}?summary=1`, {
        method: "GET",
        headers: { Accept: "application/json" }
      });

      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch {}

      if (!res.ok) {
        console.warn("Episode notes summary failed:", res.status, data || text);
        state.episodeNotes.episodesWithNotes = new Set();
        return;
      }

      const ids = Array.isArray(data?.episodesWithNotes) ? data.episodesWithNotes : [];
      state.episodeNotes.episodesWithNotes = new Set(ids.map(String));
    } catch (e) {
      console.warn("Episode notes summary fetch error:", e);
      state.episodeNotes.episodesWithNotes = new Set();
    }
  }

  // Bulk-loads all saved note text (not just which episodes have notes) so the
  // podcast search bar can match cloud notes the user hasn't opened yet.
  async function loadAllEpisodeNotesText() {
    try {
      const res = await fetch(`${API_EPISODE_NOTE}?all=1`, {
        method: "GET",
        headers: { Accept: "application/json" }
      });

      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch {}

      if (!res.ok) {
        console.warn("Episode notes bulk fetch failed:", res.status, data || text);
        return;
      }

      const notesByEpisode = (data?.notes && typeof data.notes === "object") ? data.notes : {};
      const out = Object.create(null);
      for (const [episodeId, rows] of Object.entries(notesByEpisode)) {
        if (!episodeId || !Array.isArray(rows)) continue;
        out[episodeId] = rows.map((r) => r?.text || "").join(" ");
      }
      state.episodeNotes.allNotesText = out;
    } catch (e) {
      console.warn("Episode notes bulk fetch error:", e);
    }
  }

  /***********************
   * Episode date overrides
   ***********************/
  async function loadEpisodeDateOverrides() {
    try {
      const res = await fetch(API_EPISODE_DATE, {
        method: "GET",
        headers: { Accept: "application/json" }
      });

      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch {}

      if (!res.ok) {
        console.warn("Episode date overrides fetch failed:", res.status, data || text);
        return;
      }

      const overrides = (data?.overrides && typeof data.overrides === "object") ? data.overrides : {};
      state.episodeDates.overrides = overrides;
    } catch (e) {
      console.warn("Episode date overrides fetch error:", e);
    }
  }

  // Merges manual overrides on top of state.podcast.items so every other piece
  // of code (sorting, display formatting, search) keeps reading ep.addedAt as
  // usual, unaware an override even happened.
  function applyPodcastDateOverrides() {
    const overrides = state.episodeDates.overrides || {};
    state.podcast.items = (state.podcast.items || []).map((ep) => {
      const id = String(ep?.id || "").trim();
      const ov = id ? overrides[id] : null;
      if (!ov || !ov.addedAt) return ep;
      return {
        ...ep,
        addedAt: ov.addedAt,
        addedDateOverridden: true
      };
    });
  }

  async function saveEpisodeAddedDateOverride(episodeId, addedAt, authToken) {
    const res = await fetch(API_EPISODE_DATE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Auth": String(authToken || "")
      },
      body: JSON.stringify({ episodeId, addedAt: addedAt || "" })
    });

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}

    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || text || `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) setNotesAuthToken("");
      throw new Error(msg);
    }

    if (addedAt) {
      state.episodeDates.overrides[episodeId] = data?.override || { addedAt: `${addedAt}T12:00:00.000Z` };
    } else {
      delete state.episodeDates.overrides[episodeId];
    }
  }

  // Lightweight prompt-based editor — mirrors the password gate already used
  // for notes (ensureNotesAuthOrThrow) rather than building a whole new modal.
  async function handleEditAddedDateClick(episodeId, ep) {
    if (!episodeId) return;

    const currentParts = episodeAddedDateParts(ep);
    const current = currentParts
      ? `${currentParts.y}-${String(currentParts.m).padStart(2, "0")}-${String(currentParts.d).padStart(2, "0")}`
      : "";

    const raw = window.prompt(
      "Set date added as YYYY-MM-DD.\nLeave blank and OK to clear the override and use Spotify's date.",
      current
    );
    if (raw === null) return; // cancelled

    const trimmed = raw.trim();
    if (trimmed && !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      window.alert("Please use YYYY-MM-DD.");
      return;
    }

    let authToken = "";
    try {
      authToken = ensureNotesAuthOrThrow();
    } catch (err) {
      window.alert(String(err?.message || err));
      return;
    }

    // Send the bare YYYY-MM-DD — the server normalizes it to a full ISO
    // timestamp anchored at noon UTC. (Sending it pre-suffixed here used to
    // fail the server's date regex silently, so every save was a no-op clear.)
    try {
      await saveEpisodeAddedDateOverride(episodeId, trimmed, authToken);
      applyPodcastDateOverrides();
      renderPodcastColumn();
    } catch (err) {
      window.alert(`Failed to save date: ${String(err?.message || err)}`);
    }
  }

  async function fetchEpisodeNotes(episodeId) {
    const entry = getEpisodeCacheEntry(episodeId);
    if (!entry) return null;

    entry.error = null;

    const res = await fetch(`${API_EPISODE_NOTE}?episodeId=${encodeURIComponent(episodeId)}`, {
      method: "GET",
      headers: { Accept: "application/json" }
    });

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}

    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || text || `HTTP ${res.status}`;
      throw new Error(msg);
    }

    const notes = Array.isArray(data?.notes) ? data.notes : [];
    entry.savedNotes = normalizeNotesArray(notes);
    entry.loadedSaved = true;
    entry.savedAt = null;
    entry.error = null;

    const hasText = meaningfulNotes(entry.savedNotes).length > 0;
    if (hasText) state.episodeNotes.episodesWithNotes.add(String(episodeId));
    else state.episodeNotes.episodesWithNotes.delete(String(episodeId));

    return entry;
  }

  function getNotesAuthToken() {
    try { return sessionStorage.getItem(SS_NOTES_AUTH_KEY) || ""; } catch { return ""; }
  }

  function setNotesAuthToken(token) {
    try {
      if (!token) sessionStorage.removeItem(SS_NOTES_AUTH_KEY);
      else sessionStorage.setItem(SS_NOTES_AUTH_KEY, token);
    } catch {}
  }

  function ensureNotesAuthOrThrow() {
    let token = getNotesAuthToken();
    if (token) return token;

    token = window.prompt("Enter notes password:");
    token = String(token || "").trim();
    if (!token) throw new Error("Save cancelled (missing password).");

    setNotesAuthToken(token);
    return token;
  }

  async function saveEpisodeNotes(episodeId, notes, authToken) {
    const entry = getEpisodeCacheEntry(episodeId);
    if (!entry) return;

    entry.saving = true;
    entry.error = null;
    entry.savedAt = null;
    renderPodcastColumn();

    const payload = {
      episodeId,
      notes: normalizeNotesArray(notes)
    };

    const res = await fetch(API_EPISODE_NOTE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Auth": String(authToken || "")
      },
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}

    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || text || `HTTP ${res.status}`;
      entry.saving = false;
      entry.error = msg;

      if (res.status === 401 || res.status === 403) setNotesAuthToken("");

      renderPodcastColumn();
      throw new Error(msg);
    }

    entry.savedNotes = normalizeNotesArray(payload.notes);
    entry.loadedSaved = true;
    entry.saving = false;
    entry.error = null;
    entry.savedAt = Date.now();

    const hasText = meaningfulNotes(entry.savedNotes).length > 0;
    if (hasText) state.episodeNotes.episodesWithNotes.add(String(episodeId));
    else state.episodeNotes.episodesWithNotes.delete(String(episodeId));

    renderPodcastColumn();
  }

  function episodeHasNotes(episodeId) {
    if (!episodeId) return false;

    if (state.episodeNotes.episodesWithNotes?.has(String(episodeId))) return true;

    const entry = state.episodeNotes.cache?.[episodeId];
    if (!entry) return false;

    const saved = Array.isArray(entry.savedNotes) ? entry.savedNotes : [];
    return meaningfulNotes(saved).length > 0;
  }

  function savedNotesForEpisode(episodeId) {
    if (!episodeId) return [];
    const entry = getEpisodeCacheEntry(episodeId);
    const notes = Array.isArray(entry?.savedNotes) ? entry.savedNotes : [];
    return meaningfulNotes(
      notes.map((n) => ({
        timestamp: normalizeTimestamp(n?.timestamp),
        text: String(n?.text || "")
      }))
    );
  }

  function renderSavedNotesBlock(episodeId) {
    const notes = savedNotesForEpisode(episodeId);
    if (!notes.length) return "";

    const lines = notes.map((n) => {
      const ts = escapeHtml(n.timestamp);
      const tx = renderTextWithLinkEmojis(n.text);
      return `
        <div class="epnote-saved-line">
          <div class="epnote-saved-ts">${ts}</div>
          <div class="epnote-saved-text">${tx}</div>
        </div>
      `;
    }).join("");

    return `
      <div class="epnote-saved" data-epnote-saved="${escapeHtml(episodeId)}">
        <div class="epnote-saved-head">
          <div class="epnote-saved-title">Saved notes</div>
          <button
            class="epnote-edit"
            type="button"
            title="Edit notes"
            aria-label="Edit notes"
            data-epnote-edit="${escapeHtml(episodeId)}"
          >📝</button>
        </div>
        ${lines}
      </div>
    `;
  }

  /***********************
   * Podcast panel
   ***********************/

  function safeJsonParse(text) {
    try { return text ? JSON.parse(text) : null; } catch { return null; }
  }

  function extractPaging(data) {
    const nextOffset =
      (Number.isFinite(Number(data?.nextOffset)) ? Number(data.nextOffset) : null) ??
      (Number.isFinite(Number(data?.nextPageOffset)) ? Number(data.nextPageOffset) : null) ??
      null;

    const hasMore =
      (typeof data?.hasMore === "boolean" ? data.hasMore : null) ??
      (typeof data?.more === "boolean" ? data.more : null) ??
      null;

    return { nextOffset, hasMore };
  }

  async function fetchPodcastEpisodesPaged(playlistId, { limit = 200, maxItems = 5000 } = {}) {
    let playlistMeta = null;
    let offset = 0;
    let safety = 0;
    const seenIds = new Set();
    const out = [];

    while (true) {
      safety++;
      if (safety > 200) break;

      const res = await fetch(API_PLAYLIST, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ playlistId, limit, offset })
      });

      const text = await res.text();
      const data = safeJsonParse(text);

      if (!res.ok || !data) {
        const msg = (data && (data.message || data.error)) || text || `HTTP ${res.status}`;
        throw new Error(msg);
      }

      if (!playlistMeta) playlistMeta = data.playlist || null;

      const items = Array.isArray(data.items) ? data.items : [];
      const eps = items.filter((x) => x?.type === "episode" || x?.type === "track");

      let addedThisPage = 0;
      for (const ep of eps) {
        const id = String(ep?.id || "").trim();
        if (!id) continue;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        out.push(ep);
        addedThisPage++;
        if (out.length >= maxItems) break;
      }

      if (out.length >= maxItems) break;

      const { nextOffset, hasMore } = extractPaging(data);

      if (hasMore === true) {
        const next = (nextOffset !== null) ? nextOffset : (offset + limit);
        if (next === offset && addedThisPage === 0) break;
        offset = next;
        continue;
      }

      if (nextOffset !== null && nextOffset !== offset) {
        offset = nextOffset;
        continue;
      }

      if (items.length >= limit) {
        const next = offset + limit;
        if (next === offset && addedThisPage === 0) break;
        offset = next;
        continue;
      }

      break;
    }

    return { playlist: playlistMeta, episodes: out };
  }

  async function loadPodcastColumn() {
    state.podcast.tried = true;
    state.podcast.error = null;
    state.podcast.playlist = null;
    state.podcast.items = [];

    const playlistId = PODCAST_PLAYLIST_ID;
    const limit = 200;

    try {
      const allEpisodes = [];
      const seen = new Set();

      let offset = 0;
      let safety = 0;
      let rawTotal = 0;
      let droppedTotal = 0;
      const droppedItems = [];
      const duplicateItems = [];
      const noIdItems = [];

      while (true) {
        safety++;
        if (safety > 25) break;

        const res = await fetch(API_PLAYLIST, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ playlistId, limit, offset })
        });

        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch {}

        if (!res.ok || !data) {
          const msg = (data && (data.message || data.error)) || text || `HTTP ${res.status}`;
          console.error("Podcast /api/playlist error payload:", { status: res.status, data, text });
          state.podcast.error = msg;
          return;
        }

        if (!state.podcast.playlist) state.podcast.playlist = data.playlist || null;

        rawTotal += Number(data.rawCount) || 0;
        droppedTotal += Number(data.droppedCount) || 0;
        if (Array.isArray(data.droppedItems)) droppedItems.push(...data.droppedItems);

        const items = Array.isArray(data.items) ? data.items : [];
        // Include tracks too — a few comedy skits are saved as songs in this
        // playlist but belong here alongside the episodes.
        const episodes = items.filter((x) => x?.type === "episode" || x?.type === "track");

        for (const ep of episodes) {
          const id = String(ep?.id || "").trim();
          if (!id) {
            noIdItems.push(ep);
            continue;
          }
          if (seen.has(id)) {
            duplicateItems.push(ep);
            continue;
          }
          seen.add(id);
          allEpisodes.push(ep);
        }

        const hasMore =
          (typeof data.hasMore === "boolean" ? data.hasMore : null) ??
          (typeof data.more === "boolean" ? data.more : null) ??
          false;

        const nextOffsetRaw =
          (Number.isFinite(Number(data.nextOffset)) ? Number(data.nextOffset) : null) ??
          (Number.isFinite(Number(data.nextPageOffset)) ? Number(data.nextPageOffset) : null) ??
          null;

        if (!hasMore) break;

        const nextOffset = (nextOffsetRaw !== null && nextOffsetRaw !== offset) ? nextOffsetRaw : (offset + limit);
        if (nextOffset === offset) break;

        offset = nextOffset;
      }

      state.podcast.items = allEpisodes;
      state.podcast.droppedItems = droppedItems;

      console.info("Podcast fetch tally:", {
        spotifyReportedTotal: state.podcast.playlist?.totalTracks ?? null,
        rawItemsSeenAcrossPages: rawTotal,
        droppedNullItems: droppedTotal, // Spotify returned these with no track/episode payload (removed/unavailable)
        duplicateIdItems: duplicateItems.length, // same track/episode id seen more than once across pages
        noIdItems: noIdItems.length, // had a type but no usable id (shouldn't normally happen)
        usableItemsKept: allEpisodes.length
      });
      if (droppedItems.length) {
        console.info(`Podcast items Spotify wouldn't serve data for (${droppedItems.length}):`);
        console.table(droppedItems);
      }
      if (duplicateItems.length) {
        console.info(`Podcast items dropped as duplicates (${duplicateItems.length}):`);
        console.table(duplicateItems.map((ep) => ({ id: ep.id, name: ep.name, type: ep.type, addedAt: ep.addedAt })));
      }
      if (noIdItems.length) {
        console.info(`Podcast items with no id (${noIdItems.length}):`);
        console.table(noIdItems);
      }
    } catch (e) {
      state.podcast.error = String(e?.message || e);
    }
  }

  function renderPodcastColumn() {
    const head = document.getElementById("podcastHead");
    const empty = document.getElementById("podcastEmpty");
    const errBox = document.getElementById("podcastError");
    const thumb = document.getElementById("podcastThumb");
    const title = document.getElementById("podcastTitle");
    const sub = document.getElementById("podcastSub");
    const list = document.getElementById("podcastList");
    if (!head || !empty || !errBox || !thumb || !title || !sub || !list) return;

    wirePodcastSearch();

    const tried = state.podcast.tried;
    const error = state.podcast.error;
    const p = state.podcast.playlist;
    let items = Array.isArray(state.podcast.items) ? state.podcast.items.slice() : [];
  
    if (!tried) {
      head.hidden = true;
      errBox.hidden = true;
      empty.style.display = "none";
      list.innerHTML = "";
      return;
    }
  
    empty.style.display = "none";
  
    if (error) {
      head.hidden = true;
      errBox.hidden = false;
      errBox.textContent = `Podcast playlist failed to load: ${error}`;
      list.innerHTML = "";
      return;
    }
  
    if (!p) {
      head.hidden = true;
      errBox.hidden = false;
      errBox.textContent = "Podcast playlist data missing.";
      list.innerHTML = "";
      return;
    }
  
    // Sorting by release date is meaningless for episodes with no real year on
    // record (see episodeReleaseSortKey) — hide them in that mode rather than
    // letting them sit lumped at the bottom of every release-date sort.
    if (state.podcast.sortBy === "released") {
      items = items.filter((ep) => episodeReleaseSortKey(ep) != null);
    }

    const searchQuery = document.getElementById("podcastSearchInput")?.value || "";
    if (searchQuery.trim()) {
      items = items.filter((ep) => podcastEpisodeMatchesSearch(ep, searchQuery));
    }

    items.sort(comparePodcastEpisodes);

    errBox.hidden = true;
    head.hidden = false;
  
    thumb.src = p.image || "https://spotify.jdge.cc/images/spotify_logo.png";
  
    // Title + count on the left
    title.textContent = "Podcast Episodes";
    const countText = `${items.length} items`;
    sub.innerHTML = `<div class="podcast-count" style="font-weight:600;">${escapeHtml(countText)}</div>`;

    renderPodcastSortControls();
  
    // Render list items
    list.innerHTML = items.length
      ? items.map(renderPodcastItem).join("")
      : (searchQuery.trim()
          ? `<li class="podcast-search-empty">No episodes match “${escapeHtml(searchQuery.trim())}”.</li>`
          : "");
    wirePodcastInteractions(list);
    wirePodcastThumbFallbacks(list);
  }

  function renderPodcastItem(it) {
    const episodeId = String(it?.id || "").trim();
    const epImg = it.image || "https://spotify.jdge.cc/images/spotify_logo.png";
    const name = escapeHtml(it.name || "Untitled");
    const channel = escapeHtml((it.artists || []).join(", "));
    const dur = fmtDurationFromMs(it.durationMs || 0);
    const url = it.url || "#";
  
    const isOpen = state.episodeNotes.openEpisodeId && episodeId && state.episodeNotes.openEpisodeId === episodeId;
    const hasNotes = episodeId ? episodeHasNotes(episodeId) : false;
    const noteOpacity = hasNotes ? 1 : 0.25;
  
    const entry = episodeId ? state.episodeNotes.cache?.[episodeId] : null;
    const saving = !!entry?.saving;
    const err = entry?.error || null;
    const savedAt = entry?.savedAt || null;
  
    const mode = isOpen ? state.episodeNotes.openMode : null;
  
    const showSavedBlock = !!episodeId && isOpen && mode === "append" && hasNotes;
  
    const savedBlock = showSavedBlock ? renderSavedNotesBlock(episodeId) : "";
    const editorHtml = isOpen && episodeId ? renderEpisodeNotesEditor(episodeId) : "";
  
    const statusLine = isOpen && episodeId
      ? `
        <div class="epnote-status" data-epnote-status="${escapeHtml(episodeId)}">
          ${saving ? "Saving…" : (err ? `Error: ${escapeHtml(err)}` : (savedAt ? "Saved ✓" : ""))}
        </div>
      `
      : "";
  
    const metaIconsHtml = renderPodcastMetaIcons(it);
    const badgeHtml = newBadgeHtml(episodeAddedMs(it));

    const uriType = it?.type === "track" ? "track" : "episode";
    const playId = episodeId ? `${uriType}:${episodeId}` : null;
    const spotifyUri = episodeId ? `spotify:${uriType}:${episodeId}` : null;
    const playControl = playControlHtml(playId, spotifyUri);

    return `
      <li class="podcast-item" data-episode-id="${escapeHtml(episodeId)}">
        <div class="podcast-link-grid">
          <a class="podcast-ep-left" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" aria-label="Open on Spotify">
            <img
              class="podcast-ep-thumb"
              src="${escapeHtml(epImg)}"
              alt=""
              decoding="async"
              loading="eager"
              referrerpolicy="no-referrer"
              data-epthumb="1"
              data-epthumb-src="${escapeHtml(epImg)}"
              srcset="${escapeHtml(epImg)} 1x"
            />
          </a>

          <div class="podcast-ep-meta">
            <div class="podcast-item-head">
              <a class="podcast-item-title" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${name}</a>
              ${badgeHtml}
            </div>

            <div class="podcast-item-sub">
              <span class="podcast-item-sub-text">${channel ? `${channel} • ` : ""}${escapeHtml(dur)}</span>
              <div class="podcast-item-actions">
                ${playControl.button}
                ${metaIconsHtml}
                <button
                  class="epnote-bubble"
                  type="button"
                  title="Notes"
                  aria-label="Notes"
                  data-epnote-toggle="${escapeHtml(episodeId)}"
                  style="opacity:${noteOpacity}"
                >💭</button>
              </div>
            </div>
          </div>
        </div>

        ${savedBlock}
        ${statusLine}
        ${editorHtml}
        ${playControl.progress}
      </li>
    `;
  }

  function wirePodcastThumbFallbacks(listEl) {
    const FALLBACK = "https://spotify.jdge.cc/images/spotify_logo.png";
    const imgs = listEl.querySelectorAll('img[data-epthumb="1"]');
    imgs.forEach((img) => {
      if (img.__fallbackBound) return;
      img.__fallbackBound = true;

      img.addEventListener("error", () => {
        if (img.src && img.src.includes("spotify_logo.png")) return;
        img.src = FALLBACK;
      }, { passive: true });
    });
  }

  /***********************
   * Notes editor UI
   ***********************/
  function renderEpisodeNotesEditor(episodeId) {
    const entry = getEpisodeCacheEntry(episodeId);
    const mode = state.episodeNotes.openMode || "append";

    const notes =
      (mode === "edit")
        ? (Array.isArray(entry?.draftNotes) && entry.draftNotes.length ? entry.draftNotes : [{ timestamp: "00:00:00", text: "" }])
        : (Array.isArray(entry?.draftNotes) && entry.draftNotes.length ? entry.draftNotes : [{ timestamp: "00:00:00", text: "" }]);

    const rowsHtml = notes.map((n, idx) => {
      const ts = escapeHtml(normalizeTimestamp(n?.timestamp));
      const tx = escapeHtml(String(n?.text || ""));
      return `
        <div class="epnote-row epnote-row-stacked" data-epnote-row="${idx}">
          <div class="epnote-row-top">
            <button class="epnote-add" type="button" title="Add row" aria-label="Add row" data-epnote-add="${escapeHtml(episodeId)}">👇🏻</button>

            <input
              class="epnote-time"
              type="text"
              inputmode="text"
              spellcheck="false"
              value="${ts}"
              placeholder="00:00:00"
              data-epnote-time="${escapeHtml(episodeId)}"
            />

            <button
              class="epnote-save"
              type="button"
              title="Save"
              aria-label="Save"
              data-epnote-save="${escapeHtml(episodeId)}"
            >✅</button>
          </div>

          <textarea
            class="epnote-text"
            rows="2"
            placeholder=""
            data-epnote-text="${escapeHtml(episodeId)}"
          >${tx}</textarea>
        </div>
      `;
    }).join("");

    return `
      <div class="epnote-editor" data-epnote-editor="${escapeHtml(episodeId)}">
        ${rowsHtml}
      </div>
    `;
  }

  function wirePodcastInteractions(listEl) {
    if (listEl.__epnoteBound) return;
    listEl.__epnoteBound = true;

    listEl.addEventListener("keydown", (e) => {
      const el = e.target;
      if (!el || !el.classList || !el.classList.contains("epnote-text")) return;

      if (e.key === "Enter" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();

        const start = typeof el.selectionStart === "number" ? el.selectionStart : (el.value || "").length;
        const end = typeof el.selectionEnd === "number" ? el.selectionEnd : (el.value || "").length;
        const v = String(el.value || "");
        el.value = v.slice(0, start) + "\n" + v.slice(end);

        const pos = start + 1;
        try {
          el.selectionStart = el.selectionEnd = pos;
        } catch {}

        el.style.height = "auto";
        el.style.height = `${Math.min(220, el.scrollHeight)}px`;
      }
    }, true);

    listEl.addEventListener("click", async (e) => {
      const t = e.target;

      // Mobile has no hover, so a tap toggles the same tooltip hover/focus already show.
      const tipEl = t?.closest?.(".pod-meta-emoji[data-tip]");
      if (tipEl) {
        e.preventDefault();
        e.stopPropagation();
        const wasOpen = tipEl.classList.contains("tip-open");
        document.querySelectorAll(".pod-meta-emoji.tip-open").forEach((el) => el.classList.remove("tip-open"));
        if (!wasOpen) tipEl.classList.add("tip-open");
        return;
      }

      const dateEditId = t?.getAttribute?.("data-epdate-edit");
      if (dateEditId) {
        e.preventDefault();
        const ep = (state.podcast.items || []).find((x) => String(x?.id || "") === dateEditId) || null;
        await handleEditAddedDateClick(dateEditId, ep);
        return;
      }

      const toggleId = t?.getAttribute?.("data-epnote-toggle");
      if (toggleId) {
        e.preventDefault();
        await toggleEpisodeEditor(toggleId);
        return;
      }
    
      const editId = t?.getAttribute?.("data-epnote-edit");
      if (editId) {
        e.preventDefault();
        await openEditorForExistingNotes(editId);
        return;
      }
    
      const addId = t?.getAttribute?.("data-epnote-add");
      if (addId) {
        e.preventDefault();
        addEpisodeRow(addId);
        return;
      }
    
      const saveId = t?.getAttribute?.("data-epnote-save");
      if (saveId) {
        e.preventDefault();
        await saveEpisodeFromDom(saveId);
        return;
      }
    });

    if (!document.__podTipCloseBound) {
      document.__podTipCloseBound = true;
      document.addEventListener("click", () => {
        document.querySelectorAll(".pod-meta-emoji.tip-open").forEach((el) => el.classList.remove("tip-open"));
      });
    }
  }

  function ensureSavedLoadedMaybe(episodeId) {
    const entry = getEpisodeCacheEntry(episodeId);
    if (!entry) return Promise.resolve();
    if (entry.loadedSaved) return Promise.resolve();
    return fetchEpisodeNotes(episodeId);
  }

  async function openEditorForExistingNotes(episodeId) {
    if (!episodeId) return;

    state.episodeNotes.openEpisodeId = episodeId;
    state.episodeNotes.openMode = "edit";

    const entry = getEpisodeCacheEntry(episodeId);
    renderPodcastColumn();

    try {
      entry.error = null;
      renderPodcastColumn();
      await ensureSavedLoadedMaybe(episodeId);

      entry.draftNotes = normalizeNotesArray(entry.savedNotes);
    } catch (err) {
      entry.error = String(err?.message || err);
    }

    renderPodcastColumn();

    requestAnimationFrame(() => {
      try {
        const li = document.querySelector(`.podcast-item[data-episode-id="${CSS.escape(episodeId)}"]`);
        const ta = li?.querySelector(`textarea[data-epnote-text="${CSS.escape(episodeId)}"]`);
        if (ta) ta.focus();
      } catch {}
    });
  }

  async function toggleEpisodeEditor(episodeId) {
    if (!episodeId) return;

    if (state.episodeNotes.openEpisodeId === episodeId) {
      state.episodeNotes.openEpisodeId = null;
      state.episodeNotes.openMode = null;
      renderPodcastColumn();
      return;
    }

    state.episodeNotes.openEpisodeId = episodeId;
    state.episodeNotes.openMode = "append";

    const entry = getEpisodeCacheEntry(episodeId);

    entry.draftNotes = [{ timestamp: "00:00:00", text: "" }];

    renderPodcastColumn();

    try {
      entry.error = null;
      renderPodcastColumn();
      await ensureSavedLoadedMaybe(episodeId);
    } catch (err) {
      entry.error = String(err?.message || err);
    }

    renderPodcastColumn();

    requestAnimationFrame(() => {
      try {
        const li = document.querySelector(`.podcast-item[data-episode-id="${CSS.escape(episodeId)}"]`);
        const ta = li?.querySelector(`textarea[data-epnote-text="${CSS.escape(episodeId)}"]`);
        if (ta) ta.focus();
      } catch {}
    });
  }

  function addEpisodeRow(episodeId) {
    if (!episodeId) return;
    const entry = getEpisodeCacheEntry(episodeId);
    if (!entry) return;

    if (!Array.isArray(entry.draftNotes)) entry.draftNotes = [];
    entry.draftNotes.push({ timestamp: "00:00:00", text: "" });

    state.episodeNotes.openEpisodeId = episodeId;
    if (!state.episodeNotes.openMode) state.episodeNotes.openMode = "append";

    renderPodcastColumn();

    requestAnimationFrame(() => {
      try {
        const li = document.querySelector(`.podcast-item[data-episode-id="${CSS.escape(episodeId)}"]`);
        const textareas = li?.querySelectorAll(`textarea[data-epnote-text="${CSS.escape(episodeId)}"]`) || [];
        const last = textareas.length ? textareas[textareas.length - 1] : null;
        if (last) last.focus();
      } catch {}
    });
  }

  function collectDraftNotesFromDom(episodeId) {
    const li = document.querySelector(`.podcast-item[data-episode-id="${CSS.escape(episodeId)}"]`);
    if (!li) return [{ timestamp: "00:00:00", text: "" }];

    const timeEls = Array.from(li.querySelectorAll(`input[data-epnote-time="${CSS.escape(episodeId)}"]`));
    const textEls = Array.from(li.querySelectorAll(`textarea[data-epnote-text="${CSS.escape(episodeId)}"]`));

    const rows = Math.max(timeEls.length, textEls.length);
    const out = [];
    for (let i = 0; i < rows; i++) {
      const ts = normalizeTimestamp(timeEls[i]?.value || "00:00:00");
      const tx = String(textEls[i]?.value || "").trim();
      out.push({ timestamp: ts, text: tx });
    }
    return normalizeNotesArray(out);
  }

  async function saveEpisodeFromDom(episodeId) {
    if (!episodeId) return;

    const entry = getEpisodeCacheEntry(episodeId);
    if (!entry) return;
    if (entry.saving) return;

    const mode = state.episodeNotes.openMode || "append";
    const draft = collectDraftNotesFromDom(episodeId);

    entry.draftNotes = draft;

    let finalNotes = [];

    if (mode === "edit") {
      finalNotes = normalizeNotesArray(draft);
    } else {
      const saved = normalizeNotesArray(entry.savedNotes);
      const draftMeaningful = meaningfulNotes(draft);
      finalNotes = normalizeNotesArray([...saved, ...draftMeaningful]);
    }

    let authToken = "";
    try {
      authToken = ensureNotesAuthOrThrow();
    } catch (err) {
      entry.error = String(err?.message || err);
      renderPodcastColumn();
      return;
    }

    try {
      await saveEpisodeNotes(episodeId, finalNotes, authToken);

      entry.draftNotes = [{ timestamp: "00:00:00", text: "" }];
      state.episodeNotes.openEpisodeId = null;
      state.episodeNotes.openMode = null;

      renderPodcastColumn();
    } catch (err) {
      console.error(err);
      renderPodcastColumn();
    }
  }

  /***********************
   * Modal
   ***********************/
  function openModal() {
    const backdrop = document.getElementById("modalBackdrop");
    if (!backdrop) return;
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
  }

  function closeModal() {
    const backdrop = document.getElementById("modalBackdrop");
    if (!backdrop) return;
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
  }

  function showPlaylistProgress() {
    const wrap = document.getElementById("playlistProgress");
    const bar = document.getElementById("playlistProgressBar");
    const label = document.getElementById("playlistProgressLabel");
    if (!wrap || !bar) return;
    if (label) label.hidden = false;
    wrap.classList.add("is-active");
    bar.style.transition = "none";
    bar.style.width = "0%";
  }

  // Driven by real page-completion counts (see fetchAllPlaylistItems), not a timer.
  function updatePlaylistProgress(completedPages, totalPages) {
    const bar = document.getElementById("playlistProgressBar");
    if (!bar || !totalPages) return;
    const pct = Math.min(100, Math.round((completedPages / totalPages) * 100));
    bar.style.transition = "width 0.25s ease-out";
    bar.style.width = `${pct}%`;
  }

  function hidePlaylistProgress() {
    const wrap = document.getElementById("playlistProgress");
    const bar = document.getElementById("playlistProgressBar");
    const label = document.getElementById("playlistProgressLabel");
    if (!wrap || !bar) return;
    bar.style.transition = "width 0.2s ease-out";
    bar.style.width = "100%";
    setTimeout(() => {
      wrap.classList.remove("is-active");
      bar.style.transition = "none";
      bar.style.width = "0%";
      if (label) label.hidden = true;
    }, 250);
  }

  async function fetchPlaylistItemsPage(playlistId, offset, limit) {
    const res = await fetch(API_PLAYLIST, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ playlistId, limit, offset })
    });

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}

    if (!res.ok || !data) {
      const msg = (data && (data.message || data.error)) || text || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }

  // /api/playlist caps a single response to 200 items by default, so a playlist
  // with more tracks than that needs multiple pages. The first page also tells us
  // the real totalTracks, so the remaining pages can be fetched in parallel instead
  // of following next-page links one at a time. onProgress(completedPages, totalPages)
  // fires after the first page and after each parallel page resolves, so callers can
  // drive a real (not simulated) progress bar.
  async function fetchAllPlaylistItems(playlistId, onProgress) {
    const pageSize = PLAYLIST_TRACKS_PAGE_LIMIT;

    const first = await fetchPlaylistItemsPage(playlistId, 0, pageSize);
    const playlist = first.playlist || {};
    const items = Array.isArray(first.items) ? first.items.slice() : [];

    const total = Math.min(
      typeof playlist.totalTracks === "number" ? playlist.totalTracks : items.length,
      PLAYLIST_TRACKS_MAX_ITEMS
    );

    const remainingOffsets = [];
    for (let offset = pageSize; offset < total; offset += pageSize) {
      remainingOffsets.push(offset);
    }

    const totalPages = 1 + remainingOffsets.length;
    let completedPages = 1;
    onProgress?.(completedPages, totalPages);

    if (remainingOffsets.length) {
      const pages = await Promise.allSettled(
        remainingOffsets.map((offset) =>
          fetchPlaylistItemsPage(playlistId, offset, pageSize).then((data) => {
            completedPages++;
            onProgress?.(completedPages, totalPages);
            return data;
          })
        )
      );
      for (const result of pages) {
        if (result.status === "fulfilled" && Array.isArray(result.value.items)) {
          items.push(...result.value.items);
        } else if (result.status === "rejected") {
          console.warn("Playlist page fetch failed for", playlistId, result.reason);
        }
      }
    }

    return { playlist, items: items.slice(0, PLAYLIST_TRACKS_MAX_ITEMS) };
  }

  async function openPlaylistModal(playlistId) {
    setStatus("Loading playlist…");
    openModal();

    const detailThumb = document.getElementById("detailThumb");
    const detailTitle = document.getElementById("detailTitle");
    const detailSub = document.getElementById("detailSub");
    const tracklist = document.getElementById("tracklist");
    if (!detailThumb || !detailTitle || !detailSub || !tracklist) return;

    detailThumb.src = "https://spotify.jdge.cc/images/spotify_logo.png";
    detailTitle.textContent = "Loading…";
    detailTitle.removeAttribute("href");
    detailSub.textContent = "";
    tracklist.innerHTML = "";

    showPlaylistProgress();
    try {
      const { playlist: p, items } = await fetchAllPlaylistItems(playlistId, updatePlaylistProgress);

      detailThumb.src = p.image || "https://spotify.jdge.cc/images/spotify_logo.png";
      detailTitle.textContent = p.name || "Untitled playlist";
      detailTitle.href = p.url || `https://open.spotify.com/playlist/${encodeURIComponent(playlistId)}`;

      const bits = [];
      if (typeof p.totalTracks === "number") bits.push(`${p.totalTracks} items`);
      if (p.ownerLabel) bits.push(p.ownerLabel);
      detailSub.textContent = bits.join(" • ");

      tracklist.innerHTML = sortItemsWithNewFirst(items).map(renderTrack).join("");
      setStatus("");
    } catch (err) {
      console.error(err);
      setStatus(`Playlist load failed: ${String(err.message || err)}`);
      tracklist.innerHTML = `<li class="track"><div class="track-main">
        <div class="track-name">Failed to load playlist</div>
        <div class="track-meta">${escapeHtml(String(err.message || err))}</div>
      </div></li>`;
    } finally {
      hidePlaylistProgress();
    }
  }

  /***********************
   * Real Spotify playback (Embed IFrame API)
   *
   * This plays the actual track/episode through Spotify's own embedded
   * player — a genuine play that counts on Spotify when the visitor is
   * logged in — rather than a local audio clip. `preview_url` is not an
   * option here: Spotify deprecated it for any API app created after
   * Nov 27 2024, so it's unavailable to this site regardless.
   *
   * One shared controller (#spotifyEmbedHost, outside #appMain so it
   * survives every refresh's full re-render) is reused across every play
   * button on the page via loadUri(), instead of creating a fresh iframe
   * per track. It surfaces in a centered popup (#spotifyPopupBackdrop)
   * whenever something is playing.
   ***********************/
  let spotifyEmbedController = null;
  let spotifyEmbedControllerPromise = null;
  let activePlayId = null;
  let activePlayIsPlaying = false;

  function playControlHtml(playId, spotifyUri) {
    if (!playId || !spotifyUri) return { button: "", progress: "" };
    return {
      button: `<button class="play-btn" type="button" data-play-id="${escapeHtml(playId)}" data-play-uri="${escapeHtml(spotifyUri)}" aria-label="Play on Spotify" title="Play on Spotify">▶</button>`,
      progress: `<div class="play-progress-track" data-play-progress="${escapeHtml(playId)}"><div class="play-progress-fill"></div></div>`
    };
  }

  function setPlayButtonVisual(playId, mode) {
    // mode: "idle" | "loading" | "playing"
    document.querySelectorAll(`.play-btn[data-play-id="${CSS.escape(playId)}"]`).forEach((btn) => {
      btn.classList.toggle("is-loading", mode === "loading");
      btn.classList.toggle("is-playing", mode === "playing");
      btn.textContent = mode === "playing" ? "⏸" : "▶";
    });
  }

  function setPlayProgressFraction(playId, fraction) {
    const pct = Math.max(0, Math.min(100, fraction * 100));
    document.querySelectorAll(`[data-play-progress="${CSS.escape(playId)}"] .play-progress-fill`).forEach((el) => {
      el.style.width = `${pct}%`;
    });
  }

  function resetActivePlayUI() {
    if (!activePlayId) return;
    setPlayButtonVisual(activePlayId, "idle");
    setPlayProgressFraction(activePlayId, 0);
  }

  function showSpotifyPopup() {
    const backdrop = document.getElementById("spotifyPopupBackdrop");
    if (backdrop) {
      backdrop.classList.add("is-active");
      backdrop.setAttribute("aria-hidden", "false");
    }
  }

  function hideSpotifyPopup() {
    const backdrop = document.getElementById("spotifyPopupBackdrop");
    if (backdrop) {
      backdrop.classList.remove("is-active");
      backdrop.setAttribute("aria-hidden", "true");
    }
  }

  function closeSpotifyPopup() {
    if (spotifyEmbedController) {
      try { spotifyEmbedController.pause(); } catch (err) { console.error("Spotify embed pause failed:", err); }
    }
    hideSpotifyPopup();
  }

  const spotifyPopupBackdrop = document.getElementById("spotifyPopupBackdrop");
  const spotifyPopupClose = document.getElementById("spotifyPopupClose");
  if (spotifyPopupClose) spotifyPopupClose.addEventListener("click", closeSpotifyPopup);
  if (spotifyPopupBackdrop) {
    spotifyPopupBackdrop.addEventListener("click", (e) => {
      if (e.target === spotifyPopupBackdrop) closeSpotifyPopup();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSpotifyPopup();
  });

  function handleEmbedPlaybackUpdate(data) {
    if (!activePlayId || !data) return;
    const { position, duration, isPaused, isBuffering } = data;

    activePlayIsPlaying = !isPaused;
    setPlayButtonVisual(activePlayId, isBuffering ? "loading" : (isPaused ? "idle" : "playing"));

    if (typeof duration === "number" && duration > 0) {
      setPlayProgressFraction(activePlayId, (Number(position) || 0) / duration);
    }

    // Track finished: snap the bar back to empty instead of leaving it stuck full.
    if (isPaused && typeof position === "number" && typeof duration === "number" && duration > 0 && position >= duration - 250) {
      setPlayProgressFraction(activePlayId, 0);
    }
  }

  async function getSpotifyEmbedController(initialUri) {
    if (spotifyEmbedController) return spotifyEmbedController;
    if (spotifyEmbedControllerPromise) return spotifyEmbedControllerPromise;

    spotifyEmbedControllerPromise = (async () => {
      if (!window.__spotifyIframeApiPromise) throw new Error("Spotify embed script not loaded");
      const IFrameAPI = await window.__spotifyIframeApiPromise;
      const host = document.getElementById("spotifyEmbedHost");
      if (!host) throw new Error("Missing #spotifyEmbedHost");

      return new Promise((resolve, reject) => {
        try {
          IFrameAPI.createController(host, { uri: initialUri, width: "100%", height: "152" }, (controller) => {
            spotifyEmbedController = controller;
            controller.addListener("playback_update", (e) => handleEmbedPlaybackUpdate(e?.data));
            resolve(controller);
          });
        } catch (err) {
          reject(err);
        }
      });
    })();

    return spotifyEmbedControllerPromise;
  }

  async function togglePlay(playId, spotifyUri) {
    if (!playId || !spotifyUri) return;

    // Same row clicked again: just toggle pause/resume.
    if (activePlayId === playId && spotifyEmbedController) {
      if (activePlayIsPlaying) {
        spotifyEmbedController.pause();
      } else {
        spotifyEmbedController.resume();
        showSpotifyPopup();
      }
      return;
    }

    resetActivePlayUI();
    activePlayId = playId;
    activePlayIsPlaying = false;
    setPlayButtonVisual(playId, "loading");
    showSpotifyPopup();

    try {
      if (!spotifyEmbedController) {
        await getSpotifyEmbedController(spotifyUri);
        spotifyEmbedController.play();
      } else {
        spotifyEmbedController.loadUri(spotifyUri);
        spotifyEmbedController.play();
      }
    } catch (err) {
      console.error("Spotify embed playback failed:", err);
      setPlayButtonVisual(playId, "idle");
      hideSpotifyPopup();
      if (activePlayId === playId) activePlayId = null;
    }
  }

  document.addEventListener("click", (e) => {
    const btn = e.target?.closest?.(".play-btn");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const playId = btn.getAttribute("data-play-id");
    const spotifyUri = btn.getAttribute("data-play-uri");
    togglePlay(playId, spotifyUri);
  });

  // Tracks still tagged "New" (added within NEW_BADGE_DAYS) float to the top,
  // newest first; everything else keeps the playlist's normal order.
  function sortItemsWithNewFirst(items) {
    const withMeta = items.map((it, idx) => ({ it, idx, ms: parseSortDate(it.addedAt) }));
    const isNew = (m) => m.ms != null && isNewSince(m.ms);
    const newer = withMeta.filter(isNew).sort((a, b) => (b.ms - a.ms) || (a.idx - b.idx));
    const rest = withMeta.filter((m) => !isNew(m));
    return [...newer, ...rest].map((m) => m.it);
  }

  function renderTrack(t) {
    const name = escapeHtml(t.name || "Untitled");
    const artists = escapeHtml((t.artists || []).join(", "));
    const url = t.url || "#";
    const ms = Number(t.durationMs) || 0;
    const mins = ms ? `${Math.round(ms / 60000)}m` : "";
    const badgeHtml = newBadgeHtml(parseSortDate(t.addedAt));

    const trackId = t.id ? String(t.id) : null;
    const playId = trackId ? `track:${trackId}` : null;
    const spotifyUri = trackId ? `spotify:track:${trackId}` : null;
    const playControl = playControlHtml(playId, spotifyUri);

    return `
      <li class="track">
        <div class="track-main">
          <div class="track-name-row">
            <a class="track-name" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${name}</a>
            ${badgeHtml}
          </div>
          <div class="track-meta">${artists}</div>
        </div>
        <div class="track-right">
          ${playControl.button}
          ${escapeHtml(mins)}
        </div>
        ${playControl.progress}
      </li>
    `;
  }

  /***********************
   * Refresh
   ***********************/
  async function refreshFromSpotify() {
    stopSongHoursWorker();

    buildShell();
    setButtonLoading(true);
    setStatus("Refreshing from Spotify…");

    try {
      const res = await fetch(API_REFRESH, { method: "POST", headers: { Accept: "application/json" } });

      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch {}

      if (!res.ok) {
        const msg = (data && (data.message || data.error)) || text || `HTTP ${res.status}`;
        console.error("Refresh API error payload:", { status: res.status, data, text });
        throw new Error(msg);
      }

      state.snapshot = data;
      state.filter = "all";

      state.others = Array.isArray(data?.othersPlaylists)
        ? data.othersPlaylists.map((p) => ({ ...p, ownerLabel: p.ownerLabel || "by others" }))
        : [];

      state.episodeNotes.openEpisodeId = null;
      state.episodeNotes.openMode = null;
      state.episodeNotes.episodesWithNotes = new Set();

      // Run non-critical fetches in parallel but guarded so they can't hang forever
      const tasks = [
        (async () => { try { await loadOthersFallback(); } catch(e){ console.warn('loadOthers failed', e); } })(),
        (async () => { try { await loadPodcastColumn(); } catch(e){ console.warn('loadPodcastColumn failed', e); state.podcast.error = state.podcast.error || String(e?.message || e); } })(),
        (async () => { try { await loadEpisodeNotesSummary(); } catch(e){ console.warn('loadEpisodeNotesSummary failed', e); } })(),
        (async () => { try { await loadAllEpisodeNotesText(); } catch(e){ console.warn('loadAllEpisodeNotesText failed', e); } })(),
        (async () => { try { await loadEpisodeDateOverrides(); } catch(e){ console.warn('loadEpisodeDateOverrides failed', e); } })()
      ];

      await Promise.allSettled(tasks);
      applyPodcastDateOverrides();

      // compute approximate song-hours immediately (no Worker)
      startSongHoursComputeClientSide();

      renderStatistics();
      renderFilterPills();
      renderPlaylists();
      renderOthers();
      renderPodcastColumn();

      // fire-and-forget: pops "New" badges onto playlist cards as each one is checked
      checkPlaylistsForNewTracksInBackground();

      setStatus("");
    } catch (err) {
      console.error(err);
      setStatus(`Refresh failed: ${String(err?.message || err)}`);
    } finally {
      setButtonLoading(false);
    }
  }

  /***********************
   * Boot
   ***********************/
  document.addEventListener("DOMContentLoaded", () => {
    blankUntilClick();
    if (refreshButton) refreshButton.addEventListener("click", refreshFromSpotify);
  });
})();
