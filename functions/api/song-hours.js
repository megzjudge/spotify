// /song-hours.js  (Web Worker)
// Computes exact total song duration by calling your existing /api/playlist endpoint.
// No server storage. Runs client-side in background thread.
//
// Message in:
//   { playlistIds: string[], throttleMs?: number, limit?: number }
// Message out:
//   { type:"progress", done:number, total:number, playlistId:string, msSoFar:number }
//   { type:"done", totalMs:number }
//   { type:"error", message:string }

const API_PLAYLIST = "/api/playlist";

// small helper
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeJsonParse(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

/**
 * Fetch one page of playlist items (supports offset paging).
 * Requires /api/playlist to accept { playlistId, limit, offset } and return:
 *   { items, nextOffset, hasMore }
 */
async function fetchPlaylistPage({ playlistId, limit, offset }) {
  const res = await fetch(API_PLAYLIST, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ playlistId, limit, offset })
  });

  const text = await res.text();
  const data = safeJsonParse(text);

  if (!res.ok || !data) {
    const msg = (data && (data.message || data.error)) || text || `HTTP ${res.status}`;
    throw new Error(`Playlist ${playlistId} failed: ${msg}`);
  }

  const items = Array.isArray(data.items) ? data.items : [];

  const nextOffset = Number.isFinite(Number(data.nextOffset)) ? Number(data.nextOffset) : null;
  const hasMore = typeof data.hasMore === "boolean" ? data.hasMore : null;

  return { items, nextOffset, hasMore };
}

function sumTrackMs(items) {
  let ms = 0;
  for (const it of items) {
    if ((it?.type || "") !== "track") continue;
    ms += Number(it?.durationMs) || 0;
  }
  return ms;
}

/**
 * Compute total duration for a playlist (tracks only).
 * Pages until exhausted (or safety stop).
 */
async function fetchPlaylistDurationMs(playlistId, { limit = 200 } = {}) {
  let totalMs = 0;

  let offset = 0;
  let safetyPages = 0;

  while (true) {
    safetyPages++;
    if (safetyPages > 400) break; // hard stop

    const { items, nextOffset, hasMore } = await fetchPlaylistPage({
      playlistId,
      limit,
      offset
    });

    totalMs += sumTrackMs(items);

    // Decide whether to keep paging:
    // 1) explicit hasMore
    // 2) explicit nextOffset
    // 3) heuristic: full page implies maybe more
    const gotFullPage = items.length >= limit;

    if (hasMore === true) {
      offset = (nextOffset !== null) ? nextOffset : (offset + limit);
      continue;
    }

    if (nextOffset !== null && nextOffset !== offset) {
      offset = nextOffset;
      continue;
    }

    if (gotFullPage) {
      offset += limit;
      continue;
    }

    break;
  }

  return totalMs;
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  const playlistIds = Array.isArray(msg.playlistIds) ? msg.playlistIds : [];

  const throttleMs = Number(msg.throttleMs);
  const throttle = Number.isFinite(throttleMs) ? Math.max(0, throttleMs) : 120;

  const limitIn = Number(msg.limit);
  const limit = Number.isFinite(limitIn)
    ? Math.min(200, Math.max(25, Math.floor(limitIn))) // keep under Spotify page size (100) * 2; your API will clamp anyway
    : 100;

  try {
    let totalMs = 0;

    for (let i = 0; i < playlistIds.length; i++) {
      const id = String(playlistIds[i] || "").trim();
      if (!id) continue;

      self.postMessage({
        type: "progress",
        done: i,
        total: playlistIds.length,
        playlistId: id,
        msSoFar: totalMs
      });

      try {
        totalMs += await fetchPlaylistDurationMs(id, { limit });
      } catch (err) {
        // retry once
        await sleep(500);
        totalMs += await fetchPlaylistDurationMs(id, { limit });
      }

      if (throttle) await sleep(throttle);
    }

    self.postMessage({ type: "done", totalMs });
  } catch (err) {
    self.postMessage({ type: "error", message: String(err?.message || err) });
  }
};
