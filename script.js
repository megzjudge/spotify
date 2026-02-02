(() => {
  const API_REFRESH = "/api/refresh";
  const API_PLAYLIST = "/api/playlist";

  // IMPORTANT: put your Podcast Episodes playlist ID here (same one you used in refresh.js)
  const PODCAST_PLAYLIST_ID = "2tHrihmpYzDbJ8rit7HtFR";

  const refreshButton = document.getElementById("refreshButton");
  const appMain = document.getElementById("appMain");

  let state = {
    lastSnapshot: null,
    filter: "all", // all | dailyMix | top | other
    podcast: {
      playlist: null,
      items: []
    }
  };

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

  function fmtDate(iso) {
    if (!iso) return "–";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function fmtHours(ms) {
    const h = (Number(ms) || 0) / 3600000;
    return `${h.toFixed(h >= 10 ? 0 : 1)}h`;
  }

  function blankUntilClick() {
    if (!appMain) return;
    appMain.innerHTML = `
      <p class="status" id="statusMessage">Click “Refresh from Spotify” to load your playlists.</p>
    `;
  }

  function buildShell() {
    if (!appMain) return;

    appMain.innerHTML = `
      <p class="status" id="statusMessage"></p>

      <div class="app-grid">
        <!-- LEFT: LIBRARY + OTHERS UNDER IT -->
        <section class="panel" id="leftPanel">
          <div class="panel-header">
            <h2 class="panel-title">Library</h2>
          </div>
          <div class="panel-body">
            <div class="summary-grid" id="summaryGrid"></div>

            <div class="subpanel" style="margin-top:14px;">
              <div class="subpanel-header">
                <div class="subpanel-title">Others playlists</div>
              </div>
              <div class="cards cards-compact" id="othersCards"></div>
            </div>
          </div>
        </section>

        <!-- MIDDLE: FILTER PILLS + PLAYLISTS LIST -->
        <section class="panel" id="middlePanel">
          <div class="panel-body">
            <div class="filter-pills" id="filterPills"></div>

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

            <div class="podcast-empty" id="podcastEmpty">
              Refresh to load your podcast playlist.
            </div>

            <ul class="podcast-list" id="podcastList"></ul>
          </div>
        </aside>
      </div>

      <!-- MODAL for playlist details -->
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

    // modal close
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

  function setStatus(msg) {
    const el = document.getElementById("statusMessage");
    if (!el) return;
    el.textContent = msg || "";
  }

  function cardHtml(p) {
    const img = p.image || "https://spotify.jdge.cc/images/spotify_logo.png";
    const count = typeof p.totalTracks === "number" ? `${p.totalTracks} items` : "";
    return `
      <div class="card" data-playlist-id="${escapeHtml(p.id)}">
        <img class="thumb" src="${escapeHtml(img)}" alt="" loading="lazy">
        <div class="card-meta">
          <p class="card-title">${escapeHtml(p.name || "Untitled")}</p>
          <p class="card-sub">${escapeHtml(count)}</p>
        </div>
      </div>
    `;
  }

  function setFilter(next) {
    state.filter = next;
    renderPlaylistsList();
    renderFilterPills();
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

  function renderLibraryAndOthers() {
    const data = state.lastSnapshot;
    const totals = data?.totals || {};
    const othersPlaylists = Array.isArray(data?.othersPlaylists) ? data.othersPlaylists : [];

    const summaryGrid = document.getElementById("summaryGrid");
    const othersCards = document.getElementById("othersCards");
    if (!summaryGrid || !othersCards) return;

    summaryGrid.innerHTML = `
      <div class="summary-card"><h2>Total playlists</h2><p class="summary-value">${totals.playlists ?? "–"}</p></div>
      <div class="summary-card"><h2>Total songs</h2><p class="summary-value">${totals.songs ?? "–"}</p></div>
      <div class="summary-card"><h2>Total hours</h2><p class="summary-value">${totals.songMs ? fmtHours(totals.songMs) : "–"}</p></div>
      <div class="summary-card"><h2>Podcast episodes</h2><p class="summary-value">${totals.podcastEpisodes ?? "–"}</p></div>
      <div class="summary-card"><h2>Podcast hours</h2><p class="summary-value">${totals.podcastMs ? fmtHours(totals.podcastMs) : "–"}</p></div>
      <div class="summary-card"><h2>Last updated</h2><p class="summary-value">${fmtDate(data?.lastUpdated)}</p></div>
    `;

    othersCards.innerHTML = othersPlaylists.length
      ? othersPlaylists.map(cardHtml).join("")
      : `<div class="muted-small">No “others” playlists have been added yet.</div>`;

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

  function renderPlaylistsList() {
    const playlistCards = document.getElementById("playlistCards");
    const playlistCount = document.getElementById("playlistCount");
    if (!playlistCards || !playlistCount) return;

    const list = getFilteredPlaylists();
    playlistCards.innerHTML = list.map(cardHtml).join("");
    playlistCount.textContent = String(list.length);

    wireCardClicks(playlistCards);
  }

  function renderPodcastColumn() {
    const head = document.getElementById("podcastHead");
    const empty = document.getElementById("podcastEmpty");
    const thumb = document.getElementById("podcastThumb");
    const title = document.getElementById("podcastTitle");
    const sub = document.getElementById("podcastSub");
    const list = document.getElementById("podcastList");
    if (!head || !empty || !thumb || !title || !sub || !list) return;

    const p = state.podcast.playlist;
    const items = state.podcast.items || [];

    if (!p) {
      head.hidden = true;
      empty.style.display = "block";
      list.innerHTML = "";
      return;
    }

    head.hidden = false;
    empty.style.display = "none";

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

  function wireCardClicks(containerEl) {
    containerEl.querySelectorAll(".card[data-playlist-id]").forEach((el) => {
      el.addEventListener("click", async () => {
        const id = el.getAttribute("data-playlist-id");
        if (!id) return;
        await openPlaylistModal(id);
      });
    });
  }

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

  async function fetchPodcastPlaylist() {
    // fetch the podcast playlist’s items to show in the right column
    if (!PODCAST_PLAYLIST_ID || PODCAST_PLAYLIST_ID.includes("PUT_")) return;

    try {
      const res = await fetch(API_PLAYLIST, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ playlistId: PODCAST_PLAYLIST_ID, limit: 200 })
      });

      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch {}

      if (!res.ok) return;

      state.podcast.playlist = data.playlist || null;
      state.podcast.items = Array.isArray(data.items) ? data.items : [];
    } catch {
      // ignore
    }
  }

  function renderAll() {
    renderLibraryAndOthers();
    renderFilterPills();
    renderPlaylistsList();
    renderPodcastColumn();
  }

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

      // load podcast playlist items for right column
      await fetchPodcastPlaylist();

      renderAll();
      setStatus("");
    } catch (err) {
      console.error(err);
      setStatus(`Refresh failed: ${String(err.message || err)}`);
    } finally {
      setButtonLoading(false);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    blankUntilClick();
    if (refreshButton) refreshButton.addEventListener("click", refreshFromSpotify);
  });
})();
