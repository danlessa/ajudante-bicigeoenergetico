// Pedal Hidrográfico — service worker
//
// Two cache buckets, both STATIC_CACHE by default:
//   STATIC_CACHE  — app shell (HTML/CSS/JS/icons/manifest): stale-while-
//                    revalidate. Cached copy serves instantly; a network
//                    fetch runs in the background and updates the cache for
//                    the *next* page load. So redeploys propagate without
//                    users having to hard-refresh — they just get the new
//                    version on their second visit. Same-origin mutable
//                    state (tours.ttl, uploads.ttl, data_graphs.ttl,
//                    routes.json) is the exception: network-first, since the
//                    backend upserts them live and staleness there means
//                    stale data, not just a stale app shell.
//   RUNTIME_CACHE — map tiles, OSRM, elevation, etc. stale-while-revalidate.

// A numeração divergiu enquanto a branch `deploy` seguiu à frente da `main`:
// v370 foi emitido duas vezes (grafo do viário aqui, link de rotas salvas no
// origin) e v371/v372 saíram na `deploy` (busca de endereços, ⇄ inverter).
// v373 fica acima de tudo que já circulou, que é o que importa: se a VERSION
// não crescer, o service worker serve cache velho.
const VERSION = 'phidro-v399';
const STATIC_CACHE = `${VERSION}-static`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

// Pre-cache only the entry HTML and small steady assets. app.js and
// style.css carry a deploy-time `?v=<ts>` query string, so pre-caching them
// here under the un-versioned URL would just waste a fetch — they get
// cached on first real load via the stale-while-revalidate path.
const STATIC_ASSETS = [
  './',
  './index.html',
  './routes.json',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png',
  './img/amora-icon.png',
  './imagens.html',
  './pessoas.html',
  './upload_images.html',   // forms de envio/passeio: abrem do cache (SWR) em vez de baixar a cada modal
  './upload_tour.html',
  './censo.html',
  './fonts/fonts.css',
  './fonts/ibm-plex-mono-400.woff2',
  './fonts/ibm-plex-mono-400i.woff2',
  './fonts/ibm-plex-mono-600.woff2',
  './fonts/ibm-plex-mono-700.woff2',
  './lib/utils.js',
  './lib/n3.min.js',
  './lib/exifr.esm.js',   // autofill de EXIF no upload (vendorado; era jsdelivr)
  './lib/media-query.js',   // infra de consulta (Store N3 + Comunica lazy)
  './lib/energy-worker.js',
  './lib/graph-engine.js',   // importScripts()'d pelo energy-worker no boot
  './lib/tom-select.complete.min.js',
  './lib/tom-select.min.css',
  './lib/qrcode.js',
  './lib/leaflet/leaflet.js',
  './lib/leaflet/leaflet.css',
  './lib/leaflet/images/layers.png',
  './lib/leaflet/images/layers-2x.png',
  './lib/leaflet/images/marker-icon.png',
  './lib/leaflet/images/marker-icon-2x.png',
  './lib/leaflet/images/marker-shadow.png',
  './lib/locatecontrol/L.Control.Locate.min.js',
  './lib/locatecontrol/L.Control.Locate.min.css',
  './lib/flatgeobuf-geojson.min.js',   // leitor FGB do viário/água (range requests)
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) =>
      // Some assets may 404 in dev (e.g. before routes.json is built); use
      // cache.add per-item with catch so install doesn't fail the whole batch.
      Promise.all(
        STATIC_ASSETS.map((url) =>
          cache.add(url).catch((err) => console.warn(`[sw] skip ${url}: ${err.message}`)),
        ),
      ),
    ),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== STATIC_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k)),
      ),
    ),
  );
  self.clients.claim();
});

