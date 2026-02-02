(() => {
  /***********************
   * CONFIG
   ***********************/
  const API_REFRESH = "/api/refresh";
  const API_PLAYLIST = "/api/playlist";

  const PODCAST_PLAYLIST_ID = "2tHrihmpYzDbJ8rit7HtFR";

  const OTHERS_PLAYLIST_IDS = [
    "71z6BdHlnfNj4DKRhuu1Fk",
    "7jYNznHoIYgJBzwT5jpoOe",
    "41PZG18MrSTagagiIaiG4X",
    "37i9dQZF1DX5mB2C8gBeUM",
    "37i9dQZF1EQnsJ0xmvpihE"
  ];

  const YEAR_SUMMARY_PLAYLIST_IDS = [
    "37i9dQZEVXcXHWVVT0lfDq"
  ];

  const PODCAST_COLUMN_LIMIT = 120;

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
    podcast: { tried: false, error: null, playlist: null, items: [] }
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

          <!-- YEAR SUMMARY AS ITS OWN PANEL -->
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
            <h2 class="panel-title">Podcast Eps</h2>
          </div>
          <div class="panel-body col-scroll-body">

            <div class="podcast-head" id="podcastHead" hidden>
              <img class="podcast-thumb" id="podcastThumb" alt="">
              <div style="min-width:0">
                <div class="podcast-title" id="podcastTitle"></div>
                <div class="podcast-sub" id="podcastSub"></div>
              </div>
            </div>

            <!-- keep node (for layout), but no instructional text -->
            <div class="podcast-empty" id="podcastEmpty"></div>

            <div class="podcast-error" id="podcastError" hidden></div>

            <ul class="podcast-list podcast-scroll" id="podcastList"></ul>
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

  /***********************
   * Statistics
   ***********************/
  function renderStatistics() {
    const grid = document.getElementById("statsGrid");
    if (!grid) return;

    const totals = state.snapshot?.totals || {};
    const playlists = totals.playlists ?? "–";

    const songs = totals.songs ?? "–";
    const songHours = typeof totals.songMs === "number" ? fmtHoursFromMs(totals.songMs) : "–";

    const podEps = totals.podcastEpisodes ?? "–";
    const podHours = typeof totals.podcastMs === "number" ? fmtHoursFromMs(totals.podcastMs) : "–";

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
        <div class="stat-big">${escapeHtml(String(songHours))}</div>
      </div>

      <div class="stat-card">
        <div class="stat-kicker">Podcast eps</div>
        <div class="stat-big">${escapeHtml(String(podEps))}</div>
      </div>

      <div class="stat-card">
        <div class="stat-kicker">Podcast hrs</div>
        <div class="stat-big">${escapeHtml(String(podHours))}</div>
      </div>
    `;
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
   * Prefer refresh payload, fallback to per-ID fetch
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

    if (!res.ok || !data?.playlist) return null;

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
    // Others
    if (!state.others.length) {
      const others = [];
      for (const id of OTHERS_PLAYLIST_IDS) {
        const meta = await fetchPlaylistMeta(id, "by others");
        if (meta) others.push(meta);
      }
      state.others = others;
    }

    // Year Summary
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
        state.podcast.error = `HTTP ${res.status}`;
        return;
      }

      state.podcast.playlist = data.playlist || null;

      const items = Array.isArray(data.items) ? data.items : [];

      // newest added first
      items.sort((a, b) => {
        const ta = a?.addedAt ? Date.parse(a.addedAt) : 0;
        const tb = b?.addedAt ? Date.parse(b.addedAt) : 0;
        return tb - ta;
      });

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
  }

  function renderPodcastItem(it) {
    const epImg = it.image || "https://spotify.jdge.cc/images/spotify_logo.png";
    const name = escapeHtml(it.name || "Untitled");
    const channel = escapeHtml((it.artists || []).join(", "));
    const dur = fmtDurationFromMs(it.durationMs || 0);
    const url = it.url || "#";

    return `
      <li class="podcast-item">
        <a class="podcast-link podcast-link-grid" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
          <img class="podcast-ep-thumb" src="${escapeHtml(epImg)}" alt="" loading="lazy">
          <div class="podcast-ep-meta">
            <div class="podcast-item-title">${name}</div>
            <div class="podcast-item-sub">${channel ? channel + " • " : ""}${escapeHtml(dur)}</div>
          </div>
        </a>
      </li>
    `;
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
        const msg = (data && (data.error || data.message)) || text || `HTTP ${res.status}`;
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
    buildShell();
    setButtonLoading(true);
    setStatus("Refreshing from Spotify…");

    try {
      const res = await fetch(API_REFRESH, { method: "POST", headers: { Accept: "application/json" } });

      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch {}

      if (!res.ok) {
        const msg = (data && (data.error || data.message)) || text || `HTTP ${res.status}`;
        throw new Error(msg);
      }

      state.snapshot = data;
      state.filter = "all";

      // Prefer refresh payload for these panels (fast + reliable)
      state.others = Array.isArray(data?.othersPlaylists) ? data.othersPlaylists.map(p => ({ ...p, ownerLabel: "by others" })) : [];
      state.yearSummary = Array.isArray(data?.yearSummaryPlaylists) ? data.yearSummaryPlaylists.map(p => ({ ...p, ownerLabel: "Spotify" })) : [];

      await Promise.all([
        loadOthersAndYearSummaryFallback(),
        loadPodcastColumn()
      ]);

      renderStatistics();
      renderFilterPills();
      renderPlaylists();
      renderOthers();
      renderYearSummary();
      renderPodcastColumn();

      setStatus("");
    } catch (err) {
      console.error(err);
      setStatus(`Refresh failed: ${String(err.message || err)}`);
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
