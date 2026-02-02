// functions/api/summary.js
export async function onRequestGet() {
  return new Response("null", {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
