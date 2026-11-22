// Cache léger : l'interface fonctionne hors connexion avec les derniers horaires téléchargés.
const CACHE = "satovaou-v2";
const SHELL = ["./", "index.html", "css/style.css", "js/app.js", "js/router.js", "js/fares.js", "js/calendar.js",
  "manifest.webmanifest", "icons/icon-192.png", "vendor/leaflet/leaflet.js", "vendor/leaflet/leaflet.css"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // tuiles IGN, géocodage : réseau direct
  // réseau d'abord en revalidant le cache HTTP (code et horaires toujours à jour), cache en secours hors ligne
  e.respondWith(fetch(e.request, { cache: "no-cache" }).then((r) => {
    const copy = r.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request)));
});
