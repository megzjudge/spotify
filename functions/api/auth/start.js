export async function onRequestGet({ env }) {
  const clientId = env.SPOTIFY_PROFILE; // client_id
  if (!clientId) return new Response("Missing SPOTIFY_PROFILE", { status: 500 });

  // Hardcode your deployed domain (no localhost, no ports)
  const REDIRECT_URI = "https://spotify.jdge.cc/api/auth/callback";

  // Scopes for private + collaborative playlists
  const scope = [
    "playlist-read-private",
    "playlist-read-collaborative"
  ].join(" ");

  const state = crypto.randomUUID();

  const authUrl = new URL("https://accounts.spotify.com/authorize");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("show_dialog", "true");

  return Response.redirect(authUrl.toString(), 302);
}
