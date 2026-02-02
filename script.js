(() => {
  const API_REFRESH = "/api/refresh";
  const API_PLAYLIST = "/api/playlist";

  const refreshButton = document.getElementById("refreshButton");
  const appMain = document.getElementById("appMain");

  let snapshot = null;

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
        <section class="panel" id="leftPanel">
          <div class="panel-header">
            <h2 class="panel-title">Library</h2>
          </div>
          <div class="panel-body">
            <div class="summary-grid" id="summaryGrid"></div>
            <div style="height:12px"></div>
            <div class="accordion" id="accordion"></div>
          </div>
        </section>

        <section class="panel" id="centerPanel">
          <div class="panel-body detail-empty" id="detailEmpty">
            Click a playlist to view songs.
          </div>

          <div id="detailView" style="display:none">
            <div class="detail-head">
              <img class="detail-thumb" id="detailThumb" alt="">
              <div style="min-width:0">
                <h3 class="detail-title" id="detailTitle"></h3>
                <p class="detail-sub" id="detailSub"></p>
              </div>
            </div>
            <ul class="tracklist" id="tracklist"></ul>
          </div>
        </section>

        <aside class="panel" id="rightPanel">
          <div class="panel-header">
            <h2 class="panel-title">Special</h2>
          </div>
          <div class="panel-body">
            <div class="menu" id="specialMenu"></div>
          </div>
        </aside>
      </div>
    `;
  }

  function setStatus(msg) {
    const el = document.getElementById("statusMessage");
    if (!el) return;
    el.textContent = msg || "";
  }

  function cardHtml(p) {
    const img = p.image || "https://spotify.jdge.cc/images/spotify_logo.png";
    const count = typeof p.totalTracks === "number" ? `${p.totalTracks} items` : "";
    const owner = p.ownerIsMe === false ? "by others" : "";
    const sub = [count, owner].filter(Boolean).join(" • ");

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

  function makeAcc(label, playlists, openByDefault) {
    const wrap = document.createElement("div");
    wrap.className = `acc ${openByDefault ? "open" : ""}`;

    wrap.innerHTML = `
      <button type="button">
        <div>${escapeHtml(label)}</div>
        <span>${playlists.length}</span>
      </button>
      <div class="acc-body">
        <div class="cards">
          ${playlists.map(cardHtml).join("")}
        </div>
      </div>
    `;

    wrap.querySelector("button").addEventListener("click", () => {
      wrap.classList.toggle("open");
    });

    return wrap;
  }

  function renderSnapshot(data) {
    const totals = data?.totals || {};
    const sections = data?.sections || {};
    const specials = Array.isArray(data?.specials) ? data.specials : [];

    const summaryGrid = document.getElementById("summaryGrid");
    const accordion = document.getElementById("accordion");
    const specialMenu = document.getElementById("specialMenu");

    if (!summaryGrid || !accordion || !specialMenu) return;

    // Summary: your new top stats
    summaryGrid.innerHTML = `
      <div class="summary-card"><h2>Total playlists</h2><p class="summary-value">${totals.playlists ?? "–"}</p></div>
      <div class="summary-card"><h2>Total songs</h2><p class="summary-value">${totals.songs ?? "–"}</p></div>
      <div class="summary-card"><h2>Total hours</h2><p class="summary-value">${totals.songMs ? fmtHours(totals.songMs) : "–"}</p></div>
      <div class="summary-card"><h2>Podcast episodes</h2><p class="summary-value">${totals.podcastEpisodes ?? "–"}</p></div>
      <div class="summary-card"><h2>Podcast hours</h2><p class="summary-value">${totals.podcastMs ? fmtHours(totals.podcastMs) : "–"}</p></div>
      <div class="summary-card"><h2>Last updated</h2><p class="summary-value">${fmtDate(data.lastUpdated)}</p></div>
    `;

    // Accordion: default open should be the main set.
    accordion.innerHTML = "";
    accordion.appendChild(makeAcc("Playlists", sections.other ? [...(sections.dailyMix||[]), ...(sections.top||[]), ...(sections.other||[])] : [], true));
    accordion.appendChild(makeAcc("Daily Mix", sections.dailyMix || [], false));
    accordion.appendChild(makeAcc("Top", sections.top || [], false));
    accordion.appendChild(makeAcc("Other", sections.other || [], false));

    // Special menu (right)
    specialMenu.innerHTML = specials.length
      ? specials.map(cardHtml).join("")
      : `<div style="color:var(--muted);font-size:.9rem">No special playlists found.</div>`;

    // Wire clicks
    wireCardClicks();
  }

  function wireCardClicks() {
    document.querySelectorAll(".card[data-playlist-id]").forEach((el) => {
      el.addEventListener("click", async () => {
        const id = el.getAttribute("data-playlist-id");
        if (!id) return;
        await openPlaylist(id);
      });
    });
  }

  async function openPlaylist(playlistId) {
    setStatus("Loading playlist…");

    const detailEmpty = document.getElementById("detailEmpty");
    const detailView = document.getElementById("detailView");
    const detailThumb = document.getElementById("detailThumb");
    const detailTitle = document.getElementById("detailTitle");
    const detailSub = document.getElementById("detailSub");
    const tracklist = document.getElementById("tracklist");

    if (!detailEmpty || !detailView || !detailThumb || !detailTitle || !detailSub || !tracklist) return;

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

      const infoBits = [];
      if (typeof p.totalTracks === "number") infoBits.push(`${p.totalTracks} items`);
      if (p.ownerLabel) infoBits.push(p.ownerLabel);
      detailSub.textContent = infoBits.join(" • ");

      tracklist.innerHTML = items.map(renderTrack).join("");

      detailEmpty.style.display = "none";
      detailView.style.display = "block";
      setStatus("");
    } catch (err) {
      console.error(err);
      setStatus(`Playlist load failed: ${String(err.message || err)}`);
    }
  }

  function renderTrack(t) {
    const name = escapeHtml(t.name || "Untitled");
    const artists = escapeHtml((t.artists || []).join(", "));
    const url = t.url || "#";

    // right side: show minutes for tracks/episodes
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

      snapshot = data;
      renderSnapshot(data);
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
