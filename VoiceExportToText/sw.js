// Service worker for static hosting (GitHub Pages), where serve.py / serve.ps1 aren't there to help:
// 1. models > 100 MB are stored as <file>.part0, .part1, … (GitHub's file limit): a request for <file> that the host
//    doesn't have is answered with the parts streamed back to back
// 2. COOP/COEP headers on every same-origin response → crossOriginIsolated → multi-threaded WASM (the local servers
//    send them; GitHub Pages can't)
// 3. models/ and vendor/ are kept in Cache Storage (~0.6 GB, downloaded once) — not on localhost, where the files are
//    already on disk
const CACHE = 'voice-models-v1';
const KEEP = !['localhost', '127.0.0.1'].includes(location.hostname);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (url.origin !== location.origin || (req.cache === 'only-if-cached' && req.mode !== 'same-origin')) return;
  const big = /\/(models|vendor)\//.test(url.pathname);
  e.respondWith((big ? stored(req, e) : fetch(req)).then(isolate));
});

function isolate(r) {
  if (r.status === 0) return r;            // opaque
  const h = new Headers(r.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

async function stored(req, e) {
  const cache = KEEP ? await caches.open(CACHE) : null;
  const hit = cache && (await cache.match(req.url));
  if (hit) return req.method === 'HEAD' ? new Response(null, { status: 200, headers: hit.headers }) : hit;
  let r = await fetch(req);
  if (r.status === 404) r = (await joined(req.url, req.method)) || r;
  if (cache && r.ok && req.method === 'GET') e.waitUntil(cache.put(req.url, r.clone()));
  return r;
}

/** <url>.part0, .part1, … as one response; null without part0 */
async function joined(url, method) {
  const heads = [];
  for (let i = 0; ; i++) {
    const r = await fetch(`${url}.part${i}`, { method: 'HEAD' });
    if (!r.ok) break;
    heads.push(+r.headers.get('content-length') || 0);
  }
  if (!heads.length) return null;
  const headers = { 'Content-Type': 'application/octet-stream' };
  if (heads.every(Boolean)) headers['Content-Length'] = String(heads.reduce((a, b) => a + b, 0));
  if (method === 'HEAD') return new Response(null, { status: 200, headers });
  let i = 0, reader = null;
  const body = new ReadableStream({
    async pull(c) {
      for (;;) {
        if (!reader) {
          if (i >= heads.length) { c.close(); return; }
          const r = await fetch(`${url}.part${i++}`);
          if (!r.ok) { c.error(new Error(`${url}.part${i - 1}: ${r.status}`)); return; }
          reader = r.body.getReader();
        }
        const { done, value } = await reader.read();
        if (!done) { c.enqueue(value); return; }
        reader = null;
      }
    },
  });
  return new Response(body, { status: 200, headers });
}
