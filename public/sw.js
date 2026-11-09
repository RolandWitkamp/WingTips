// Offline reading: the app itself, the tips you loaded last time and their photos stay available
// without a connection. Everything is network-first, so online you always get the latest version
// and the cache only answers when the network can't.
const CACHE = "wingtips-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE && key !== "wingtips-share") await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Android share menu → WingTips (manifest share_target): GitHub Pages can't take a POST, so the
  // worker catches it, parks the shared GPX in a cache and opens the app, which picks it up.
  if (req.method === "POST" && new URL(req.url).pathname === "/share-gpx") {
    event.respondWith((async () => {
      try {
        const file = (await req.formData()).get("gpx");
        if (file && typeof file !== "string") {
          const cache = await caches.open("wingtips-share");
          await cache.put("/__shared-gpx", new Response(await file.text(), { headers: { "Content-Type": "application/gpx+xml" } }));
        }
      } catch { /* open the app anyway */ }
      return Response.redirect("/?shared-gpx=1", 303);
    })());
    return;
  }
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const isPage = req.mode === "navigate";
  const isOwnFile = url.origin === self.location.origin;
  const isSupabaseData = url.hostname.endsWith(".supabase.co") && url.pathname.startsWith("/rest/v1/");
  const isPhoto = url.hostname.endsWith(".supabase.co") && url.pathname.startsWith("/storage/v1/object/public/");
  const isStaticThirdParty = /(^|\.)fonts\.(googleapis|gstatic)\.com$|(^|\.)flagcdn\.com$/.test(url.hostname);
  if (isPage) event.respondWith(networkFirst(req, "/"));
  else if (isOwnFile || isSupabaseData) event.respondWith(networkFirst(req));
  else if (isPhoto || isStaticThirdParty) event.respondWith(cacheFirst(req));
});

async function networkFirst(req, cacheKey) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(cacheKey || req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(cacheKey || req);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") cache.put(req, res.clone());
  return res;
}