// Hosts whose responses we want to keep cached for offline / fast revisits.
// (photon.komoot.io — a busca de endereços — fica DE FORA de propósito: cada
// query de typeahead é única, então cachear não compra nada; hosts fora da
// lista passam direto pra rede, sem bloqueio.)
const RUNTIME_HOSTS = [
  /(^|\.)tile\.openstreetmap\.org$/,
  /(^|\.)server\.arcgisonline\.com$/,
  /(^|\.)telhas\.pedalhidrografi\.co$/,
  /(^|\.)cameratopo\.pedalhidrografi\.co$/,
  /(^|\.)raster\.geosampa\.prefeitura\.sp\.gov\.br$/,
  /(^|\.)api\.open-meteo\.com$/,
  /(^|\.)routing\.openstreetmap\.de$/,
  // jsdelivr fica só pelos lazy-loads do app.js (heic2any/jszip/geotiff);
  // Leaflet, n3 e exifr foram vendorados pra lib/ (unpkg/CDN saiu).
  /(^|\.)cdn\.jsdelivr\.net$/,
];

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Localização ao vivo: NUNCA cachear. As posições mudam a cada segundo e
  // o GET sai com Cache-Control: no-store — deixa passar direto pra rede.
  if (url.pathname.includes('/live-location')) return;  // cobre /live-locations tb

  // FlatGeobuf (viário/água): passa DIRETO pra rede, sem tocar o cache. O
  // leitor busca fatias por Range (206) e o cache.match() IGNORA o header
  // Range — um 200 completo cacheado seria servido como resposta a um range
  // request, corrompendo o parse. (206 nunca é cacheado pelo guard de status
  // abaixo, mas o perigo é o lado do match.)
  if (url.pathname.endsWith('.fgb')) return;

  // Same-origin: estado mutável usa network-first — qualquer upload/sync
  // novo aparece no próximo refresh sem o dance de dois-refreshes do
  // stale-while-revalidate. Inclui routes.json: o backend faz upsert
  // incremental nele a cada /upload-tour //delete-tour, então é tão "vivo"
  // quanto os TTLs. Inclui também /saved-routes e /saved-route/<id> (o
  // fetch com cache:'no-store' do cliente só ignora o cache HTTP, não o
  // Cache Storage do SW — sem essa entrada, salvar/excluir uma rota salva
  // reaparecia/sumia só depois de dois refreshes). `endsWith`/`includes`
  // (e não ===) pra funcionar também sob hosting com subpath (ex.: o
  // mirror legado em /rotas_app/).
  if (url.origin === self.location.origin) {
    if (url.pathname.endsWith('/data/data_graphs.ttl')
        || url.pathname.endsWith('/data/uploads.ttl')
        || url.pathname.endsWith('/data/tours.ttl')
        || url.pathname.endsWith('/data/images.ttl')
        || url.pathname.endsWith('/data/identities.ttl')
        || url.pathname.endsWith('/data/lists.ttl')
        || url.pathname.endsWith('/routes.json')
        || url.pathname.includes('/saved-route')
        // Página de compartilhamento /route/<slug> (não pega o og.png, que
        // termina em .png): o redirect embutido aponta pro slug — servir uma
        // cópia velha depois de renomear a rota mandaria pro slug morto.
        || /\/route\/[a-z0-9][a-z0-9-]*$/.test(url.pathname)
        // Página por passeio /passeio/<slug> (o index SSR'ado): o conteúdo
        // muda a cada edição do passeio — network-first, com fallback pro
        // shell cacheado no networkFirst quando offline. (A forma de 2
        // segmentos /passeio/<ES>/<seq> não casa — a classe não inclui "/".)
        || /\/passeio\/[A-Za-z0-9-]+$/.test(url.pathname)) {
      event.respondWith(networkFirst(req, STATIC_CACHE));
    } else {
      event.respondWith(staleWhileRevalidate(req, STATIC_CACHE));
    }
    return;
  }

  // Allowlisted third-party hosts: stale-while-revalidate.
  if (RUNTIME_HOSTS.some((re) => re.test(url.host))) {
    event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
    return;
  }

  // Everything else: pass through.
});

// Tenta rede primeiro; cai pra cache só se a rede falhar (offline).
async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok && res.status === 200) cache.put(req, res.clone());
    return res;
  } catch (_) {
    const cached = await cache.match(req);
    if (cached) return cached;
    // Navegação offline pra um caminho nunca visitado (ex.: um
    // /passeio/<slug> recém-compartilhado): serve o shell do app — o
    // cliente abre o passeio pelo path (tryOpenTourFromPath).
    if (req.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    return Response.error();
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req)
    .then((res) => {
      // Only cache successful, non-opaque responses to avoid filling cache
      // with failed/redirect garbage.
      if (res && res.ok && res.status === 200) cache.put(req, res.clone());
      return res;
    })
    .catch(() => cached || Response.error());
  return cached || fetchPromise;
}
