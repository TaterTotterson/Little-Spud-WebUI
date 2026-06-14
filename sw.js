const CACHE_NAME = "little-spud-webui-v43";
const ASSETS = [
  "./",
  "./index.html",
  "./src/app.js",
  "./src/styles.css",
  "./assets/little-spud.svg",
  "./assets/new-tater-logo.png",
  "./assets/new-tater-avatar.png",
  "./manifest.webmanifest"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => null);
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        const focused = clients.find((client) => "focus" in client);
        if (focused) return focused.focus();
        if (self.clients.openWindow) return self.clients.openWindow("./");
        return null;
      })
  );
});
