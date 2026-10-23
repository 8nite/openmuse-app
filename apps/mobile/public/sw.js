// OpenMuse web service worker: app-shell offline cache + notification clicks
// + Web Push receiver (server holds VAPID keys, see apps/server/src/engine/push.ts).
var CACHE = "openmuse-v1";
var CORE = ["/", "/manifest.webmanifest", "/favicon.png", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(CORE))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (key !== CACHE) return caches.delete(key);
            return null;
          }),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Network-first for navigations/API, cache-fallback so the shell still opens offline.
self.addEventListener("fetch", (event) => {
  var req = event.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          var copy = res.clone();
          caches.open(CACHE).then((cache) => {
            cache.put("/", copy).catch(() => {});
          });
          return res;
        })
        .catch(() => caches.match("/").then((cached) => cached || Response.error())),
    );
    return;
  }
  // Cache hashed static assets (_expo/static/...) after first load.
  if (url.pathname.indexOf("/_expo/static/") === 0) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          var copy = res.clone();
          caches.open(CACHE).then((cache) => {
            cache.put(req, copy).catch(() => {});
          });
          return res;
        });
      }),
    );
  }
});

self.addEventListener("push", (event) => {
  var title = "OpenMuse";
  var body = "";
  var url = "/";
  try {
    const data = event.data ? event.data.json() : {};
    if (data.title) title = String(data.title).slice(0, 60);
    if (data.body) body = String(data.body).slice(0, 180);
    if (data.url) url = String(data.url);
  } catch {}
  event.waitUntil(
    self.registration.showNotification(title, {
      body: body || undefined,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-72.png",
      tag: "openmuse-push",
      data: { url: url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (let i = 0; i < list.length; i++) {
        const client = list[i];
        if ("focus" in client) {
          if (event.notification.data?.url) {
            try {
              client.navigate(event.notification.data.url);
            } catch {}
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        const url = event.notification.data?.url || "/";
        return self.clients.openWindow(url);
      }
      return null;
    }),
  );
});
