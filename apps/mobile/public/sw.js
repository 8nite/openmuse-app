// OpenMuse web service worker: app-shell offline cache + notification clicks.
// ponytail: keep this dependency-free and cache-only; no push server (no VAPID) by design.
var CACHE = "openmuse-v1";
var CORE = ["/", "/manifest.webmanifest", "/favicon.png", "/icons/icon-192.png"];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(function (cache) {
        return cache.addAll(CORE);
      })
      .catch(function () {})
      .then(function () {
        return self.skipWaiting();
      }),
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys.map(function (key) {
            if (key !== CACHE) return caches.delete(key);
            return null;
          }),
        );
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

// Network-first for navigations/API, cache-fallback so the shell still opens offline.
self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then(function (res) {
          var copy = res.clone();
          caches.open(CACHE).then(function (cache) {
            cache.put("/", copy).catch(function () {});
          });
          return res;
        })
        .catch(function () {
          return caches.match("/").then(function (cached) {
            return cached || Response.error();
          });
        }),
    );
    return;
  }
  // Cache hashed static assets (_expo/static/...) after first load.
  if (url.pathname.indexOf("/_expo/static/") === 0) {
    event.respondWith(
      caches.match(req).then(function (cached) {
        if (cached) return cached;
        return fetch(req).then(function (res) {
          var copy = res.clone();
          caches.open(CACHE).then(function (cache) {
            cache.put(req, copy).catch(function () {});
          });
          return res;
        });
      }),
    );
  }
});

self.addEventListener("push", function (event) {
  var title = "OpenMuse";
  var body = "";
  var url = "/";
  try {
    var data = event.data ? event.data.json() : {};
    if (data.title) title = String(data.title).slice(0, 60);
    if (data.body) body = String(data.body).slice(0, 180);
    if (data.url) url = String(data.url);
  } catch (e) {}
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

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var client = list[i];
        if ("focus" in client) {
          if (event.notification.data && event.notification.data.url) {
            try {
              client.navigate(event.notification.data.url);
            } catch (e) {}
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        var url = (event.notification.data && event.notification.data.url) || "/";
        return self.clients.openWindow(url);
      }
      return null;
    }),
  );
});
