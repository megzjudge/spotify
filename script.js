// script.js

(() => {
  /***********************
   * CONFIG
   ***********************/
  const API_REFRESH = "/api/refresh";
  const API_PLAYLIST = "/api/playlist";
  const API_EPISODE_NOTE = "/api/episode-note";

  // ✅ song-hours endpoint
  const API_SONG_HOURS = "/api/song-hours";

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

  // We still fetch plenty; CSS limits the visible height.
  const PODCAST_COLUMN_LIMIT = 200;

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
    podcast: { tried: false, error: null, playlist: null, items: [] },

    // ✅ song-hours polling
    songHours: {
      pollTimer: null,
      tries: 0
    },

    // Episode notes
    episodeNotes: {
      // episodeId -> {
      //   savedNotes:[{timestamp,text}],
      //   draftNotes:[{timestamp,text}],
      //   loadedSaved:boolean,
      //   saving:boolean,
      //   savedAt:number|null,
      //   error:string|null
      // }
      cache: Object.create(null),

      openEpisodeId: null,

      // ✅ "append" when opening via 💭 bubble (keep saved notes outside; draft empty)
      // ✅ "edit"   when opening via 📝 (populate editor with saved notes)
      openMode: null,

      // episodeIds known to have notes (from summary endpoint)
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
    // Accept "SS", "MM:SS", "HH:MM:SS". Always return "HH:MM:SS".
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

    // keep at least one row if empty
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
            <h2 class="panel-title">Podcast Episodes</h2>
          </div>
          <div class="panel-body col-scroll-body">

            <div class="podcast-head" id="podcastHead" hidden>
              <img class="podcast-thumb" id="podcastThumb" alt="">
              <div style="min-width:0">
                <div class="podcast-title" id="podcastTitle"></div>
                <div class="podcast-sub" id="podcastSub"></div>
              </div>
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
    const getList = (k) => Array.isArray(sections?.[k]) ? sections[k] : [];

    const core = [
      ...getList("dailyMix"),
      ...getList("top"),
      ...getList("other")
    ];

    const sumTracks = (arr) =>
      arr.reduce((acc, p) => acc + (Number(p?.totalTracks) || 0), 0);

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
      const hint = status === "computing" ? " (computing…)" : "";
      return { label: approxLabel, hint };
    }

    return { label: "–", hint: "" };
  }

  function renderStatistics() {
    const grid = document.getElementById("statsGrid");
    if (!grid) return;

    const totals = state.snapshot?.totals || {};
    const playlists = totals.playlists ?? "–";

    const computedSongs = computeSongCountFromSnapshot({
      includeOthers: false,
      includeYearSummary: false
    });
    const songs = computedSongs > 0 ? computedSongs : (totals.songs ?? "–");

    const songHours = getSongHoursDisplay(totals);

    const pod = computePodcastStatsFromState();
    const podEps = pod.episodes > 0 ? pod.episodes : (totals.podcastEpisodes ?? "–");
    const podHours = pod.episodes > 0 ? fmtHoursFromMs(pod.ms) :
      (typeof totals.podcastMs === "number" ? fmtHoursFromMs(totals.podcastMs) : "–");

    grid.innerHTML = `
      <div class="stat-card span-2">
        <div class="stat-kicker">Total playlists</div>
        <div class="stat-big">${escapeHtml(String(playlists))}</div>
      </div>

      <div class="stat-card">
        <div class="stat-kicker">Total songs</div>
        <div class="stat-big">${escapeHtml(String(songs))}</div>
      </div>

      <div class="stat-big">
        ${escapeHtml(String(songHours.label))}
        ${songHours.hint ? `<span class="stat-computing">${escapeHtml(songHours.hint)}</span>` : ""}
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
   * Song-hours: start compute + poll for exact
   ***********************/
  function stopSongHoursPolling() {
    if (state.songHours.pollTimer) {
      clearInterval(state.songHours.pollTimer);
      state.songHours.pollTimer = null;
    }
    state.songHours.tries = 0;
  }

  async function kickSongHoursCompute(totalSongs, approxMs) {
    try {
      await fetch(API_SONG_HOURS, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          totalSongs: Number(totalSongs) || 0,
          approxMs: Number(approxMs) || 0,
          avgMinutesPerSong: 3
        })
      });
    } catch {
      // ignore
    }
  }

  function startSongHoursPolling() {
    stopSongHoursPolling();

    const totals = state.snapshot?.totals || {};
    if (typeof totals.songMsExact === "number") return;

    if (typeof totals.songMsApprox === "number") {
      totals.songHoursStatus = "computing";
      renderStatistics();
    }

    state.songHours.pollTimer = setInterval(async () => {
      state.songHours.tries++;
      if (state.songHours.tries > 45) { // ~90s @ 2s interval
        stopSongHoursPolling();
        return;
      }

      try {
        const res = await fetch(API_SONG_HOURS, { method: "GET", headers: { Accept: "application/json" } });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch {}

        if (!res.ok || !data) return;

        const exactMs =
          (typeof data.exactMs === "number") ? data.exactMs :
          (typeof data.ms === "number") ? data.ms :
          null;

        if (typeof exactMs === "number") {
          state.snapshot.totals.songMsExact = exactMs;
          state.snapshot.totals.songMsExactUpdatedAt = data.updatedAt ?? null;
          state.snapshot.totals.songHoursStatus = "exact";
          state.snapshot.totals.songMs = exactMs; // backward compat
          renderStatistics();
          stopSongHoursPolling();
          return;
        }

        if (data.running === true || data.running === "1") {
          if (state.snapshot?.totals) state.snapshot.totals.songHoursStatus = "computing";
        }
      } catch {
        // ignore
      }
    }, 2000);
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

    // Backward-compat if older cached shape exists
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

    // sync summary set
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

    // fast-path: known from summary API
    if (state.episodeNotes.episodesWithNotes?.has(String(episodeId))) return true;

    // fallback: if cached, inspect savedNotes
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

    const lines = notes.slice(0, 6).map((n) => {
      const ts = escapeHtml(n.timestamp);
      const tx = escapeHtml(n.text);
      return `
        <div class="epnote-saved-line">
          <div class="epnote-saved-ts">${ts}</div>
          <div class="epnote-saved-text">${tx}</div>
        </div>
      `;
    }).join("");

    const more = notes.length > 6 ? `<div class="epnote-saved-more">…and ${notes.length - 6} more</div>` : "";

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
        ${more}
      </div>
    `;
  }

  /***********************
   * Podcast panel
   ***********************/
  async function loadPodcastColumn() {
    state.podcast.tried = true;
    state.podcast.error = null;
    state.podcast.playlist = null;
    state.podcast.items = [];

    try {
      const res = await fetch(API_PLAYLIST, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ playlistId: PODCAST_PLAYLIST_ID, limit: PODCAST_COLUMN_LIMIT })
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

      state.podcast.playlist = data.playlist || null;

      let items = Array.isArray(data.items) ? data.items : [];

      items = items.filter((x) => (x?.type || "") === "episode");

      const anyAddedAt = items.some((x) => !!x?.addedAt);
      if (anyAddedAt) {
        items.sort((a, b) => {
          const ta = a?.addedAt ? Date.parse(a.addedAt) : 0;
          const tb = b?.addedAt ? Date.parse(b.addedAt) : 0;
          return tb - ta;
        });
      } else {
        items.reverse();
      }

      state.podcast.items = items;
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
    const items = state.podcast.items || [];

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

    errBox.hidden = true;
    head.hidden = false;

    thumb.src = p.image || "https://spotify.jdge.cc/images/spotify_logo.png";
    title.textContent = p.name || "Podcast Episodes";
    sub.textContent = `${items.length} items`;

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

    // ✅ IMPORTANT FIX:
    // - When opened via 💭 (append), keep Saved notes visible OUTSIDE the editor, and editor is blank.
    // - When opened via 📝 (edit), editor is prefilled; (optional) hide the printed block to reduce duplication.
    const showSavedBlock =
      (!!episodeId && hasNotes && (!isOpen || mode === "append"));

    const savedBlock = showSavedBlock ? renderSavedNotesBlock(episodeId) : "";

    const editorHtml = isOpen && episodeId ? renderEpisodeNotesEditor(episodeId) : "";

    const statusLine = isOpen && episodeId
      ? `
        <div class="epnote-status" data-epnote-status="${escapeHtml(episodeId)}">
          ${saving ? "Saving…" : (err ? `Error: ${escapeHtml(err)}` : (savedAt ? "Saved ✓" : ""))}
        </div>
      `
      : "";

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
            <div class="podcast-item-title">${name}</div>
            <div class="podcast-item-sub">${channel ? channel + " • " : ""}${escapeHtml(dur)}</div>
          </div>

          <button
            class="epnote-bubble"
            type="button"
            title="Notes"
            aria-label="Notes"
            data-epnote-toggle="${escapeHtml(episodeId)}"
            style="opacity:${noteOpacity}"
          >💭</button>
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

    // In "append" mode: show blank draft rows (do NOT mirror saved notes into textarea)
    // In "edit" mode: draftNotes is populated with saved notes before render
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

    listEl.addEventListener("click", async (e) => {
      const t = e.target;

      const toggleId = t?.getAttribute?.("data-epnote-toggle");
      if (toggleId) {
        e.preventDefault();
        await toggleEpisodeEditor(toggleId); // 💭 opens APPEND mode
        return;
      }

      const editId = t?.getAttribute?.("data-epnote-edit");
      if (editId) {
        e.preventDefault();
        await openEditorForExistingNotes(editId); // 📝 opens EDIT mode
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

    listEl.addEventListener("input", (e) => {
      const ta = e.target;
      if (ta && ta.classList && ta.classList.contains("epnote-text")) {
        ta.style.height = "auto";
        ta.style.height = `${Math.min(220, ta.scrollHeight)}px`;
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

      // ✅ populate editor with saved notes for editing
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

    // close if same
    if (state.episodeNotes.openEpisodeId === episodeId) {
      state.episodeNotes.openEpisodeId = null;
      state.episodeNotes.openMode = null;
      renderPodcastColumn();
      return;
    }

    state.episodeNotes.openEpisodeId = episodeId;
    state.episodeNotes.openMode = "append";

    const entry = getEpisodeCacheEntry(episodeId);

    // ✅ append mode draft is always blank by default
    entry.draftNotes = [{ timestamp: "00:00:00", text: "" }];

    renderPodcastColumn();

    // ✅ load saved notes (so the printed block shows the real saved text),
    // but DO NOT put them into the textbox.
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

    // Update cache draft
    entry.draftNotes = draft;

    let finalNotes = [];

    if (mode === "edit") {
      // overwrite with draft
      finalNotes = normalizeNotesArray(draft);
    } else {
      // append: savedNotes + draftNotes (only meaningful draft lines)
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

      // ✅ after save: close editor and reset draft
      entry.draftNotes = [{ timestamp: "00:00:00", text: "" }];
      state.episodeNotes.openEpisodeId = null;
      state.episodeNotes.openMode = null;

      renderPodcastColumn();
    } catch (err) {
      console.error(err);
      // keep open on error
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
    stopSongHoursPolling();

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
        ? data.othersPlaylists.map(p => ({ ...p, ownerLabel: p.ownerLabel || "by others" }))
        : [];

      state.yearSummary = Array.isArray(data?.yearSummaryPlaylists)
        ? data.yearSummaryPlaylists.map(p => ({ ...p, ownerLabel: p.ownerLabel || "Spotify" }))
        : [];

      state.episodeNotes.openEpisodeId = null;
      state.episodeNotes.openMode = null;
      state.episodeNotes.episodesWithNotes = new Set();

      await Promise.all([
        loadOthersAndYearSummaryFallback(),
        loadPodcastColumn(),
        loadEpisodeNotesSummary()
      ]);

      renderStatistics();
      renderFilterPills();
      renderPlaylists();
      renderOthers();
      renderYearSummary();
      renderPodcastColumn();

      // background song-hours compute
      const totals = state.snapshot?.totals || {};
      const totalSongs = Number(totals?.songs) || 0;
      const approxMs = Number(totals?.songMsApprox) || 0;

      if (totalSongs > 0 && typeof totals.songMsExact !== "number") {
        kickSongHoursCompute(totalSongs, approxMs);
        startSongHoursPolling();
      }

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
