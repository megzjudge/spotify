// /song-hours.js  (Web Worker)
// Computes exact total song duration by calling your existing /api/playlist endpoint.
// No server storage. Runs client-side in background thread.

const API_PLAYLIST = "/api/playlist";

// small helper
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchPlaylistDurationMs(playlistId) {
  // NOTE: relies on your /api/playlist returning items with durationMs for tracks.
  // If /api/playlist is paginated server-side, it should already handle it.
  const res = await fetch(API_PLAYLIST, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ playlistId })
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok || !data) {
    const msg = (data && (data.message || data.error)) || text || `HTTP ${res.status}`;
    throw new Error(`Playlist ${playlistId} failed: ${msg}`);
  }

  const items = Array.isArray(data.items) ? data.items : [];
  let ms = 0;
  for (const it of items) {
    if ((it?.type || "") !== "track") continue;
    ms += Number(it?.durationMs) || 0;
  }
  return ms;
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  const playlistIds = Array.isArray(msg.playlistIds) ? msg.playlistIds : [];
  const throttleMs = Number(msg.throttleMs) || 120;

  try {
    let totalMs = 0;

    for (let i = 0; i < playlistIds.length; i++) {
      const id = playlistIds[i];
      if (!id) continue;

      // progress update
      self.postMessage({ type: "progress", done: i, total: playlistIds.length });

      // retry once on transient errors
      try {
        totalMs += await fetchPlaylistDurationMs(id);
      } catch (err) {
        await sleep(500);
        totalMs += await fetchPlaylistDurationMs(id);
      }

      // gentle throttle to reduce rate-limit pain
      await sleep(throttleMs);
    }

    self.postMessage({ type: "done", totalMs });
  } catch (err) {
    self.postMessage({ type: "error", message: String(err?.message || err) });
  }
};
