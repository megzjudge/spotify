(() => {
  const API_REFRESH = "/api/refresh";
  const API_PLAYLIST = "/api/playlist";

  const refreshButton = document.getElementById("refreshButton");
  const appMain = document.getElementById("appMain");

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
        <!-- LEFT: LIBRARY STATS -->
        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">Library</h2>
          </div>
          <div class="panel-body">
            <div class="summary-grid" id="summaryGrid"></div>
          </div>
        </section>

        <!-- MIDDLE: SECTIONS + PLAYLIST LIST -->
        <section class="panel">
          <div class="panel-body section-pills" id="sectionPills"></div>

          <div class="panel" style="margin:14px; margin-top:12px; overflow:hidden;">
            <div class="list-header">
              <div class="title">Playlists</div>
              <div class="count" id="playlistCount">–</div>
            </div>
            <div class="cards" id="playlistCards"></div>
          </div>
        </section>

        <!-- RIGHT: OTHERS -->
        <aside class="panel">
          <div class="panel-header">
            <h2 class="panel-title">Others playlists</h2>
          </div>
          <div class="panel-body">
            <div class="cards" id="othersCards" style="max-height:64vh; overflow:auto; padding:0;"></div>
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

    // modal close handlers
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
    const sub = [count].filter(Boolean).join(" • ");

    return `
      <div class="card" data-playlist-id="${escapeHtml(p.id)}">
        <img class="thumb" src="${escapeHtml(img)}" alt="" loading="lazy">
        <div class="card-meta">
          <p class="card-title">${escapeHtml(p.name || "Untitled")}</p>
          <p class="card-sub">${escapeHtml(sub)}</p>
        </div>
      </div>
    `;
  }

  function renderSnapshot(data) {
    const totals = data?.totals || {};
    const sections = data?.sections || {};
    const othersPlaylists = Array.isArray(data?.othersPlaylists) ? data.othersPlaylists : [];

    const summaryGrid = document.getElementById("summaryGrid");
    const sectionPills = document.getElementById("sectionPills");
    const playlistCards = document.getElementById("playlistCards");
    const playlistCount = document.getElementById("playlistCount");
    const othersCards = document.getElementById("othersCards");

    if (!summaryGrid || !sectionPills || !playlistCards || !playlistCount || !othersCards) return;

    // LEFT: stats (no “new tracks”; all metrics)
    summaryGrid.innerHTML = `
      <div class="summary-card"><h2>Total playlists</h2><p class="summary-value">${totals.playlists ?? "–"}</p></div>
      <div class="summary-card"><h2>Total songs</h2><p class="summary-value">${totals.songs ?? "–"}</p></div>
      <div class="summary-card"><h2>Total hours</h2><p class="summary-value">${totals.songMs ? fmtHours(totals.songMs) : "–"}</p></div>
      <div class="summary-card"><h2>Podcast episodes</h2><p class="summary-value">${totals.podcastEpisodes ?? "–"}</p></div>
      <div class="summary-card"><h2>Podcast hours</h2><p class="summary-value">${totals.podcastMs ? fmtHours(totals.podcastMs) : "–"}</p></div>
      <div class="summary-card"><h2>Last updated</h2><p class="summary-value">${fmtDate(data.lastUpdated)}</p></div>
    `;

    // MIDDLE: pills (Daily Mix / Top / Other counts)
    const dailyMix = sections.dailyMix || [];
    const top = sections.top || [];
    const other = sections.other || [];

    sectionPills.innerHTML = `
      <div class="pill"><div>Daily Mix</div><span>${dailyMix.length}</span></div>
      <div class="pill"><div>Top</div><span>${top.length}</span></div>
      <div class="pill"><div>Other</div><span>${other.length}</span></div>
    `;

    // MIDDLE: full playlist list (same as screenshot — default open)
    const allPlaylists = [...dailyMix, ...top, ...other];
    playlistCards.innerHTML = allPlaylists.map(cardHtml).join("");
    playlistCount.textContent = String(allPlaylists.length);

    // RIGHT: others playlists (manual allowlist only)
    othersCards.innerHTML = othersPlaylists.length
      ? othersPlaylists.map(cardHtml).join("")
      : `<div style="padding:12px 14px;color:var(--muted);font-size:.9rem">No “others” playlists have been added yet.</div>`;

    wireCardClicks();
    setStatus("");
  }

  function wireCardClicks() {
    document.querySelectorAll(".card[data-playlist-id]").forEach((el) => {
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
    const modalTitle = document.getElementById("modalTitle");

    if (!detailThumb || !detailTitle || !detailSub || !tracklist || !modalTitle) return;

    // quick reset
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

      modalTitle.textContent = "Playlist";
      detailThumb.src = p.image || "https://spotify.jdge.cc/images/spotify_logo.png";
      detailTitle.textContent = p.name || "Untitled playlist";

      const infoBits = [];
      if (typeof p.totalTracks === "number") infoBits.push(`${p.totalTracks} items`);
      if (p.ownerLabel) infoBits.push(p.ownerLabel);
      detailSub.textContent = infoBits.join(" • ");

      tracklist.innerHTML = items.map(renderTrack).join("");
      setStatus("");
    } catch (err) {
      console.error(err);
      setStatus(`Playlist load failed: ${String(err.message || err)}`);
      tracklist.innerHTML = `<li class="track"><div class="track-main"><div class="track-name">Failed to load playlist</div><div class="track-meta">${escapeHtml(String(err.message || err))}</div></div></li>`;
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

      renderSnapshot(data);
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
