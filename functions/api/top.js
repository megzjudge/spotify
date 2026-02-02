// functions/api/top.js
export async function onRequestGet() {
  return new Response(JSON.stringify({ artists: [], tracks: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
