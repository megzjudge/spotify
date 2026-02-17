// script.js

(() => {
  /***********************
   * CONFIG
   ***********************/
  const API_REFRESH = "/api/refresh";
  const API_PLAYLIST = "/api/playlist";
  const API_EPISODE_NOTE = "/api/episode-note";

  // ✅ IMPORTANT:
  // /api/song-hours does NOT exist as a Pages Function right now (GET falls back to HTML, POST is 405).
  // We used to compute exact song-hours client-side via a Worker; that caused failures (Worker fetch URL parsing).
  // Now we will compute an approximate song-hours value locally from the song count.

  const PODCAST_PLAYLIST_ID = "2tHrihmpYzDbJ8rit7HtFR";

  const OTHERS_PLAYLIST_IDS = [
    "71z6BdHlnfNj4DKRhuu1Fk",
    "7jYNznHoIYgJBzwT5jpoOe",
    "41PZG18MrSTagagiIaiG4X",
    "37i9dQZF1DX5mB2C8gBeUM",
    "37i9dQZF1EQnsJ0xmvpihE"
  ];

  // IMPORTANT: this only affects the fallback per-ID fetch in the browser.
  // Your /api/refresh is the primary source of truth for Year Summary.
  const YEAR_SUMMARY_PLAYLIST_IDS = [];

  // ✅ Podcast paging config
  const PODCAST_PAGE_LIMIT = 200;

  // ✅ Safety cap so we never go crazy if an API bug loops pages.
  const PODCAST_MAX_ITEMS = 5000;

  // ✅ Notes auth (client-side) — stored per-session only.
  const SS_NOTES_AUTH_KEY = "spotify_notes_auth";

  /***********************
   * DOM
   ***********************/
  const refreshButton = document.getElementById("refreshButton");
  const appMain = document.getElementById("appMain");

  /***********************
   * STATE
   ***********************/
  const state = {
    snapshot: null,
    filter: "all",
    others: [],
    yearSummary: [],
    podcast: {
      tried: false,
      error: null,
      playlist: null,
      items: [],
      // sorting for podcast panel
      sortBy: "released", // "released" | "added"
      sortDir: "desc" // "asc" | "desc"
    },

    // song-hours: we keep small state but we no longer spawn a Worker
    songHours: {
      running: false,
      lastError: null
    },

    // Episode notes
    episodeNotes: {
      cache: Object.create(null),
      openEpisodeId: null,
      openMode: null,
      episodesWithNotes: new Set()
    }
  };

  /***********************
   * UI Helpers
   ***********************/
  function setButtonLoading(isLoading) {
    if (!refreshButton) return;
    refreshButton.disabled = isLoading;
    refreshButton.classList.toggle("is-loading", isLoading);
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

          <section class="panel" style="margin-top:16px;">
            <div class="panel-header">
              <h2 class="panel-title">Year Summary Playlist</h2>
            </div>
            <div class="panel-body">
              <div class="cards cards-compact" id="yearSummaryCards"></div>
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
              <h3 class="detail-title" id="detailTitle"></h3>
              <p class="detail-sub" id="detailSub"></p>
            </div>
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
    return `
      <div class="card" data-playlist-id="${escapeHtml(p.id)}">
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
  function computeSongCountFromSnapshot({ includeOthers = false, includeYearSummary = false } = {}) {
    const sections = state.snapshot?.sections || {};
    const getList = (k) => (Array.isArray(sections?.[k]) ? sections[k] : []);
    const core = [...getList("dailyMix"), ...getList("top"), ...getList("other")];
    const sumTracks = (arr) => arr.reduce((acc, p) => acc + (Number(p?.totalTracks) || 0), 0);
    let sum = sumTracks(core);
    if (includeOthers) sum += sumTracks(state.others || []);
    if (includeYearSummary) sum += sumTracks(state.yearSummary || []);
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

    const computedSongs = computeSongCountFromSnapshot({ includeOthers: false, includeYearSummary: false });
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

  function togglePodcastSort(by) {
    if (!by) return;
    const cur = state.podcast.sortBy;
    if (cur === by) {
      // toggle direction
      state.podcast.sortDir = state.podcast.sortDir === "desc" ? "asc" : "desc";
    } else {
      state.podcast.sortBy = by;
      state.podcast.sortDir = "desc";
    }
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
   * Manual panels (Others + Year Summary)
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

  async function loadOthersAndYearSummaryFallback() {
    if (!state.others.length) {
      const others = [];
      for (const id of OTHERS_PLAYLIST_IDS) {
        const meta = await fetchPlaylistMeta(id, "by others");
        if (meta) others.push(meta);
      }
      state.others = others;
    }

    if (!state.yearSummary.length) {
      const years = [];
      for (const id of YEAR_SUMMARY_PLAYLIST_IDS) {
        const meta = await fetchPlaylistMeta(id, "Spotify");
        if (meta) years.push(meta);
      }
      state.yearSummary = years;
    }
  }

  function renderOthers() {
    const el = document.getElementById("othersCards");
    if (!el) return;

    el.innerHTML = state.others.length
      ? state.others.map(cardHtml).join("")
      : `<div class="muted-small">No “others” playlists added.</div>`;

    wireCardClicks(el);
  }

  function renderYearSummary() {
    const el = document.getElementById("yearSummaryCards");
    if (!el) return;

    el.innerHTML = state.yearSummary.length
      ? state.yearSummary.map(cardHtml).join("")
      : `<div class="muted-small">No year summary playlist added yet.</div>`;

    wireCardClicks(el);
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
      const eps = items.filter((x) => (x?.type || "") === "episode");

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

        const items = Array.isArray(data.items) ? data.items : [];
        const episodes = items.filter((x) => (x?.type || "") === "episode");

        for (const ep of episodes) {
          const id = String(ep?.id || "").trim();
          if (!id) continue;
          if (seen.has(id)) continue;
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

      const anyAddedAt = allEpisodes.some((x) => !!x?.addedAt);
      if (anyAddedAt) {
        allEpisodes.sort((a, b) => {
          const ta = a?.addedAt ? Date.parse(a.addedAt) : 0;
          const tb = b?.addedAt ? Date.parse(b.addedAt) : 0;
          return tb - ta;
        });
      } else {
        allEpisodes.reverse();
      }

      state.podcast.items = allEpisodes;
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
  
    // Sort client-side according to state.podcast.sortBy / sortDir
    const sortBy = state.podcast.sortBy || "released";
    const sortDir = state.podcast.sortDir === "asc" ? 1 : -1;
    items.sort((a, b) => {
      try {
        if (sortBy === "added") {
          const ta = a?.addedAt ? Date.parse(a.addedAt) : 0;
          const tb = b?.addedAt ? Date.parse(b.addedAt) : 0;
          return (ta === tb) ? 0 : (ta < tb ? -1 * sortDir : 1 * sortDir);
        } else {
          const ra = a?.release_date ? Date.parse(a.release_date) : (a?.addedAt ? Date.parse(a.addedAt) : 0);
          const rb = b?.release_date ? Date.parse(b.release_date) : (b?.addedAt ? Date.parse(b.addedAt) : 0);
          return (ra === rb) ? 0 : (ra < rb ? -1 * sortDir : 1 * sortDir);
        }
      } catch (e) {
        return 0;
      }
    });
  
    errBox.hidden = true;
    head.hidden = false;
  
    thumb.src = p.image || "https://spotify.jdge.cc/images/spotify_logo.png";
  
    // Title + count on the left
    title.textContent = "Podcast Episodes";
    const countText = `${items.length} items`;
    sub.innerHTML = `<div class="podcast-count" style="font-weight:600;">${escapeHtml(countText)}</div>`;

    // Controls (kept on the right column) — we render buttons here so the header layout is tidy.
    const controlsEl = document.getElementById("podcastHeadControls");
    if (controlsEl) {
      // two small buttons: released (leaf) and added (target)
      const releasedArrow = state.podcast.sortBy === "released" ? (state.podcast.sortDir === "desc" ? "▼" : "▲") : "▲▼";
      const addedArrow = state.podcast.sortBy === "added" ? (state.podcast.sortDir === "desc" ? "▼" : "▲") : "▲▼";

      controlsEl.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;">
          <button class="pod-sort-btn" data-sort="released" title="Sort by released" aria-label="Sort by released">🍃 ${releasedArrow}</button>
          <button class="pod-sort-btn" data-sort="added" title="Sort by added" aria-label="Sort by added">🎯 ${addedArrow}</button>
        </div>
      `;

      // wire clicks on the controls (keeps sorting logic in togglePodcastSort)
      controlsEl.querySelectorAll("button[data-sort]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          const by = btn.getAttribute("data-sort");
          if (!by) return;
          togglePodcastSort(by);
          renderPodcastColumn();
        });
      });
    }
  
    // Render list items
    list.innerHTML = items.map(renderPodcastItem).join("");
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
  
    // Emojis go on the subtitle row next to the timestamp/duration
    const emojisHtml = `<span class="pod-inline-icons" aria-hidden="true" style="margin-left:8px;">🍃 🎯</span>`;
  
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
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
              <div class="podcast-item-title" style="flex:1;min-width:0;text-align:left;">${name}</div>
              <!-- keep notes bubble on the right -->
              <div style="margin-left:12px;">
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
  
            <!-- subtitle row: channel, duration, emojis -->
            <div class="podcast-item-sub" style="text-align:left;display:flex;align-items:center;gap:8px;">
              <div style="white-space:nowrap;">${channel ? channel + " • " : ""}${escapeHtml(dur)}</div>
              <div>${emojisHtml}</div>
            </div>
          </div>
        </div>
  
        ${savedBlock}
        ${statusLine}
        ${editorHtml}
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
    
      const sortBy = t?.getAttribute?.("data-sort");
      if (sortBy) {
        e.preventDefault();
        togglePodcastSort(sortBy);
        renderPodcastColumn();
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
    detailSub.textContent = "";
    tracklist.innerHTML = "";

    try {
      const res = await fetch(API_PLAYLIST, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ playlistId })
      });

      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch {}

      if (!res.ok) {
        const msg = (data && (data.message || data.error)) || text || `HTTP ${res.status}`;
        console.error("Playlist modal /api/playlist error payload:", { status: res.status, data, text });
        throw new Error(msg);
      }

      const p = data.playlist || {};
      const items = Array.isArray(data.items) ? data.items : [];

      detailThumb.src = p.image || "https://spotify.jdge.cc/images/spotify_logo.png";
      detailTitle.textContent = p.name || "Untitled playlist";

      const bits = [];
      if (typeof p.totalTracks === "number") bits.push(`${p.totalTracks} items`);
      if (p.ownerLabel) bits.push(p.ownerLabel);
      detailSub.textContent = bits.join(" • ");

      tracklist.innerHTML = items.map(renderTrack).join("");
      setStatus("");
    } catch (err) {
      console.error(err);
      setStatus(`Playlist load failed: ${String(err.message || err)}`);
      tracklist.innerHTML = `<li class="track"><div class="track-main">
        <div class="track-name">Failed to load playlist</div>
        <div class="track-meta">${escapeHtml(String(err.message || err))}</div>
      </div></li>`;
    }
  }

  function renderTrack(t) {
    const name = escapeHtml(t.name || "Untitled");
    const artists = escapeHtml((t.artists || []).join(", "));
    const url = t.url || "#";
    const ms = Number(t.durationMs) || 0;
    const mins = ms ? `${Math.round(ms / 60000)}m` : "";
    return `
      <li class="track">
        <div class="track-main">
          <a class="track-name" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${name}</a>
          <div class="track-meta">${artists}</div>
        </div>
        <div class="track-right">${escapeHtml(mins)}</div>
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

      state.yearSummary = Array.isArray(data?.yearSummaryPlaylists)
        ? data.yearSummaryPlaylists.map((p) => ({ ...p, ownerLabel: p.ownerLabel || "Spotify" }))
        : [];

      state.episodeNotes.openEpisodeId = null;
      state.episodeNotes.openMode = null;
      state.episodeNotes.episodesWithNotes = new Set();

      // Run non-critical fetches in parallel but guarded so they can't hang forever
      const tasks = [
        (async () => { try { await loadOthersAndYearSummaryFallback(); } catch(e){ console.warn('loadOthers failed', e); } })(),
        (async () => { try { await loadPodcastColumn(); } catch(e){ console.warn('loadPodcastColumn failed', e); state.podcast.error = state.podcast.error || String(e?.message || e); } })(),
        (async () => { try { await loadEpisodeNotesSummary(); } catch(e){ console.warn('loadEpisodeNotesSummary failed', e); } })()
      ];

      await Promise.allSettled(tasks);

      // compute approximate song-hours immediately (no Worker)
      startSongHoursComputeClientSide();

      renderStatistics();
      renderFilterPills();
      renderPlaylists();
      renderOthers();
      renderYearSummary();
      renderPodcastColumn();

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
