// script.js
(() => {
  const API_REFRESH = "/api/refresh";
  const LS_KEY = "spotify_snapshot_v1";

  const refreshButton = document.getElementById("refreshButton");
  const statusMessage = document.getElementById("statusMessage");
  const summarySection = document.getElementById("summarySection");
  const playlistsContainer = document.getElementById("playlistsContainer");
  const noChangesSection = document.getElementById("noChangesSection");

  const totalPlaylistsEl = document.getElementById("totalPlaylists");
  const totalNewTracksEl = document.getElementById("totalNewTracks");
  const lastUpdatedEl = document.getElementById("lastUpdated");

  const topsSection = document.getElementById("topsSection");
  const topArtistsList = document.getElementById("topArtistsList");
  const topTracksList = document.getElementById("topTracksList");

  function setButtonLoading(isLoading) {
    if (!refreshButton) return;
    refreshButton.disabled = isLoading;
    refreshButton.classList.toggle("is-loading", isLoading);
  }

  function setBlankState() {
    if (statusMessage) {
      statusMessage.textContent =
        "Click “Refresh from Spotify” to pull the latest playlist data.";
    }
    if (summarySection) summarySection.hidden = true;
    if (noChangesSection) noChangesSection.hidden = true;
    if (playlistsContainer) playlistsContainer.innerHTML = "";
    if (topsSection) topsSection.hidden = true;

    if (totalPlaylistsEl) totalPlaylistsEl.textContent = "–";
    if (totalNewTracksEl) totalNewTracksEl.textContent = "–";
    if (lastUpdatedEl) lastUpdatedEl.textContent = "Not yet run";
  }

  function setErrorState(message) {
    if (statusMessage) statusMessage.textContent = message;
    if (summarySection) summarySection.hidden = true;
    if (noChangesSection) noChangesSection.hidden = true;
    if (playlistsContainer) playlistsContainer.innerHTML = "";
    if (topsSection) topsSection.hidden = true;
  }

  function saveSnapshot(data) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn("Failed to save snapshot to localStorage", e);
    }
  }

  async function refreshFromSpotify() {
    setButtonLoading(true);

    if (statusMessage) statusMessage.textContent = "Refreshing from Spotify…";
    if (noChangesSection) noChangesSection.hidden = true;

    try {
      const res = await fetch(API_REFRESH, {
        method: "POST",
        headers: { Accept: "application/json" }
      });

      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }

      if (!res.ok) {
        const msg =
          (data && (data.error || data.message || data.detail)) ||
          text ||
          `Request failed with status ${res.status}`;
        throw new Error(msg);
      }

      if (!data) throw new Error("No JSON returned from /api/refresh");

      saveSnapshot(data);
      renderData(data);
    } catch (err) {
      console.error(err);
      setErrorState(`Couldn’t refresh from Spotify: ${String(err?.message || err)}`);
    } finally {
      setButtonLoading(false);
    }
  }

  function renderData(data) {
    if (!data) {
      setBlankState();
      return;
    }

    const payload = data.data && typeof data.data === "object" ? data.data : data;

    const playlists = Array.isArray(payload.playlists) ? payload.playlists : [];
    const lastUpdated = payload.lastUpdated || payload.updatedAt || payload.timestamp || null;

    const totalPlaylists =
      typeof payload.totalPlaylists === "number" ? payload.totalPlaylists : playlists.length;

    const totalNewTracks =
      typeof payload.totalNewTracks === "number"
        ? payload.totalNewTracks
        : playlists.reduce((sum, p) => {
            const c =
              typeof p?.newTracksCount === "number"
                ? p.newTracksCount
                : Array.isArray(p?.newTracks)
                  ? p.newTracks.length
                  : 0;
            return sum + c;
          }, 0);

    if (summarySection) summarySection.hidden = false;

    if (totalPlaylistsEl) totalPlaylistsEl.textContent = String(totalPlaylists);
    if (totalNewTracksEl) totalNewTracksEl.textContent = String(totalNewTracks);

    if (lastUpdatedEl) {
      if (lastUpdated) {
        const d = new Date(lastUpdated);
        lastUpdatedEl.textContent = isNaN(d.getTime())
          ? String(lastUpdated)
          : d.toLocaleString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit"
            });
      } else {
        lastUpdatedEl.textContent = "Not yet run";
      }
    }

    if (!playlistsContainer) return;
    playlistsContainer.innerHTML = "";

    const playlistsWithNew = playlists.filter(
      (p) => (p.newTracksCount || (p.newTracks && p.newTracks.length)) > 0
    );

    if (!playlistsWithNew.length) {
      if (statusMessage) statusMessage.textContent = "Up to date.";
      if (noChangesSection) noChangesSection.hidden = false;
    } else {
      if (statusMessage) statusMessage.textContent = "Here are the playlists with new songs:";
      if (noChangesSection) noChangesSection.hidden = true;

      playlistsWithNew.forEach((playlist) => {
        const card = document.createElement("article");
        card.className = "playlist-card";

        const playlistUrl =
          playlist.url ||
          (playlist.id ? `https://open.spotify.com/playlist/${playlist.id}` : "#");

        const imageUrl =
          playlist.image || "https://spotify.jdge.cc/images/spotify_logo.png";

        const newTracks = Array.isArray(playlist.newTracks) ? playlist.newTracks : [];
        const newCount =
          typeof playlist.newTracksCount === "number" ? playlist.newTracksCount : newTracks.length;

        const tracksListHtml =
          newTracks.length > 0
            ? `<ul class="tracks-list">
                ${newTracks
                  .map((track) => {
                    const artists = Array.isArray(track.artists)
                      ? track.artists.join(", ")
                      : track.artists || "";
                    const trackUrl =
                      track.url ||
                      (track.id ? `https://open.spotify.com/track/${track.id}` : "#");
                    const addedDate = track.addedAt ? new Date(track.addedAt) : null;
                    const addedLabel =
                      addedDate && !isNaN(addedDate.getTime())
                        ? addedDate.toLocaleDateString(undefined, {
                            year: "numeric",
                            month: "short",
                            day: "numeric"
                          })
                        : "";

                    return `
                      <li class="track">
                        <div class="track-main">
                          <a href="${trackUrl}" target="_blank" rel="noopener noreferrer" class="track-title">
                            ${escapeHtml(track.name || "Untitled track")}
                          </a>
                          ${
                            artists
                              ? `<span class="track-artists">${escapeHtml(artists)}</span>`
                              : ""
                          }
                        </div>
                        ${
                          addedLabel
                            ? `<span class="track-added">Added ${addedLabel}</span>`
                            : ""
                        }
                      </li>
                    `;
                  })
                  .join("")}
              </ul>`
            : '<p class="muted">Track details not available for this playlist.</p>';

        card.innerHTML = `
          <div class="playlist-header">
            <img src="${imageUrl}" alt="" class="playlist-image" loading="lazy">
            <div class="playlist-meta">
              <a href="${playlistUrl}" target="_blank" rel="noopener noreferrer" class="playlist-name">
                ${escapeHtml(playlist.name || "Untitled playlist")}
              </a>
              <div class="playlist-meta-row">
                ${
                  typeof playlist.totalTracks === "number"
                    ? `<span>${playlist.totalTracks} total tracks</span>`
                    : ""
                }
                ${
                  newCount
                    ? `<span class="badge badge-new">${newCount} new ${
                        newCount === 1 ? "song" : "songs"
                      }</span>`
                    : ""
                }
              </div>
            </div>
          </div>
          ${tracksListHtml}
        `;

        playlistsContainer.appendChild(card);
      });
    }

    renderTop(payload.top || payload.tops || payload);
  }

  function renderTop(data) {
    if (!topsSection || !topArtistsList || !topTracksList) return;

    const artists = Array.isArray(data.artists) ? data.artists : [];
    const tracks = Array.isArray(data.tracks) ? data.tracks : [];

    if (!artists.length && !tracks.length) {
      topsSection.hidden = true;
      return;
    }

    topsSection.hidden = false;

    topArtistsList.innerHTML = artists
      .map((a) => {
        const img = a.image || "https://spotify.jdge.cc/images/spotify_logo.png";
        const genres = (a.genres || []).slice(0, 2).join(", ");
        const subtitle = genres || (a.followers ? `${Number(a.followers).toLocaleString()} followers` : "");
        const url = a.url || "#";

        return `
          <li class="tops-item">
            <img src="${img}" alt="" class="tops-avatar" loading="lazy">
            <div class="tops-body">
              <a href="${url}" target="_blank" rel="noopener noreferrer" class="tops-title">
                ${escapeHtml(a.name || "Unknown artist")}
              </a>
              ${subtitle ? `<span class="tops-subtitle">${escapeHtml(subtitle)}</span>` : ""}
            </div>
          </li>
        `;
      })
      .join("");

    topTracksList.innerHTML = tracks
      .map((t) => {
        const img = t.albumImage || "https://spotify.jdge.cc/images/spotify_logo.png";
        const artistsStr = (t.artists || []).join(", ");
        const subtitle = artistsStr || t.album || "";
        const url = t.url || "#";

        return `
          <li class="tops-item">
            <img src="${img}" alt="" class="tops-avatar" loading="lazy">
            <div class="tops-body">
              <a href="${url}" target="_blank" rel="noopener noreferrer" class="tops-title">
                ${escapeHtml(t.name || "Unknown track")}
              </a>
              ${subtitle ? `<span class="tops-subtitle">${escapeHtml(subtitle)}</span>` : ""}
            </div>
          </li>
        `;
      })
      .join("");
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  document.addEventListener("DOMContentLoaded", () => {
    setBlankState();
    if (refreshButton) refreshButton.addEventListener("click", refreshFromSpotify);
  });
})();
