const version = "__VERSION__";
const assets = "__ASSETS__";
const cacheName = "ruang-baca-" + version;
const shells = ["/login/", "/library/", "/read/"];
const base = ["/site.css", "/icon.svg", "/manifest.webmanifest", "/client/login.js", "/client/library.js", ...shells];

async function prepareReader(cache) {
  if (await cache.match("/_reader-ready")) return;
  for (let offset = 0; offset < assets.length; offset += 12) {
    await Promise.all(assets.slice(offset, offset + 12).map(async (url) => {
      if (!(await cache.match(url))) await cache.add(url);
    }));
  }
  await cache.put("/_reader-ready", new Response("ok"));
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await cache.addAll(base);
    const old = (await caches.keys()).filter((name) => name.startsWith("ruang-baca-") && name !== cacheName);
    for (const name of old) {
      if (await (await caches.open(name)).match("/client/reader.js")) {
        await prepareReader(cache);
        break;
      }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("ruang-baca-") && key !== cacheName)
    .map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("message", (event) => {
  if (event.data !== "prepare-reader") return;
  event.waitUntil((async () => {
    try {
      await prepareReader(await caches.open(cacheName));
      event.ports[0].postMessage(true);
    } catch {
      event.ports[0].postMessage(false);
    }
  })());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (!base.includes(url.pathname) && !assets.includes(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    if (event.request.mode === "navigate" && shells.includes(url.pathname)) {
      const fresh = await fetch(event.request, { cache: "no-cache" }).catch(() => undefined);
      if (fresh?.ok) {
        await cache.put(url.pathname, fresh.clone()).catch(() => {});
        return fresh;
      }
      return (await cache.match(url.pathname)) ?? fresh ?? Response.error();
    }
    const cached = await cache.match(url.pathname);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok) await cache.put(url.pathname, response.clone());
    return response;
  })());
});
