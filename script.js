// script.js
(() => {
  // Adjust this if you route the worker through a custom domain.
  const WORKER_BASE_URL = 'https://restless-breeze-4929.touch-97a.workers.dev';

  const refreshButton = document.getElementById('refreshButton');
  const statusMessage = document.getElementById('statusMessage');
  const summarySection = document.getElementById('summarySection');
  const playlistsContainer = document.getElementById('playlistsContainer');
  const noChangesSection = document.getElementById('noChangesSection');

  const totalPlaylistsEl = document.getElementById('totalPlaylists');
  const totalNewTracksEl = document.getElementById('totalNewTracks');
  const lastUpdatedEl = document.getElementById('lastUpdated');

  function setButtonLoading(isLoading) {
    if (!refreshButton) return;
    refreshButton.disabled = isLoading;
    refreshButton.classList.toggle('is-loading', isLoading);
  }

  async function fetchSummary({ refresh } = { refresh: false }) {
    const endpoint = refresh ? '/api/refresh' : '/api/summary';

    setButtonLoading(refresh);

    try {
      statusMessage.textContent = refresh
        ? 'Refreshing from Spotify…'
        : 'Loading latest snapshot…';

      const response = await fetch(WORKER_BASE_URL + endpoint, {
        method: refresh ? 'POST' : 'GET',
        headers: {
          Accept: 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }

      const data = await response.json();
      renderData(data);
    } catch (err) {
      console.error(err);
      statusMessage.textContent =
        'Something went wrong talking to the worker. Please try again in a moment.';
      summarySection.hidden = true;
      playlistsContainer.innerHTML = '';
      if (noChangesSection) noChangesSection.hidden = true;
    } finally {
      setButtonLoading(false);
    }
  }

  function renderData(data) {
    if (!data) {
      statusMessage.textContent =
        'No data in storage yet. Use “Refresh from Spotify” to run the first scan.';
      summarySection.hidden = true;
      playlistsContainer.innerHTML = '';
      if (noChangesSection) noChangesSection.hidden = true;
      return;
    }

    const {
      lastUpdated,
      totalPlaylists,
      totalNewTracks,
      playlists = []
    } = data;

    // Summary
    summarySection.hidden = false;
    totalPlaylistsEl.textContent =
      typeof totalPlaylists === 'number' ? totalPlaylists : '–';
    totalNewTracksEl.textContent =
      typeof totalNewTracks === 'number' ? totalNewTracks : '–';

    if (lastUpdated) {
      const d = new Date(lastUpdated);
      lastUpdatedEl.textContent = isNaN(d.getTime())
        ? lastUpdated
        : d.toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          });
    } else {
      lastUpdatedEl.textContent = 'Not yet run';
    }

    // Playlists with new tracks
    const playlistsWithNew = playlists.filter(
      (p) => (p.newTracksCount || (p.newTracks && p.newTracks.length)) > 0
    );

    playlistsContainer.innerHTML = '';

    if (!playlistsWithNew.length) {
      statusMessage.textContent = 'Up to date.';
      if (noChangesSection) noChangesSection.hidden = false;
      return;
    }

    if (noChangesSection) noChangesSection.hidden = true;
    statusMessage.textContent = 'Here are the playlists with new songs:';

    playlistsWithNew.forEach((playlist) => {
      const card = document.createElement('article');
      card.className = 'playlist-card';

      const playlistUrl =
        playlist.url ||
        (playlist.id
          ? `https://open.spotify.com/playlist/${playlist.id}`
          : '#');

      const imageUrl =
        playlist.image || 'https://spotify.jdge.cc/images/spotify_logo.png';

      const newTracks = playlist.newTracks || [];
      const newCount = playlist.newTracksCount || newTracks.length;

      const tracksListHtml =
        newTracks.length > 0
          ? `<ul class="tracks-list">
              ${newTracks
                .map((track) => {
                  const artists = Array.isArray(track.artists)
                    ? track.artists.join(', ')
                    : track.artists || '';
                  const trackUrl =
                    track.url ||
                    (track.id
                      ? `https://open.spotify.com/track/${track.id}`
                      : '#');
                  const addedDate = track.addedAt
                    ? new Date(track.addedAt)
                    : null;
                  const addedLabel =
                    addedDate && !isNaN(addedDate.getTime())
                      ? addedDate.toLocaleDateString(undefined, {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric'
                        })
                      : '';

                  return `
                    <li class="track">
                      <div class="track-main">
                        <a href="${trackUrl}" target="_blank" rel="noopener noreferrer" class="track-title">
                          ${escapeHtml(track.name || 'Untitled track')}
                        </a>
                        ${
                          artists
                            ? `<span class="track-artists">${escapeHtml(
                                artists
                              )}</span>`
                            : ''
                        }
                      </div>
                      ${
                        addedLabel
                          ? `<span class="track-added">Added ${addedLabel}</span>`
                          : ''
                      }
                    </li>
                  `;
                })
                .join('')}
            </ul>`
          : '<p class="muted">Track details not available for this playlist.</p>';

      card.innerHTML = `
        <div class="playlist-header">
          <img src="${imageUrl}" alt="" class="playlist-image" loading="lazy">
          <div class="playlist-meta">
            <a href="${playlistUrl}" target="_blank" rel="noopener noreferrer" class="playlist-name">
              ${escapeHtml(playlist.name || 'Untitled playlist')}
            </a>
            <div class="playlist-meta-row">
              ${
                typeof playlist.totalTracks === 'number'
                  ? `<span>${playlist.totalTracks} total tracks</span>`
                  : ''
              }
              ${
                newCount
                  ? `<span class="badge badge-new">${newCount} new ${
                      newCount === 1 ? 'song' : 'songs'
                    }</span>`
                  : ''
              }
            </div>
          </div>
        </div>
        ${tracksListHtml}
      `;

      playlistsContainer.appendChild(card);
    });
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (refreshButton) {
      refreshButton.addEventListener('click', () => fetchSummary({ refresh: true }));
    }

    // Load existing snapshot from KV on first load (no Spotify call).
    fetchSummary({ refresh: false });
  });
})();
