(() => {
  /***********************
   * CONFIG
   ***********************/
  const API_REFRESH = "/api/refresh";
  const API_PLAYLIST = "/api/playlist";

  // Your podcast playlist (private is fine — pulled via your server token)
  const PODCAST_PLAYLIST_ID = "2tHrihmpYzDbJ8rit7HtFR";

  // Manually curated playlists NOT owned by you (you choose these)
  const OTHERS_PLAYLIST_IDS = [
    "71z6BdHlnfNj4DKRhuu1Fk",
    "7jYNznHoIYgJBzwT5jpoOe",
    "41PZG18MrSTagagiIaiG4X",
    "37i9dQZF1DX5mB2C8gBeUM",
    "37i9dQZF1EQnsJ0xmvpihE"
  ];

  // Year summary playlists (one per year; add more later)
  const YEAR_SUMMARY_PLAYLIST_IDS = [
    "37i9dQZEVXcXHWVVT0lfDq" // 2025
  ];

  // Limit how many items we display in the Podcast column to keep it snappy
  const PODCAST_COLUMN_LIMIT = 120;

  /***********************
   * DOM
   ***********************/
  const refreshButton = document.getElementById("refreshButton");
  const appMain = document.getElementById("appMain"); // ensure <main id="appMain"></main>

  /***********************
   * STATE
   ***********************/
  let state = {
    lastSnapshot: null,
    filter: "all", // all | dailyMix | top | other
    podcast: {
      tried: false, // <- new: used to suppress the “refresh to load…” placeholder after refresh
      playlist: null,
      items: [],
      error: null
    },
    others: [],
    yearSummary: []
  };

  /***********************
   * UTIL
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

  function setStatus(msg) {
    const el = document.getElementById("statusMessage");
    if (!el) return;
    el.textContent = msg || "";
  }

  function fmtHoursFromMs(ms) {
    const h = (Number(ms) || 0) / 3600000;
    return `${h.toFixed(h >= 10 ? 0 : 1)}h`;
  }

  /***********************
   * BLANK UNTIL CLICK
   ***********************/
  function blankUntilClick() {
    if (!appMain) return;
    appMain.innerHTML = `
      <p class="status" id="statusMessage">
        Click “Refresh from Spotify” to load your playlists.
      </p>
    `;
  }

  /***********************
   * UI SHELL (layout like your screenshot)
   ***********************/
  function buildShell() {
    if (!appMain) return;

    appMain.innerHTML = `
      <p class="status" id="statusMessage"></p>

      <div class="app-grid">

        <!-- LEFT: STATISTICS + OTHERS (as its own block OUTSIDE stats) -->
        <section class="panel" id="leftPanel">
          <div class="panel-header">
            <h2 class="panel-title">Statistics</h2>
          </div>

          <div class="panel-body">
            <div class="stats-stack" id="statsStack"></div>
          </div>

          <div class="panel-body" style="padding-top:0;">
            <div class="subpanel">
              <div class="subpanel-header">
                <div class="subpanel-title">Others playlists</div>
              </div>
              <div class="cards cards-compact" id="othersCards"></div>
            </div>
          </div>
        </section>

        <!-- MIDDLE: FILTERS + YEAR SUMMARY + PLAYLISTS -->
        <section class="panel" id="middlePanel">
          <div class="panel-body">

            <div class="filter-pills" id="filterPills"></div>

            <div class="subpanel" style="margin-top:12px;">
              <div class="subpanel-header">
                <div class="subpanel-title">Year Summary Playlist</div>
              </div>
              <div class="cards cards-compact" id="yearSummaryCards"></div>
            </div>

            <div class="subpanel" style="margin-top:12px;">
              <div class="subpanel-header">
                <div class="subpanel-title">Playlists</div>
                <div class="subpanel-count" id="playlistCount">–</div>
              </div>
              <div class="cards" id="playlistCards"></div>
            </div>

          </div>
        </section>

        <!-- RIGHT: PODCAST EPISODES WATCHED -->
        <aside class="panel" id="rightPanel">
          <div class="panel-header">
            <h2 class="panel-title">Podcast Episodes Watched</h2>
          </div>

          <div class="panel-body">
            <div class="podcast-head" id="podcastHead" hidden>
              <img class="podcast-thumb" id="podcastThumb" alt="">
              <div style="min-width:0">
                <div class="podcast-title" id="podcastTitle"></div>
                <div class="podcast-sub" id="podcastSub"></div>
              </div>
            </div>

            <!-- Placeholder (only before first refresh) -->
            <div class="podcast-empty" id="podcastEmpty">
              Click refresh to load podcast episodes.
            </div>

            <!-- Error (if refresh attempted but podcast load fails) -->
            <div class="podcast-error" id="podcastError" hidden></div>

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

    // modal close wiring
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
   * RENDER HELPERS
   ***********************/
  function cardHtml(p) {
    const img = p.image || "https://spotify.jdge.cc/images/spotify_logo.png";
    const count = typeof p.totalTracks === "number" ? `${p.totalTracks} items` : "";
    const owner = p.ownerLabel ? ` • ${p.ownerLabel}` : "";
    return `
      <div class="card" data-playlist-id="${escapeHtml(p.id)}">
        <img class="thumb" src="${escapeHtml(img)}" alt="" loading="lazy">
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

  /**
   * STATISTICS (3 lines, no “last updated”)
   * - Total playlists
   * - Total songs + total song hours (exclude podcast playlist)
   * - Podcast episodes + podcast hours (only podcast playlist)
   *
   * This expects your refresh payload to include totals like:
   * totals.playlists
   * totals.songs
   * totals.songMs
   * totals.podcastEpisodes
   * totals.podcastMs
   *
   * If your backend doesn’t provide those yet, you’ll see “–”.
   */
  function renderStatisticsAndOthers() {
    const data = state.lastSnapshot;
    const totals = data?.totals || {};

    const statsStack = document.getElementById("statsStack");
    const othersCards = document.getElementById("othersCards");
    if (!statsStack || !othersCards) return;

    statsStack.innerHTML = `
      <div class="stat-line">
        <div class="stat-label">Total playlists</div>
        <div class="stat-value">${totals.playlists ?? "–"}</div>
      </div>

      <div class="stat-line">
        <div class="stat-label">Total songs • Total song hours</div>
        <div class="stat-value">
          ${totals.songs ?? "–"}${typeof totals.songMs === "number" ? ` • ${fmtHoursFromMs(totals.songMs)}` : ""}
        </div>
        <div class="stat-note">Excludes Podcast Episodes playlist</div>
      </div>

      <div class="stat-line">
        <div class="stat-label">Podcast episodes • Podcast hours</div>
        <div class="stat-value">
          ${totals.podcastEpisodes ?? "–"}${typeof totals.podcastMs === "number" ? ` • ${fmtHoursFromMs(totals.podcastMs)}` : ""}
        </div>
        <div class="stat-note">Only from Podcast Episodes playlist</div>
      </div>
    `;

    othersCards.innerHTML = state.others.length
      ? state.others.map(cardHtml).join("")
      : `<div class="muted-small">No “others” playlists added.</div>`;

    wireCardClicks(othersCards);
  }

  function getFilteredPlaylists() {
    const sections = state.lastSnapshot?.sections || {};
    const dailyMix = sections.dailyMix || [];
    const top = sections.top || [];
    const other = sections.other || [];

    if (state.filter === "dailyMix") return dailyMix;
    if (state.filter === "top") return top;
    if (state.filter === "other") return other;
    return [...dailyMix, ...top, ...other];
  }

  function setFilter(next) {
    state.filter = next;
    renderFilterPills();
    renderPlaylistsList();
  }

  function renderFilterPills() {
    const pills = document.getElementById("filterPills");
    if (!pills) return;

    const sections = state.lastSnapshot?.sections || {};
    const dailyMix = sections.dailyMix || [];
    const top = sections.top || [];
    const other = sections.other || [];
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

  function renderPlaylistsList() {
    const playlistCards = document.getElementById("playlistCards");
    const playlistCount = document.getElementById("playlistCount");
    if (!playlistCards || !playlistCount) return;

    const list = getFilteredPlaylists();
    playlistCards.innerHTML = list.map(cardHtml).join("");
    playlistCount.textContent = String(list.length);

    wireCardClicks(playlistCards);
  }

  function renderYearSummary() {
    const yearCards = document.getElementById("yearSummaryCards");
    if (!yearCards) return;

    yearCards.innerHTML = state.yearSummary.length
      ? state.yearSummary.map(cardHtml).join("")
      : `<div class="muted-small">No year summary playlist added yet.</div>`;

    wireCardClicks(yearCards);
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

    const p = state.podcast.playlist;
    const items = state.podcast.items || [];
    const tried = state.podcast.tried;
    const error = state.podcast.error;

    // Before first refresh: show the gentle placeholder
    if (!tried) {
      head.hidden = true;
      errBox.hidden = true;
      empty.style.display = "block";
      list.innerHTML = "";
      return;
    }

    // After refresh: never show "refresh to load..." placeholder again
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

    // OK
    errBox.hidden = true;
    head.hidden = false;

    thumb.src = p.image || "https://spotify.jdge.cc/images/spotify_logo.png";
    title.textContent = p.name || "Podcast Episodes";
    sub.textContent = `${items.length} items`;

    list.innerHTML = items.map(renderPodcastItem).join("");
  }

  function renderPodcastItem(it) {
    const name = escapeHtml(it.name || "Untitled");
    const show = escapeHtml((it.artists || []).join(", "));
    const url = it.url || "#";
    return `
      <li class="podcast-item">
        <a class="podcast-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
          <div class="podcast-item-title">${name}</div>
          <div class="podcast-item-sub">${show}</div>
        </a>
      </li>
    `;
  }

  /***********************
   * MODAL (playlist detail)
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
        const msg = (data && (data.error || data.message || data.detail)) || text || `HTTP ${res.status}`;
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
      tracklist.innerHTML = `
        <li class="track">
          <div class="track-main">
            <div class="track-name">Failed to load playlist</div>
            <div class="track-meta">${escapeHtml(String(err.message || err))}</div>
          </div>
        </li>
      `;
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
   * API fetchers (manual sections)
   ***********************/
  async function fetchPlaylistMetaViaApi(playlistId) {
    const res = await fetch(API_PLAYLIST, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ playlistId, limit: 0 })
    });

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}

    if (!res.ok || !data) return null;

    const p = data.playlist || {};
    return {
      id: p.id || playlistId,
      name: p.name || "Untitled playlist",
      url: p.url || p.externalUrl || p.spotifyUrl || null,
      image: p.image || null,
      totalTracks: typeof p.totalTracks === "number" ? p.totalTracks : null,
      ownerLabel: p.ownerLabel || "by others"
    };
  }

  async function fetchManualOthers() {
    const out = [];
    for (const id of OTHERS_PLAYLIST_IDS) {
      const meta = await fetchPlaylistMetaViaApi(id);
      if (meta) out.push({ ...meta, ownerLabel: meta.ownerLabel || "by others" });
    }
    state.others = out;
  }

  async function fetchYearSummary() {
    const out = [];
    for (const id of YEAR_SUMMARY_PLAYLIST_IDS) {
      const meta = await fetchPlaylistMetaViaApi(id);
      if (meta) out.push({ ...meta, ownerLabel: meta.ownerLabel || "Spotify" });
    }
    state.yearSummary = out;
  }

  async function fetchPodcastPlaylist() {
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
        state.podcast.error = `HTTP ${res.status}`;
        return;
      }

      state.podcast.playlist = data.playlist || null;
      state.podcast.items = Array.isArray(data.items) ? data.items : [];
    } catch (e) {
      state.podcast.error = String(e?.message || e);
    }
  }

  /***********************
   * RENDER ALL
   ***********************/
  function renderAll() {
    renderStatisticsAndOthers();
    renderFilterPills();
    renderYearSummary();
    renderPlaylistsList();
    renderPodcastColumn();
  }

  /***********************
   * REFRESH
   ***********************/
  async function refreshFromSpotify() {
    buildShell();
    setButtonLoading(true);
    setStatus("Refreshing from Spotify…");

    try {
      const res = await fetch(API_REFRESH, {
        method: "POST",
        headers: { Accept: "application/json" }
      });

      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch {}

      if (!res.ok) {
        const msg = (data && (data.error || data.message || data.detail)) || text || `HTTP ${res.status}`;
        throw new Error(msg);
      }

      state.lastSnapshot = data;
      state.filter = "all";

      await Promise.all([
        fetchManualOthers(),
        fetchYearSummary(),
        fetchPodcastPlaylist()
      ]);

      renderAll();
      setStatus("");
    } catch (err) {
      console.error(err);
      setStatus(`Refresh failed: ${String(err.message || err)}`);
    } finally {
      setButtonLoading(false);
    }
  }

  /***********************
   * BOOT
   ***********************/
  document.addEventListener("DOMContentLoaded", () => {
    blankUntilClick();
    if (refreshButton) refreshButton.addEventListener("click", refreshFromSpotify);
  });
})();
