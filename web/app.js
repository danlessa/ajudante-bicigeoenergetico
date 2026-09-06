// Pedal Hidrográfico — "Rotas" page (standalone)
//
// Reads the pre-baked web/routes.json (produced by `python scripts/build-routes.py`),
// renders every route on a Leaflet map with OSM + the custom hydrography
// overlay, sorts the sidebar by Data descending, and supports:
//   - a date-window slider that filters routes in real time
//   - clicking a route to open a modal embedding the linked Instagram post

// Marcador de build — confira no console (`window.__PHIDRO_BUILD`) pra saber
// se o browser está rodando o app.js mais novo (deve casar com o sw VERSION).
window.__PHIDRO_BUILD = 270;

const ROUTES_JSON_URL = 'routes.json';
const SP = [-23.5505, -46.6333];
const DAY_MS = 86_400_000;

// First ES-module migration step: pure helpers + toast + storage live in
// lib/utils.js. The rest of app.js still uses module-level let/const to be
// migrated incrementally.
import {
  escapeHtml,
  escapeXml,
  formatHMS,
  mapConcurrent,
  haversineMeters as haversine,
  showToast,
  storage,
} from './lib/utils.js';

// ─── Settings ────────────────────────────────────────────────────────────────
// Tudo aqui é tunável pelo modal de Configurações (gear no topbar). Defaults
// vivem em SETTINGS_DEFAULTS; o objeto `settings` é o estado vivo, persistido
// em localStorage e exportável/importável como JSON-LD.
const SETTINGS_KEY = 'phidro:settings';
const SETTINGS_DEFAULTS = {
  photoSource: 'server',                // 'server' | 'local'
  spotlight: {
    enabled: false,
    boost: 10.0,
    peakSec: 1,
    peakCount: 1,
    pulseShape: 7,
    echoAmp: 0.7,
    echoOffset: 0.7,
    tickMs: 200,
  },
  markerLayout: {
    minScaleFloor: 0.4,
    minScaleCeil: 0.9,
    rampStart: 13,
    rampEnd: 18,
    hoverScale: 3.3,                    // ×40px = tamanho do photo-dot no hover
  },
  mapDefaults: {
    startZoom: 12,                      // aplicado no load inicial
    baseLayer: 'osm',                   // 'osm' | 'satellite'
  },
  cameraTopo: {
    // Câmera Topográfica: relevo servido como tiles XYZ por
    // cameratopo.pedalhidrografi.co com a fonte Google Earth Engine (dem=ee —
    // mesma composição elevação em cmocean.phase × declividade blend-multiply,
    // renderizada pelo EE em qualquer zoom). null = deixa o servidor resolver
    // como `auto` (percentis de uma região de referência fixa).
    minElev: null,     // m (auto = p5)
    maxElev: null,     // m (auto = p80)
    maxSlope: null,    // m/m (auto = p80 da declividade)
    slopeGamma: 1.2,   // γ do realce de declividade
    cycles: 1,         // quantas vezes a paleta se repete na faixa de elevação
    opacityPct: 85,
  },
  clipsGhost: {
    enabled: true,                      // tocar vídeo fantasma quando Animação ligada
    segmentSec: 10,                     // duração de cada clipe em laço
    fadeSec: 2,                         // duração do fade-in/out da imagem
    audioFadeSec: 4,                    // fade do áudio — geralmente mais longo que o vídeo
    useHd: false,                       // usar a variante 720p (mais pesada) em vez da 360p
  },
  clipMarker: {
    baseSizePx: 18,                     // diâmetro do anel branco em repouso
    borderPx: 3,                        // espessura da borda
    minScale: 0.1,                      // escala no silêncio
    maxScale: 20,                       // escala no pico de RMS
    intensityGain: 4,                   // multiplicador no RMS pra esticar a faixa visual
  },
  audioLoop: {
    enabled: false,                     // loop ambiente só com o áudio dos clipes
    segmentSec: 12,                     // tempo por trilha antes do crossfade
    crossfadeSec: 5,                    // duração do crossfade entre trilhas
  },
  fovCone: {
    enabled: true,                      // mostra cone de visada quando há EXIF bearing
    sizeScale: 1.0,                     // multiplica o raio do cone (1 = default ~38 SVG units)
    opacity: 0.45,                      // 0..1, aplicado em fill-opacity via custom property
  },
  images: {
    // Markers usam `image-set(thumb 1x, large 2x)` por padrão — em retina
    // o browser baixa a versão `large` (~500 KB) pra nitidez. Com dezenas
    // de markers isso estoura memória em celular. Quando OFF (padrão), o
    // 2x não é declarado e os markers ficam no thumb mesmo em retina.
    // Não afeta o popup de preview (que sempre usa `large`).
    useLarge: false,
  },
  attendees: {
    // Toggle de privacidade pra listagem nominal de participantes /
    // iniciantes nos passeios. OFF por padrão — quando ON, o modal de
    // rota mostra "Participantes" e "Iniciantes" como chips, o censo
    // ganha colunas com a contagem nominal, e o upload_tour expõe os
    // campos pra edição. Os dados nos triples (schema:attendee,
    // ph:hasNewcomer) NÃO são afetados pelo toggle — só a renderização.
    list: false,
  },
  liveLocation: {
    // Compartilhamento de localização ao vivo (opt-in, pseudônimo, efêmero).
    // `enabled` NUNCA persiste ligado entre sessões (resetado no boot, igual
    // ao spotlight) — transmitir a própria posição exige ação deliberada a
    // cada sessão. `displayName` persiste. As posições só existem em memória
    // no servidor e expiram sozinhas (ver backend LIVE_TTL_S).
    enabled: false,
    view: true,                          // ver pessoas ao vivo no mapa (independe de transmitir)
    displayName: '',
    ttlSec: 10800,                       // por quanto tempo o servidor guarda meu rastro (s) — 03:00
    shareMs: 5000,                       // intervalo mínimo entre POSTs da minha posição
    pollMs: 4000,                        // intervalo de leitura das posições alheias
  },
};
function _deepMerge(base, over) {
  if (!over || typeof over !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(over)) {
    const v = over[k];
    if (v && typeof v === 'object' && !Array.isArray(v)
        && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = _deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return JSON.parse(JSON.stringify(SETTINGS_DEFAULTS));
    return _deepMerge(SETTINGS_DEFAULTS, JSON.parse(raw));
  } catch {
    return JSON.parse(JSON.stringify(SETTINGS_DEFAULTS));
  }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}
// 'pi' era o nome antigo da fonte same-origin (backend rodava num Raspberry
// Pi), renomeada pra 'server'. 'cdn' (espelho estático legado) e 'auto'
// (servidor→cdn) foram removidos — o backend serve as fotos na mesma
// origem. Usado tanto no boot quanto na importação de settings (JSON-LD
// exportado de uma sessão antiga pode carregar qualquer um destes).
function _migratePhotoSourceValue(v) {
  if (v === 'pi' || v === 'cdn' || v === 'auto') return 'server';
  return v;
}
const settings = loadSettings();
// Migração: fonte de imagens ficava em chave separada — preserva valor antigo.
{
  const legacy = localStorage.getItem('phidro:photoSource');
  if (legacy && settings.photoSource === SETTINGS_DEFAULTS.photoSource) {
    settings.photoSource = legacy;
  }
  settings.photoSource = _migratePhotoSourceValue(settings.photoSource);
}
// Animação NÃO persiste entre sessões — sempre arranca desligada. Se o
// usuário ligar no Ajustes/botão, vale só pra sessão atual.
if (settings.spotlight) settings.spotlight.enabled = false;
// Compartilhamento ao vivo idem — nunca arranca transmitindo (privacidade).
if (settings.liveLocation) settings.liveLocation.enabled = false;

// ─── Map ─────────────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: true })
  .setView(SP, settings.mapDefaults.startZoom);

// ─── Ordem de empilhamento das camadas (z-index por pane) ────────────────────
// Cada camada de mapa reordenável vive no seu próprio pane, numa faixa de
// z-index entre o tilePane (200) e o markerPane (600) do Leaflet — assim
// marcadores (fotos, números de rota) e tooltips ficam SEMPRE por cima. O topo
// da lista do modal "Ordem de empilhamento" é desenhado por cima. A ordem é
// editável ali e persiste no localStorage (por dispositivo). Camadas sem
// presença espacial (loop de áudio, vídeo fantasma) não entram aqui.
const LAYER_PANE = (id) => `phlyr-${id}`;
const DEFAULT_LAYER_ORDER = [
  'osm', 'satellite',          // mapas base (fundo)
  'camera-topo',               // relevo FABDEM (abaixo da topografia colorida)
  'rmsampa',                   // topografia colorida
  'sara1930',                  // SARA 1930 (histórico)
  'mapa1850',                  // Mapa de 1850 (histórico)
  'mtpi-pindorama', 'mtpi-parana', // MTPI (índice de posição topográfica multiescala)
  'positron',                  // OSM claro (CARTO) em multiply — ACIMA dos rasters
  'custom-wms', 'custom-xyz',  // camadas custom do usuário
  'osm-cicloinfra',
  'osm-overpass',
  'routes',                    // linhas das rotas, no topo das camadas de mapa
  'route-highlight',           // rota destacada (1,5×), acima das rotas normais
];
const LAYER_ORDER_KEY = 'phidro:layerOrder';
let layerOrder = DEFAULT_LAYER_ORDER.slice();
try {
  const saved = JSON.parse(localStorage.getItem(LAYER_ORDER_KEY) || 'null');
  // Reconcilia em vez de descartar: preserva a ordem salva do usuário e só
  // encaixa as camadas novas (ausentes no salvo) na posição padrão delas,
  // descartando ids que não existem mais. Assim adicionar uma camada (ex.:
  // 'route-highlight') NÃO zera o empilhamento personalizado de quem já tinha.
  if (Array.isArray(saved) && saved.length) {
    // filtra ids inválidos E dedupa (indexOf === i) — localStorage corrompido
    // à mão não pode duplicar um pane e atribuir z-index duas vezes.
    const merged = saved.filter((k, i) => DEFAULT_LAYER_ORDER.includes(k) && saved.indexOf(k) === i);
    DEFAULT_LAYER_ORDER.forEach((k, defIdx) => {
      if (!merged.includes(k)) merged.splice(Math.min(defIdx, merged.length), 0, k);
    });
    layerOrder = merged;
  }
} catch { /* ignora JSON inválido */ }
// Cria os panes ANTES de qualquer camada que os referencie. Tiles e vetores
// herdam o pointer-events correto da CSS do Leaflet (tiles não bloqueiam
// clique; paths interativos continuam clicáveis), então não mexemos nisso.
for (const id of DEFAULT_LAYER_ORDER) map.createPane(LAYER_PANE(id));
function applyLayerOrder() {
  layerOrder.forEach((id, i) => {
    const pane = map.getPane(LAYER_PANE(id));
    if (pane) pane.style.zIndex = String(360 + i);
  });
  try { localStorage.setItem(LAYER_ORDER_KEY, JSON.stringify(layerOrder)); } catch { /* quota */ }
}
applyLayerOrder();

// Preview de foto/vídeo: popup do Leaflet quando cabe na viewport; senão
// (tipicamente mobile portrait), promovemos pra um modal bottom-sheet
// centralizado. O Leaflet sozinho não dá uma UX boa em mobile — o popup
// fica espremido contra as bordas, hit-area pequena pro fechar, e o
// autoPan acaba escondendo o marker. O modal resolve isso.

function panMapAbovePhotoSheet(latlng, modal) {
  if (!latlng) return;
  const mapEl = map.getContainer();
  const mapRect = mapEl.getBoundingClientRect();
  const sheet = modal && !modal.hidden ? modal.querySelector('.modal-content') : null;
  const modalRect = sheet
    ? sheet.getBoundingClientRect()
    : { top: window.innerHeight };
  const visTop = Math.max(0, mapRect.top);
  const visBottom = Math.min(modalRect.top, mapRect.bottom);
  const desiredY = (visTop + visBottom) / 2 - mapRect.top;
  const desiredX = mapEl.clientWidth / 2;
  const pt = map.latLngToContainerPoint(latlng);
  const dx = pt.x - desiredX;
  const dy = pt.y - desiredY;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
    map.panBy([dx, dy], { animate: true, duration: 0.25 });
  }
}
// Pausa qualquer <video>/<audio> dentro do container — usado tanto no
// fechamento do popup do Leaflet quanto do fallback modal pra evitar
// áudio tocando em background depois que o dialog fecha.
function pauseMediaIn(root) {
  if (!root) return;
  for (const el of root.querySelectorAll?.('video, audio') || []) {
    try { el.pause(); } catch (_) {}
  }
}

// Leaflet só fecha o popup detachando o DOM; em alguns browsers o <video>
// Destaque do marcador de foto cujo popup está aberto (o clicado) — análogo ao
// anel dos vídeos, pra ficar fácil achar qual marcador foi aberto num cluster.
let _activePhotoDot = null;
function clearPhotoMarkerHighlight() {
  if (_activePhotoDot) { _activePhotoDot.classList.remove('photo-dot-active'); _activePhotoDot = null; }
}
function highlightPhotoMarker(marker) {
  clearPhotoMarkerHighlight();
  const dot = marker?.getElement?.()?.querySelector('.photo-dot');
  if (dot) { dot.classList.add('photo-dot-active'); _activePhotoDot = dot; }
}

// continua tocando antes do GC. Pausa explícita no popupclose.
map.on('popupclose', (e) => {
  const el = e.popup?.getElement?.();
  if (el) pauseMediaIn(el);
  clearPhotoMarkerHighlight();
});

function showPhotoFallbackModal(innerHtml) {
  let modal = document.getElementById('photo-fallback-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'photo-fallback-modal';
    modal.className = 'modal photo-fallback-modal';
    modal.hidden = true;
    modal.addEventListener('click', (ev) => {
      if (ev.target === modal) {
        pauseMediaIn(modal);
        modal.hidden = true;
        clearPhotoPreview();
      }
    });
    document.body.appendChild(modal);
  }
  modal.innerHTML =
    '<div class="modal-content photo-fallback-content">' +
      innerHtml +
    '</div>';
  modal.querySelector('.photo-fallback-content').appendChild(makeCloseDot(() => {
    pauseMediaIn(modal);
    modal.hidden = true;
    clearPhotoPreview();
  }));
  modal.hidden = false;
  // Navegação também no modal promovido: arrastar ↔ + manter as setas visíveis.
  attachPhotoSwipe(modal.querySelector('.photo-fallback-content'));
  updatePhotoNavArrows();
}
// Fecha o preview de foto/vídeo QUALQUER que seja sua forma atual: popup real
// do Leaflet OU o modal promovido (`photo-fallback-modal`, usado quando o
// popup não cabe no viewport — ver promoteIfNeeded). `map.closePopup()`
// sozinho não basta: se o popup já foi promovido, ele nem existe mais como
// popup Leaflet, e o modal clonado ficava aberto por trás da ação (ex.: dava
// pra abrir a galeria via "Ver grande" e o preview antigo continuava na tela).
function closePhotoPreview() {
  map.closePopup();
  const modal = document.getElementById('photo-fallback-modal');
  if (modal && !modal.hidden) {
    pauseMediaIn(modal);
    modal.hidden = true;
  }
  clearPhotoPreview();
}
function popupFitsViewport(el) {
  const rect = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 16;
  return (
    rect.left >= margin &&
    rect.top >= margin &&
    rect.right <= vw - margin &&
    rect.bottom <= vh - margin
  );
}
map.on('popupopen', (e) => {
  const popup = e.popup;
  const el = popup.getElement?.();
  if (!el || !el.classList.contains('photo-popup-wrap')) return;
  // Destaca o marcador de foto clicado (vídeos já se distinguem pela borda).
  const srcMarker = popup._source;
  if (srcMarker && srcMarker._photo) highlightPhotoMarker(srcMarker);
  // Preview ativo → habilita a navegação por tempo (setas / ← → / arrastar).
  photoPreviewMarker = srcMarker || null;
  updatePhotoNavArrows();
  attachPhotoSwipe(el);
  // Se já tem um modal aberto (de outro marker), fecha — evita dois previews visíveis.
  const existingModal = document.getElementById('photo-fallback-modal');
  if (existingModal && !existingModal.hidden) {
    pauseMediaIn(existingModal);
    existingModal.hidden = true;
  }
  const promoteIfNeeded = () => {
    if (!el.isConnected || el.style.visibility === 'hidden') return;
    if (popupFitsViewport(el)) return;
    const inner = el.querySelector('.photo-popup');
    if (!inner) return;
    el.style.visibility = 'hidden';
    showPhotoFallbackModal(inner.outerHTML);
    setTimeout(() => map.closePopup(popup), 0);
    const latlng = popup.getLatLng?.();
    const modal = document.getElementById('photo-fallback-modal');
    requestAnimationFrame(() => panMapAbovePhotoSheet(latlng, modal));
  };
  // Espera o layout assentar, e re-checa quando a img/video terminar de
  // baixar (sem dimensões a primeira medição erra).
  requestAnimationFrame(promoteIfNeeded);
  const media = el.querySelector('.photo-popup img, .photo-popup video');
  if (media) {
    const evt = media.tagName === 'VIDEO' ? 'loadedmetadata' : 'load';
    if (!media.complete && !(media.duration > 0)) {
      media.addEventListener(evt, () => requestAnimationFrame(promoteIfNeeded), { once: true });
    }
  }
});

// ─── Navegação entre fotos no preview (ordenação por TEMPO) ───────────────────
// Com um preview aberto: ← (ou seta ‹, ou arrastar →) vai pra foto ANTERIOR no
// tempo; → (ou seta ›, ou arrastar ←) vai pra PRÓXIMA. Só entre as fotos
// visíveis no momento (respeita o filtro de listas/SPARQL, a janela de data e o
// filtro de pedal). Fotos sem data-hora ficam de fora.
let photoPreviewMarker = null;
let _photoNavigating = false;

// Marcadores de foto visíveis com data válida, ordenados por tempo (asc).
function visiblePhotoMarkersByTime() {
  return photoMarkers
    .filter((m) => map.hasLayer(m) && m._photo && Number.isFinite(Date.parse(m._photo.datetime)))
    .map((m) => ({ m, t: Date.parse(m._photo.datetime) }))
    .sort((a, b) => a.t - b.t
      || String(a.m._photo.phash || '').localeCompare(String(b.m._photo.phash || '')))
    .map((x) => x.m);
}
// forward=true → próxima no tempo; forward=false → anterior. Sem wrap.
function findTimeNeighbor(fromMarker, forward) {
  if (!fromMarker?._photo) return null;
  const list = visiblePhotoMarkersByTime();
  const idx = list.indexOf(fromMarker);
  if (idx === -1) return null;
  const j = forward ? idx + 1 : idx - 1;
  return (j >= 0 && j < list.length) ? list[j] : null;
}
function navigatePhoto(forward) {
  const from = photoPreviewMarker;
  if (!from || !from._photo) return;
  const target = findTimeNeighbor(from, forward);
  if (!target) return;
  _photoNavigating = true;
  map.setView(target.getLatLng(), map.getZoom(), { animate: false });
  target.openPopup();          // dispara popupopen → seta photoPreviewMarker + promove se preciso
  photoPreviewMarker = target;
  _photoNavigating = false;
}

// Setas fixas nos cantos (‹ ›), visíveis com um preview aberto.
const photoNavPrev = document.createElement('button');
photoNavPrev.type = 'button';
photoNavPrev.className = 'photo-nav-arrow photo-nav-prev';
photoNavPrev.innerHTML = '‹';
photoNavPrev.title = 'Foto anterior no tempo (←)';
photoNavPrev.setAttribute('aria-label', photoNavPrev.title);
photoNavPrev.hidden = true;
const photoNavNext = document.createElement('button');
photoNavNext.type = 'button';
photoNavNext.className = 'photo-nav-arrow photo-nav-next';
photoNavNext.innerHTML = '›';
photoNavNext.title = 'Próxima foto no tempo (→)';
photoNavNext.setAttribute('aria-label', photoNavNext.title);
photoNavNext.hidden = true;
photoNavPrev.addEventListener('click', (e) => { e.stopPropagation(); navigatePhoto(false); });
photoNavNext.addEventListener('click', (e) => { e.stopPropagation(); navigatePhoto(true); });
document.body.append(photoNavPrev, photoNavNext);

function updatePhotoNavArrows() {
  const on = !!photoPreviewMarker;
  photoNavPrev.hidden = !(on && findTimeNeighbor(photoPreviewMarker, false));
  photoNavNext.hidden = !(on && findTimeNeighbor(photoPreviewMarker, true));
}
function clearPhotoPreview() {
  photoPreviewMarker = null;
  updatePhotoNavArrows();
}
// Arrasta ↔ pra navegar (toque): arrastar pra ESQUERDA → próxima; pra DIREITA → anterior.
function attachPhotoSwipe(el) {
  if (!el || el._swipeBound) return;
  el._swipeBound = true;
  let x0 = null, y0 = null;
  el.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0]; x0 = t.clientX; y0 = t.clientY;
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) navigatePhoto(dx < 0);
  }, { passive: true });
}
// ← / → navegam quando há preview (e o foco não está num campo de texto).
document.addEventListener('keydown', (e) => {
  if (!photoPreviewMarker) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); navigatePhoto(true); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); navigatePhoto(false); }
});
// Fechamento REAL do popup (não promoção pro modal nem navegação) limpa o preview.
map.on('popupclose', (e) => {
  const el = e.popup?.getElement?.();
  if (!el || !el.classList.contains('photo-popup-wrap')) return;
  if (_photoNavigating) return;
  setTimeout(() => {
    if (_photoNavigating) return;
    const modal = document.getElementById('photo-fallback-modal');
    if (modal && !modal.hidden) return;                              // promovido pro modal
    if (document.querySelector('.leaflet-popup .photo-popup')) return; // outro popup abriu
    clearPhotoPreview();
  }, 0);
});

const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  pane: LAYER_PANE('osm'),
  attribution: '&copy; OpenStreetMap contributors',
});
const satellite = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  {
    maxZoom: 19,
    pane: LAYER_PANE('satellite'),
    attribution:
      'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  },
);
// Camada base inicial vem do settings.mapDefaults.baseLayer.
(settings.mapDefaults.baseLayer === 'satellite' ? satellite : osm).addTo(map);

// Em telas retina (devicePixelRatio ≥ 2) os tiles de 256px eram ampliados 2×
// pra preencher a caixa de 256px de CSS = 512px físicos → borrados. Só ficavam
// nítidos com o zoom do navegador em 50% (o que derruba o dpr pra 1). A correção
// é o padrão "retina tiles" do Leaflet: pedir o tile do zoom SEGUINTE e desenhá-lo
// em meia caixa (tileSize 128 + zoomOffset 1), pra 256px de imagem caírem em 256px
// físicos = nítido. (É o que detectRetina faz por dentro — mas ele também derruba
// maxZoom 19→18, sumindo a camada nos zooms mais fechados, e deixa maxNativeZoom em
// 16, fazendo o caminho retina pedir z17 inexistente e 404ar; por isso é manual.)
const rmsampaRetina = L.Browser.retina;
const rmsampa = L.tileLayer('https://telhas.pedalhidrografi.co/rmsampa-v2/{z}/{x}/{y}.png', {
  maxZoom: 19,
  // O servidor só tem tiles até z=16; acima disso o Leaflet escala o tile do
  // z=16 (interpolado) em vez de pedir z≥17 e levar 404. No caminho retina o
  // zoom pedido é nativo+1, então limitamos a 15 pra nunca passar de 16.
  maxNativeZoom: rmsampaRetina ? 15 : 16,
  tileSize: rmsampaRetina ? 128 : 256,
  zoomOffset: rmsampaRetina ? 1 : 0,
  opacity: 0.85,
  pane: LAYER_PANE('rmsampa'),
  attribution: 'Topografia: Pedal Hidrográfico',
}).addTo(map);

// CARTO Positron (OSM claro minimalista, sem chave). O pane fica em
// mix-blend-mode: multiply — branco é identidade, então por cima dos rasters
// (Câmera Topográfica, topografia colorida, satélite) o traçado escuro de
// ruas/rótulos fica "gravado" no relevo em vez de cobri-lo com o fundo claro.
// Sozinha (sem raster embaixo), multiply contra o fundo do mapa ≈ camada
// normal. {r} = tiles @2x em telas retina (o Leaflet resolve sozinho).
const positron = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  maxZoom: 19,
  subdomains: 'abcd',
  pane: LAYER_PANE('positron'),
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
});
map.getPane(LAYER_PANE('positron')).style.mixBlendMode = 'multiply';

// Historical aerial photo mosaic of São Paulo (SARA Brasil, 1930), served
// from GeoSampa's GeoServer. Leaflet's L.tileLayer.wms requests one tile at
// a time. To browse other historical mosaics on the same workspace see:
//   https://raster.geosampa.prefeitura.sp.gov.br/geoserver/geoportal/wms?service=WMS&request=GetCapabilities
const sara1930 = L.tileLayer.wms(
  'https://raster.geosampa.prefeitura.sp.gov.br/geoserver/geoportal/wms',
  {
    layers: 'SaraBrasil_1930',
    format: 'image/png',
    transparent: true,
    version: '1.3.0',
    opacity: 0.85,
    maxZoom: 19,
    pane: LAYER_PANE('sara1930'),
    attribution: 'SARA Brasil 1930 · GeoSampa / Prefeitura de São Paulo',
  },
);

// MTPI (índice de posição topográfica multiescala) servido em XYZ por
// telhas.pedalhidrografi.co. Tiles nativos só até z10 (Pindorama/COP90 90 m,
// América do Sul) e z12 (Bacia do Paraná 30 m); maxNativeZoom escala acima disso
// em vez de levar 404.
const mtpiPindorama = L.tileLayer('https://telhas.pedalhidrografi.co/mtpi_cop90_sa_full/{z}/{x}/{y}.png', {
  maxZoom: 19,
  maxNativeZoom: 10,
  pane: LAYER_PANE('mtpi-pindorama'),
  attribution: 'MTPI COP90 · Pedal Hidrográfico',
});
const mtpiParana = L.tileLayer('https://telhas.pedalhidrografi.co/mtpi_bacia_parana_30/{z}/{x}/{y}.png', {
  maxZoom: 19,
  maxNativeZoom: 12,
  pane: LAYER_PANE('mtpi-parana'),
  attribution: 'MTPI Bacia do Paraná 30 m · Pedal Hidrográfico',
});

// Mapa histórico georreferenciado de São Paulo (1850), tiles XYZ em
// telhas.pedalhidrografi.co. Tiles nativos até z18; maxNativeZoom escala acima.
const mapa1850 = L.tileLayer('https://telhas.pedalhidrografi.co/1850/{z}/{x}/{y}.png', {
  maxZoom: 19,
  maxNativeZoom: 18,
  opacity: 0.85,
  pane: LAYER_PANE('mapa1850'),
  attribution: 'Mapa de 1850 · Pedal Hidrográfico',
});

// ─── Combined layer panel ────────────────────────────────────────────────────
// A single flat list of layers — each an independent visibility checkbox plus
// an opacity slider. There is deliberately NO "base vs overlay" distinction:
// the basemaps are just two layers like any other (both can be on at once),
// and their stacking — like everyone else's — is controlled by the "Ordem de
// empilhamento" modal.
const baseDefault = settings.mapDefaults.baseLayer === 'satellite' ? 'satellite' : 'osm';
const BASE_LAYERS = [
  { id: 'osm',       label: 'OpenStreetMap', layer: osm,       defaultVisible: baseDefault === 'osm',       defaultPct: 100 },
  { id: 'satellite', label: 'Satélite',      layer: satellite, defaultVisible: baseDefault === 'satellite', defaultPct: 100 },
];
// FeatureGroup das rotas destacadas (botão "Destacar rota" no modal de rota).
// Guarda cópias 1,5× mais grossas das rotas escolhidas; a linha "Rota destacada"
// no painel de camadas (só aparece quando há destaque) tem 🗑 pra limpar.
const routeHighlightGroup = L.featureGroup();
const OVERLAY_LAYERS = [
  {
    id: 'route-highlight',
    label: 'Rota destacada',
    defaultVisible: false,
    defaultPct: 100,
    noOpacity: true,
    layer: routeHighlightGroup,
    trash: true,
    trashAction: () => clearRouteHighlight(),
  },
  { id: 'rmsampa',  label: 'Topografia colorida', layer: rmsampa,  defaultVisible: true,  defaultPct: 85 },
  // Câmera Topográfica: relevo do FABDEM renderizado no cliente (cmocean.phase
  // × declividade), re-renderizado a cada pan/zoom. Botão de engrenagem abre o
  // modal de parâmetros (min/max elevação, declividade máx., γ, estimar).
  {
    id: 'camera-topo',
    label: 'Câmera Topográfica',
    defaultVisible: false,
    defaultPct: settings.cameraTopo.opacityPct,
    gear: true,
    show: () => showCameraTopo(),
    hide: () => hideCameraTopo(),
    setOpacity: (frac) => setCameraTopoOpacity(frac),
    edit: () => openCameraTopoModal(),
  },
  { id: 'sara1930', label: 'SARA 1930',           layer: sara1930, defaultVisible: false, defaultPct: 85 },
  { id: 'mapa1850', label: 'Mapa 1850',           layer: mapa1850, defaultVisible: false, defaultPct: 85 },
  // Positron em multiply: o pane tem mix-blend-mode, então ligada por cima de
  // um raster ela "grava" ruas/rótulos nele (branco = identidade) em vez de
  // cobri-lo. Ver a definição da camada pro racional.
  { id: 'positron', label: 'Positron (OSM × relevo)', layer: positron, defaultVisible: false, defaultPct: 100 },
  { id: 'mtpi-pindorama', label: 'MTPI Pindorama 90m',       layer: mtpiPindorama, defaultVisible: false, defaultPct: 100 },
  { id: 'mtpi-parana',    label: 'MTPI Bacia do Paraná 30m', layer: mtpiParana,    defaultVisible: false, defaultPct: 100 },
  // Pseudo-layer for the loaded sidebar routes. Custom show/hide/setOpacity
  // because routes are a Map of polylines + markers, not a single tileLayer.
  {
    id: 'routes',
    label: 'Rotas cadastradas',
    defaultVisible: true,
    defaultPct: 100,
    show: () => setRoutesGloballyVisible(true),
    hide: () => setRoutesGloballyVisible(false),
    setOpacity: (frac) => applyRoutesOpacity(frac * 100),
  },
  // Hidrografia + cristas do OSM, do FGB por range request. Reconsulta no
  // pan/zoom. O id continua 'osm-overpass' embora o Overpass tenha saído:
  // é a CHAVE da visibilidade/opacidade persistidas em localStorage —
  // renomear órfanaria a preferência de quem já usa a camada.
  {
    id: 'osm-overpass',
    label: 'Morros e Águas',
    defaultVisible: false,
    defaultPct: 100,
    show: () => hidroLayer.show(),
    hide: () => hidroLayer.hide(),
    setOpacity: (frac) => hidroLayer.setOpacity(frac),
  },
  // Cicloinfra do OSM (ciclovias, ciclofaixas, caminhos compartilhados).
  {
    id: 'osm-cicloinfra',
    label: 'Cicloinfra OSM',
    defaultVisible: false,
    defaultPct: 100,
    show: () => cicloinfraLayer.show(),
    hide: () => cicloinfraLayer.hide(),
    setOpacity: (frac) => cicloinfraLayer.setOpacity(frac),
  },
  // Fotos geotaggeadas (lidas do manifesto web/data/data_graphs.ttl, que
  // aponta pra uploads.ttl entre outros dumps). Pequenos círculos que abrem
  // o thumbnail num popup ao clicar.
  {
    id: 'photos',
    label: 'Imagens contribuídas',
    defaultVisible: true,
    defaultPct: 100,
    show: () => showPhotos(),
    hide: () => hidePhotos(),
    setOpacity: (frac) => setPhotosOpacity(frac),
  },
  // Vídeo fantasma — o checkbox espelha `settings.clipsGhost.enabled`
  // (start/stop da reprodução); o slider controla a opacidade visual do
  // <video> sobreposto. Animação (botão da topbar) é o switch global.
  {
    id: 'clips-ghost',
    label: 'Vídeo fantasma',
    defaultVisible: true,
    defaultPct: 70,
    show: () => {
      if (settings.clipsGhost) settings.clipsGhost.enabled = true;
      saveSettings();
      applyClipsGhostSettings();
      setClipsGhostOpacity(clipsGhostUserOpacity);
    },
    hide: () => {
      if (settings.clipsGhost) settings.clipsGhost.enabled = false;
      saveSettings();
      applyClipsGhostSettings();
    },
    setOpacity: (frac) => { clipsGhostUserOpacity = frac; setClipsGhostOpacity(frac); },
  },
  // Pessoas ao vivo — exibe quem está compartilhando localização + a
  // trajetória das últimas 3h. O checkbox espelha `settings.liveLocation.view`
  // (ver pessoas é independente de transmitir a própria posição). Sem slider
  // de opacidade (noOpacity). defaultVisible vem do valor persistido pra que o
  // checkbox reflita a escolha anterior já no boot.
  {
    id: 'live-people',
    label: 'Pessoas ao vivo',
    defaultVisible: settings.liveLocation?.view !== false,
    defaultPct: 70,                       // opacidade inicial dos pontos do rastro (%)
    show: () => setLiveViewEnabled(true),
    hide: () => setLiveViewEnabled(false),
    setOpacity: (frac) => setLiveBandOpacity(frac),
  },
  // Loop de áudio — o checkbox espelha `settings.audioLoop.enabled`; o
  // slider controla o volume máximo das trilhas durante o crossfade.
  {
    id: 'audio-loop',
    label: 'Loop de áudio',
    defaultVisible: false,
    defaultPct: 80,
    show: () => {
      if (settings.audioLoop) settings.audioLoop.enabled = true;
      saveSettings();
      applyAudioLoopSettings();
    },
    hide: () => {
      if (settings.audioLoop) settings.audioLoop.enabled = false;
      saveSettings();
      applyAudioLoopSettings();
    },
    setOpacity: (frac) => setAudioLoopUserVolume(frac),
  },
  // User-defined tile sources. The URL is prompted on demand and persisted
  // in localStorage so the layer is restored on reload.
  {
    id: 'custom-xyz',
    label: 'XYZ custom',
    defaultVisible: false,
    defaultPct: 80,
    editable: true,
    show: () => showCustomXyz(),
    hide: () => hideCustomXyz(),
    setOpacity: (frac) => { if (customXyzLayer) customXyzLayer.setOpacity(frac); },
    edit: () => promptCustomXyzUrl(),
  },
  {
    id: 'custom-wms',
    label: 'WMS custom',
    defaultVisible: false,
    defaultPct: 80,
    editable: true,
    show: () => showCustomWms(),
    hide: () => hideCustomWms(),
    setOpacity: (frac) => { if (customWmsLayer) customWmsLayer.setOpacity(frac); },
    edit: () => promptCustomWmsConfig(),
  },
];

// ─── Camadas OSM servidas por FlatGeobuf ─────────────────────────────────────
// "Morros e Águas" e "Cicloinfra OSM" consultavam o Overpass a cada pan/zoom.
// Agora saem dos mesmos FGBs hospedados junto do viário e dos DEMs: o índice
// espacial (packed Hilbert R-tree) deixa o navegador buscar SÓ OS BYTES da
// bbox visível por HTTP Range — sem servidor de consulta no caminho, então
// sem rate limit do OSM, sem timeout de 60 s e com o disco do navegador
// cacheando as faixas já baixadas.
//
// Assados por `scripts/build-viario.py --layers`, semanalmente pelo workflow
// .github/workflows/build-fgb.yml. COBERTURA: AMÉRICA DO SUL — o mesmo extrato
// Geofabrik que o resto do pipeline já usa. Fora dela as camadas ficam vazias
// (com o Overpass funcionavam no mundo inteiro; ver o changelog da Ajuda).
const HIDRO_FGB_URL      = 'https://telhas.pedalhidrografi.co/viario/south-america-hidro.fgb';
const CICLOINFRA_FGB_URL = 'https://telhas.pedalhidrografi.co/viario/south-america-cicloinfra.fgb';
const PH_NETWORK_URL     = 'https://telhas.pedalhidrografi.co/viario/ph-cycle-network.geojson';

// O Overpass exigia zoom ≥ 13 porque cada consulta pesava num servidor
// compartilhado — esse motivo MORREU com o FGB. O que sobra é custo do lado do
// cliente, e ele não escala com o zoom: escala com a ÁREA DA BBOX (uma tela de
// notebook em zoom 11 pede muito mais bytes que um celular no mesmo zoom).
// Então o limite é por área, não por nível de zoom.
//
// Ordem de grandeza medida no extrato do Uruguai (28.577 linhas de água em
// 176.000 km² → ~0,2 kB/km²); em área urbana bem mapeada dá pra contar com
// 1–5 kB/km². Daí:
//   até ~1.200 km²  (≈ zoom 12 num notebook)  → tudo
//   até ~8.000 km²  (≈ zoom 10)               → só o principal (ver DETAIL_MAIN)
//   acima disso                                → não consulta: seriam dezenas
//                                                de MB pra desenhar um borrão
const OSM_FGB_MAX_BBOX_KM2  = 8000;
const OSM_FGB_FULL_BBOX_KM2 = 1200;
// Teto de feições desenhadas por camada — a rede de proteção final, caso a
// densidade local desminta a estimativa acima.
const OSM_FGB_MAX_FEATURES = 20000;

// Nível de detalhe derivado da área: em bbox grande desenha só o que ainda
// significa alguma coisa naquela escala (rios e cristas; ciclovias
// segregadas), em vez de recusar a camada ou travar a aba.
const DETAIL_FULL = 'full';
const DETAIL_MAIN = 'main';

// Área aproximada da bbox em km² (equiretangular, com o cosseno da latitude
// média — a mesma aproximação do resto do app).
function bboxAreaKm2(bb) {
  const midLat = (bb.south + bb.north) / 2;
  const kmPerDeg = 111.32;
  const h = (bb.north - bb.south) * kmPerDeg;
  const w = (bb.east - bb.west) * kmPerDeg * Math.cos(midLat * Math.PI / 180);
  return Math.abs(h * w);
}

// A rede cicloviária do coletivo (relations cycle_network=BR:PedalHidrografico)
// vem num GeoJSON minúsculo, baixado UMA vez e reusado — são poucas e locais,
// não valem um range request por pan. Falha não derruba a camada: a hidrografia
// desenha do mesmo jeito.
let _phNetworkPromise = null;
async function loadPhCycleNetwork() {
  if (!_phNetworkPromise) {
    _phNetworkPromise = fetch(PH_NETWORK_URL)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((fc) => fc.features || []);
    // Erro não fica grudado: solta a promise pra próxima tentativa refazer.
    _phNetworkPromise.catch(() => { _phNetworkPromise = null; });
  }
  return _phNetworkPromise;
}

// Driver compartilhado das duas camadas. Cada `source` sabe buscar suas feições
// na bbox e como estilizar/rotular — é só isso que distingue Morros e Águas de
// Cicloinfra. A ordem das sources é a ordem de desenho (a última fica por cima).
function makeOsmFgbLayer({ id, label, sources }) {
  const drawn = [];
  let active = false, opacity = 1, debounce = null, seq = 0;

  function clear() {
    for (const l of drawn) map.removeLayer(l);
    drawn.length = 0;
  }

  function render(perSource, detail) {
    clear();
    const pane = LAYER_PANE(id);
    let capped = false;
    for (let s = 0; s < sources.length; s++) {
      const { styleFor, tipFor, alwaysDraw } = sources[s];
      // Teto batido: para de desenhar as fontes volumosas, mas SEGUE nas
      // isentas (`continue`, não `break` — sair do laço aqui puliria a rede do
      // coletivo, que é justamente a última source e a que não pode sumir).
      if (capped && !alwaysDraw) continue;
      for (const f of perSource[s] || []) {
        const g = f && f.geometry; if (!g) continue;
        const props = f.properties || {};
        // styleFor devolve null pro que não vale a pena nesta escala.
        const style = styleFor(props, detail);
        if (!style) continue;
        const parts = g.type === 'LineString' ? [g.coordinates]
          : g.type === 'MultiLineString' ? g.coordinates : [];
        for (const coords of parts) {
          if (!Array.isArray(coords) || coords.length < 2) continue;
          // `alwaysDraw` isenta as fontes minúsculas e importantes do teto — a
          // rede do coletivo é a ÚLTIMA source (pra ficar por cima), então sem
          // isto ela sumiria justo onde a hidrografia é densa o bastante pra
          // estourar o limite.
          if (!alwaysDraw && drawn.length >= OSM_FGB_MAX_FEATURES) { capped = true; break; }
          // O FGB guarda [lng,lat]; o Leaflet quer [lat,lng].
          const layer = L.polyline(coords.map((c) => [c[1], c[0]]),
            { ...style, opacity, pane });
          const tip = tipFor(props);
          if (tip) layer.bindTooltip(tip, { sticky: true, className: 'osm-tip' });
          layer.addTo(map);
          drawn.push(layer);
        }
        if (capped && !alwaysDraw) break;
      }
    }
    return capped;
  }

  async function refresh() {
    if (!active) return;
    const b = map.getBounds();
    const bb = {
      west: b.getWest(), south: b.getSouth(),
      east: b.getEast(), north: b.getNorth(),
    };
    const areaKm2 = bboxAreaKm2(bb);
    if (areaKm2 > OSM_FGB_MAX_BBOX_KM2) {
      clear();
      showToast(`Área grande demais para carregar ${label} — aproxime o mapa`);
      return;
    }
    const detail = areaKm2 > OSM_FGB_FULL_BBOX_KM2 ? DETAIL_MAIN : DETAIL_FULL;
    const mySeq = ++seq;
    showToast(`Buscando ${label}…`, 1500);
    try {
      // Uma source que falha vira lista vazia — a camada desenha o que veio.
      // `failed` separa "não tem nada aqui" de "não consegui buscar": são
      // conselhos opostos (aproximar vs tentar de novo), e sem isso um 404 no
      // FGB aparecia pro usuário como área vazia.
      let failed = 0;
      const perSource = await Promise.all(sources.map((s) => s.load(bb).catch((e) => {
        failed++;
        console.warn(`[${id}] fonte indisponível:`, e.message);
        return [];
      })));
      if (mySeq !== seq || !active) return;   // um pan mais novo já saiu na frente
      const total = perSource.reduce((n, fs) => n + fs.length, 0);
      if (!total) {
        clear();
        showToast(failed === sources.length
          ? `${label}: fonte indisponível`
          : `${label}: nada nesta área`, 1800);
        return;
      }
      const capped = render(perSource, detail);
      // `failed` PRECISA aparecer também no caminho de sucesso. A rede do
      // coletivo não é filtrada por bbox e fica memoizada, então ela sozinha
      // mantém `total > 0` mesmo com o FGB da hidrografia fora do ar — sem
      // isto, o mapa mostrava só as linhas azuis sob um toast triunfante e o
      // usuário concluía que a área não tem água mapeada.
      const notes = [];
      if (failed) notes.push('parte das fontes indisponível');
      if (capped) notes.push('aproxime para ver o resto');
      else if (detail === DETAIL_MAIN) notes.push('só o principal — aproxime para o resto');
      showToast(`${label}: ${drawn.length} feições`
        + (notes.length ? ` (${notes.join('; ')})` : ''), 1800);
    } catch (err) {
      if (mySeq !== seq) return;
      console.warn(`[${id}] falhou:`, err);
      showToast(`Falha em ${label}: ${err.message}`);
    }
  }

  function onMoveEnd() {
    clearTimeout(debounce);
    debounce = setTimeout(refresh, 700);
  }

  return {
    show() { active = true; map.on('moveend', onMoveEnd); refresh(); },
    hide() {
      active = false;
      map.off('moveend', onMoveEnd);
      clearTimeout(debounce);
      clear();
    },
    setOpacity(frac) {
      opacity = frac;
      for (const l of drawn) l.setStyle({ opacity: frac });
    },
  };
}

// Estilo da "Morros e Águas" — espelha a folha de estilo JOSM homônima:
//   waterway=river                verde  #A6C045 w5  (tracejado se em túnel)
//   waterway=stream/canal/vala/…  ocre   #DDB84F w3  (tracejado se em túnel)
//   natural=ridge                 laranja #EF7A30 w3
// Numa bbox grande (DETAIL_MAIN) só rio, canal e crista sobrevivem: vala,
// dreno e córrego viram renda ilegível nessa escala e respondem pela maior
// parte das feições (no extrato do Uruguai, 8.365 de 28.577 linhas eram
// ditch/drain). Filtrar aqui é o que deixa a camada abrir sem trava.
function hidroStyleFor(p, detail) {
  // `tunnel=culvert` (córrego canalizado) e `tunnel=yes` tracejam; `no` não.
  // Com o Overpass bastava a chave existir — `tunnel=no` tracejava à toa.
  const tunnel = !!p.tunnel && p.tunnel !== 'no';
  if (p.natural === 'ridge') return { color: '#EF7A30', weight: 3 };
  if (p.waterway === 'river') {
    return { color: '#A6C045', weight: 5, dashArray: tunnel ? '4 6' : null };
  }
  const main = p.waterway === 'canal' || p.waterway === 'riverbank';
  if (detail === DETAIL_MAIN && !main) return null;
  if (p.waterway) {
    return { color: '#DDB84F', weight: 3, dashArray: tunnel ? '4 4' : null };
  }
  return detail === DETAIL_MAIN ? null : { color: '#888', weight: 2 };
}

function hidroTipFor(p) {
  const parts = [];
  if (p.name) parts.push(`<strong>${escapeHtml(p.name)}</strong>`);
  const kind = p.waterway || p.natural || '';
  if (kind) parts.push(`<em>${escapeHtml(kind)}</em>`);
  if (p.tunnel && p.tunnel !== 'no') parts.push('(túnel)');
  return parts.join(' · ') || 'OSM';
}

// Rede do coletivo: azul de destaque, grossa, por cima da hidrografia.
function phNetworkTipFor(p) {
  const parts = [`<strong>${escapeHtml(p.name || 'Pedal Hidrográfico')}</strong>`];
  if (p.ref) parts.push(`<em>ref ${escapeHtml(p.ref)}</em>`);
  return parts.join(' · ');
}

const hidroLayer = makeOsmFgbLayer({
  id: 'osm-overpass',            // id histórico — ver OVERLAY_LAYERS
  label: 'hidrografia OSM',
  sources: [
    {
      // `false` = fora do LRU do viário: a camada reconsulta a cada pan e
      // encheria o cache (10 slots) com viewports inteiras de feições.
      load: (bb) => streamFgbFeatures(HIDRO_FGB_URL, bb, false),
      styleFor: hidroStyleFor,
      tipFor: hidroTipFor,
    },
    {
      // Sem bbox: são poucas relations e a viewport já recorta no desenho —
      // mesmo comportamento da consulta Overpass antiga.
      load: () => loadPhCycleNetwork(),
      styleFor: () => ({ color: '#2da9ff', weight: 5 }),
      tipFor: phNetworkTipFor,
      alwaysDraw: true,   // são dezenas de linhas, e é a camada-assinatura
    },
  ],
});

// Estacionada aqui junto da irmã, e NÃO lá embaixo na seção de cicloinfra: o
// painel de camadas pode restaurar a visibilidade persistida antes daquele
// ponto do arquivo, e um `const` em TDZ viraria ReferenceError no boot.
// As funções de estilo/rótulo seguem lá (declarações `function`, içadas).
const cicloinfraLayer = makeOsmFgbLayer({
  id: 'osm-cicloinfra',
  label: 'cicloinfra OSM',
  sources: [{
    load: (bb) => streamFgbFeatures(CICLOINFRA_FGB_URL, bb, false),
    styleFor: styleForCycloinfra,
    tipFor: cicloinfraTipFor,
  }],
});

// ─── Fotos geotaggeadas (manifesto → dumps em web/data/*.ttl) ─────────────
// Cada foto com GPS vira um pequeno círculo no mapa; clicar abre um popup
// com o thumbnail. O acervo é descrito em RDF/Turtle conforme
// `data/shapes.ttl` (ph:ImageShape). O app lê `data/data_graphs.ttl` (um
// void:Dataset) pra descobrir quais dumps carregar — atualmente
// `uploads.ttl` (imagens) e `tours.ttl` (passeios). N3.js parseia tudo
// no browser; a fonte pode ser o servidor (mesma origem) ou um kit local (.zip).
const PHOTOS_DIR_REL    = 'photos/';                       // <phash>/{original,large,thumb}.jpg
const TOURS_TTL_REL     = 'data/tours.ttl';                // catálogo de passeios (opcional)

// Origem persistida em localStorage: 'server' | 'local'.
// Default 'server' (mesma origem — o backend serve/redireciona as fotos).
// 'local' usa um kit .zip/.ttl importado. O usuário troca via 🗂 Fonte….
let photoSource = settings.photoSource;
// Quando local: kit ZIP descompactado em memória, com blob URLs por arquivo.
let localKit = null;   // { ttlText, files: Map<path,blob URL> }

let photoMarkers   = [];
// Declarado cedo (não na seção de clipes) porque relaxPhotoMarkers o lê,
// e essa função pode rodar via applyPhotoAnim/zoomend antes da seção de
// clipes inicializar — let na TDZ jogava ReferenceError.
let clipsMarkers   = [];
let photosLoaded   = false;
let photosLoading  = null;
// Mesmo padrão do `seq` das camadas OSM por FGB: cada carga captura o
// contador no início e abandona o resultado se outro reload começou depois —
// senão uma carga lenta em voo sobrescreveria dados mais novos ao terminar.
let photosFetchSeq = 0;
let photosVisible  = false;
let photosOpacity  = 1;
// Quando setado ({date, label}), só as fotos daquele pedal ficam visíveis.
let photoRideFilter = null;
// Janela de data herdada do filtro da sidebar — {from, to} em ms, ou null.
// Quando setada, fotos cujo datetime cai fora da janela ficam ocultas.
let photoDateWindow = null;
// Filtro por listas (álbuns) / SPARQL das mídias visíveis no mapa. Persiste em
// localStorage. Default: só as mídias da lista "Padrão". Modos:
//   'all'    → todas as mídias (escape "Todas")
//   'picker' → união das listas marcadas (mediaFilter.lists)
//   'sparql' → resultado de uma consulta SPARQL (mediaFilterResultSet)
// Literal inline (LST_NS é declarado bem mais abaixo — usar aqui cairia na TDZ
// do const, já que este bloco roda na inicialização do módulo).
const PADRAO_LIST_IRI = 'https://id.pedalhidrografi.co/listas/padrao';
let mediaFilter = loadMediaFilter();
let mediaFilterResultSet = null;   // Set<iri> quando mode==='sparql'
function loadMediaFilter() {
  try {
    const raw = JSON.parse(localStorage.getItem('phidro:mediaFilter') || 'null');
    if (raw && raw.mode) {
      return { mode: raw.mode, lists: new Set(raw.lists || [PADRAO_LIST_IRI]),
               query: raw.query || '' };
    }
  } catch (e) { /* ignore */ }
  return { mode: 'picker', lists: new Set([PADRAO_LIST_IRI]), query: '' };
}
function saveMediaFilter() {
  try {
    localStorage.setItem('phidro:mediaFilter', JSON.stringify({
      mode: mediaFilter.mode, lists: [...mediaFilter.lists], query: mediaFilter.query || '',
    }));
  } catch (e) { /* ignore */ }
}
// Alguma lista selecionada existe de fato no catálogo? (Pré-migração a lista
// Padrão ainda não existe — nesse caso o picker se comporta como "Todas" pra
// não deixar o mapa vazio.)
function pickerHasKnownList() {
  for (const l of (mediaFilter.lists || [])) if (listCatalog.has(l)) return true;
  return false;
}
// O filtro é o "padrão" (não-customizado) quando: mostra Todas, OU é o picker
// só com a lista Padrão, OU o picker aponta pra listas inexistentes (→ mostra
// tudo). Nesses casos o botão de funil NÃO acende de azul-ciano.
function mediaFilterIsDefault() {
  if (mediaFilter.mode === 'all') return true;
  if (mediaFilter.mode === 'sparql') return false;
  if (!pickerHasKnownList()) return true;
  const ls = mediaFilter.lists;
  return ls.size === 1 && ls.has(PADRAO_LIST_IRI);
}
function mediaMatchesFilter(iri, lists) {
  if (mediaFilter.mode === 'all') return true;
  if (mediaFilter.mode === 'sparql') {
    return mediaFilterResultSet ? mediaFilterResultSet.has(iri) : true;
  }
  // picker
  if (!mediaFilter.lists || mediaFilter.lists.size === 0) return true;
  if (!pickerHasKnownList()) return true;   // listas inexistentes → todas
  for (const l of (lists || [])) if (mediaFilter.lists.has(l)) return true;
  return false;
}
// Conteúdo bruto da última .ttl carregada (para o "Baixar .ttl").
let lastTtlText  = '';
let lastTtlOrigin = '';   // URL / nome de arquivo de origem (para debug + status)
// Catálogos derivados do TTL: tours[iri]={title,date}, persons[iri]={name},
// lists[iri]={name} (álbuns schema:Collection).
let tourCatalog   = new Map();
let personCatalog = new Map();
let listCatalog   = new Map();
// Store N3 em memória (fotos+clipes+tours) pro filtro SPARQL avançado do mapa;
// (re)construído em buildPhotoMarkers a partir dos quads já parseados.
let mediaStore    = null;

// Delegação de clique nos popups de foto: link no Passeio abre o modal da
// rota correspondente (mesma janela que a barra lateral usa).
document.addEventListener('click', (ev) => {
  const a = ev.target.closest?.('.photo-popup a.ride-link[data-route-id]');
  if (a) {
    ev.preventDefault();
    const id = a.getAttribute('data-route-id');
    if (id && typeof openRouteModal === 'function') openRouteModal(id);
    return;
  }
  // Botão "📁 Listas" no popup: abre o editor de listas da mídia.
  const le = ev.target.closest?.('.photo-popup button.media-lists-edit[data-hash]');
  if (le) {
    ev.preventDefault();
    const kind = le.getAttribute('data-kind');
    const hash = le.getAttribute('data-hash');
    let cur = [];
    if (kind === 'image') {
      cur = photoMarkers.find((m) => m._photo && m._photo.phash === hash)?._photo.lists || [];
    } else {
      const e = clipsMarkers.find((x) => x && x.clip && x.clip.vhash === hash);
      cur = e ? (e.clip.lists || []) : [];
    }
    openMediaListsEditor(kind, hash, cur);
    return;
  }
  // Botão "✎ Editar" no popup: abre upload_images.html?edit=<iri> no modal.
  const me = ev.target.closest?.('.photo-popup button.media-edit[data-hash]');
  if (me) {
    ev.preventDefault();
    const kind = me.getAttribute('data-kind');
    const hash = me.getAttribute('data-hash');
    const iri = MED_NS + hash;   // IRI opaco (tipo é a classe, não o prefixo)
    const ifr = document.getElementById('upload-iframe');
    if (ifr) ifr.src = './upload_images.html?edit=' + encodeURIComponent(iri);
    if (typeof openUploadModal === 'function') openUploadModal();
    return;
  }
  // Botão "🔍 Ver grande" no popup: fecha o popup e abre a MESMA mídia na
  // galeria (que já é maximizável e mostra a foto/vídeo bem maior, com
  // painel de metadados) — em vez de tentar caber o popup do Leaflet na
  // tela inteira.
  const vf = ev.target.closest?.('.photo-popup button.media-view-full[data-hash]');
  if (vf) {
    ev.preventDefault();
    closePhotoPreview();
    openImagensModalToMedia(vf.getAttribute('data-hash'));
    return;
  }
  // Botão "🔗 Compartilhar" no popup: copia o link direto (abre a galeria já
  // filtrada nesta mídia pra quem receber).
  const sh = ev.target.closest?.('.photo-popup button.media-share[data-hash]');
  if (sh) {
    ev.preventDefault();
    shareLink(
      `https://amora.pedalhidrografi.co/imagens.html?pick=${encodeURIComponent(sh.getAttribute('data-hash'))}`,
      'Link da mídia',
    );
    return;
  }
  // Botão "Excluir" no popup: chama o backend e recarrega a camada.
  const del = ev.target.closest?.('.photo-popup button.photo-del[data-phash]');
  if (del) {
    ev.preventDefault();
    const phash = del.getAttribute('data-phash');
    if (!phash) return;
    if (!confirm('Excluir esta imagem? Remove arquivos + triples no servidor.')) return;
    del.disabled = true; del.textContent = 'Excluindo…';
    fetch(`./delete-image/${encodeURIComponent(phash)}`, { method: 'POST' })
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.text().catch(() => '');
          throw new Error(`HTTP ${r.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
        }
        showToast('Imagem excluída.');
        closePhotoPreview();
        reloadPhotos();
      })
      .catch((err) => {
        del.disabled = false; del.textContent = 'Excluir ✕';
        alert(`Falha ao excluir: ${err.message}`);
      });
    return;
  }
  // Botão "Excluir" no popup de vídeo: POST /delete-video/<vhash>.
  const delV = ev.target.closest?.('.photo-popup button.video-del[data-vhash]');
  if (delV) {
    ev.preventDefault();
    const vhash = delV.getAttribute('data-vhash');
    if (!vhash) return;
    if (!confirm('Excluir este vídeo? Remove arquivos webm/mp4/audio/thumb + triples no servidor.')) return;
    delV.disabled = true; delV.textContent = 'Excluindo…';
    fetch(`./delete-video/${encodeURIComponent(vhash)}`, { method: 'POST' })
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.text().catch(() => '');
          throw new Error(`HTTP ${r.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
        }
        showToast('Vídeo excluído.');
        closePhotoPreview();
        // Recarrega o catálogo de clipes do zero pra refletir.
        clipsCatalog = null;
        loadClipsCatalog().then((clips) => makeClipMarkers(clips));
      })
      .catch((err) => {
        delV.disabled = false; delV.textContent = 'Excluir ✕';
        alert(`Falha ao excluir: ${err.message}`);
      });
  }
});

// Marcadores de foto de um pedal específico (data ISO AAAA-MM-DD).
function ridePhotos(date) {
  return photoMarkers.filter(
    (m) => m._photo.ride && m._photo.ride.date === date,
  );
}

// Clipes do mesmo passeio — match por:
//  (a) tourIri direto se o TTL declara ph:capturedDuring (uploads via form), OU
//  (b) fallback: dcterms:date do clipe igual à data do passeio (clipes
//      importados de raw/ via build-clips.py não têm ph:capturedDuring).
function rideClips(date, tourIri) {
  if (!clipsMarkers.length) return [];
  return clipsMarkers.filter(({ clip }) => {
    if (tourIri && clip.tourIri === tourIri) return true;
    return Boolean(clip.date && clip.date === date);
  });
}

// ── Marcador de foto: círculo, ou cone de visada quando há bússola ───────
const CARDINALS = ['N', 'NE', 'L', 'SE', 'S', 'SO', 'O', 'NO'];
function cardinal(deg) {
  return CARDINALS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

// Caminho SVG de um setor (cone) com vértice em (cx,cy), abrindo `fov` graus
// em torno do rumo `bearing` (0 = norte = para cima).
function conePath(cx, cy, r, bearing, fov) {
  const a1 = ((bearing - fov / 2) * Math.PI) / 180;
  const a2 = ((bearing + fov / 2) * Math.PI) / 180;
  const x1 = (cx + r * Math.sin(a1)).toFixed(1);
  const y1 = (cy - r * Math.cos(a1)).toFixed(1);
  const x2 = (cx + r * Math.sin(a2)).toFixed(1);
  const y2 = (cy - r * Math.cos(a2)).toFixed(1);
  const largeArc = fov > 180 ? 1 : 0;
  return `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${largeArc} 1 ${x2},${y2} Z`;
}

// Deriva rumo + campo de visão dos metadados EXIF (saída do exifr).
function cameraFromExif(meta) {
  let bearing = null;
  let fov = null;
  const dir = meta && meta.GPSImgDirection;
  if (Number.isFinite(dir)) bearing = ((dir % 360) + 360) % 360;
  const f35 = meta && meta.FocalLengthIn35mmFilm;
  if (Number.isFinite(f35) && f35 > 0) {
    const portrait = [5, 6, 7, 8].includes(meta.Orientation);
    const frame = portrait ? 24 : 36;
    fov = (2 * Math.atan(frame / (2 * f35)) * 180) / Math.PI;
  }
  return { bearing, fov };
}

// divIcon da foto. Com bússola → cone translúcido + thumbnail no vértice;
// sem bússola → o círculo simples.
function photoDivIcon(thumbUrl, bearing, fov, extraClass, largeUrl) {
  const dotClass = 'photo-dot' + (extraClass ? ' ' + extraClass : '');
  // image-set: navegadores em telas HiDPI (devicePixelRatio >= 2) pegam o
  // large (~2400px) em vez do thumb (~256px), eliminando o borrão de
  // upscaling durante a animação (peak ~150px CSS = 300 device-pixels em 2x).
  // Em telas 1x a banda fica preservada (só thumb baixa).
  // escapeHtml: url1x/url2x acabam derivados de RDF (phash de subject IRI,
  // ou schema:thumbnail em dados legado/editados à mão) — evita quebrar o
  // atributo `style="…"` se algum caractere de aspas colar no valor.
  const url1x = escapeHtml(thumbUrl);
  const url2x = escapeHtml(largeUrl || thumbUrl);
  // Ordem: fallback primeiro, image-set depois — navegadores aceitam o
  // último declaração válida; quem não entende image-set fica com url() simples.
  const bg =
    `background-image: url('${url1x}'); ` +
    `background-image: -webkit-image-set(url('${url1x}') 1x, url('${url2x}') 2x); ` +
    `background-image: image-set(url('${url1x}') 1x, url('${url2x}') 2x);`;
  const dot = `<div class="${dotClass}" style="${bg}"></div>`;
  // Cone só aparece quando: EXIF traz `bearing` E o usuário não desligou
  // em Ajustes. Sem cone, cai pro ícone redondo padrão.
  const wantCone = Number.isFinite(bearing) && settings.fovCone?.enabled !== false;
  if (!wantCone) {
    return L.divIcon({
      className: 'photo-dot-wrap',
      html: dot,
      iconSize: [40, 40],
      iconAnchor: [20, 20],
      popupAnchor: [0, -20],
    });
  }
  const SZ = 120;
  const C = SZ / 2;
  const f = Number.isFinite(fov) ? Math.max(10, Math.min(170, fov)) : 70;
  const scale = Number.isFinite(settings.fovCone?.sizeScale)
    ? Math.max(0.25, Math.min(2, settings.fovCone.sizeScale)) : 1;
  const r = 38 * scale;
  return L.divIcon({
    className: 'photo-dot-wrap',
    html:
      `<div class="photo-aim" style="width:${SZ}px;height:${SZ}px">` +
      `<svg width="${SZ}" height="${SZ}" viewBox="0 0 ${SZ} ${SZ}">` +
      `<path d="${conePath(C, C, r, bearing, f)}" class="photo-cone"/>` +
      `</svg>${dot}</div>`,
    iconSize: [SZ, SZ],
    iconAnchor: [C, C],
    popupAnchor: [0, -C],
  });
}

// Encolhe os círculos/cones de foto fora do zoom 16+ via custom property
// CSS (--photo-scale). 2/3 a cada tick a partir do 15.
function updatePhotoScale() {
  const reductions = Math.max(0, 12 - map.getZoom());
  const scale = Math.pow(2 / 3, reductions);
  document.body.style.setProperty('--photo-scale', scale.toFixed(3));
}

// Encolhe + nudge por densidade local: marcadores em vizinhanças com muitas
// fotos ficam menores (1/sqrt(1+n), piso 0.4) e se afastam uns dos outros
// (deslocamento em px, capado em ~1 raio do dot). Custom properties por ícone:
//   --photo-density-scale  multiplica --photo-scale
//   --photo-dx / --photo-dy  translação CSS sem mexer no LatLng real
const PHOTO_BASE_RADIUS = 20;   // metade do diâmetro nominal do .photo-dot (40px)
const PHOTO_RELAX_ITERS = 8;

// Piso da escala por densidade dependente do zoom — todos os parâmetros
// vêm de settings.markerLayout (configuráveis no modal de Configurações).
function photoMinScaleForZoom(z) {
  const { minScaleFloor, minScaleCeil, rampStart, rampEnd } = settings.markerLayout;
  const span = Math.max(0.0001, rampEnd - rampStart);
  const t = (z - rampStart) / span;
  const ramp = minScaleFloor + (minScaleCeil - minScaleFloor) * t;
  return Math.max(minScaleFloor, Math.min(minScaleCeil, ramp));
}

function relaxPhotoMarkers() {
  const zoomScale = parseFloat(
    document.body.style.getPropertyValue('--photo-scale')) || 1;
  const bounds = map.getBounds();
  const items = [];
  // Combina fotos + clipes na mesma relaxação: vídeos clusterizam com
  // imagens (encolhem + se afastam por densidade local). NÃO ganham
  // `_spotIntensity`, então o boost da animação não os afeta.
  const allMarkers = [];
  for (const m of photoMarkers) allMarkers.push(m);
  for (const e of clipsMarkers) { if (e) allMarkers.push(e.marker); }
  for (const m of allMarkers) {
    if (!m._icon) continue;                     // ainda não adicionado ao mapa
    if (!bounds.contains(m.getLatLng())) {
      // Limpa override em quem caiu da viewport, evita herdar valor stale.
      m._icon.style.removeProperty('--photo-density-scale');
      m._icon.style.removeProperty('--photo-dx');
      m._icon.style.removeProperty('--photo-dy');
      continue;
    }
    const pt = map.latLngToContainerPoint(m.getLatLng());
    items.push({ marker: m, x: pt.x, y: pt.y, dx: 0, dy: 0, scale: 1 });
  }

  const baseR = PHOTO_BASE_RADIUS * zoomScale;
  const neighborWindow2 = (2 * baseR) ** 2;
  const minScale = photoMinScaleForZoom(map.getZoom());

  // 1) escala por densidade local
  for (const a of items) {
    let n = 0;
    for (const b of items) {
      if (a === b) continue;
      const dx = a.x - b.x, dy = a.y - b.y;
      if (dx * dx + dy * dy < neighborWindow2) n++;
    }
    a.scale = Math.max(minScale, 1 / Math.sqrt(1 + n));
    // 1.1) spotlight contínuo: intensidade por marcador (0..1, atualizada
    // pelo loop em photoSpotlightTick) modula um boost no scale. Raio
    // efetivo cresce junto, então a relaxação empurra vizinhos suavemente.
    const intensity = a.marker._spotIntensity || 0;
    a.scale *= 1 + (settings.spotlight.boost - 1) * intensity;
  }

  // 1.5) pré-dispersão de fotos exatamente co-localizadas (mesmo GPS).
  // Sem isto, dist=0 entre pares "duplicados" zera a força de repulsão e elas
  // ficam empilhadas — só a de cima recebe clique, as de baixo ficam inacessíveis.
  const groups = new Map();
  for (const item of items) {
    const key = Math.round(item.x) + ',' + Math.round(item.y);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (let k = 0; k < group.length; k++) {
      const angle = (k / group.length) * Math.PI * 2;
      group[k].dx = Math.cos(angle) * baseR;
      group[k].dy = Math.sin(angle) * baseR;
    }
  }

  // 2) relaxação iterativa: empurra pares que ainda colidem; cap maior para
  //    grupos co-localizados (até 2 raios) para deixar espaço para espalhar.
  const maxJitter = baseR * 2;
  for (let iter = 0; iter < PHOTO_RELAX_ITERS; iter++) {
    let moved = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        const ra = baseR * a.scale, rb = baseR * b.scale;
        const minDist = ra + rb;
        const dx = (b.x + b.dx) - (a.x + a.dx);
        const dy = (b.y + b.dy) - (a.y + a.dy);
        const dist = Math.hypot(dx, dy);
        if (dist < minDist && dist > 1e-3) {
          const push = (minDist - dist) / 2;
          const nx = dx / dist, ny = dy / dist;
          a.dx -= nx * push; a.dy -= ny * push;
          b.dx += nx * push; b.dy += ny * push;
          a.dx = Math.max(-maxJitter, Math.min(maxJitter, a.dx));
          a.dy = Math.max(-maxJitter, Math.min(maxJitter, a.dy));
          b.dx = Math.max(-maxJitter, Math.min(maxJitter, b.dx));
          b.dy = Math.max(-maxJitter, Math.min(maxJitter, b.dy));
          moved = true;
        }
      }
    }
    if (!moved) break;
  }

  // 3) commit nas custom properties do ícone
  for (const a of items) {
    const el = a.marker._icon;
    el.style.setProperty('--photo-density-scale', a.scale.toFixed(3));
    el.style.setProperty('--photo-dx', a.dx.toFixed(1) + 'px');
    el.style.setProperty('--photo-dy', a.dy.toFixed(1) + 'px');
  }
}

function refreshPhotoLayout() {
  updatePhotoScale();
  relaxPhotoMarkers();
}
map.on('zoomend moveend', refreshPhotoLayout);
updatePhotoScale();

// ── Spotlight contínuo ───────────────────────────────────────────────────
// Cada marcador tem uma fase φ ∈ [0,1) constante; ao longo do tempo, sua
// intensidade segue um pulso gaussiano periódico. As fases são distribuídas
// aleatoriamente, então em qualquer instante alguns marcadores estão perto
// do pico (boost ~ settings.spotlight.boost) e outros em repouso. O loop atualiza
// _spotIntensity e re-chama relaxPhotoMarkers, que ajusta tamanhos e nudges
// — as transições CSS suavizam tudo. Pausa durante pan pra não brigar com
// o gesto.
// Todos os tunables vivem em settings.spotlight (modal de Configurações).

let photoSpotlightPaused = false;
map.on('movestart', () => { photoSpotlightPaused = true; });
map.on('moveend',   () => { photoSpotlightPaused = false; });

function photoSpotlightTick() {
  if (photoSpotlightPaused) return;
  const bounds = map.getBounds();
  const visible = [];
  for (const m of photoMarkers) {
    if (!m._icon) continue;
    if (!bounds.contains(m.getLatLng())) {
      m._spotIntensity = 0;
      continue;
    }
    // Atribui fase preguiçosa na primeira visita.
    if (m._spotPhase === undefined) m._spotPhase = Math.random();
    visible.push(m);
  }
  if (visible.length === 0) return;

  const sp = settings.spotlight;
  // Período derivado: cada pico dura ≈peakSec, e queremos ~peakCount ativos.
  const period = Math.max(
    sp.peakSec,
    visible.length * sp.peakSec / Math.max(0.001, sp.peakCount));
  const peakFrac = Math.min(0.5, sp.peakSec / period);
  const halfWidth = peakFrac / 2;

  const t = performance.now() / 1000 / period;
  for (const m of visible) {
    const x = ((t + m._spotPhase) % 1 + 1) % 1;     // posição na onda [0,1)
    const d = Math.min(x, 1 - x);                    // distância circular ao pico
    const main = Math.exp(-Math.pow(d / halfWidth, sp.pulseShape));
    const xEcho = ((x - sp.echoOffset) % 1 + 1) % 1;
    const dEcho = Math.min(xEcho, 1 - xEcho);
    const echo = sp.echoAmp *
      Math.exp(-Math.pow(dEcho / halfWidth, sp.pulseShape));
    m._spotIntensity = Math.max(main, echo);
  }
  relaxPhotoMarkers();
}

// Toggle persistente no topbar ✨ + interruptor pro modal de Configurações.
// Quando desliga: para o timer, zera intensidades e re-relaxa pra que os
// marcadores voltem ao tamanho/posição que a relaxação por densidade definiria.
let photoSpotlightTimer = null;

function applyPhotoAnim() {
  if (settings.spotlight.enabled) {
    if (!photoSpotlightTimer) {
      photoSpotlightTimer = setInterval(photoSpotlightTick, settings.spotlight.tickMs);
    }
  } else {
    if (photoSpotlightTimer) {
      clearInterval(photoSpotlightTimer);
      photoSpotlightTimer = null;
    }
    for (const m of photoMarkers) m._spotIntensity = 0;
    relaxPhotoMarkers();
  }
  // Mantém os ícones ✨ (linhas "Imagens contribuídas" / "Vídeo fantasma" do
  // painel de camadas) em sincronia.
  for (const b of document.querySelectorAll('.layer-anim-toggle')) {
    b.setAttribute('aria-pressed', String(settings.spotlight.enabled));
  }
}

// Animação liga/desliga TUDO: o spotlight (animação dos marcadores) e o ghost
// video (clipes em loop como pano de fundo translúcido sobre o mapa). Acionada
// pelos ícones ✨ no painel de camadas (ver makeRow).
async function toggleAnimation() {
  const enabling = !settings.spotlight.enabled;
  settings.spotlight.enabled = enabling;
  saveSettings();
  applyPhotoAnim();
  if (enabling) await startClipsGhost();
  else stopClipsGhost();
}
applyPhotoAnim();

// ── Clips: ghost backdrop ─────────────────────────────────────────────────
// Catálogo de clipes vive em `web/data/images.ttl` (ph:MotionImage). Os arquivos
// transcodados ficam em `web/clips/`. Quando Animação está ligada, um
// `<video>` sobre o mapa toca segmentos aleatórios de 5s de cada clipe em
// laço, com áudio. O mapa não move; só os marcadores de cada clipe acendem
// quando seu vídeo está no ar.
const CLIPS_DIR = './clips/';
// Duração do segmento e do fade são lidos do `settings.clipsGhost` em tempo
// real — assim mudanças nos sliders de Ajustes pegam efeito no próximo clipe.
function clipSegmentS()   { return Math.max(2, settings.clipsGhost?.segmentSec ?? 10); }
function clipFadeS()      { return Math.max(0.1, Math.min(settings.clipsGhost?.fadeSec ?? 2, clipSegmentS() / 2)); }
function clipAudioFadeS() {
  // Áudio pode ser MAIOR que vídeo (até metade do segmento), mas nunca
  // menor — pra dar a impressão de fade sonoro mais suave que o visual.
  const desired = settings.clipsGhost?.audioFadeSec ?? 4;
  return Math.max(clipFadeS(), Math.min(desired, clipSegmentS() / 2));
}
let clipsCatalog = null;          // [{file, lat, lng, duration, ...}]
// clipsMarkers declarado cedo, perto de photoMarkers — ver comentário lá.
let clipsAdvanceTimer = null;
let clipsAudioOutTimer = null;
let clipsCurrentIndex = -1;
let clipsGhostVideo  = null;      // <video> element, criado preguiçosamente
// Token de sessão de playback: incrementado a cada playClipAt/stopClipsGhost.
// Um `loadedmetadata` atrasado (clipe anterior ainda carregando quando o
// usuário parou/pulou) compara seu token e vira no-op em vez de tocar áudio
// de um vídeo escondido e agendar timers órfãos.
let clipsPlaySession = 0;
// Listener `loadedmetadata` pendente ({el, handler}) — removido explicitamente
// no próximo playClipAt / stopClipsGhost pra não acumular handlers órfãos.
let clipsPendingMeta = null;
// Erros consecutivos de mídia sem nenhum playback bem-sucedido — quando um
// ciclo inteiro da playlist falha, paramos em vez de loopar requests 404.
let clipsErrorStreak = 0;
// Valor inicial vem do `defaultPct` da entrada `clips-ghost` no OVERLAY_LAYERS
// — uma única fonte de verdade pro fade-in do primeiro clipe e pra posição
// inicial do slider do painel Camadas.
let clipsGhostUserOpacity = (
  (OVERLAY_LAYERS.find((l) => l.id === 'clips-ghost')?.defaultPct ?? 70) / 100
);

function setClipsGhostOpacity(frac) {
  if (clipsGhostVideo) clipsGhostVideo.style.opacity = String(frac);
}

function ensureClipsGhostVideo() {
  if (clipsGhostVideo) return clipsGhostVideo;
  const v = document.createElement('video');
  v.id = 'clips-ghost-video';
  v.className = 'clips-ghost-video';
  v.playsInline = true;
  v.preload = 'auto';
  v.loop = false;   // o avanço é controlado por advanceClip(), não loop nativo
  v.hidden = true;
  v.style.opacity = '0';
  v.volume = 0;
  // CORS: o backend redireciona /clips/<x> pra gs://phidro-state/clips/<x>
  // (different-origin). Sem `crossOrigin=anonymous`, o browser não faz
  // CORS request, e quando `createMediaElementSource` engata o vídeo
  // no Web Audio graph (pro pulse de RMS), o áudio fica TAINTED e o
  // graph emite silêncio — embora a tag <video> sozinha tocaria normal.
  // Bucket já tem CORS Access-Control-Allow-Origin:* configurado no
  // deploy-cloudrun.sh, então a request CORS passa limpa.
  v.crossOrigin = 'anonymous';
  // No `.leaflet-container` (sibling do `.leaflet-map-pane`). Não tentamos
  // mais empilhar com z-index entre tiles e markers porque o map-pane do
  // Leaflet cria seu próprio stacking context (transform), o que torna
  // impossível inserir um irmão entre suas panes internas. Trade-off
  // aceito: vídeo fica por cima de tudo, mas os marcadores (anel branco
  // grosso pulsando até 20×) atravessam visualmente o vídeo translúcido.
  map.getContainer().appendChild(v);
  // Salva-vidas pro loop infinito: se o clipe terminar antes do timer
  // (mais curto que o segmento), avança na hora. Se der erro de mídia,
  // também avança em vez de parar.
  // Só avança se Animação E o vídeo fantasma ainda estiverem ligados —
  // evita que um `ended`/`error` atrasado relance um clipe depois que o
  // usuário desativou o ghost via Camadas/Ajustes.
  const wantAdvance = () => settings.spotlight?.enabled && settings.clipsGhost?.enabled !== false;
  v.addEventListener('ended', () => { if (wantAdvance()) advanceClip(); });
  v.addEventListener('error', () => {
    if (!wantAdvance()) return;
    // Backoff pro caso degenerado: se TODOS os clipes da playlist falharem
    // em sequência (ex.: URLs 404 num host sem os arquivos), avançar pra
    // sempre viraria um loop infinito de requests. Após um ciclo completo
    // de erros sem nenhum playback bem-sucedido, desligamos a Animação
    // limpa (mesmo caminho do clique no botão).
    clipsErrorStreak++;
    const playable = (clipsCatalog || []).filter((c) => c.audioOnly !== true).length;
    if (playable > 0 && clipsErrorStreak >= playable) {
      console.warn('[clips] nenhum clipe pôde ser carregado — desligando a Animação.');
      settings.spotlight.enabled = false;
      saveSettings();
      applyPhotoAnim();   // re-sincroniza o botão Animação (aria-pressed)
      stopClipsGhost();
      return;
    }
    advanceClip();
  });
  // Qualquer playback que realmente começa zera a contagem de falhas.
  v.addEventListener('playing', () => { clipsErrorStreak = 0; });
  clipsGhostVideo = v;
  return v;
}

// ── Audio intensity → pulso do marker do clipe ────────────────────────────
// Plugamos o <video> num AudioContext via MediaElementSource e medimos o
// RMS do sinal a cada frame. O valor (0..1) vira CSS custom property no
// marker ativo (`--clip-intensity`), que escala o círculo laranja.
let clipsAudioCtx = null;
let clipsAnalyser = null;
let clipsAudioBuf = null;
let clipsAudioRaf = null;

function ensureClipsAudioGraph(video) {
  if (clipsAnalyser) return clipsAnalyser;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    clipsAudioCtx = new AC();
    const src = clipsAudioCtx.createMediaElementSource(video);
    clipsAnalyser = clipsAudioCtx.createAnalyser();
    clipsAnalyser.fftSize = 256;
    clipsAnalyser.smoothingTimeConstant = 0.5;
    clipsAudioBuf = new Uint8Array(clipsAnalyser.fftSize);
    // Em série: source → analyser → destination. Sem o destination o vídeo
    // ficaria mudo (MediaElementSource desconecta o output direto do elemento).
    src.connect(clipsAnalyser);
    clipsAnalyser.connect(clipsAudioCtx.destination);
  } catch (err) {
    console.warn('[clips audio] init falhou:', err.message);
    return null;
  }
  return clipsAnalyser;
}

function setActiveMarkerIntensity(level) {
  if (clipsCurrentIndex < 0) return;
  const m = clipsMarkers[clipsCurrentIndex];
  if (!m) return;
  const dot = m.marker.getElement()?.querySelector('.clip-marker');
  if (dot) dot.style.setProperty('--clip-intensity', level.toFixed(3));
}

function startClipsIntensityLoop() {
  if (clipsAudioRaf || !clipsAnalyser) return;
  const tick = () => {
    if (!clipsAnalyser) { clipsAudioRaf = null; return; }
    clipsAnalyser.getByteTimeDomainData(clipsAudioBuf);
    // RMS amplitude do sinal (centrado em 128).
    let sum = 0;
    for (let i = 0; i < clipsAudioBuf.length; i++) {
      const x = (clipsAudioBuf[i] - 128) / 128;
      sum += x * x;
    }
    const rms = Math.sqrt(sum / clipsAudioBuf.length);
    // Voz típica fica ~0.1-0.3 RMS; multiplica pra esticar a faixa visual.
    const gain = settings.clipMarker?.intensityGain ?? 4;
    const level = Math.min(1, rms * gain);
    setActiveMarkerIntensity(level);
    clipsAudioRaf = requestAnimationFrame(tick);
  };
  clipsAudioRaf = requestAnimationFrame(tick);
}

function stopClipsIntensityLoop() {
  if (clipsAudioRaf) cancelAnimationFrame(clipsAudioRaf);
  clipsAudioRaf = null;
  setActiveMarkerIntensity(0);
}

// Rampas independentes pra opacidade do vídeo e pro volume do áudio.
// Separar permite que o fade sonoro seja mais longo que o visual (a
// transição auditiva fica perceptualmente mais suave). Cada uma cancela
// a anterior do mesmo tipo se chamada de novo.
let clipsOpacityRaf = null;
let clipsVolumeRaf  = null;
function fadeProp(v, prop, target, durationMs, rafSlot) {
  if (rafSlot.id) cancelAnimationFrame(rafSlot.id);
  return new Promise((resolve) => {
    const startVal = prop === 'opacity'
      ? (parseFloat(v.style.opacity) || 0)
      : v.volume;
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / durationMs);
      const val = startVal + (target - startVal) * t;
      if (prop === 'opacity') v.style.opacity = String(val);
      else v.volume = Math.max(0, Math.min(1, val));
      if (t < 1) rafSlot.id = requestAnimationFrame(step);
      else { rafSlot.id = null; resolve(); }
    };
    rafSlot.id = requestAnimationFrame(step);
  });
}
const _opacitySlot = { id: null };
const _volumeSlot  = { id: null };
function fadeClipOpacity(v, target, durationMs) { return fadeProp(v, 'opacity', target, durationMs, _opacitySlot); }
function fadeClipVolume(v, target, durationMs)  { return fadeProp(v, 'volume',  target, durationMs, _volumeSlot); }

async function loadClipsCatalog() {
  if (clipsCatalog) return clipsCatalog;
  // Fonte única: ph:MotionImage em web/data/images.ttl. Clipes processados por
  // scripts/build-clips.py vivem em web/clips/ — o próprio build-clips.py
  // escreve as triples no uploads.ttl com autoria/licença default.
  try {
    clipsCatalog = await loadClipsFromUploadsTtl();
  } catch (err) {
    console.warn('[clips] falha ao carregar vídeos de uploads.ttl:', err.message);
    clipsCatalog = [];
  }
  return clipsCatalog;
}

// Lê `web/data/images.ttl` e extrai ph:MotionImage → entradas no formato
// {file, file720, audio, thumb, lat, lng, duration, datetime, vhash, …}.
// Arquivos vivem em `web/clips/<id>.{360p.mp4,720p.mp4,audio.webm,thumb.jpg}`
// (clipes locais de build-clips.py usam stem original; uploads do form
// usam o vhash de 16 hex). Quando o vídeo é audio-only, ph:video360p/720p
// ficam ausentes — o app renderiza só como fonte sonora (audio loop), não
// como ghost-video no mapa.
async function loadClipsFromUploadsTtl() {
  const res = await fetch('./data/images.ttl', { cache: 'no-cache' });
  if (!res.ok) return [];
  const text = await res.text();
  if (!text.trim()) return [];
  await ensureN3();
  return new Promise((resolve) => {
    const parser = new window.N3.Parser({ format: 'text/turtle' });
    const PH_ = 'https://id.pedalhidrografi.co/terms#';
    const SCHEMA_ = 'https://schema.org/';
    const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const subs = new Map();
    const geos = new Map();
    parser.parse(text, (err, quad, done) => {
      if (err) { console.warn('[uploads-video] parse:', err.message); resolve([]); return; }
      if (done) {
        const clips = [];
        for (const [_s, props] of subs) {
          if (!props.types?.has(PH_ + 'MotionImage')) continue;
          const geo = props.locationCreated ? geos.get(props.locationCreated) : null;
          if (!geo || !Number.isFinite(geo.lat) || !Number.isFinite(geo.lng)) continue;
          // Sem áudio = não tem o que tocar; ignora.
          if (!props.audio) continue;
          // Paths relativos a ./clips/ (sem prefixo) — playClipAt() e o
          // popup builder prepende CLIPS_DIR antes de usar.
          const file360 = props.video360p;
          const file720 = props.video720p;
          const audio   = props.audio;
          const file    = file360 || file720 || audio;
          let duration = null;
          if (props.duration) {
            const m = /^PT([\d.]+)S$/.exec(props.duration);
            if (m) duration = parseFloat(m[1]);
          }
          // Date como YYYY-MM-DD pra bater com `ride.date` das fotos no
          // gallery de passeio. Vem do dcterms:date (xsd:dateTime ISO 8601).
          // `datetime` preserva a string completa pro popup ("Quando?").
          const date = props.dateXsd ? props.dateXsd.slice(0, 10) : null;
          clips.push({
            iri: _s,
            vhash: _s.startsWith(MED_NS) ? _s.slice(MED_NS.length) : null,
            file,
            file720: file720 || file360 || audio,
            audio,
            thumb: props.thumbnail || null,
            lat: geo.lat,
            lng: geo.lng,
            duration,
            date,
            datetime: props.dateXsd || null,
            tourIri: props.capturedDuring,
            license: props.license,
            lists: props.lists || [],
            audioOnly: !file360 && !file720,
          });
        }
        resolve(clips);
        return;
      }
      const s = quad.subject.value;
      const p = quad.predicate.value;
      const o = quad.object;
      const sub = subs.get(s) || {};
      // Set, não valor único: mídia georreferenciada carrega DOIS tipos
      // (ph:MotionImage + ph:GeoreferencedImage) — o último quad não pode
      // "vencer" e esconder o MotionImage.
      if (p === RDF_TYPE) (sub.types = sub.types || new Set()).add(o.value);
      else if (p === SCHEMA_ + 'latitude')   { const g = geos.get(s) || {}; g.lat = parseFloat(o.value); geos.set(s, g); }
      else if (p === SCHEMA_ + 'longitude')  { const g = geos.get(s) || {}; g.lng = parseFloat(o.value); geos.set(s, g); }
      else if (p === SCHEMA_ + 'duration')       sub.duration = o.value;
      else if (p === 'http://purl.org/dc/terms/license') sub.license = o.value;
      else if (p === SCHEMA_ + 'locationCreated') sub.locationCreated = o.value;
      else if (p === PH_ + 'capturedDuring')     sub.capturedDuring = o.value;
      else if (p === PH_ + 'video360p')          sub.video360p = o.value;
      else if (p === PH_ + 'video720p')          sub.video720p = o.value;
      else if (p === PH_ + 'audio')              sub.audio = o.value;
      else if (p === SCHEMA_ + 'thumbnail')      sub.thumbnail = o.value;
      else if (p === SCHEMA_ + 'isPartOf')       { (sub.lists = sub.lists || []).push(o.value); }
      else if (p === 'http://purl.org/dc/terms/date') sub.dateXsd = o.value;
      subs.set(s, sub);
    });
  });
}

// Render do popup de clipe — chamado lazy no popupopen pra ver `tourCatalog`
// (que é populado pelo loadPhotos, em paralelo com loadClipsCatalog no boot).
function renderClipPopupHtml(c) {
  const dur = Number.isFinite(c.duration) ? `${c.duration.toFixed(1)} s` : '—';
  const whenHuman = c.datetime
    ? new Date(c.datetime).toLocaleString('pt-BR', { dateStyle: 'medium', timeStyle: 'short' })
    : '—';
  // Mesmo render do Passeio do popup de foto: "CODE: Title" (ex.: "PH 92:
  // Crista do Lauzane…"), com link `.ride-link` que abre o modal da rota
  // na sidebar (delegação já existe pra .photo-popup a.ride-link).
  let tourHtml = '—';
  if (c.tourIri) {
    const t = tourCatalog?.get(c.tourIri);
    const label = t
      ? ((t.code && t.title) ? `${t.code}: ${t.title}`
         : (t.code || t.title || t.date || c.tourIri))
      : c.tourIri;
    tourHtml = `<a href="#" class="ride-link" data-route-id="${escapeHtml(c.tourIri)}">${escapeHtml(label)}</a>`;
  }
  const licShort = c.license
    ? (c.license.match(/licenses\/([a-z-]+)\/(\d+\.\d+)/i)?.slice(1).join(' ').toUpperCase()
       || c.license.match(/zero\/(\d+\.\d+)/i)?.[1]?.replace(/^/, 'CC0 ')
       || c.license)
    : null;
  const license = c.license
    ? `<a href="${escapeHtml(c.license)}" target="_blank" rel="noopener">${escapeHtml(licShort)}</a>`
    : '—';
  const delBtn = c.vhash
    ? `<button type="button" class="photo-del video-del" data-vhash="${escapeHtml(c.vhash)}">Excluir ✕</button>`
    : '';
  const listsBtn = c.vhash
    ? `<button type="button" class="media-lists-edit" data-kind="video" data-hash="${escapeHtml(c.vhash)}">📁 Listas</button>`
    : '';
  // Mesma bolinha verde de maximizar usada nos outros modais — fica no
  // canto, ao lado do × do Leaflet, não dentro de .photo-actions.
  const viewDot = c.vhash
    ? `<button type="button" class="maximize-dot media-view-full" data-hash="${escapeHtml(c.vhash)}" title="Ver grande" aria-label="Ver grande"></button>`
    : '';
  const shareBtn = c.vhash
    ? `<button type="button" class="media-share" data-hash="${escapeHtml(c.vhash)}">🔗 Compartilhar</button>`
    : '';
  const listNames = (c.lists && c.lists.length)
    ? c.lists.map((l) => escapeHtml(listCatalog.get(l)?.name || l.split(/[/#]/).pop())).join(', ')
    : null;
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  const videoSrc = c.file  ? CLIPS_DIR + enc(c.file)  : '';
  const v720Src  = c.file720 && c.file720 !== c.file ? CLIPS_DIR + enc(c.file720) : '';
  const audioSrc = c.audio ? CLIPS_DIR + enc(c.audio) : '';
  // `playsinline` é essencial em iOS Safari — sem ele, tap em ▶ tenta
  // entrar em fullscreen e dentro de popup falha silenciosamente. O
  // `webkit-playsinline` cobre iOS antigos pra garantia.
  const playerHtml = c.audioOnly
    ? (audioSrc ? `<audio controls preload="metadata" src="${audioSrc}"></audio>` : '')
    : (videoSrc ? `<video controls playsinline webkit-playsinline preload="metadata" src="${videoSrc}"></video>` : '');
  const dlChips = [];
  if (videoSrc) dlChips.push(`<a class="photo-dl" href="${videoSrc}" download="${escapeHtml(c.file)}">Vídeo 360p ↓</a>`);
  if (v720Src)  dlChips.push(`<a class="photo-dl" href="${v720Src}"  download="${escapeHtml(c.file720)}">Vídeo 720p ↓</a>`);
  if (audioSrc) dlChips.push(`<a class="photo-dl" href="${audioSrc}" download="${escapeHtml((c.audio || '').split('/').pop())}">Áudio ↓</a>`);
  const actions = [shareBtn, ...dlChips, listsBtn, delBtn].filter(Boolean).join('');
  return (
    `<div class="photo-popup video-popup">` +
      viewDot +
      playerHtml +
      `<dl class="photo-details">` +
        `<dt>Quando</dt><dd>${whenHuman}</dd>` +
        `<dt>Duração</dt><dd>${dur}</dd>` +
        `<dt>Passeio</dt><dd>${tourHtml}</dd>` +
        (listNames ? `<dt>Listas</dt><dd>${listNames}</dd>` : '') +
        `<dt>Licença</dt><dd>${license}</dd>` +
        (c.vhash ? `<dt>vHash</dt><dd><code>${escapeHtml(c.vhash)}</code></dd>` : '') +
      `</dl>` +
      (actions ? `<div class="photo-actions">${actions}</div>` : '') +
    `</div>`
  );
}

function makeClipMarkers(clips) {
  // Pane dedicado pra clipes — z-index acima do markerPane (600) faz com
  // que os anéis pulsando fiquem ACIMA das fotos quando se sobrepõem.
  if (!map.getPane('clipMarkers')) {
    const pane = map.createPane('clipMarkers');
    pane.style.zIndex = '650';
  }
  for (const e of clipsMarkers) { if (e) map.removeLayer(e.marker); }
  clipsMarkers = [];
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) continue;
    // Marker: círculo estilo foto com o thumb do clipe + borda red-orange.
    // O `.clip-marker` overlay continua escondido até a animação ativar,
    // quando ganha `.active` e pulsa em cima do dot. `c.thumb` vem de
    // schema:thumbnail (literal RDF livre) — encodeURIComponent por segmento
    // como em renderClipPopupHtml, pra não quebrar o `style="…url('…')"`.
    const thumbUrl = c.thumb ? CLIPS_DIR + c.thumb.split('/').map(encodeURIComponent).join('/') : '';
    const bg = thumbUrl
      ? `background-image: url('${thumbUrl}'); background-size: cover; background-position: center;`
      : 'background-color: rgba(255,87,34,0.35);';
    const icon = L.divIcon({
      className: 'photo-dot-wrap',
      html:
        `<div class="photo-dot photo-dot-video" style="${bg}"></div>` +
        `<div class="clip-marker"></div>`,
      iconSize: [40, 40],
      iconAnchor: [20, 20],
      popupAnchor: [0, -20],
    });
    const m = L.marker([c.lat, c.lng], { icon, interactive: true, pane: 'clipMarkers' });
    m._clip = c;
    // Popup gerado lazy via callback — `tourCatalog` pode ainda não ter
    // sido populado pelo loadPhotos() quando o marker é criado (boot race
    // entre loadClipsCatalog e loadPhotos). Adiando até o popupopen, o
    // lookup do tour title vê dados frescos.
    m.bindPopup(() => renderClipPopupHtml(c),
      { maxWidth: 440, className: 'photo-popup-wrap', autoPan: false });
    // Durante a Animação, o clique no marker dispara o ghost-video player
    // (mesma UX antiga). Fora da Animação, abre o popup normal.
    // bindPopup() acima já registrou seu próprio listener de 'click' que abre
    // o popup automaticamente — como foi registrado primeiro, ele dispara
    // ANTES deste handler. No ramo da Animação, fecha o popup que acabou de
    // abrir (síncrono, antes de qualquer repaint — sem flash visível) pra não
    // abrir o popup E tocar o clipe ao mesmo tempo.
    m.on('click', (e) => {
      if (settings.spotlight?.enabled && !c.audioOnly) {
        L.DomEvent.stopPropagation(e);
        m.closePopup();
        playClipAt(i);
      } else {
        m.openPopup();
      }
    });
    // Visibilidade efetiva (dot estático vs. anel pulsante) é resolvida por
    // applyClipMarkersVisibility logo abaixo, depois que o array está pronto.
    // Indexado pelo índice de `clipsCatalog` (não `push`) pra manter
    // clipsMarkers[i] alinhado com clipsCatalog[i] — setActiveMarkerIntensity
    // e getMarkerEl indexam por índice de catálogo. Hoje nenhum clipe é
    // pulado (loadClipsFromUploadsTtl já filtra geo-less/audio-less), mas se
    // o `continue` acima disparar, a entrada vira um buraco e os consumidores
    // tratam com guarda em vez de desalinhar silenciosamente.
    clipsMarkers[i] = { clip: c, marker: m };
  }
  applyClipMarkersVisibility();
}

function highlightClipMarker(index) {
  for (let i = 0; i < clipsMarkers.length; i++) {
    if (!clipsMarkers[i]) continue;
    const dot = clipsMarkers[i].marker.getElement()?.querySelector('.clip-marker');
    if (!dot) continue;
    dot.classList.toggle('active', i === index);
  }
}

function pickNextClipIndex() {
  if (!clipsCatalog || clipsCatalog.length === 0) return -1;
  // O ghost-video player só toca clipes com trilha de vídeo de fato.
  // Clipes `audioOnly` (sem ph:video360p/ph:video720p) vão pro audio loop, não
  // pra ele — ver loadClipsFromUploadsTtl. Filtro idempotente: se nenhum
  // clipe tiver vídeo, devolve -1 (animação simplesmente não roda).
  const videoIndices = [];
  for (let i = 0; i < clipsCatalog.length; i++) {
    if (clipsCatalog[i].audioOnly !== true) videoIndices.push(i);
  }
  if (videoIndices.length === 0) return -1;
  if (videoIndices.length === 1) return videoIndices[0];
  let next;
  let tries = 0;
  do {
    next = videoIndices[Math.floor(Math.random() * videoIndices.length)];
    tries++;
  } while (next === clipsCurrentIndex && tries < 10);
  return next;
}

// Timers dos estados do marker. A cada `playClipAt` limpamos tudo e
// reagendamos: o marker novo entra em intro (verde, 1s), depois branco; o
// marker antigo fica branco por 1s de overlap, vira outro (laranja) por
// mais 1s, e some. Resultado visual:
//   [t=0]    new=intro(verde) + old=white     (2 visíveis, 1 branco)
//   [t=1s]   new=white         + old=outro(laranja) (2 visíveis, 1 branco)
//   [t=2s]   new=white                                 (1 branco)
let clipsIntroTimer = null;
let clipsOldOutroTimer = null;
let clipsOldRemoveTimer = null;
const CLIP_INTRO_OUTRO_MS = 1000;
function clearMarkerStateTimers() {
  if (clipsIntroTimer)     { clearTimeout(clipsIntroTimer);     clipsIntroTimer = null; }
  if (clipsOldOutroTimer)  { clearTimeout(clipsOldOutroTimer);  clipsOldOutroTimer = null; }
  if (clipsOldRemoveTimer) { clearTimeout(clipsOldRemoveTimer); clipsOldRemoveTimer = null; }
}
function getMarkerEl(index) {
  const m = clipsMarkers[index];
  return m ? m.marker.getElement()?.querySelector('.clip-marker') : null;
}

function playClipAt(index) {
  if (!clipsCatalog || index < 0 || index >= clipsCatalog.length) return;
  // Guarda defensiva: marker de clipe audio-only não deve disparar o
  // ghost-video player (que assume trilha de vídeo). O audio loop é
  // quem cuida desses — ver audioLoop* abaixo. Se um audio-only foi
  // clicado durante a Animação, simplesmente avança pro próximo vídeo.
  if (clipsCatalog[index].audioOnly === true) { advanceClip(); return; }
  const v = ensureClipsGhostVideo();
  // Nova sessão de playback: invalida qualquer `startAt` pendente do clipe
  // anterior (ver guarda no início de startAt) e remove o listener órfão.
  const session = ++clipsPlaySession;
  if (clipsPendingMeta) {
    clipsPendingMeta.el.removeEventListener('loadedmetadata', clipsPendingMeta.handler);
    clipsPendingMeta = null;
  }
  const c = clipsCatalog[index];
  const prevIndex = clipsCurrentIndex;
  clipsCurrentIndex = index;

  // Handoff dos marcadores: NÃO removemos `.active` do anterior na hora —
  // ele continua branco por mais 1s (sobreposição com o intro do novo),
  // depois vira laranja (outro) por mais 1s, e só então some.
  clearMarkerStateTimers();
  const newDot = getMarkerEl(index);
  if (newDot) {
    newDot.classList.remove('outro');
    newDot.classList.add('active');
    newDot.classList.add('intro');
    clipsIntroTimer = setTimeout(() => {
      const el = getMarkerEl(clipsCurrentIndex);
      if (el) el.classList.remove('intro');
      clipsIntroTimer = null;
    }, CLIP_INTRO_OUTRO_MS);
  }
  if (prevIndex >= 0 && prevIndex !== index) {
    const prevDot = getMarkerEl(prevIndex);
    if (prevDot) {
      // 1s de overlap como branco — depois bolinha laranja por mais 1s.
      clipsOldOutroTimer = setTimeout(() => {
        prevDot.classList.remove('intro');
        prevDot.classList.add('outro');
        clipsOldOutroTimer = null;
      }, CLIP_INTRO_OUTRO_MS);
      clipsOldRemoveTimer = setTimeout(() => {
        prevDot.classList.remove('outro');
        prevDot.classList.remove('active');
        clipsOldRemoveTimer = null;
      }, CLIP_INTRO_OUTRO_MS * 2);
    }
  }

  if (clipsAdvanceTimer)  { clearTimeout(clipsAdvanceTimer);  clipsAdvanceTimer = null; }
  if (clipsAudioOutTimer) { clearTimeout(clipsAudioOutTimer); clipsAudioOutTimer = null; }

  // Escolhe variante 720p se o usuário pediu E o catálogo tem essa versão.
  const wantHd = settings.clipsGhost?.useHd === true;
  const fileName = wantHd && c.file720 ? c.file720 : c.file;
  const src = CLIPS_DIR + encodeURIComponent(fileName);
  if (v.src !== new URL(src, location.href).href) {
    v.src = src;
  }
  v.hidden = false;
  // Começa silencioso/invisível pra encadear o fade-in junto do início do
  // segmento. Se o usuário desligou o painel Camadas → opacity 0, o
  // efeito segue invisível mesmo após o fade.
  v.style.opacity = '0';
  v.volume = 0;

  const startAt = () => {
    // O listener foi consumido (once) — solta a referência pendente.
    if (clipsPendingMeta?.handler === startAt) clipsPendingMeta = null;
    // Guarda anti-stale: se o usuário parou o ghost ou pulou de clipe
    // enquanto os metadados carregavam, este startAt atrasado não pode
    // tocar áudio de um vídeo escondido nem agendar timers.
    if (session !== clipsPlaySession) return;
    const segS = clipSegmentS();
    const fadeS = clipFadeS();
    const audioFadeS = clipAudioFadeS();
    const dur = v.duration;
    const maxStart = Math.max(0, (Number.isFinite(dur) ? dur : c.duration || 0) - segS);
    const start = maxStart > 0 ? Math.random() * maxStart : 0;
    try { v.currentTime = start; } catch {}
    v.play().catch(() => {});
    ensureClipsAudioGraph(v);
    if (clipsAudioCtx && clipsAudioCtx.state === 'suspended') {
      clipsAudioCtx.resume().catch(() => {});
    }
    startClipsIntensityLoop();
    // Fade-in: opacidade no `fadeS`; áudio no `audioFadeS` (mais longo).
    fadeClipOpacity(v, clipsGhostUserOpacity, fadeS * 1000);
    fadeClipVolume(v, 1, audioFadeS * 1000);
    // Fade-out de áudio começa MAIS CEDO que o vídeo (porque é mais longo),
    // mas ambos chegam a zero ~ao mesmo tempo (advance). Rastreamos o timer
    // pra cancelar quando o usuário pula pro próximo clipe — senão ele
    // dispara em cima do `fadeClipVolume(v, 1, ...)` do próximo e mata o
    // fade-in.
    const audioOutDelay = Math.max(0, (segS - audioFadeS) * 1000);
    clipsAudioOutTimer = setTimeout(
      () => fadeClipVolume(v, 0, audioFadeS * 1000),
      audioOutDelay,
    );
    clipsAdvanceTimer = setTimeout(() => {
      fadeClipOpacity(v, 0, fadeS * 1000).then(() => advanceClip());
    }, (segS - fadeS) * 1000);
    // O "outro" do marker é agora agendado pelo PRÓXIMO playClipAt
    // (overlap entre marker antigo e novo), não pelo próprio clipe.
  };
  if (v.readyState >= 1) startAt();
  else {
    clipsPendingMeta = { el: v, handler: startAt };
    v.addEventListener('loadedmetadata', startAt, { once: true });
  }
}

function advanceClip() {
  if (!settings.spotlight.enabled) return;
  const next = pickNextClipIndex();
  if (next >= 0) playClipAt(next);
}

async function startClipsGhost() {
  if (!settings.clipsGhost?.enabled) return;
  await loadClipsCatalog();
  if (!clipsCatalog || clipsCatalog.length === 0) return;
  if (clipsMarkers.length === 0) makeClipMarkers(clipsCatalog);
  // Animação acabou de ligar: traz os markers pro mapa mesmo se "Imagens
  // contribuídas" estiver desligada, pra que o anel pulsante apareça.
  applyClipMarkersVisibility();
  const start = pickNextClipIndex();
  if (start >= 0) playClipAt(start);
}

function stopClipsGhost() {
  // Invalida sessões de playback em voo e remove o `loadedmetadata` pendente
  // — sem isto um startAt atrasado tocaria áudio com o vídeo já escondido.
  clipsPlaySession++;
  if (clipsPendingMeta) {
    clipsPendingMeta.el.removeEventListener('loadedmetadata', clipsPendingMeta.handler);
    clipsPendingMeta = null;
  }
  if (clipsAdvanceTimer)  { clearTimeout(clipsAdvanceTimer);  clipsAdvanceTimer = null; }
  if (clipsAudioOutTimer) { clearTimeout(clipsAudioOutTimer); clipsAudioOutTimer = null; }
  clearMarkerStateTimers();
  if (clipsGhostVideo) {
    try { clipsGhostVideo.pause(); } catch {}
    clipsGhostVideo.hidden = true;
  }
  stopClipsIntensityLoop();
  // Limpa as classes residuais antes de soltar o `.active`.
  for (const e of clipsMarkers) {
    if (!e) continue;
    const dot = e.marker.getElement()?.querySelector('.clip-marker');
    if (dot) { dot.classList.remove('intro'); dot.classList.remove('outro'); }
  }
  highlightClipMarker(-1);
  // Animação desligou: se "Imagens contribuídas" também estiver off, retira
  // os markers do mapa (não há mais nada pra mostrar).
  applyClipMarkersVisibility();
}

// Carrega marcadores na boot pra mostrar onde existem clipes mesmo com
// Animação desligada. (`spotlight.enabled` é forçado pra false no boot,
// então não tentamos auto-iniciar o ghost aqui — fica só na ação do usuário.)
loadClipsCatalog().then((clips) => {
  if (clips && clips.length) makeClipMarkers(clips);
});

// ── Detecção automática do pedal de uma foto ─────────────────────────────
// Usa as rotas já carregadas na barra lateral: casa pela data (chave quase
// única, pedais são semanais) e, na falta, pela proximidade do traçado.
function rideFromEntry(e) {
  const num = e.number;
  return {
    date: e.date || null,
    code: num && num.value ? `${num.source} ${num.value}` : null,
    name: e.name || null,
  };
}
function dateKey(d) {
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}
function detectRideByDate(dateObj) {
  const cand = [dateKey(dateObj)];
  if (dateObj.getHours() < 6) {
    // foto de madrugada → provavelmente o pedal da véspera
    const prev = new Date(dateObj);
    prev.setDate(prev.getDate() - 1);
    cand.push(dateKey(prev));
  }
  for (const r of routes.values()) {
    if (r.entry.date && cand.includes(r.entry.date)) {
      return rideFromEntry(r.entry);
    }
  }
  return null;
}
function detectRideByGps(lat, lng) {
  const here = L.latLng(lat, lng);
  let best = null;
  let bestD = Infinity;
  for (const r of routes.values()) {
    const lls = r.entry.latlngs;
    if (!lls || !lls.length) continue;
    for (const ll of lls) {
      const d = here.distanceTo(L.latLng(ll[0], ll[1]));
      if (d < bestD) {
        bestD = d;
        best = r.entry;
      }
    }
  }
  return bestD < 250 && best ? rideFromEntry(best) : null;
}
// dateObj: Date local da captura (EXIF). Devolve {date,code,name} ou null.
function detectRide(dateObj, lat, lng) {
  let ride = null;
  if (dateObj instanceof Date && !isNaN(dateObj)) {
    ride = detectRideByDate(dateObj);
  }
  if (!ride && Number.isFinite(lat) && Number.isFinite(lng)) {
    ride = detectRideByGps(lat, lng);
  }
  return ride;
}


// ─── Carregamento do TTL + parsing ────────────────────────────────────────
// N3.js servido localmente em web/lib/n3.min.js (UMD; expõe window.N3).
// Bundled offline para não depender de CDN — alinha com o "local-first".
const N3_URL = './lib/n3.min.js';
let _n3Promise = null;
async function ensureN3() {
  if (!_n3Promise) {
    _n3Promise = (async () => {
      if (!window.N3) await loadScript(N3_URL);
      return window.N3.Parser;
    })();
    _n3Promise.catch(() => { _n3Promise = null; });
  }
  return _n3Promise;
}

const PH_NS  = 'https://id.pedalhidrografi.co/terms#';
const PHD_NS = 'https://pedalhidrografi.co/data/';
const MED_NS = 'https://id.pedalhidrografi.co/midia/';    // mídia (image_/video_ + hash)
const LST_NS = 'https://id.pedalhidrografi.co/listas/';   // listas/álbuns (schema:Collection)
const SCHEMA = 'https://schema.org/';
const DCT    = 'http://purl.org/dc/terms/';
const PROV   = 'http://www.w3.org/ns/prov#';
const NFO    = 'http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#';
const EXIF   = 'http://www.w3.org/2003/12/exif/ns#';
const RDFT   = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

// Mapeia o MIME de `schema:encodingFormat` do original pra extensão do blob
// armazenado (`photos/<phash>/original.<ext>`). Só os três valores não-jpg
// aparecem no catálogo; ausência/qualquer-outro cai em 'jpg' (retrocompatível).
function origMimeToExt(mime) {
  switch (mime) {
    case 'image/heic': return 'heic';
    case 'image/heif': return 'heif';
    case 'image/png':  return 'png';
    default:           return 'jpg';
  }
}

// Resolve a URL de uma variante de imagem com base na fonte ativa. Pro
// original, `origExt` é a extensão real do blob guardado (default 'jpg');
// `large`/`thumb` são sempre .jpg.
function resolvePhotoUrl(phash, variant /* 'large' | 'thumb' | 'original' */, origExt = 'jpg') {
  if (!phash) return '';
  if (localKit) {
    const candidates = variant === 'original'
      ? [`photos/${phash}/original.jpg`, `photos/${phash}/original.png`,
         `photos/${phash}/original.heic`, `photos/${phash}/original.heif`,
         `photos/${phash}/original.jpeg`]
      : [`photos/${phash}/${variant}.jpg`];
    for (const p of candidates) {
      const u = localKit.files.get(p);
      if (u) return u;
    }
    return '';
  }
  const ext = variant === 'original' ? origExt : 'jpg';
  return `./${PHOTOS_DIR_REL}${phash}/${variant}.${ext}`;
}

// Parse de um texto TTL em quads (lista de triples N3.js).
async function parseTtlToQuads(text) {
  const Parser = await ensureN3();
  return new Parser().parse(text);
}

// Constrói o modelo (tours, persons, photos) a partir de uma lista de quads.
function buildModelFromQuads(quads) {
  const types = new Map(), titles = new Map(), dates = new Map();
  const names = new Map(), elev = new Map();
  const bearings = new Map(), focals = new Map();
  const tours = new Map();
  // Filiação a séries (PH, BP, BT, S...) por meio de Associações:
  //   Tour --ph:inSeriesEdition--> Association --ph:inEventSeries--> EventSeries
  //                                            --ph:sequenceInSeries--> N
  const tourAssocs    = new Map();   // tourIri → Set(assocIri)
  const assocSeries   = new Map();   // assocIri → seriesIri
  const assocSequence = new Map();   // assocIri → integer
  // ph:linkRoute → RouteReference (bn) → schema:url (RWGPS URL).
  const tourRouteRef  = new Map();   // tourIri → bn IRI
  const subjectUrl    = new Map();   // subject IRI/bn → URL string
  const authors = new Map(), provs = new Map();
  const licenses = new Map();
  const origFmts = new Map();   // imageIri → MIME do original (schema:encodingFormat)
  const locOf = new Map(), locLat = new Map(), locLng = new Map();
  // Pertencimento a listas (álbuns): mídia --schema:isPartOf--> schema:Collection.
  const listsOf = new Map();   // mediaIri → Set(listIri)
  // Activity (ph:Upload) → { startedAt, generated: imageIri }
  const uploadProps    = new Map();
  const uploadByImage  = new Map();   // image IRI → activity props

  for (const q of quads) {
    const s = q.subject.value, p = q.predicate.value, ov = q.object.value;
    if      (p === RDFT) { if (!types.has(s)) types.set(s, new Set()); types.get(s).add(ov); }
    else if (p === DCT + 'title')           titles.set(s, ov);
    else if (p === DCT + 'date')            dates.set(s, ov);
    else if (p === DCT + 'license')         licenses.set(s, ov);
    else if (p === SCHEMA + 'encodingFormat') origFmts.set(s, ov);
    else if (p === SCHEMA + 'name') names.set(s, ov);   // nome real vence sobre apelido
    else if (p === SCHEMA + 'alternateName') { if (!names.has(s)) names.set(s, ov); }
    else if (p === SCHEMA + 'latitude')     locLat.set(s, parseFloat(ov));
    else if (p === SCHEMA + 'longitude')    locLng.set(s, parseFloat(ov));
    else if (p === SCHEMA + 'elevation')    elev.set(s, parseFloat(ov));
    else if (p === SCHEMA + 'locationCreated') locOf.set(s, ov);
    else if (p === SCHEMA + 'isPartOf') {
      if (!listsOf.has(s)) listsOf.set(s, new Set()); listsOf.get(s).add(ov);
    }
    else if (p === EXIF + 'gpsImgDirection')   bearings.set(s, parseFloat(ov));
    else if (p === EXIF + 'focalLengthIn35mmFilm') focals.set(s, parseFloat(ov));
    else if (p === PH_NS + 'capturedDuring')   tours.set(s, ov);
    else if (p === PH_NS + 'inSeriesEdition') {
      if (!tourAssocs.has(s)) tourAssocs.set(s, new Set());
      tourAssocs.get(s).add(ov);
    }
    else if (p === PH_NS + 'inEventSeries')    assocSeries.set(s, ov);
    else if (p === PH_NS + 'sequenceInSeries') assocSequence.set(s, parseInt(ov, 10));
    else if (p === PH_NS + 'linkRoute')        tourRouteRef.set(s, ov);
    else if (p === SCHEMA + 'url')             subjectUrl.set(s, ov);
    else if (p === PROV + 'wasAttributedTo') {
      if (!authors.has(s)) authors.set(s, new Set()); authors.get(s).add(ov);
    }
    else if (p === 'http://purl.org/pav/providedBy') {
      if (!provs.has(s)) provs.set(s, new Set()); provs.get(s).add(ov);
    }
    // ph:Upload activity (adicionado pelo backend em cada /upload-image).
    else if (p === PROV + 'startedAtTime') {
      const a = uploadProps.get(s) || {}; a.startedAt = ov; uploadProps.set(s, a);
    }
    else if (p === PROV + 'generated') {
      const a = uploadProps.get(s) || {}; a.generated = ov; uploadProps.set(s, a);
    }
  }
  // Indexa activities pelas imagens que geraram.
  for (const [_aIri, a] of uploadProps) {
    if (a.generated) uploadByImage.set(a.generated, a);
  }

  // Mapeia IRI de série pra sigla de exibição. Slug do IRI por padrão;
  // exceção: a série S (Suado) historicamente é grafada "PH-S".
  const SERIES_LABEL_OVERRIDE = { S: 'PH-S' };
  const seriesLabel = (iri) => {
    const slug = iri.split(/[/#]/).pop();
    return SERIES_LABEL_OVERRIDE[slug] || slug;
  };
  // Concatena as siglas de filiação de um passeio, ex.: "PH 92" ou
  // "PH 92 & PH-S 6". Ordena por sigla pra estabilidade.
  const buildTourCode = (tourIri) => {
    const assocs = tourAssocs.get(tourIri);
    if (!assocs || !assocs.size) return null;
    const parts = [];
    for (const a of assocs) {
      const sIri = assocSeries.get(a);
      const seq  = assocSequence.get(a);
      if (!sIri || !Number.isFinite(seq)) continue;
      parts.push(`${seriesLabel(sIri)} ${seq}`);
    }
    if (!parts.length) return null;
    parts.sort();
    return parts.join(' & ');
  };

  // Extrai o id da rota da URL referenciada por ph:linkRoute — o numérico do
  // RideWithGPS ou o slug de uma rota salva do amora (/route/<slug>). É o
  // mesmo id que o backend usa nas entradas de routes.json.
  const tourRouteId = (tourIri) => {
    const bn = tourRouteRef.get(tourIri);
    if (!bn) return null;
    const url = subjectUrl.get(bn);
    if (!url) return null;
    const m = /ridewithgps\.com\/routes\/(\d+)/i.exec(url);
    if (m) return m[1];
    const a = /\/route\/([a-z0-9][a-z0-9-]*)\/?$/i.exec(url);
    return a ? a[1].toLowerCase() : null;
  };

  tourCatalog = new Map();
  personCatalog = new Map();
  listCatalog = new Map();
  for (const [s, ts] of types) {
    if (ts.has(PH_NS + 'Tour')) {
      tourCatalog.set(s, {
        title:   titles.get(s) || s,
        date:    (dates.get(s) || '').slice(0, 10),
        code:    buildTourCode(s),
        routeId: tourRouteId(s),
      });
    }
    if (ts.has(SCHEMA + 'Person')) {
      personCatalog.set(s, { name: names.get(s) || s });
    }
    if (ts.has(SCHEMA + 'Collection')) {
      listCatalog.set(s, { name: names.get(s) || s.split(/[/#]/).pop() });
    }
  }

  const photos = [];
  for (const [s, ts] of types) {
    if (!ts.has(PH_NS + 'StillImage')) continue;
    const locNode = locOf.get(s);
    const lat = locNode != null ? locLat.get(locNode) : undefined;
    const lng = locNode != null ? locLng.get(locNode) : undefined;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const phash = s.startsWith(MED_NS) ? s.slice(MED_NS.length) : null;
    const tourIri = tours.get(s);
    const t = tourIri ? tourCatalog.get(tourIri) : null;
    const ride = t
      ? { date: t.date, name: t.title, code: t.code || null, tourIri: tourIri || null, routeId: t.routeId || null }
      : null;
    const personName = (iri) => personCatalog.get(iri)?.name || iri.split(/[/#]/).pop();
    const authorIris = [...(authors.get(s) || [])];
    const authorNames = authorIris.map(personName);
    const providerIris = [...(provs.get(s) || [])];
    const providerNames = providerIris.map(personName);
    const datetime = dates.get(s) || null;
    let fov = null;
    const f35 = focals.get(s);
    if (Number.isFinite(f35) && f35 > 0) {
      fov = (2 * Math.atan(36 / (2 * f35)) * 180) / Math.PI;
    }
    // Activity (`ph:Upload`) que gerou esta imagem, se houver — o servidor a
    // adiciona junto do upload, com ip / user-agent / timestamp de envio.
    const upload = uploadByImage.get(s) || null;
    // Extensão real do original guardado (heic/heif/png; jpg por padrão).
    const origExt = origMimeToExt(origFmts.get(s));
    photos.push({
      id: s,
      phash,
      lat, lng,
      alt:       elev.get(s) ?? null,
      bearing:   Number.isFinite(bearings.get(s)) ? bearings.get(s) : null,
      fov,
      orig:      titles.get(s) || (phash ? `image_${phash}` : s),
      datetime,
      ride,
      authors:     authorNames,
      authorIris:  authorIris,
      providers:   providerNames,
      providerIris: providerIris,
      lists:     [...(listsOf.get(s) || [])],
      license:   licenses.get(s) || null,
      upload,    // { startedAt } | null
      origExt,
      file:      resolvePhotoUrl(phash, 'large'),
      thumb:     resolvePhotoUrl(phash, 'thumb'),
      full:      resolvePhotoUrl(phash, 'original', origExt),
    });
  }
  // Store N3 com TODOS os quads (fotos+vídeos+tours+listas) pro filtro SPARQL
  // avançado do mapa (via Comunica, lazy). Guardado em módulo; reconstruído a
  // cada reload de fotos.
  try {
    if (window.PhidroMediaQuery) mediaStore = window.PhidroMediaQuery.makeStore(quads);
    else if (window.N3 && window.N3.Store) mediaStore = new window.N3.Store(quads);
  } catch (e) { console.warn('[media-store] falhou:', e); }
  return photos;
}

// Tenta carregar o manifesto `data/data_graphs.ttl` de uma fonte; devolve
// a lista de URLs absolutas dos arquivos a fundir.
const VOID  = 'http://rdfs.org/ns/void#';
const MANIFEST_REL = 'data/data_graphs.ttl';

async function fetchManifest(originBase, originLabel) {
  // Resolve para URL absoluta — `new URL(rel, base)` exige base absoluta,
  // então `./data/data_graphs.ttl` (modo servidor) precisa virar
  // `http://host/.../data/data_graphs.ttl` primeiro.
  const url = new URL(originBase + MANIFEST_REL, location.href).href;
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${originLabel}: HTTP ${res.status}`);
  const text = await res.text();
  const quads = await parseTtlToQuads(text);
  const urls = [];
  for (const q of quads) {
    if (q.predicate.value === VOID + 'dataDump') {
      urls.push(new URL(q.object.value, url).href);
    }
  }
  return { url, urls };
}

// Carrega todos os grafos listados no manifesto e devolve {quads, text}.
// Para modo local, ignora manifesto e usa o TTL do kit direto.
async function loadAllGraphs() {
  if (photoSource === 'local') {
    if (!localKit) throw new Error('sem kit local importado');
    return {
      quads:   await parseTtlToQuads(localKit.ttlText),
      text:    localKit.ttlText,
      origin:  'local',
      sources: ['(kit local)'],
    };
  }
  // Servidor (mesma origem): o backend serve/redireciona o manifesto + as fotos.
  const bases = [{ base: './', label: 'server' }];
  let lastErr = '';
  for (const b of bases) {
    let m;
    try { m = await fetchManifest(b.base, b.label); }
    catch (e) { lastErr = e.message; continue; }
    // Manifesto vivo — baixa TODOS os arquivos listados em PARALELO (eram N
    // round trips em série, cada um um request no Cloud Run: ~0,25 s a mais
    // por carga/reload em produção) e parseia na ordem do manifesto.
    const allQuads = [];
    const parts    = [];
    const texts = await Promise.all(m.urls.map((u) =>
      fetch(u, { cache: 'no-cache' })
        .then((r) => { if (!r.ok) { console.warn(`[manifest] ${u}: ${r.status}`); return null; } return r.text(); })
        .catch((e) => { console.warn(`[manifest] ${u}: ${e.message}`); return null; })));
    for (const [i, t] of texts.entries()) {
      if (t == null) continue;
      const u = m.urls[i];
      try {
        parts.push(`# ─── ${u} ───\n${t}`);
        allQuads.push(...await parseTtlToQuads(t));
      } catch (e) { console.warn(`[manifest] ${u}: ${e.message}`); }
    }
    return {
      quads:   allQuads,
      text:    parts.join('\n\n'),
      origin:  b.label,
      sources: m.urls,
    };
  }
  throw new Error(lastErr || 'nenhuma fonte respondeu');
}

async function loadPhotos() {
  if (photosLoaded) return;
  if (photosLoading) { await photosLoading; return; }
  photosLoading = (async () => {
    const seq = ++photosFetchSeq;
    try {
      const r = await loadAllGraphs();
      // Outro reload começou enquanto este carregava — descarta o resultado
      // obsoleto sem tocar em nenhum estado.
      if (seq !== photosFetchSeq) return;
      lastTtlText  = r.text;
      lastTtlOrigin = `${r.origin} · ${r.sources.length} grafo(s)`;
      const photos = buildModelFromQuads(r.quads);
      buildPhotoMarkers(photos);
      photosLoaded = true;
      updatePhotoSourceStatus(`${photos.length} foto(s), ${r.sources.length} grafo(s).`);
    } catch (err) {
      if (seq !== photosFetchSeq) return;
      console.warn('[photos] falha:', err);
      showToast(`Falha ao carregar imagens: ${err.message}`);
      updatePhotoSourceStatus(`Erro: ${err.message}`);
      photosLoading = null;  // permite que a próxima chamada tente de novo
    }
  })();
  await photosLoading;
}

// Dado curto: { rótulo, conteúdo HTML }. Vira <dl>.
function _photoDetailRows(ph) {
  const rows = [];
  if (ph.datetime) {
    const dt = new Date(ph.datetime);
    if (!isNaN(dt)) rows.push(['Quando', escapeHtml(dt.toLocaleString('pt-BR'))]);
  }
  if (ph.ride) {
    // Ex.: "PH 92: Crista do Lauzane…" ou "PH 92 & PH-S 6: O Trem e o Meteoro".
    const label = ph.ride.code && ph.ride.name
      ? `${ph.ride.code}: ${ph.ride.name}`
      : (ph.ride.code || ph.ride.name || ph.ride.date);
    // Se o passeio bate com uma entrada do catálogo (routes está chaveado
    // por tourIri), vira link que abre o modal correspondente na sidebar.
    const html = ph.ride.tourIri
      ? `<a href="#" class="ride-link" data-route-id="${escapeHtml(ph.ride.tourIri)}">${escapeHtml(label)}</a>`
      : escapeHtml(label);
    rows.push(['Passeio', html]);
  }
  const coords =
    `${ph.lat.toFixed(5)}, ${ph.lng.toFixed(5)}` +
    (Number.isFinite(ph.alt) ? ` · ${Math.round(ph.alt)} m` : '') +
    (Number.isFinite(ph.bearing) ? ` · ${Math.round(ph.bearing)}° ${cardinal(ph.bearing)}` : '');
  rows.push(['Coordenadas', escapeHtml(coords)]);
  const personLinks = (names, iris) => names.map((name, i) => {
    const iri = iris[i];
    return iri
      ? `<a href="${escapeHtml(iri)}" target="_blank" rel="noopener">${escapeHtml(name)}</a>`
      : escapeHtml(name);
  }).join(', ');
  if (ph.authors && ph.authors.length) {
    rows.push(['Autoria', personLinks(ph.authors, ph.authorIris || [])]);
  }
  if (ph.providers && ph.providers.length) {
    rows.push(['Quem subiu', personLinks(ph.providers, ph.providerIris || [])]);
  }
  if (ph.lists && ph.lists.length) {
    const names = ph.lists.map((l) => escapeHtml(listCatalog.get(l)?.name || l.split(/[/#]/).pop()));
    rows.push(['Listas', names.join(', ')]);
  }
  if (ph.license) {
    // Texto compacto para CC; fallback pra URL inteira.
    let label = ph.license;
    const m = /licenses\/([a-z-]+)\/(\d+\.\d+)/.exec(ph.license);
    if (m) label = `CC ${m[1].toUpperCase()} ${m[2]}`;
    else if (/publicdomain\/zero\/1\.0/.test(ph.license)) label = 'CC0 1.0';
    rows.push(['Licença', `<a href="${escapeHtml(ph.license)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`]);
  }
  if (ph.upload && ph.upload.startedAt) {
    const dt = new Date(ph.upload.startedAt);
    const when = !isNaN(dt) ? dt.toLocaleString('pt-BR') : ph.upload.startedAt;
    rows.push(['Envio', escapeHtml(when)]);
  }
  if (ph.phash) {
    rows.push(['pHash', `<code>${escapeHtml(ph.phash)}</code>`]);
  }
  return rows;
}

function buildPhotoMarkers(photos) {
  for (const m of photoMarkers) {
    if (map.hasLayer(m)) map.removeLayer(m);
  }
  photoMarkers = [];
  for (const ph of photos) {
    if (!Number.isFinite(ph.lat) || !Number.isFinite(ph.lng)) continue;
    // O `largeUrl` é usado como variante 2x no `image-set` do marker —
    // em telas HiDPI (todos os celulares), o browser baixa essa versão
    // grande SÓ pra renderizar o dot mais nítido. Com dezenas de markers,
    // isso estoura memória em mobile. Quando o toggle de Ajustes está
    // desligado (padrão), passamos `null` e o image-set fica em thumb 1x.
    const useLargeFor2x = settings.images?.useLarge === true;
    const icon = photoDivIcon(
      ph.thumb || ph.file,
      ph.bearing,
      ph.fov,
      '',
      useLargeFor2x ? ph.file : null,
    );
    const m = L.marker([ph.lat, ph.lng], { icon, opacity: photosOpacity });
    m._photo = ph;
    const rows = _photoDetailRows(ph)
      .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join('');
    // Baixar original: usa `download` no <a> — o backend é same-origin então
    // o browser respeita o atributo e abre o save-as direto. O nome do
    // arquivo herda o `orig` (título dcterms) quando disponível.
    const dlName = (ph.orig || (ph.phash ? `image_${ph.phash}` : 'image')).replace(/[\s/]+/g, '_');
    const dlBtn = ph.full
      ? `<a class="photo-dl" href="${escapeHtml(ph.full)}" download="${escapeHtml(dlName)}" target="_blank" rel="noopener">Baixar original ↓</a>`
      : '';
    // Botão de excluir: bate em POST /delete-image/<phash> (backend).
    // Requer phash e fonte same-origin; em modo local só mostra "Baixar".
    const delBtn = (ph.phash && photoSource === 'server')
      ? `<button type="button" class="photo-del" data-phash="${escapeHtml(ph.phash)}">Excluir ✕</button>`
      : '';
    const listsBtn = (ph.phash && photoSource === 'server')
      ? `<button type="button" class="media-lists-edit" data-kind="image" data-hash="${escapeHtml(ph.phash)}">📁 Listas</button>`
      : '';
    const editBtn = (ph.phash && photoSource === 'server')
      ? `<button type="button" class="media-edit" data-kind="image" data-hash="${escapeHtml(ph.phash)}">✎ Editar</button>`
      : '';
    // "Ver grande": abre a MESMA foto na galeria (iframe já maximizável, com
    // painel de metadados) — mais robusto que tentar caber um popup do
    // Leaflet na tela inteira (a árvore de panes usa transform, o que
    // quebraria um position:fixed ingênuo). Estilizado como a bolinha verde
    // de maximizar dos outros modais (mesma classe .maximize-dot), ao lado
    // do × do Leaflet — não faz parte de .photo-actions.
    const viewDot = (ph.phash && photoSource === 'server')
      ? `<button type="button" class="maximize-dot media-view-full" data-hash="${escapeHtml(ph.phash)}" title="Ver grande" aria-label="Ver grande"></button>`
      : '';
    const shareBtn = (ph.phash && photoSource === 'server')
      ? `<button type="button" class="media-share" data-hash="${escapeHtml(ph.phash)}">🔗 Compartilhar</button>`
      : '';
    const actions = [shareBtn, dlBtn, listsBtn, editBtn, delBtn].filter(Boolean).join('');
    m.bindPopup(
      `<div class="photo-popup">` +
        viewDot +
        `<img src="${escapeHtml(ph.file)}" loading="lazy" alt="${escapeHtml(ph.orig)}" />` +
        `<dl class="photo-details">${rows}</dl>` +
        (actions ? `<div class="photo-actions">${actions}</div>` : '') +
      `</div>`,
      { maxWidth: 440, className: 'photo-popup-wrap', autoPan: false },
    );
    photoMarkers.push(m);
  }
  console.log(`[photos] ${photoMarkers.length} marcador(es)`);
}

async function reloadPhotos() {
  photosLoaded = false;
  photosLoading = null;
  await loadPhotos();
  applyPhotoVisibility();
}

// ─── Fonte (Servidor / Local) ─────────────────────────────────────────────
function setPhotoSource(src) {
  if (!['server', 'local'].includes(src)) return;
  // Saindo do modo `local`: revoga as blob URLs do kit pra não vazar memória
  // (só eram revogadas ao importar um novo kit).
  if (src !== 'local' && localKit) {
    for (const u of localKit.files.values()) try { URL.revokeObjectURL(u); } catch {}
    localKit = null;
  }
  photoSource = src;
  try { localStorage.setItem('phidro:photoSource', src); } catch {}
  settings.photoSource = src;
  saveSettings();
  updatePhotoSourceStatus(`Fonte: ${src}.`);
  reloadPhotos();
}

function updatePhotoSourceStatus(msg) {
  const el = document.getElementById('photos-source-status');
  if (el) el.textContent = `${msg} (origem: ${lastTtlOrigin || photoSource})`;
}

async function importPhotosLocal(file) {
  if (!file) return;
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.ttl') || file.type === 'text/turtle') {
    lastTtlText = await file.text();
    lastTtlOrigin = `local: ${file.name}`;
    const photos = buildModelFromQuads(await parseTtlToQuads(lastTtlText));
    photosFetchSeq++; // invalida qualquer loadPhotos em voo — o import vence
    buildPhotoMarkers(photos);
    photosLoaded = true;
    applyPhotoVisibility();
    updatePhotoSourceStatus(`Importado ${photos.length} foto(s) de ${file.name}.`);
    return;
  }
  if (name.endsWith('.zip') || file.type === 'application/zip') {
    const JSZip = await ensureJSZip();
    const zip = await JSZip.loadAsync(file);
    let ttlEntry = zip.file('update.ttl');
    if (!ttlEntry) {
      for (const entry of Object.values(zip.files)) {
        if (!entry.dir && entry.name.endsWith('.ttl')) { ttlEntry = entry; break; }
      }
    }
    if (!ttlEntry) throw new Error('kit sem .ttl');
    if (localKit) {
      for (const u of localKit.files.values()) try { URL.revokeObjectURL(u); } catch {}
    }
    const files = new Map();
    for (const entry of Object.values(zip.files)) {
      if (entry.dir || !entry.name.startsWith('photos/')) continue;
      files.set(entry.name, URL.createObjectURL(await entry.async('blob')));
    }
    const ttlText = await ttlEntry.async('string');
    localKit = { ttlText, files };
    lastTtlText = ttlText;
    lastTtlOrigin = `local kit: ${file.name}`;
    photoSource = 'local';
    try { localStorage.setItem('phidro:photoSource', 'local'); } catch {}
    const photos = buildModelFromQuads(await parseTtlToQuads(ttlText));
    photosFetchSeq++; // invalida qualquer loadPhotos em voo — o import vence
    buildPhotoMarkers(photos);
    photosLoaded = true;
    applyPhotoVisibility();
    updatePhotoSourceStatus(`Importado kit com ${photos.length} foto(s).`);
    return;
  }
  throw new Error('arquivo precisa ser .ttl ou kit .zip');
}

function downloadTtl() {
  if (!lastTtlText) { showToast('Carregue um catálogo primeiro.'); return; }
  const blob = new Blob([lastTtlText], { type: 'text/turtle;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.download = `photos-${stamp}.ttl`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function downloadKit() {
  if (!photoMarkers.length) { showToast('Carregue um catálogo primeiro.'); return; }
  if (!lastTtlText) { showToast('TTL não disponível para o kit.'); return; }
  const JSZip = await ensureJSZip();
  const zip = new JSZip();
  zip.file('update.ttl', lastTtlText);
  const photosFolder = zip.folder('photos');
  let added = 0, missing = 0;
  for (const m of photoMarkers) {
    const ph = m._photo;
    if (!ph.phash) continue;
    const folder = photosFolder.folder(ph.phash);
    // O original conserva sua extensão real (heic/heif/png; jpg por padrão);
    // large/thumb são sempre .jpg.
    for (const [variant, url, ext] of [['large', ph.file, 'jpg'], ['thumb', ph.thumb, 'jpg'], ['original', ph.full, ph.origExt || 'jpg']]) {
      if (!url) { missing++; continue; }
      try {
        const res = await fetch(url);
        if (!res.ok) { missing++; continue; }
        folder.file(`${variant}.${ext}`, await res.blob());
        added++;
      } catch { missing++; }
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `phidro-kit-${stamp}.zip`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  showToast(`Kit pronto: ${added} arquivo(s)${missing ? `, ${missing} indisponível(is)` : ''}.`);
}

// Visibilidade efetiva: camada ligada E (sem filtro OU foto do pedal filtrado).
function applyPhotoVisibility() {
  for (const m of photoMarkers) {
    const ph = m._photo;
    const matchesRide =
      !photoRideFilter ||
      (ph.ride && ph.ride.date === photoRideFilter.date);
    // Foto com datetime ausente é tratada como "sempre visível" (mesma
    // política que routes sem dateMs), pra não esconder fotos antigas
    // sem metadado por causa do filtro.
    let matchesDate = true;
    if (photoDateWindow && ph.datetime) {
      const t = Date.parse(ph.datetime);
      if (Number.isFinite(t)) {
        matchesDate = t >= photoDateWindow.from && t <= photoDateWindow.to;
      }
    }
    const matchesList = mediaMatchesFilter(ph.id, ph.lists);
    const shouldShow = photosVisible && matchesRide && matchesDate && matchesList;
    if (shouldShow && !map.hasLayer(m)) m.addTo(map);
    else if (!shouldShow && map.hasLayer(m)) map.removeLayer(m);
  }
  applyClipMarkersVisibility();
  renderPhotoFilterChip();
  renderMediaFilterChip();
  relaxPhotoMarkers();
}

// Cada marcador de clipe carrega DUAS camadas visuais no mesmo Leaflet
// marker: o dot estático (`.photo-dot-video`) e o anel pulsante
// (`.clip-marker`, branco/verde/laranja durante a animação). Cada uma segue
// um controle diferente:
//   • dot estático  → camada "Imagens contribuídas" (photosVisible)
//   • anel pulsante → "Vídeo fantasma" / Animação (clipsAnimationActive)
// Por isso o Leaflet marker fica no mapa quando QUALQUER um dos dois está
// ligado; quando só a animação está ligada, escondemos o dot estático via
// CSS (`.clip-dot-hidden`) e deixamos só o anel pulsar.
function clipsAnimationActive() {
  return !!(settings.spotlight?.enabled && settings.clipsGhost?.enabled);
}
function applyClipMarkersVisibility() {
  const animOn = clipsAnimationActive();
  for (const e of clipsMarkers) {
    if (!e) continue;
    const m = e.marker;
    // O dot estático respeita o filtro de listas; a animação (ghost-video)
    // ignora o filtro e toca todos os clipes.
    const matchesList = mediaMatchesFilter(e.clip.iri, e.clip.lists);
    const showStatic = photosVisible && matchesList;
    const onMap = showStatic || animOn;
    if (onMap && !map.hasLayer(m)) m.addTo(map);
    else if (!onMap && map.hasLayer(m)) map.removeLayer(m);
    if (!map.hasLayer(m)) continue;
    const el = m.getElement();
    if (el) el.classList.toggle('clip-dot-hidden', !showStatic);
    // Com fotos ligadas o dot acompanha a opacidade do slider; com só a
    // animação no ar, o anel pulsa em opacidade cheia.
    m.setOpacity(showStatic ? photosOpacity : 1);
  }
}

function showPhotos() {
  photosVisible = true;
  loadPhotos().then(() => {
    if (!photosVisible) return;
    applyPhotoVisibility();
    recomputeSparqlFilterIfNeeded();
    if (photoMarkers.length === 0) {
      showToast('Nenhuma imagem carregada (suba via upload_images.html)');
    }
  });
}
function hidePhotos() {
  photosVisible = false;
  applyPhotoVisibility();
}
function setPhotosOpacity(frac) {
  photosOpacity = frac;
  for (const m of photoMarkers) m.setOpacity(frac);
  // Só atenua o clipe quando o dot estático está no ar; com fotos desligadas
  // o marker existe apenas pra animação e o anel deve pulsar em opacidade cheia.
  if (photosVisible) {
    for (const e of clipsMarkers) { if (e && map.hasLayer(e.marker)) e.marker.setOpacity(frac); }
  }
}

// Liga a camada já filtrada para um pedal (usado pelo modal de rota).
function showPhotosForRide(date, label) {
  photoRideFilter = { date, label: label || date };
  photosVisible = true;
  const cb = document.querySelector(
    '.layer-panel .layer-row[data-id="photos"] input[type="checkbox"]',
  );
  if (cb) cb.checked = true;
  loadPhotos().then(() => applyPhotoVisibility());
}
function clearPhotoRideFilter() {
  photoRideFilter = null;
  applyPhotoVisibility();
}

// Chip flutuante mostrando o filtro de pedal ativo (✕ limpa o filtro).
function renderPhotoFilterChip() {
  let chip = document.getElementById('photo-filter-chip');
  if (!photoRideFilter || !photosVisible) {
    if (chip) chip.remove();
    return;
  }
  if (!chip) {
    chip = document.createElement('div');
    chip.id = 'photo-filter-chip';
    chip.className = 'map-chip';
    document.getElementById('map').appendChild(chip);
  }
  const n = ridePhotos(photoRideFilter.date).length;
  chip.innerHTML =
    `<span>Fotos: ${escapeHtml(photoRideFilter.label)} (${n})</span>` +
    `<button type="button" title="Ver todas as imagens">✕</button>`;
  chip.querySelector('button').onclick = clearPhotoRideFilter;
}

// ── Filtro de mídias por listas (álbuns) / SPARQL ──────────────────────────
function mediaFilterSummary() {
  if (mediaFilter.mode === 'all') return 'Todas';
  if (mediaFilter.mode === 'sparql') return 'SPARQL';
  const names = [...mediaFilter.lists].map(
    (l) => listCatalog.get(l)?.name || l.split(/[/#]/).pop());
  if (!names.length) return 'nenhuma lista';
  if (!pickerHasKnownList()) return 'Todas';
  if (names.length <= 2) return names.join(', ');
  return `${names.length} listas`;
}

// O gatilho do filtro é o botão de funil na linha "Imagens contribuídas" do
// painel de camadas (não há mais chip flutuante no mapa). Estados do botão:
//   • popover aberto            → laranja (accent), via aria-expanded
//   • filtro customizado fechado → azul-ciano (.is-custom)  (≠ Padrão/Todas)
//   • Padrão / Todas / fechado   → sem destaque
function updateMediaFilterButton() {
  const btn = document.querySelector('.layer-filter-toggle');
  if (!btn) return;
  const open = !!document.getElementById('media-filter-pop');
  const custom = photosVisible && !mediaFilterIsDefault();
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  btn.classList.toggle('is-custom', !open && custom);
  btn.title = (open || custom)
    ? `Filtro de imagens: ${mediaFilterSummary()} — clique pra ajustar`
    : 'Filtrar imagens/vídeos por lista ou SPARQL';
}
// Chamado em mudanças de filtro/visibilidade (mantém o nome pros callers).
function renderMediaFilterChip() {
  if (!photosVisible) closeMediaFilterPopover();
  updateMediaFilterButton();
}

function toggleMediaFilterPopover() {
  const pop = document.getElementById('media-filter-pop');
  if (pop) closeMediaFilterPopover();
  else openMediaFilterPopover();
}
function closeMediaFilterPopover() {
  const pop = document.getElementById('media-filter-pop');
  if (!pop) return;
  if (pop._cleanup) pop._cleanup();
  pop.remove();
  updateMediaFilterButton();   // tira o laranja de "aberto"
}

function openMediaFilterPopover() {
  closeMediaFilterPopover();
  const pop = document.createElement('div');
  pop.id = 'media-filter-pop';
  pop.className = 'media-filter-pop';
  const isAll = mediaFilter.mode === 'all';
  const isSparql = mediaFilter.mode === 'sparql';
  const lists = [...listCatalog.entries()]
    .sort((a, b) => (a[1].name || '').localeCompare(b[1].name || '', 'pt'));
  const rows = lists.length
    ? lists.map(([iri, o]) =>
        `<label class="mf-row"><input type="checkbox" class="mf-list" value="${escapeHtml(iri)}"` +
        `${mediaFilter.lists.has(iri) ? ' checked' : ''}${isAll || isSparql ? ' disabled' : ''}>` +
        `<span>${escapeHtml(o.name || iri.split(/[/#]/).pop())}</span></label>`).join('')
    : '<div class="mf-empty">Nenhuma lista ainda. Suba imagens com listas ou rode a migração da Padrão.</div>';
  const defaultQuery = mediaFilter.query
    || (window.PhidroMediaQuery
        ? window.PhidroMediaQuery.listMembershipQuery(PADRAO_LIST_IRI)
        : `SELECT ?m WHERE { ?m <${SCHEMA}isPartOf> <${PADRAO_LIST_IRI}> }`);
  pop.innerHTML =
    `<div class="mf-head">Filtro de imagens<button type="button" class="mf-close" title="Fechar">✕</button></div>` +
    `<label class="mf-row mf-todas"><input type="checkbox" id="mf-all"${isAll ? ' checked' : ''}>` +
    `<span><b>Todas</b> (ignora listas)</span></label>` +
    `<div class="mf-lists">${rows}</div>` +
    `<details class="mf-adv"${isSparql ? ' open' : ''}><summary>Avançado (SPARQL)</summary>` +
    `<textarea id="mf-sparql" rows="6" spellcheck="false">${escapeHtml(defaultQuery)}</textarea>` +
    `<div class="mf-adv-actions"><button type="button" id="mf-run" class="mf-btn">Aplicar consulta</button></div>` +
    `<div id="mf-err" class="mf-err"></div></details>`;
  document.body.appendChild(pop);
  L.DomEvent.disableClickPropagation(pop);
  L.DomEvent.disableScrollPropagation(pop);

  // Fecha ao clicar fora (captura no pointerdown → pega mesmo com o
  // disableClickPropagation) ou com Esc. O setTimeout evita fechar no próprio
  // clique de abertura.
  const onDocPointer = (e) => {
    if (pop.contains(e.target) || e.target.closest?.('.layer-filter-toggle')) return;
    closeMediaFilterPopover();
  };
  const onKey = (e) => { if (e.key === 'Escape') closeMediaFilterPopover(); };
  pop._cleanup = () => {
    document.removeEventListener('pointerdown', onDocPointer, true);
    document.removeEventListener('keydown', onKey);
  };
  setTimeout(() => document.addEventListener('pointerdown', onDocPointer, true), 0);
  document.addEventListener('keydown', onKey);

  pop.querySelector('.mf-close').onclick = closeMediaFilterPopover;
  pop.querySelector('#mf-all').onchange = (e) => {
    if (e.target.checked) applyMediaFilter({ mode: 'all' });
    else applyMediaFilter({ mode: 'picker' });
    openMediaFilterPopover();   // re-render (habilita/desabilita rows)
  };
  pop.querySelectorAll('.mf-list').forEach((cb) => {
    cb.onchange = () => {
      const sel = new Set([...pop.querySelectorAll('.mf-list:checked')].map((c) => c.value));
      applyMediaFilter({ mode: 'picker', lists: sel });
    };
  });
  pop.querySelector('#mf-run').onclick = () => {
    const q = pop.querySelector('#mf-sparql').value.trim();
    applyMediaFilter({ mode: 'sparql', query: q });
  };
  updateMediaFilterButton();   // acende o laranja de "aberto"
}

// Aplica uma mudança de estado do filtro: persiste, recomputa (async no modo
// SPARQL) e reprojeta a visibilidade das mídias.
function applyMediaFilter(patch) {
  if (patch.mode) mediaFilter.mode = patch.mode;
  if (patch.lists) mediaFilter.lists = patch.lists;
  if (patch.query != null) mediaFilter.query = patch.query;
  saveMediaFilter();
  const errBox = document.getElementById('mf-err');
  if (errBox) errBox.textContent = '';
  if (mediaFilter.mode === 'sparql') {
    if (!window.PhidroMediaQuery || !mediaStore) {
      if (errBox) errBox.textContent = 'Carregue as imagens primeiro (ligue a camada).';
      return;
    }
    if (errBox) errBox.textContent = 'Consultando…';
    window.PhidroMediaQuery.queryMediaIris(mediaStore, mediaFilter.query)
      .then((set) => {
        mediaFilterResultSet = set;
        if (errBox) errBox.textContent = `${set.size} mídia(s).`;
        applyPhotoVisibility();
        renderMediaFilterChip();
      })
      .catch((e) => {
        mediaFilterResultSet = new Set();
        if (errBox) errBox.textContent = 'Erro na consulta: ' + (e.message || e);
        applyPhotoVisibility();
      });
    return;
  }
  mediaFilterResultSet = null;
  applyPhotoVisibility();
  renderMediaFilterChip();
}

// Recomputa o result-set do modo SPARQL depois que as mídias carregam (boot com
// filtro SPARQL persistido, ou reload após mutação). No-op nos outros modos.
function recomputeSparqlFilterIfNeeded() {
  if (mediaFilter.mode !== 'sparql') return;
  if (!window.PhidroMediaQuery || !mediaStore) return;
  window.PhidroMediaQuery.queryMediaIris(mediaStore, mediaFilter.query)
    .then((set) => { mediaFilterResultSet = set; applyPhotoVisibility(); })
    .catch((e) => {
      console.warn('[media-filter] SPARQL:', e.message || e);
      mediaFilterResultSet = new Set(); applyPhotoVisibility();
    });
}

// ── Editor de listas por mídia (popup do mapa) ─────────────────────────────
function slugifyList(name) {
  return (name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'lista';
}
function ttlEscapeStr(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// Persiste a nova lista de listas de UMA mídia via /update-image|/update-video
// (mode=patch, remove=schema:isPartOf → substitui o pertencimento inteiro).
async function saveMediaLists(kind, hash, listIris, pendingNew) {
  let ttl = '@prefix schema: <https://schema.org/> .\n';
  const mediaIri = MED_NS + hash;   // IRI opaco (tipo é a classe)
  if (listIris.length) {
    ttl += `<${mediaIri}> schema:isPartOf ${listIris.map((i) => '<' + i + '>').join(', ')} .\n`;
  }
  for (const nl of (pendingNew || [])) {
    if (listIris.includes(nl.iri)) {
      ttl += `<${nl.iri}> a schema:Collection ; schema:name "${ttlEscapeStr(nl.name)}" .\n`;
    }
  }
  const fd = new FormData();
  fd.append('ttl', ttl);
  fd.append('remove', 'schema:isPartOf');
  const url = (kind === 'image' ? './update-image/' : './update-video/') + encodeURIComponent(hash);
  const res = await fetch(url, { method: 'POST', body: fd });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = (j.details && j.details.join('; ')) || j.error || msg; } catch (e) {}
    throw new Error(msg);
  }
  return res.json();
}

function openMediaListsEditor(kind, hash, currentLists) {
  document.getElementById('media-lists-editor')?.remove();
  const modal = document.createElement('div');
  modal.id = 'media-lists-editor';
  modal.className = 'modal media-lists-modal';
  const cur = new Set(currentLists || []);
  const lists = [...listCatalog.entries()]
    .sort((a, b) => (a[1].name || '').localeCompare(b[1].name || '', 'pt'));
  const rows = lists.length
    ? lists.map(([li, o]) =>
        `<label class="mle-row"><input type="checkbox" class="mle-list" value="${escapeHtml(li)}"` +
        `${cur.has(li) ? ' checked' : ''}><span>${escapeHtml(o.name || li.split(/[/#]/).pop())}</span></label>`).join('')
    : '<div class="mle-empty">Nenhuma lista ainda — crie uma abaixo.</div>';
  modal.innerHTML =
    `<div class="modal-content media-lists-content">` +
    `<header><h3>Listas da mídia</h3><button class="close" title="Fechar" aria-label="Fechar">✕</button></header>` +
    `<div class="mle-lists">${rows}</div>` +
    `<div class="mle-new"><input type="text" id="mle-newname" placeholder="Nova lista (álbum)…" maxlength="60">` +
    `<button type="button" id="mle-add" class="mle-btn">+ criar</button></div>` +
    `<div class="mle-actions"><button type="button" id="mle-save" class="mle-save">Salvar</button></div>` +
    `<div id="mle-err" class="mle-err"></div></div>`;
  document.body.appendChild(modal);
  modal.hidden = false;
  const close = () => modal.remove();
  modal.querySelector('.close').onclick = close;
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  const pendingNew = [];
  modal.querySelector('#mle-add').onclick = () => {
    const inp = modal.querySelector('#mle-newname');
    const nm = inp.value.trim();
    if (!nm) return;
    const li = LST_NS + slugifyList(nm);
    const exists = [...modal.querySelectorAll('.mle-list')].some((c) => c.value === li);
    if (!exists) {
      pendingNew.push({ iri: li, name: nm });
      const lab = document.createElement('label');
      lab.className = 'mle-row';
      lab.innerHTML = `<input type="checkbox" class="mle-list" value="${escapeHtml(li)}" checked>` +
        `<span>${escapeHtml(nm)} <em>(nova)</em></span>`;
      modal.querySelector('.mle-empty')?.remove();
      modal.querySelector('.mle-lists').appendChild(lab);
    }
    inp.value = '';
  };
  modal.querySelector('#mle-save').onclick = async () => {
    const chosen = [...modal.querySelectorAll('.mle-list:checked')].map((c) => c.value);
    const errBox = modal.querySelector('#mle-err');
    errBox.textContent = 'Salvando…';
    try {
      await saveMediaLists(kind, hash, chosen, pendingNew);
      close();
      showToast('Listas atualizadas.');
      if (kind === 'image') reloadPhotos();
      else { clipsCatalog = null; loadClipsCatalog().then((clips) => makeClipMarkers(clips)); }
    } catch (e) {
      errBox.textContent = 'Erro: ' + (e.message || e);
    }
  };
}

// Tira de miniaturas das fotos do pedal, exibida no modal da rota.
function renderRoutePhotos(entry) {
  const box = document.getElementById('route-modal-photos');
  box.innerHTML = '';
  if (!entry.date) return;
  const label = entry.number?.value
    ? `${entry.number.source} ${entry.number.value}`
    : buildLabel(entry);
  // Carrega o catálogo de clipes em paralelo com photos pra renderizar a
  // tira de vídeos junto. Falha silenciosamente se uploads.ttl não tiver
  // ph:MotionImage — apenas o strip de fotos sai.
  loadClipsCatalog().then(() => {
    const cms = rideClips(entry.date, entry.tourIri);
    if (!cms.length) return;
    const head = document.createElement('div');
    head.className = 'route-photos-head';
    const count = document.createElement('span');
    count.textContent = `${cms.length} vídeo${cms.length > 1 ? 's' : ''} deste pedal`;
    head.appendChild(count);
    const strip = document.createElement('div');
    strip.className = 'route-photos-strip';
    for (const { clip, marker } of cms) {
      const wrap = document.createElement('div');
      wrap.className = 'route-clip';
      const img = document.createElement('img');
      img.src = clip.thumb ? CLIPS_DIR + clip.thumb : '';
      img.loading = 'lazy';
      img.alt = clip.iri || 'vídeo';
      img.title = 'Ver no mapa';
      img.addEventListener('click', () => {
        closeRouteModal();
        map.setView(marker.getLatLng(), Math.max(map.getZoom(), 15));
        marker.openPopup();
      });
      wrap.appendChild(img);
      strip.appendChild(wrap);
    }
    box.appendChild(head);
    box.appendChild(strip);
  });
  loadPhotos().then(() => {
    const ms = ridePhotos(entry.date);
    if (ms.length === 0) return;
    const head = document.createElement('div');
    head.className = 'route-photos-head';
    const count = document.createElement('span');
    count.textContent = `${ms.length} imagem${ms.length > 1 ? 'ns' : ''} deste pedal`;
    head.appendChild(count);
    // Botões de download em lote — empacotam todas as fotos do pedal num .zip.
    const dlActions = document.createElement('span');
    dlActions.className = 'route-photos-dl';
    const bigBtn   = document.createElement('button');
    bigBtn.type = 'button'; bigBtn.className = 'linkbtn';
    bigBtn.textContent = 'Baixar originais ↓';
    const largeBtn = document.createElement('button');
    largeBtn.type = 'button'; largeBtn.className = 'linkbtn';
    largeBtn.textContent = 'Baixar grandes ↓';
    bigBtn.addEventListener('click',
      () => bulkDownloadPhotos(ms.map((m) => m._photo), 'original', label, bigBtn));
    largeBtn.addEventListener('click',
      () => bulkDownloadPhotos(ms.map((m) => m._photo), 'large', label, largeBtn));
    dlActions.appendChild(bigBtn);
    dlActions.appendChild(largeBtn);
    head.appendChild(dlActions);
    const strip = document.createElement('div');
    strip.className = 'route-photos-strip';
    for (const m of ms) {
      const img = document.createElement('img');
      img.src = m._photo.file;
      img.loading = 'lazy';
      img.alt = m._photo.orig || '';
      img.title = 'Ver no mapa';
      img.addEventListener('click', () => {
        // Só abre a foto no mapa — SEM filtrar (era um efeito colateral
        // surpreendente do clique; filtrar agora é explícito, via o botão
        // "Filtrar imagens para esta rota" no cabeçalho do modal).
        closeRouteModal();
        map.setView(m.getLatLng(), Math.max(map.getZoom(), 15));
        m.openPopup();
      });
      strip.appendChild(img);
    }
    box.appendChild(head);
    box.appendChild(strip);
  });
}

// Baixa todas as fotos de um pedal num .zip (variant = 'original' | 'large').
// Usa o JSZip que já carregamos pra outros fluxos. Em caso de erro num
// arquivo, segue baixando os outros — o .zip sai com o que conseguiu.
async function bulkDownloadPhotos(photos, variant, label, btn) {
  if (!photos || !photos.length) return;
  const origLabel = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Empacotando…'; }
  try {
    const JSZip = await ensureJSZip();
    const zip = new JSZip();
    let ok = 0, fail = 0;
    for (let i = 0; i < photos.length; i++) {
      const ph = photos[i];
      const url = variant === 'original' ? ph.full : ph.file;
      if (!url) { fail++; continue; }
      if (btn) btn.textContent = `Baixando ${i + 1}/${photos.length}…`;
      try {
        const r = await fetch(url, { cache: 'no-cache' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const blob = await r.blob();
        // Nome no zip: tenta `orig`, cai pro phash, depois pro fim da URL.
        let name = (ph.orig || (ph.phash ? `image_${ph.phash}` : '')) || url.split('/').pop();
        name = name.replace(/[\\/:*?"<>|]+/g, '_');
        // Garante extensão razoável quando `orig` não traz.
        if (!/\.[a-z0-9]{1,5}$/i.test(name)) {
          const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
          name = `${name}.${ext}`;
        }
        zip.file(name, blob);
        ok++;
      } catch (e) {
        console.warn(`[bulk-dl] ${url}: ${e.message}`);
        fail++;
      }
    }
    if (!ok) { showToast(`Falha ao baixar (${fail} erros)`); return; }
    if (btn) btn.textContent = 'Compactando…';
    const out = await zip.generateAsync({ type: 'blob' });
    const safe = (label || 'pedal').replace(/[\\/:*?"<>|\s]+/g, '_');
    const fname = `${safe}_${variant}.zip`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(out);
    a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    showToast(`${ok} imagem(ns) compactada(s)${fail ? ` · ${fail} com erro` : ''}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origLabel; }
  }
}

// ─── Envio de fotos pelo usuário (apenas na sessão) ──────────────────────────
// Botão que abre o seletor de arquivos; lê o GPS do EXIF de cada foto no
// próprio navegador e a coloca no mapa. HEIC (iPhone) é convertido em JPEG
// via heic2any. Nada é salvo no servidor — recarregar a página limpa tudo.
// As bibliotecas exifr/heic2any são carregadas sob demanda para não pesar
// o carregamento normal da página.
const HEIC2ANY_URL =
  'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
const JSZIP_URL =
  'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
// Envio ao acervo agora acontece pela upload_images.html (POST /upload-image
// no backend). Aqui no app o upload é apenas preview de sessão.
let uploadedMarkers = [];
let uploadedData = [];

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`falha ao carregar ${src}`));
    document.head.appendChild(s);
  });
}
// exifr VENDORADO em web/lib/ (era jsdelivr): bloqueadores/ETP do Firefox e uso
// offline derrubavam o import do CDN, e com ele o "soltar foto no mapa" por GPS.
let _exifrMod = null;
async function ensureExifr() {
  if (!_exifrMod) _exifrMod = await import('./lib/exifr.esm.js').then((m) => m.default || m);
  return _exifrMod;
}
async function ensureHeic2any() {
  if (!window.heic2any) await loadScript(HEIC2ANY_URL);
}
async function ensureJSZip() {
  if (!window.JSZip) await loadScript(JSZIP_URL);
  return window.JSZip;
}
function isHeic(f) {
  return /image\/hei[cf]/i.test(f.type) || /\.(heic|heif)$/i.test(f.name);
}
// Tipo MIME confiável — alguns navegadores deixam f.type vazio para HEIC.
function fileContentType(f) {
  if (f.type) return f.type;
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  return (
    { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      heic: 'image/heic', heif: 'image/heif' }[ext] || 'application/octet-stream'
  );
}

async function handlePhotoUpload(fileList) {
  const files = [...(fileList || [])];
  if (files.length === 0) return;
  showToast(`Processando ${files.length} imagem(ns)…`);
  let exifrLib;
  try {
    exifrLib = await ensureExifr();
  } catch {
    showToast('Não foi possível carregar o leitor de EXIF.');
    return;
  }
  if (files.some(isHeic)) {
    try {
      await ensureHeic2any();
    } catch {
      showToast('Não foi possível carregar o conversor HEIC.');
    }
  }

  let added = 0;
  let noGps = 0;
  let failed = 0;
  for (const f of files) {
    try {
      const meta = await exifrLib.parse(f, {
        gps: true,
        exif: true,
        ifd0: true,
        translateValues: false,
      });
      const lat = meta?.latitude;
      const lng = meta?.longitude;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        noGps++;
        continue;
      }
      let url;
      if (isHeic(f)) {
        if (!window.heic2any) {
          failed++;
          continue;
        }
        const out = await window.heic2any({
          blob: f,
          toType: 'image/jpeg',
          quality: 0.7,
        });
        url = URL.createObjectURL(Array.isArray(out) ? out[0] : out);
      } else {
        url = URL.createObjectURL(f);
      }
      const cam = cameraFromExif(meta);
      const ride = detectRide(meta?.DateTimeOriginal, lat, lng);
      addUploadedPhoto({
        url,
        file: f,
        orig: f.name,
        ride,
        lat: Math.round(lat * 1e6) / 1e6,
        lng: Math.round(lng * 1e6) / 1e6,
        alt: Number.isFinite(meta?.GPSAltitude)
          ? Math.round(meta.GPSAltitude * 10) / 10
          : null,
        datetime:
          meta?.DateTimeOriginal instanceof Date
            ? meta.DateTimeOriginal.toISOString()
            : null,
        bearing: cam.bearing,
        fov: cam.fov,
      });
      added++;
    } catch (err) {
      console.warn('[upload] falha em', f.name, err);
      failed++;
    }
  }

  if (added > 0) {
    map.fitBounds(L.latLngBounds(uploadedMarkers.map((m) => m.getLatLng())), {
      maxZoom: 15,
      padding: [40, 40],
    });
  }
  renderUploadChip();
  const parts = [`${added} adicionada(s)`];
  if (noGps) parts.push(`${noGps} sem GPS`);
  if (failed) parts.push(`${failed} com erro`);
  showToast(parts.join(' · '));
}

function addUploadedPhoto(p) {
  const icon = photoDivIcon(p.url, p.bearing, p.fov, 'photo-dot-upload', p.url);
  const m = L.marker([p.lat, p.lng], { icon });
  const when = p.datetime ? new Date(p.datetime).toLocaleString('pt-BR') : '';
  const rideText = p.ride
    ? (p.ride.code && p.ride.name
        ? `${p.ride.code}: ${p.ride.name}`
        : (p.ride.code || p.ride.name || p.ride.date))
    : 'Imagem enviada · apenas nesta sessão';
  m.bindPopup(
    `<div class="photo-popup">` +
      `<img src="${p.url}" alt="${escapeHtml(p.orig)}" />` +
      `<div class="photo-ride">${escapeHtml(rideText)}</div>` +
      `<div class="photo-meta">${escapeHtml(p.orig)}` +
      (when ? ` · ${escapeHtml(when)}` : '') +
      (Number.isFinite(p.alt) ? ` · ${p.alt} m` : '') +
      (Number.isFinite(p.bearing)
        ? ` · ${Math.round(p.bearing)}° ${cardinal(p.bearing)}`
        : '') +
      `</div></div>`,
    { maxWidth: 440, className: 'photo-popup-wrap', autoPan: false },
  );
  m.addTo(map);
  uploadedMarkers.push(m);
  uploadedData.push(p);
}

function clearUploadedPhotos() {
  for (const m of uploadedMarkers) map.removeLayer(m);
  for (const p of uploadedData) {
    try {
      URL.revokeObjectURL(p.url);
    } catch {}
  }
  uploadedMarkers = [];
  uploadedData = [];
  renderUploadChip();
}

// Exporta os pontos da sessão como JSON simples — útil pra triagem manual.
// Para entrar no acervo, suba via upload_images.html (POST /upload-image).
function exportUploadedPhotos() {
  if (uploadedData.length === 0) return;
  const payload = {
    generatedAt: new Date().toISOString(),
    count: uploadedData.length,
    photos: uploadedData.map((p) => ({
      file: `photos/${p.orig.replace(/\.[^.]+$/, '')}.jpg`,
      orig: p.orig,
      lat: p.lat,
      lng: p.lng,
      alt: p.alt,
      datetime: p.datetime,
      ride: null,
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'photos-upload.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function renderUploadChip() {
  let chip = document.getElementById('upload-status-chip');
  if (uploadedMarkers.length === 0) {
    if (chip) chip.remove();
    return;
  }
  if (!chip) {
    chip = document.createElement('div');
    chip.id = 'upload-status-chip';
    chip.className = 'map-chip';
    document.getElementById('map').appendChild(chip);
  }
  chip.innerHTML =
    `<span>📷 ${uploadedMarkers.length} imagem(ns) (apenas nesta sessão)</span>` +
    `<button type="button" data-act="export">Exportar</button>` +
    `<button type="button" data-act="clear">Limpar</button>`;
  chip.querySelector('[data-act="export"]').onclick = exportUploadedPhotos;
  chip.querySelector('[data-act="clear"]').onclick = clearUploadedPhotos;
}

// "Enviar imagens" abre o upload_images.html dentro de um iframe modal:
// isola o estado da página (CDN imports, Tom Select, etc.) e devolve um
// uploadModal limpo a cada abertura.
const uploadBtn        = document.getElementById('upload-btn');
const uploadModal      = document.getElementById('upload-modal');
const uploadIframe     = document.getElementById('upload-iframe');
let _uploadDirty = false;   // o form avisou (phidro-media-changed) que salvou/editou algo
function openUploadModal() {
  if (!uploadModal) return;
  closeOtherMobileDialogs('upload');
  // Lazy-load: só seta o src na 1ª abertura (depois mantém o estado do form).
  // NB: `iframe.src` (IDL) é truthy mesmo quando o atributo está vazio
  // (devolve a URL da página pai/`about:blank`). Checamos o atributo cru.
  if (!uploadIframe.getAttribute('src')) {
    uploadIframe.src = './upload_images.html';
  }
  uploadModal.hidden = false;
  uploadBtn?.setAttribute('aria-pressed', 'true');
}
function closeUploadModal() {
  if (uploadModal) uploadModal.hidden = true;
  uploadBtn?.setAttribute('aria-pressed', 'false');
  // Pede pro upload_images.html limpar os cards — evita acumular fotos já
  // enviadas (ou abandonadas) entre uma abertura e outra do modal.
  try {
    uploadIframe?.contentWindow?.postMessage({ type: 'phidro-upload-modal-closed' }, window.location.origin);
  } catch (_) {}
  // Recarrega o catálogo SÓ se o form avisou que salvou algo
  // (phidro-media-changed): fechar sem enviar não custa mais 4 dumps + um
  // rebuild de todos os marcadores.
  if (_uploadDirty) { _uploadDirty = false; reloadPhotos(); }
}
uploadBtn?.addEventListener('click', openUploadModal);
// Clique no overlay (fora do conteúdo) fecha.
uploadModal?.addEventListener('click', (e) => {
  if (e.target === uploadModal) closeUploadModal();
});
// Esc também fecha.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && uploadModal && !uploadModal.hidden) closeUploadModal();
});

// Cadastro/edição de passeio em iframe — o src é remontado a cada abertura
// porque o ?id pode mudar entre invocações (novo vs editar X vs editar Y).
const tourModal      = document.getElementById('tour-modal');
const tourIframe     = document.getElementById('tour-iframe');
let _tourDirty = false;     // o form avisou (phidro-tour-changed) que salvou/apagou um passeio
function openTourModal(tourId) {
  if (!tourModal) return;
  closeOtherMobileDialogs('tour');
  if (closeRouteModal && !routeModal?.hidden) closeRouteModal();
  const src = tourId
    ? `./upload_tour.html?id=${encodeURIComponent(tourId)}`
    : './upload_tour.html';
  // Título da faixa reflete o modo (criar vs editar).
  const tourTitle = document.getElementById('tour-modal-title');
  if (tourTitle) tourTitle.textContent = tourId ? 'Editar passeio' : 'Subir passeio';
  // Forçar reload mesmo quando o ?id é o mesmo: substitui o src.
  tourIframe.src = src;
  tourModal.hidden = false;
}
function closeTourModal() {
  if (tourModal) tourModal.hidden = true;
  // Libera o iframe (e seu state) — próxima abertura monta limpo.
  if (tourIframe) tourIframe.src = '';
  // Tour criado/editado/deletado (o form avisa via phidro-tour-changed) →
  // recarrega catálogos; fechar sem salvar não recarrega nada. O resumo no
  // route-modal re-fetch'a tours.ttl com no-cache na próxima abertura, então
  // mudanças aparecem sem refresh.
  if (_tourDirty) { _tourDirty = false; reloadPhotos(); }
}
tourModal?.addEventListener('click', (e) => {
  if (e.target === tourModal) closeTourModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && tourModal && !tourModal.hidden) closeTourModal();
});

// Censo em iframe — re-aponta pra censo.html toda vez que abre. Sem isto,
// se o usuário navega de dentro do iframe (ex.: clicando "+ Cadastrar
// passeio", que vai pra upload_tour.html), reabrir o modal mostraria a
// página interna em vez do censo. Re-set explícito é cheap e idempotente.
const censoModal      = document.getElementById('censo-modal');
const censoIframe     = document.getElementById('censo-iframe');
const censoLink       = document.getElementById('censo-link');
const CENSO_URL = './censo.html';
function openCensoModal() {
  if (!censoModal) return;
  closeOtherMobileDialogs('censo');
  // Compara contra o iframe.contentWindow.location.pathname pra detectar
  // navegação interna; senão, mantém pra preservar scroll/sort do censo
  // entre aberturas. Fallback: comparar com getAttribute('src').
  let needsReset = true;
  try {
    const path = censoIframe.contentWindow?.location?.pathname || '';
    needsReset = !path.endsWith('/censo.html');
  } catch (_) {
    // Cross-origin protection — não devia rolar em same-origin, mas seguro.
    needsReset = !censoIframe.getAttribute('src');
  }
  if (needsReset) censoIframe.src = CENSO_URL;
  censoModal.hidden = false;
}
function closeCensoModal() {
  if (censoModal) censoModal.hidden = true;
}
censoLink?.addEventListener('click', (e) => {
  // Modifier keys / middle click → deixa o link funcionar normalmente
  // (abrir em nova aba, etc.).
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button === 1) return;
  e.preventDefault();
  openCensoModal();
});
censoModal?.addEventListener('click', (e) => {
  if (e.target === censoModal) closeCensoModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && censoModal && !censoModal.hidden) closeCensoModal();
});
// Mensagens dos iframes filhos (Censo, Galeria). Só mesma origem.
window.addEventListener('message', (e) => {
  if (e.origin !== window.location.origin) return;
  if (!e.data || !e.data.type) return;
  switch (e.data.type) {
    case 'phidro-censo-back':     closeCensoModal(); break;
    case 'phidro-gallery-back':   closeImagensModal(); break;
    case 'phidro-gallery-reload':
      reloadPhotos();
      clipsCatalog = null;
      loadClipsCatalog().then((clips) => makeClipMarkers(clips));
      break;
    case 'phidro-gallery-show':   galleryShowMedia(e.data.iri); break;
    case 'phidro-media-changed':  _uploadDirty = true; break;   // form de upload salvou/editou
    case 'phidro-tour-changed':   _tourDirty = true; break;     // form de passeio salvou/apagou
    default: break;
  }
});

// Galeria de imagens em iframe — mesma mecânica do Censo.
const imagensBtn        = document.getElementById('imagens-btn');
const imagensModal      = document.getElementById('imagens-modal');
const imagensIframe     = document.getElementById('imagens-iframe');
const IMAGENS_URL = './imagens.html';
function openImagensModal() {
  if (!imagensModal) return;
  closeOtherMobileDialogs('imagens');
  let needsReset = true;
  try {
    const path = imagensIframe.contentWindow?.location?.pathname || '';
    needsReset = !path.endsWith('/imagens.html');
  } catch (_) {
    needsReset = !imagensIframe.getAttribute('src');
  }
  if (needsReset) imagensIframe.src = IMAGENS_URL;
  imagensModal.hidden = false;
  imagensBtn?.setAttribute('aria-pressed', 'true');
}
function closeImagensModal() {
  if (imagensModal) imagensModal.hidden = true;
  imagensBtn?.setAttribute('aria-pressed', 'false');
}
// Abre a galeria já navegada + focada numa mídia específica (usado pelo
// "🔍 Ver grande" do popup de foto/vídeo). Sempre reseta o src (diferente de
// openImagensModal, que reusa a página se já estiver na galeria) — é uma
// navegação deliberada pro item, não só "abrir o que já tava aberto".
function openImagensModalToMedia(hash) {
  if (!imagensModal || !hash) return;
  closeOtherMobileDialogs('imagens');
  imagensIframe.src = `${IMAGENS_URL}?pick=${encodeURIComponent(hash)}`;
  imagensModal.hidden = false;
  imagensBtn?.setAttribute('aria-pressed', 'true');
}
// Copia um link pro clipboard (fallback: prompt, pra quem bloqueia a
// Clipboard API — ex.: contexto não-https ou permissão negada).
function shareLink(url, label = 'Link') {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(
      () => showToast(`✓ ${label} copiado`),
      () => prompt('Copie o link:', url));
  } else {
    prompt('Copie o link:', url);
  }
}
imagensBtn?.addEventListener('click', openImagensModal);
imagensModal?.addEventListener('click', (e) => {
  if (e.target === imagensModal) closeImagensModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && imagensModal && !imagensModal.hidden) closeImagensModal();
});
// "Ver no mapa" da galeria → fecha o modal, voa até o marcador e abre o popup.
function galleryShowMedia(iri) {
  closeImagensModal();
  if (!iri) return;
  let marker = photoMarkers.find((m) => m._photo && m._photo.id === iri) || null;
  if (!marker) {
    const cm = clipsMarkers.find((x) => x && x.clip && x.clip.iri === iri);
    if (cm) marker = cm.marker;
  }
  if (!marker) { showToast('Mídia não está no mapa.'); return; }
  photosVisible = true;
  const ll = marker.getLatLng();
  map.flyTo(ll, Math.max(map.getZoom(), 16));
  setTimeout(() => {
    if (!map.hasLayer(marker)) marker.addTo(map);
    marker.openPopup();
  }, 450);
}

// Menu "Subir" — atalho no topbar que abre um mini-modal com as duas ações
// de contribuição (enviar mídia / cadastrar passeio), cada uma delegando pro
// modal já existente.
const subirBtn        = document.getElementById('subir-btn');
const subirModal      = document.getElementById('subir-modal');
const subirModalClose = document.getElementById('subir-modal-close');
function openSubirModal() {
  if (!subirModal) return;
  closeOtherMobileDialogs('subir');
  subirModal.hidden = false;
}
function closeSubirModal() {
  if (subirModal) subirModal.hidden = true;
}
subirBtn?.addEventListener('click', openSubirModal);
subirModalClose?.addEventListener('click', closeSubirModal);
subirModal?.addEventListener('click', (e) => {
  if (e.target === subirModal) closeSubirModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && subirModal && !subirModal.hidden) closeSubirModal();
});
document.getElementById('subir-upload-media')?.addEventListener('click', () => {
  closeSubirModal();
  openUploadModal();
});
document.getElementById('subir-new-tour')?.addEventListener('click', () => {
  closeSubirModal();
  openTourModal();
});
document.getElementById('subir-censo')?.addEventListener('click', () => {
  closeSubirModal();
  openCensoModal();
});
document.getElementById('subir-memoria')?.addEventListener('click', () => {
  // Virou um <a href> de verdade (link rastreável pra indexação): o navegador
  // abre a aba nova sozinho — aqui só fecha o modal.
  closeSubirModal();
});
document.getElementById('subir-custos')?.addEventListener('click', () => {
  closeSubirModal();
  // Página própria (não modal): abre em aba nova pra não derrubar o mapa.
  window.open('./custos.html', '_blank', 'noopener');
});
document.getElementById('subir-download-gpx')?.addEventListener('click', () => {
  closeSubirModal();
  downloadAllRoutesGpx();
});
document.getElementById('subir-share-loc')?.addEventListener('click', () => {
  closeSubirModal();
  onShareLocClick();
});
document.getElementById('subir-help')?.addEventListener('click', () => {
  closeSubirModal();
  closeOtherMobileDialogs('help');
  setHelpOpen(true);
});

// ─── Botão de fechar (bolinha vermelha estilo macOS) ─────────────────────────
// Como os modais e painéis não têm mais barra de título, injeta uma bolinha
// vermelha discreta no canto superior esquerdo. Cada contêiner reserva a folga
// no CSS (.close-dot). `onClose` roda no clique.
function makeCloseDot(onClose, title = 'Fechar') {
  const dot = document.createElement('button');
  dot.type = 'button';
  dot.className = 'close-dot';
  dot.title = title;
  dot.setAttribute('aria-label', title);
  dot.addEventListener('click', (e) => { e.stopPropagation(); onClose(e); });
  return dot;
}

// Modais: a bolinha dispara o clique-no-overlay (`modal.click()`), reusando o
// handler de clique-fora que cada modal já tem (e.target === modal → fecha
// corretamente, com toda a limpeza: reloadPhotos, reset de iframe, aria, etc.).
for (const content of document.querySelectorAll('.modal > .modal-content')) {
  const modal = content.closest('.modal');
  if (!modal) continue;
  content.appendChild(makeCloseDot(() => modal.click()));
}

// Bolinha verde de maximizar (estilo macOS) nos modais em iframe: alterna entre
// janela e tela cheia (classe .maximized no .modal-content), persistido por
// chave. Usada na galeria e no censo.
function addMaximizeDot(modalEl, key, defaultOn = false) {
  const content = modalEl?.querySelector('.modal-content');
  if (!content) return;
  const dot = document.createElement('button');
  dot.type = 'button';
  dot.className = 'maximize-dot';
  const setMax = (on, persist) => {
    content.classList.toggle('maximized', on);
    dot.setAttribute('aria-pressed', String(on));
    dot.title = on ? 'Restaurar' : 'Maximizar';
    dot.setAttribute('aria-label', dot.title);
    if (persist) { try { localStorage.setItem(key, on ? '1' : '0'); } catch (_) {} }
  };
  dot.addEventListener('click', (e) => {
    e.stopPropagation();   // não borbulha pro overlay (que fecharia o modal)
    setMax(!content.classList.contains('maximized'), true);
  });
  content.appendChild(dot);
  // Sem preferência salva ainda, usa `defaultOn` (ex.: galeria já maximizada
  // por padrão no celular); uma vez que a pessoa mexe na bolinha, a escolha
  // dela persiste e passa a valer sempre.
  let saved = defaultOn;
  try {
    const stored = localStorage.getItem(key);
    if (stored !== null) saved = stored === '1';
  } catch (_) {}
  setMax(saved, false);
}
addMaximizeDot(imagensModal, 'phidro:galleryMaximized', window.matchMedia('(max-width: 760px)').matches);
addMaximizeDot(censoModal, 'phidro:censoMaximized');
addMaximizeDot(uploadModal, 'phidro:uploadModalMaximized');
addMaximizeDot(tourModal, 'phidro:tourModalMaximized');

// Sidebar de Rotas: a bolinha fecha o painel (mesmo caminho do ☰/toggle). Como
// só é clicável com a sidebar aberta, o toggle sempre fecha.
document.getElementById('sidebar')?.appendChild(
  makeCloseDot(() => toggleRoutesSidebar(), 'Fechar rotas'),
);

// ─── Modal de Configurações ───────────────────────────────────────────────
const settingsBtn        = document.getElementById('settings-btn');
const settingsModal      = document.getElementById('settings-modal');
const settingsClose      = document.getElementById('settings-close');
const photosImportBtn    = document.getElementById('photos-import-btn');
const photosImportInput  = document.getElementById('photos-import-input');
const photosExportTtlBtn = document.getElementById('photos-export-ttl-btn');
const photosExportKitBtn = document.getElementById('photos-export-kit-btn');
const photosReloadBtn    = document.getElementById('photos-reload-btn');

// Aplica TODOS os settings vivos (sem reload). Chamado quando algo muda no
// modal ou quando carrega um JSON-LD importado.
function applyPhotoHoverScale() {
  const s = settings.markerLayout?.hoverScale ?? 3.3;
  document.documentElement.style.setProperty('--photo-hover-scale', String(s));
}
function applyAllSettings() {
  applyPhotoAnim();      // liga/desliga animação + tickMs novo
  relaxPhotoMarkers();   // novos floor/ceil/boost pegam efeito agora
  applyPhotoHoverScale();
  applyClipsGhostSettings();
  applyClipMarkerSettings();
  applyAudioLoopSettings();
  applyImagesSettings();
  applyFovConeSettings();
  applyLiveLocation();   // liga/desliga transmissão + leitura de posições ao vivo
}
// Cone de visada: a opacidade pega efeito via CSS var (live), mas o
// enable/disable e a escala reconstroem o ícone — então recarregamos as
// fotos quando esses dois mudam. Igual ao truque do useLarge.
let _lastFovEnabled = null;
let _lastFovScale = null;
function applyFovConeSettings() {
  const op = Number.isFinite(settings.fovCone?.opacity) ? settings.fovCone.opacity : 0.45;
  document.documentElement.style.setProperty('--photo-cone-opacity', String(op));
  const enabled = settings.fovCone?.enabled !== false;
  const scale = Number.isFinite(settings.fovCone?.sizeScale) ? settings.fovCone.sizeScale : 1;
  const structuralChange = (_lastFovEnabled !== null && _lastFovEnabled !== enabled)
                        || (_lastFovScale   !== null && _lastFovScale   !== scale);
  _lastFovEnabled = enabled;
  _lastFovScale   = scale;
  if (structuralChange
      && typeof reloadPhotos === 'function'
      && typeof photoMarkers !== 'undefined' && photoMarkers.length) {
    reloadPhotos();
  }
}
// `images.useLarge` é lido em tempo de criação dos markers — pra refletir
// uma mudança no toggle, precisamos reconstruir. `reloadPhotos` faz isso.
// Só dispara um reload se o valor REALMENTE mudou desde a última aplicação.
let _lastUseLarge = null;
function applyImagesSettings() {
  const v = settings.images?.useLarge === true;
  if (_lastUseLarge === v) return;
  _lastUseLarge = v;
  if (typeof reloadPhotos === 'function' && typeof photoMarkers !== 'undefined' && photoMarkers.length) {
    reloadPhotos();
  }
}
// Empurra os params do marker de clipe como custom properties no <html>;
// o CSS lê `--clip-marker-size`, `--clip-marker-border`, `--clip-min-scale`,
// `--clip-max-scale` em vez de valores hardcoded.
function applyClipMarkerSettings() {
  const m = settings.clipMarker || {};
  const root = document.documentElement.style;
  if (Number.isFinite(m.baseSizePx)) root.setProperty('--clip-marker-size', `${m.baseSizePx}px`);
  if (Number.isFinite(m.borderPx))   root.setProperty('--clip-marker-border', `${m.borderPx}px`);
  if (Number.isFinite(m.minScale))   root.setProperty('--clip-min-scale', String(m.minScale));
  if (Number.isFinite(m.maxScale))   root.setProperty('--clip-max-scale', String(m.maxScale));
}
applyClipMarkerSettings();
// Reage a mudanças no `settings.clipsGhost.enabled` quando o slider de
// Ajustes muda em tempo real. Se Animação está ligada e o vídeo foi
// desabilitado, para a reprodução; se foi habilitado e Animação está ligada,
// reinicia. (segmentSec / fadeSec pegam efeito no próximo clipe via
// `clipSegmentS()`/`clipFadeS()`.)
function applyClipsGhostSettings() {
  if (typeof settings === 'undefined') return;
  const animOn = settings.spotlight?.enabled;
  const wantClips = settings.clipsGhost?.enabled !== false;
  const isPlaying = clipsGhostVideo && !clipsGhostVideo.paused;
  if (animOn && wantClips && !isPlaying) {
    startClipsGhost();
  } else if (isPlaying && (!animOn || !wantClips)) {
    stopClipsGhost();
  }
  syncLayerCheckbox('clips-ghost', wantClips);
}
// Mantém o checkbox de Camadas em sincronia com o setting (quando o usuário
// muda em Ajustes, o painel reflete; e vice-versa). Não dispara `change`
// pra evitar laço recursivo.
function syncLayerCheckbox(layerId, checked) {
  const row = document.querySelector(`.layer-panel .layer-row[data-id="${CSS.escape(layerId)}"]`);
  const cb = row?.querySelector('input[type="checkbox"]');
  if (cb && cb.checked !== !!checked) cb.checked = !!checked;
}

// ── Audio loop ────────────────────────────────────────────────────────────
// Loop ambiente independente do vídeo: pega o `audio` de cada clipe e toca
// em sequência aleatória com crossfade. Dois `<audio>` elements são tocados
// em paralelo durante o crossfade — A esmaece, B aparece, e na próxima vez
// trocam de papel.
const audioLoopA = new Audio();
const audioLoopB = new Audio();
audioLoopA.preload = 'auto';
audioLoopB.preload = 'auto';
audioLoopA.volume = 0;
audioLoopB.volume = 0;
let audioLoopCurrent = audioLoopA;
let audioLoopNext    = audioLoopB;
let audioLoopActive  = false;
// Mesma ideia do clipsGhostUserOpacity: o teto inicial sai do `defaultPct`
// do `audio-loop` em OVERLAY_LAYERS.
let audioLoopUserVolume = (
  (OVERLAY_LAYERS.find((l) => l.id === 'audio-loop')?.defaultPct ?? 80) / 100
);
function setAudioLoopUserVolume(frac) {
  audioLoopUserVolume = Math.max(0, Math.min(1, frac));
  // Clampa o volume das trilhas em curso pra não estourar o novo teto.
  for (const el of [audioLoopA, audioLoopB]) {
    if (el && !el.paused) el.volume = Math.min(el.volume, audioLoopUserVolume);
  }
}
let audioLoopTimer   = null;
let audioLoopIndex   = -1;
let audioLoopFadeRafs = new WeakMap();   // raf id por elemento

function fadeAudioElement(el, targetVol, durationMs) {
  const prev = audioLoopFadeRafs.get(el);
  if (prev) cancelAnimationFrame(prev);
  const startVol = el.volume;
  const t0 = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - t0) / durationMs);
    el.volume = Math.max(0, Math.min(1, startVol + (targetVol - startVol) * t));
    if (t < 1) audioLoopFadeRafs.set(el, requestAnimationFrame(step));
    else audioLoopFadeRafs.delete(el);
  };
  audioLoopFadeRafs.set(el, requestAnimationFrame(step));
}

function pickNextAudioClipIndex() {
  if (!clipsCatalog || clipsCatalog.length === 0) return -1;
  const candidates = [];
  for (let i = 0; i < clipsCatalog.length; i++) {
    if (clipsCatalog[i].audio && i !== audioLoopIndex) candidates.push(i);
  }
  if (candidates.length === 0) {
    // Só sobrou o atual (ou nenhum) — repete mesmo.
    for (let i = 0; i < clipsCatalog.length; i++) if (clipsCatalog[i].audio) return i;
    return -1;
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
}

async function startAudioLoop() {
  if (audioLoopActive) return;
  if (!settings.audioLoop?.enabled) return;
  await loadClipsCatalog();
  if (!clipsCatalog || clipsCatalog.length === 0) return;
  audioLoopActive = true;
  audioLoopAdvance();
}

function stopAudioLoop() {
  audioLoopActive = false;
  if (audioLoopTimer) { clearTimeout(audioLoopTimer); audioLoopTimer = null; }
  for (const el of [audioLoopA, audioLoopB]) {
    const r = audioLoopFadeRafs.get(el);
    if (r) cancelAnimationFrame(r);
    audioLoopFadeRafs.delete(el);
    try { el.pause(); } catch {}
    el.volume = 0;
  }
}

function audioLoopAdvance() {
  if (!audioLoopActive) return;
  const next = pickNextAudioClipIndex();
  if (next < 0) return;
  audioLoopIndex = next;
  const c = clipsCatalog[next];
  const segS  = Math.max(2, settings.audioLoop?.segmentSec ?? 12);
  const xfS   = Math.max(0.5, Math.min(settings.audioLoop?.crossfadeSec ?? 3, segS / 2));

  // Próxima trilha carrega no elemento "next" e sobe de 0 até 1; current
  // desce simultaneamente. Depois trocamos papel.
  audioLoopNext.src = CLIPS_DIR + c.audio.split('/').map(encodeURIComponent).join('/');
  audioLoopNext.currentTime = 0;
  audioLoopNext.volume = 0;
  audioLoopNext.play().catch(() => {});
  fadeAudioElement(audioLoopNext, audioLoopUserVolume, xfS * 1000);
  fadeAudioElement(audioLoopCurrent, 0, xfS * 1000);

  // Swap roles pro próximo ciclo.
  const justStarted = audioLoopNext;
  audioLoopNext = audioLoopCurrent;
  audioLoopCurrent = justStarted;

  // Agenda próxima troca pra `segS - xfS` (assim o crossfade encavala bonito
  // no fim do segmento, não depois).
  audioLoopTimer = setTimeout(audioLoopAdvance, Math.max(1, (segS - xfS)) * 1000);
}

function applyAudioLoopSettings() {
  if (typeof settings === 'undefined') return;
  const want = settings.audioLoop?.enabled === true;
  if (want && !audioLoopActive) {
    // Browsers bloqueiam play() de áudio sem gesto do usuário. No boot
    // (sem cliques ainda) o `audio.play()` rejeita silencioso. Em vez de
    // tentar e falhar, esperamos o primeiro gesto na página e só então
    // iniciamos. Se o usuário trocou o setting via Ajustes (que JÁ é um
    // gesto), o `audioGestureUnlocked` flag pula a espera.
    if (audioGestureUnlocked) startAudioLoop();
    else armAudioLoopGestureUnlock();
  } else if (!want && audioLoopActive) {
    stopAudioLoop();
    disarmAudioLoopGestureUnlock();
  }
  syncLayerCheckbox('audio-loop', want);
}

// Marca uma vez que o usuário interagiu — qualquer pointerdown/keydown
// libera autoplay pelo resto da sessão.
let audioGestureUnlocked = false;
document.addEventListener('pointerdown', () => { audioGestureUnlocked = true; },
  { capture: true, once: true });
document.addEventListener('keydown', () => { audioGestureUnlocked = true; },
  { capture: true, once: true });

let audioLoopGestureHandler = null;
function armAudioLoopGestureUnlock() {
  if (audioLoopGestureHandler) return;
  audioLoopGestureHandler = () => {
    disarmAudioLoopGestureUnlock();
    audioGestureUnlocked = true;
    if (settings.audioLoop?.enabled && !audioLoopActive) startAudioLoop();
  };
  document.addEventListener('pointerdown', audioLoopGestureHandler, { capture: true, once: true });
  document.addEventListener('keydown', audioLoopGestureHandler, { capture: true, once: true });
  document.addEventListener('touchstart', audioLoopGestureHandler, { capture: true, once: true });
}
function disarmAudioLoopGestureUnlock() {
  if (!audioLoopGestureHandler) return;
  document.removeEventListener('pointerdown', audioLoopGestureHandler, true);
  document.removeEventListener('keydown', audioLoopGestureHandler, true);
  document.removeEventListener('touchstart', audioLoopGestureHandler, true);
  audioLoopGestureHandler = null;
}
applyPhotoHoverScale();
// Aplica as configs persistidas no boot — sem isso, sliders/checkboxes do
// painel Camadas ficam dessincronizados do estado real do app, e o loop de
// áudio salvo como `enabled: true` só pegaria efeito após a primeira
// interação manual.
applyClipsGhostSettings();
applyAudioLoopSettings();

// Lê/escreve em settings por caminho "a.b.c".
function getSettingPath(path) {
  return path.split('.').reduce((o, k) => o?.[k], settings);
}
function setSettingPath(path, value) {
  const parts = path.split('.');
  let o = settings;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
  o[parts[parts.length - 1]] = value;
}
function syncSettingsControl(el) {
  const val = getSettingPath(el.dataset.setting);
  if (el.type === 'checkbox') {
    el.checked = !!val;
  } else if (el.type === 'range' || el.type === 'number') {
    el.value = String(val);
    const out = el.parentElement?.querySelector('output');
    if (out) out.textContent = el.value;
  } else {
    el.value = String(val);
  }
}
function wireSettingsControls() {
  if (!settingsModal) return;
  for (const el of settingsModal.querySelectorAll('[data-setting]')) {
    syncSettingsControl(el);
    el.addEventListener('input', () => {
      const path = el.dataset.setting;
      let v;
      if (el.type === 'checkbox') v = el.checked;
      else if (el.type === 'range' || el.type === 'number') v = parseFloat(el.value);
      else v = el.value;
      setSettingPath(path, v);
      const out = el.parentElement?.querySelector('output');
      if (out && el.type === 'range') out.textContent = el.value;
      saveSettings();
      applyAllSettings();
    });
  }
}

function openSettings() {
  if (!settingsModal) return;
  closeOtherMobileDialogs('settings');
  // Radios da fonte de imagens (não usam data-setting porque setPhotoSource
  // faz mais que só mexer no objeto).
  for (const r of settingsModal.querySelectorAll('input[name="photos-source"]')) {
    r.checked = (r.value === photoSource);
  }
  updatePhotoSourceStatus(lastTtlOrigin ? 'OK' : 'sem TTL carregado');
  for (const el of settingsModal.querySelectorAll('[data-setting]')) {
    syncSettingsControl(el);
  }
  settingsModal.hidden = false;
  settingsBtn?.setAttribute('aria-pressed', 'true');
}
function closeSettings() {
  if (settingsModal) settingsModal.hidden = true;
  settingsBtn?.setAttribute('aria-pressed', 'false');
}

settingsBtn?.addEventListener('click', () => {
  if (settingsModal && !settingsModal.hidden) {
    closeSettings();
    return;
  }
  openSettings();
});
settingsClose?.addEventListener('click', closeSettings);
settingsModal?.addEventListener('click', (e) => {
  if (e.target === settingsModal) closeSettings();
});
for (const r of settingsModal?.querySelectorAll('input[name="photos-source"]') || []) {
  r.addEventListener('change', () => setPhotoSource(r.value));
}
photosImportBtn?.addEventListener('click', () => photosImportInput?.click());
photosImportInput?.addEventListener('change', async () => {
  const f = photosImportInput.files && photosImportInput.files[0];
  if (!f) return;
  try { await importPhotosLocal(f); }
  catch (err) { showToast(`Falha no import: ${err.message}`); }
  photosImportInput.value = '';
});
photosExportTtlBtn?.addEventListener('click', downloadTtl);
photosExportKitBtn?.addEventListener('click', () => {
  downloadKit().catch(err => showToast(`Falha no kit: ${err.message}`));
});
photosReloadBtn?.addEventListener('click', () => reloadPhotos());
wireSettingsControls();

// Export / Import dos settings em JSON-LD.
const SETTINGS_JSONLD_CONTEXT = {
  '@vocab': 'https://pedalhidrografi.co/terms/settings#',
  ph:        'https://id.pedalhidrografi.co/terms#',
};
// Snapshot do estado atual dos controles do painel Camadas (checkbox de
// visibilidade + slider de opacidade) por ID de layer. Fica fora de
// `settings` porque a fonte de verdade é o DOM da Leaflet, não o objeto JS.
function collectLayerStates() {
  const panel = document.querySelector('.layer-panel');
  if (!panel) return null;
  const out = {};
  panel.querySelectorAll('.layer-row').forEach((row) => {
    const id = row.dataset.id;
    if (!id) return;
    const cb = row.querySelector('input[type="checkbox"]');
    const rb = row.querySelector('input[type="radio"]');
    const slider = row.querySelector('input.opacity-slider');
    out[id] = {
      visible: cb ? cb.checked : (rb ? rb.checked : null),
      pct: slider ? Number(slider.value) : null,
    };
  });
  return out;
}
function applyLayerStates(states) {
  if (!states || typeof states !== 'object') return;
  const panel = document.querySelector('.layer-panel');
  if (!panel) return;
  for (const [id, state] of Object.entries(states)) {
    const row = panel.querySelector(`.layer-row[data-id="${CSS.escape(id)}"]`);
    if (!row) continue;
    if (state.visible !== null && state.visible !== undefined) {
      const cb = row.querySelector('input[type="checkbox"]');
      const rb = row.querySelector('input[type="radio"]');
      if (cb) {
        cb.checked = !!state.visible;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (rb && state.visible) {
        rb.checked = true;
        rb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    if (Number.isFinite(state.pct)) {
      const slider = row.querySelector('input.opacity-slider');
      if (slider) {
        slider.value = String(state.pct);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  }
}
// URL dos layers customizáveis (XYZ + WMS) vive em localStorage —
// preservamos como parte do export pra trazer junto.
function collectCustomLayers() {
  let wms = null;
  try { wms = JSON.parse(localStorage.getItem('phidro:customWms') || 'null'); }
  catch { wms = null; }
  return {
    xyz: localStorage.getItem('phidro:customXyz') || null,
    wms,
  };
}
function applyCustomLayers(cfg) {
  if (!cfg) return;
  if (cfg.xyz) {
    localStorage.setItem('phidro:customXyz', cfg.xyz);
    if (typeof ensureCustomXyz === 'function') ensureCustomXyz(cfg.xyz);
  }
  if (cfg.wms) {
    localStorage.setItem('phidro:customWms', JSON.stringify(cfg.wms));
    if (typeof ensureCustomWms === 'function') ensureCustomWms(cfg.wms);
  }
}

function downloadSettingsJsonLd() {
  const doc = {
    '@context': SETTINGS_JSONLD_CONTEXT,
    '@type': 'AppSettings',
    generatedAt: new Date().toISOString(),
    ...JSON.parse(JSON.stringify(settings)),
    layers: collectLayerStates(),
    customLayers: collectCustomLayers(),
  };
  const blob = new Blob([JSON.stringify(doc, null, 2)],
    { type: 'application/ld+json' });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `phidro-settings-${stamp}.jsonld`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  showToast('Configurações exportadas.');
}
async function importSettingsJsonLd(file) {
  const text = await file.text();
  let doc;
  try { doc = JSON.parse(text); }
  catch { throw new Error('JSON inválido'); }
  // Separa as duas chaves "fora-do-settings" (camadas e custom layers) do
  // resto antes do deep-merge — elas têm fluxos de aplicação próprios.
  const { '@context': _c, '@type': _t, generatedAt: _g,
          layers: layersState, customLayers, ...rest } = doc;
  const merged = _deepMerge(SETTINGS_DEFAULTS, _deepMerge(settings, rest));
  // Cuidado: a fonte de imagens muda via setPhotoSource pra disparar reload.
  // Migra valores legados ('pi'/'cdn'/'auto') — um JSON-LD exportado de uma
  // sessão antiga pode trazê-los, e setPhotoSource só aceita 'server'/'local'.
  merged.photoSource = _migratePhotoSourceValue(merged.photoSource);
  const newPhotoSource = merged.photoSource;
  Object.assign(settings, merged);
  saveSettings();
  if (newPhotoSource && newPhotoSource !== photoSource) {
    setPhotoSource(newPhotoSource);
  }
  for (const el of settingsModal?.querySelectorAll('[data-setting]') || []) {
    syncSettingsControl(el);
  }
  applyAllSettings();
  applyCustomLayers(customLayers);
  // Aplica estados das camadas DEPOIS — os controles podem ter sido
  // recriados pela inicialização de camadas customizáveis acima.
  applyLayerStates(layersState);
  showToast('Configurações importadas.');
}
document.getElementById('settings-export-btn')?.addEventListener(
  'click', downloadSettingsJsonLd);
const settingsImportInput = document.getElementById('settings-import-input');
document.getElementById('settings-import-btn')?.addEventListener(
  'click', () => settingsImportInput?.click());
settingsImportInput?.addEventListener('change', async () => {
  const f = settingsImportInput.files && settingsImportInput.files[0];
  if (!f) return;
  try { await importSettingsJsonLd(f); }
  catch (err) { showToast(`Falha no import: ${err.message}`); }
  settingsImportInput.value = '';
});
document.getElementById('settings-reset-btn')?.addEventListener('click', () => {
  if (!confirm('Restaurar todos os parâmetros para os padrões?')) return;
  Object.assign(settings, JSON.parse(JSON.stringify(SETTINGS_DEFAULTS)));
  saveSettings();
  for (const el of settingsModal?.querySelectorAll('[data-setting]') || []) {
    syncSettingsControl(el);
  }
  applyAllSettings();
  showToast('Padrões restaurados.');
});

// ─── Cicloinfra (OSM) — estilo e rótulo ──────────────────────────────────────
// O que é "seguro-ish" pra bicicleta, conforme assado no FGB por
// scripts/build-viario.py (mesmo predicado da consulta Overpass anterior):
//   highway=cycleway                          ciclovia segregada
//   highway=path + bicycle=yes/designated     caminho compartilhado
//   highway=* + cycleway[:left|:right|:both]  via com ciclofaixa/faixa
//               = lane/track/…
// Tudo no mesmo ciano de destaque; espessura + tracejado sinalizam o tipo.
// A camada em si (cicloinfraLayer) fica lá em cima, junto da Morros e Águas.
//
// ATENÇÃO aos nomes das colunas: o GDAL SANEIA `cycleway:left` pra
// `cycleway_left` ao assar o FGB, então é assim que chegam aqui — nada de
// `tags['cycleway:left']`, que era a forma do Overpass.
function classifyCycloinfra(p) {
  if (p.highway === 'cycleway') return 'ciclovia';
  if (p.highway === 'path') return 'caminho compartilhado';
  if (p.cycleway || p.cycleway_left || p.cycleway_right || p.cycleway_both) {
    return 'ciclofaixa';
  }
  return '';
}

function styleForCycloinfra(p, detail) {
  const kind = classifyCycloinfra(p);
  // Ciclovia (segregada): contínua + grossa. Ciclofaixa (pintada na via):
  // tracejada + fina. Caminho compartilhado: pontilhado.
  if (kind === 'ciclovia') return { color: '#00BFA6', weight: 4 };
  // Numa bbox grande, só a malha segregada — ciclofaixa e caminho
  // compartilhado são tracejados finos que somem visualmente nessa escala e
  // respondem pelo grosso das feições.
  if (detail === DETAIL_MAIN) return null;
  if (kind === 'caminho compartilhado') {
    return { color: '#00BFA6', weight: 3, dashArray: '2 5' };
  }
  if (kind === 'ciclofaixa') {
    return { color: '#00BFA6', weight: 3, dashArray: '6 4' };
  }
  return { color: '#00BFA6', weight: 2 };
}

function cicloinfraTipFor(p) {
  const parts = [];
  if (p.name) parts.push(`<strong>${escapeHtml(p.name)}</strong>`);
  const kind = classifyCycloinfra(p);
  if (kind) parts.push(`<em>${kind}</em>`);
  if (p.surface) parts.push(`piso: ${escapeHtml(p.surface)}`);
  return parts.join(' · ') || 'cicloinfra';
}

// ─── Custom XYZ / WMS layers ─────────────────────────────────────────────────
let customXyzUrl = localStorage.getItem('phidro:customXyz') || '';
let customXyzLayer = null;
let customWmsConfig = (() => {
  try { return JSON.parse(localStorage.getItem('phidro:customWms') || 'null'); }
  catch { return null; }
})();
let customWmsLayer = null;

function ensureCustomXyz(url) {
  if (!url) return null;
  if (customXyzLayer && customXyzUrl === url) return customXyzLayer;
  if (customXyzLayer && map.hasLayer(customXyzLayer)) map.removeLayer(customXyzLayer);
  customXyzUrl = url;
  customXyzLayer = L.tileLayer(url, {
    maxZoom: 22,
    opacity: 0.8,
    pane: LAYER_PANE('custom-xyz'),
    attribution: 'XYZ custom',
  });
  localStorage.setItem('phidro:customXyz', url);
  return customXyzLayer;
}

function showCustomXyz() {
  if (!customXyzUrl) {
    promptCustomXyzUrl();
    if (!customXyzUrl) {
      // user cancelled — uncheck the box again
      const cb = document.querySelector('input[type="checkbox"][data-id="custom-xyz"]');
      if (cb) cb.checked = false;
      return;
    }
  }
  ensureCustomXyz(customXyzUrl);
  if (customXyzLayer && !map.hasLayer(customXyzLayer)) customXyzLayer.addTo(map);
}
function hideCustomXyz() {
  if (customXyzLayer && map.hasLayer(customXyzLayer)) map.removeLayer(customXyzLayer);
}

function promptCustomXyzUrl() {
  const url = prompt(
    'URL do tile XYZ (use {z}/{x}/{y} como placeholders):\n' +
      'Ex: https://server.example.com/tiles/{z}/{x}/{y}.png',
    customXyzUrl,
  );
  if (url == null) return;
  const trimmed = url.trim();
  if (!trimmed) {
    customXyzUrl = '';
    localStorage.removeItem('phidro:customXyz');
    hideCustomXyz();
    return;
  }
  ensureCustomXyz(trimmed);
  if (customXyzLayer && !map.hasLayer(customXyzLayer)) customXyzLayer.addTo(map);
  // Tick the checkbox in case it was unchecked
  const cb = document.querySelector('input[type="checkbox"][data-id="custom-xyz"]');
  if (cb) cb.checked = true;
  showToast(`XYZ custom carregado`);
}

function ensureCustomWms(cfg) {
  if (!cfg || !cfg.service || !cfg.layers) return null;
  const sameAsBefore = customWmsLayer && customWmsConfig &&
    customWmsConfig.service === cfg.service &&
    customWmsConfig.layers === cfg.layers &&
    customWmsConfig.version === cfg.version;
  if (sameAsBefore) return customWmsLayer;
  if (customWmsLayer && map.hasLayer(customWmsLayer)) map.removeLayer(customWmsLayer);
  customWmsConfig = cfg;
  customWmsLayer = L.tileLayer.wms(cfg.service, {
    layers: cfg.layers,
    format: 'image/png',
    transparent: true,
    version: cfg.version || '1.3.0',
    opacity: 0.8,
    maxZoom: 22,
    pane: LAYER_PANE('custom-wms'),
    attribution: 'WMS custom',
  });
  localStorage.setItem('phidro:customWms', JSON.stringify(cfg));
  return customWmsLayer;
}

function showCustomWms() {
  if (!customWmsConfig) {
    promptCustomWmsConfig();
    if (!customWmsConfig) {
      const cb = document.querySelector('input[type="checkbox"][data-id="custom-wms"]');
      if (cb) cb.checked = false;
      return;
    }
  }
  ensureCustomWms(customWmsConfig);
  if (customWmsLayer && !map.hasLayer(customWmsLayer)) customWmsLayer.addTo(map);
}
function hideCustomWms() {
  if (customWmsLayer && map.hasLayer(customWmsLayer)) map.removeLayer(customWmsLayer);
}

function promptCustomWmsConfig() {
  const service = prompt(
    'URL do servidor WMS:\nEx: https://example.com/geoserver/wms',
    customWmsConfig?.service || '',
  );
  if (service == null) return;
  const s = service.trim();
  if (!s) {
    customWmsConfig = null;
    localStorage.removeItem('phidro:customWms');
    hideCustomWms();
    return;
  }
  const layers = prompt(
    'Nome da camada WMS (use vírgula para múltiplas):\nEx: workspace:layerName',
    customWmsConfig?.layers || '',
  );
  if (layers == null) return;
  const l = layers.trim();
  if (!l) return;
  ensureCustomWms({ service: s, layers: l, version: customWmsConfig?.version || '1.3.0' });
  if (customWmsLayer && !map.hasLayer(customWmsLayer)) customWmsLayer.addTo(map);
  const cb = document.querySelector('input[type="checkbox"][data-id="custom-wms"]');
  if (cb) cb.checked = true;
  showToast(`WMS custom carregado`);
}

// "Where am I" control (leaflet-locatecontrol). Adds the small target icon
// in the top-left of the map AND wires the topbar "📍 Localização" button
// to trigger it programmatically — same control instance, two affordances.
let locateControl = null;
if (L.control.locate) {
  locateControl = L.control.locate({
    position: 'topleft',
    // 'once': centraliza/zooma só no PRIMEIRO fix; depois disso o mapa não se
    // mexe mais (cada update do watchPosition reposicionava + re-zoomava pra
    // caber o círculo de precisão, que vai encolhendo → ficava dando zoom).
    setView: 'once',
    flyTo: true,
    cacheLocation: true,
    drawCircle: true,
    showPopup: false,
    keepCurrentZoomLevel: false,
    locateOptions: { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    strings: {
      title: 'Mostrar minha localização',
      metersUnit: 'm',
      feetUnit: 'ft',
      popup: 'Você está a até {distance} {unit} deste ponto',
      outsideMapBoundsMsg: 'Fora dos limites do mapa',
    },
  }).addTo(map);
}
const locateBtn = document.getElementById('locate-btn');
locateBtn?.addEventListener('click', () => {
  if (!locateControl) {
    alert('Geolocalização não disponível neste navegador.');
    return;
  }
  // Toggle behavior: tap once to start tracking, tap again to stop.
  if (locateControl._active) locateControl.stop();
  else locateControl.start();
});

// ─── Localização ao vivo ──────────────────────────────────────────────────
// Compartilhamento de posição em tempo (quase) real: opt-in, pseudônimo,
// efêmero. O mesmo substrato roda em três cenários: (a) browser com tela
// ligada/app em foco → watchPosition; (b) browser em segundo plano → pausa
// (limite da plataforma); (c) shell nativo (Capacitor) → o plugin de
// background-geolocation chama `window.phidroLivePush(coords)` mesmo com a
// tela apagada. Ver o plano de implementação. Toda a visualização é idêntica
// independente da fonte do fix.
const LIVE_ID_KEY = 'phidro:liveId';
// Único ponto que monta a URL dos endpoints /live-*: no browser fica
// same-origin (base vazia); o shell nativo seta window.PHIDRO_API_BASE
// (ou carrega o site via server.url, caso em que isto também fica vazio).
function liveApiUrl(path) { return (window.PHIDRO_API_BASE || '') + path; }
function liveId() {
  let id = null;
  try { id = localStorage.getItem(LIVE_ID_KEY); } catch {}
  if (!id || !/^[0-9a-fA-F-]{1,64}$/.test(id)) {
    id = (crypto?.randomUUID?.() || (Date.now().toString(16) + Math.random().toString(16).slice(2)))
      .replace(/[^0-9a-fA-F-]/g, '').slice(0, 64);
    try { localStorage.setItem(LIVE_ID_KEY, id); } catch {}
  }
  return id;
}
// Cor estável por pessoa: hash do id → matiz. Mesma pessoa, mesma cor entre
// atualizações; pessoas diferentes ficam distinguíveis.
function liveColorForId(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 72%, 48%)`;
}

let _liveWatchId = null;       // id do navigator.geolocation.watchPosition
let _livePollTimer = null;     // setInterval da leitura
let _livePollMs = null;        // intervalo (ms) atualmente aplicado — só recria o timer se mudar
let _liveLastSentMs = 0;       // throttle do envio (settings.liveLocation.shareMs)
let _liveGeoErrShown = false;  // já avisei de falha de GPS (code 2/3) nesta sessão de envio?
// Ver e transmitir são independentes: dá pra ver as pessoas no mapa sem
// transmitir a própria posição (e vice-versa). Cada um tem seu flag de
// estado aplicado pra evitar start/stop repetido.
let _liveViewing = false;      // poll + render ligado
let _liveSharing = false;      // transmissão da minha posição ligada
let _liveBandOpacity = 0.7;    // opacidade dos pontos do rastro (slider em Pessoas ao vivo)
const _personMarkers = new Map();   // token -> { marker, trail, ticks, tickDots, last }
// Ajustes por pessoa (clique no dot abre um popup): { token: {color?, opacity?, hideHistory?} }.
// Persistido localmente, aplicado em upsertPersonMarker.
const LIVE_OVERRIDES_KEY = 'phidro:livePersonOverrides';
let _personOverrides = {};
try { _personOverrides = JSON.parse(localStorage.getItem(LIVE_OVERRIDES_KEY)) || {}; } catch { _personOverrides = {}; }
function saveLiveOverrides() {
  try { localStorage.setItem(LIVE_OVERRIDES_KEY, JSON.stringify(_personOverrides)); } catch {}
}
// Os ajustes-por-pessoa usam tokens efêmeros como chave; sem poda o mapa cresce
// pra sempre no localStorage. `ts` é gravado quando o usuário mexe nos ajustes
// de alguém (reapply abaixo). Entradas sem ts (legado) ganham carimbo agora; as
// não-tocadas há mais de 30 dias são descartadas.
const LIVE_OVERRIDE_TTL_MS = 30 * 24 * 3600 * 1000;
function pruneLiveOverrides() {
  const now = Date.now();
  let changed = false;
  for (const [token, ov] of Object.entries(_personOverrides)) {
    if (!ov || typeof ov !== 'object') { delete _personOverrides[token]; changed = true; continue; }
    if (!Number.isFinite(ov.ts)) { ov.ts = now; changed = true; }
    else if (now - ov.ts > LIVE_OVERRIDE_TTL_MS) { delete _personOverrides[token]; changed = true; }
  }
  if (changed) saveLiveOverrides();
}
pruneLiveOverrides();

function livePeoplePane() {
  if (!map.getPane('livePeople')) {
    const pane = map.createPane('livePeople');
    pane.style.zIndex = '660';   // acima de clipMarkers (650) e fotos (600)
  }
  return 'livePeople';
}
function liveTrailsPane() {
  if (!map.getPane('liveTrails')) {
    const pane = map.createPane('liveTrails');
    pane.style.zIndex = '655';   // linhas de rastro abaixo dos dots (660)
  }
  return 'liveTrails';
}
// divIcon de uma pessoa ao vivo — anel colorido + inicial + (opcional) seta
// de rumo. Classe própria (.live-person), distinta do .photo-dot. `stale`
// (sem fix recente) tira o pulso "ao vivo" via .is-stale.
function personDivIcon(p, mine, stale, color) {
  color = color || (mine ? '#1e88e5' : liveColorForId(p.id));
  const initial = (p.name || '').trim().charAt(0).toUpperCase() || '•';
  const heading = Number.isFinite(p.heading) ? p.heading : null;
  const arrow = heading != null
    ? `<div class="live-person-arrow" style="transform:translate(-50%,-50%) rotate(${heading}deg) translateY(-20px)"></div>` : '';
  const label = p.name
    ? `<div class="live-person-label">${escapeHtml(p.name)}</div>` : '';
  const cls = 'live-person' + (mine ? ' is-me' : '') + (stale ? ' is-stale' : '');
  return L.divIcon({
    className: 'live-person-wrap',
    html: `<div class="${cls}" style="--live-color:${color}">`
        + `${arrow}<div class="live-person-dot">${escapeHtml(initial)}</div>${label}</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -18],
  });
}

// Idade (s) → opacidade do marcador. Janela de 3h: fresco = 1, esmaece
// gradualmente e estaciona em ~0.35 depois de ~20 min sem novo fix.
function liveOpacityForAge(age) {
  if (!Number.isFinite(age)) return 1;
  return Math.max(0.35, 1 - age / 1800);
}
const LIVE_STALE_AGE_S = 120;   // sem fix há mais que isto → marcador "parado"
// Idade (s) → texto "há quanto tempo" pros tooltips dos pontos do rastro.
function formatLiveAgo(sec) {
  if (!Number.isFinite(sec)) return '';
  if (sec < 10) return 'agora';
  if (sec < 60) return `há ${Math.round(sec)} s`;
  if (sec < 3600) return `há ${Math.round(sec / 60)} min`;
  return `há ${(sec / 3600).toFixed(1).replace('.', ',')} h`;
}

function upsertPersonMarker(p, mine) {
  const ll = [p.lat, p.lng];
  const stale = Number.isFinite(p.age) && p.age > LIVE_STALE_AGE_S;
  // Ajustes por pessoa (clique no dot → popup): cor, opacidade, esconder histórico.
  const ov = _personOverrides[p.id] || {};
  const color = ov.color || (mine ? '#1e88e5' : liveColorForId(p.id));
  const opMul = Number.isFinite(ov.opacity) ? Math.max(0, Math.min(1, ov.opacity)) : 1;
  const showHistory = ov.hideHistory !== true;
  let e = _personMarkers.get(p.id);
  const icon = personDivIcon(p, mine, stale, color);
  if (!e) {
    const marker = L.marker(ll, { icon, pane: livePeoplePane(), zIndexOffset: 1000 });
    marker.addTo(map);
    marker.on('click', () => openLivePersonControls(p.id));
    e = { marker, trail: null, ticks: null, tickDots: [], last: null };
    _personMarkers.set(p.id, e);
  } else {
    e.marker.setLatLng(ll);
    e.marker.setIcon(icon);
  }
  e.last = p;   // guardado p/ reaplicar na hora quando o popup muda um ajuste
  e.marker.setOpacity(liveOpacityForAge(p.age) * opMul);

  // Trajetória = uma LINHA conectando os fixes + um PONTO em cada fix cujo raio
  // reflete a incerteza (precisão) daquele ponto. (Substitui a antiga faixa de
  // incerteza, que era um polígono problemático.) `showHistory` (toggle no
  // popup) esconde tudo, deixando só o dot atual. `p.trail` vem como
  // [lat,lng,acc,age]; passamos só [lat,lng] pra linha — L.toLatLng() devolve
  // null pra arrays de 4 elementos e estoura o _projectLatlngs no zoom.
  const pts = showHistory && Array.isArray(p.trail) ? p.trail : [];
  const line = pts.map((q) => [q[0], q[1]]);
  if (line.length >= 2) {
    if (!e.trail) {
      e.trail = L.polyline(line, { pane: liveTrailsPane(), color,
        weight: 2, opacity: 0.7 * opMul, interactive: false }).addTo(map);
    } else {
      e.trail.setLatLngs(line);
      e.trail.setStyle({ color, opacity: 0.7 * opMul });
    }
  } else if (e.trail) {
    map.removeLayer(e.trail); e.trail = null;
  }
  // Pontos do rastro: raio cresce com a incerteza (px); hover/toque mostra "há
  // quanto tempo" (q[3] = idade em s). Downsample p/ ~40 por pessoa. Reusa os
  // circleMarkers entre polls (setLatLng/setStyle), em vez de destruir+recriar
  // ~40 layers a cada poll — mesmo padrão do marcador-cabeça e da linha.
  if (!e.ticks) { e.ticks = L.layerGroup().addTo(map); e.tickDots = []; }
  const sampled = [];
  if (showHistory && pts.length) {
    const tstep = Math.max(1, Math.ceil(pts.length / 40));
    for (let k = 0; k < pts.length; k += tstep) {
      const q = pts[k];
      if (Number.isFinite(q[0]) && Number.isFinite(q[1])) sampled.push(q);
    }
  }
  for (let k = 0; k < sampled.length; k++) {
    const q = sampled[k];
    const acc = Number.isFinite(q[2]) && q[2] > 0 ? q[2] : 0;
    const radius = Math.max(2.5, Math.min(14, 2 + acc / 5));   // px ~ incerteza
    const ago = formatLiveAgo(q[3]);
    let dot = e.tickDots[k];
    if (!dot) {
      // Sem borda (stroke:false) — assim opacidade 0 some de vez.
      dot = L.circleMarker([q[0], q[1]], { pane: liveTrailsPane(), radius,
        stroke: false, fillColor: color, fillOpacity: _liveBandOpacity * opMul });
      dot.on('click', () => dot.openTooltip());   // suporte a toque
      dot.bindTooltip(ago, { direction: 'top', sticky: true });
      dot.addTo(e.ticks);
      e.tickDots[k] = dot;
    } else {
      dot.setLatLng([q[0], q[1]]);
      dot.setRadius(radius);
      dot.setStyle({ fillColor: color, fillOpacity: _liveBandOpacity * opMul });
      dot.setTooltipContent(ago);
    }
  }
  // Remove o excedente (rastro encolheu ou histórico foi escondido).
  for (let k = sampled.length; k < e.tickDots.length; k++) {
    if (e.tickDots[k]) e.ticks.removeLayer(e.tickDots[k]);
  }
  e.tickDots.length = sampled.length;
  // Tempo da posição atual no próprio dot (hover/toque).
  const ago = formatLiveAgo(p.age);
  if (e.marker.getTooltip()) e.marker.setTooltipContent(ago);
  else e.marker.bindTooltip(ago, { direction: 'top' });
}

// Popup de ajustes por pessoa — aberto ao clicar no dot. Cor, opacidade e
// toggle "mostrar histórico" (rastro + faixa + pontos). Persiste por token.
function openLivePersonControls(token) {
  const e = _personMarkers.get(token);
  if (!e) return;
  const ov = _personOverrides[token] || (_personOverrides[token] = {});
  const p = e.last || {};
  const mine = token === liveId();
  const curColor = ov.color || (mine ? '#1e88e5' : liveColorForId(token));
  const op = Number.isFinite(ov.opacity) ? Math.round(ov.opacity * 100) : 100;
  const showHist = ov.hideHistory !== true;
  const html =
    '<div class="live-ctrl">' +
    `<div class="live-ctrl-name">${escapeHtml(p.name || 'Sem apelido')}</div>` +
    `<label>Cor <input type="color" class="lc-color" value="${curColor}"></label>` +
    `<label>Opacidade <input type="range" class="lc-op" min="10" max="100" value="${op}"></label>` +
    `<label class="lc-hist-row"><input type="checkbox" class="lc-hist"${showHist ? ' checked' : ''}> Mostrar histórico</label>` +
    '<button type="button" class="lc-reset">Restaurar padrão</button>' +
    '</div>';
  const popup = L.popup({ className: 'live-ctrl-popup', closeButton: true })
    .setLatLng(e.marker.getLatLng()).setContent(html).openOn(map);
  const root = popup.getElement();
  if (!root) return;
  const reapply = () => { ov.ts = Date.now(); saveLiveOverrides(); if (e.last) upsertPersonMarker(e.last, mine); };
  root.querySelector('.lc-color').addEventListener('input', (ev) => { ov.color = ev.target.value; reapply(); });
  root.querySelector('.lc-op').addEventListener('input', (ev) => { ov.opacity = Number(ev.target.value) / 100; reapply(); });
  root.querySelector('.lc-hist').addEventListener('change', (ev) => { ov.hideHistory = !ev.target.checked; reapply(); });
  root.querySelector('.lc-reset').addEventListener('click', () => {
    delete _personOverrides[token]; saveLiveOverrides();
    if (e.last) upsertPersonMarker(e.last, mine);
    map.closePopup(popup);
  });
}

function removePersonMarker(token) {
  const e = _personMarkers.get(token);
  if (!e) return;
  if (e.marker) map.removeLayer(e.marker);
  if (e.trail) map.removeLayer(e.trail);
  if (e.ticks) map.removeLayer(e.ticks);
  _personMarkers.delete(token);
}
function clearPersonMarkers() {
  for (const token of [..._personMarkers.keys()]) removePersonMarker(token);
}

// Envio (throttled) da minha posição. Chamado tanto pelo watchPosition do
// browser quanto pelo bridge nativo (window.phidroLivePush).
function sendLivePosition(lat, lng, accuracy, heading) {
  if (!settings.liveLocation?.enabled) return;
  const now = Date.now();
  const minGap = Math.max(1000, settings.liveLocation?.shareMs || 5000);
  if (now - _liveLastSentMs < minGap) return;
  _liveLastSentMs = now;
  const body = { id: liveId(), name: (settings.liveLocation?.displayName || '').trim().slice(0, 40),
    lat, lng, ttl: settings.liveLocation?.ttlSec ?? 10800 };
  if (Number.isFinite(accuracy)) body.accuracy = accuracy;
  if (Number.isFinite(heading)) body.heading = heading;
  fetch(liveApiUrl('/live-location'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), keepalive: true,
  }).catch(() => {});
}
// Hook pro shell nativo: o plugin de background-geolocation chama isto a cada
// fix (inclusive com a tela apagada). { latitude, longitude, accuracy, bearing }.
window.phidroLivePush = (c) => {
  if (!c) return;
  sendLivePosition(c.latitude ?? c.lat, c.longitude ?? c.lng,
    c.accuracy, c.bearing ?? c.heading);
};

function pollLivePositions() {
  fetch(liveApiUrl('/live-locations'), { cache: 'no-store' })
    .then((r) => r.ok ? r.json() : null)
    .then((data) => {
      if (!data || !Array.isArray(data.positions)) return;
      const mine = liveId();
      const seen = new Set();
      for (const p of data.positions) {
        if (!p || typeof p.id !== 'string') continue;
        if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
        seen.add(p.id);
        upsertPersonMarker(p, p.id === mine);
      }
      for (const token of [..._personMarkers.keys()]) {
        if (!seen.has(token)) removePersonMarker(token);
      }
    })
    .catch(() => {});
}

// Detecta o shell nativo (Capacitor). Aí o plugin de background-geolocation
// dirige o envio (funciona com a tela apagada); no browser usamos watchPosition.
function liveIsNative() {
  return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function'
    && window.Capacitor.isNativePlatform());
}
let _liveNativeWatcher = null;
// Guarda um pedido de "parar" que chegou enquanto addWatcher() ainda estava em
// voo (janela em que _liveNativeWatcher segue null/undefined) — sem isto, o
// watcher nativo ficava rodando mesmo depois do usuário desligar o
// compartilhamento (ver startNativeBackgroundWatch/stopNativeBackgroundWatch).
let _liveWatchStopRequested = false;
// Liga o watcher de background do @capacitor-community/background-geolocation.
// O plugin é registrado pelo lado nativo do shell; aqui o acessamos pelo
// global injetado (window.Capacitor.Plugins) — sem import, então este mesmo
// código roda inalterado num browser comum (onde o plugin simplesmente não
// existe e caímos no watchPosition). Cada fix chama window.phidroLivePush.
async function startNativeBackgroundWatch() {
  const BG = window.Capacitor?.Plugins?.BackgroundGeolocation;
  if (!BG || _liveNativeWatcher) return !!BG;
  _liveWatchStopRequested = false; // descarta pedido de parada de um ciclo anterior
  try {
    _liveNativeWatcher = await BG.addWatcher({
      backgroundTitle: 'Pedal Hidrográfico',
      backgroundMessage: 'Compartilhando sua localização ao vivo',
      requestPermissions: true,
      stale: false,
      distanceFilter: 10,
    }, (location, error) => {
      if (error || !location) return;
      window.phidroLivePush(location);   // {latitude, longitude, accuracy, bearing}
    });
    if (_liveWatchStopRequested) {
      // Usuário desligou o compartilhamento enquanto o addWatcher estava em
      // voo — stopNativeBackgroundWatch não tinha o id ainda pra chamar
      // removeWatcher. Desliga agora que o id existe.
      _liveWatchStopRequested = false;
      try { await BG.removeWatcher({ id: _liveNativeWatcher }); } catch {}
      _liveNativeWatcher = null;
      return false;
    }
    return true;
  } catch { _liveNativeWatcher = null; return false; }
}
async function stopNativeBackgroundWatch() {
  const BG = window.Capacitor?.Plugins?.BackgroundGeolocation;
  if (BG && _liveNativeWatcher) {
    try { await BG.removeWatcher({ id: _liveNativeWatcher }); } catch {}
  } else {
    // BG existe mas o watcher ainda não foi atribuído (addWatcher em voo) —
    // sinaliza pro startNativeBackgroundWatch desligar assim que resolver.
    _liveWatchStopRequested = true;
  }
  _liveNativeWatcher = null;
}

function startLiveShare() {
  // No shell nativo devolve a Promise<boolean> do watcher pra applyLiveLocation
  // poder desfazer o estado se o background-geolocation não subir (permissão
  // negada / erro do plugin). No browser retorna undefined (erros são tratados
  // no callback de watchPosition).
  if (liveIsNative()) return startNativeBackgroundWatch();
  if (_liveWatchId != null || !navigator.geolocation) return;
  _liveGeoErrShown = false;
  _liveWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      _liveGeoErrShown = false;   // recuperou o sinal — pode avisar de novo se cair
      const c = pos.coords;
      sendLivePosition(c.latitude, c.longitude, c.accuracy,
        Number.isFinite(c.heading) ? c.heading : NaN);
    },
    (err) => {
      if (err && err.code === 1) {   // PERMISSION_DENIED
        showToast('Sem permissão de localização — compartilhamento desligado.');
        settings.liveLocation.enabled = false; saveSettings();
        applyLiveLocation();
        const cb = document.querySelector('[data-setting="liveLocation.enabled"]');
        if (cb) cb.checked = false;
      } else if (err && (err.code === 2 || err.code === 3) && !_liveGeoErrShown) {
        // POSITION_UNAVAILABLE / TIMEOUT: o watch segue tentando (perder o GPS
        // por um tempo é comum pedalando), mas avisa UMA vez pra não mentir
        // "transmitindo" enquanto nenhuma posição é enviada.
        _liveGeoErrShown = true;
        showToast('Não foi possível obter sua localização — tentando de novo.');
      }
    },
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 },
  );
}
function stopLiveShare() {
  if (liveIsNative()) stopNativeBackgroundWatch();
  if (_liveWatchId != null && navigator.geolocation) {
    navigator.geolocation.clearWatch(_liveWatchId);
  }
  _liveWatchId = null;
  _liveLastSentMs = 0;
  // NÃO chama /live-location/stop: o rastro fica visível até expirar da janela
  // de 3h (decisão de produto). Parar só interrompe novos envios.
}

// Opacidade dos pontos do rastro (slider da camada Pessoas ao vivo). Atualiza
// os dots existentes na hora; os recriados a cada poll já leem a var.
function setLiveBandOpacity(frac) {
  _liveBandOpacity = Math.max(0, Math.min(1, frac));
  // Reaplica respeitando o multiplicador de opacidade por pessoa (opMul), do
  // mesmo jeito que upsertPersonMarker — senão o slider sobrescreveria o ajuste
  // individual de quem parou de reportar (não volta sozinho no próximo poll).
  for (const [token, e] of _personMarkers.entries()) {
    if (!e.ticks) continue;
    const ov = _personOverrides[token] || {};
    const opMul = Number.isFinite(ov.opacity) ? Math.max(0, Math.min(1, ov.opacity)) : 1;
    e.ticks.eachLayer((c) => c.setStyle && c.setStyle({ fillOpacity: _liveBandOpacity * opMul }));
  }
}

// Liga/desliga "ver pessoas ao vivo" (controlado pelo checkbox no painel de
// camadas, id 'live-people'). Fonte da verdade: settings.liveLocation.view.
function setLiveViewEnabled(v) {
  if (!settings.liveLocation) settings.liveLocation = {};
  settings.liveLocation.view = !!v;
  saveSettings();
  applyLiveLocation();
}

// Reconcilia o subsistema com as configurações. Idempotente (chamado por
// applyAllSettings a cada mudança e por visibilitychange). Ver e transmitir
// são independentes.
function applyLiveLocation() {
  // ── Ver (poll + render): ligado se `view` E a aba está visível. Pausa em
  // background pra não consumir rede à toa.
  const wantView = !!settings.liveLocation?.view && !document.hidden;
  if (wantView !== _liveViewing) {
    _liveViewing = wantView;
    if (wantView) {
      pollLivePositions();
      _livePollMs = Math.max(1500, settings.liveLocation?.pollMs || 4000);
      _livePollTimer = setInterval(pollLivePositions, _livePollMs);
    } else {
      if (_livePollTimer != null) { clearInterval(_livePollTimer); _livePollTimer = null; }
      _livePollMs = null;
      clearPersonMarkers();
    }
  } else if (wantView && _livePollTimer != null) {
    // Sem transição: só recria o timer se pollMs mudou de verdade. Antes,
    // qualquer mudança de Ajustes/visibilidade reiniciava a cadência (o próximo
    // fetch escorregava até um intervalo inteiro pra frente).
    const ms = Math.max(1500, settings.liveLocation?.pollMs || 4000);
    if (ms !== _livePollMs) {
      clearInterval(_livePollTimer);
      _livePollMs = ms;
      _livePollTimer = setInterval(pollLivePositions, ms);
    }
  }

  // ── Transmitir (independente do ver): ligado se `enabled`.
  const wantShare = !!settings.liveLocation?.enabled;
  if (wantShare !== _liveSharing) {
    _liveSharing = wantShare;
    if (wantShare) {
      // startLiveShare pode ser assíncrono (shell nativo). Se o watcher de
      // background não subir (resolve false — permissão negada / erro do
      // plugin), desfaz o estado pra não mentir "transmitindo" e permitir nova
      // tentativa, espelhando o tratamento de PERMISSION_DENIED do browser. No
      // browser startLiveShare devolve undefined (≠ false), então sem rollback.
      Promise.resolve(startLiveShare()).then((ok) => {
        if (ok === false) {
          _liveSharing = false;
          settings.liveLocation.enabled = false;
          saveSettings();
          _syncShareCheckbox();
          updateShareLocBtn();
          showToast('Não foi possível iniciar o compartilhamento ao vivo.');
        }
      });
    } else stopLiveShare();
  }
  updateShareLocBtn();   // mantém o botão do topbar em sincronia com `enabled`
}

// Ícone 📍 (linha "Pessoas ao vivo") — liga/desliga a transmissão da própria
// posição (settings.liveLocation.enabled). O estado fica espelhado no
// aria-pressed e no checkbox de Ajustes. getElementById (sem TDZ) pra poder
// ser chamado de dentro do applyLiveLocation do boot.
function updateShareLocBtn() {
  const btn = document.getElementById('share-loc-btn');
  if (btn) btn.setAttribute('aria-pressed', String(!!settings.liveLocation?.enabled));
}
function _syncShareCheckbox() {
  const cb = document.querySelector('[data-setting="liveLocation.enabled"]');
  if (cb) cb.checked = !!settings.liveLocation?.enabled;
}
// Clique no 📍 (wired em makeRow): se já transmite, para; senão abre o modal
// pra escolher apelido + por quanto tempo guardar o rastro.
function onShareLocClick() {
  if (!settings.liveLocation) settings.liveLocation = {};
  if (settings.liveLocation.enabled) {
    settings.liveLocation.enabled = false;
    saveSettings(); applyLiveLocation(); _syncShareCheckbox();
  } else {
    openShareNameModal();
  }
}

// Retenção como horas+minutos (campos separados — duração, não horário, então
// nada de AM/PM). Lê/escreve em segundos.
function openShareNameModal() {
  const modal = document.getElementById('share-name-modal');
  if (!modal) return;
  const nameEl = document.getElementById('share-name-input');
  const sec = Math.max(60, Math.min(24 * 3600, settings.liveLocation?.ttlSec ?? 10800));
  const hEl = document.getElementById('share-name-ttl-h');
  const mEl = document.getElementById('share-name-ttl-m');
  if (nameEl) nameEl.value = settings.liveLocation?.displayName || '';
  if (hEl) hEl.value = String(Math.floor(sec / 3600));
  if (mEl) mEl.value = String(Math.floor((sec % 3600) / 60));
  if (typeof closeOtherMobileDialogs === 'function') closeOtherMobileDialogs('share');
  modal.hidden = false;
  setTimeout(() => nameEl?.focus(), 0);
}
function closeShareNameModal() {
  const modal = document.getElementById('share-name-modal');
  if (modal) modal.hidden = true;
}
function confirmShareName() {
  if (!settings.liveLocation) settings.liveLocation = {};
  const nameEl = document.getElementById('share-name-input');
  const h = Math.max(0, Math.min(24, Math.floor(Number(document.getElementById('share-name-ttl-h')?.value) || 0)));
  const m = Math.max(0, Math.min(59, Math.floor(Number(document.getElementById('share-name-ttl-m')?.value) || 0)));
  settings.liveLocation.displayName = (nameEl?.value || '').trim().slice(0, 40);
  settings.liveLocation.ttlSec = Math.max(60, Math.min(24 * 3600, h * 3600 + m * 60));
  settings.liveLocation.enabled = true;
  saveSettings();
  applyLiveLocation();
  _syncShareCheckbox();
  const dn = document.querySelector('[data-setting="liveLocation.displayName"]');
  if (dn) dn.value = settings.liveLocation.displayName;
  closeShareNameModal();
}
document.getElementById('share-name-close')?.addEventListener('click', closeShareNameModal);
document.getElementById('share-name-confirm')?.addEventListener('click', confirmShareName);
document.getElementById('share-name-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'share-name-modal') closeShareNameModal();
});
document.getElementById('share-name-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); confirmShareName(); }
});

// Pausa/retoma o poll quando a aba some/volta (só afeta o ver).
document.addEventListener('visibilitychange', applyLiveLocation);
// Ao fechar/ocultar a aba, só encerra o watch local — o rastro permanece no
// servidor até expirar (3h). Zera _liveSharing pra que o próximo reconcile
// (visibilitychange/pageshow) veja a transição e religue: pagehide também
// dispara ao entrar no bfcache (trocar de app / bloquear a tela), onde a página
// segue viva — sem isso o watch morria mas o estado dizia "ainda transmitindo".
window.addEventListener('pagehide', () => { if (_liveSharing) { stopLiveShare(); _liveSharing = false; } });
// Volta do bfcache (pageshow persisted): a página continua com enabled=true mas
// o watch foi encerrado no pagehide — reconcilia pra religar a transmissão.
window.addEventListener('pageshow', (e) => { if (e.persisted) applyLiveLocation(); });
// Boot: liga o "ver pessoas ao vivo" já no load (default on), sem depender de
// abrir Ajustes — mesmo padrão dos outros apply*() chamados na inicialização.
applyLiveLocation();

// ─── Persistência das camadas (visibilidade + opacidade) ─────────────────
// O estado do painel de camadas persiste entre sessões. O estado natural de
// boot de cada camada == seu `defaultVisible` (rmsampa entra via .addTo,
// fotos via showPhotos(), o resto começa oculto), então no restore só
// precisamos forçar as camadas que diferem do default.
const LAYER_STATE_KEY = 'phidro:layerState';   // { [id]: { on, pct } }
// Estas NUNCA auto-restauram visibilidade no boot: custom-* exigem URL;
// audio-loop tocaria sozinho (autoplay bloqueado/indesejado). Seguem
// controláveis manualmente na sessão.
const LAYER_PERSIST_SKIP = new Set(['custom-xyz', 'custom-wms', 'audio-loop', 'route-highlight']);
let _restoringLayers = false;
function readLayerState() {
  try { return JSON.parse(localStorage.getItem(LAYER_STATE_KEY)) || {}; }
  catch { return {}; }
}
function persistLayerState() {
  if (_restoringLayers) return;
  const panel = document.querySelector('.layer-panel');
  if (!panel) return;
  const state = {};
  for (const cb of panel.querySelectorAll('.layer-row input[type="checkbox"]')) {
    const id = cb.dataset.id;
    const slider = panel.querySelector(`input.opacity-slider[data-id="${id}"]`);
    state[id] = { on: cb.checked, pct: slider ? Number(slider.value) : undefined };
  }
  try { localStorage.setItem(LAYER_STATE_KEY, JSON.stringify(state)); } catch {}
}
function restoreLayerState() {
  const panel = document.querySelector('.layer-panel');
  if (!panel) return;
  const saved = readLayerState();
  _restoringLayers = true;
  try {
    for (const l of [...BASE_LAYERS, ...OVERLAY_LAYERS]) {
      if (LAYER_PERSIST_SKIP.has(l.id)) continue;
      const s = saved[l.id];
      if (!s) continue;
      const cb = panel.querySelector(`.layer-row input[type="checkbox"][data-id="${l.id}"]`);
      const slider = panel.querySelector(`input.opacity-slider[data-id="${l.id}"]`);
      // Opacidade: aplica só se diferente do default.
      if (slider && Number.isFinite(s.pct) && s.pct !== l.defaultPct) {
        slider.value = String(s.pct);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      }
      // Visibilidade: o boot natural == defaultVisible, então só forçamos
      // (via change → show/hide/add/remove) quando o salvo difere do default.
      if (cb && typeof s.on === 'boolean' && s.on !== l.defaultVisible) {
        cb.checked = s.on;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  } finally { _restoringLayers = false; }
}

const layerPanel = L.control({ position: 'topright' });
layerPanel.onAdd = function () {
  const div = L.DomUtil.create('div', 'leaflet-bar layer-panel');
  const ALL_LAYERS = [...BASE_LAYERS, ...OVERLAY_LAYERS];
  const byId = (id) => ALL_LAYERS.find((x) => x.id === id);
  // Camadas de mapa (têm pane reordenável → estão em layerOrder) ganham setas
  // ↑/↓ pra reordenar o empilhamento, exibidas em ordem topo→fundo. Camadas de
  // conteúdo (fotos/clipes/pessoas/áudio — panes fixos, desenhadas por cima)
  // vão agrupadas no fim, sem setas. Isto substitui o antigo modal de ordem.
  const stackIds = () => layerOrder.slice().reverse();            // topo→fundo
  const contentIds = () => OVERLAY_LAYERS.map((l) => l.id).filter((id) => !layerOrder.includes(id));

  const rowsBox = L.DomUtil.create('div', 'layer-rows', div);
  const rowEls = {};

  // Reordena o empilhamento movendo `id` em layerOrder (+1 = pro topo/frente).
  function moveLayer(id, delta) {
    const i = layerOrder.indexOf(id);
    const j = i + delta;
    if (j < 0 || j >= layerOrder.length) return;
    [layerOrder[i], layerOrder[j]] = [layerOrder[j], layerOrder[i]];
    applyLayerOrder();
    layoutRows();
  }

  // Recoloca as linhas (movendo os nós, sem recriar — preserva checkbox/slider
  // e seus handlers) e atualiza o disabled das setas nas pontas.
  function layoutRows() {
    for (const id of stackIds())   { if (rowEls[id]) rowsBox.appendChild(rowEls[id]); }
    for (const id of contentIds()) { if (rowEls[id]) rowsBox.appendChild(rowEls[id]); }
    const stack = stackIds();
    stack.forEach((id, di) => {
      const el = rowEls[id]; if (!el) return;
      el.querySelector('.layer-move-up')?.toggleAttribute('disabled', di === 0);
      el.querySelector('.layer-move-down')?.toggleAttribute('disabled', di === stack.length - 1);
    });
  }

  function makeRow(l, reorderable) {
    const row = document.createElement('div');
    row.className = 'layer-row';
    row.dataset.id = l.id;
    // "Rota destacada" só aparece quando há destaque (setRouteHighlightRow).
    if (l.id === 'route-highlight') row.classList.add('layer-row-hidden');
    // Botões da linha num mini-grid fixo 3 colunas (sempre 3 col → checkboxes
    // alinhados; a ação fica sempre na col 3 → ✨ de "Imagens contribuídas" e
    // "Vídeo fantasma" no mesmo x):
    //   col1=▲   col2=▼ (ou 🔽 filtro em "Imagens contribuídas", que não tem
    //   setas)   col3=ação (☰/📍/✨/✎/⚙/🗑)
    const btns = [];
    if (reorderable) {
      btns.push('<button type="button" class="layer-move-up btn-up" title="Empilhar acima" aria-label="Empilhar acima">▲</button>');
      btns.push('<button type="button" class="layer-move-down btn-down" title="Empilhar abaixo" aria-label="Empilhar abaixo">▼</button>');
    }
    // Ação secundária (col3): filtro de mídias na camada "Imagens contribuídas".
    if (l.id === 'photos')
      btns.push('<button type="button" class="layer-action layer-filter-toggle btn-filter" title="Filtrar imagens/vídeos por lista ou SPARQL" aria-label="Filtrar imagens" aria-expanded="false"><svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M1 2.5h14L9.5 9v4.2l-3 1.8V9L1 2.5z" fill="currentColor"/></svg></button>');
    if (l.id === 'routes')
      btns.push('<button type="button" id="routes-panel-toggle" class="layer-action btn-action" title="Mostrar rotas" aria-label="Mostrar rotas" aria-pressed="false">☰</button>');
    else if (l.id === 'live-people')
      btns.push('<button type="button" id="share-loc-btn" class="layer-action btn-action" title="Compartilhar minha localização ao vivo" aria-label="Compartilhar localização" aria-pressed="false">📍</button>');
    else if (l.id === 'photos' || l.id === 'clips-ghost')
      btns.push('<button type="button" class="layer-action layer-anim-toggle btn-action" title="Ligar/desligar animação dos marcadores + vídeo fantasma" aria-label="Animação" aria-pressed="false">✨</button>');
    else if (l.editable)
      btns.push('<button type="button" class="layer-action layer-action-edit btn-action" title="Editar URL" aria-label="Editar URL">✎</button>');
    else if (l.gear)
      btns.push('<button type="button" class="layer-action layer-action-edit btn-action" title="Configurar" aria-label="Configurar">⚙</button>');
    else if (l.trash)
      btns.push('<button type="button" class="layer-action layer-action-trash btn-action" title="Remover destaque" aria-label="Remover destaque">🗑</button>');
    const buttons = `<span class="layer-btns">${btns.join('')}</span>`;
    const opacity = l.noOpacity ? ''
      : `<input type="range" class="opacity-slider" data-id="${l.id}" min="0" max="100" value="${l.defaultPct}" aria-label="Opacidade — ${l.label}" />`
        + `<span class="opacity-value" data-id="${l.id}">${l.defaultPct}%</span>`;
    row.innerHTML = buttons
      + `<label><input type="checkbox" data-id="${l.id}" ${l.defaultVisible ? 'checked' : ''} />`
      + `<span>${l.label}</span></label>`
      + opacity;

    row.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
      const o = byId(l.id); if (!o) return;
      if (o.show && o.hide) { if (e.target.checked) o.show(); else o.hide(); }
      else if (o.layer) {
        if (e.target.checked) o.layer.addTo(map);
        else if (map.hasLayer(o.layer)) map.removeLayer(o.layer);
      }
      persistLayerState();
    });
    const slider = row.querySelector('input.opacity-slider');
    if (slider) slider.addEventListener('input', () => {
      const o = byId(l.id); if (!o) return;
      const pct = Number(slider.value);
      if (o.setOpacity) o.setOpacity(pct / 100);
      else if (o.layer && o.layer.setOpacity) o.layer.setOpacity(pct / 100);
      row.querySelector('.opacity-value').textContent = `${pct}%`;
      persistLayerState();
    });
    // Cada ícone de ação (a linha tem os que se aplicam; querySelector devolve
    // null pros ausentes). stopPropagation evita o fecha-sidebar no clique-fora.
    const onAct = (sel, fn) => row.querySelector(sel)?.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation(); fn();
    });
    onAct('#routes-panel-toggle', toggleRoutesSidebar);
    onAct('#share-loc-btn', onShareLocClick);
    onAct('.layer-anim-toggle', toggleAnimation);
    onAct('.layer-filter-toggle', toggleMediaFilterPopover);
    onAct('.layer-action-edit', () => { if (l.edit) l.edit(); });
    onAct('.layer-action-trash', () => { if (l.trashAction) l.trashAction(); });
    if (reorderable) {
      row.querySelector('.layer-move-up').addEventListener('click', () => moveLayer(l.id, +1));
      row.querySelector('.layer-move-down').addEventListener('click', () => moveLayer(l.id, -1));
    }
    return row;
  }

  for (const id of stackIds())   { const l = byId(id); if (l) rowEls[id] = makeRow(l, true); }
  for (const id of contentIds()) { const l = byId(id); if (l) rowEls[id] = makeRow(l, false); }
  layoutRows();

  // Reset da ordem de empilhamento (substitui o botão "Restaurar padrão" do
  // antigo modal).
  const reset = L.DomUtil.create('button', 'layer-order-reset-inline', div);
  reset.type = 'button';
  reset.textContent = '↺ Ordem padrão';
  reset.addEventListener('click', () => {
    layerOrder = DEFAULT_LAYER_ORDER.slice();
    applyLayerOrder();
    layoutRows();
  });

  // Título "Camadas" na faixa reservada, ao lado da bolinha (absolute → não
  // desloca as linhas).
  const panelTitle = L.DomUtil.create('div', 'layer-panel-title', div);
  panelTitle.textContent = 'Camadas';

  // Bolinha de fechar (macOS) no canto do painel — fecha as camadas (mesmo
  // caminho do botão ⧉ Camadas: esconde + persiste). Absolute → não desloca
  // as linhas; a faixa superior reservada no CSS evita colisão com o conteúdo.
  div.appendChild(makeCloseDot(() => {
    closeOtherMobileDialogs('layers');
    applyLayersVisibility(true);
    try { localStorage.setItem(LAYERS_HIDDEN_KEY, '1'); } catch {}
  }, 'Fechar camadas'));

  L.DomEvent.disableClickPropagation(div);
  L.DomEvent.disableScrollPropagation(div);
  return div;
};
layerPanel.addTo(map);
// A camada "Fotos geo" vem ligada por padrão (defaultVisible: true) — o
// checkbox só reflete o estado, então a ativamos explicitamente aqui.
showPhotos();
// NB: restoreLayerState() é chamado MAIS PARA BAIXO (após `routesGloballyVisible`
// ser declarado) — chamar aqui caía na temporal dead zone desse `let` e o
// toggle de "Rotas cadastradas" não pegava no boot.

// ─── State ───────────────────────────────────────────────────────────────────
const routesList = document.getElementById('routes-list');
const routesStatus = document.getElementById('routes-status');
const dateFilter = document.getElementById('date-filter');
const rangeFrom = document.getElementById('range-from');
const rangeTo = document.getElementById('range-to');
const rangeFromValue = document.getElementById('range-from-value');
const rangeToValue = document.getElementById('range-to-value');
const dateReset = document.getElementById('date-reset');

// tourIri → { entry, layer, casing, badge, listEl, bounds, dateMs, visible }
// Vários passeios podem compartilhar uma rota do RWGPS (entry.id), mas cada
// um é um evento próprio — chaveamos por tourIri pra preservar essa identidade.
const routes = new Map();
let dateMin = null;
let dateMax = null;

// ─── Layer panel toggle (header button) ──────────────────────────────────────
const layersBtn = document.getElementById('layers-btn');
const LAYERS_HIDDEN_KEY = 'phidro:layersHidden';
const LAYERS_AUTO_HIDE_AREA_FRAC = 0.2; // se o painel cobriria >20% da tela, oculta no boot
function applyLayersVisibility(hidden) {
  document.body.classList.toggle('layers-hidden', hidden);
  if (layersBtn) layersBtn.setAttribute('aria-pressed', String(!hidden));
}
function defaultLayersHiddenByArea() {
  const el = document.querySelector('.layer-panel');
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  const panelArea = rect.width * rect.height;
  const viewportArea = window.innerWidth * window.innerHeight;
  return panelArea > LAYERS_AUTO_HIDE_AREA_FRAC * viewportArea;
}
{
  const persisted = localStorage.getItem(LAYERS_HIDDEN_KEY);
  const shouldHide = persisted !== null
    ? persisted === '1'
    : defaultLayersHiddenByArea();
  applyLayersVisibility(shouldHide);
}
layersBtn?.addEventListener('click', () => {
  const nowHidden = !document.body.classList.contains('layers-hidden');
  if (!nowHidden) closeOtherMobileDialogs('layers');
  applyLayersVisibility(nowHidden);
  try { localStorage.setItem(LAYERS_HIDDEN_KEY, nowHidden ? '1' : '0'); } catch {}
});

// (O antigo modal "Ordem de empilhamento" foi removido — as setas ↑/↓ agora
// vivem em cada linha do painel de camadas; ver layerPanel.onAdd acima.)

// ─── Header toggle (hide/show topbar) ────────────────────────────────────────
const headerToggle = document.getElementById('header-toggle');
const HEADER_HIDDEN_KEY = 'phidro:headerHidden';
// Park the toggle in Leaflet's top-left control column, above the zoom +/−.
const leafletTopLeft = document.querySelector('.leaflet-top.leaflet-left');
if (headerToggle && leafletTopLeft) {
  leafletTopLeft.insertBefore(headerToggle, leafletTopLeft.firstChild);
  L.DomEvent.disableClickPropagation(headerToggle);
  L.DomEvent.disableScrollPropagation(headerToggle);
}
// O 🔍 da busca de endereços estaciona AQUI, junto com o ☰ — e não lá embaixo,
// onde vive o resto da busca. Motivo: destino comum. Os dois moram na mesma
// coluna do Leaflet, e enquanto o estacionamento ficava ~3600 linhas depois,
// qualquer exceção no meio do arquivo deixava o ☰ estacionado e o 🔍 órfão no
// fluxo do #map — cravado no canto (0,0), meio engolido pela borda superior do
// Safari iOS com o header oculto (num iPhone real foi exatamente o que se viu;
// o gatilho é dependente de estado local, então headless não reproduz). O
// bloco da busca em si continua lá embaixo e NÃO re-estaciona.
// (getElementById próprio: a const geoSearchBtn lá de baixo está em TDZ aqui.)
{
  const geoBtn = document.getElementById('geo-search-btn');
  if (geoBtn && leafletTopLeft) {
    leafletTopLeft.appendChild(geoBtn);
    L.DomEvent.disableClickPropagation(geoBtn);
    L.DomEvent.disableScrollPropagation(geoBtn);
  }
}
function applyHeaderVisibility(hidden) {
  document.body.classList.toggle('header-hidden', hidden);
  if (headerToggle) {
    headerToggle.textContent = hidden ? '☰▼' : '☰▲';
    headerToggle.setAttribute('aria-pressed', String(hidden));
    headerToggle.setAttribute('aria-label', hidden ? 'Mostrar cabeçalho' : 'Ocultar cabeçalho');
    headerToggle.setAttribute('title', hidden ? 'Mostrar cabeçalho' : 'Ocultar cabeçalho');
  }
}
applyHeaderVisibility(localStorage.getItem(HEADER_HIDDEN_KEY) === '1');
headerToggle?.addEventListener('click', () => {
  const nowHidden = !document.body.classList.contains('header-hidden');
  applyHeaderVisibility(nowHidden);
  try { localStorage.setItem(HEADER_HIDDEN_KEY, nowHidden ? '1' : '0'); } catch {}
});

// ─── Sidebar toggle (mobile drawer + desktop hide) ───────────────────────────
// Two distinct states so behavior matches each viewport:
//   .sidebar-open   — explicit "show now" on mobile (drawer slide-in).
//   .sidebar-hidden — explicit "hide" on desktop (map gets full width).
const SIDEBAR_HIDDEN_KEY = 'phidro:sidebarHidden';
const isMobileViewport = () => window.matchMedia('(max-width: 760px)').matches;

// No mobile, cada diálogo (Camadas, Rotas, Enviar, Ajustes, Ajuda) é um
// bottom-sheet — e só um pode ficar aberto por vez. Antes de abrir um,
// pedimos pros outros se recolherem. (No desktop é no-op, pra não atrapalhar
// quem quer ver dois painéis lado a lado.)
function closeOtherMobileDialogs(except) {
  if (!isMobileViewport()) return;
  if (except !== 'sidebar' && document.body.classList.contains('sidebar-open')) {
    document.body.classList.remove('sidebar-open');
    if (typeof updateMenuBtnPressed === 'function') updateMenuBtnPressed();
  }
  if (except !== 'layers' && !document.body.classList.contains('layers-hidden')) {
    // applyLayersVisibility só altera DOM/aria — não persiste no localStorage.
    applyLayersVisibility(true);
  }
  if (except !== 'help' && helpModal && !helpModal.hidden) {
    helpModal.hidden = true;
    helpBtn?.setAttribute('aria-pressed', 'false');
  }
  if (except !== 'settings' && settingsModal && !settingsModal.hidden) {
    settingsModal.hidden = true;
    settingsBtn?.setAttribute('aria-pressed', 'false');
  }
  if (except !== 'upload' && uploadModal && !uploadModal.hidden) {
    uploadModal.hidden = true;
    uploadBtn?.setAttribute('aria-pressed', 'false');
  }
  if (except !== 'tour' && tourModal && !tourModal.hidden) {
    tourModal.hidden = true;
    if (tourIframe) tourIframe.src = '';
  }
  if (except !== 'censo' && censoModal && !censoModal.hidden) {
    censoModal.hidden = true;
  }
  if (except !== 'imagens' && imagensModal && !imagensModal.hidden) {
    imagensModal.hidden = true;
    imagensBtn?.setAttribute('aria-pressed', 'false');
  }
  if (except !== 'share') {
    const shareModal = document.getElementById('share-name-modal');
    if (shareModal && !shareModal.hidden) shareModal.hidden = true;
  }
  if (except !== 'subir' && subirModal && !subirModal.hidden) {
    subirModal.hidden = true;
  }
}

// Boot defaults para a sidebar no desktop:
//   - Se existir preferência persistida, ela manda (1 = oculta, 0 = visível).
//   - Sem preferência: oculta automaticamente quando a viewport for pequena
//     demais — não cabem ~4 rotas verticalmente OU a tela não tem largura pra
//     pelo menos 4× a sidebar (320px cada).
// No mobile, ignoramos `.sidebar-hidden` (que `display:none`-aria a sidebar
// e quebraria o drawer); o drawer começa fechado por outros meios.
const SIDEBAR_AUTO_HIDE_MIN_HEIGHT = 400;   // ~50px/rota × 4 + cabeçalho
const SIDEBAR_AUTO_HIDE_MIN_WIDTH  = 320 * 4; // 4× largura da sidebar
function defaultDesktopSidebarHidden() {
  return (
    window.innerHeight < SIDEBAR_AUTO_HIDE_MIN_HEIGHT ||
    window.innerWidth  < SIDEBAR_AUTO_HIDE_MIN_WIDTH
  );
}
if (!isMobileViewport()) {
  const persisted = localStorage.getItem(SIDEBAR_HIDDEN_KEY);
  const shouldHide = persisted !== null ? persisted === '1' : defaultDesktopSidebarHidden();
  if (shouldHide) {
    document.body.classList.add('sidebar-hidden');
    // O grid muda pra coluna única — o container do mapa cresce. Leaflet
    // cacheia o tamanho na hora de inicializar, então sem `invalidateSize()`
    // a área onde a sidebar ficaria não pede tiles até o usuário panejar.
    setTimeout(() => map.invalidateSize(), 0);
  }
}
updateMenuBtnPressed();

// O toggle das rotas agora mora no ícone ☰ da linha "Rotas cadastradas" no
// painel de camadas (ver makeRow). A lógica fica aqui pra reaproveitar o
// estado + a persistência da sidebar.
function toggleRoutesSidebar() {
  if (isMobileViewport()) {
    const willOpen = !document.body.classList.contains('sidebar-open');
    if (willOpen) closeOtherMobileDialogs('sidebar');
    document.body.classList.toggle('sidebar-open');
  } else {
    const nowHidden = !document.body.classList.contains('sidebar-hidden');
    document.body.classList.toggle('sidebar-hidden', nowHidden);
    try { localStorage.setItem(SIDEBAR_HIDDEN_KEY, nowHidden ? '1' : '0'); } catch {}
    // Trigger a Leaflet reflow so the map fills the new width cleanly.
    setTimeout(() => map.invalidateSize(), 220);
  }
  updateMenuBtnPressed();
}

// Tap outside the drawer closes it (mobile only).
document.addEventListener('click', (e) => {
  if (!isMobileViewport()) return;
  if (!document.body.classList.contains('sidebar-open')) return;
  if (e.target.closest('#sidebar') || e.target.closest('#routes-panel-toggle')) return;
  document.body.classList.remove('sidebar-open');
  updateMenuBtnPressed();
});

// Transição mobile → desktop (ex.: usuário gira pra landscape e a viewport
// cruza 760px): mantém a sidebar oculta. Sem isto, o CSS desktop volta a
// mostrá-la porque `.sidebar-hidden` não foi aplicado no boot mobile.
let _wasMobileViewport = isMobileViewport();
window.addEventListener('resize', () => {
  const nowMobile = isMobileViewport();
  if (_wasMobileViewport && !nowMobile) {
    document.body.classList.add('sidebar-hidden');
    document.body.classList.remove('sidebar-open');
    setTimeout(() => map.invalidateSize(), 0);
  }
  _wasMobileViewport = nowMobile;
  updateMenuBtnPressed();
  updateTitleAlignment();
});

// Título "amora: ajudante bicigeoenergético": alinhado à esquerda por padrão,
// mas centraliza quando o texto embrulha em mais de uma linha (celulares
// estreitos em retrato) — senão a segunda linha fica "pendurada" à esquerda.
// A partir de 900px o CSS já força nowrap+ellipsis (nunca embrulha), então a
// checagem nem roda ali.
function updateTitleAlignment() {
  const titleText = document.querySelector('.title-text');
  const titleH1 = document.querySelector('.topbar h1');
  if (!titleText || !titleH1) return;
  if (window.matchMedia('(min-width: 900px)').matches) {
    titleH1.classList.remove('title-wrapped');
    return;
  }
  const lineHeight = parseFloat(getComputedStyle(titleText).lineHeight) || 0;
  const wrapped = lineHeight > 0 && titleText.getBoundingClientRect().height > lineHeight * 1.4;
  titleH1.classList.toggle('title-wrapped', wrapped);
}
updateTitleAlignment();

function updateMenuBtnPressed() {
  const btn = document.getElementById('routes-panel-toggle');
  if (!btn) return;
  const visible = isMobileViewport()
    ? document.body.classList.contains('sidebar-open')
    : !document.body.classList.contains('sidebar-hidden');
  btn.setAttribute('aria-pressed', String(visible));
}

// ─── PWA: register service worker ────────────────────────────────────────────
// Em dev local (localhost / 127.0.0.1) o SW fica DESLIGADO: ele cacheia
// app.js/style.css com stale-while-revalidate, o que obrigava a recarregar
// duas vezes (ou limpar cache) pra ver cada edição. Aqui desregistramos
// qualquer SW e limpamos os caches, então um reload normal sempre traz o
// código mais novo. Em produção (amora) registra normalmente.
const _isLocalDev = ['localhost', '127.0.0.1', '0.0.0.0', ''].includes(location.hostname);
if ('serviceWorker' in navigator) {
  if (_isLocalDev) {
    navigator.serviceWorker.getRegistrations()
      .then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
    if (window.caches) {
      caches.keys().then((ks) => ks.forEach((k) => caches.delete(k))).catch(() => {});
    }
  } else {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.warn('[sw] registration failed:', err);
      });
    });
  }
}

// ─── Boot ────────────────────────────────────────────────────────────────────
boot()
  .catch((err) => {
    console.error(err);
    routesStatus.classList.add('error');
    routesStatus.textContent = `Falha: ${err.message}`;
  })
  .finally(() => {
    // After the page is ready, decode any #st=... shared route from the URL;
    // sem estado embutido, tenta o deep link de rota salva por nome
    // (#rt=<slug>, plantado pelo 303 de /route/<slug>).
    tryLoadFromShareHash()
      .then((loaded) => (loaded ? true : tryLoadSavedRouteFromHash()))
      .catch((err) => console.warn('[share] hash load failed:', err));
    if (!tryOpenTourFromPath()) tryOpenTourFromQuery();
  });

// Abre o modal da rota cujo passeio bate com `slug` — o slug8 (sufixo do
// tourIri) OU o slug legível (entry.slug, o schema:identifier que o backend
// espelha em routes.json). Retorna true se abriu.
function _openTourBySlug(slug) {
  for (const [key, r] of routes) {
    const tourId = _tourIdFromIri(r.entry?.tourIri);
    if (tourId !== slug && r.entry?.slug !== slug) continue;
    const canon = document.querySelector('link[rel="canonical"]');
    if (canon) canon.href = `https://amora.pedalhidrografi.co/passeio/${encodeURIComponent(r.entry?.slug || tourId)}`;
    // O backend injeta um <article> SSR pra crawlers/no-JS; com o modal
    // aberto ele é redundante — remove. Se o tour NÃO está em routes.json
    // (sem rota), o article fica como conteúdo de fallback abaixo do mapa.
    document.getElementById('tour-article')?.remove();
    openRouteModal(key);
    return true;
  }
  return false;
}

// ── URL legível por passeio (/passeio/<slug>) ─────────────────────────────
// Abrir um passeio reflete o endereço canônico na barra (replaceState — sem
// poluir o histórico); fechar volta pra raiz. Só quando o app está servido
// na raiz do host — num deploy em subpath a URL fica como está.
function _urlAtHostRoot() {
  const p = location.pathname;
  return p === '/' || p === '/index.html' || p.startsWith('/passeio/');
}
function _setTourUrl(entry) {
  if (!_urlAtHostRoot()) return;
  const tourId = _tourIdFromIri(entry?.tourIri);
  if (!tourId) return;   // rota sem passeio (importação legada) — URL fica
  history.replaceState(null, '', `/passeio/${encodeURIComponent(entry.slug || tourId)}`);
}
function _clearTourUrl() {
  if (location.pathname.startsWith('/passeio/')) history.replaceState(null, '', '/');
}

// Deep link por caminho: /passeio/<slug legível ou slug8> — a URL canônica
// dos links compartilhados/sitemap. O servidor serve o index SSR'ado nesse
// caminho (com <base href="/">); aqui só abrimos o modal correspondente.
function tryOpenTourFromPath() {
  const m = /^\/passeio\/([A-Za-z0-9-]+)$/.exec(location.pathname);
  if (!m) return false;
  if (_openTourBySlug(m[1])) return true;
  console.warn(`[tour] deep link /passeio/${m[1]} não encontrado em routes.json`);
  return false;
}

// Deep link por query: /?tour=<slug> (forma antiga — segue viva; o backend
// 303a pra /passeio/<slug>, mas a Cloudflare pode comer a query string antes
// de chegar na origem, então o cliente resolve aqui também). Depois de abrir,
// openRouteModal normaliza a barra pro endereço canônico.
//
// A resolução do LEGADO (?tour=<id-numérico> antigo → slug) é feita AQUI, no
// cliente, pelo mesmo motivo. O mapa (só byOldId) é buscado sob demanda, só
// quando o id não bate direto — o caso comum (slug novo) não paga nada.
async function tryOpenTourFromQuery() {
  const id = new URLSearchParams(location.search).get('tour');
  if (!id) return;
  if (_openTourBySlug(id)) return;
  try {
    const res = await fetch('./data/tour-iri-map.json', { cache: 'no-cache' });
    if (res.ok) {
      const slug = ((await res.json()).byOldId || {})[id];
      if (slug && _openTourBySlug(slug)) return;
    }
  } catch (_) { /* sem mapa — degrada pro warning */ }
  console.warn(`[tour] deep link ?tour=${id} não encontrado em routes.json`);
}

// Lê o corpo da resposta em streaming, chamando onProgress(bytesRecebidos)
// a cada chunk. Reporta bytes *descomprimidos* — com gzip no servidor o
// Content-Length é o tamanho comprimido, então uma % seria mentirosa; o
// contador absoluto não. Fallback pro .text() quando não há body stream.
async function readBodyWithProgress(res, onProgress) {
  if (!res.body || typeof res.body.getReader !== 'function') return res.text();
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(received);
  }
  const all = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(all);
}

async function boot() {
  routesStatus.textContent = 'Carregando rotas…';
  let data;
  try {
    // Sem `cache: 'no-cache'` de propósito: precisa casar com o
    // <link rel="preload" as="fetch"> do index.html (modos de cache
    // diferentes não casam e o download duplicaria). A revalidação fica
    // por conta do Cache-Control: no-cache + ETag que o backend manda.
    const res = await fetch(ROUTES_JSON_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = JSON.parse(await readBodyWithProgress(res, (received) => {
      routesStatus.textContent =
        `Carregando rotas… ${(received / 1048576).toFixed(1).replace('.', ',')} MB`;
    }));
  } catch (err) {
    throw new Error(
      `Não foi possível carregar ${ROUTES_JSON_URL} (${err.message}). ` +
        `Rode \`python scripts/build-routes.py\` para gerá-lo.`,
    );
  }

  const all = Array.isArray(data?.routes) ? data.routes : [];
  if (all.length === 0) throw new Error('routes.json não contém rotas');

  // Sort by Data descending; rows without a date sink to the bottom.
  all.sort((a, b) => (b.dateMs ?? -Infinity) - (a.dateMs ?? -Infinity));

  const allBounds = L.latLngBounds([]);
  let drawn = 0;

  for (const entry of all) {
    const key = entry.tourIri || entry.id;
    const li = addRouteToSidebar(entry);
    if (!entry.latlngs || entry.latlngs.length === 0) {
      li.classList.add('failed');
      li.title = entry.error || 'Sem traçado disponível';
      routes.set(key, { entry, listEl: li, dateMs: entry.dateMs ?? null, visible: false });
      continue;
    }

    const numberLabel = formatNumbers(entry);

    // Dark casing + white stroke for readability on top of OSM/hydrography.
    // Both live in the reorderable 'routes' pane (number badges stay markers,
    // so they remain above everything).
    const casing = L.polyline(entry.latlngs, {
      color: '#1a1a1a',
      weight: 3.5,
      opacity: 0.55,
      lineCap: 'round',
      lineJoin: 'round',
      pane: LAYER_PANE('routes'),
    });
    const layer = L.polyline(entry.latlngs, {
      color: '#ffffff',
      weight: 1.75,
      opacity: 1,
      lineCap: 'round',
      lineJoin: 'round',
      pane: LAYER_PANE('routes'),
    });

    const nums = entryNumbers(entry);
    const popupHtml =
      `<strong>${escapeHtml(buildLabel(entry))}</strong><br>` +
      (nums.length ? `${formatNumbersHtml(entry)}<br>` : '') +
      `Rota ${entry.id}` +
      (entry.igPost ? `<br><a href="#" class="popup-open-modal" data-route-id="${escapeHtml(key)}">Abrir passeio</a>` : '');
    layer.bindPopup(popupHtml);
    layer.on('click', () => openRouteModal(key));
    layer.on('popupopen', () => wireUpPopupLinks());

    // Plain-text number overlay (no background) at the route's midpoint.
    let badge = null;
    if (nums.length) {
      const mid = entry.latlngs[Math.floor(entry.latlngs.length / 2)];
      const iconH = 18 * nums.length;
      badge = L.marker(mid, {
        icon: L.divIcon({
          className: 'route-number-icon',
          html: `<span class="route-number-text">${formatNumbersHtml(entry)}</span>`,
          iconSize: [60, iconH],
          iconAnchor: [30, iconH / 2],
        }),
        interactive: true,
        keyboard: false,
      });
      badge.on('click', () => openRouteModal(key));
    }

    // Só adiciona ao mapa se a camada "Rotas cadastradas" está visível. Sem
    // isto, rotas recém-construídas entram no mapa direto, e o filtro de data
    // (setRouteVisible) faz early-return pras que já estão `visible:true`, então
    // nunca reconcilia contra routesGloballyVisible — e o toggle "off" salvo de
    // sessões anteriores não pegava no boot.
    if (routesGloballyVisible) {
      casing.addTo(map);
      layer.addTo(map);
      if (badge) badge.addTo(map);
    }
    allBounds.extend(layer.getBounds());

    // POIs from the GPX (entry.pois) are kept on the entry but NOT rendered
    // on the always-visible map — they appear only when the user enters edit
    // mode for this route via the modal's "Editar este traçado" button.

    routes.set(key, {
      entry,
      layer,
      casing,
      badge,
      listEl: li,
      bounds: layer.getBounds(),
      dateMs: entry.dateMs ?? null,
      visible: true,
    });
    drawn++;
  }

  // Default view stays at São Paulo (set above) — don't auto-fit to all routes.
  // Click a sidebar entry to zoom to a specific route.
  setupDateFilter(all);
  // Status oculto no sucesso — só aparece pra "Loading…" e mensagens de erro.
  routesStatus.classList.remove('error');
  routesStatus.textContent = '';
  routesStatus.hidden = true;
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────
function addRouteToSidebar(entry) {
  const key = entry.tourIri || entry.id;
  const li = document.createElement('li');
  li.dataset.routeId = key;
  const numbersHtml = formatNumbersHtml(entry);
  li.innerHTML = `
    <span class="route-number sidebar-badge">${numbersHtml || '·'}</span>
    <div>
      <strong>${escapeHtml(buildLabel(entry))}</strong>
    </div>
  `;
  li.addEventListener('click', () => openRouteModal(key));
  li.addEventListener('mouseenter', () => onRouteRowHover(entry, li, true));
  li.addEventListener('mouseleave', () => onRouteRowHover(entry, li, false));
  routesList.appendChild(li);
  return li;
}

// ─── Sidebar hover preview (highlight on map + floating stats tooltip) ───────
const routeTooltip = document.getElementById('route-tooltip');

function onRouteRowHover(entry, li, hovering) {
  const r = routes.get(entry.tourIri || entry.id);
  if (!r || drawingMode) {
    if (!hovering) hideRouteTooltip();
    return;
  }
  if (hovering) {
    highlightRoute(r);
    showRouteTooltip(entry, li);
  } else {
    unhighlightRoute(r);
    hideRouteTooltip();
  }
}

function highlightRoute(r) {
  if (!r.layer) return;
  // Remember original style once so repeated hovers don't drift.
  if (!r._hoverOrig) {
    r._hoverOrig = {
      color: r.layer.options.color || '#ffffff',
      weight: r.layer.options.weight || 3.5,
    };
  }
  r.layer.setStyle({ color: '#ffb547', weight: 6 });
  if (r.layer.bringToFront) r.layer.bringToFront();
}
function unhighlightRoute(r) {
  if (r.layer && r._hoverOrig) {
    r.layer.setStyle(r._hoverOrig);
  }
}

function showRouteTooltip(entry, li) {
  if (!routeTooltip) return;
  const stats = entry.stats;
  const numberLabel = formatNumbers(entry);
  const km =
    stats?.distMeters != null
      ? `${(stats.distMeters / 1000).toFixed(1).replace('.', ',')} km`
      : '';
  const asc = stats?.ascentMeters != null ? `↑${stats.ascentMeters} m` : '';
  const desc = stats?.descentMeters != null ? `↓${stats.descentMeters} m` : '';
  const statsLine = [km, asc, desc].filter(Boolean).join(' · ');
  const metaLine = [entry.date, numberLabel].filter(Boolean).join(' · ');
  routeTooltip.innerHTML =
    `<strong>${escapeHtml(entry.name || `Route ${entry.id}`)}</strong>` +
    (metaLine ? `<div class="rt-meta">${escapeHtml(metaLine)}</div>` : '') +
    (statsLine ? `<div class="rt-stats">${statsLine}</div>` : '');

  // Position to the LEFT of the sidebar item (sidebar sits on the right edge),
  // vertically centered on the row.
  const rect = li.getBoundingClientRect();
  routeTooltip.style.right = `${Math.max(8, window.innerWidth - rect.left + 8)}px`;
  routeTooltip.style.top = `${rect.top + rect.height / 2}px`;
  routeTooltip.style.left = 'auto';
  routeTooltip.hidden = false;
}
function hideRouteTooltip() {
  if (routeTooltip) routeTooltip.hidden = true;
}

function buildLabel(entry) {
  const date = entry.date || '';
  const name = entry.name || '';
  return [date, name].filter(Boolean).join(' — ') || `Route ${entry.id}`;
}

// Códigos de série atribuídos ao passeio. `formatNumbers` devolve uma string
// junta com ` · ` (contextos de texto puro como nome de arquivo); a variante
// `_Html` escapa cada código e usa `<br>` por padrão, pra empilhar verticalmente
// em badges/popups quando o tour pertence a mais de uma série. Cai pra
// `entry.number` quando o backend ainda não emite `numbers`.
function entryNumbers(entry) {
  return Array.isArray(entry.numbers) && entry.numbers.length
    ? entry.numbers
    : (entry.number?.value ? [entry.number] : []);
}
function formatNumbers(entry) {
  return entryNumbers(entry).map((n) => `${n.source} ${n.value}`).join(' · ');
}
function formatNumbersHtml(entry, sep = '<br>') {
  return entryNumbers(entry)
    .map((n) => escapeHtml(`${n.source} ${n.value}`))
    .join(sep);
}

function focusRoute(id) {
  const r = routes.get(id);
  if (!r || !r.bounds) return;
  document.querySelectorAll('#routes-list li.active').forEach((el) => el.classList.remove('active'));
  r.listEl.classList.add('active');
  map.fitBounds(r.bounds, { padding: [40, 40] });
}

// ─── Date filter ─────────────────────────────────────────────────────────────
function setupDateFilter(entries) {
  const datedMs = entries.map((e) => e.dateMs).filter((d) => Number.isFinite(d));
  if (datedMs.length === 0) return;

  dateMin = Math.min(...datedMs);
  dateMax = Math.max(...datedMs);
  if (dateMin === dateMax) {
    // Pad to a 1-day window so the slider has motion.
    dateMax = dateMin + DAY_MS;
  }

  for (const input of [rangeFrom, rangeTo]) {
    input.min = String(dateMin);
    input.max = String(dateMax);
    input.step = String(DAY_MS);
  }
  rangeFrom.value = String(dateMin);
  rangeTo.value = String(dateMax);

  rangeFrom.addEventListener('input', onRangeChange);
  rangeTo.addEventListener('input', onRangeChange);
  dateReset.addEventListener('click', () => {
    rangeFrom.value = String(dateMin);
    rangeTo.value = String(dateMax);
    onRangeChange();
  });

  // Clicar nos rótulos `from`/`to` abre um date-picker nativo. Mantemos um
  // <input type="date"> oculto por par só pra invocar `showPicker()`; o span
  // continua sendo o que o usuário lê.
  const fromPicker = makeHiddenDatePicker(dateMin, dateMax, (ms) => {
    rangeFrom.value = String(Math.max(dateMin, Math.min(ms, Number(rangeTo.value))));
    onRangeChange();
  });
  const toPicker = makeHiddenDatePicker(dateMin, dateMax, (ms) => {
    rangeTo.value = String(Math.max(Number(rangeFrom.value), Math.min(ms, dateMax)));
    onRangeChange();
  });
  dateFilter.appendChild(fromPicker);
  dateFilter.appendChild(toPicker);
  rangeFromValue.classList.add('clickable-date');
  rangeFromValue.setAttribute('role', 'button');
  rangeFromValue.setAttribute('tabindex', '0');
  rangeToValue.classList.add('clickable-date');
  rangeToValue.setAttribute('role', 'button');
  rangeToValue.setAttribute('tabindex', '0');
  const triggerPicker = (picker, currentMs) => {
    picker.value = toIsoDate(currentMs);
    if (typeof picker.showPicker === 'function') picker.showPicker();
    else picker.focus();   // fallback navegadores antigos: o input fica focável
  };
  rangeFromValue.addEventListener('click', () =>
    triggerPicker(fromPicker, Number(rangeFrom.value)));
  rangeToValue.addEventListener('click', () =>
    triggerPicker(toPicker, Number(rangeTo.value)));

  dateFilter.hidden = false;
  applyDateWindow(dateMin, dateMax);
}

function makeHiddenDatePicker(minMs, maxMs, onPicked) {
  const el = document.createElement('input');
  el.type = 'date';
  el.className = 'date-picker-hidden';
  el.min = toIsoDate(minMs);
  el.max = toIsoDate(maxMs);
  el.addEventListener('change', () => {
    if (!el.value) return;
    const ms = fromIsoDate(el.value);
    if (Number.isFinite(ms)) onPicked(ms);
  });
  return el;
}
// Date <-> "YYYY-MM-DD" em horário local — o input type=date trabalha em
// strings ISO sem timezone, então não usamos toISOString() (que é UTC e
// causaria off-by-one no fuso de SP).
function toIsoDate(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function fromIsoDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

function onRangeChange() {
  let from = Number(rangeFrom.value);
  let to = Number(rangeTo.value);
  if (from > to) {
    // Push the inactive thumb out of the way.
    if (document.activeElement === rangeFrom) {
      to = from;
      rangeTo.value = String(to);
    } else {
      from = to;
      rangeFrom.value = String(from);
    }
  }
  applyDateWindow(from, to);
}

function applyDateWindow(from, to) {
  rangeFromValue.textContent = formatDay(from);
  rangeToValue.textContent = formatDay(to);

  let visible = 0;
  for (const r of routes.values()) {
    // Undated routes (often older imports without a Data column entry — many
    // BP/BT/S-only rides) can't be placed on the timeline, so always show
    // them rather than silently hiding them.
    const inRange =
      r.dateMs == null ? true : r.dateMs >= from && r.dateMs <= to + DAY_MS - 1;
    setRouteVisible(r, inRange);
    if (inRange) visible++;
  }

  // Estado vazio: se o filtro de data escondeu TODAS as rotas, avisa no lugar
  // da lista silenciosamente vazia (o "Carregando…" já some quando o catálogo
  // termina). Só age com o catálogo carregado e fora do estado de erro.
  if (routes.size > 0 && !routesStatus.classList.contains('error')) {
    if (visible === 0) {
      routesStatus.textContent = 'Nenhuma rota neste período — toque ↺ pra limpar o filtro.';
      routesStatus.hidden = false;
    } else {
      routesStatus.textContent = '';
      routesStatus.hidden = true;
    }
  }

  // Propaga a mesma janela pras fotos. `to + DAY_MS - 1` inclui o dia
  // inteiro do limite superior (mesma convenção das rotas).
  photoDateWindow = { from, to: to + DAY_MS - 1 };
  applyPhotoVisibility();

}

// ─── Loaded-routes pseudo-layer (visibility + opacity from layer panel) ──────
// Per-route on-map-ness is the AND of two booleans:
//   r.visible            — set by the date filter
//   routesGloballyVisible — set by the master checkbox in the layer panel
// Opacity is scaled by routesOpacityPct (0..100) over baseline values.
const ROUTE_OPACITY_BASE = { casing: 0.55, layer: 1.0, badge: 1.0 };
let routesGloballyVisible = true;
let routesOpacityPct = 100;

// Restaura a visibilidade/opacidade das camadas escolhidas em sessões
// anteriores. Roda AQUI (e não logo após o painel) de propósito: o estado de
// boot de cada camada == seu defaultVisible, mas a camada "Rotas cadastradas"
// guarda o estado em `routesGloballyVisible`/`routesOpacityPct` (declarados
// logo acima) — restaurar antes disso esbarrava na temporal dead zone desses
// `let` e o hide() das rotas era engolido. As rotas carregam async depois e
// respeitam o flag já ajustado aqui (sem flash). No 1º acesso, sem estado
// salvo, é no-op.
restoreLayerState();

function setRouteVisible(r, visible) {
  if (r.visible === visible) return;
  r.visible = visible;
  r.listEl.classList.toggle('hidden-by-filter', !visible);
  applyRouteOnMap(r);
}

function applyRouteOnMap(r) {
  const onMap = r.visible && routesGloballyVisible;
  const add = (l) => l && !map.hasLayer(l) && l.addTo(map);
  const drop = (l) => l && map.hasLayer(l) && map.removeLayer(l);
  if (onMap) {
    add(r.casing); add(r.layer); add(r.badge);
  } else {
    drop(r.casing); drop(r.layer); drop(r.badge);
  }
}

function setRoutesGloballyVisible(visible) {
  routesGloballyVisible = visible;
  for (const r of routes.values()) applyRouteOnMap(r);
}

function applyRoutesOpacity(pct) {
  routesOpacityPct = pct;
  const f = pct / 100;
  for (const r of routes.values()) {
    if (r.casing) r.casing.setStyle({ opacity: ROUTE_OPACITY_BASE.casing * f });
    if (r.layer) r.layer.setStyle({ opacity: ROUTE_OPACITY_BASE.layer * f });
    if (r.badge) r.badge.setOpacity(ROUTE_OPACITY_BASE.badge * f);
  }
}

// ─── Rota destacada (botão "Destacar rota" no modal de rota) ─────────────────
// Desenha uma cópia 1,5× mais grossa da rota (mesmo estilo: casing escuro +
// traço branco) num featureGroup próprio, acima das rotas normais. A linha
// "Rota destacada" no painel de camadas (escondida até existir destaque) tem 🗑.
function addRouteHighlight(key) {
  const r = routes.get(key);
  if (!r || !Array.isArray(r.entry?.latlngs) || r.entry.latlngs.length < 2) return;
  const dup = routeHighlightGroup.getLayers().some((l) => l._phKey === key);
  if (!dup) {
    const pane = LAYER_PANE('route-highlight');
    const base = { lineCap: 'round', lineJoin: 'round', pane, interactive: false };
    const casing = L.polyline(r.entry.latlngs, { ...base, color: '#1a1a1a', weight: 5.25, opacity: 0.55 });
    const line   = L.polyline(r.entry.latlngs, { ...base, color: '#ffffff', weight: 2.6,  opacity: 1 });
    casing._phKey = key; line._phKey = key;
    routeHighlightGroup.addLayer(casing);
    routeHighlightGroup.addLayer(line);
  }
  if (!map.hasLayer(routeHighlightGroup)) routeHighlightGroup.addTo(map);
  setRouteHighlightRow(true);
}
function clearRouteHighlight() {
  routeHighlightGroup.clearLayers();
  if (map.hasLayer(routeHighlightGroup)) map.removeLayer(routeHighlightGroup);
  setRouteHighlightRow(false);
}
// Mostra/esconde a linha "Rota destacada" no painel e sincroniza o checkbox.
function setRouteHighlightRow(show) {
  const row = document.querySelector('.layer-row[data-id="route-highlight"]');
  if (row) row.classList.toggle('layer-row-hidden', !show);
  const cb = row?.querySelector('input[type="checkbox"]');
  if (cb) cb.checked = show;
}

function formatDay(ms) {
  const d = new Date(ms);
  // ISO yyyy-mm-dd, but localized — use toLocaleDateString for friendliness.
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}

// ─── Route detail modal (with human-friendly summary + edit) ────────────────
const routeModal = document.getElementById('route-modal');
const routeModalTitle = document.getElementById('route-modal-title');
const routeModalMeta = document.getElementById('route-modal-meta');
const routeModalSummary = document.getElementById('route-modal-ig');  // legacy id, repurposed
const routeModalClose = document.getElementById('route-modal-close');
let _routeModalReqId = 0;  // guarda contra summary de um modal antigo sobrescrever um novo

routeModalClose.addEventListener('click', closeRouteModal);
routeModal.addEventListener('click', (e) => {
  if (e.target === routeModal) closeRouteModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !routeModal.hidden) closeRouteModal();
});
addMaximizeDot(routeModal, 'phidro:routeModalMaximized');

// Extrai o slug do passeio (sufixo após `pas:` / IRI completa). Aceita também
// as formas legadas phd:tour_ por segurança (dados/links pré-migração).
function _tourIdFromIri(iri) {
  if (!iri) return null;
  const PAS = 'https://id.pedalhidrografi.co/passeio/';
  const PHD = 'https://pedalhidrografi.co/data/';
  if (iri.startsWith(PAS))            return iri.slice(PAS.length);
  if (iri.startsWith('pas:'))         return iri.slice('pas:'.length);
  if (iri.startsWith(PHD + 'tour_'))  return iri.slice((PHD + 'tour_').length);
  if (iri.startsWith('phd:tour_'))    return iri.slice('phd:tour_'.length);
  return null;
}

// Constrói uma view legível do passeio: lê tours.ttl + identities.ttl, resolve
// o IRI alvo e seus blank nodes (route reference, energy values) e
// dependentes (associações → série+edição), mapeia pessoas/séries pra nomes
// via declarações nesses arquivos e devolve HTML pronto pra render no modal.
async function _renderTourSummary(tourId) {
  const PH    = 'https://id.pedalhidrografi.co/terms#';
  const PHD   = 'https://pedalhidrografi.co/data/';
  const PAS   = 'https://id.pedalhidrografi.co/passeio/';
  const SCHEMA = 'https://schema.org/';
  const DCT   = 'http://purl.org/dc/terms/';
  const RDFT  = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const PROV  = 'http://www.w3.org/ns/prov#';
  const QUDT  = 'http://qudt.org/schema/qudt/';

  let Parser;
  try {
    Parser = await ensureN3();
  } catch (e) {
    return `<p class="muted">Parser N3 indisponível: ${escapeHtml(e.message)}.</p>`;
  }
  let text;
  try {
    // Pessoas (schema:Person + nomes) vivem SÓ em identities.ttl desde o
    // split dos catálogos — sem ela, autoras/quem-subiu/participantes caem
    // no fallback de IRI crua (nameOf() nunca acha o label).
    const [tRes, iRes] = await Promise.all([
      fetch('./data/tours.ttl', { cache: 'no-cache' }),
      fetch('./data/identities.ttl', { cache: 'no-cache' }),
    ]);
    if (!tRes.ok) throw new Error(`HTTP ${tRes.status}`);
    const identitiesText = iRes.ok ? await iRes.text() : '';
    text = (await tRes.text()) + '\n\n' + identitiesText;
  } catch (e) {
    return `<p class="muted">tours.ttl indisponível: ${escapeHtml(e.message)}.</p>`;
  }

  const tourIri = `${PAS}${tourId}`;
  const subjBy = new Map();  // subject IRI/bnode-id → array of quads
  const types = new Map();   // subject → Set of types
  const labels = new Map();  // subject → human label (name/title/code)
  try {
    for (const q of new Parser().parse(text)) {
      const s = q.subject.value, p = q.predicate.value, o = q.object.value;
      if (!subjBy.has(s)) subjBy.set(s, []);
      subjBy.get(s).push(q);
      if (p === RDFT) {
        if (!types.has(s)) types.set(s, new Set());
        types.get(s).add(o);
      } else if (p === SCHEMA + 'name') {
        labels.set(s, o);   // nome real vence sobre apelido/título
      } else if (p === SCHEMA + 'alternateName' || p === DCT + 'title') {
        if (!labels.has(s)) labels.set(s, o);
      }
    }
  } catch (e) {
    return `<p class="muted">Parser falhou: ${escapeHtml(e.message)}.</p>`;
  }
  const own = subjBy.get(tourIri) || [];
  if (!own.length) {
    return `<p class="muted">Passeio <code>pas:${escapeHtml(tourId)}</code> não encontrado.</p>`;
  }

  function nameOf(iri) {
    if (!iri) return null;
    if (labels.has(iri)) return labels.get(iri);
    // Fallback: parte após o último separador.
    return iri.replace(/^.*[#/]/, '');
  }
  // Nome de pessoa como link pro IRI (dereferenciável — 303 pra pessoas.html
  // focada nela). Usado só pra campos com range garantido schema:Person.
  function personLink(iri) {
    return `<a href="${escapeHtml(iri)}" target="_blank" rel="noopener">${escapeHtml(nameOf(iri))}</a>`;
  }

  // Coleta valores agrupados por predicado.
  const get = (pred, kind = 'lit') => {
    const out = [];
    for (const q of own) {
      if (q.predicate.value !== pred) continue;
      if (kind === 'iri' && q.object.termType !== 'NamedNode') continue;
      if (kind === 'lit' && q.object.termType !== 'Literal') continue;
      if (kind === 'bn'  && q.object.termType !== 'BlankNode') continue;
      out.push(q.object.value);
    }
    return out;
  };
  const first = (pred, kind = 'lit') => get(pred, kind)[0] || null;
  const bnodeProps = (bn) => {
    const m = new Map();
    for (const q of subjBy.get(bn) || []) m.set(q.predicate.value, q.object.value);
    return m;
  };

  const title       = first(DCT + 'title');
  const date        = first(DCT + 'date');
  const description = first(DCT + 'description');
  const instagram   = first(PH + 'linkInstagram');
  const announce    = first(SCHEMA + 'image', 'iri') || first(SCHEMA + 'image');
  const attendees   = first(PH + 'countAttendee');
  const newcomers   = first(PH + 'countNewcomer');
  const departed    = first(PH + 'departedAt');
  const arrived     = first(PH + 'arrivedAt');
  const moving      = first(PH + 'movingDuration');
  const totalDur    = first(PH + 'totalDuration');
  const hadBonde    = first(PH + 'hadBonde');
  const hadRain     = first(PH + 'hadRain');
  const incidents   = get(PH + 'hadIncident');

  // Série + edição via ph:inSeriesEdition → resolve associações.
  const seriesPairs = [];
  for (const assocIri of get(PH + 'inSeriesEdition', 'iri')) {
    const m = bnodeProps(assocIri);
    const evIri = m.get(PH + 'inEventSeries');
    const seq   = m.get(PH + 'sequenceInSeries');
    if (evIri && seq) {
      seriesPairs.push({
        code: evIri.replace(/^.*[#/]/, ''),
        title: nameOf(evIri),
        n: seq,
        iri: evIri,
      });
    }
  }

  // Rota via blank node ph:linkRoute.
  let route = null;
  const routeBn = first(PH + 'linkRoute', 'bn');
  if (routeBn) {
    const m = bnodeProps(routeBn);
    route = {
      url: m.get(SCHEMA + 'url'),
      provider: m.get(SCHEMA + 'provider'),
    };
  }

  // ph:energyEstimate / ph:measuredEnergy são literais xsd:decimal (kJ) direto
  // no tour. A classificação de intensidade é derivada do valor por faixas
  // fixas (não é mais armazenada no TTL).
  function intensityFor(kj) {
    if (!Number.isFinite(kj)) return null;
    if (kj < 150)  return 'De boa';
    if (kj < 300)  return 'Ok';
    if (kj < 500)  return 'Endorfinado';
    if (kj < 1000) return 'Frito';
    return 'Insano';
  }
  function readEnergy(pred, withClass) {
    const v = first(pred);
    if (v == null) return null;
    return { value: v, class: withClass ? intensityFor(parseFloat(v)) : null };
  }
  const energyEst  = readEnergy(PH + 'energyEstimate', true);
  const energyMeas = readEnergy(PH + 'measuredEnergy', false);

  // Pessoas (autoras + participantes + iniciantes). "Quem subiu" (provedores)
  // não é exibido — pouco relevante pro resumo do passeio. Os dois últimos
  // são listados nominalmente APENAS quando o toggle de privacidade
  // `attendees.list` está ligado em Ajustes. Os triples vivem no TTL
  // independentemente — só a renderização é controlada.
  const authors   = get(PROV + 'wasAttributedTo', 'iri').map(personLink);
  // organizer pode ser Pessoa OU Organização — sem link (não garante /pessoas/).
  const organizers= get(SCHEMA + 'organizer',     'iri').map(nameOf);
  const showAttendeeList = settings.attendees?.list === true;
  const attendeeList = showAttendeeList ? get(SCHEMA + 'attendee', 'iri').map(personLink) : [];
  const newcomerList = showAttendeeList ? get(PH + 'hasNewcomer', 'iri').map(personLink) : [];

  // Helpers de formatação.
  function fmtDate(s) {
    if (!s) return '—';
    // "2024-09-09T20:00:00-03:00" → "09/09/2024 20:00"
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (m) return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`;
    return s;
  }
  function fmtDuration(s) {
    if (!s) return '—';
    const m = s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
    if (!m) return s;
    const h = parseInt(m[1] || '0', 10);
    const mn = parseInt(m[2] || '0', 10);
    const sc = parseInt(m[3] || '0', 10);
    const parts = [];
    if (h) parts.push(`${h}h`);
    if (mn) parts.push(`${mn}min`);
    if (sc && !h) parts.push(`${sc}s`);
    return parts.join(' ') || '0min';
  }
  function row(label, html) {
    return `<dt>${escapeHtml(label)}</dt><dd>${html}</dd>`;
  }

  // Monta o HTML.
  const rows = [];
  if (title) rows.push(row('Título', escapeHtml(title)));
  if (date)  rows.push(row('Quando', escapeHtml(fmtDate(date))));
  if (seriesPairs.length) {
    rows.push(row('Série', seriesPairs.map(s =>
      `<a href="${escapeHtml(s.iri)}" target="_blank" rel="noopener"><strong>${escapeHtml(s.code)}</strong></a> ${escapeHtml(s.n)}` +
      (s.title && s.title !== s.code ? ` — ${escapeHtml(s.title)}` : '')
    ).join(' · ')));
  }
  if (organizers.length) rows.push(row('Organização', organizers.map(escapeHtml).join(', ')));
  if (route?.url) {
    const provName = route.provider ? route.provider.replace(/^.*[#/]/, '') : '';
    rows.push(row('Rota',
      `<a href="${escapeHtml(route.url)}" target="_blank" rel="noopener">${escapeHtml(route.url)}</a>` +
      (provName ? ` <span class="muted">(${escapeHtml(provName)})</span>` : '')));
  }
  if (instagram) rows.push(row('Instagram',
    `<a href="${escapeHtml(instagram)}" target="_blank" rel="noopener">${escapeHtml(instagram)}</a>`));
  // authors/attendeeList/newcomerList já vêm como HTML (personLink) — NÃO
  // escapar de novo aqui (double-escape quebraria os links).
  if (authors.length)   rows.push(row('Autoras',  authors.join(', ')));
  if (attendeeList.length) rows.push(row('Participantes', attendeeList.join(', ')));
  if (newcomerList.length) rows.push(row('Iniciantes',    newcomerList.join(', ')));

  // Métricas — só mostra se tiver pelo menos um valor.
  const metricsParts = [];
  if (attendees)  metricsParts.push(`${escapeHtml(attendees)} participantes`);
  if (newcomers)  metricsParts.push(`${escapeHtml(newcomers)} iniciantes`);
  if (energyEst)  metricsParts.push(`~${escapeHtml(energyEst.value)} kJ${energyEst.class ? ` <span class="muted">(${escapeHtml(energyEst.class)})</span>` : ''}`);
  if (metricsParts.length) rows.push(row('Métricas', metricsParts.join(' · ')));

  const realParts = [];
  if (departed) realParts.push(`Partiu ${escapeHtml(fmtDate(departed))}`);
  if (arrived)  realParts.push(`Chegou ${escapeHtml(fmtDate(arrived))}`);
  // Tempo total: derivado (chegada − saída) quando há os dois horários; senão
  // o literal ph:totalDuration que o form grava na falta deles.
  {
    let totalIso = null;
    if (departed && arrived) {
      const ms = Date.parse(arrived) - Date.parse(departed);
      if (Number.isFinite(ms) && ms > 0) {
        const mins = Math.round(ms / 60000);
        totalIso = `PT${Math.floor(mins / 60)}H${mins % 60}M`;
      }
    } else if (totalDur) {
      totalIso = totalDur;
    }
    if (totalIso) realParts.push(`Total ${escapeHtml(fmtDuration(totalIso))}`);
  }
  if (moving)   realParts.push(`Movimento ${escapeHtml(fmtDuration(moving))}`);
  if (energyMeas) realParts.push(`${escapeHtml(energyMeas.value)} kJ medidos`);
  if (hadBonde === 'true') realParts.push('🚇 bonde');
  if (hadRain  === 'true') realParts.push('🌧️ choveu');
  if (realParts.length) rows.push(row('Métricas reais', realParts.join(' · ')));

  if (incidents.length) {
    rows.push(row('Incidentes',
      `<ul class="tour-incidents">${incidents.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`));
  }
  if (description) {
    rows.push(row('Narrativa', `<div class="tour-narrative">${escapeHtml(description).replace(/\n/g, '<br>')}</div>`));
  }

  // Hero do anúncio. URL pode vir como `file:///app/tour_assets/<id>/...`
  // (caminho server-side de scripts antigos) — remapeamos pro path web
  // servido pelo backend (`/tour_assets/...`). URLs http(s) passam direto.
  let announceUrl = announce || null;
  if (announceUrl && announceUrl.startsWith('file:///app/tour_assets/')) {
    announceUrl = './' + announceUrl.slice('file:///app/'.length);
  }
  const heroHtml = announceUrl
    ? `<a class="tour-announce-hero" href="${escapeHtml(announceUrl)}" ` +
      `target="_blank" rel="noopener" title="Abrir imagem em tamanho real">` +
      `<img src="${escapeHtml(announceUrl)}" alt="anúncio" ` +
      `onerror="this.parentElement.style.display='none'"></a>`
    : '';

  return heroHtml + `<dl class="tour-summary">${rows.join('')}</dl>`;
}

function openRouteModal(id) {
  const r = routes.get(id);
  if (!r) return;
  // No mobile a sidebar (z 5500) fica ACIMA do modal de rota (z 5000); sem
  // fechá-la, tocar numa rota "abria" o modal atrás dela (parecia não abrir).
  if (typeof closeOtherMobileDialogs === 'function') closeOtherMobileDialogs('route');
  focusRoute(id);

  const entry = r.entry;
  const numberLabel = formatNumbers(entry);
  const tourId = _tourIdFromIri(entry.tourIri);

  routeModalTitle.textContent = buildLabel(entry);

  // Série+número e data NÃO aparecem aqui — já estão no título do modal
  // (buildLabel) e no campo "Série" do resumo do passeio (seriesPairs).
  const metaParts = [];
  // Provider "amora" = rota salva do próprio editor (/route/<slug>, abre o
  // app com a rota carregada); ausente/rwgps = RideWithGPS (legado incluso).
  metaParts.push(
    entry.provider === 'amora'
      ? `<a href="./route/${encodeURIComponent(entry.id)}" target="_blank" rel="noopener">Abrir rota salva no editor ↗</a>`
      : `<a href="https://ridewithgps.com/routes/${entry.id}" target="_blank" rel="noopener">Abrir no RideWithGPS ↗</a>`,
  );
  if (Array.isArray(entry.latlngs) && entry.latlngs.length >= 2) {
    metaParts.push(
      `<button type="button" class="linkbtn edit-route-btn">Editar este traçado ✎</button>`,
    );
    metaParts.push(
      `<button type="button" class="linkbtn highlight-route-btn">Destacar rota ★</button>`,
    );
  }
  if (entry.date) {
    metaParts.push(
      `<button type="button" class="linkbtn filter-ride-photos-btn">Filtrar imagens para esta rota 🔍</button>`,
    );
  }
  if (tourId) {
    metaParts.push(
      `<button type="button" class="linkbtn share-tour-btn">🔗 Compartilhar</button>`,
    );
    metaParts.push(
      `<button type="button" class="linkbtn edit-tour-btn">Editar passeio ✎</button>`,
    );
  }
  routeModalMeta.innerHTML = metaParts.join(' · ');
  routeModalMeta.querySelector('.filter-ride-photos-btn')?.addEventListener('click', () => {
    showPhotosForRide(entry.date, numberLabel || buildLabel(entry));
    closeRouteModal();
  });
  routeModalMeta.querySelector('.edit-route-btn')?.addEventListener('click', () => {
    closeRouteModal();
    editEntryInDrawingTool(entry);
  });
  routeModalMeta.querySelector('.highlight-route-btn')?.addEventListener('click', () => {
    addRouteHighlight(id);
    closeRouteModal();
  });
  // Link canônico do passeio (mesmo formato do <link rel="canonical"> da
  // SSR e do sitemap — abre direto no modal certo pra quem recebe). Slug
  // legível quando o backend já o mintou; senão o slug8.
  routeModalMeta.querySelector('.share-tour-btn')?.addEventListener('click', () => {
    shareLink(`https://amora.pedalhidrografi.co/passeio/${encodeURIComponent(entry.slug || tourId)}`, 'Link do passeio');
  });
  routeModalMeta.querySelector('.edit-tour-btn')?.addEventListener('click', () => {
    openTourModal(tourId);
  });

  // Resumo do passeio: view legível a partir de tours.ttl. Sem tour vinculado,
  // mostra placeholder.
  if (tourId) {
    routeModalSummary.innerHTML = `<p class="muted">carregando…</p>`;
    const reqId = ++_routeModalReqId;
    _renderTourSummary(tourId).then((html) => {
      // Evita corrida se o usuário trocou de modal antes da resposta.
      if (reqId !== _routeModalReqId) return;
      routeModalSummary.innerHTML = html;
    });
  } else {
    _routeModalReqId++;  // invalida qualquer resposta pendente de um modal anterior
    routeModalSummary.innerHTML =
      `<p class="muted">Sem Tour vinculado a esta rota — provavelmente importação legada.</p>`;
  }

  renderRoutePhotos(entry);
  _setTourUrl(entry);   // barra de endereço ← /passeio/<slug> (canônico)
  routeModal.hidden = false;
}

function closeRouteModal() {
  routeModal.hidden = true;
  routeModalSummary.innerHTML = '';
  document.getElementById('route-modal-photos').innerHTML = '';
  _routeModalReqId++;  // invalida qualquer _renderTourSummary pendente
  _clearTourUrl();
}


// Popup links (rendered in Leaflet popup) need delegation since they're
// detached from the document until popupopen.
function wireUpPopupLinks() {
  document.querySelectorAll('.popup-open-modal').forEach((a) => {
    if (a.dataset.wired) return;
    a.dataset.wired = '1';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const id = a.dataset.routeId;
      if (id) openRouteModal(id);
    });
  });
}

// ─── Utils ─── (moved to lib/utils.js — imported at the top of this file)

// ─── GPX drawing tool ────────────────────────────────────────────────────────
// Each click is a USER WAYPOINT. Between consecutive waypoints we render a
// path; when the "Rotear via OSM" toggle is on, that path is fetched from the
// FOSSGIS OSRM instance (real bike/foot profiles) so the line follows real
// streets. Otherwise the path is a straight segment.
//
// Drag a waypoint to move it — the two segments touching it get re-fetched.
// Press the line itself (tap/click, or hold-and-drag) to insert an
// intermediate waypoint into that segment — see onLinePointerDown.
// Undo/Redo walk a snapshot history (waypoint positions + cached paths).
// Save → assembles the full path into a GPX file and downloads it.

const traceBtn = document.getElementById('trace-btn');
const traceControls = document.getElementById('trace-controls');
const traceUndo = document.getElementById('trace-undo');
const traceRedo = document.getElementById('trace-redo');
const traceSave = document.getElementById('trace-save');
const traceView = document.getElementById('trace-view');
const traceTrash = document.getElementById('trace-trash');
const traceReverse = document.getElementById('trace-reverse');
const traceCount = document.getElementById('trace-count');   // ausente desde a remoção do label "# pontos"
// Modo "Ver": dentro da edição, oculta os pontos e suaviza a linha pra
// pré-visualizar o traçado limpo. O botão Cancelar vira "Editar".
let previewMode = false;

// The floating panel sits inside the map container, so without this Leaflet
// would treat clicks on its buttons as map clicks and add trackpoints.
L.DomEvent.disableClickPropagation(traceControls);
L.DomEvent.disableScrollPropagation(traceControls);
const traceRoutingMode = document.getElementById('trace-routing-mode');
const traceMetrics = document.getElementById('trace-metrics');

// ─── Physics + simulation parameters ─────────────────────────────────────────
// Per-segment forces:
//   F_roll = Crr × m × g
//   F_aero = 0.5 × ρ × CdA × v²
//   F_grav = m × g × sin(θ)              (θ from elevation/length)
// Rider holds constant power on flat/uphill → solve cubic for v.
// On descent, rider coasts and brakes, capturing ε of the gravity assist as
// extra speed beyond the flat-equivalent: v = v_flat + ε·(v_coast − v_flat).
const G = 9.81;
// Stored as fractions in the params object; surfaced as % in the UI.
const PCT_PARAMS = new Set(['epsilon', 'efficiency', 'slopeFlatThreshold', 'kEff', 'carKEff', 'carEpsilon', 'carSlopeFlatThreshold']);
const DEFAULT_PARAMS = {
  mass: 75,                 // kg (rider + bike)
  crr: 0.008,
  cda: 0.5,                 // m² — typical upright tourist
  rho: 1.1,                 // kg/m³ — ~750 m asl (São Paulo)
  // Three-tier power profile, chosen by gradient (see slopeFlatThreshold).
  powerAscent: 100,         // W when slope > +threshold
  powerFlat: 50,            // W when |slope| ≤ threshold
  powerDescent: 10,         // W when slope < −threshold
  epsilon: 0.17,            // 0..1 — fração da gravidade de descida virada velocidade (só tempo)
  efficiency: 0.90,         // 0..1 — moving time / total time
  slopeFlatThreshold: 0.02, // 0..1 — ±2% boundary; também o limiar de subida v2 (arrasto cai acima)
  // Modelo de energia v2 (bicycling-energy-model): eficiência da transmissão e
  // deadband de elevação. v_f (velocidade no plano p/ o arrasto) é derivada do
  // equilíbrio na potência de plano. ε (recuperação na descida) é estimada do
  // perfil — o param `epsilon` acima só afeta a velocidade simulada (tempo).
  kEff: 0.97,               // 0..1 — eficiência da transmissão
  deadbandM: 2,             // m — deadband de elevação p/ h± na energia v2
  // Fonte de elevação: FABDEM (Range fetch de tiles 1°×1°) por padrão; cai
  // pra Open-Meteo se desligado ou se a célula vier nodata/404.
  useFabdem: true,
  // DEM local de alta resolução de São Paulo (sampa_geral, ~5 m, COG único).
  // Quando ligado, tem prioridade sobre o FABDEM dentro da extensão da RMSP;
  // fora dela (ou nodata) cai pro FABDEM/Open-Meteo. Ligado por padrão.
  useSampaDem: true,
  // Roteamento "menor energia" (FABDEM + Dijkstra assimétrico): o custo por aresta
  // é o modelo v2 derivado dos parâmetros físicos acima (mass/crr/cda/rho/kEff +
  // v_f da potência de plano) via readCost() — não há mais α/β/η.
  energySearchMarginPct: 100, // % de margem em torno da bbox dos endpoints
  // Direções de movimento do Dijkstra em grade ("pelo terreno" e fallback
  // raster do viário): 4/8/16/32/64/128. Conjuntos maiores (escada de Farey do
  // simujaules: 16 = +movimentos de cavalo, etc.) reduzem a superestimativa de
  // energia da grade-8 (~⅔ dela some em 16) ao custo de mais arestas por célula.
  // Movimentos longos são integrados por perfil no worker (ver buildMoves).
  // Default 16 = a recomendação do bicycling-energy-model (Entry 74 / paper 3
  // §3.2(d)): o ótimo de med|Δ%| no levantamento local (0,20 pp do ótimo
  // n=32 do FABDEM); 8 é a escolha rápida e ganhos além de 32 são marginais.
  nDirs: 16,
  // Tratamento σ do mapa (bicycling-energy-model, Entry 74): Gaussiana com
  // σ em metros aplicada ao mosaico DEM ANTES do roteamento por energia
  // (grade do terreno + grafo vetorial do viário que amostra o mosaico) —
  // inclusive nas fontes grossas (FABDEM). Perfis tratados vivem na banda de
  // descida rasa que o ε grade-local credita perto do limite de coasting;
  // sem o tratamento, o ruído fabrica micro-descidas íngremes e o custo v2
  // explode. 0 = desligado. NÃO afeta a Câmera Topográfica nem a amostragem
  // de elevação do traçado (que segue com o deadband).
  demSmoothSigmaM: 30,
  // Fonte do viário no "menor energia pelo viário": grafo PRÉ-COZIDO de SP
  // (sampa-viario-graph.bin — elevações baked, sem DEM por rota) por padrão,
  // com o FGB da América do Sul (range requests) como fallback; desligado
  // roteia no grid raster da MESMA rede (serrilhado de ~30 m, sem grafo).
  // Fora da América do Sul não há viário nenhum — o modo cai na energia livre.
  // (Chave histórica "Gpkg" mantida — renomear órfanaria a preferência salva.)
  useViarioGpkg: true,
  // "Menor energia pelo terreno": tratar lagos/represas e rios dos FGBs de
  // água como barreira intransponível (a rota não cruza água). Desligado =
  // água ignorada (nem os FGBs são consultados se os portais também
  // estiverem off).
  useWaterMask: true,
  // "Menor energia pelo terreno": atravessar lagos/rios barrados por cima de
  // pontes/túneis via portais (atalho no tabuleiro). Desligado = água é barreira
  // total (sem travessia). Não afeta o "pelo viário" (já roteia nas vias).
  usePortals: true,
  // Comparação com um SUV (editar traçado): liga/desliga o cálculo e a exibição
  // na barra de métricas + tooltip. Os campos abaixo são a física do carro
  // usada nesse cálculo — mesmo modelo v2 por segmento da bike, ver
  // carEnergyJ() e powerForCar(). Perfil de potência de 3 níveis próprio do
  // SUV (a potência em descida pode ser NEGATIVA — freio ativo, o SUV não
  // deixa a gravidade acelerá-lo livre como a bike faz).
  suvCompareEnabled: true,
  // Defaults calibrados p/ ~10,7 km/L no plano (meta 10 ± 2 km/L com gasolina
  // a 32.000 kJ/L), com valores de literatura pra um SUV a gasolina em São
  // Paulo — ver docs/car_efficiency_methodology.md.
  carMass: 5000,           // kg
  carCrr: 0.013,           // rolamento no asfalto (0,010–0,015 p/ pneus de SUV)
  carCda: 1.1,             // m² — Cd~0,38 × área frontal ~2,9 m² (SUV grande/boxy)
  carKEff: 0.28,           // 0..1 — eficiência tanque→roda em cruzeiro (0,25–0,30)
  carEpsilon: 0.20,        // 0..1 — combustível evitado na descida; baixo p/ SP (trânsito para
                           //        toda hora + grades rasos → motor segue queimando; DFCO raro)
  carPowerAscent: 45000,   // W — potência em subida (> +limiar): motorista acelera na subida
                           //     (em SP não se "cruza" em morro) — ~69/50/35 km/h a +3/+5/+8%
  carPowerFlat: 15000,     // W — potência em plano (±limiar): cruzeiro ~65 km/h
  carPowerDescent: 5000,   // W — potência em descida (< −limiar): acelerador leve (motorista ainda dá um gás)
  carSlopeFlatThreshold: 0.03, // 0..1 — limiar de plano do SUV (±3%): grade de equilíbrio do coasting em estrada
  // Escala a energia mecânica da bike ("nas pernas") pra energia metabólica
  // (comida) — eficiência humana ~25% → ~4×. Usado só na comparação com o SUV.
  bikeMetabolicFactor: 4,
};

function powerFor(gradient, p) {
  if (gradient > p.slopeFlatThreshold) return p.powerAscent;
  if (gradient < -p.slopeFlatThreshold) return p.powerDescent;
  return p.powerFlat;
}
let params = loadParams();

function loadParams() {
  try {
    const raw = localStorage.getItem('phidro:params:v1');
    if (!raw) return { ...DEFAULT_PARAMS };
    return { ...DEFAULT_PARAMS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_PARAMS };
  }
}
function saveParams() {
  try { localStorage.setItem('phidro:params:v1', JSON.stringify(params)); } catch {}
}

let drawingMode = false;
let defaultSaveName = ''; // pre-populated by GPX import / route-modal edit
let layersWasVisible = false; // remembers panel state across drawing sessions
// Each trackpoint is a user waypoint.
//   pathFromPrev: [[lat,lng], ...] inclusive of both endpoints.
//                 null for the first waypoint.
let trackpoints = [];
// `drawHistory` (e não `history`) — um identificador module-level chamado
// `history` sombrearia window.history e quebraria history.replaceState().
let drawHistory = [[]];      // snapshots of [{ lat, lng, pathFromPrev }, ...]
let historyIndex = 0;
let draftPolyline = null;
let draftCasing = null;
let pointIdCounter = 0;
// 'straight' | 'cycling' | 'foot' — controls how new segments are computed.
// 'straight' just connects waypoints with a line (the absolute shortest distance).
let routingMode = 'straight';
let pendingRouteSeq = 0;     // increments per OSRM call; lets us discard stale results

traceBtn.addEventListener('click', () => {
  if (previewMode) { exitPreviewMode(); return; }  // "Editar" volta pra edição
  if (!drawingMode) {
    enterDrawingMode();
    // Rascunho persistido (fechou o navegador / Cancelar sem descartar)
    // volta pra tela — o descarte explícito é o 🗑 da barra.
    restoreTraceDraft();
  } else {
    exitDrawingMode();
  }
});
traceSave.addEventListener('click', () => saveAndExit());
traceView.addEventListener('click', () => enterPreviewMode());
traceTrash?.addEventListener('click', () => discardTrace());
traceReverse.addEventListener('click', () => reverseTraceDirection());
traceUndo.addEventListener('click', undo);
traceRedo.addEventListener('click', redo);
traceRoutingMode.addEventListener('change', () => {
  const prev = routingMode;
  routingMode = traceRoutingMode.value || 'straight';
  // Trocar o modo re-roteia o rascunho atual com o modo/fontes vigentes (antes
  // só valia pros próximos waypoints). Reverte o seletor se o usuário recusar
  // um re-roteamento grande.
  rerouteCurrentDraft(prev);
  scheduleTraceDraftSave();   // persiste o modo mesmo sem re-roteamento (reta)
});

document.addEventListener('keydown', (e) => {
  // Defer to whatever modal is open instead of acting on the drawing tool.
  if (!paramsModal.hidden) {
    if (e.key === 'Escape') paramsModal.hidden = true;
    return;
  }
  const saveModalOpen = document.getElementById('save-modal') && !document.getElementById('save-modal').hidden;
  if (saveModalOpen) return; // its own keydown listener handles Enter / Esc
  if (!drawingMode) return;
  const isMod = e.metaKey || e.ctrlKey;
  if (isMod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
  } else if (e.key === 'Escape') {
    // Esc com um modal aberto (QR do link, Ajuda, …) é do modal — cada um
    // fecha o seu no próprio listener. Sem este guard o mesmo keydown
    // também derrubava o modo de edição e o traçado ia embora junto.
    if (document.querySelector('.modal:not([hidden])')) return;
    if (previewMode) exitPreviewMode();   // Esc no modo Ver volta pra edição
    else exitDrawingMode();
  }
});

function enterDrawingMode() {
  drawingMode = true;
  document.body.classList.add('drawing');
  // Toda sessão de desenho começa DESVINCULADA de qualquer rota do servidor.
  // Quem carrega uma rota (loadSavedRoute / loadGpxIntoEditor) re-seta o id
  // depois. Sem isto, traçar uma rota NOVA logo após salvar outra reusaria o
  // `currentSavedRouteId` e sobrescreveria a rota anterior no servidor.
  currentSavedRouteId = null;

  for (const r of routes.values()) {
    if (r.casing) r.casing.setStyle({ opacity: 0.15 });
    if (r.layer) {
      r.layer.setStyle({ opacity: 0.25 });
      r.layer.unbindPopup();
      r.layer.off('click');
    }
    if (r.badge) {
      r.badge.setOpacity(0.3);
      r.badge.off('click');
    }
  }

  trackpoints = [];
  drawHistory = [[]];
  historyIndex = 0;
  if (draftPolyline) { map.removeLayer(draftPolyline); draftPolyline = null; }
  if (draftCasing)   { map.removeLayer(draftCasing);   draftCasing = null; }

  routingMode = traceRoutingMode.value || 'straight';
  map.on('click', onMapClickInDrawing);
  // Suspend the map's double-click-to-zoom while drawing: a double-click on
  // empty map would otherwise fire two click-to-add points and then zoom.
  map.doubleClickZoom.disable();
  // Tuck the layer panel away while drawing so it can't crowd the trace
  // controls. Remember its prior state to restore on exit.
  layersWasVisible = !document.body.classList.contains('layers-hidden');
  if (layersWasVisible) {
    document.body.classList.add('layers-hidden');
    if (layersBtn) layersBtn.setAttribute('aria-pressed', 'false');
  }
  traceBtn.textContent = '🗺︎ cancelar';
  traceBtn.setAttribute('aria-label', 'Cancelar');
  traceBtn.setAttribute('title', 'Cancelar (Esc) — o traçado fica guardado');
  traceBtn.setAttribute('aria-pressed', 'true');
  traceControls.hidden = false;
  updateTraceControls();
  updateMetrics();
}

// ─── Modo "Ver" (pré-visualização limpa do traçado) ──────────────────────────
// Oculta os pontos editáveis e mostra a linha suavizada; esconde a barra de
// edição e troca Cancelar → Editar. Editar (ou Esc) desfaz. Não altera os
// dados — só a apresentação; sair restaura a geometria exata.
function chaikinSmooth(points, iterations = 2) {
  let pts = points;
  for (let it = 0; it < iterations; it++) {
    if (pts.length < 3) break;
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      out.push([ax + 0.25 * (bx - ax), ay + 0.25 * (by - ay)]);
      out.push([ax + 0.75 * (bx - ax), ay + 0.75 * (by - ay)]);
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

function enterPreviewMode() {
  if (!drawingMode || previewMode) return;
  previewMode = true;
  document.body.classList.add('trace-preview');   // oculta marcadores/rótulos (CSS)
  // Suaviza a linha exibida (Chaikin sobre o caminho montado).
  if (draftPolyline) {
    const smooth = chaikinSmooth(assembleLatLngs().map((ll) => [ll.lat, ll.lng]), 2);
    if (draftCasing) draftCasing.setLatLngs(smooth);
    draftPolyline.setLatLngs(smooth);
  }
  traceControls.hidden = true;
  // Cancelar → Editar; mantém aria-pressed='true' (laranja).
  traceBtn.textContent = '✎🗺︎ editar';
  traceBtn.setAttribute('aria-label', 'Editar');
  traceBtn.setAttribute('title', 'Voltar a editar');
}

function exitPreviewMode() {
  if (!previewMode) return;
  previewMode = false;
  document.body.classList.remove('trace-preview');
  updateDraftPolyline();   // restaura a geometria exata (des-suaviza)
  traceControls.hidden = false;
  traceBtn.textContent = '🗺︎ cancelar';
  traceBtn.setAttribute('aria-label', 'Cancelar');
  traceBtn.setAttribute('title', 'Cancelar (Esc) — o traçado fica guardado');
}

function exitDrawingMode() {
  // Cancelar/Esc NÃO descartam o traçado: o rascunho fica no localStorage e
  // volta no próximo Traçar (o descarte explícito é o 🗑 da barra). Uma
  // gravação debounced ainda pendente precisa ser descarregada AGORA — senão
  // o timer dispararia depois do wipe abaixo e salvaria um rascunho vazio.
  if (_traceDraftTimer) { clearTimeout(_traceDraftTimer); saveTraceDraft(); }
  drawingMode = false;
  previewMode = false;
  document.body.classList.remove('drawing', 'trace-preview');

  for (const t of trackpoints) map.removeLayer(t.marker);
  trackpoints = [];
  if (draftPolyline) { map.removeLayer(draftPolyline); draftPolyline = null; }
  if (draftCasing)   { map.removeLayer(draftCasing);   draftCasing = null; }
  drawHistory = [[]];
  historyIndex = 0;

  for (const [key, r] of routes) {
    const entry = r.entry;
    const numsHtml = formatNumbersHtml(entry);
    if (r.layer) {
      const popupHtml =
        `<strong>${escapeHtml(buildLabel(entry))}</strong><br>` +
        (numsHtml ? `${numsHtml}<br>` : '') +
        `Rota ${entry.id}` +
        (entry.igPost
          ? `<br><a href="#" class="popup-open-modal" data-route-id="${escapeHtml(key)}">Abrir passeio</a>`
          : '');
      r.layer.bindPopup(popupHtml);
      r.layer.on('click', () => openRouteModal(key));
    }
    if (r.badge) r.badge.on('click', () => openRouteModal(key));
  }
  // Restore the route opacity to whatever the layer-panel slider says.
  applyRoutesOpacity(routesOpacityPct);

  map.off('click', onMapClickInDrawing);
  map.doubleClickZoom.enable();
  // Restore the layer panel if drawing mode had hidden it.
  if (layersWasVisible) {
    document.body.classList.remove('layers-hidden');
    if (layersBtn) layersBtn.setAttribute('aria-pressed', 'true');
    layersWasVisible = false;
  }
  traceBtn.textContent = '🗺︎ traçar';
  traceBtn.setAttribute('aria-label', 'Traçar GPX');
  traceBtn.setAttribute('title', 'Traçar GPX');
  traceBtn.removeAttribute('aria-pressed');
  traceControls.hidden = true;
  defaultSaveName = '';
}

async function onMapClickInDrawing(e) {
  if (previewMode) return;   // no modo Ver não se adiciona ponto
  // Ignore the trailing click of a press-to-insert gesture on the draft line
  // (its mousedown started on the line; the click can still fire on the map
  // container) so it doesn't append a stray point at the end.
  if (lineInsertActive) return;
  // Idem pra escolha na busca de endereços: o clique no resultado remove o
  // <li> ainda durante o dispatch, e o walk de _leaflet_disable_click do
  // Leaflet (que sobe por parentNode a partir do target) morre no nó
  // destacado antes de achar a flag do painel — o clique "vira" clique no
  // mapa e caía aqui como ponto extra num lugar aleatório (meio do flyTo).
  // Também engole o ghost click do toque e um duplo-clique no painel recém-
  // encolhido. Ver geoSearchPickTs em pickGeoSearchResult.
  if (Date.now() - geoSearchPickTs < 700) return;
  const tp = createTrackpoint(e.latlng);
  trackpoints.push(tp);

  // Initial straight path from the previous waypoint (if any).
  if (trackpoints.length > 1) {
    const prev = trackpoints[trackpoints.length - 2];
    tp.pathFromPrev = straightPath(prev.marker.getLatLng(), tp.marker.getLatLng());
  }
  redrawAndMetrics();
  updateTraceControls();

  if (routingMode !== 'straight' && trackpoints.length > 1) {
    const idx = trackpoints.length - 1;
    await refetchPath(idx);
    redrawAndMetrics();
  }
  pushHistory();
}

// Initial state for the new trackpoint can be passed in (used by snapshot
// restore, GPX import, and edit-from-route flows) so the marker is built with
// the right icon up front instead of via a follow-up setIcon call.
function createTrackpoint(latlng, init = {}) {
  const id = ++pointIdCounter;
  const isPoi = !!init.isPoi;
  const sym = init.sym || 'Flag, Blue';
  const name = init.name || '';
  const marker = L.marker(latlng, {
    icon: tpIcon(isPoi, sym),
    draggable: true,
    keyboard: false,
    zIndexOffset: 1000,
  });
  marker._tpId = id;
  marker.on('drag', () => redrawAndMetrics());
  marker.on('dragend', () => onMarkerDragEnd(id));
  marker.on('click', () => openTpPopup(id));
  marker.addTo(map);
  if (name) {
    marker.bindTooltip(name, {
      permanent: true,
      direction: 'right',
      offset: [10, 0],
      className: 'tp-label',
    });
  }
  return { id, marker, pathFromPrev: null, name, isPoi, sym };
}

// Map of POI sym/type values → short Portuguese label rendered as plain text
// next to each POI marker. Covers both Garmin's vocabulary (used by the
// drawing tool) and RWGPS's lowercase types (used by the build script when
// exporting from RWGPS GPX wpts).
const POI_LABEL = {
  // Garmin-style
  'Flag, Blue':     'ponto',
  'Flag, Red':      'ponto',
  'Flag, Green':    'ponto',
  'Pin, Yellow':    'ponto',
  'Pin, Red':       'ponto',
  'Summit':         'pico',
  'Restaurant':     'comida',
  'Drinking Water': 'água',
  'Restroom':       'banheiro',
  'Picnic Area':    'piquenique',
  'Trail Head':     'trilha',
  'Information':    'vista',
  'Bridge':         'ponte',
  'Tunnel':         'túnel',
  'Crossing':       'travessia',
  // RWGPS-style (lowercase) — fallback if sym wasn't translated.
  'water':          'água',
  'summit':         'pico',
  'viewpoint':      'vista',
  'overlook':       'vista',
  'food':           'comida',
  'restroom':       'banheiro',
  'picnic':         'piquenique',
  'parking':        'estac.',
  'bike_shop':      'bike',
  'bike_parking':   'bike',
  'camping':        'camping',
  'lodging':        'hotel',
  'monument':       'monum.',
  'photo':          'foto',
  'shopping':       'loja',
  'transit':        'metrô',
  'first_aid':      'soc.',
  'caution':        'atenção',
  'crossing':       'travessia',
  'generic':        'POI',
  'Dot':            'POI',
};
function symLabel(sym) {
  return POI_LABEL[sym] || POI_LABEL[String(sym || '').toLowerCase()] || 'POI';
}

// Emoji rendered on the map for each POI symbol — same keys as POI_LABEL
// (Garmin vocabulary + RWGPS lowercase types). Falls back to a generic pin.
const POI_EMOJI = {
  // Garmin-style
  'Flag, Blue':     '📍',
  'Flag, Red':      '📍',
  'Flag, Green':    '📍',
  'Pin, Yellow':    '📍',
  'Pin, Red':       '📍',
  'Summit':         '⛰️',
  'Restaurant':     '🍴',
  'Drinking Water': '💧',
  'Restroom':       '🚻',
  'Picnic Area':    '🧺',
  'Trail Head':     '🥾',
  'Information':    '👁️',
  'Bridge':         '🌉',
  'Tunnel':         '🚇',
  'Crossing':       '⚠️',
  // RWGPS-style (lowercase)
  'water':          '💧',
  'summit':         '⛰️',
  'viewpoint':      '👁️',
  'overlook':       '👁️',
  'food':           '🍴',
  'restroom':       '🚻',
  'picnic':         '🧺',
  'parking':        '🅿️',
  'bike_shop':      '🚲',
  'bike_parking':   '🚲',
  'camping':        '⛺',
  'lodging':        '🏨',
  'monument':       '🗿',
  'photo':          '📷',
  'shopping':       '🛍️',
  'transit':        '🚇',
  'first_aid':      '⛑️',
  'caution':        '⚠️',
  'crossing':       '🚸',
  'generic':        '📍',
  'Dot':            '📍',
};
function symEmoji(sym) {
  return POI_EMOJI[sym] || POI_EMOJI[String(sym || '').toLowerCase()] || '📍';
}

// RideWithGPS exports always set <sym>Dot</sym> — the actual semantic lives
// in <type> (water / summit / overlook / generic / etc.). Translate that to a
// Garmin-recognized <sym> name so:
//   1) the in-editor icon picks the right emoji, and
//   2) re-saving the GPX produces a sym Garmin Edge devices render natively.
const RWGPS_TYPE_TO_GARMIN_SYM = {
  water:        'Drinking Water',
  food:         'Restaurant',
  restroom:     'Restroom',
  picnic:       'Picnic Area',
  summit:       'Summit',
  overlook:     'Information',
  viewpoint:    'Information',
  parking:      'Pin, Yellow',
  bike_shop:    'Pin, Yellow',
  bike_parking: 'Pin, Yellow',
  camping:      'Pin, Yellow',
  lodging:      'Pin, Yellow',
  monument:     'Pin, Red',
  photo:        'Information',
  shopping:     'Pin, Yellow',
  transit:      'Tunnel',
  first_aid:    'Pin, Red',
  caution:      'Crossing',
  crossing:     'Crossing',
  generic:      'Flag, Blue',
};
function rwgpsToGarminSym(poi) {
  const t = String(poi.type || '').trim().toLowerCase();
  if (t && RWGPS_TYPE_TO_GARMIN_SYM[t]) return RWGPS_TYPE_TO_GARMIN_SYM[t];
  // Garmin-style sym already? Use it. RWGPS's "Dot" alone has no semantic, so
  // fall back to a generic flag in that case.
  if (poi.sym && poi.sym !== 'Dot') return poi.sym;
  return 'Flag, Blue';
}

// Garmin-friendly symbol vocabulary. These names render as native icons on
// Edge cycling computers when present in the GPX <sym> element.
const GARMIN_SYMS = [
  ['Flag, Blue',     'Bandeira azul'],
  ['Flag, Red',      'Bandeira vermelha'],
  ['Flag, Green',    'Bandeira verde'],
  ['Pin, Yellow',    'Pino amarelo'],
  ['Pin, Red',       'Pino vermelho'],
  ['Summit',         'Mirante / pico'],
  ['Restaurant',     'Restaurante'],
  ['Drinking Water', 'Água'],
  ['Restroom',       'Banheiro'],
  ['Picnic Area',    'Piquenique'],
  ['Trail Head',     'Início de trilha'],
  ['Information',    'Informação'],
  ['Bridge',         'Ponte'],
  ['Tunnel',         'Túnel'],
  ['Crossing',       'Travessia'],
];

function tpIcon(isPoi, sym) {
  if (isPoi) {
    return L.divIcon({
      className: 'trackpoint-marker poi',
      html: `<span class="poi-emoji" title="${symLabel(sym)}">${symEmoji(sym)}</span>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
  }
  return L.divIcon({
    className: 'trackpoint-marker',
    html: '<div class="trackpoint-dot"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function refreshMarker(tp) {
  tp.marker.setIcon(tpIcon(tp.isPoi, tp.sym));
  // Show the name as a permanent tooltip — handy for POIs especially.
  if (tp.name) {
    if (!tp.marker.getTooltip()) {
      tp.marker.bindTooltip(tp.name, {
        permanent: true,
        direction: 'right',
        offset: [10, 0],
        className: 'tp-label',
      });
    } else {
      tp.marker.setTooltipContent(tp.name);
    }
  } else if (tp.marker.getTooltip()) {
    tp.marker.unbindTooltip();
  }
}

function openTpPopup(id) {
  const tp = trackpoints.find((t) => t.id === id);
  if (!tp) return;

  const root = document.createElement('div');
  root.className = 'tp-popup-body';
  root.innerHTML = `
    <label class="tp-row">
      <span>Nome</span>
      <input type="text" class="tp-name" placeholder="ex.: Mirante do Pacaembu" />
    </label>
    <label class="tp-row tp-checkbox">
      <input type="checkbox" class="tp-poi" />
      <span>POI Garmin (vira &lt;wpt&gt; no GPX)</span>
    </label>
    <label class="tp-row tp-sym-row">
      <span>Símbolo</span>
      <select class="tp-sym"></select>
    </label>
    <div class="tp-actions">
      <button type="button" class="tp-delete">Remover ponto</button>
    </div>
  `;

  const nameInput = root.querySelector('.tp-name');
  const poiCheck = root.querySelector('.tp-poi');
  const symSelect = root.querySelector('.tp-sym');
  const symRow = root.querySelector('.tp-sym-row');
  const deleteBtn = root.querySelector('.tp-delete');

  for (const [code, label] of GARMIN_SYMS) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = `${label} (${code})`;
    symSelect.appendChild(opt);
  }

  // Pre-check "POI Garmin" for a fresh point (no name, not yet a POI) so
  // dropping a POI is one tap — opening the popup marks it and reveals the
  // symbol picker. Already-configured points (named, or already a POI) keep
  // their state; uncheck to turn it back into a plain route point.
  if (!tp.isPoi && !tp.name) {
    tp.isPoi = true;
    refreshMarker(tp);
    pushHistory();
  }

  nameInput.value = tp.name || '';
  poiCheck.checked = !!tp.isPoi;
  symSelect.value = tp.sym || 'Flag, Blue';
  symRow.style.display = tp.isPoi ? '' : 'none';

  nameInput.addEventListener('input', () => {
    tp.name = nameInput.value;
    refreshMarker(tp);
  });
  nameInput.addEventListener('change', pushHistory);
  poiCheck.addEventListener('change', () => {
    tp.isPoi = poiCheck.checked;
    symRow.style.display = tp.isPoi ? '' : 'none';
    refreshMarker(tp);
    pushHistory();
  });
  symSelect.addEventListener('change', () => {
    tp.sym = symSelect.value;
    refreshMarker(tp);
    pushHistory();
  });
  deleteBtn.addEventListener('click', () => {
    map.closePopup();
    removeTrackpoint(id);
  });

  L.popup({ closeButton: true, autoClose: false, className: 'tp-popup' })
    .setLatLng(tp.marker.getLatLng())
    .setContent(root)
    .openOn(map);
}

async function removeTrackpoint(id) {
  const idx = trackpoints.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const tp = trackpoints[idx];
  map.removeLayer(tp.marker);
  trackpoints.splice(idx, 1);

  // The trackpoint that used to come *after* the removed one needs a fresh
  // pathFromPrev (or null if it just became the first point).
  if (idx < trackpoints.length) {
    const next = trackpoints[idx];
    if (idx === 0) {
      next.pathFromPrev = null;
    } else {
      const prev = trackpoints[idx - 1];
      next.pathFromPrev = straightPath(prev.marker.getLatLng(), next.marker.getLatLng());
    }
  }
  redrawAndMetrics();
  updateTraceControls();
  if (routingMode !== 'straight' && idx > 0 && idx < trackpoints.length) {
    await refetchPath(idx);
    redrawAndMetrics();
  }
  pushHistory();
}

async function onMarkerDragEnd(id) {
  const idx = trackpoints.findIndex((t) => t.id === id);
  if (idx === -1) return;

  // Always update incoming/outgoing straight fallback first so the line snaps
  // to the new waypoint position immediately.
  if (idx > 0) {
    trackpoints[idx].pathFromPrev = straightPath(
      trackpoints[idx - 1].marker.getLatLng(),
      trackpoints[idx].marker.getLatLng(),
    );
  }
  if (idx < trackpoints.length - 1) {
    trackpoints[idx + 1].pathFromPrev = straightPath(
      trackpoints[idx].marker.getLatLng(),
      trackpoints[idx + 1].marker.getLatLng(),
    );
  }
  redrawAndMetrics();

  if (routingMode !== 'straight') {
    if (idx > 0) await refetchPath(idx);
    if (idx < trackpoints.length - 1) await refetchPath(idx + 1);
    redrawAndMetrics();
  }
  pushHistory();
}

function straightPath(fromLatLng, toLatLng) {
  return [
    [fromLatLng.lat, fromLatLng.lng],
    [toLatLng.lat, toLatLng.lng],
  ];
}

// Re-fetch the routed path arriving at trackpoints[idx] from trackpoints[idx-1].
// Falls back to a straight line on any failure.
// `seqOverride`: as chamadas em lote (restaurar rota salva/compartilhada via
// mapConcurrent) DEVEM compartilhar UM único seq, senão cada chamada
// concorrente incrementa o contador global e invalida as irmãs — só o último
// segmento commitava e o resto ficava na reta. Sem override, cada chamada
// (edição interativa) pega seu próprio seq pra invalidar in-flight antigos.
async function refetchPath(idx, seqOverride) {
  const tp = trackpoints[idx];
  const prev = trackpoints[idx - 1];
  if (!tp || !prev) return;

  const seq = seqOverride !== undefined ? seqOverride : ++pendingRouteSeq;
  const tpId = tp.id;
  try {
    let path;
    if (routingMode === 'energy' || routingMode === 'energy_road') {
      const subMode = routingMode === 'energy_road' ? 'road' : 'free';
      path = await energyRoute(prev.marker.getLatLng(), tp.marker.getLatLng(), subMode);
    } else {
      path = await osrmRoute(
        prev.marker.getLatLng(),
        tp.marker.getLatLng(),
        routingMode === 'foot' ? 'foot' : 'cycling',
      );
    }
    const stillExists = trackpoints.find((t) => t.id === tpId);
    if (!stillExists || seq !== pendingRouteSeq) return;
    // Proveniência do segmento: o modo que produziu ESTA geometria. Viaja no
    // snapshot/undo, no rascunho persistido e no GPX exportado (userWaypoints)
    // — reabrir o arquivo devolve a opção de roteamento de cada waypoint.
    if (path) path.mode = routingMode;
    stillExists.pathFromPrev = path;
    scheduleTraceDraftSave();
  } catch (err) {
    console.warn(`Route failed (mode=${routingMode}, idx=${idx}):`, err.message);
    // Keep the straight fallback that was already set.
  }
}

// ─── Roteamento por menor energia (FABDEM + Dijkstra) ────────────────────
// Limite duro do segmento — fora dele o custo do DEM cresce demais e a
// experiência azeda. Acima desta distância cai pra reta. Atenção: o custo
// (mosaico DEM + consulta do viário + Dijkstra) cresce ~quadrático com a
// distância, então segmentos longos são naturalmente mais lentos.
const ENERGY_MAX_SEGMENT_KM = 20;

let _energyWorker = null;
function getEnergyWorker() {
  if (!_energyWorker) {
    _energyWorker = new Worker('./lib/energy-worker.js');
  }
  return _energyWorker;
}

// Contador de requisições pro worker singleton — chamadas concorrentes
// (ex.: mapConcurrent com 4 em voo no restore de share-link/GPX) adicionam
// um listener cada; sem o reqId todas resolveriam com o PRIMEIRO `done`.
let energyReqSeq = 0;

function runEnergyWorker(payload) {
  const w = getEnergyWorker();
  const reqId = ++energyReqSeq;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      w.removeEventListener('message', onmsg);
      w.removeEventListener('error', onerr);
    };
    const onmsg = (ev) => {
      const m = ev.data;
      // Mensagem de outra requisição concorrente — não é nossa, ignora.
      // reqId ausente = worker antigo em cache (pré-eco): aceita pra não
      // pendurar a promise (compatível com chamadas isoladas).
      if (m.reqId !== undefined && m.reqId !== reqId) return;
      if (m.kind === 'progress') return;
      // Só 'done'/'error' resolvem a promise — outros kinds (ex.: 'warning',
      // sem reqId) não têm .path e deixariam o caller com um resultado vazio.
      if (m.kind === 'error') { cleanup(); reject(new Error(m.message)); return; }
      if (m.kind !== 'done') return;
      cleanup();
      resolve(m);
    };
    // Sem isto, uma exceção não-tratada no worker deixava a promise pendurada
    // pra sempre (o caller de estimateEnergy travava). O worker pode ter
    // crashado, então o descartamos pra forçar recriação no próximo uso.
    const onerr = (ev) => {
      cleanup();
      _energyWorker = null;
      reject(new Error(ev.message || 'energy worker error'));
    };
    w.addEventListener('message', onmsg);
    w.addEventListener('error', onerr);
    w.postMessage({ kind: 'run', reqId, ...payload });
  });
}

// Costura tiles 1°×1° em um Float32Array sobre uma bbox dada. Cells fora
// da cobertura → NaN/mask=0. Devolve { height, mask, H, W }.
async function loadFabdemMosaic(bb) {
  const A = FABDEM_ARCSEC;
  const W = Math.round((bb.east  - bb.west)  / A);
  const H = Math.round((bb.north - bb.south) / A);
  const height = new Float32Array(W * H);
  const mask   = new Uint8Array(W * H);
  height.fill(NaN);

  const eps = 1e-9;
  const latLo = Math.floor(bb.south);
  const latHi = Math.floor(bb.north - eps);
  const lonLo = Math.floor(bb.west);
  const lonHi = Math.floor(bb.east  - eps);

  for (let lat = latLo; lat <= latHi; lat++) {
    for (let lon = lonLo; lon <= lonHi; lon++) {
      const t = await openFabdemTile(lat, lon);
      if (!t) continue;
      const interWest  = Math.max(bb.west,  lon);
      const interEast  = Math.min(bb.east,  lon + 1);
      const interSouth = Math.max(bb.south, lat);
      const interNorth = Math.min(bb.north, lat + 1);
      if (interEast <= interWest || interNorth <= interSouth) continue;
      const [oX, oY] = t.origin;
      const [rX, rY] = t.resolution;
      const wnd = [
        Math.round((interWest  - oX) / rX),
        Math.round((interNorth - oY) / rY),
        Math.round((interEast  - oX) / rX),
        Math.round((interSouth - oY) / rY),
      ];
      const raster = await t.image.readRasters({ window: wnd, interleave: true });
      const rW = wnd[2] - wnd[0];
      const rH = wnd[3] - wnd[1];
      const colOffset = Math.round((interWest - bb.west)    / A);
      const rowOffset = Math.round((bb.north  - interNorth) / A);
      for (let r = 0; r < rH; r++) {
        const mr = rowOffset + r;
        if (mr < 0 || mr >= H) continue;
        for (let c = 0; c < rW; c++) {
          const mc = colOffset + c;
          if (mc < 0 || mc >= W) continue;
          const v = raster[r * rW + c];
          if (Number.isFinite(v) && (t.nodata == null || v !== t.nodata)) {
            const idx = mr * W + mc;
            height[idx] = v;
            mask[idx]   = 1;
          }
        }
      }
    }
  }
  return { height, mask, H, W };
}

// Mosaico de elevação a partir do COG de SP, reamostrado pra MESMA grade do
// FABDEM (A = FABDEM_ARCSEC) — assim o Dijkstra e o índice seed/goal seguem
// idênticos, independente da fonte. Lê uma janela única do COG cobrindo a bbox
// e amostra o vizinho mais próximo. Retorna null se a bbox não couber inteira
// na extensão do DEM (aí o chamador cai pro FABDEM, evitando buracos).
async function loadDemHandleMosaic(t, bb) {
  if (!t) return null;
  // Só usa este DEM se a bbox do segmento cabe INTEIRA na extensão dele —
  // senão devolve null e o caller cai pra próxima fonte (sem costurar bordas).
  if (!(withinSampaDem(t.bounds, bb.north, bb.west) &&
        withinSampaDem(t.bounds, bb.south, bb.east))) return null;
  const A = FABDEM_ARCSEC;
  const W = Math.round((bb.east  - bb.west)  / A);
  const H = Math.round((bb.north - bb.south) / A);
  if (!W || !H) return null;
  const [oX, oY] = t.origin;
  const [rX, rY] = t.resolution;   // rX>0, rY<0
  // Janela de pixels do COG que cobre a bbox (com folga de 1).
  const scMin = Math.max(0, Math.floor((bb.west  - oX) / rX) - 1);
  const scMax = Math.min(t.W - 1, Math.ceil((bb.east  - oX) / rX) + 1);
  const srMin = Math.max(0, Math.floor((bb.north - oY) / rY) - 1);
  const srMax = Math.min(t.H - 1, Math.ceil((bb.south - oY) / rY) + 1);
  if (scMax < scMin || srMax < srMin) return null;
  let ras;
  try {
    ras = await t.image.readRasters({
      window: [scMin, srMin, scMax + 1, srMax + 1],
      interleave: true,
    });
  } catch (e) {
    console.warn(`[dem] mosaico falhou: ${e.message}`);
    return null;
  }
  const wndW = scMax - scMin + 1;
  const wndH = srMax - srMin + 1;
  const height = new Float32Array(W * H);
  const mask   = new Uint8Array(W * H);
  height.fill(NaN);
  for (let mr = 0; mr < H; mr++) {
    const lat = bb.north - (mr + 0.5) * A;
    let sr = Math.round((lat - oY) / rY) - srMin;
    if (sr < 0) sr = 0; else if (sr >= wndH) sr = wndH - 1;
    for (let mc = 0; mc < W; mc++) {
      const lng = bb.west + (mc + 0.5) * A;
      let sc = Math.round((lng - oX) / rX) - scMin;
      if (sc < 0) sc = 0; else if (sc >= wndW) sc = wndW - 1;
      const v = ras[sr * wndW + sc];
      if (Number.isFinite(v) && (t.nodata == null || v !== t.nodata)) {
        const idx = mr * W + mc;
        height[idx] = v;
        mask[idx]   = 1;
      }
    }
  }
  return { height, mask, H, W };
}
async function loadSampaDemMosaic(bb) { return loadDemHandleMosaic(await openSampaDem(), bb); }
async function loadCustomDemMosaic(bb) { return loadDemHandleMosaic(_customDem, bb); }

// Tratamento σ do mapa (Entry 74 do bicycling-energy-model): suavização
// Gaussiana do mosaico DEM antes do roteamento por energia. CÓPIA MANTIDA À
// MÃO do smoothHeightsInPlace do sampasimu (app.js; test-dem-smoothing.mjs
// de lá trava a transformação — validada pelo harness da Entry 20): Gaussiana
// sequencial por eixo, normalizada pela máscara, truncada em 3σ, σ_px por
// eixo a partir do passo em metros, in place. Só o roteamento chama (ver
// energyRoute) — a Câmera Topográfica lê o mosaico cru. Não trocar por um
// blur genérico: as escolhas de σ do estudo só valem pra ESTA transformação.
function smoothHeightsInPlace(height, mask, H, W, dxM, dyM, sigmaM) {
  if (!(sigmaM > 0)) return;
  const passes = [
    { sigPx: sigmaM / dxM, horizontal: true },
    { sigPx: sigmaM / dyM, horizontal: false },
  ];
  for (const p of passes) {
    const R = Math.ceil(3 * p.sigPx);
    if (!(R >= 1)) continue;
    const w = new Float64Array(R + 1);
    for (let k = 0; k <= R; k++) w[k] = Math.exp(-(k * k) / (2 * p.sigPx * p.sigPx));
    if (p.horizontal) {
      const buf = new Float64Array(W);
      for (let r = 0; r < H; r++) {
        const base = r * W;
        for (let c = 0; c < W; c++) {
          const idx = base + c;
          if (!mask[idx]) continue;
          let num = w[0] * height[idx], den = w[0];
          for (let k = 1; k <= R; k++) {
            const a = c - k, b = c + k;
            if (a >= 0 && mask[base + a]) { num += w[k] * height[base + a]; den += w[k]; }
            if (b < W && mask[base + b]) { num += w[k] * height[base + b]; den += w[k]; }
          }
          buf[c] = num / den;
        }
        for (let c = 0; c < W; c++) if (mask[base + c]) height[base + c] = buf[c];
      }
    } else {
      // Vertical pass, row-major streaming: for output row r, accumulate the
      // (2R+1) source rows r±k sequentially into num/den, then defer the
      // write by R rows via a ring buffer (source rows must stay unmodified
      // while they can still appear in a later output row's window).
      const num = new Float64Array(W), den = new Float64Array(W);
      const ring = []; // { row, vals: Float64Array }
      const flushRow = (entry) => {
        const base = entry.row * W;
        for (let c = 0; c < W; c++) if (mask[base + c]) height[base + c] = entry.vals[c];
      };
      for (let r = 0; r < H; r++) {
        num.fill(0); den.fill(0);
        const k0 = Math.max(0, r - R), k1 = Math.min(H - 1, r + R);
        for (let rr = k0; rr <= k1; rr++) {
          const wk = w[Math.abs(rr - r)], base = rr * W;
          for (let c = 0; c < W; c++) {
            if (mask[base + c]) { num[c] += wk * height[base + c]; den[c] += wk; }
          }
        }
        const vals = new Float64Array(W);
        const base = r * W;
        for (let c = 0; c < W; c++) vals[c] = mask[base + c] ? num[c] / den[c] : height[base + c];
        ring.push({ row: r, vals });
        // Flush rows whose window can no longer include any unwritten source row.
        while (ring.length && ring[0].row <= r - R) flushRow(ring.shift());
      }
      while (ring.length) flushRow(ring.shift());
    }
  }
}

// Escolhe a fonte do mosaico: DEM custom (se carregado e a bbox cabe nele) →
// DEM de SP (se ligado) → FABDEM. Cada fonte só vale onde cobre a bbox inteira.
async function loadDemMosaic(bb) {
  if (_customDem) {
    const custom = await loadCustomDemMosaic(bb);
    if (custom) return custom;
  }
  if (params.useSampaDem) {
    const sampa = await loadSampaDemMosaic(bb);
    if (sampa) return sampa;
  }
  return loadFabdemMosaic(bb);
}

// Bresenham: pinta (r0,c0)→(r1,c1) na máscara.
function rasterizeLineToMask(mask, W, H, r0, c0, r1, c1) {
  let r = r0, c = c0;
  const dr = Math.abs(r1 - r0), dc = Math.abs(c1 - c0);
  const sr = r0 < r1 ? 1 : -1;
  const sc = c0 < c1 ? 1 : -1;
  let err = dc - dr;
  while (true) {
    if (r >= 0 && r < H && c >= 0 && c < W) mask[r * W + c] = 1;
    if (r === r1 && c === c1) break;
    const e2 = err * 2;
    if (e2 > -dr) { err -= dr; c += sc; }
    if (e2 <  dc) { err += dc; r += sr; }
  }
}

// Constrói a máscara binária do viário (1-célula de largura ≈ 30 m, a
// resolução do FABDEM). Sem dilatação — o caminho fica preso aos eixos
// das vias. O carimbo 3×3 ao redor de seed/goal acontece DEPOIS, em
// energyRoute(), pra garantir que a origem/destino estejam acessíveis
// mesmo que o clique fique a 1 célula do nó OSM mais próximo.
// `lines` são as polilinhas [[lng,lat],…] do viário (queryViarioLines) — as
// mesmas que alimentam o grafo vetorial. Antes vinham do Overpass no formato
// {nodes, ways}; agora a rede é só uma, e este raster é o fallback dela.
function rasterizeRoads(lines, bb, H, W, A) {
  const mask = new Uint8Array(W * H);
  for (const line of lines) {
    let prev = null;
    for (const pt of line) {
      const r = Math.round((bb.north - pt[1]) / A);
      const c = Math.round((pt[0] - bb.west) / A);
      if (prev) rasterizeLineToMask(mask, W, H, prev[0], prev[1], r, c);
      prev = [r, c];
    }
  }
  return mask;
}

// ─── Rede viária vetorial (FlatGeobuf da América do Sul) ────────────────────
// FlatGeobuf do viário (OSM highway= com bridge/tunnel/layer) hospedado junto
// dos DEMs — cobre a AMÉRICA DO SUL inteira. O índice espacial do FGB (packed
// Hilbert R-tree) permite buscar SÓ OS BYTES da bbox via HTTP Range — nada de
// baixar o arquivo inteiro (o antigo gpkg de SP, ~125 MB, era baixado inteiro
// e consultado via sql.js). No "Menor energia pelo viário" é FALLBACK do grafo
// pré-cozido (VIARIO_GRAPH_URL abaixo); segue sendo a fonte PRIMÁRIA do modo
// terreno (água + corredores + portais de ponte/túnel). Gerado por
// scripts/build-viario.py. sql.js/proj4 ficam SÓ pra rede custom em .gpkg.
const VIARIO_FGB_URL       = 'https://telhas.pedalhidrografi.co/viario/south-america-viario.fgb';
const WATER_AREAS_FGB_URL  = 'https://telhas.pedalhidrografi.co/viario/south-america-water-areas.fgb';
const WATER_RIVERS_FGB_URL = 'https://telhas.pedalhidrografi.co/viario/south-america-water-rivers.fgb';
const SQLJS_BASE = 'https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/';
const PROJ4_URL  = 'https://cdn.jsdelivr.net/npm/proj4@2.9.0/dist/proj4.js';

// flatgeobuf (vendorado em lib/): deserialize(url, rect) → async generator de
// Features GeoJSON, buscando por range request; deserialize(Uint8Array) idem
// pra arquivo local (rede custom .fgb).
let _flatgeobufPromise = null;
async function ensureFlatgeobuf() {
  if (!_flatgeobufPromise) {
    _flatgeobufPromise = (async () => {
      if (!window.flatgeobuf) await loadScript('./lib/flatgeobuf-geojson.min.js');
      return window.flatgeobuf;
    })();
    _flatgeobufPromise.catch(() => { _flatgeobufPromise = null; });
  }
  return _flatgeobufPromise;
}

// Cache LRU das consultas FGB por (url, bbox arredondada): o SW NÃO cacheia
// respostas 206 (e é contornado pros .fgb — ver sw.js), então este cache é o
// que absorve a consulta dupla da mesma bbox (modo terreno consulta viário e
// água pro mesmo trecho; rotas re-traçadas idem).
const _fgbCache = new Map();
const FGB_CACHE_MAX = 10;
// `useCache=false` pras CAMADAS DE MAPA (Morros e Águas / Cicloinfra): elas
// reconsultam a cada pan, então cada viewport viraria uma entrada nova e as 10
// vagas do LRU acabariam segurando 10 viewports inteiras de feições na memória
// — dezenas de milhares de linhas cada. Elas redesenham do zero de qualquer
// jeito, e os BYTES já ficam no cache HTTP do navegador (o SW deixa .fgb
// passar direto justamente pra não estragar as respostas 206).
async function streamFgbFeatures(url, bb, useCache = true) {
  const key = `${url}|${bb.west.toFixed(4)},${bb.south.toFixed(4)},${bb.east.toFixed(4)},${bb.north.toFixed(4)}`;
  if (useCache && _fgbCache.has(key)) {
    const v = _fgbCache.get(key);
    _fgbCache.delete(key); _fgbCache.set(key, v);   // refresca a posição LRU
    return v;
  }
  const fgb = await ensureFlatgeobuf();
  const rect = { minX: bb.west, minY: bb.south, maxX: bb.east, maxY: bb.north };
  // O deserialize não aceita AbortSignal — o timeout corre por fora e rejeita
  // a espera (as fetches órfãs morrem sozinhas quando o generator é solto).
  const feats = [];
  await Promise.race([
    (async () => { for await (const f of fgb.deserialize(url, rect)) feats.push(f); })(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout FGB')), VIARIO_FETCH_TIMEOUT_MS)),
  ]);
  if (useCache) {
    _fgbCache.set(key, feats);
    while (_fgbCache.size > FGB_CACHE_MAX) _fgbCache.delete(_fgbCache.keys().next().value);
  }
  return feats;
}

let _sqlJsPromise = null;
async function ensureSqlJs() {
  if (!_sqlJsPromise) {
    _sqlJsPromise = (async () => {
      if (typeof window.initSqlJs !== 'function') await loadScript(SQLJS_BASE + 'sql-wasm.js');
      return window.initSqlJs({ locateFile: (f) => SQLJS_BASE + f });
    })();
    _sqlJsPromise.catch(() => { _sqlJsPromise = null; });
  }
  return _sqlJsPromise;
}
let _proj4Promise = null;
async function ensureProj4() {
  if (!_proj4Promise) {
    _proj4Promise = (async () => {
      if (!window.proj4) await loadScript(PROJ4_URL);
      return window.proj4;
    })();
    _proj4Promise.catch(() => { _proj4Promise = null; });
  }
  return _proj4Promise;
}

// Decodifica blob StandardGeoPackageBinary → array de linhas ([x,y][]),
// ou null quando a geometria não é (Multi)LineString. Layout do header
// conforme OGC GeoPackage 1.4 §2.1.3.
function parseGpkgGeom(blob) {
  if (!(blob instanceof Uint8Array) || blob.length < 8) return null;
  if (blob[0] !== 0x47 || blob[1] !== 0x50) return null; // "GP"
  const flags = blob[3];
  const envelopeType = (flags >> 1) & 0x07;
  const envBytes = [0, 32, 48, 48, 64, 0, 0, 0][envelopeType] || 0;
  const wkbStart = 8 + envBytes;
  if (blob.length < wkbStart + 9) return null;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  return parseWKB(view, wkbStart);
}
// Tipo WKB → tipo-base 2-D + stride por vértice. Cobre as duas codificações
// de dimensão: ISO/OGC (1002 = LineString Z, padrão do QGIS p/ fontes 3-D) e
// EWKB (bits 0x80000000 Z / 0x40000000 M).
function wkbTypeInfo(t) {
  const code = t & 0x0fffffff;
  const base = code % 1000;
  const isoDim = Math.floor(code / 1000) | 0;
  const hasZ = (t & 0x80000000) !== 0 || isoDim === 1 || isoDim === 3;
  const hasM = (t & 0x40000000) !== 0 || isoDim === 2 || isoDim === 3;
  return { base, stride: 16 + (hasZ ? 8 : 0) + (hasM ? 8 : 0) };
}
function parseWKB(view, off) {
  const le = view.getUint8(off) === 1; off += 1;
  const t = view.getUint32(off, le);   off += 4;
  const { base: baseType, stride } = wkbTypeInfo(t);
  if (baseType === 2) { // LineString
    const n = view.getUint32(off, le); off += 4;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = [view.getFloat64(off, le), view.getFloat64(off + 8, le)];
      off += stride;
    }
    return [out];
  }
  if (baseType === 5) { // MultiLineString — cada filho repete o header
    const k = view.getUint32(off, le); off += 4;
    const lines = [];
    for (let j = 0; j < k; j++) {
      const subLE = view.getUint8(off) === 1; off += 1;
      const subT = view.getUint32(off, subLE); off += 4;
      const { base: subBase, stride: subStride } = wkbTypeInfo(subT);
      if (subBase !== 2) return null;
      const n = view.getUint32(off, subLE); off += 4;
      const ln = new Array(n);
      for (let i = 0; i < n; i++) {
        ln[i] = [view.getFloat64(off, subLE), view.getFloat64(off + 8, subLE)];
        off += subStride;
      }
      lines.push(ln);
    }
    return lines;
  }
  return null;
}

// Timeout compartilhado das buscas de rede do viário (FGB, grafo pré-cozido).
const VIARIO_FETCH_TIMEOUT_MS = 60000;

// Abre um GeoPackage (bytes já em memória) num handle de viário reusável pelas
// consultas — descobre a camada de linhas, resolve o CRS (reprojeção proj4
// quando não é WGS84) e quais tags de tabuleiro existem. Só usado pela REDE
// CUSTOM em .gpkg (o viário remoto migrou pra FlatGeobuf); uma camada `water`
// que exista num gpkg custom é ignorada. Quando a fonte é WGS84 o caminho
// comum NÃO carrega proj4 nem reprojeta vértice a vértice — os transformadores
// `toWgs`/`fromWgs` viram identidade. O parser de geometria é o
// `parseGpkgGeom` acima.
async function buildViarioSrc(SQL, bytes) {
  const db = new SQL.Database(bytes);
  try {
  const gc = db.exec('SELECT table_name, column_name, srs_id FROM gpkg_geometry_columns');
  if (!gc.length || !gc[0].values.length) throw new Error('gpkg sem gpkg_geometry_columns');
  // Pode haver 2+ camadas (ex.: `water` num gpkg antigo) — fica a 1ª de linhas.
  let vRow = null;
  for (const r of gc[0].values) { if (r[0] !== 'water' && !vRow) vRow = r; }
  if (!vRow) vRow = gc[0].values[0];
  const tableName = vRow[0];
  const geomCol   = vRow[1] || 'geom';
  const srsId     = vRow[2];
  const isSrcWgs = srsId === 4326 || srsId === 0 || srsId === -1;
  let toWgs = (xy) => xy;     // fonte → [lng,lat]   (vértices)
  let fromWgs = (xy) => xy;   // [lng,lat] → fonte   (cantos da bbox)
  if (!isSrcWgs) {
    const proj4 = await ensureProj4();
    const srsRes = db.exec(`SELECT definition FROM gpkg_spatial_ref_sys WHERE srs_id = ${srsId}`);
    if (!srsRes.length || !srsRes[0].values[0][0]) throw new Error(`SRS ${srsId} sem definição`);
    proj4.defs(`EPSG:${srsId}`, srsRes[0].values[0][0]);
    const tr = proj4('EPSG:4326', `EPSG:${srsId}`);  // transformador reusável
    toWgs = (xy) => tr.inverse(xy);
    fromWgs = (xy) => tr.forward(xy);
  }
  // Tags de ponte/túnel/nível pro achatamento do tabuleiro no roteamento.
  // Esquemas variam: colunas dedicadas (bridge/tunnel/layer) OU um hstore
  // `other_tags` (export do osmium/QGIS). Lemos as que existirem; se nenhuma,
  // o grafo roteia sem achatamento (e o FGB do viário vira a fonte das tags,
  // por proximidade — ver fetchViarioDecksForBbox/markDecksByProximity).
  let tagCols = [];
  try {
    const ti = db.exec(`PRAGMA table_info("${tableName}")`);
    const allCols = ti.length ? ti[0].values.map((r) => r[1]) : [];
    tagCols = ['bridge', 'tunnel', 'layer', 'name', 'other_tags'].filter((c) => allCols.includes(c));
  } catch { /* sem tags = sem achatamento */ }
  return { db, tableName, geomCol, isSrcWgs, toWgs, fromWgs, tagCols };
  } catch (e) {
    try { db.close(); } catch { /* já fechado */ }   // não vaza o handle WASM na falha
    throw e;
  }
}

// ─── Grafo pré-cozido do viário (sampa-viario-graph.bin) ─────────────────────
// Fonte PRIMÁRIA do "Menor energia pelo viário": o grafo já montado no bake
// (scripts/build-viario.py --graph) com as elevações amostradas POR NÓ (DEM de
// SP ~5 m onde cobre, FABDEM no resto) e tabuleiros de ponte/túnel achatados em
// rampa. Zero DEM, zero montagem de grafo por sessão: a decodificação é um
// passe de typed arrays. O FGB do viário (streamFgbFeatures acima) segue em
// uso pro modo TERRENO (água/corredores/portais) e como fallback do viário
// fora da cobertura do grafo (que é SÓ SP — o FGB cobre a América do Sul).
// Formato: ver o bloco "Grafo pré-cozido" no script.
const VIARIO_GRAPH_URL = 'https://telhas.pedalhidrografi.co/viario/sampa-viario-graph.bin';

// Custo v2 por aresta — IDÊNTICO ao v2Edge do worker (lib/energy-worker.js) e
// ao v2_edge do backend Rust do simujaules; manter em sincronia. dist = metros
// de solo, dh = desnível com sinal. Rolamento sempre; arrasto só fora das
// subidas; recuperação na descida ε por grade. Compartilhado pelo grafo do
// FGB (viarioGraphRoute) e pelo grafo pré-cozido (bakedViarioRoute).
function v2EdgeCostFn(cost) {
  return (dist, dh) => {
    if (dh >= 0) {
      const aero = (dh < cost.climbThr * dist) ? cost.aAero * dist : 0;
      return cost.aRoll * dist + aero + cost.beta * dh;
    }
    const ndh = -dh;
    let eps = cost.abRatio * dist / ndh;
    if (eps > 1) eps = 1;
    eps -= cost.epsOffset;
    if (eps < 0) eps = 0;
    const e = cost.aRoll * dist + cost.aAero * dist - eps * cost.beta * ndh;
    return e < 0 ? 0 : e;
  };
}

// Decodifica o binário PHVG (little-endian; seções alinhadas a 4 bytes) e
// reconstrói o CSR num passe. Nós em µgrau (1e-6 — a MESMA quantização de
// junção do viarioGraphRoute), elevação em decímetros, flags bit0 = interior
// de tabuleiro, bit1 = aresta de cadeia pro nó i+1.
function decodeViarioGraph(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 24 || dv.getUint32(0, true) !== 0x47564850) // 'PHVG' LE
    throw new Error('grafo: magic inválido');
  const version = dv.getUint32(4, true);
  if (version !== 1) throw new Error(`grafo: versão ${version} não suportada`);
  const N = dv.getUint32(8, true);
  const NESC = dv.getUint32(12, true);
  const EX = dv.getUint32(16, true);
  let off = 24;
  const pad4 = () => { off = (off + 3) & ~3; };
  const view = (Ctor, len) => { pad4(); const v = new Ctor(buf, off, len); off += len * Ctor.BYTES_PER_ELEMENT; return v; };
  const dLat  = view(Int16Array, N);
  const dLng  = view(Int16Array, N);
  const elev  = view(Int16Array, N);   // dm
  const flags = view(Uint8Array, N);
  const chain = view(Uint16Array, N);  // dm
  const escIdx = view(Uint32Array, NESC);
  const escLat = view(Int32Array, NESC);
  const escLng = view(Int32Array, NESC);
  const exU = view(Uint32Array, EX);
  const exV = view(Uint32Array, EX);
  const exD = view(Uint16Array, EX);   // dm
  if (off > buf.byteLength) throw new Error('grafo: arquivo truncado');

  // Deltas → coordenadas absolutas (µgrau). Sentinela dLat=-32768 → escape.
  const latU = new Int32Array(N), lngU = new Int32Array(N);
  let pLat = 0, pLng = 0, e = 0;
  for (let i = 0; i < N; i++) {
    if (dLat[i] === -32768) {
      if (e >= NESC || escIdx[e] !== i) throw new Error('grafo: escape fora de ordem');
      pLat = escLat[e]; pLng = escLng[e]; e++;
    } else {
      pLat += dLat[i]; pLng += dLng[i];
    }
    latU[i] = pLat; lngU[i] = pLng;
  }

  // CSR: grau → prefix-sum → preenchimento (cadeia i↔i+1 + explícitas).
  const indptr = new Uint32Array(N + 1);
  for (let i = 0; i < N; i++) if ((flags[i] & 2) && i + 1 < N) { indptr[i + 1]++; indptr[i + 2]++; }
  for (let k = 0; k < EX; k++) { indptr[exU[k] + 1]++; indptr[exV[k] + 1]++; }
  for (let i = 0; i < N; i++) indptr[i + 1] += indptr[i];
  const E2 = indptr[N];
  const targets = new Uint32Array(E2);
  const edist   = new Uint16Array(E2);  // dm
  const cursor  = indptr.slice(0, N);
  const put = (u, v, d) => { const c = cursor[u]++; targets[c] = v; edist[c] = d; };
  for (let i = 0; i < N; i++) if ((flags[i] & 2) && i + 1 < N) { put(i, i + 1, chain[i]); put(i + 1, i, chain[i]); }
  for (let k = 0; k < EX; k++) { put(exU[k], exV[k], exD[k]); put(exV[k], exU[k], exD[k]); }
  return { N, latU, lngU, elev, flags, indptr, targets, edist };
}

let _viarioGraphPromise = null;
async function ensureViarioGraph() {
  if (_viarioGraphPromise) return _viarioGraphPromise;
  _viarioGraphPromise = (async () => {
    showToast('Baixando grafo do viário de SP (uma vez)…');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), VIARIO_FETCH_TIMEOUT_MS);
    let buf;
    try {
      const t0 = performance.now();
      const res = await fetch(VIARIO_GRAPH_URL, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`grafo ${res.status}`);
      buf = await res.arrayBuffer();
      const g = decodeViarioGraph(buf);
      console.info(`[viario] grafo pré-cozido: ${g.N} nós · ${g.indptr[g.N]} arestas dirigidas · ` +
        `${(buf.byteLength / 1e6).toFixed(0)} MB em ${(performance.now() - t0).toFixed(0)} ms`);
      return g;
    } finally {
      clearTimeout(timer);
    }
  })();
  _viarioGraphPromise.catch(() => { _viarioGraphPromise = null; });
  return _viarioGraphPromise;
}

// Buffers de trabalho do Dijkstra no grafo pré-cozido, reusados entre chamadas
// (N ~5 M — realocar por rota seria ~70 MB de churn). Seguro mesmo com rotas
// concorrentes (mapConcurrent): o miolo síncrono roda sem await no meio.
let _bakedScratch = null;
function bakedScratch(N) {
  if (!_bakedScratch || _bakedScratch.dist.length !== N) {
    _bakedScratch = {
      allowed: new Uint8Array(N),
      done:    new Uint8Array(N),
      dist:    new Float32Array(N),
      prev:    new Int32Array(N),
    };
  }
  return _bakedScratch;
}

// Roteia origem→destino no grafo pré-cozido, restrito à bbox (paridade com o
// grafo por-bbox do FGB). Devolve a polilinha [lat,lng] com .deckFlag, ou
// null se não há caminho. Sem DEM: as elevações já vêm baked por nó.
async function bakedViarioRoute(fromLatLng, toLatLng, bb) {
  const g = await ensureViarioGraph();
  const t0 = performance.now();
  const { N, latU, lngU, elev, flags, indptr, targets, edist } = g;
  const s6 = Math.round(bb.south * 1e6), n6 = Math.round(bb.north * 1e6);
  const w6 = Math.round(bb.west * 1e6),  e6 = Math.round(bb.east * 1e6);
  const sc = bakedScratch(N);
  const { allowed, done, dist, prev } = sc;
  done.fill(0); dist.fill(Infinity);

  // Passe único: marca os nós na bbox e acha o nó mais próximo de cada ponta
  // (mesma métrica não escalada do nearest() do viarioGraphRoute).
  const fLat = Math.round(fromLatLng.lat * 1e6), fLng = Math.round(fromLatLng.lng * 1e6);
  const tLat = Math.round(toLatLng.lat * 1e6),   tLng = Math.round(toLatLng.lng * 1e6);
  let s = -1, t = -1, sD = Infinity, tD = Infinity, nAllowed = 0;
  for (let i = 0; i < N; i++) {
    const la = latU[i], lg = lngU[i];
    if (la < s6 || la > n6 || lg < w6 || lg > e6) { allowed[i] = 0; continue; }
    allowed[i] = 1; nAllowed++;
    let dl = la - fLat, dg = lg - fLng;
    let d = dl * dl + dg * dg;
    if (d < sD) { sD = d; s = i; }
    dl = la - tLat; dg = lg - tLng;
    d = dl * dl + dg * dg;
    if (d < tD) { tD = d; t = i; }
  }
  if (s < 0 || t < 0) return null;

  const edgeCost = v2EdgeCostFn(readCost(params));
  const heap = new MinHeap();
  dist[s] = 0;
  heap.push(0, s);
  while (heap.size) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === t) break;
    const du = dist[u], hu = elev[u];
    for (let k = indptr[u], end = indptr[u + 1]; k < end; k++) {
      const v = targets[k];
      if (done[v] || !allowed[v]) continue;
      const w = edgeCost(edist[k] * 0.1, (elev[v] - hu) * 0.1);
      const nd = du + w;
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; heap.push(nd, v); }
    }
  }
  if (!done[t]) {
    console.info(`[viario] grafo pré-cozido: ${nAllowed} nós na bbox · sem caminho`);
    return null;
  }

  const path = [];
  const deckFlag = [];
  for (let v = t; ; v = prev[v]) {
    path.push([latU[v] / 1e6, lngU[v] / 1e6]);
    deckFlag.push(!!(flags[v] & 1));
    if (v === s) break;
  }
  path.reverse(); deckFlag.reverse();
  path.unshift([fromLatLng.lat, fromLatLng.lng]); deckFlag.unshift(false);
  path.push([toLatLng.lat, toLatLng.lng]); deckFlag.push(false);
  path.deckFlag = deckFlag;
  // Objetivo do roteador (J) — exibido na barra de métricas (ver energyRoute).
  path.routedEnergyJ = dist[t];
  console.info(`[viario] grafo pré-cozido: ${nAllowed} nós na bbox · rota ${path.length} pts em ` +
    `${(performance.now() - t0).toFixed(0)} ms`);
  return path;
}

// ─── Rede viária custom (fgb, gpkg ou GeoJSON carregado de arquivo) ──────────
// Carregada em memória pelo modal "Fontes de dados"; tem PRIORIDADE sobre o
// FGB da América do Sul no "Menor energia pelo viário". .fgb é
// parseado inteiro (arquivo local não ganha nada com range) e vira o kind
// geojson; .gpkg passa pelo pipeline sql.js (buildViarioSrc + queryGpkgLines);
// GeoJSON (sempre WGS84, RFC 7946) é varrido direto pra [lng,lat]. Efêmera:
// some ao recarregar.
let _customNetwork = null;   // { kind:'gpkg', src, name } | { kind:'geojson', fc, name }
async function setCustomNetwork(file) {
  const name = file.name || 'rede';
  const lower = name.toLowerCase();
  // Carrega o novo PRIMEIRO; só depois fecha o anterior — assim uma falha de
  // leitura preserva a rede atual em vez de deixar o usuário sem nenhuma.
  let next;
  if (lower.endsWith('.fgb')) {
    const fgb = await ensureFlatgeobuf();
    const feats = [];
    // deserialize(Uint8Array) também é um async generator (sem range).
    for await (const f of fgb.deserialize(new Uint8Array(await file.arrayBuffer()))) feats.push(f);
    if (!feats.length) throw new Error('FGB sem feições');
    next = { kind: 'geojson', fc: { features: feats }, name };
  } else if (lower.endsWith('.geojson') || lower.endsWith('.json')) {
    const fc = JSON.parse(await file.text());
    const feats = fc && (fc.type === 'FeatureCollection' ? fc.features
      : fc.type === 'Feature' ? [fc] : (Array.isArray(fc) ? fc : null));
    if (!Array.isArray(feats)) throw new Error('GeoJSON sem FeatureCollection/Feature');
    next = { kind: 'geojson', fc: { features: feats }, name };
  } else {
    const SQL = await ensureSqlJs();
    const src = await buildViarioSrc(SQL, new Uint8Array(await file.arrayBuffer()));
    next = { kind: 'gpkg', src, name };
  }
  clearCustomNetwork();   // fecha o db do gpkg anterior (se houver) sem vazar
  _customNetwork = next;
  return _customNetwork;
}
function clearCustomNetwork() {
  if (_customNetwork && _customNetwork.kind === 'gpkg') {
    try { _customNetwork.src.db.close(); } catch { /* já fechado */ }
  }
  _customNetwork = null;
}

// Linhas de uma rede GeoJSON que tocam a bbox → mesmo formato de queryViarioLines
// ({ lines:[[lng,lat],…], meta:[{deck,…}], hasTags }). GeoJSON é sempre WGS84.
function queryGeojsonLines(bb, fc) {
  const lines = [], meta = [];
  let hasTags = false;
  for (const f of (fc.features || [])) {
    const g = f && f.geometry; if (!g) continue;
    const props = f.properties || {};
    if (props.bridge != null || props.tunnel != null) hasTags = true;
    const bridge = props.bridge, tunnel = props.tunnel;
    const deck = (bridge && bridge !== 'no') || tunnel === 'yes';
    const m = deck
      ? { deck: true, tunnel: tunnel === 'yes', layer: parseInt(props.layer, 10) || (tunnel === 'yes' ? -1 : 1) }
      : { deck: false };
    const polys = g.type === 'LineString' ? [g.coordinates]
      : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const coords of polys) {
      if (!Array.isArray(coords) || coords.length < 2) continue;
      let loX = Infinity, hiX = -Infinity, loY = Infinity, hiY = -Infinity;
      for (const c of coords) {
        const x = c[0], y = c[1];
        if (x < loX) loX = x; if (x > hiX) hiX = x;
        if (y < loY) loY = y; if (y > hiY) hiY = y;
      }
      if (hiX < bb.west || loX > bb.east || hiY < bb.south || loY > bb.north) continue;
      lines.push(coords.map((c) => [c[0], c[1]]));   // [lng,lat]
      meta.push(m);
    }
  }
  return { lines, meta, hasTags };
}

// Despacha a consulta da rede custom (gpkg → pipeline sql.js; geojson/fgb → varre).
async function queryCustomNetworkLines(bb) {
  if (!_customNetwork) return { lines: [], meta: [], hasTags: false };
  if (_customNetwork.kind === 'geojson') return queryGeojsonLines(bb, _customNetwork.fc);
  return queryViarioLines(bb, _customNetwork.src);
}

// Ganchos de depuração do stack do viário (o app é um module — sem isto nada
// é alcançável do console). Ex.: __phidroViario.queryViarioLines({west,south,
// east,north}) pra inspecionar o que o FGB devolve numa bbox.
window.__phidroViario = {
  queryViarioLines, queryWater, streamFgbFeatures,
  setCustomNetwork, clearCustomNetwork, queryCustomNetworkLines,
};

// Consulta o viário que cai na bbox e devolve as linhas em WGS84 (array de
// polilinhas [[lng,lat], …]). É a matéria-prima do roteamento vetorial — a
// rota segue a geometria real das vias, sem o serrilhado do grid raster.
// Sem `src`: o FGB remoto da América do Sul, por range request (só os bytes
// da bbox). Com `src`: um .gpkg custom já aberto (pipeline sql.js abaixo).
async function queryViarioLines(bb, src) {
  if (!src) {
    const t0 = performance.now();
    const feats = await streamFgbFeatures(VIARIO_FGB_URL, bb);
    const out = queryGeojsonLines(bb, { features: feats });
    // O produtor SEMPRE grava bridge/tunnel/layer no FGB — hasTags fixo em
    // true pra nunca acionar o fallback de tags por proximidade (que só
    // existia pra gpkg antigo sem colunas).
    out.hasTags = true;
    const decks = out.meta.reduce((n, m) => n + (m.deck ? 1 : 0), 0);
    console.info(`[viario] FGB ${(performance.now() - t0).toFixed(0)} ms · ` +
      `${feats.length} feições → ${out.lines.length} linhas na bbox (${decks} tabuleiros)`);
    return out;
  }
  return queryGpkgLines(bb, src);
}

// Pipeline sql.js da rede custom em .gpkg (era o caminho do antigo gpkg de SP).
async function queryGpkgLines(bb, src) {
  const { db, tableName, geomCol, isSrcWgs, toWgs, fromWgs, tagCols } = src;
  const t0 = performance.now();
  // Geometria é a coluna 0; as tags (se houver) vêm depois, nesta ordem.
  const tagIdx = {}; (tagCols || []).forEach((c, i) => { tagIdx[c] = i + 1; });
  const tagSel = (tagCols || []).map((c) => `, t."${c}"`).join('');
  // Lê bridge/tunnel/layer da linha — coluna dedicada OU hstore other_tags.
  // Túnel ou bridge!=no → "deck" (tabuleiro plano); senão via comum.
  const deckMeta = (row) => {
    if (!tagCols || !tagCols.length) return { deck: false };
    const get = (c) => (tagIdx[c] != null ? row[tagIdx[c]] : null);
    const ot = get('other_tags');
    const otv = (k) => { if (!ot) return null; const m = ot.match(new RegExp('"' + k + '"=>"([^"]*)"')); return m ? m[1] : null; };
    const bridge = get('bridge') || otv('bridge');
    const tunnel = get('tunnel') || otv('tunnel');
    const deck = (bridge && bridge !== 'no') || tunnel === 'yes';
    if (!deck) return { deck: false };
    const layerRaw = get('layer') || otv('layer');
    return { deck: true, tunnel: tunnel === 'yes', layer: parseInt(layerRaw, 10) || (tunnel === 'yes' ? -1 : 1) };
  };

  // bbox em CRS de origem pro filtro R-tree (evita varrer o estado inteiro).
  let xmin, xmax, ymin, ymax;
  if (isSrcWgs) {
    xmin = bb.west; xmax = bb.east; ymin = bb.south; ymax = bb.north;
  } else {
    const corners = [
      [bb.west, bb.south], [bb.east, bb.south],
      [bb.east, bb.north], [bb.west, bb.north],
    ].map(fromWgs);
    xmin = Math.min(...corners.map((p) => p[0]));
    xmax = Math.max(...corners.map((p) => p[0]));
    ymin = Math.min(...corners.map((p) => p[1]));
    ymax = Math.max(...corners.map((p) => p[1]));
  }

  const rtree = `rtree_${tableName}_${geomCol}`;
  let stmt, usedRtree = true;
  try {
    stmt = db.prepare(`
      SELECT t."${geomCol}"${tagSel} FROM "${tableName}" t
      WHERE t.fid IN (
        SELECT id FROM "${rtree}"
        WHERE minx <= ? AND maxx >= ? AND miny <= ? AND maxy >= ?
      )`);
    stmt.bind([xmax, xmin, ymax, ymin]);
  } catch (e) {
    // Sem R-tree = scan da tabela INTEIRA por segmento — o caso lento. Avisa.
    console.warn('[viario] SEM R-tree — scan completo (lento!):', e.message);
    usedRtree = false;
    stmt = db.prepare(`SELECT t."${geomCol}"${tagSel} FROM "${tableName}" t`); // alias t: tagSel usa t."col"
  }

  const lines = [];
  const meta = []; // paralelo a `lines`: { deck, tunnel?, layer? } por linha
  let scanned = 0, kept = 0, decks = 0;
  while (stmt.step()) {
    scanned++;
    const row = stmt.get();
    const geom = parseGpkgGeom(row[0]);
    if (!geom) continue;
    const m = deckMeta(row);
    for (const coords of geom) {
      // Filtro bbox em JS (coords da fonte): ESSENCIAL quando o módulo R-tree
      // não está no sql.js (a query cai pro scan da tabela inteira) — mantém só
      // as linhas que tocam a bbox do segmento; sem isso, o grafo abrangeria
      // SP inteira (~3 M nós/segmento). Com R-tree, é um no-op barato.
      let loX = Infinity, hiX = -Infinity, loY = Infinity, hiY = -Infinity;
      for (let i = 0; i < coords.length; i++) {
        const x = coords[i][0], y = coords[i][1];
        if (x < loX) loX = x; if (x > hiX) hiX = x;
        if (y < loY) loY = y; if (y > hiY) hiY = y;
      }
      if (hiX < xmin || loX > xmax || hiY < ymin || loY > ymax) continue;
      const out = new Array(coords.length);
      for (let i = 0; i < coords.length; i++) {
        out[i] = isSrcWgs ? coords[i] : toWgs(coords[i]);   // [lng, lat]
      }
      lines.push(out);
      meta.push(m); // MultiLineString: cada filho herda as tags da feição
      kept++;
      if (m.deck) decks++;
    }
  }
  stmt.free();
  console.info(`[viario] consulta ${(performance.now() - t0).toFixed(0)} ms · ` +
    `${scanned} varridas → ${lines.length} na bbox (${decks} tabuleiros) · rtree=${usedRtree} · ` +
    `crs=${isSrcWgs ? 'wgs84' : 'reprojetado'} · tags=${(tagCols || []).join('|') || 'nenhuma'}`);
  // hasTags: o gpkg já traz ponte/túnel (não precisa casar por proximidade).
  const hasTags = (tagCols || []).some((c) => c === 'bridge' || c === 'tunnel' || c === 'other_tags');
  return { lines, meta, hasTags };
}

// Pontes/viadutos (bridge!=no) e túneis (tunnel=yes) do viário na bbox, COM
// geometria. Só entra pra uma rede CUSTOM sem tags (o FGB remoto sempre traz
// bridge/tunnel — hasTags fixo em true): é o viário que diz quais
// linhas são tabuleiros pra achatar. Pull pequeno (poucas estruturas por
// segmento). Best-effort: falha → sem achatamento.
// Pontes/túneis da bbox pra marcar tabuleiro numa rede CUSTOM que não traz as
// tags. Antes era uma consulta Overpass própria; agora sai do MESMO FGB do
// viário, que já carrega bridge/tunnel/layer — uma fonte a menos e uma
// consulta a menos (o LRU do streamFgbFeatures ainda reaproveita a busca que
// o roteamento já fez pra esta bbox).
async function fetchViarioDecksForBbox(bb) {
  const { lines, meta } = await queryViarioLines(bb);
  const decks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = meta[i];
    if (!m || !m.deck) continue;
    decks.push({ pts: lines[i], tunnel: !!m.tunnel, layer: m.layer });
  }
  return decks;
}

// Marca quais linhas da rede (custom sem tags) são tabuleiros casando-as por
// PROXIMIDADE com as pontes/túneis do OSM. Como ambas seguem a mesma
// estrutura física, ficam a poucos metros uma da outra. Uma linha vira deck se
// a maioria (≥60%) dos seus vértices amostrados está a ≤ TOL de algum segmento
// de ponte do OSM — conservador, pra NÃO achatar uma via de superfície que só
// CRUZA o viaduto (toca em ~1 ponto) nem uma paralela distante. Anota
// tunnel/layer da estrutura casada. Devolve quantas linhas marcou.
function markDecksByProximity(lines, meta, decks, bb) {
  if (!decks || !decks.length) return 0;
  const TOL = 14, TOL2 = TOL * TOL;            // m — rede vs OSM ~uma faixa
  const midLat = (bb.south + bb.north) / 2;
  const mPerLat = 111320, mPerLng = 111320 * Math.cos(midLat * Math.PI / 180);
  const segs = [];                              // [x0,y0,x1,y1,deck] em metros
  for (const d of decks) {
    for (let i = 0; i + 1 < d.pts.length; i++) {
      segs.push([d.pts[i][0] * mPerLng, d.pts[i][1] * mPerLat,
                 d.pts[i + 1][0] * mPerLng, d.pts[i + 1][1] * mPerLat, d]);
    }
  }
  if (!segs.length) return 0;
  const ptSeg2 = (px, py, x0, y0, x1, y1) => {
    const dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy;
    let tt = L2 ? ((px - x0) * dx + (py - y0) * dy) / L2 : 0;
    tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
    const ex = x0 + tt * dx - px, ey = y0 + tt * dy - py;
    return ex * ex + ey * ey;
  };
  let marked = 0;
  for (let li = 0; li < lines.length; li++) {
    if (meta[li] && meta[li].deck) continue;   // já marcado por tag do gpkg
    const line = lines[li];
    const step = Math.max(1, (line.length / 6) | 0); // amostra ≤ ~6 vértices
    let near = 0, tot = 0, matched = null;
    for (let i = 0; i < line.length; i += step) {
      tot++;
      const px = line[i][0] * mPerLng, py = line[i][1] * mPerLat;
      let best = Infinity, bestD = null;
      for (const s of segs) { const d2 = ptSeg2(px, py, s[0], s[1], s[2], s[3]); if (d2 < best) { best = d2; bestD = s[4]; } }
      if (best <= TOL2) { near++; matched = bestD; }
    }
    if (tot && near / tot >= 0.6 && matched) {
      meta[li] = { deck: true, tunnel: matched.tunnel, layer: matched.layer };
      marked++;
    }
  }
  return marked;
}

// ── Água (FGBs de áreas + rios) → máscara de barreira no "Menor energia pelo
//    terreno" ──────────────────────────────────────────────────────────────
// A água vem em DOIS FGBs (FGB é mono-camada): polígonos (lagos/represas/
// riverbank) e linhas (waterway=river). Preenche os polígonos (even-odd,
// buracos = ilhas) e barra os rios (supercover). Coords [lng,lat].
// Even-odd scanline fill (rings em coords de GRADE) → marca `out` (1 = barrado).
function fillRingsEvenOdd(rings, out, W, H) {
  let yMin = Infinity, yMax = -Infinity;
  for (const r of rings) for (const p of r) { if (p[1] < yMin) yMin = p[1]; if (p[1] > yMax) yMax = p[1]; }
  if (!Number.isFinite(yMin)) return;
  const r0 = Math.max(0, Math.floor(yMin)), r1 = Math.min(H - 1, Math.floor(yMax));
  const xs = [];
  for (let ry = r0; ry <= r1; ry++) {
    const yc = ry + 0.5; xs.length = 0;
    for (const ring of rings) { const n = ring.length; if (n < 3) continue; for (let i = 0, j = n - 1; i < n; j = i++) { const yi = ring[i][1], yj = ring[j][1]; if ((yi > yc) !== (yj > yc)) xs.push(ring[i][0] + (yc - yi) / (yj - yi) * (ring[j][0] - ring[i][0])); } }
    if (xs.length < 2) continue; xs.sort((a, b) => a - b); const base = ry * W;
    for (let k = 0; k + 1 < xs.length; k += 2) { const cA = Math.max(0, Math.ceil(xs[k] - 0.5)), cB = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5)); for (let c = cA; c <= cB; c++) out[base + c] = 1; }
  }
}
// Supercover (4-conn) de polilinha (coords de GRADE) → marca `out`.
function rasterSupercover(pts, out, W, H) {
  const mark = (cx, cy) => { if (cx >= 0 && cx < W && cy >= 0 && cy < H) out[cy * W + cx] = 1; };
  for (let s = 0; s + 1 < pts.length; s++) {
    const x0 = pts[s][0], y0 = pts[s][1], x1 = pts[s + 1][0], y1 = pts[s + 1][1];
    const dX = x1 - x0, dY = y1 - y0;
    let ix = Math.floor(x0), iy = Math.floor(y0); const ixe = Math.floor(x1), iye = Math.floor(y1);
    const sx = dX > 0 ? 1 : dX < 0 ? -1 : 0, sy = dY > 0 ? 1 : dY < 0 ? -1 : 0;
    const tdx = dX !== 0 ? Math.abs(1 / dX) : Infinity, tdy = dY !== 0 ? Math.abs(1 / dY) : Infinity;
    let tmx = dX !== 0 ? ((sx > 0 ? ix + 1 : ix) - x0) / dX : Infinity, tmy = dY !== 0 ? ((sy > 0 ? iy + 1 : iy) - y0) / dY : Infinity;
    mark(ix, iy); let g = Math.abs(ixe - ix) + Math.abs(iye - iy) + 4;
    while ((ix !== ixe || iy !== iye) && g-- > 0) { if (tmx < tmy) { tmx += tdx; ix += sx; } else { tmy += tdy; iy += sy; } mark(ix, iy); }
  }
}
// Lê a água que cai na bbox → { polys, lines } em [lng,lat] (FGBs são 4326).
// polys = anéis por polígono ([anel externo, buracos…]); lines = polilinhas.
// Best-effort por arquivo: um dos dois falhando não derruba o outro; os dois
// falhando → null (o chamador segue sem máscara, como antes).
async function queryWater(bb) {
  let failures = 0;
  const grab = (url) => streamFgbFeatures(url, bb).catch((e) => {
    failures++; console.warn('[water] FGB falhou:', url, e.message); return [];
  });
  const [areas, rivers] = await Promise.all([
    grab(WATER_AREAS_FGB_URL), grab(WATER_RIVERS_FGB_URL),
  ]);
  if (failures === 2) return null;
  const polys = [], lines = [];
  for (const f of areas) {
    const g = f && f.geometry; if (!g) continue;
    if (g.type === 'Polygon') polys.push(g.coordinates);
    else if (g.type === 'MultiPolygon') for (const rings of g.coordinates) polys.push(rings);
  }
  for (const f of rivers) {
    const g = f && f.geometry; if (!g) continue;
    if (g.type === 'LineString') lines.push(g.coordinates);
    else if (g.type === 'MultiLineString') for (const ln of g.coordinates) lines.push(ln);
  }
  return { polys, lines };
}

// Min-heap binário (prioridade f64 + id int) com deleção preguiçosa — o
// suficiente pra um Dijkstra sobre o grafo do viário. Sem decrease-key:
// reinserimos e ignoramos nós já finalizados.
class MinHeap {
  constructor() { this.pri = []; this.id = []; }
  get size() { return this.id.length; }
  push(p, i) {
    const pri = this.pri, id = this.id;
    let c = id.length;
    pri.push(p); id.push(i);
    while (c > 0) {
      const par = (c - 1) >> 1;
      if (pri[par] <= pri[c]) break;
      const tp = pri[par]; pri[par] = pri[c]; pri[c] = tp;
      const ti = id[par];  id[par]  = id[c];  id[c]  = ti;
      c = par;
    }
  }
  pop() {
    const pri = this.pri, id = this.id;
    const top = id[0];
    const lp = pri.pop(), li = id.pop();
    if (id.length) {
      pri[0] = lp; id[0] = li;
      let c = 0; const m = id.length;
      while (true) {
        const l = 2 * c + 1, r = 2 * c + 2; let s = c;
        if (l < m && pri[l] < pri[s]) s = l;
        if (r < m && pri[r] < pri[s]) s = r;
        if (s === c) break;
        const tp = pri[s]; pri[s] = pri[c]; pri[c] = tp;
        const ti = id[s];  id[s]  = id[c];  id[c]  = ti;
        c = s;
      }
    }
    return top;
  }
}

// Roteia origem→destino SOBRE o grafo vetorial do viário (não no grid). Monta
// nós (vértices, junções compartilham coordenada) e arestas dirigidas com o
// custo de energia assimétrico do modelo (mesma fórmula do energy-worker:
// subida = alpha·dist + beta·Δh; descida = max(0, alpha·dist − eta·beta·|Δh|)),
// amostrando a elevação do DEM por nó. Devolve a polilinha lat/lng da via, ou
// null se não há caminho (cai pro fallback). `from`/`to` reais são costurados
// nas pontas pra conectar com os marcadores.
function viarioGraphRoute(lines, meta, fromLatLng, toLatLng, dem, bb, A) {
  const t0 = performance.now();
  const W = dem.W, H = dem.H, height = dem.height, mask = dem.mask;
  const nodeKey = new Map();          // "latq,lngq" → id
  const nodeLat = [], nodeLng = [], nodeElev = [];
  const KEY = 1e6;                    // ~0.1 m de quantização p/ junções

  // NaN = elevação DESCONHECIDA (fora da bbox do mosaico, ou célula sem
  // cobertura de DEM). NUNCA 0: as consultas do viário devolvem linhas
  // INTEIRAS que só TOCAM a bbox, então os vértices de fora viravam nós a
  // 0 m — um penhasco falso de ~730 m em SP, e sair dele custa β·730 ≈
  // 554 kJ. Era isso que inflava o "objetivo do roteador" a ~10× a
  // estimativa. Quem consome descarta o nó/aresta (ver `allowed` abaixo).
  function sampleElev(lat, lng) {
    const r = Math.round((bb.north - lat) / A);
    const c = Math.round((lng - bb.west) / A);
    if (r < 0 || r >= H || c < 0 || c >= W) return NaN;
    const i = r * W + c;
    if (mask && !mask[i]) return NaN;
    const h = height[i];
    return Number.isFinite(h) ? h : NaN;
  }
  function getNode(lng, lat) {
    const k = Math.round(lat * KEY) + ',' + Math.round(lng * KEY);
    let id = nodeKey.get(k);
    if (id === undefined) {
      id = nodeLat.length;
      nodeKey.set(k, id);
      nodeLat.push(lat); nodeLng.push(lng); nodeElev.push(sampleElev(lat, lng));
    }
    return id;
  }

  const adj = [];                     // adj[u] = [v0, cost0, v1, cost1, …]
  const M_DEG = 111320;
  const cellM = A * M_DEG;            // ~tamanho da célula do DEM em metros
  // Custo v2 por aresta — helper compartilhado com o grafo pré-cozido
  // (v2EdgeCostFn, junto do decodeViarioGraph acima).
  const edgeCost = v2EdgeCostFn(readCost(params));

  // Pontos do caminho que caem em tabuleiro (p/ achatar também o perfil do
  // display, depois — usando a elevação que o PRÓPRIO display amostrou nos
  // apoios, não o DEM grosseiro do roteamento).
  const deckNodes = new Set();
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (line.length < 2) continue;
    // Tabuleiro (ponte/túnel): a elevação NÃO segue o DEM de terreno nu por
    // baixo (vale/sela). Achata pra uma reta entre os dois apoios no solo
    // (interpolada por comprimento de arco) — igual ao modo grafo do sampasimu.
    // Os apoios ficam no solo (compartilham nó com a via de acesso); só o vão
    // intermediário é achatado.
    const isDeck = !!(meta && meta[li] && meta[li].deck);
    let flat = null;
    const h0 = isDeck ? sampleElev(line[0][1], line[0][0]) : NaN;
    const h1 = isDeck ? sampleElev(line[line.length - 1][1], line[line.length - 1][0]) : NaN;
    // Sem os DOIS apoios com elevação conhecida não dá pra achatar o tabuleiro
    // (a rampa sairia NaN) — segue pelo caminho normal, e as arestas com ponta
    // desconhecida são descartadas logo abaixo.
    if (isDeck && Number.isFinite(h0) && Number.isFinite(h1)) {
      const arc = new Array(line.length); arc[0] = 0;
      for (let i = 1; i < line.length; i++) {
        const dLat = (line[i][1] - line[i - 1][1]) * M_DEG;
        const dLng = (line[i][0] - line[i - 1][0]) * M_DEG *
          Math.cos((line[i][1] + line[i - 1][1]) / 2 * Math.PI / 180);
        arc[i] = arc[i - 1] + Math.hypot(dLat, dLng);
      }
      const total = arc[line.length - 1];
      flat = arc.map((a) => (total > 0 ? h0 + (h1 - h0) * (a / total) : h0));
    }
    let pu = -1, pi = -1;
    for (let i = 0; i < line.length; i++) {
      const lng = line[i][0], lat = line[i][1];
      const u = getNode(lng, lat);
      // Marca só o VÃO (interior) do tabuleiro; os apoios (i=0 e i=último) ficam
      // no solo e servem de âncora pro achatamento do perfil no display.
      if (isDeck && i > 0 && i < line.length - 1) deckNodes.add(u);
      // Aresta só entre nós com elevação CONHECIDA — senão o custo v2 sairia
      // NaN (ou, como antes, de um 0 m fabricado).
      if (pu !== -1 && pu !== u &&
          Number.isFinite(nodeElev[pu]) && Number.isFinite(nodeElev[u])) {
        const dLat = (nodeLat[u] - nodeLat[pu]) * M_DEG;
        const dLng = (nodeLng[u] - nodeLng[pu]) * M_DEG *
          Math.cos((nodeLat[u] + nodeLat[pu]) / 2 * Math.PI / 180);
        const dist = Math.hypot(dLat, dLng);
        let fwd, bwd;
        if (flat) {
          // Tabuleiro: rampa uniforme entre os apoios (não amostra o DEM).
          const dh = flat[i] - flat[pi];
          fwd = edgeCost(dist, dh); bwd = edgeCost(dist, -dh);
        } else {
          // Amostra o PERFIL de elevação ao longo do segmento (~1 célula do DEM
          // por passo) e soma o custo assimétrico passo a passo — igual ao
          // profileCost do grafo do sampasimu. Vértices esparsos numa via reta
          // sobre um morro deixavam o custo só pelo desnível das pontas (≈0),
          // barateando a subida-e-descida; o perfil captura o morro.
          const nsub = Math.max(1, Math.ceil(dist / cellM));
          const subD = dist / nsub;
          const eU = nodeElev[pu], eV = nodeElev[u];
          const phs = [eU];
          for (let sct = 1; sct <= nsub; sct++) {
            const tt = sct / nsub;
            let hs = sct === nsub ? eV : sampleElev(
              nodeLat[pu] + (nodeLat[u] - nodeLat[pu]) * tt,
              nodeLng[pu] + (nodeLng[u] - nodeLng[pu]) * tt);
            // Buraco de cobertura NO MEIO do segmento: interpola entre as
            // pontas (ambas conhecidas) em vez de deixar o custo virar NaN.
            if (!Number.isFinite(hs)) hs = eU + (eV - eU) * tt;
            phs.push(hs);
          }
          fwd = 0; for (let sct = 0; sct < nsub; sct++) fwd += edgeCost(subD, phs[sct + 1] - phs[sct]);
          bwd = 0; for (let sct = nsub; sct > 0; sct--) bwd += edgeCost(subD, phs[sct - 1] - phs[sct]);
        }
        (adj[pu] || (adj[pu] = [])).push(u, fwd);
        (adj[u]  || (adj[u]  = [])).push(pu, bwd);
      }
      pu = u; pi = i;
    }
  }

  const N = nodeLat.length;
  if (!N) return null;

  // Nós ELEGÍVEIS = os com elevação conhecida (⇔ dentro da bbox e com
  // cobertura de DEM). Mesma restrição que o grafo pré-cozido aplica com o seu
  // `allowed`; sem ela o Dijkstra roteava por vértices de FORA da bbox, que
  // vinham com elevação fabricada.
  const allowed = new Uint8Array(N);
  let nAllowed = 0;
  for (let i = 0; i < N; i++) if (Number.isFinite(nodeElev[i])) { allowed[i] = 1; nAllowed++; }
  if (!nAllowed) return null;

  // Snap origem/destino no nó ELEGÍVEL mais próximo (varredura linear — N pequeno).
  function nearest(lat, lng) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < N; i++) {
      if (!allowed[i]) continue;
      const dl = nodeLat[i] - lat, dg = nodeLng[i] - lng;
      const d = dl * dl + dg * dg;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }
  const s = nearest(fromLatLng.lat, fromLatLng.lng);
  const t = nearest(toLatLng.lat, toLatLng.lng);
  if (s < 0 || t < 0) return null;

  const distA = new Float64Array(N).fill(Infinity);
  const prev  = new Int32Array(N).fill(-1);
  const done  = new Uint8Array(N);
  distA[s] = 0;
  const heap = new MinHeap();
  heap.push(0, s);
  while (heap.size) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === t) break;
    const a = adj[u];
    if (!a) continue;
    const du = distA[u];
    for (let k = 0; k < a.length; k += 2) {
      const v = a[k], w = a[k + 1];
      if (done[v] || !allowed[v]) continue;
      const nd = du + w;
      if (nd < distA[v]) { distA[v] = nd; prev[v] = u; heap.push(nd, v); }
    }
  }
  if (!done[t]) {
    console.info(`[viario] grafo ${nAllowed}/${N} nós elegíveis · sem caminho (origem/destino desconexos)`);
    return null;
  }

  const path = [];
  const deckFlag = [];
  for (let v = t; v !== -1; v = prev[v]) {
    path.push([nodeLat[v], nodeLng[v]]);
    deckFlag.push(deckNodes.has(v));
  }
  path.reverse(); deckFlag.reverse();
  path.unshift([fromLatLng.lat, fromLatLng.lng]); deckFlag.unshift(false);
  path.push([toLatLng.lat, toLatLng.lng]); deckFlag.push(false);
  // Anexa as flags de tabuleiro ao próprio array do caminho (viaja junto até o
  // trackpoint). flattenDeckProfile() depois achata o perfil do display nesses
  // pontos usando a elevação amostrada nos apoios.
  path.deckFlag = deckFlag;
  // Objetivo do roteador (J) — exibido na barra de métricas (ver energyRoute).
  path.routedEnergyJ = distA[t];
  console.info(`[viario] grafo ${nAllowed}/${N} nós elegíveis · rota ${path.length} pts em ` +
    `${(performance.now() - t0).toFixed(0)} ms`);
  return path;
}

// `mode` = 'free' (qualquer célula do DEM) | 'road' (restringe ao viário:
// grafo pré-cozido → FGB da América do Sul → grid raster do mesmo FGB)
async function energyRoute(fromLatLng, toLatLng, mode = 'free') {
  const distKm = fromLatLng.distanceTo(toLatLng) / 1000;
  if (distKm > ENERGY_MAX_SEGMENT_KM) {
    showToast(`Segmento ${distKm.toFixed(2)} km > ${ENERGY_MAX_SEGMENT_KM} km — usando reta`);
    return straightPath(fromLatLng, toLatLng);
  }

  // Clampa nos dois lados: sem teto, um valor corrompido importado inflaria
  // a bbox do mosaico FABDEM e alocaria um Float32Array gigante. 200% é
  // folga de sobra pro segmento de até 2 km.
  const margin = Math.min(2, Math.max(0, (params.energySearchMarginPct || 0) / 100));
  let west  = Math.min(fromLatLng.lng, toLatLng.lng);
  let east  = Math.max(fromLatLng.lng, toLatLng.lng);
  let south = Math.min(fromLatLng.lat, toLatLng.lat);
  let north = Math.max(fromLatLng.lat, toLatLng.lat);
  // Folga ISOTRÓPICA (em metros), dimensionada pelo MAIOR eixo do segmento.
  // Inflar cada eixo pelo PRÓPRIO span dava um corredor degenerado quando o
  // trecho é quase leste-oeste (ou norte-sul): com o span de latitude ~0 a
  // bbox saía como uma fatia (medimos 15486 m × 773 m num trecho de 5 km),
  // que corta o viário em ilhas desconexas — o grafo não achava caminho e o
  // roteamento despencava pros fallbacks. PAD_MAX_M limita o custo do mosaico
  // DEM nos segmentos longos (mesma função do clamp de `margin` acima).
  const M_PER_DEG = 111320;
  const cosLat = Math.max(0.05, Math.cos((south + north) / 2 * Math.PI / 180));
  const spanLatM = (north - south) * M_PER_DEG;
  const spanLngM = (east  - west)  * M_PER_DEG * cosLat;
  const PAD_MAX_M = 5000;
  const padM = Math.min(PAD_MAX_M, Math.max(Math.max(spanLatM, spanLngM) * margin, 25));
  const padLat = padM / M_PER_DEG;
  const padLng = padM / (M_PER_DEG * cosLat);
  west  -= padLng; east  += padLng;
  south -= padLat; north += padLat;

  const A = FABDEM_ARCSEC;
  const bb = {
    west:  Math.floor(west  / A) * A,
    east:  Math.ceil (east  / A) * A,
    south: Math.floor(south / A) * A,
    north: Math.ceil (north / A) * A,
  };

  // ROAD primário: grafo PRÉ-COZIDO do viário de SP — elevações já amostradas
  // no bake, então resolve SEM baixar DEM nem FGB (por isso roda antes do
  // mosaico abaixo). Rede custom carregada tem prioridade e cai pro fluxo
  // clássico; falha/sem caminho cai pro FGB, como sempre. O mesmo toggle
  // useViarioGpkg governa grafo pré-cozido + FGB (é a mesma fonte, só o
  // empacotamento muda); desligado, pula direto pro grid raster.
  if (mode === 'road' && !_customNetwork && params.useViarioGpkg !== false) {
    try {
      const path = await bakedViarioRoute(fromLatLng, toLatLng, bb);
      if (path && path.length) return path;
      console.info('[energy_road] grafo pré-cozido sem caminho — caindo pro FGB');
    } catch (e) {
      console.warn('[energy_road] grafo pré-cozido indisponível:', e.message);
    }
  }

  await ensureGeoTIFF();
  const tDem = performance.now();
  const dem = await loadDemMosaic(bb);
  console.info(`[energy] DEM ${dem.W}×${dem.H} em ${(performance.now() - tDem).toFixed(0)} ms`);
  if (!dem.W || !dem.H) {
    console.warn('[energy] DEM vazio — fallback pra reta');
    return straightPath(fromLatLng, toLatLng);
  }

  // Passo da célula em metros — usado já pelo tratamento σ e depois pelo worker.
  const midLat = (bb.south + bb.north) / 2;
  const EARTH_R = 6378137;
  const dy = A * Math.PI / 180 * EARTH_R;
  const dx = dy * Math.cos(midLat * Math.PI / 180);

  // Tratamento σ do mapa (Entry 74): suaviza o mosaico ANTES de qualquer
  // consumidor de roteamento — a grade do terreno E os grafos vetoriais do
  // viário (FGB / rede custom) amostram estas alturas. Inclui as
  // fontes grossas (FABDEM) de propósito — ver DEFAULT_PARAMS.demSmoothSigmaM.
  const sigmaM = Math.max(0, +(params.demSmoothSigmaM ?? DEFAULT_PARAMS.demSmoothSigmaM) || 0);
  if (sigmaM > 0) {
    const tSm = performance.now();
    smoothHeightsInPlace(dem.height, dem.mask, dem.H, dem.W, dx, dy, sigmaM);
    console.info(`[energy] tratamento σ=${sigmaM} m em ${(performance.now() - tSm).toFixed(0)} ms`);
  }

  // ROAD com rede custom: se o usuário carregou um fgb/gpkg/GeoJSON de viário
  // no modal "Fontes de dados", ele tem PRIORIDADE — mesma engine de grafo do
  // viário remoto. Sucesso = retorno imediato; falha/sem caminho cai pro FGB
  // da América do Sul abaixo (a rede custom pode cobrir só parte do trecho).
  if (mode === 'road' && _customNetwork) {
    try {
      const { lines, meta, hasTags } = await queryCustomNetworkLines(bb);
      if (lines.length) {
        if (!hasTags) {
          try {
            const decks = await fetchViarioDecksForBbox(bb);
            markDecksByProximity(lines, meta, decks, bb);
          } catch (e3) {
            console.warn('[energy_road] pontes do viário (rede custom) indisponíveis:', e3.message);
          }
        }
        const path = viarioGraphRoute(lines, meta, fromLatLng, toLatLng, dem, bb, A);
        if (path && path.length) return path;
        console.info('[energy_road] rede custom sem caminho — caindo pro FGB');
      }
    } catch (e) {
      console.warn('[energy_road] grafo da rede custom falhou:', e.message);
    }
  }

  // ROAD, fonte única: o FGB do viário da América do Sul. A rede é buscada UMA
  // vez e serve às duas tentativas, do melhor pro pior:
  //   1) grafo VETORIAL → a rota segue a geometria real das vias (linhas
  //      suaves, sem o serrilhado de ~30 m do grid), com ponte/túnel achatados
  //      a partir das colunas bridge/tunnel do próprio FGB;
  //   2) grid RASTER (máscara + Dijkstra no DEM) → serrilhado, porém
  //      resiliente; só roda se o grafo não achar caminho.
  // Não há mais terceira fonte: o Overpass saiu (era o plano B ao vivo, e com
  // ele saiu a cobertura fora da América do Sul — lá o "pelo viário" agora cai
  // direto na energia livre).
  // Toggle (Parâmetros): ligado usa o grafo vetorial; desligado vai direto ao
  // grid raster da MESMA rede.
  let roadLines = null;
  if (mode === 'road') {
    try {
      const { lines, meta } = await queryViarioLines(bb);
      roadLines = lines;
      if (params.useViarioGpkg !== false) {
        const path = viarioGraphRoute(lines, meta, fromLatLng, toLatLng, dem, bb, A);
        if (path && path.length) return path;
        console.info('[energy_road] grafo do FGB sem caminho — tentando grid raster');
      }
    } catch (e) {
      console.warn('[energy_road] viário do FGB falhou:', e.message);
      showToast(`Viário indisponível (${e.message}) — caindo para menor energia livre.`);
    }
  }

  // Rede viária no grid raster — fallback do grafo vetorial, mesma rede.
  // Último caso: energia livre (networkMask = null).
  let networkMask = null;
  if (mode === 'road' && roadLines) {
    if (!roadLines.length) {
      showToast('Sem viário no bbox — caindo para menor energia livre.');
    } else {
      networkMask = rasterizeRoads(roadLines, bb, dem.H, dem.W, A);
    }
  }

  const seedR = Math.max(0, Math.min(dem.H - 1, Math.round((bb.north - fromLatLng.lat) / A)));
  const seedC = Math.max(0, Math.min(dem.W - 1, Math.round((fromLatLng.lng - bb.west) / A)));
  const goalR = Math.max(0, Math.min(dem.H - 1, Math.round((bb.north - toLatLng.lat)   / A)));
  const goalC = Math.max(0, Math.min(dem.W - 1, Math.round((toLatLng.lng - bb.west)    / A)));

  // Garante que seed/goal estão sempre na máscara de viário — senão
  // Dijkstra nunca sai da origem. Pintamos um carimbo 3×3 ao redor de cada.
  if (networkMask) {
    for (const [pr, pc] of [[seedR, seedC], [goalR, goalC]]) {
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = pr + dr, cc = pc + dc;
        if (rr >= 0 && rr < dem.H && cc >= 0 && cc < dem.W) networkMask[rr * dem.W + cc] = 1;
      }
    }
  }

  // Máscara de barreira de ÁGUA (modos raster: terreno livre + fallback raster
  // do viário): preenche lagos/represas e barra rios dos FGBs de água, pra
  // rota não atravessar água. Pontes/túneis viram PORTAIS (abaixo), pra
  // cruzar a água barrada no tabuleiro. Origem/destino nunca são barrados.
  let portals = null;
  const waterBlocked = [];   // células barradas pela água (p/ refazer sem elas)
  // Viário (linhas do FGB): usado pra (a) abrir CORREDORES passáveis na máscara
  // de água — estradas/pontes atravessam a água, como no sampasimu — e (b) os
  // portais de ponte/túnel. Buscado UMA vez e reusado pelos dois blocos abaixo.
  let viaLines = null, viaMeta = null;
  if (params.useWaterMask !== false || params.usePortals !== false) {
    try { const q = await queryViarioLines(bb); viaLines = q.lines; viaMeta = q.meta; }
    catch (e) { console.warn('[energy] viário (corredores/portais) falhou:', e.message); }
  }
  // Toggle nos Parâmetros (useWaterMask): desligado → água ignorada (e os FGBs
  // nem são consultados se os portais também estiverem off → zero tráfego).
  if (params.useWaterMask !== false) try {
    const water = await queryWater(bb);
    if (water && (water.polys.length || water.lines.length)) {
      const block = new Uint8Array(dem.W * dem.H);
      const toG = (lng, lat) => [(lng - bb.west) / A, (bb.north - lat) / A];
      for (const rings of water.polys) fillRingsEvenOdd(rings.map((r) => r.map((p) => toG(p[0], p[1]))), block, dem.W, dem.H);
      for (const ln of water.lines) rasterSupercover(ln.map((p) => toG(p[0], p[1])), block, dem.W, dem.H);
      // CORREDORES: as vias (incl. pontes/túneis) abrem caminho passável sobre a
      // água — uma estrada que cruza um rio/represa não é barreira. Poupa essas
      // células do bloqueio (o "network carves corridors" do sampasimu). Sem
      // isto, um destino sobre/à beira d'água fica ilhado.
      //
      // Duas fontes de corredor: (a) `networkMask` — a rede RASTER em uso no
      // "pelo viário" quando o grafo vetorial não achou caminho (ou o toggle
      // está desligado); é ELA que o worker roteia, então é ELA que precisa
      // atravessar a água, senão a ponte fica barrada e a rota cai na reta.
      // (b) `road` — as linhas VETORIAIS do FGB (corredores do modo terreno;
      // só existem com o viário consultado). Sem (a), o fallback raster perdia
      // todas as travessias d'água.
      let road = null;
      if (viaLines) { road = new Uint8Array(dem.W * dem.H); for (const ln of viaLines) rasterSupercover(ln.map((p) => toG(p[0], p[1])), road, dem.W, dem.H); }
      let blocked = 0, corr = 0;
      for (let i = 0; i < block.length; i++) {
        if (!block[i] || !dem.mask[i]) continue;
        if (networkMask && networkMask[i]) { corr++; continue; }   // via raster cruza a água
        if (road && road[i]) { corr++; continue; }                 // via vetorial (FGB) cruza a água
        dem.mask[i] = 0; waterBlocked.push(i); blocked++;
      }
      dem.mask[seedR * dem.W + seedC] = 1; dem.mask[goalR * dem.W + goalC] = 1;
      console.info(`[energy] máscara de água: ${blocked} células barradas (${water.polys.length} áreas, ${water.lines.length} rios)${corr ? `, ${corr} de corredor viário liberadas` : ''}`);
    }
  } catch (e) { console.warn('[energy] máscara de água falhou:', e.message); }

  // Portais de ponte/túnel (raster): atalho dirigido entre as duas células de
  // apoio no custo do tabuleiro plano — deixa a rota cruzar a água barrada por
  // cima da ponte. Decks = linhas do viário com bridge/tunnel (FGB já em cache
  // pela água); o worker calcula o custo a partir das alturas das pontas.
  // Toggle nos Parâmetros (usePortals): desligado → água vira barreira total.
  if (params.usePortals !== false && viaLines) try {
    const lines = viaLines, meta = viaMeta;
    const u = [], v = [], lenM = [], M = 111320;
    const cellOf = (lng, lat) => { const r = Math.round((bb.north - lat) / A), c = Math.round((lng - bb.west) / A); return (r < 0 || r >= dem.H || c < 0 || c >= dem.W) ? -1 : r * dem.W + c; };
    for (let li = 0; li < lines.length; li++) {
      if (!(meta[li] && meta[li].deck)) continue;
      const ln = lines[li];
      if (ln.length < 2) continue;
      const a = cellOf(ln[0][0], ln[0][1]), b = cellOf(ln[ln.length - 1][0], ln[ln.length - 1][1]);
      if (a < 0 || b < 0 || a === b) continue;
      let len = 0;
      for (let i = 1; i < ln.length; i++) { const dLat = (ln[i][1] - ln[i - 1][1]) * M, dLng = (ln[i][0] - ln[i - 1][0]) * M * Math.cos((ln[i][1] + ln[i - 1][1]) / 2 * Math.PI / 180); len += Math.hypot(dLat, dLng); }
      u.push(a); v.push(b); lenM.push(len);
    }
    if (u.length) portals = { u: Int32Array.from(u), v: Int32Array.from(v), lenM: Float64Array.from(lenM), n: u.length };
    if (portals) console.info(`[energy] ${portals.n} portais de ponte/túnel`);
  } catch (e) { console.warn('[energy] portais falharam:', e.message); }

  try {
    const tWork = performance.now();
    const baseOpts = {
      height: dem.height,
      networkMask,
      // O worker vendado lê os portais como 5 arrays soltos (portalU/V/LenM/HU/HV),
      // não como objeto. amora não tem `ele` de tabuleiro → HU/HV = null (o worker
      // cai pra altura do DEM nas pontas, igual ao comportamento anterior).
      portalU:    portals ? portals.u    : null,
      portalV:    portals ? portals.v    : null,
      portalLenM: portals ? portals.lenM : null,
      portalHU:   null,
      portalHV:   null,
      H: dem.H, W: dem.W, dx, dy,
      seedR, seedC, goalR, goalC,
      mode: 'from',
      cost: readCost(params),
      // Valida aqui (o worker degrada valores inválidos pra 8, não pro nosso
      // default 16 — um params corrompido mudaria o traçado silenciosamente).
      nDirs: [4, 8, 16, 32, 64, 128].includes(params.nDirs | 0) ? (params.nDirs | 0) : 16,
    };
    let res = await runEnergyWorker({ ...baseOpts, mask: dem.mask });
    // Rede de segurança: se mesmo com os corredores viários a água ainda selou
    // o caminho (ex.: destino em água aberta, sem via por perto), refaz UMA vez
    // sem a barreira. Uma rota real que raspa a água é melhor que cair na reta.
    // (mask é CLONADA no postMessage, não transferida → dá pra reusar dem.mask.)
    if ((!res.path || !res.path.length) && waterBlocked.length) {
      for (const idx of waterBlocked) dem.mask[idx] = 1;
      console.warn(`[energy] água ainda selou o caminho — refazendo sem a barreira (${waterBlocked.length} células)`);
      res = await runEnergyWorker({ ...baseOpts, mask: dem.mask });
    }
    console.info(`[energy] worker em ${(performance.now() - tWork).toFixed(0)} ms`);
    if (!res.path || !res.path.length) {
      console.warn('[energy] sem caminho — fallback pra reta');
      return straightPath(fromLatLng, toLatLng);
    }
    const out = Array.from(res.path, (i) => {
      const r = (i / dem.W) | 0;
      const c = i - r * dem.W;
      return [bb.north - (r + 0.5) * A, bb.west + (c + 0.5) * A];
    });
    // Objetivo do roteador (J): a energia acumulada no destino que o Dijkstra
    // minimizou — viaja no array do caminho (como o deckFlag) até a barra de
    // métricas, que a exibe ao lado da estimativa route-level.
    if (Number.isFinite(res.pathEnergy)) out.routedEnergyJ = res.pathEnergy;
    return out;
  } catch (e) {
    console.warn('[energy] worker falhou:', e.message);
    return straightPath(fromLatLng, toLatLng);
  }
}

async function osrmRoute(fromLatLng, toLatLng, profile = 'cycling') {
  // FOSSGIS (routing.openstreetmap.de) roda uma instância OSRM POR PERFIL —
  // o perfil real é escolhido pelo path (routed-bike / routed-foot); o
  // segmento /driving/ é ignorado pelo OSRM e fica só por convenção da API.
  // O demo antigo (router.project-osrm.org) só tem o perfil de CARRO e
  // ignorava silenciosamente o /cycling/ da URL — por isso a troca.
  const instance = profile === 'foot' ? 'routed-foot' : 'routed-bike';
  const url =
    `https://routing.openstreetmap.de/${instance}/route/v1/driving/` +
    `${fromLatLng.lng},${fromLatLng.lat};${toLatLng.lng},${toLatLng.lat}` +
    `?overview=full&geometries=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes?.[0]) throw new Error(`OSRM ${data.code || 'no route'}`);
  return data.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
}

// Build the visual polyline from current marker positions + cached paths.
// During a drag the dragged waypoint's marker has moved, so the segment(s)
// touching it will look slightly off (the path interior is from the old
// position) — that gets corrected by refetch/straight-path on dragend.
function assembleLatLngs() {
  const latlngs = [];
  for (let i = 0; i < trackpoints.length; i++) {
    const tp = trackpoints[i];
    const wp = tp.marker.getLatLng();
    if (i === 0) {
      latlngs.push(wp);
    } else {
      const path = tp.pathFromPrev;
      if (path && path.length >= 2) {
        for (let j = 1; j < path.length - 1; j++) {
          latlngs.push(L.latLng(path[j][0], path[j][1]));
        }
      }
      latlngs.push(wp);
    }
  }
  return latlngs;
}

function redrawAndMetrics() {
  updateDraftPolyline();
  updateMetrics();
  scheduleElevationFetch();
}

function updateDraftPolyline() {
  const latlngs = assembleLatLngs();
  if (latlngs.length === 0) {
    if (draftPolyline) { map.removeLayer(draftPolyline); draftPolyline = null; }
    if (draftCasing)   { map.removeLayer(draftCasing);   draftCasing = null; }
    return;
  }
  // White line over a dark casing so the trace stays readable on top of any
  // base layer — same scheme as the rendered sidebar routes, for visual
  // consistency between the in-progress draft and the saved result.
  if (!draftPolyline) {
    // `bubblingMouseEvents: false` keeps mouse events ON the line from
    // bubbling up to the map's onMapClickInDrawing — otherwise grabbing the
    // line to insert an intermediate waypoint would ALSO append a stray
    // point at the end of the trace.
    draftCasing = L.polyline(latlngs, {
      color: '#1a1a1a',
      weight: 7,
      opacity: 0.55,
      lineCap: 'round',
      lineJoin: 'round',
      bubblingMouseEvents: false,
      className: 'draft-line',
    }).addTo(map);
    draftPolyline = L.polyline(latlngs, {
      color: '#ffffff',
      weight: 3.5,
      opacity: 1,
      lineCap: 'round',
      lineJoin: 'round',
      bubblingMouseEvents: false,
      className: 'draft-line',
    }).addTo(map);
    // Press on the line to insert an intermediate waypoint into the segment
    // grabbed: a plain tap/click drops it where you pressed, or hold and drag
    // to place it wherever you release. Driven by Pointer Events (unified
    // mouse + touch + pen) bound natively on each <path> — Leaflet doesn't
    // surface 'pointerdown' as a layer event, and its synthesized
    // mousemove/mouseup don't fire during a touch drag. Bound on both casing
    // and top stroke since either may be the topmost element under the press.
    for (const layer of [draftPolyline, draftCasing]) {
      const el = layer.getElement();
      if (el) L.DomEvent.on(el, 'pointerdown', onLinePointerDown);
    }
  } else {
    if (draftCasing) draftCasing.setLatLngs(latlngs);
    draftPolyline.setLatLngs(latlngs);
  }
}

// ─── Press the draft line → insert an intermediate waypoint ─────────────────
// A plain tap/click drops the new waypoint where you pressed; holding and
// dragging places it wherever you release. The segment it lands in is fixed at
// press time (the segment grabbed); only the position follows the pointer. A
// dashed ghost previews the result during the drag. Pointer Events + pointer
// capture make this work identically for mouse and touch — capture routes
// every move/up to the original <path> even when the finger leaves the line.
let lineInsertActive = false; // set while a press-to-insert gesture is in flight
function onLinePointerDown(e) {
  if (!drawingMode || previewMode || trackpoints.length < 2) return;
  if (e.button != null && e.button > 0) return; // ignore right/middle click
  if (e.isPrimary === false) return;            // ignore extra touch points
  L.DomEvent.stop(e);

  const startLatLng = map.mouseEventToLatLng(e);
  const idx = findInsertIndex(startLatLng);
  lineInsertActive = true;
  // Suspend map panning so the drag moves the ghost, not the map.
  map.dragging.disable();

  const target = e.currentTarget; // the <path> that was pressed
  const pointerId = e.pointerId;
  try { target.setPointerCapture(pointerId); } catch (_) { /* ok without it */ }

  const ghost = L.marker(startLatLng, {
    icon: tpIcon(false, ''),
    interactive: false,
    keyboard: false,
    zIndexOffset: 2000,
  }).addTo(map);
  const preview = L.polyline([], {
    color: '#ffffff',
    weight: 2,
    opacity: 0.8,
    dashArray: '4 5',
    interactive: false,
  }).addTo(map);

  const prevLatLng = trackpoints[idx - 1]?.marker.getLatLng();
  const nextLatLng = trackpoints[idx]?.marker.getLatLng();
  const drawPreview = (latlng) => {
    const segs = [];
    if (prevLatLng) segs.push([prevLatLng, latlng]);
    if (nextLatLng) segs.push([latlng, nextLatLng]);
    preview.setLatLngs(segs);
  };
  drawPreview(startLatLng);

  let lastLatLng = startLatLng;
  const onMove = (ev) => {
    L.DomEvent.preventDefault(ev); // stop the page from scrolling under a touch
    lastLatLng = map.mouseEventToLatLng(ev);
    ghost.setLatLng(lastLatLng);
    drawPreview(lastLatLng);
  };
  const cleanup = () => {
    L.DomEvent.off(target, 'pointermove', onMove);
    L.DomEvent.off(target, 'pointerup', onUp);
    L.DomEvent.off(target, 'pointercancel', onCancel);
    try { target.releasePointerCapture(pointerId); } catch (_) { /* already gone */ }
    map.removeLayer(ghost);
    map.removeLayer(preview);
    map.dragging.enable();
    // The trailing `click` from a mouse press lands on the map container (the
    // common ancestor when released off the line); swallow it next tick so
    // onMapClickInDrawing doesn't append a point at the end.
    setTimeout(() => { lineInsertActive = false; }, 0);
  };
  const onUp = (ev) => {
    L.DomEvent.preventDefault(ev);
    const dropLatLng = map.mouseEventToLatLng(ev);
    cleanup();
    insertWaypointAt(idx, dropLatLng);
  };
  const onCancel = () => cleanup();
  L.DomEvent.on(target, 'pointermove', onMove);
  L.DomEvent.on(target, 'pointerup', onUp);
  L.DomEvent.on(target, 'pointercancel', onCancel);
}

// Find the index where a new waypoint should be inserted: between the two
// consecutive user waypoints whose great-circle segment is closest to the
// click location. Uses a simple flat-Earth approximation — fine at the
// scales the editor works at.
function findInsertIndex(latlng) {
  let bestIdx = trackpoints.length;
  let bestDist = Infinity;
  for (let i = 0; i < trackpoints.length - 1; i++) {
    const a = trackpoints[i].marker.getLatLng();
    const b = trackpoints[i + 1].marker.getLatLng();
    const d = pointToSegmentDistance(latlng, a, b);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i + 1;
    }
  }
  return bestIdx;
}

function pointToSegmentDistance(p, a, b) {
  const dx = b.lng - a.lng;
  const dy = b.lat - a.lat;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ddx = p.lng - a.lng, ddy = p.lat - a.lat;
    return Math.sqrt(ddx * ddx + ddy * ddy);
  }
  const t = Math.max(
    0,
    Math.min(1, ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) / lenSq),
  );
  const cx = a.lng + t * dx;
  const cy = a.lat + t * dy;
  return Math.hypot(p.lng - cx, p.lat - cy);
}

async function insertWaypointAt(idx, latlng, init = {}) {
  // Plain trackpoint by default — same as a click-to-add. The user can
  // toggle the POI flag in the marker popup if they want. `init` lets a
  // caller pre-set name/POI (a busca de endereços rotula o ponto com o
  // endereço escolhido).
  const tp = createTrackpoint(latlng, init);
  trackpoints.splice(idx, 0, tp);

  // Wire pathFromPrev for the inserted waypoint, then rebuild the next one's
  // path (since its previous waypoint is now the inserted one, not its old
  // neighbor).
  if (idx > 0) {
    tp.pathFromPrev = straightPath(
      trackpoints[idx - 1].marker.getLatLng(),
      tp.marker.getLatLng(),
    );
  } else {
    tp.pathFromPrev = null;
  }
  if (idx + 1 < trackpoints.length) {
    const next = trackpoints[idx + 1];
    next.pathFromPrev = straightPath(
      tp.marker.getLatLng(),
      next.marker.getLatLng(),
    );
  }
  redrawAndMetrics();
  updateTraceControls();

  if (routingMode !== 'straight') {
    if (idx > 0) await refetchPath(idx);
    if (idx + 1 < trackpoints.length) await refetchPath(idx + 1);
    redrawAndMetrics();
  }
  pushHistory();
}

// ─── Busca de endereços (geocoding) ──────────────────────────────────────────
// Botão 🔍 na coluna de controles do Leaflet (abaixo do zoom) abre um painel
// de busca com typeahead via Photon (komoot) — feito pra autocomplete, ao
// contrário do Nominatim, cuja política de uso PROÍBE typeahead. Se o Photon
// um dia sumir, o fallback é o Nominatim em modo buscar-ao-Enter
// (nominatim.openstreetmap.org/search?format=jsonv2&accept-language=pt-BR).
// Escolher um resultado:
//   • com o editor de traçado aberto → vira o PRÓXIMO waypoint da rota, com o
//     endereço como rótulo — dá pra montar partida → paradas → chegada só
//     buscando endereços em sequência;
//   • fora do editor → voa até o lugar e solta um pino temporário cujo popup
//     oferece "Traçar a partir daqui" (entra no editor com o endereço como
//     ponto de partida). O pino nunca vira trackpoint nem persiste.
const geoSearchBtn = document.getElementById('geo-search-btn');
const geoSearchPanel = document.getElementById('geo-search-panel');
const geoSearchInput = document.getElementById('geo-search-input');
const geoSearchList = document.getElementById('geo-search-results');
const geoSearchStatus = document.getElementById('geo-search-status');
let geoSearchTimer = null;
let geoSearchAbort = null;     // AbortController da busca em voo (latest-wins)
let geoSearchResults = [];
let geoSearchLastQuery = '';   // query dos resultados exibidos (p/ Enter direto)
let geoSearchActiveIdx = -1;   // item destacado via ↑/↓
let geoSearchMarker = null;    // pino temporário do modo fora-do-editor
let geoSearchPickTs = 0;       // guarda anti-clique-fantasma (ver onMapClickInDrawing)

// O BOTÃO já foi estacionado na coluna top-left lá em cima, junto com o
// header-toggle (ver o comentário de "destino comum" naquele bloco) — aqui só
// resta blindar o PAINEL: em modo de desenho, um clique que vazasse pro mapa
// viraria trackpoint.
if (geoSearchPanel) {
  L.DomEvent.disableClickPropagation(geoSearchPanel);
  L.DomEvent.disableScrollPropagation(geoSearchPanel);
}

async function photonGeocode(query) {
  geoSearchAbort?.abort();
  const ctrl = new AbortController();
  geoSearchAbort = ctrl;
  const c = map.getCenter();
  // lat/lon + location_bias_scale puxam o ranking pro que está na tela (São
  // Paulo na prática) sem excluir o resto; sem `lang` — o Photon só tem
  // en/de/fr e resultados BR já vêm em português por padrão.
  const url = 'https://photon.komoot.io/api/?' + new URLSearchParams({
    q: query,
    limit: '6',
    lat: c.lat.toFixed(5),
    lon: c.lng.toFixed(5),
    location_bias_scale: '0.4',
    zoom: String(Math.min(16, Math.round(map.getZoom()))),
  });
  const resp = await fetch(url, { signal: ctrl.signal });
  if (!resp.ok) throw new Error(`Photon HTTP ${resp.status}`);
  const data = await resp.json();
  const seen = new Set();
  const items = [];
  for (const f of data.features || []) {
    const p = f.properties || {};
    const [lng, lat] = f.geometry?.coordinates || [];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const key = p.osm_id != null ? `${p.osm_type || ''}/${p.osm_id}` : `${lat},${lng}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = p.name || [p.street, p.housenumber].filter(Boolean).join(', ');
    if (!label) continue;
    const detail = [p.district, p.city, p.state].filter(Boolean).join(', ');
    items.push({ label, detail, lat, lng });
  }
  return items;
}

// O painel é filho do container do mapa; ancora ele ao lado do botão na hora
// de abrir (a posição do botão varia com a topbar oculta, safe-area etc.).
function positionGeoSearchPanel() {
  const mapRect = map.getContainer().getBoundingClientRect();
  const btnRect = geoSearchBtn.getBoundingClientRect();
  if (window.innerWidth <= 600) {
    // Tela estreita: largura (quase) toda, abaixo do botão. width:auto
    // libera o esticamento left+right (o CSS fixa 320px pro desktop).
    geoSearchPanel.style.top = `${Math.round(btnRect.bottom - mapRect.top + 6)}px`;
    geoSearchPanel.style.left = '8px';
    geoSearchPanel.style.right = '8px';
    geoSearchPanel.style.width = 'auto';
  } else {
    geoSearchPanel.style.top = `${Math.round(btnRect.top - mapRect.top)}px`;
    geoSearchPanel.style.left = `${Math.round(btnRect.right - mapRect.left + 8)}px`;
    geoSearchPanel.style.right = 'auto';
    geoSearchPanel.style.width = '';
  }
}

function setGeoSearchStatus(msg) {
  geoSearchStatus.textContent = msg;
  geoSearchStatus.hidden = !msg;
}

function openGeoSearch() {
  positionGeoSearchPanel();
  geoSearchPanel.hidden = false;
  geoSearchBtn.setAttribute('aria-pressed', 'true');
  geoSearchInput.focus();
  geoSearchInput.select();
}

function closeGeoSearch() {
  clearTimeout(geoSearchTimer);
  geoSearchAbort?.abort();
  geoSearchPanel.hidden = true;
  geoSearchBtn.setAttribute('aria-pressed', 'false');
  setGeoSearchStatus('');
  renderGeoSearchResults([]);
}

function renderGeoSearchResults(items) {
  geoSearchResults = items;
  geoSearchActiveIdx = -1;
  geoSearchInput.removeAttribute('aria-activedescendant');
  geoSearchList.textContent = '';
  items.forEach((item, i) => {
    const li = document.createElement('li');
    li.id = `geo-search-opt-${i}`;
    li.setAttribute('role', 'option');
    const label = document.createElement('span');
    label.className = 'geo-search-label';
    label.textContent = item.label;
    li.appendChild(label);
    if (item.detail) {
      const detail = document.createElement('span');
      detail.className = 'geo-search-detail';
      detail.textContent = item.detail;
      li.appendChild(detail);
    }
    li.addEventListener('click', () => pickGeoSearchResult(item));
    geoSearchList.appendChild(li);
  });
}

function setGeoSearchActive(idx) {
  const rows = geoSearchList.children;
  if (!rows.length) return;
  geoSearchActiveIdx = ((idx % rows.length) + rows.length) % rows.length;
  for (let i = 0; i < rows.length; i++) {
    rows[i].classList.toggle('is-active', i === geoSearchActiveIdx);
  }
  const active = rows[geoSearchActiveIdx];
  geoSearchInput.setAttribute('aria-activedescendant', active.id);
  active.scrollIntoView({ block: 'nearest' });
}

async function runGeoSearch() {
  const q = geoSearchInput.value.trim();
  if (q.length < 3) {
    geoSearchAbort?.abort();
    renderGeoSearchResults([]);
    setGeoSearchStatus('');
    return;
  }
  setGeoSearchStatus('Buscando…');
  try {
    const items = await photonGeocode(q);
    geoSearchLastQuery = q;
    renderGeoSearchResults(items);
    setGeoSearchStatus(items.length ? '' : 'Nenhum resultado — tente incluir bairro ou cidade');
  } catch (err) {
    if (err.name === 'AbortError') return; // superada por uma busca mais nova
    console.warn('[geo-search]', err);
    renderGeoSearchResults([]);
    setGeoSearchStatus('Erro de rede na busca');
  }
}

async function pickGeoSearchResult(item) {
  // Carimbo ANTES de mexer no DOM: o handler de clique do container (Leaflet)
  // roda logo depois deste, no mesmo dispatch — sem isto o clique no <li>
  // recém-removido virava clique no mapa e adicionava um ponto extra num
  // lugar aleatório (ver o guard em onMapClickInDrawing).
  geoSearchPickTs = Date.now();
  const latlng = L.latLng(item.lat, item.lng);
  const targetZoom = Math.max(map.getZoom(), 15);
  if (drawingMode && !previewMode) {
    // Vira o próximo waypoint; o painel fica aberto pro loop buscar→adicionar
    // de vários endereços em sequência (partida → paradas → chegada).
    geoSearchInput.value = '';
    renderGeoSearchResults([]);
    setGeoSearchStatus('');
    map.flyTo(latlng, targetZoom);
    await insertWaypointAt(trackpoints.length, latlng, { name: item.label });
    geoSearchInput.focus();
  } else {
    closeGeoSearch();
    map.flyTo(latlng, targetZoom);
    dropGeoSearchPin(item, latlng);
  }
}

function removeGeoSearchPin() {
  if (geoSearchMarker) {
    map.removeLayer(geoSearchMarker);
    geoSearchMarker = null;
  }
}

function dropGeoSearchPin(item, latlng) {
  removeGeoSearchPin();
  const marker = L.marker(latlng);
  const div = document.createElement('div');
  div.className = 'geo-search-popup';
  const title = document.createElement('strong');
  title.textContent = item.label;
  div.appendChild(title);
  if (item.detail) {
    const detail = document.createElement('span');
    detail.className = 'geo-search-detail';
    detail.textContent = item.detail;
    div.appendChild(detail);
  }
  const traceHere = document.createElement('button');
  traceHere.type = 'button';
  traceHere.textContent = '🗺︎ Traçar a partir daqui';
  traceHere.addEventListener('click', async () => {
    geoSearchPickTs = Date.now(); // o popup some sob o cursor — mesmo guard
    removeGeoSearchPin();
    // Entrar no editor zera o rascunho — o endereço vira o ponto de PARTIDA.
    if (!drawingMode) enterDrawingMode();
    else if (previewMode) exitPreviewMode();
    await insertWaypointAt(trackpoints.length, latlng, { name: item.label });
  });
  div.appendChild(traceHere);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = '✕ Remover pino';
  remove.addEventListener('click', () => removeGeoSearchPin());
  div.appendChild(remove);
  marker.bindPopup(div);
  marker.addTo(map).openPopup();
  // O flyTo em andamento fecha o popup quando a animação de zoom começa;
  // reabre quando o mapa assenta (no-op se já estiver aberto).
  map.once('moveend', () => {
    if (geoSearchMarker === marker) marker.openPopup();
  });
  geoSearchMarker = marker;
}

geoSearchBtn?.addEventListener('click', () => {
  if (geoSearchPanel.hidden) openGeoSearch();
  else closeGeoSearch();
});
geoSearchInput?.addEventListener('input', () => {
  clearTimeout(geoSearchTimer);
  geoSearchTimer = setTimeout(runGeoSearch, 350);
});
geoSearchInput?.addEventListener('keydown', (e) => {
  // Nada daqui deve vazar pro keydown global: Esc cancelaria o modo de
  // desenho e Cmd+Z desfaria um waypoint em vez do texto digitado.
  e.stopPropagation();
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setGeoSearchActive(geoSearchActiveIdx + 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    setGeoSearchActive(geoSearchActiveIdx - 1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const q = geoSearchInput.value.trim();
    if (geoSearchActiveIdx >= 0 && geoSearchResults[geoSearchActiveIdx]) {
      pickGeoSearchResult(geoSearchResults[geoSearchActiveIdx]);
    } else if (geoSearchResults.length && q === geoSearchLastQuery) {
      pickGeoSearchResult(geoSearchResults[0]);
    } else {
      clearTimeout(geoSearchTimer);
      runGeoSearch();
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeGeoSearch();
  }
});

function totalDistanceMeters() {
  const latlngs = assembleLatLngs();
  let total = 0;
  for (let i = 1; i < latlngs.length; i++) {
    total += latlngs[i - 1].distanceTo(latlngs[i]); // Leaflet's haversine
  }
  return total;
}

// ─── FABDEM (1°×1° COG tiles hospedadas no R2, fabdem.pedalhidrografi.co) ────
// Range-fetch só dos strips que cobrem cada ponto/bbox. geotiff.js é
// carregado sob demanda do CDN; window.GeoTIFF expõe a API. Os tiles ficam na
// RAIZ do bucket (sem segmento /fabdem/) — nomes Bristol direto na base.
const FABDEM_BASE_URL = 'https://fabdem.pedalhidrografi.co/';
const FABDEM_TILE_DEG = 1;
const FABDEM_ARCSEC   = 1 / 3600;            // ~30 m no equador
const GEOTIFF_URL     = 'https://cdn.jsdelivr.net/npm/geotiff@3.0.5/dist-browser/geotiff.js';

let _geoTiffPromise = null;
async function ensureGeoTIFF() {
  if (!_geoTiffPromise) {
    _geoTiffPromise = (async () => {
      if (!window.GeoTIFF) await loadScript(GEOTIFF_URL);
      return window.GeoTIFF;
    })();
    _geoTiffPromise.catch(() => { _geoTiffPromise = null; });
  }
  return _geoTiffPromise;
}

// Convenção do bucket: SW corner, hemisfério antes dos dígitos.
//   lat=-24, lon=-47  →  S24W047_FABDEM_V1-2.tif
function fabdemTileName(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  const la = String(Math.abs(lat)).padStart(2, '0');
  const lo = String(Math.abs(lon)).padStart(3, '0');
  return `${ns}${la}${ew}${lo}_FABDEM_V1-2.tif`;
}

// Cache de tiles abertos. Cada entrada guarda só o IFD (geotiff.js
// adia o fetch de pixels até readRasters).
const _fabdemTileCache = new Map();   // "SXX[E|W]XXX" → { image, origin, resolution, nodata } | null
async function openFabdemTile(latLo, lonLo) {
  const key = `${latLo}_${lonLo}`;
  if (_fabdemTileCache.has(key)) return _fabdemTileCache.get(key);
  const url = FABDEM_BASE_URL + fabdemTileName(latLo, lonLo);
  try {
    const GeoTIFF = await ensureGeoTIFF();
    const tiff   = await GeoTIFF.fromUrl(url);
    const image  = await tiff.getImage();
    const origin = image.getOrigin();
    const resolution = image.getResolution();
    const nodataRaw = image.fileDirectory.getValue
      ? image.fileDirectory.getValue('GDAL_NODATA')
      : image.fileDirectory.GDAL_NODATA;
    const nodata = nodataRaw ? parseFloat(nodataRaw) : null;
    const entry = { image, origin, resolution, nodata };
    _fabdemTileCache.set(key, entry);
    return entry;
  } catch (e) {
    console.info(`[fabdem] tile (${latLo},${lonLo}) indisponível: ${e.message}`);
    _fabdemTileCache.set(key, null);    // negative cache: don't keep retrying
    return null;
  }
}

// Interpolação BILINEAR num buffer de janela (interleave) lido via readRasters.
// (u, v) são coords de pixel CENTRADAS — já descontado o 0.5 da borda, então o
// valor da célula k mora em k e os vizinhos são floor(u)/floor(u)+1. cMin/rMin
// são o canto da janela lida; winW/winH suas dimensões. Cantos nodata / NaN /
// fora-da-janela são descartados e os pesos renormalizados (degrada com graça
// nas bordas de cobertura); null se nenhum dos 4 cantos vale. A amostragem
// bilinear suaviza o serrilhado do nearest-neighbor — perfil de elevação mais
// fiel à rampa real da célula, sem saltos de ±meia-célula entre pontos.
function bilinearFromWindow(ras, winW, winH, cMin, rMin, u, v, nodata) {
  const c0 = Math.floor(u), r0 = Math.floor(v);
  const fu = u - c0, fv = v - r0;
  const corners = [
    [r0,     c0,     (1 - fu) * (1 - fv)],
    [r0,     c0 + 1, fu * (1 - fv)],
    [r0 + 1, c0,     (1 - fu) * fv],
    [r0 + 1, c0 + 1, fu * fv],
  ];
  let acc = 0, wsum = 0;
  for (const [r, c, w] of corners) {
    if (w <= 0) continue;
    const lc = c - cMin, lr = r - rMin;
    if (lc < 0 || lr < 0 || lc >= winW || lr >= winH) continue;
    const val = ras[lr * winW + lc];
    if (!Number.isFinite(val) || (nodata != null && val === nodata)) continue;
    acc += val * w; wsum += w;
  }
  return wsum > 0 ? acc / wsum : null;
}

// Sample elevation (meters) at lat/lng, BILINEAR. Returns null when the tile is
// missing or every covering cell is nodata. Batched callers should prefer
// `sampleFabdemBatch` to reuse a single window per tile.
async function sampleFabdemAt(lat, lng) {
  const latLo = Math.floor(lat);
  const lonLo = Math.floor(lng);
  const t = await openFabdemTile(latLo, lonLo);
  if (!t) return null;
  const [oX, oY] = t.origin;
  const [rX, rY] = t.resolution;   // rX > 0, rY < 0
  const W = t.image.getWidth(), H = t.image.getHeight();
  const u = (lng - oX) / rX - 0.5;
  const v = (lat - oY) / rY - 0.5;
  const cMin = Math.max(0, Math.floor(u)), rMin = Math.max(0, Math.floor(v));
  const cMax = Math.min(W - 1, Math.floor(u) + 1), rMax = Math.min(H - 1, Math.floor(v) + 1);
  if (cMax < cMin || rMax < rMin) return null;
  try {
    const winW = cMax - cMin + 1, winH = rMax - rMin + 1;
    const ras = await t.image.readRasters({
      window: [cMin, rMin, cMax + 1, rMax + 1],
      interleave: true,
    });
    return bilinearFromWindow(ras, winW, winH, cMin, rMin, u, v, t.nodata);
  } catch (e) {
    console.warn(`[fabdem] sample ${lat},${lng} falhou: ${e.message}`);
    return null;
  }
}

// Sample many points efficiently: groups by tile and reads one bounding
// window per tile, then indexes each point into the buffer. ~1 HTTP
// range request per tile instead of one per point.
async function sampleFabdemBatch(points /* [[lat, lng], …] */) {
  if (!points.length) return [];
  // Bucket points by their tile.
  const groups = new Map();   // "latLo_lonLo" → { latLo, lonLo, idxs: [origIdx,…] }
  points.forEach(([lat, lng], i) => {
    const latLo = Math.floor(lat);
    const lonLo = Math.floor(lng);
    const k = `${latLo}_${lonLo}`;
    if (!groups.has(k)) groups.set(k, { latLo, lonLo, idxs: [] });
    groups.get(k).idxs.push(i);
  });
  const out = new Array(points.length).fill(null);
  for (const { latLo, lonLo, idxs } of groups.values()) {
    const t = await openFabdemTile(latLo, lonLo);
    if (!t) continue;
    const [oX, oY] = t.origin;
    const [rX, rY] = t.resolution;
    const W = t.image.getWidth(), H = t.image.getHeight();
    // Janela cobrindo os 4 vizinhos bilineares (floor..floor+1) de cada ponto.
    let cMin = Infinity, cMax = -Infinity, rMin = Infinity, rMax = -Infinity;
    const samp = idxs.map(i => {
      const [lat, lng] = points[i];
      const u = (lng - oX) / rX - 0.5;
      const v = (lat - oY) / rY - 0.5;
      const c0 = Math.floor(u), r0 = Math.floor(v);
      if (c0     < cMin) cMin = c0;     if (c0 + 1 > cMax) cMax = c0 + 1;
      if (r0     < rMin) rMin = r0;     if (r0 + 1 > rMax) rMax = r0 + 1;
      return [i, u, v];
    });
    cMin = Math.max(0, cMin); rMin = Math.max(0, rMin);
    cMax = Math.min(W - 1, cMax); rMax = Math.min(H - 1, rMax);
    if (cMax < cMin || rMax < rMin) continue;
    try {
      const winW = cMax - cMin + 1, winH = rMax - rMin + 1;
      const ras = await t.image.readRasters({
        window: [cMin, rMin, cMax + 1, rMax + 1],
        interleave: true,
      });
      for (const [i, u, v] of samp) {
        const z = bilinearFromWindow(ras, winW, winH, cMin, rMin, u, v, t.nodata);
        if (z != null) out[i] = z;
      }
    } catch (e) {
      console.warn(`[fabdem] read window (${latLo},${lonLo}) falhou: ${e.message}`);
    }
  }
  return out;
}

// ─── DEM local de SP (sampa_geral): COG único EPSG:4326 (~5 m) ───────────────
// COG único hospedado em telhas.pedalhidrografi.co; geotiff.js puxa só os
// blocos necessários por Range request. Mesma matemática de pixel do FABDEM
// (ambos EPSG:4326), só que UMA imagem em vez de tiles 1°×1°. Aberto sob
// demanda e cacheado; ativo apenas quando params.useSampaDem está ligado.
const SAMPA_DEM_URL = 'https://telhas.pedalhidrografi.co/dem/sampa_geral.tif';

// Constrói o "handle" de DEM (origin/resolution/bounds/nodata) a partir de uma
// imagem geotiff.js já aberta. Compartilhado entre o DEM de SP (Range fetch de
// URL) e o DEM custom (GeoTIFF carregado de arquivo em memória). A matemática
// de pixel assume EPSG:4326 (graus) — igual ao FABDEM.
function demHandleFromImage(image) {
  const origin = image.getOrigin();         // [oX(west lon), oY(north lat)]
  const resolution = image.getResolution(); // [rX>0, rY<0]
  const W = image.getWidth();
  const H = image.getHeight();
  const nodataRaw = image.fileDirectory.getValue
    ? image.fileDirectory.getValue('GDAL_NODATA')
    : image.fileDirectory.GDAL_NODATA;
  const nodata = nodataRaw != null ? parseFloat(nodataRaw) : null;
  const bounds = {
    west:  origin[0],
    north: origin[1],
    east:  origin[0] + W * resolution[0],
    south: origin[1] + H * resolution[1],
  };
  return { image, origin, resolution, W, H, nodata, bounds };
}

let _sampaDemPromise = null;
async function openSampaDem() {
  if (_sampaDemPromise) return _sampaDemPromise;
  _sampaDemPromise = (async () => {
    try {
      const GeoTIFF = await ensureGeoTIFF();
      const tiff  = await GeoTIFF.fromUrl(SAMPA_DEM_URL);
      return demHandleFromImage(await tiff.getImage());
    } catch (e) {
      console.info(`[sampa-dem] indisponível: ${e.message}`);
      return null;   // negative cache: don't keep retrying
    }
  })();
  return _sampaDemPromise;
}

// ─── DEM custom (GeoTIFF carregado de arquivo, EPSG:4326) ────────────────────
// Carregado em memória pelo modal "Fontes de dados"; tem PRIORIDADE sobre o DEM
// de SP e o FABDEM onde cobrir (na amostragem e no mosaico do roteamento). Mesmo
// handle/matemática do DEM de SP — só que a imagem vem de um ArrayBuffer
// (fromArrayBuffer) em vez de Range fetch. Efêmero: some ao recarregar a página.
let _customDem = null;   // { image, …, bounds, projected, name } | null
async function setCustomDem(file) {
  const GeoTIFF = await ensureGeoTIFF();
  const buf = await file.arrayBuffer();
  const tiff = await GeoTIFF.fromArrayBuffer(buf);
  const h = demHandleFromImage(await tiff.getImage());
  // Aviso de CRS: a matemática de pixel é em graus (EPSG:4326). Um DEM projetado
  // (UTM/Web Mercator…) amostraria errado. Detecta por DUAS vias: a geokey
  // ProjectedCSTypeGeoKey (presente ⇒ projetado, mesmo que a base seja 4326) E
  // a heurística da resolução — um DEM em metros tem |res| » 0.5° (um grau ≈
  // 111 km; FABDEM/DEM-SP têm res ~1e-4..1e-3°), pegando até GeoTIFF sem geokeys.
  // Não bloqueia (alguns COG 4326 não setam geokeys), só alerta.
  h.projected = Math.abs(h.resolution[0]) > 0.5;
  try {
    const keys = h.image.getGeoKeys ? h.image.getGeoKeys() : {};
    if (keys.ProjectedCSTypeGeoKey) h.projected = true;
  } catch { /* sem geokeys: vale a heurística de resolução acima */ }
  h.name = file.name;
  _customDem = h;
  return h;
}
function clearCustomDem() { _customDem = null; }

function withinSampaDem(b, lat, lng) {
  return lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east;
}

// Sample many points from the single COG: one bounding-window read covering
// every in-bounds point. Out-of-bounds (or nodata) entries stay null so the
// caller can fall back to FABDEM/Open-Meteo.
async function sampleDemHandle(t, points /* [[lat,lng], …] */) {
  const out = new Array(points.length).fill(null);
  if (!t || !points.length) return out;
  const [oX, oY] = t.origin;
  const [rX, rY] = t.resolution;
  // Janela cobrindo os 4 vizinhos bilineares (floor..floor+1) de cada ponto.
  let cMin = Infinity, cMax = -Infinity, rMin = Infinity, rMax = -Infinity;
  const samp = [];
  points.forEach(([lat, lng], i) => {
    if (!withinSampaDem(t.bounds, lat, lng)) return;
    const u = (lng - oX) / rX - 0.5;
    const v = (lat - oY) / rY - 0.5;
    const c0 = Math.floor(u), r0 = Math.floor(v);
    if (c0 + 1 < 0 || c0 > t.W - 1 || r0 + 1 < 0 || r0 > t.H - 1) return;
    if (c0     < cMin) cMin = c0;     if (c0 + 1 > cMax) cMax = c0 + 1;
    if (r0     < rMin) rMin = r0;     if (r0 + 1 > rMax) rMax = r0 + 1;
    samp.push([i, u, v]);
  });
  if (!samp.length) return out;
  cMin = Math.max(0, cMin); rMin = Math.max(0, rMin);
  cMax = Math.min(t.W - 1, cMax); rMax = Math.min(t.H - 1, rMax);
  if (cMax < cMin || rMax < rMin) return out;
  try {
    const winW = cMax - cMin + 1, winH = rMax - rMin + 1;
    const ras = await t.image.readRasters({
      window: [cMin, rMin, cMax + 1, rMax + 1],
      interleave: true,
    });
    for (const [i, u, v] of samp) {
      const z = bilinearFromWindow(ras, winW, winH, cMin, rMin, u, v, t.nodata);
      if (z != null) out[i] = z;
    }
  } catch (e) {
    console.warn(`[dem] read window falhou: ${e.message}`);
  }
  return out;
}
async function sampleSampaDemBatch(points) { return sampleDemHandle(await openSampaDem(), points); }
async function sampleCustomDemBatch(points) { return sampleDemHandle(_customDem, points); }

// ─── Câmera Topográfica: relevo servido como tiles XYZ ───────────────────────
// Igual ao sampasimu: elevação na paleta cmocean.phase (cíclica, perceptual)
// multiplicada por um realce de declividade (branco→preto, γ-corrigido). O
// render roda no servidor (cameratopo.pedalhidrografi.co/{z}/{x}/{y}.png) com
// a fonte `dem=ee`: a MESMA composição construída como expressão Google Earth
// Engine sobre o FABDEM (mapid proxiado pelo cameratopo) — declividade nativa
// em qualquer zoom, sem os limites do render local de COGs (que clampava a
// camada a z12–16). A camada é um L.tileLayer comum no pane reordenável
// 'camera-topo' — sem re-render por pan/zoom no cliente. Parâmetros (min/max
// elevação, declividade máx., γ, ciclos da paleta) viram querystring do tile;
// campo em branco = `auto` (o servidor resolve por percentis de uma região de
// referência — mesmo com dem=ee, os percentis vêm do caminho local). O botão
// "Estimar pela extensão atual" ainda calcula percentis no cliente
// (buildCameraTopoFrame, abaixo) pra preencher valores explícitos adaptados à
// viewport.

// Declividade (m/m) por diferença central. Bordas replicam; vizinho nodata cai
// na própria altura (zero gradiente em vez de salto fictício na borda do DEM).
function computeSlope(height, mask, H, W, dxM, dyM) {
  const slope = new Float32Array(H * W);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      if (!mask[i]) continue;
      const cw = c > 0 ? c - 1 : c, ce = c < W - 1 ? c + 1 : c;
      const rn = r > 0 ? r - 1 : r, rs = r < H - 1 ? r + 1 : r;
      const h0 = height[i];
      const hw = mask[r * W + cw] ? height[r * W + cw] : h0;
      const he = mask[r * W + ce] ? height[r * W + ce] : h0;
      const hn = mask[rn * W + c] ? height[rn * W + c] : h0;
      const hs = mask[rs * W + c] ? height[rs * W + c] : h0;
      const spanX = (ce - cw) * dxM, spanY = (rs - rn) * dyM;
      const dhdx = spanX > 0 ? (he - hw) / spanX : 0;
      const dhdy = spanY > 0 ? (hs - hn) / spanY : 0;
      slope[i] = Math.sqrt(dhdx * dhdx + dhdy * dhdy);
    }
  }
  return slope;
}

function percentileFromSorted(sorted, p) {
  const n = sorted.length;
  if (!n) return NaN;
  const f = (Math.max(0, Math.min(100, p)) / 100) * (n - 1);
  const i0 = Math.floor(f), i1 = Math.min(n - 1, i0 + 1);
  return sorted[i0] + (sorted[i1] - sorted[i0]) * (f - i0);
}

const RELIEF_PERCENTILE_SAMPLES = 100_000;

// Percentis (elev p5/p80, declividade p80) por amostragem reservatório — barato
// e estável mesmo em mosaicos grandes. Usado pelo render (quando o parâmetro é
// auto) e pelo botão "Estimar pela extensão atual".
function reliefPercentiles(height, mask, slope, H, W) {
  const N = H * W;
  const eS = new Float32Array(RELIEF_PERCENTILE_SAMPLES);
  const sS = new Float32Array(RELIEF_PERCENTILE_SAMPLES);
  let collected = 0, seen = 0;
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    if (collected < RELIEF_PERCENTILE_SAMPLES) {
      eS[collected] = height[i]; sS[collected] = slope[i]; collected++;
    } else {
      const j = Math.floor(Math.random() * (seen + 1));
      if (j < RELIEF_PERCENTILE_SAMPLES) { eS[j] = height[i]; sS[j] = slope[i]; }
    }
    seen++;
  }
  if (!collected) return null;
  const eSorted = eS.subarray(0, collected).slice().sort();
  const sSorted = sS.subarray(0, collected).slice().sort();
  return {
    elevP5:   percentileFromSorted(eSorted, 5),
    elevP80:  percentileFromSorted(eSorted, 80),
    slopeP80: Math.max(1e-9, percentileFromSorted(sSorted, 80)),
  };
}

// Só pro botão "Estimar pela extensão atual": abaixo disso o mosaico DEM da
// viewport (~30 m) fica grande/inútil demais pra estimar percentis no cliente.
// A CAMADA em si não clampa mais — a fonte EE renderiza nativa em todo zoom.
const CAMERA_TOPO_MIN_ZOOM = 12;
const CAMERATOPO_TILE_BASE = 'https://cameratopo.pedalhidrografi.co';
// Cache-buster espelhando o TILE_VERSION da UI do cameratopo — bumpar junto
// quando o render de lá mudar, senão CDN/navegador seguram tiles velhos até 7d.
const CAMERATOPO_TILE_VERSION = '4';
let cameraTopoLayer = null;
let cameraTopoOpacity = settings.cameraTopo.opacityPct / 100;

// Monta a URL de tiles a partir dos parâmetros. Campo null → `auto` (o servidor
// resolve por percentis de uma região de referência — uniforme em toda a grade,
// sem costuras). slopeMax é em m/m (igual ao armazenado). `ss` (superamostragem
// do render local) não se aplica à fonte ee — omitido.
function cameraTopoTileUrl() {
  const c = settings.cameraTopo;
  const qs = new URLSearchParams();
  qs.set('elevMin',  c.minElev  != null ? String(c.minElev)  : 'auto');
  qs.set('elevMax',  c.maxElev  != null ? String(c.maxElev)  : 'auto');
  qs.set('slopeMax', c.maxSlope != null ? String(c.maxSlope) : 'auto');
  qs.set('slopeGamma', String(c.slopeGamma ?? 1.2));
  qs.set('cycles', String(c.cycles ?? 1));
  qs.set('dem', 'ee');
  qs.set('v', CAMERATOPO_TILE_VERSION);
  return `${CAMERATOPO_TILE_BASE}/{z}/{x}/{y}.png?${qs.toString()}`;
}

function showCameraTopo() {
  if (!cameraTopoLayer) {
    cameraTopoLayer = L.tileLayer(cameraTopoTileUrl(), {
      opacity: cameraTopoOpacity,
      pane: LAYER_PANE('camera-topo'),
      attribution: 'Câmera Topográfica · FABDEM · Google Earth Engine',
    });
  }
  cameraTopoLayer.addTo(map);
}
function hideCameraTopo() {
  if (cameraTopoLayer) map.removeLayer(cameraTopoLayer);
}
function setCameraTopoOpacity(frac) {
  cameraTopoOpacity = frac;
  settings.cameraTopo.opacityPct = Math.round(frac * 100);
  saveSettings();
  if (cameraTopoLayer) cameraTopoLayer.setOpacity(frac);
}
// Reconstrói a URL quando um parâmetro muda (o Leaflet recarrega os tiles).
function refreshCameraTopo() {
  if (cameraTopoLayer) cameraTopoLayer.setUrl(cameraTopoTileUrl());
}

// Monta o mosaico DEM da viewport, computa declividade e os parâmetros (auto =
// percentis), e devolve { dem, slope, elevMin, elevMax, slopeMax, gamma, bb }.
async function buildCameraTopoFrame() {
  const b = map.getBounds();
  const bb = { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() };
  const dem = await loadDemMosaic(bb);
  if (!dem || !dem.W || !dem.H) return null;
  const A = FABDEM_ARCSEC;
  const latC = (bb.north + bb.south) / 2;
  const dyM = A * 111320;
  const dxM = A * 111320 * Math.cos((latC * Math.PI) / 180);
  const slope = computeSlope(dem.height, dem.mask, dem.H, dem.W, dxM, dyM);
  const pct = reliefPercentiles(dem.height, dem.mask, slope, dem.H, dem.W);
  if (!pct) return null;
  const cfg = settings.cameraTopo;
  return {
    dem, slope, bb,
    elevMin:  cfg.minElev  != null ? cfg.minElev  : pct.elevP5,
    elevMax:  cfg.maxElev  != null ? cfg.maxElev  : pct.elevP80,
    slopeMax: cfg.maxSlope != null ? cfg.maxSlope : pct.slopeP80,
    gamma:    cfg.slopeGamma || 1.2,
    pct,
  };
}

// ─── Elevation (FABDEM por padrão; Open-Meteo como fallback) ─────────────────
// Cached by ~1m-rounded lat,lon so dragging/undo doesn't refetch the same
// point. Up to 100 coords per HTTP call; debounced 400ms after user activity.
const elevationCache = new Map();
let elevationDebounceTimer = null;
let elevationFetchSeq = 0;

function elevKey(lat, lng) {
  return `${lat.toFixed(5)},${lng.toFixed(5)}`;
}

function pathLatLngArray() {
  return assembleLatLngs().map((ll) => [ll.lat, ll.lng]);
}

// Achata o perfil de elevação do DISPLAY nos vãos de tabuleiro. viarioGraphRoute
// marca os pontos interiores de ponte/túnel (path.deckFlag). Para cada trecho
// contíguo marcado, interpola a elevação dos interiores entre os dois apoios
// (pontos não-marcados vizinhos), usando a elevação que o PRÓPRIO display
// amostrou nos apoios — então ↑/↓/kJ refletem o tabuleiro plano sem o
// descasamento de fonte que haveria ao reusar o DEM grosseiro do roteamento.
// Roda depois do fetch de elevação e antes de updateMetrics.
function flattenDeckProfile() {
  const distM = (a, b) => {
    const M = 111320, dLat = (b[0] - a[0]) * M,
      dLng = (b[1] - a[1]) * M * Math.cos((a[0] + b[0]) / 2 * Math.PI / 180);
    return Math.hypot(dLat, dLng);
  };
  for (const tp of trackpoints) {
    const pts = tp && tp.pathFromPrev;
    const flags = pts && pts.deckFlag;
    if (!pts || !flags || flags.length !== pts.length) continue;
    let i = 0;
    while (i < flags.length) {
      if (!flags[i]) { i++; continue; }
      let a = i; while (i + 1 < flags.length && flags[i + 1]) i++;
      const b = i; i++;
      const lo = a - 1, hi = b + 1;        // âncoras = apoios (não-marcados)
      if (lo < 0 || hi >= pts.length) continue;
      const eLo = elevationCache.get(elevKey(pts[lo][0], pts[lo][1]));
      const eHi = elevationCache.get(elevKey(pts[hi][0], pts[hi][1]));
      if (!Number.isFinite(eLo) || !Number.isFinite(eHi)) continue;
      const arc = []; let total = 0;
      for (let k = lo; k <= hi; k++) { if (k > lo) total += distM(pts[k - 1], pts[k]); arc.push(total); }
      for (let k = a; k <= b; k++) {
        const f = total > 0 ? arc[k - lo] / total : 0;
        elevationCache.set(elevKey(pts[k][0], pts[k][1]), eLo + (eHi - eLo) * f);
      }
    }
  }
}

function scheduleElevationFetch() {
  clearTimeout(elevationDebounceTimer);
  elevationDebounceTimer = setTimeout(async () => {
    const path = pathLatLngArray();
    if (path.length === 0) return;
    const seq = ++elevationFetchSeq;
    await fetchMissingElevations(path, seq);
    if (seq === elevationFetchSeq) { flattenDeckProfile(); updateMetrics(); }
  }, 400);
}

async function fetchMissingElevations(path, seq) {
  // Collect unique cache keys we don't have.
  const seen = new Set();
  const missing = [];
  for (const [lat, lng] of path) {
    const k = elevKey(lat, lng);
    if (elevationCache.has(k) || seen.has(k)) continue;
    seen.add(k);
    missing.push([lat, lng]);
  }
  if (missing.length === 0) return;

  // Cadeia de fontes: DEM de SP (se ligado, alta-res dentro da RMSP) →
  // FABDEM (se ligado) → Open-Meteo. Cada fonte só recebe o que sobrou null.
  let stillMissing = missing;
  const drainSource = async (label, sampleFn) => {
    try {
      const elevs = await sampleFn(stillMissing);
      if (seq !== elevationFetchSeq) return true; // cancelado: aborta
      const remaining = [];
      stillMissing.forEach(([la, lo], i) => {
        const e = elevs[i];
        if (Number.isFinite(e)) elevationCache.set(elevKey(la, lo), e);
        else remaining.push([la, lo]);
      });
      stillMissing = remaining;
    } catch (err) {
      console.warn(`${label} elevation fetch failed:`, err.message);
    }
    return false;
  };
  if (_customDem) {
    if (await drainSource('custom-dem', sampleCustomDemBatch)) return;
    if (stillMissing.length === 0) return;
  }
  if (params.useSampaDem) {
    if (await drainSource('sampa-dem', sampleSampaDemBatch)) return;
    if (stillMissing.length === 0) return;
  }
  if (params.useFabdem) {
    if (await drainSource('FABDEM', sampleFabdemBatch)) return;
  }
  if (stillMissing.length === 0) return;

  // Open-Meteo (fallback): 1 chamada a cada 100 coords.
  const BATCH = 100;
  for (let i = 0; i < stillMissing.length; i += BATCH) {
    if (seq !== elevationFetchSeq) return;
    const batch = stillMissing.slice(i, i + BATCH);
    const lats = batch.map(([la]) => la.toFixed(5)).join(',');
    const lons = batch.map(([, lo]) => lo.toFixed(5)).join(',');
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const elevs = Array.isArray(data.elevation) ? data.elevation : [];
      batch.forEach(([la, lo], j) => {
        const e = elevs[j];
        if (Number.isFinite(e)) elevationCache.set(elevKey(la, lo), e);
      });
    } catch (err) {
      console.warn('Open-Meteo elevation fetch failed:', err.message);
      return;
    }
  }
}

function elevationForPath(path) {
  // Returns { gainMeters, lossMeters, missing } where missing is the count of
  // points without a cached elevation.
  let gain = 0;
  let loss = 0;
  let missing = 0;
  let prev = null;
  for (const [lat, lng] of path) {
    const e = elevationCache.get(elevKey(lat, lng));
    if (!Number.isFinite(e)) {
      missing++;
      continue;
    }
    if (prev != null) {
      const d = e - prev;
      if (d > 0) gain += d;
      else loss += -d;
    }
    prev = e;
  }
  return { gain, loss, missing };
}

// ─── Speed simulation ────────────────────────────────────────────────────────
// Solve  a·v³ + b·v + c = 0  for the positive real root, where
//   a = ½·ρ·CdA   b = m·g·(Crr + sin θ)   c = −P
// On flat/uphill this gives the rider's equilibrium speed. Newton from a
// sensible starting point converges in ~10 iterations.
function solveSpeedAtGradient(power, gradient, p) {
  const a = 0.5 * p.rho * p.cda;
  const b = p.mass * G * (p.crr + gradient);
  const c = -power;
  let v = 5;
  for (let i = 0; i < 60; i++) {
    const f = a * v * v * v + b * v + c;
    const fp = 3 * a * v * v + b;
    if (!Number.isFinite(fp) || Math.abs(fp) < 1e-12) break;
    const dv = f / fp;
    v -= dv;
    if (v < 0.1) v = 0.1;
    if (Math.abs(dv) < 1e-7) break;
  }
  return Math.max(0.5, v);
}

function segmentSpeed(gradient, p) {
  const power = powerFor(gradient, p);
  // Flat / uphill / gentle descent: rider holds the power for that terrain
  // category, solve cubic for equilibrium speed.
  if (gradient >= -p.slopeFlatThreshold) {
    return solveSpeedAtGradient(power, gradient, p);
  }
  // True descent (slope < −threshold): the rider would naturally exceed flat
  // speed. ε controls how much of that excess they actually let happen.
  const vFlat = solveSpeedAtGradient(p.powerFlat, 0, p);
  const vCoast = solveSpeedAtGradient(p.powerDescent, gradient, p);
  if (vCoast <= vFlat) return vFlat;
  return vFlat + p.epsilon * (vCoast - vFlat);
}

// Deadband (backlash) filter on an elevation profile: ignores moves smaller than
// `tau` and tracks larger ones (lagging by tau), rejecting sub-tau DEM jitter from
// h±/h₋ while preserving real climbs. NaN points (missing elevation) pass through
// and don't update the running reference. The v2 model's "right" smoothing for
// full-profile data (see bicycling-energy-model/notas.md). Mirrors sampasimu's
// deadband() / refEnergyKJ.
function deadbandElev(h, tau) {
  const out = new Array(h.length);
  let y = NaN;
  for (let i = 0; i < h.length; i++) {
    const hi = h[i];
    if (!Number.isFinite(hi)) { out[i] = NaN; continue; }
    if (!Number.isFinite(y)) { y = hi; out[i] = y; continue; }
    if (hi > y + tau) y = hi - tau;
    else if (hi < y - tau) y = hi + tau;
    out[i] = y;
  }
  return out;
}

// v2 cost bundle from the physics params — the SINGLE source for the routing
// engine (the vendored worker's v2Edge AND the inline vector router's edgeCost)
// and the energy estimate. v_f is derived from the flat-power equilibrium. The
// per-edge arithmetic must stay identical across all three (worker v2Edge, the
// inline edgeCost, sampasimu's Rust v2_edge). Keep epsOffset = 0.13.
function readCost(p) {
  const vf = solveSpeedAtGradient(p.powerFlat, 0, p);
  const kEff = Math.min(1, Math.max(0.1, p.kEff ?? 0.97));
  const aero = 0.5 * p.rho * p.cda * vf * vf;            // ½ρCdA·v_f² (J per ground metre)
  return {
    aRoll: (p.crr * p.mass * G) / kEff,                  // J per ground metre (always)
    aAero: aero / kEff,                                  // J per ground metre (off climbs)
    beta: (p.mass * G) / kEff,                           // J per metre climbed
    climbThr: p.slopeFlatThreshold,
    abRatio: p.crr + aero / (p.mass * G),                // = α/β, flat-resistance grade
    epsOffset: 0.13,
    vf, kEff,                                            // convenience for the estimate/tooltip
  };
}

// Perfil da receita de planejamento (bicycling-energy-model, paper 2 §3):
// reamostra o traçado a passo FIXO de 30 m de arco, lendo a série de elevação
// dos vértices (já com tabuleiros achatados pelo flattenDeckProfile) por
// interpolação linear na quilometragem. Regra 3 da receita: NÃO superamostrar
// a fonte — vértices densos (OSRM ~10 m, GPX, DEM-SP 5 m) sobre uma fonte
// grossa fabricam relevo sub-célula e inflam h₊ (FABDEM @5 m: +4,3 pp de viés
// vs +2,2 @30 m, Tabela 1 do paper) — e o ε₀ = 0,13 do estimador de descida
// foi calibrado exatamente a 30 m de amostragem (paper 1 §4.4.2). A
// quilometragem s é a do TRAÇADO real (arco), então distância/rolamento não
// mudam com a reamostragem. h = NaN onde algum vértice-suporte ainda não tem
// elevação (mesma semântica de "carregando" de antes).
const PROFILE_STEP_M = 30;
function buildRecipeProfile(latlngs) {
  const n = latlngs.length;
  const sV = new Float64Array(n);
  const eV = new Float64Array(n);
  const elevAt = (q) => {
    const e = elevationCache.get(elevKey(q.lat, q.lng));
    return Number.isFinite(e) ? e : NaN;
  };
  eV[0] = elevAt(latlngs[0]);
  let S = 0;
  for (let i = 1; i < n; i++) {
    S += latlngs[i - 1].distanceTo(latlngs[i]);
    sV[i] = S;
    eV[i] = elevAt(latlngs[i]);
  }
  // Nós a cada 30 m + o endpoint (um resto < 1 m é absorvido no último nó,
  // pra não criar um segmento-migalha no fim).
  const s = [];
  for (let x = 0; x < S; x += PROFILE_STEP_M) s.push(x);
  if (!s.length || S - s[s.length - 1] >= 1) s.push(S); else s[s.length - 1] = S;
  const h = new Float64Array(s.length);
  let j = 0;
  for (let k = 0; k < s.length; k++) {
    while (j < n - 2 && sV[j + 1] < s[k]) j++;
    const a = eV[j], b = eV[j + 1], span = sV[j + 1] - sV[j];
    const f = span > 0 ? (s[k] - sV[j]) / span : 0;
    h[k] = (Number.isFinite(a) && Number.isFinite(b)) ? a + (b - a) * f : NaN;
  }
  return { s, h, total: S };
}

// Walk the recipe profile summing distance, time, and the v2 leg energy.
// TIME stays the per-segment equilibrium-speed simulation (on raw Δh); ENERGY is
// the v2 closed form (bicycling-energy-model notas.md): rolling over all distance,
// aero charged only OFF the climbs at the flat speed v_f, gravity m·g·Δh with a
// per-grade descent recovery ε, all ÷ k_eff, on a 2 m-deadbanded profile —
// paper 2's eq. (L1) with paper 1 eq. (5)'s drop-weighted ε_d, on the 30 m
// resampled profile of buildRecipeProfile above.
// Returns null if there's no path yet.
function simulateRide(p) {
  const latlngs = assembleLatLngs();
  if (latlngs.length < 2) return null;

  const prof = buildRecipeProfile(latlngs);
  const elev = Array.from(prof.h);            // NaN onde falta elevação
  const elevS = deadbandElev(elev, p.deadbandM ?? 2);

  // v2 cost coefficients (Joules; ÷1000 for kJ at display) — shared with the
  // routing engine via readCost(). aero is dropped on segments steeper than climbThr.
  const { aRoll, aAero, beta, abRatio, climbThr, vf, kEff } = readCost(p);

  let totalDist = 0, totalTime = 0, elevMissing = 0;
  let tAscent = 0, tFlat = 0, tDescent = 0;
  // v2 accumulators (on the smoothed profile).
  let xTot = 0, xNonClimb = 0, hPlus = 0, hMinus = 0;
  let epsNum = 0, epsDen = 0;          // drop-weighted εcoast
  let wRollJ = 0, wAeroJ = 0, wClimbJ = 0;

  for (let i = 1; i < prof.s.length; i++) {
    const seg = prof.s[i] - prof.s[i - 1];
    if (seg < 0.5) continue;

    // Raw Δh → the (unchanged) speed/time simulation.
    const eA = elev[i - 1], eB = elev[i];
    let dh = 0;
    if (Number.isFinite(eA) && Number.isFinite(eB)) dh = eB - eA;
    else elevMissing++;
    const gradient = dh / seg;
    const v = segmentSpeed(gradient, p);
    const t = seg / v;

    totalDist += seg;
    totalTime += t;
    if (gradient > p.slopeFlatThreshold) tAscent += t;
    else if (gradient < -p.slopeFlatThreshold) tDescent += t;
    else tFlat += t;

    // Smoothed Δh → the v2 leg-energy accounting.
    const eAs = elevS[i - 1], eBs = elevS[i];
    const dhS = (Number.isFinite(eAs) && Number.isFinite(eBs)) ? eBs - eAs : 0;
    const gradS = dhS / seg;
    xTot += seg;
    wRollJ += aRoll * seg;
    if (dhS >= 0) {
      hPlus += dhS;
      wClimbJ += beta * dhS;
      if (gradS < climbThr) { xNonClimb += seg; wAeroJ += aAero * seg; } // aero off climbs
    } else {
      hMinus += -dhS;
      xNonClimb += seg; wAeroJ += aAero * seg;        // descents: full flat aero
      const s = -gradS;                                // descent grade > 0
      const epsCoast = Math.min(1, abRatio / s);
      epsNum += epsCoast * (-dhS);
      epsDen += (-dhS);
    }
  }

  // Drop-weighted ε with the empirical −0.13 offset, clamped to [0,1].
  let eps = epsDen > 0 ? epsNum / epsDen - 0.13 : 0;
  if (eps < 0) eps = 0; else if (eps > 1) eps = 1;
  const wDescentJ = -eps * beta * hMinus;             // ≤ 0 (energy gravity returns)
  const eLegJ = wRollJ + wAeroJ + wClimbJ + wDescentJ;
  const fPlus = xTot > 0 ? (xTot - xNonClimb) / xTot : 0;

  return {
    distMeters: totalDist,
    timeSec: totalTime,
    avgSpeedMps: totalDist / Math.max(1, totalTime),
    eLegJ,
    workRollJ: wRollJ,
    workAeroJ: wAeroJ,
    workGravUpJ: wClimbJ,
    workGravDownJ: wDescentJ,
    fPlus, epsUsed: eps, vf, kEff,
    timeAscentSec: tAscent,
    timeFlatSec: tFlat,
    timeDescentSec: tDescent,
    ascentM: hPlus,        // smoothed (matches the energy terms)
    descentM: hMinus,
    elevMissing,
  };
}

// Perfil de potência de 3 níveis do SUV — mesma lógica de powerFor() da bike,
// mas com o limiar e as potências próprios do carro. A potência em descida
// pode ser NEGATIVA (freio ativo): o SUV não deixa a gravidade acelerá-lo
// livre como a bike faz (que só reduz o pedal e deixa o ε de velocidade —
// tempo, não energia — abrir parte da diferença).
function powerForCar(gradient, p) {
  if (gradient > p.carSlopeFlatThreshold) return p.carPowerAscent;
  if (gradient < -p.carSlopeFlatThreshold) return p.carPowerDescent;
  return p.carPowerFlat;
}

// Velocidade de equilíbrio do SUV num gradiente — mesmo solver cúbico da
// bike (solveSpeedAtGradient), com a MESMA salvaguarda que segmentSpeed() usa
// pra descidas: perto do limiar (ou com potência de descida pequena/positiva),
// o Newton do solver parte de v=5 e pode ficar preso no piso (0,5 m/s) em vez
// de achar a raiz real — um artefato numérico, não uma velocidade física.
// vFlatRef (equilíbrio no plano, sempre bem-comportado) serve de piso: se a
// "velocidade de descida" resolvida vier menor ou igual a ela, é sinal de que
// o solver não convergiu (ou a potência de descida é baixa demais pra superar
// rolamento+arrasto), então usa vFlatRef em vez do valor quebrado.
function speedForCar(gradient, power, carP, vFlatRef) {
  const v = solveSpeedAtGradient(power, gradient, carP);
  return (gradient < 0 && v <= vFlatRef) ? vFlatRef : v;
}

// ─── Comparação "quantas vezes mais eficiente é a bike" vs. um SUV ───────────
// Caminha o MESMO traçado/perfil de elevação (deadbanded) que simulateRide()
// usa pra bike, segmento a segmento, com duas diferenças físicas do carro:
//   • arrasto SEMPRE cobrado (mesmo subindo) — a bike desacelera o bastante
//     numa subida pra zerar a contribuição aero; o SUV mantém a velocidade do
//     seu próprio perfil de potência o tempo todo (f=1, nunca cai fora).
//   • ε (recuperação na descida) é FIXO (p.carEpsilon), não estimado do
//     perfil da rota como o da bike.
// A velocidade de cada segmento vem do MESMO solver cúbico da bike
// (solveSpeedAtGradient), só que com o perfil de potência de 3 níveis e a
// massa/Crr/CdA do carro (powerForCar) — logo o termo aero varia por
// segmento (velocidade de subida ≠ plano ≠ descida), ao contrário do v_f
// único que o modelo fechado da bike usa.
function carEnergyJ(p) {
  const latlngs = assembleLatLngs();
  if (latlngs.length < 2) return { energyJ: 0, vAscent: 0, vFlat: 0, vDescent: 0 };

  // Mesmo perfil reamostrado a 30 m da bike (buildRecipeProfile) — a
  // comparação só é justa se os dois andam sobre a mesma elevação.
  const prof = buildRecipeProfile(latlngs);
  const elevS = deadbandElev(Array.from(prof.h), p.deadbandM ?? 2);

  const carP = { rho: p.rho, cda: p.carCda, mass: p.carMass, crr: p.carCrr };
  const alphaR = (p.carCrr * p.carMass * G) / p.carKEff;
  const beta = (p.carMass * G) / p.carKEff;
  const vFlatRef = solveSpeedAtGradient(p.carPowerFlat, 0, carP);

  let energyJ = 0;
  for (let i = 1; i < prof.s.length; i++) {
    const seg = prof.s[i] - prof.s[i - 1];
    if (seg < 0.5) continue;

    const eAs = elevS[i - 1], eBs = elevS[i];
    const dhS = (Number.isFinite(eAs) && Number.isFinite(eBs)) ? eBs - eAs : 0;
    const gradS = dhS / seg;

    const power = powerForCar(gradS, p);
    const v = speedForCar(gradS, power, carP, vFlatRef);
    const aeroJPerM = (0.5 * p.rho * p.carCda * v * v) / p.carKEff;

    energyJ += alphaR * seg + aeroJPerM * seg; // rolamento + arrasto (f=1, sempre)
    if (dhS >= 0) energyJ += beta * dhS;                          // subida
    else energyJ -= p.carEpsilon * beta * (-dhS);                 // descida (ε fixo)
  }

  // Velocidades de referência (só pra exibição): equilíbrio em cada nível do
  // perfil de potência, avaliado exatamente no limiar de plano configurado.
  const vAscent  = solveSpeedAtGradient(p.carPowerAscent, p.carSlopeFlatThreshold, carP);
  const vDescent = speedForCar(-p.carSlopeFlatThreshold, p.carPowerDescent, carP, vFlatRef);

  return { energyJ, vAscent, vFlat: vFlatRef, vDescent };
}

// Duração compacta pra barra de edição: uma unidade só (dias é a exceção,
// mostra d+h). 7d14h · 3h52 · 42m59 · 30s. Sem segundos a partir de 1 h.
function fmtDurCompact(sec) {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return `${d}d${String(h).padStart(2, '0')}h`;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}`;
  return `${s}s`;
}
// Distância compacta: abaixo de 2 km mostra metros (1689m); senão km com 1
// casa (16,4 km).
function fmtDistCompact(meters) {
  if (meters < 2000) return `${Math.round(meters)}m`;
  return `${(meters / 1000).toFixed(1).replace('.', ',')} km`;
}

// Poder calorífico da gasolina — usado só pra converter a energia de
// combustível do SUV (carKJ) numa estimativa de litros consumidos.
const GASOLINE_KJ_PER_LITER = 32000;

function updateMetrics() {
  const sim = simulateRide(params);
  const fmt = (n, d = 1) => n.toFixed(d).replace('.', ',');

  if (!sim) {
    traceMetrics.textContent = `0m · 0 kJ`;
    traceMetrics.title = '';
    return;
  }

  const km = sim.distMeters / 1000;
  const avgKmh = (sim.avgSpeedMps * 3600) / 1000;
  const totalKJ = sim.eLegJ / 1000;
  const wRollKJ = sim.workRollJ / 1000;
  const wAeroKJ = sim.workAeroJ / 1000;
  const wGravUpKJ = sim.workGravUpJ / 1000;
  const wGravDownKJ = sim.workGravDownJ / 1000; // ≤ 0 (gravity returned on descent)
  const vfKmh = (sim.vf * 3600) / 1000;
  const fPlusPct = (sim.fPlus * 100).toFixed(0);
  const epsPct = (sim.epsUsed * 100).toFixed(0);
  const kEffPct = (sim.kEff * 100).toFixed(0);
  let carKJ = 0, carLiters = 0, carVAscentKmh = 0, carVFlatKmh = 0, carVDescentKmh = 0;
  let bikeMetabolicKJ = 0, bikeVsCarRatio = 0, carKEffPct = '0';
  if (params.suvCompareEnabled) {
    const carSim = carEnergyJ(params);
    carKJ = carSim.energyJ / 1000;
    carLiters = carKJ / GASOLINE_KJ_PER_LITER;
    carVAscentKmh = (carSim.vAscent * 3600) / 1000;
    carVFlatKmh = (carSim.vFlat * 3600) / 1000;
    carVDescentKmh = (carSim.vDescent * 3600) / 1000;
    bikeMetabolicKJ = totalKJ * params.bikeMetabolicFactor;
    bikeVsCarRatio = bikeMetabolicKJ > 0.01 ? carKJ / bikeMetabolicKJ : 0;
    carKEffPct = (params.carKEff * 100).toFixed(0);
  }
  // Energia da ROTA (objetivo do roteador): soma dos routedEnergyJ por
  // segmento — o custo v2 por aresta que o Dijkstra minimizou (grade
  // σ30-tratada ou grafo do viário), capturado no roteamento. É um número
  // DIFERENTE da estimativa acima (a receita route-level do paper 2 sobre o
  // perfil reamostrado): fonte de elevação e discretização divergem de
  // propósito. "≥" quando só parte dos segmentos foi roteada por energia
  // (reta/OSRM/sentido invertido não têm objetivo).
  let routedJ = 0, routedSegs = 0, totalSegs = 0;
  for (let i = 1; i < trackpoints.length; i++) {
    totalSegs++;
    const pp = trackpoints[i].pathFromPrev;
    if (pp && Number.isFinite(pp.routedEnergyJ)) { routedJ += pp.routedEnergyJ; routedSegs++; }
  }
  const routedKJ = routedJ / 1000;
  const routedPartial = routedSegs > 0 && routedSegs < totalSegs;
  const routedCompact = routedSegs > 0
    ? ` · rota ${routedPartial ? '≥' : ''}${Math.round(routedKJ)} kJ`
    : '';

  const movingTimeSec = sim.timeSec;
  const totalTimeSec = movingTimeSec / Math.max(0.01, params.efficiency);
  const haveAllElev = sim.elevMissing === 0;
  const elevHint = haveAllElev ? '' : ' · ↑ carregando';
  const ascDesc = haveAllElev
    ? `↑${sim.ascentM.toFixed(0)} m ↓${sim.descentM.toFixed(0)} m`
    : `↑${sim.ascentM.toFixed(0)}… ↓${sim.descentM.toFixed(0)}…`;
  const thrPct = (params.slopeFlatThreshold * 100).toFixed(1).replace('.', ',');
  const effPct = (params.efficiency * 100).toFixed(0);
  const carCompact = (params.suvCompareEnabled && totalKJ > 0.01)
    ? ` · 🚙 ${fmt(carKJ / 1000, 1)} MJ / ⛽ ${fmt(carLiters, 2)} L (${fmt(bikeVsCarRatio, 0)}× mais energia)`
    : '';

  traceMetrics.textContent =
    `${fmtDistCompact(sim.distMeters)} · ${ascDesc} · ${fmtDurCompact(movingTimeSec)} mov · ${fmtDurCompact(totalTimeSec)} tot · ${Math.round(totalKJ)} kJ${routedCompact}${carCompact}${elevHint}`;
  traceMetrics.title =
    `Simulação por segmento.\n` +
    `  Distância:        ${fmt(km, 2)} km\n` +
    `  Subida acumulada: ${sim.ascentM.toFixed(0)} m\n` +
    `  Descida acumulada:${sim.descentM.toFixed(0)} m\n` +
    `  Vel. média (mov): ${fmt(avgKmh)} km/h\n` +
    `\n` +
    `Tempo:\n` +
    `  Movimento:        ${formatHMS(movingTimeSec)}\n` +
    `  Total (efic. ${effPct}%): ${formatHMS(totalTimeSec)}\n` +
    `\n` +
    `Tempo de movimento por terreno (limiar de ±${thrPct}%):\n` +
    `  Subida (${params.powerAscent} W):   ${formatHMS(sim.timeAscentSec)}\n` +
    `  Plano  (${params.powerFlat} W):    ${formatHMS(sim.timeFlatSec)}\n` +
    `  Descida (${params.powerDescent} W): ${formatHMS(sim.timeDescentSec)}\n` +
    `\n` +
    `Energia (modelo v2, pernas, kJ — perfil reamostrado a 30 m + deadband ${params.deadbandM ?? 2} m,\n` +
    `a receita de planejamento do bicycling-energy-model, paper 2 §3):\n` +
    `  Rolamento (Crr=${params.crr}, m=${params.mass} kg, k_ef=${kEffPct}%):  ${fmt(wRollKJ)}\n` +
    `  Aero (CdA=${params.cda} m², ρ=${params.rho}, v_f=${fmt(vfKmh)} km/h, só fora das subidas): ${fmt(wAeroKJ)}\n` +
    `  Subida (m·g·Δh+ / k_ef, f+=${fPlusPct}%):                   ${fmt(wGravUpKJ)}\n` +
    `  Descida (−ε·m·g·Δh− / k_ef, ε=${epsPct}% estimado do perfil): ${fmt(wGravDownKJ)}\n` +
    `  ────────────────────────────────────\n` +
    `  Energia nas pernas:                                       ${fmt(totalKJ)} kJ\n` +
    (routedSegs > 0
      ? `\n` +
        `Energia da rota (objetivo do roteador): ${routedPartial ? '≥' : ''}${fmt(routedKJ)} kJ` +
        `${routedPartial ? ` — só ${routedSegs} de ${totalSegs} segmento(s) roteado(s) por energia` : ''}\n` +
        `  Soma dos custos de aresta v2 que o Dijkstra minimizou (grade σ30-tratada /\n` +
        `  grafo do viário). Difere da estimativa acima por fonte de elevação e\n` +
        `  discretização — a estimativa re-precifica o traçado pela receita route-level.\n` : '') +
    `\n` +
    `Modelo v2 (bicycling-energy-model). Energia metabólica ≈ ${params.bikeMetabolicFactor}× isto (eficiência humana ~25%).` +
    (params.suvCompareEnabled
      ? `\n\n` +
        `Comparação com um SUV (mesma rota, modelo v2 por segmento com m=${params.carMass} kg, ` +
        `Crr=${params.carCrr}, CdA=${params.carCda} m², k_ef=${carKEffPct}%, sem recuperação na ` +
        `descida (ε=${(params.carEpsilon * 100).toFixed(0)}%) e arrasto em 100% da distância mesmo ` +
        `subindo (f=1)):\n` +
        `  Potência/velocidade de equilíbrio (limiar ±${(params.carSlopeFlatThreshold * 100).toFixed(1).replace('.', ',')}%):\n` +
        `    Subida (${params.carPowerAscent} W):  ${fmt(carVAscentKmh)} km/h\n` +
        `    Plano  (${params.carPowerFlat} W):  ${fmt(carVFlatKmh)} km/h\n` +
        `    Descida (${params.carPowerDescent} W): ${fmt(carVDescentKmh)} km/h\n` +
        `  Energia do SUV (combustível):                             ${fmt(carKJ / 1000, 1)} MJ\n` +
        `  Gasolina (${GASOLINE_KJ_PER_LITER.toLocaleString('pt-BR')} kJ/L):                            ${fmt(carLiters, 2)} L\n` +
        `  Bike (metabólica, ${params.bikeMetabolicFactor}× a mecânica, eficiência humana ~25%): ${fmt(bikeMetabolicKJ)} kJ\n` +
        `  SUV usa ${fmt(bikeVsCarRatio, 0)}× mais energia que a bike (combustível vs. energia metabólica)`
      : '') +
    (sim.elevMissing > 0 ? `\n\n${sim.elevMissing} ponto(s) ainda sem elevação.` : '');
}

// formatHMS() now imported from lib/utils.js

// ─── Params modal ────────────────────────────────────────────────────────────
const paramsBtn = document.getElementById('params-btn');
const paramsModal = document.getElementById('params-modal');
const paramsClose = document.getElementById('params-close');
const paramsReset = document.getElementById('params-reset');
const PARAM_INPUTS = {
  mass:               document.getElementById('param-mass'),
  crr:                document.getElementById('param-crr'),
  cda:                document.getElementById('param-cda'),
  rho:                document.getElementById('param-rho'),
  powerAscent:        document.getElementById('param-power-ascent'),
  powerFlat:          document.getElementById('param-power-flat'),
  powerDescent:       document.getElementById('param-power-descent'),
  epsilon:            document.getElementById('param-epsilon'),
  efficiency:         document.getElementById('param-efficiency'),
  slopeFlatThreshold: document.getElementById('param-slope-threshold'),
  kEff:               document.getElementById('param-keff'),
  deadbandM:          document.getElementById('param-deadband'),
  // FABDEM + energy-routing
  energySearchMarginPct: document.getElementById('param-energy-margin'),
  // Comparação com carro (SUV)
  carMass:            document.getElementById('param-car-mass'),
  carCrr:             document.getElementById('param-car-crr'),
  carCda:             document.getElementById('param-car-cda'),
  carKEff:            document.getElementById('param-car-keff'),
  carEpsilon:         document.getElementById('param-car-epsilon'),
  carPowerAscent:     document.getElementById('param-car-power-ascent'),
  carPowerFlat:       document.getElementById('param-car-power-flat'),
  carPowerDescent:    document.getElementById('param-car-power-descent'),
  carSlopeFlatThreshold: document.getElementById('param-car-slope-threshold'),
  bikeMetabolicFactor: document.getElementById('param-bike-metabolic-factor'),
};
const PARAM_CHECKBOXES = {
  useFabdem: document.getElementById('param-use-fabdem'),
  useSampaDem: document.getElementById('param-use-sampa-dem'),
  useViarioGpkg: document.getElementById('param-use-viario-gpkg'),
  useWaterMask: document.getElementById('param-use-water-mask'),
  usePortals: document.getElementById('param-use-portals'),
  suvCompareEnabled: document.getElementById('param-suv-compare-enabled'),
};
// Leitura (read-only) dos coeficientes de custo v2 derivados (kJ/m): α_r = custo
// horizontal de rolamento (m·g·Crr/k_ef); α_a = custo horizontal de arrasto no
// plano (½ρCdA·v_f²/k_ef, só fora das subidas); β = custo de subida (m·g/k_ef).
// É o que o roteamento por energia usa por aresta. Atualiza ao abrir o modal e a
// cada mudança de parâmetro.
const alpharReadout = document.getElementById('param-alphar-readout');
const alphaaReadout = document.getElementById('param-alphaa-readout');
const betaReadout   = document.getElementById('param-beta-readout');
function updateCostReadout() {
  const c = readCost(params);
  const fmt4 = (n) => n.toFixed(4).replace('.', ',');
  if (alpharReadout) alpharReadout.textContent = fmt4(c.aRoll / 1000);
  if (alphaaReadout) alphaaReadout.textContent = fmt4(c.aAero / 1000);
  if (betaReadout)   betaReadout.textContent   = fmt4(c.beta / 1000);
}

paramsBtn.addEventListener('click', () => {
  fillParamInputs();
  paramsModal.hidden = false;
});
paramsClose.addEventListener('click', () => (paramsModal.hidden = true));
paramsModal.addEventListener('click', (e) => {
  if (e.target === paramsModal) paramsModal.hidden = true;
});
paramsReset.addEventListener('click', () => {
  params = { ...DEFAULT_PARAMS };
  saveParams();
  fillParamInputs();
  updateMetrics();
});
for (const [key, input] of Object.entries(PARAM_INPUTS)) {
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v)) return;
    params[key] = PCT_PARAMS.has(key) ? Math.max(0, Math.min(1, v / 100)) : v;
    saveParams();
    updateMetrics();
    updateCostReadout();
  });
}
// Direções de movimento da grade: select próprio (fora do loop genérico de
// PARAM_INPUTS) porque mudar a vizinhança muda a GEOMETRIA roteada — precisa
// re-rotear o rascunho, como os toggles de viário/água.
const paramNDirs = document.getElementById('param-n-dirs');
paramNDirs.addEventListener('change', () => {
  const v = parseInt(paramNDirs.value, 10);
  if (![4, 8, 16, 32, 64, 128].includes(v)) return;
  params.nDirs = v;
  saveParams();
  updateMetrics();
  rerouteCurrentDraft();
});
// Tratamento σ do mapa: select próprio pelo mesmo motivo do nDirs — mudar a
// suavização do mosaico muda a geometria roteada, então re-roteia o rascunho.
const paramDemSmooth = document.getElementById('param-dem-smooth');
paramDemSmooth.addEventListener('change', () => {
  const v = parseFloat(paramDemSmooth.value);
  if (![0, 10, 20, 30].includes(v)) return;
  params.demSmoothSigmaM = v;
  saveParams();
  updateMetrics();
  rerouteCurrentDraft();
});

for (const [key, input] of Object.entries(PARAM_CHECKBOXES)) {
  input.addEventListener('change', () => {
    params[key] = !!input.checked;
    saveParams();
    if (key === 'useFabdem' || key === 'useSampaDem') {
      // Fonte de elevação: limpa o cache (senão os valores antigos persistiam e
      // o toggle não tinha efeito), reamostra e — no modo energia — re-roteia.
      recomputeAfterDemChange();
    } else if (key === 'suvCompareEnabled') {
      // Só liga/desliga um display — não afeta a geometria roteada.
      updateMetrics();
    } else {
      // Viário / máscara d'água / portais: afetam só a geometria roteada.
      updateMetrics();
      rerouteCurrentDraft();
    }
  });
}

function fillParamInputs() {
  PARAM_INPUTS.mass.value = params.mass;
  PARAM_INPUTS.crr.value = params.crr;
  PARAM_INPUTS.cda.value = params.cda;
  PARAM_INPUTS.rho.value = params.rho;
  PARAM_INPUTS.powerAscent.value = params.powerAscent;
  PARAM_INPUTS.powerFlat.value = params.powerFlat;
  PARAM_INPUTS.powerDescent.value = params.powerDescent;
  PARAM_INPUTS.epsilon.value = (params.epsilon * 100).toFixed(0);
  PARAM_INPUTS.efficiency.value = (params.efficiency * 100).toFixed(0);
  PARAM_INPUTS.slopeFlatThreshold.value = (params.slopeFlatThreshold * 100).toFixed(1);
  PARAM_INPUTS.kEff.value = (params.kEff * 100).toFixed(0);
  PARAM_INPUTS.deadbandM.value = params.deadbandM;
  PARAM_INPUTS.energySearchMarginPct.value = params.energySearchMarginPct;
  paramNDirs.value = String([4, 8, 16, 32, 64, 128].includes(params.nDirs | 0) ? params.nDirs : 16);
  paramDemSmooth.value = String([0, 10, 20, 30].includes(+params.demSmoothSigmaM) ? +params.demSmoothSigmaM : 30);
  PARAM_INPUTS.carMass.value = params.carMass;
  PARAM_INPUTS.carCrr.value = params.carCrr;
  PARAM_INPUTS.carCda.value = params.carCda;
  PARAM_INPUTS.carKEff.value = (params.carKEff * 100).toFixed(0);
  PARAM_INPUTS.carEpsilon.value = (params.carEpsilon * 100).toFixed(0);
  PARAM_INPUTS.carPowerAscent.value = params.carPowerAscent;
  PARAM_INPUTS.carPowerFlat.value = params.carPowerFlat;
  PARAM_INPUTS.carPowerDescent.value = params.carPowerDescent;
  PARAM_INPUTS.carSlopeFlatThreshold.value = (params.carSlopeFlatThreshold * 100).toFixed(1);
  PARAM_INPUTS.bikeMetabolicFactor.value = params.bikeMetabolicFactor;
  PARAM_CHECKBOXES.useFabdem.checked       = params.useFabdem !== false;
  PARAM_CHECKBOXES.useSampaDem.checked     = !!params.useSampaDem;
  PARAM_CHECKBOXES.useViarioGpkg.checked   = params.useViarioGpkg !== false;
  PARAM_CHECKBOXES.useWaterMask.checked    = params.useWaterMask !== false;
  PARAM_CHECKBOXES.usePortals.checked      = params.usePortals !== false;
  PARAM_CHECKBOXES.suvCompareEnabled.checked = params.suvCompareEnabled !== false;
  updateCostReadout();
}

// ─── Modal "Fontes de dados" (DEM + rede viária) ─────────────────────────────
// Aberto pelo botão na seção de elevação dos Parâmetros. Hospeda os 3 toggles de
// fonte (FABDEM / DEM de SP / FGB do viário — mesmos IDs, já ligados via
// PARAM_CHECKBOXES) + carregar/limpar DEM custom e rede viária custom. Os
// arquivos custom ficam só em memória (efêmeros) e têm prioridade sobre os
// built-ins na amostragem de elevação e no roteamento por energia.
const dsModal        = document.getElementById('datasources-modal');
const dsOpenBtn      = document.getElementById('open-datasources');
const dsCloseBtn     = document.getElementById('datasources-close');
const customDemFile  = document.getElementById('custom-dem-file');
const customDemLoad  = document.getElementById('custom-dem-load');
const customDemClear = document.getElementById('custom-dem-clear');
const customDemStatus= document.getElementById('custom-dem-status');
const customNetFile  = document.getElementById('custom-net-file');
const customNetLoad  = document.getElementById('custom-net-load');
const customNetClear = document.getElementById('custom-net-clear');
const customNetStatus= document.getElementById('custom-net-status');

function setDsStatus(el, clearBtn, name, emptyLabel) {
  if (!el) return;
  el.textContent = name || emptyLabel;
  el.title = name || '';
  el.classList.toggle('is-set', !!name);
  if (clearBtn) clearBtn.hidden = !name;
}
function refreshDataSourceStatus() {
  setDsStatus(customDemStatus, customDemClear, _customDem ? _customDem.name : '', 'nenhum');
  setDsStatus(customNetStatus, customNetClear, _customNetwork ? _customNetwork.name : '', 'nenhuma');
}
function fillDataSourceInputs() {
  PARAM_CHECKBOXES.useFabdem.checked     = params.useFabdem !== false;
  PARAM_CHECKBOXES.useSampaDem.checked   = !!params.useSampaDem;
  PARAM_CHECKBOXES.useViarioGpkg.checked = params.useViarioGpkg !== false;
  refreshDataSourceStatus();
}
// Re-roteia TODOS os segmentos do rascunho atual com o modo/fontes vigentes.
// Chamado quando algo que afeta a GEOMETRIA roteada muda: o seletor de modo, a
// rede viária custom, ou os toggles de viário/DEM (no modo energia) — antes
// essas mudanças só valiam pros próximos waypoints, então uma rota já carregada
// ignorava as fontes. Sem efeito fora do desenho ou em 'straight' (reta não
// roteia). Acima do limiar pede confirmação (re-rotear centenas de trechos por
// energia é pesado); se recusar e `revertModeTo` veio (troca de seletor), volta
// o modo anterior.
const REROUTE_CONFIRM_THRESHOLD = 150;
async function rerouteCurrentDraft(revertModeTo) {
  if (!drawingMode || routingMode === 'straight' || trackpoints.length < 2) return;
  const indices = [];
  for (let i = 1; i < trackpoints.length; i++) indices.push(i);
  if (indices.length > REROUTE_CONFIRM_THRESHOLD &&
      !confirm(`Isto vai rotear ${indices.length} trechos pelo modo selecionado e pode demorar bastante. Continuar?`)) {
    if (revertModeTo !== undefined) {
      routingMode = revertModeTo;
      traceRoutingMode.value = revertModeTo;
    }
    return;
  }
  const routeSeq = ++pendingRouteSeq;
  showToast(`Re-roteando ${indices.length} trecho(s)…`, 2500);
  await mapConcurrent(indices, 4, (idx) => refetchPath(idx, routeSeq));
  redrawAndMetrics();
  scheduleTraceDraftSave();
}

// Trocar a fonte de elevação exige limpar o cache (senão valores já amostrados
// de outra fonte permaneceriam) e reagendar o fetch — que recalcula o perfil e
// as métricas. No modo energia o DEM também muda a geometria roteada, então
// re-roteia o rascunho.
function recomputeAfterDemChange() {
  elevationCache.clear();
  scheduleElevationFetch();
  rerouteCurrentDraft();
}
if (dsModal && dsOpenBtn) {
  dsOpenBtn.addEventListener('click', () => { fillDataSourceInputs(); dsModal.hidden = false; });
  dsCloseBtn?.addEventListener('click', () => { dsModal.hidden = true; });
  dsModal.addEventListener('click', (e) => { if (e.target === dsModal) dsModal.hidden = true; });

  customDemLoad?.addEventListener('click', () => customDemFile?.click());
  customDemFile?.addEventListener('change', async () => {
    const file = customDemFile.files && customDemFile.files[0];
    customDemFile.value = '';
    if (!file) return;
    try {
      showToast(`Carregando DEM ${file.name}…`);
      const h = await setCustomDem(file);
      refreshDataSourceStatus();
      if (h.projected) showToast('Atenção: o DEM parece projetado (não-4326) — a elevação pode sair errada.', 4500);
      else showToast(`DEM custom ativo: ${file.name}`);
      recomputeAfterDemChange();
    } catch (err) {
      console.warn('[custom-dem] falhou:', err);
      showToast(`Falha ao ler o DEM: ${err.message}`);
    }
  });
  customDemClear?.addEventListener('click', () => {
    clearCustomDem();
    refreshDataSourceStatus();
    showToast('DEM custom removido.');
    recomputeAfterDemChange();
  });

  customNetLoad?.addEventListener('click', () => customNetFile?.click());
  customNetFile?.addEventListener('change', async () => {
    const file = customNetFile.files && customNetFile.files[0];
    customNetFile.value = '';
    if (!file) return;
    try {
      showToast(`Carregando rede ${file.name}…`);
      await setCustomNetwork(file);
      refreshDataSourceStatus();
      // A rede custom só é consultada no modo "Menor energia pelo viário". Se já
      // estiver nesse modo com um rascunho, re-roteia na hora; senão orienta.
      if (routingMode === 'energy_road' && drawingMode) {
        showToast(`Rede viária custom ativa: ${file.name}.`, 3000);
        rerouteCurrentDraft();
      } else {
        showToast(`Rede viária custom ativa: ${file.name}. Use o modo "Menor energia pelo viário" para roteá-la.`, 5000);
      }
    } catch (err) {
      console.warn('[custom-net] falhou:', err);
      showToast(`Falha ao ler a rede: ${err.message}`);
    }
  });
  customNetClear?.addEventListener('click', () => {
    clearCustomNetwork();
    refreshDataSourceStatus();
    showToast('Rede viária custom removida.');
    if (routingMode === 'energy_road') rerouteCurrentDraft();
  });
}

// ─── Modal "Comparação com carro (SUV)" ──────────────────────────────────────
// Aberto pelo botão na seção "Comparação com carro (SUV)" dos Parâmetros. Os
// campos são os mesmos PARAM_INPUTS/PARAM_CHECKBOXES do modal principal — só
// hospedados aqui pra não lotar o modal de Parâmetros — então persistem e
// recalculam a métrica pela MESMA fiação genérica (loops acima), sem código
// extra de leitura/escrita.
const suvCompareModal    = document.getElementById('suv-compare-modal');
const suvCompareOpenBtn  = document.getElementById('open-suv-compare');
const suvCompareCloseBtn = document.getElementById('suv-compare-close');
if (suvCompareModal && suvCompareOpenBtn) {
  suvCompareOpenBtn.addEventListener('click', () => { fillParamInputs(); suvCompareModal.hidden = false; });
  suvCompareCloseBtn?.addEventListener('click', () => { suvCompareModal.hidden = true; });
  suvCompareModal.addEventListener('click', (e) => { if (e.target === suvCompareModal) suvCompareModal.hidden = true; });
}

// ─── Modal da Câmera Topográfica (engrenagem na camada) ──────────────────────
const ctopoModal    = document.getElementById('camera-topo-modal');
const ctopoMinElev  = document.getElementById('ctopo-min-elev');
const ctopoMaxElev  = document.getElementById('ctopo-max-elev');
const ctopoMaxSlope = document.getElementById('ctopo-max-slope');   // em %
const ctopoGamma    = document.getElementById('ctopo-gamma');
const ctopoCycles   = document.getElementById('ctopo-cycles');

function fillCameraTopoInputs() {
  const c = settings.cameraTopo;
  ctopoMinElev.value  = c.minElev  != null ? c.minElev : '';
  ctopoMaxElev.value  = c.maxElev  != null ? c.maxElev : '';
  ctopoMaxSlope.value = c.maxSlope != null ? +(c.maxSlope * 100).toFixed(1) : '';
  ctopoGamma.value    = c.slopeGamma ?? 1.2;
  ctopoCycles.value   = c.cycles ?? 1;
}
function openCameraTopoModal() {
  fillCameraTopoInputs();
  ctopoModal.hidden = false;
}
function closeCameraTopoModal() { ctopoModal.hidden = true; }

function ctopoReadNum(input) {
  const v = input.value.trim();
  if (v === '') return null;
  const n = parseFloat(v.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
function applyCameraTopoInputs() {
  const c = settings.cameraTopo;
  c.minElev = ctopoReadNum(ctopoMinElev);
  c.maxElev = ctopoReadNum(ctopoMaxElev);
  const sl = ctopoReadNum(ctopoMaxSlope);
  c.maxSlope = sl != null ? sl / 100 : null;   // % → m/m
  const g = ctopoReadNum(ctopoGamma);
  c.slopeGamma = g != null && g > 0 ? g : 1.2;
  const cyc = ctopoReadNum(ctopoCycles);
  c.cycles = cyc != null && cyc >= 1 ? Math.min(16, Math.round(cyc)) : 1;
  saveSettings();
  refreshCameraTopo();
}
if (ctopoModal) {
  for (const el of [ctopoMinElev, ctopoMaxElev, ctopoMaxSlope, ctopoGamma, ctopoCycles]) {
    el.addEventListener('input', applyCameraTopoInputs);
  }
  document.getElementById('ctopo-close')?.addEventListener('click', closeCameraTopoModal);
  ctopoModal.addEventListener('click', (e) => { if (e.target === ctopoModal) closeCameraTopoModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !ctopoModal.hidden) closeCameraTopoModal();
  });
  document.getElementById('ctopo-reset')?.addEventListener('click', () => {
    const d = SETTINGS_DEFAULTS.cameraTopo;
    Object.assign(settings.cameraTopo, {
      minElev: d.minElev, maxElev: d.maxElev, maxSlope: d.maxSlope,
      slopeGamma: d.slopeGamma, cycles: d.cycles,
    });
    saveSettings();
    fillCameraTopoInputs();
    refreshCameraTopo();
  });
  document.getElementById('ctopo-estimate')?.addEventListener('click', async () => {
    const btn = document.getElementById('ctopo-estimate');
    if (map.getZoom() < CAMERA_TOPO_MIN_ZOOM) {
      showToast(`Aproxime o mapa (zoom ≥ ${CAMERA_TOPO_MIN_ZOOM}) para estimar`);
      return;
    }
    const prev = btn.textContent;
    btn.disabled = true; btn.textContent = 'Estimando…';
    try {
      const frame = await buildCameraTopoFrame();
      if (frame && frame.pct) {
        const c = settings.cameraTopo;
        c.minElev  = Math.round(frame.pct.elevP5);
        c.maxElev  = Math.round(frame.pct.elevP80);
        c.maxSlope = frame.pct.slopeP80;
        saveSettings();
        fillCameraTopoInputs();
        refreshCameraTopo();
      } else {
        showToast('Sem dados de elevação na extensão atual.');
      }
    } catch (e) {
      showToast('Falha ao estimar: ' + e.message);
    } finally {
      btn.disabled = false; btn.textContent = prev;
    }
  });
}

// ─── Params serialization (JSON-LD with QUDT + schema.org) ───────────────────
// Each parameter is exported as a qudt:Quantity node with a quantityKind and
// unit IRI from the QUDT vocabulary. This makes the file genuine RDF (any
// JSON-LD processor will turn it into RDF triples) while staying valid JSON
// — so old plain-JSON files still load via the same import path.
//
// References:
//   QUDT      https://qudt.org/  (Quantities, Units, Dimensions, and Types)
//   JSON-LD   https://www.w3.org/TR/json-ld11/
//   schema.org for the surrounding provenance metadata.
const QUDT_PROFILE = {
  mass:               { iri: 'totalMass',                      kind: 'kind:Mass',                 unit: 'unit:KiloGM' },
  crr:                { iri: 'rollingResistanceCoefficient',   kind: 'kind:DimensionlessRatio',   unit: 'unit:UNITLESS' },
  cda:                { iri: 'dragArea',                       kind: 'kind:Area',                 unit: 'unit:M2' },
  rho:                { iri: 'airDensity',                     kind: 'kind:MassDensity',          unit: 'unit:KiloGM-PER-M3' },
  powerAscent:        { iri: 'powerAscent',                    kind: 'kind:Power',                unit: 'unit:W' },
  powerFlat:          { iri: 'powerFlat',                      kind: 'kind:Power',                unit: 'unit:W' },
  powerDescent:       { iri: 'powerDescent',                   kind: 'kind:Power',                unit: 'unit:W' },
  epsilon:            { iri: 'descentEnergyRecoveryFraction',  kind: 'kind:DimensionlessRatio',   unit: 'unit:UNITLESS' },
  efficiency:         { iri: 'movingEfficiency',               kind: 'kind:DimensionlessRatio',   unit: 'unit:UNITLESS' },
  slopeFlatThreshold: { iri: 'slopeFlatThreshold',             kind: 'kind:DimensionlessRatio',   unit: 'unit:UNITLESS' },
  kEff:               { iri: 'transmissionEfficiency',         kind: 'kind:DimensionlessRatio',   unit: 'unit:UNITLESS' },
  deadbandM:          { iri: 'elevationDeadband',               kind: 'kind:Length',                unit: 'unit:M' },
  demSmoothSigmaM:    { iri: 'demSmoothingSigma',               kind: 'kind:Length',                unit: 'unit:M' },
  energySearchMarginPct: { iri: 'energySearchMargin',           kind: 'kind:DimensionlessRatio',   unit: 'unit:PERCENT' },
  // Comparação com carro (SUV)
  carMass:            { iri: 'carTotalMass',                    kind: 'kind:Mass',                 unit: 'unit:KiloGM' },
  carCrr:             { iri: 'carRollingResistanceCoefficient',  kind: 'kind:DimensionlessRatio',   unit: 'unit:UNITLESS' },
  carCda:             { iri: 'carDragArea',                      kind: 'kind:Area',                 unit: 'unit:M2' },
  carKEff:            { iri: 'carEngineEfficiency',              kind: 'kind:DimensionlessRatio',   unit: 'unit:UNITLESS' },
  carEpsilon:         { iri: 'carDescentEnergyRecoveryFraction', kind: 'kind:DimensionlessRatio',   unit: 'unit:UNITLESS' },
  carPowerAscent:     { iri: 'carPowerAscent',                   kind: 'kind:Power',                unit: 'unit:W' },
  carPowerFlat:       { iri: 'carPowerFlat',                     kind: 'kind:Power',                unit: 'unit:W' },
  carPowerDescent:    { iri: 'carPowerDescent',                  kind: 'kind:Power',                unit: 'unit:W' },
  carSlopeFlatThreshold: { iri: 'carSlopeFlatThreshold',         kind: 'kind:DimensionlessRatio',   unit: 'unit:UNITLESS' },
  bikeMetabolicFactor:{ iri: 'bikeMetabolicFactor',              kind: 'kind:DimensionlessRatio',   unit: 'unit:UNITLESS' },
};

function paramsToJsonLd(p) {
  const doc = {
    '@context': {
      '@vocab':       'https://pedalhidrografi.co/vocab/sim#',
      qudt:           'http://qudt.org/schema/qudt/',
      unit:           'http://qudt.org/vocab/unit/',
      kind:           'http://qudt.org/vocab/quantitykind/',
      schema:         'https://schema.org/',
      xsd:            'http://www.w3.org/2001/XMLSchema#',
      Quantity:       'qudt:Quantity',
      value:          { '@id': 'qudt:value',             '@type': 'xsd:double' },
      // Termo pro predicado qudt:unit — NÃO chamar de `unit` de novo: colidiria
      // com o prefixo `unit:` acima (chaves de objeto duplicadas em JS ficam
      // com a última — o prefixo sumiria do contexto emitido e todo valor
      // `unit:*` (ex. `unit:W`) deixaria de resolver como IRI compacta).
      qudtUnit:       { '@id': 'qudt:unit',              '@type': '@id' },
      quantityKind:   { '@id': 'qudt:hasQuantityKind',   '@type': '@id' },
    },
    '@type': 'CyclingSimulationParameters',
    'schema:dateCreated': new Date().toISOString(),
    'schema:creator': 'Cláudio · ajudante bicigeoenergético sampa',
  };
  for (const [key, prof] of Object.entries(QUDT_PROFILE)) {
    doc[prof.iri] = {
      '@type': 'Quantity',
      quantityKind: prof.kind,
      qudtUnit: prof.unit,
      value: p[key],
    };
  }
  return doc;
}

// Accept either a JSON-LD doc (detected by `@context`) or our older plain JSON.
function paramsFromAnyJson(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('JSON inválido');
  const out = { ...DEFAULT_PARAMS };
  if (obj['@context']) {
    for (const [key, prof] of Object.entries(QUDT_PROFILE)) {
      const node = obj[prof.iri];
      if (node && typeof node === 'object' && Number.isFinite(node.value)) {
        out[key] = node.value;
      }
    }
    return out;
  }
  // JSON simples (formato antigo): aceita só chaves conhecidas com número
  // finito. O spread cru `{...obj}` deixava string/NaN escorrer pro
  // energyRoute e pro worker de energia.
  for (const key of Object.keys(DEFAULT_PARAMS)) {
    if (Number.isFinite(obj[key])) out[key] = obj[key];
  }
  return out;
}

const paramsExport = document.getElementById('params-export');
const paramsLoad = document.getElementById('params-load');
const paramsImport = document.getElementById('params-import');

paramsExport.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(paramsToJsonLd(params), null, 2)], {
    type: 'application/ld+json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `parametros-${new Date().toISOString().slice(0, 10)}.jsonld`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

paramsLoad.addEventListener('click', () => paramsImport.click());

paramsImport.addEventListener('change', () => {
  const file = paramsImport.files?.[0];
  paramsImport.value = ''; // allow re-loading the same file
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      params = paramsFromAnyJson(JSON.parse(reader.result));
      saveParams();
      fillParamInputs();
      updateMetrics();
    } catch (err) {
      alert(`Não foi possível carregar os parâmetros: ${err.message}`);
    }
  };
  reader.onerror = () => alert('Não foi possível ler o arquivo de parâmetros.');
  reader.readAsText(file);
});


function snapshot() {
  return trackpoints.map((t) => ({
    lat: t.marker.getLatLng().lat,
    lng: t.marker.getLatLng().lng,
    // Clone the path so future mutations don't bleed into history.
    path: t.pathFromPrev ? t.pathFromPrev.map((p) => [p[0], p[1]]) : null,
    // deckFlag marca trechos de ponte/túnel (viarioGraphRoute) p/ o flattening
    // de elevação — precisa sobreviver ao undo/redo (não é reconstruído).
    deckFlag: t.pathFromPrev?.deckFlag ? [...t.pathFromPrev.deckFlag] : null,
    // Objetivo do roteador do segmento (J) — idem: capturado no roteamento,
    // não é reconstruível depois.
    routedEnergyJ: Number.isFinite(t.pathFromPrev?.routedEnergyJ) ? t.pathFromPrev.routedEnergyJ : null,
    // Modo de roteamento que produziu a geometria deste segmento
    // (proveniência; ver refetchPath) — sobrevive a undo/rascunho/GPX.
    mode: t.pathFromPrev?.mode || null,
    name: t.name || '',
    isPoi: !!t.isPoi,
    sym: t.sym || 'Flag, Blue',
  }));
}

function pushHistory() {
  drawHistory = drawHistory.slice(0, historyIndex + 1);
  drawHistory.push(snapshot());
  historyIndex = drawHistory.length - 1;
  updateTraceControls();
  scheduleTraceDraftSave();
}

function undo() {
  if (historyIndex <= 0) return;
  historyIndex--;
  restoreSnapshot(drawHistory[historyIndex]);
}

function redo() {
  if (historyIndex >= drawHistory.length - 1) return;
  historyIndex++;
  restoreSnapshot(drawHistory[historyIndex]);
}

// Inverte o SENTIDO da rota: a ordem dos trackpoints vira ao contrário e cada
// geometria de segmento em cache é revertida (com o deckFlag junto, ponto a
// ponto). Instantâneo e offline — NÃO re-roteia: é a MESMA linha percorrida
// ao contrário (num modo OSRM ela pode passar na contramão de uma via de mão
// única; re-rotear é só trocar o modo de roteamento, que já re-roteia tudo).
// As métricas/energia recalculam sozinhas pro novo sentido (redrawAndMetrics
// lê a geometria montada na ordem de percurso).
function reverseTraceDirection() {
  if (trackpoints.length < 2 || previewMode) return;
  pendingRouteSeq++; // invalida re-roteamentos OSRM em voo (indexam a ordem antiga)
  const old = trackpoints;
  const n = old.length;
  const reversed = old.slice().reverse();
  // Calcula todos os caminhos novos ANTES de atribuir — old/reversed
  // compartilham os mesmos objetos trackpoint.
  // old[i].pathFromPrev cobre old[i-1]→old[i]; o elemento na posição nova j
  // é old[n-1-j], cujo anterior novo é old[n-j] — o caminho entre eles é o
  // pathFromPrev de old[n-j], revertido.
  const newPaths = reversed.map((tp, j) => {
    if (j === 0) return null;
    const src = old[n - j].pathFromPrev;
    if (!src) {
      return straightPath(reversed[j - 1].marker.getLatLng(), tp.marker.getLatLng());
    }
    const path = src.map((p) => [p[0], p[1]]).reverse();
    if (src.deckFlag) path.deckFlag = [...src.deckFlag].reverse();
    // routedEnergyJ NÃO é copiado de propósito: o custo v2 é assimétrico
    // (subida ≠ descida), então o objetivo do sentido inverso é outro número
    // que só um re-roteamento produziria.
    return path;
  });
  reversed.forEach((tp, j) => { tp.pathFromPrev = newPaths[j]; });
  trackpoints = reversed;
  redrawAndMetrics();
  updateTraceControls();
  pushHistory();
}

function restoreSnapshot(snap) {
  for (const t of trackpoints) map.removeLayer(t.marker);
  trackpoints = [];
  pendingRouteSeq++; // invalidate any in-flight OSRM calls
  for (const s of snap) {
    const tp = createTrackpoint(L.latLng(s.lat, s.lng), {
      name: s.name || '',
      isPoi: !!s.isPoi,
      sym: s.sym || 'Flag, Blue',
    });
    tp.pathFromPrev = s.path ? s.path.map((p) => [p[0], p[1]]) : null;
    if (s.deckFlag && tp.pathFromPrev) tp.pathFromPrev.deckFlag = s.deckFlag;
    if (Number.isFinite(s.routedEnergyJ) && tp.pathFromPrev) tp.pathFromPrev.routedEnergyJ = s.routedEnergyJ;
    if (s.mode && tp.pathFromPrev) tp.pathFromPrev.mode = s.mode;
    trackpoints.push(tp);
  }
  redrawAndMetrics();
  updateTraceControls();
  scheduleTraceDraftSave();
}

function updateTraceControls() {
  traceUndo.disabled = historyIndex <= 0;
  traceRedo.disabled = historyIndex >= drawHistory.length - 1;
  if (traceTrash) traceTrash.disabled = trackpoints.length === 0;
  if (traceReverse) traceReverse.disabled = trackpoints.length < 2;
  if (traceCount) {
    const n = trackpoints.length;
    traceCount.textContent = `${n} ponto${n === 1 ? '' : 's'}`;
  }
}

// ─── Rascunho persistente do traçado (localStorage) ─────────────────────────
// O traçado em edição sobrevive a fechar o navegador/aba: cada mutação agenda
// uma gravação (debounced — serializar uma rota longa a cada tecla sairia
// caro) e o botão Traçar restaura o rascunho ao entrar. Cancelar/Esc só
// fecham o editor; o descarte de verdade é o 🗑 (discardTrace). O formato
// espelha snapshot() (geometria roteada, deckFlag, energia e modo por
// segmento inclusos), mais o modo global, o nome e o vínculo com a rota
// salva no servidor.
const TRACE_DRAFT_KEY = 'phidro:traceDraft:v1';
let _traceDraftTimer = null;

function scheduleTraceDraftSave() {
  if (_traceDraftTimer) clearTimeout(_traceDraftTimer);
  _traceDraftTimer = setTimeout(saveTraceDraft, 400);
}

function saveTraceDraft() {
  _traceDraftTimer = null;
  try {
    if (!trackpoints.length) { localStorage.removeItem(TRACE_DRAFT_KEY); return; }
    localStorage.setItem(TRACE_DRAFT_KEY, JSON.stringify({
      v: 1,
      rm: routingMode,
      n: defaultSaveName || '',
      sid: currentSavedRouteId || null,
      wp: snapshot(),
    }));
  } catch (err) {
    // Quota cheia (rota gigante) ou storage indisponível — segue sem persistir.
    console.warn('[draft] não persistiu:', err.message);
  }
}

function clearTraceDraft() {
  if (_traceDraftTimer) { clearTimeout(_traceDraftTimer); _traceDraftTimer = null; }
  try { localStorage.removeItem(TRACE_DRAFT_KEY); } catch {}
}

// Restaura o rascunho persistido (se houver) na sessão de desenho recém-
// aberta pelo botão Traçar. Retorna true se restaurou. Os DEMAIS caminhos de
// entrada (carregar GPX/rota salva/link) NÃO restauram — eles trazem a
// própria rota, que vira o novo rascunho no pushHistory deles.
function restoreTraceDraft() {
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(TRACE_DRAFT_KEY) || 'null'); } catch {}
  if (!draft || !Array.isArray(draft.wp)) return false;
  const wp = draft.wp.filter((s) => s && Number.isFinite(s.lat) && Number.isFinite(s.lng));
  if (!wp.length) return false;
  if (draft.rm && ['straight', 'cycling', 'foot', 'energy', 'energy_road'].includes(draft.rm)) {
    routingMode = draft.rm;
    traceRoutingMode.value = draft.rm;
  }
  restoreSnapshot(wp);
  defaultSaveName = draft.n || '';
  currentSavedRouteId = draft.sid || null;
  pushHistory();   // baseline do undo: [vazio, rascunho] — desfazer limpa a tela
  const bounds = L.latLngBounds(trackpoints.map((t) => t.marker.getLatLng()));
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] });
  showToast(`Rascunho restaurado · ${trackpoints.length} pontos`);
  return true;
}

// 🗑 Descartar: joga fora o traçado atual E o rascunho persistido — o único
// caminho que apaga de verdade. Continua no modo de desenho, com tela limpa.
function discardTrace() {
  if (!trackpoints.length || previewMode) return;
  if (!confirm('Descartar o traçado atual? Isso apaga o rascunho guardado neste navegador (rotas salvas no servidor não são afetadas).')) return;
  clearTraceDraft();
  pendingRouteSeq++;   // invalida roteamentos em voo do traçado descartado
  for (const t of trackpoints) map.removeLayer(t.marker);
  trackpoints = [];
  drawHistory = [[]];
  historyIndex = 0;
  defaultSaveName = '';
  currentSavedRouteId = null;
  redrawAndMetrics();
  updateTraceControls();
  showToast('Traçado descartado.');
}

// Opens the save-name modal; the modal's confirm button does the actual save.
function saveAndExit() {
  if (trackpoints.length < 2) {
    alert('Adicione pelo menos 2 pontos antes de salvar o GPX.');
    return;
  }
  openSaveModal();
}

function performSave(name) {
  const latlngs = assembleLatLngs().map((ll) => [ll.lat, ll.lng]);
  const pois = trackpoints
    .filter((t) => t.isPoi)
    .map((t) => {
      const ll = t.marker.getLatLng();
      return {
        lat: ll.lat,
        lon: ll.lng,
        name: t.name || 'POI',
        sym: t.sym || 'Flag, Blue',
      };
    });
  // Snapshot of the user's editable waypoints (lat/lng + name/POI/sym),
  // independent from the routed track. Embedded in extensions so re-editing
  // round-trips cleanly without inflating the visible marker count.
  const userWaypoints = trackpoints.map((t) => {
    const ll = t.marker.getLatLng();
    return {
      lat: ll.lat,
      lng: ll.lng,
      name: t.name || '',
      isPoi: !!t.isPoi,
      sym: t.sym || 'Flag, Blue',
      // Geometria roteada do segmento que CHEGA neste ponto (precisão cheia —
      // arquivo não tem limite de tamanho). Sem isto, reabrir o GPX perdia o
      // traçado exato e re-roteava do zero (lento/divergente no modo energia).
      path: t.pathFromPrev ? t.pathFromPrev.map((p) => [p[0], p[1]]) : null,
      // deckFlag marca trechos de ponte/túnel (viarioGraphRoute) p/ o
      // flattening de elevação — sem isto, reabrir o GPX perdia a marcação e
      // o perfil voltava a mostrar o vale/fundo do DEM sob o tabuleiro.
      deckFlag: t.pathFromPrev?.deckFlag ? [...t.pathFromPrev.deckFlag] : null,
      // Objetivo do roteador do segmento (J) — pra barra de métricas seguir
      // mostrando a energia da rota depois de reabrir o GPX.
      routedEnergyJ: Number.isFinite(t.pathFromPrev?.routedEnergyJ) ? t.pathFromPrev.routedEnergyJ : null,
      // Modo de roteamento que produziu ESTE segmento (proveniência, ver
      // refetchPath) — reabrir o GPX devolve a opção de roteamento por
      // waypoint, não só a geometria.
      mode: t.pathFromPrev?.mode || null,
    };
  });
  const ts = new Date();
  const gpx = buildGpx(latlngs, name, pois, {
    paramsJsonLd: paramsToJsonLd(params),
    userWaypoints,
    routingMode,
  });
  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filenameFromName(name, ts);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  // Exportar é um checkpoint, não um fim: o traçado continua aberto pra
  // seguir editando (era exitDrawingMode() aqui — a rota "sumia do mapa"
  // na hora que era salva). Esc ou ✕ Cancelar saem quando o usuário quiser.
  defaultSaveName = name;
  showToast('GPX salvo — o traçado segue aberto pra edição (Esc sai).');
}

function filenameFromName(name, ts) {
  const slug = (name || 'tracado')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'tracado';
  return `${slug}-${ts.toISOString().slice(0, 10)}.gpx`;
}

// Custom XML namespace for our GPX extensions block. Other tools (Garmin,
// Strava, RWGPS) will silently ignore unknown namespaces per the GPX spec.
const PHIDRO_NS = 'https://pedalhidrografi.co/ns/gpx/1.0';

// ─── Sharable-URL state (gzipped JSON in the hash fragment) ──────────────────
// Encodes the current trackpoints + routing mode into a tiny URL that, when
// opened, repopulates the editor with the same draft. Hash fragment so it
// stays client-side (no server logs, no CDN caching).
// v2: além dos waypoints, embute a GEOMETRIA roteada de cada segmento
// (polyline5 simplificada, ver abaixo) — quem abre o link vê EXATAMENTE a
// rota de quem compartilhou, sem re-rotear via OSRM (reprodutível, abre mais
// rápido e funciona offline). Links v1 (sem `sg`) seguem funcionando: caem
// no caminho antigo de re-roteamento.
const SHARE_STATE_VERSION = 2;

// Tolerância do Douglas-Peucker (em graus, ~5 m) aplicada à geometria antes
// de codificar — invisível nos zooms de uso e corta 50–70% dos pontos.
const SHARE_SIMPLIFY_TOLERANCE = 5e-5;

// Hash maior que isso → refaz o link sem geometria embutida (formato v1):
// browsers aguentam bem mais, mas QR codes ficam densos e messengers feios.
const SHARE_HASH_MAX_CHARS = 12000;

// Codec polyline5 (algoritmo Google/OSRM): deltas entre pontos consecutivos
// em inteiros de 1e-5 grau, varint base-32 deslocado de 63. ~2 bytes/ponto
// em geometria urbana — muito menor que floats em JSON, mesmo após gzip.
function encodePolylineValue(v) {
  v = v < 0 ? ~(v << 1) : v << 1;
  let out = '';
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  return out + String.fromCharCode(v + 63);
}

function encodePolyline(latlngs) {
  let out = '';
  let prevLat = 0;
  let prevLng = 0;
  for (const pt of latlngs) {
    // Aceita [lat,lng] (pathFromPrev) ou L.LatLng, por robustez.
    const iLat = Math.round((pt.lat ?? pt[0]) * 1e5);
    const iLng = Math.round((pt.lng ?? pt[1]) * 1e5);
    out += encodePolylineValue(iLat - prevLat) + encodePolylineValue(iLng - prevLng);
    prevLat = iLat;
    prevLng = iLng;
  }
  return out;
}

// Retorna null em vez de lançar — segmento corrompido degrada pra reta.
function decodePolylineSafe(str) {
  if (typeof str !== 'string' || str.length < 2) return null;
  const pts = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  while (i < str.length) {
    for (const axis of ['lat', 'lng']) {
      let shift = 0;
      let result = 0;
      let b;
      do {
        if (i >= str.length) return null;
        b = str.charCodeAt(i++) - 63;
        if (b < 0) return null;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 'lat') lat += delta;
      else lng += delta;
    }
    pts.push([lat / 1e5, lng / 1e5]);
  }
  if (pts.length < 2) return null;
  for (const [a, b] of pts) {
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) {
      return null;
    }
  }
  return pts;
}

function simplifyForShare(path) {
  if (path.length <= 2) return path;
  const pts = path.map((pt) => L.point(pt.lat ?? pt[0], pt.lng ?? pt[1]));
  return L.LineUtil.simplify(pts, SHARE_SIMPLIFY_TOLERANCE).map((p) => [p.x, p.y]);
}

function snapshotForShare(name) {
  const state = {
    v: SHARE_STATE_VERSION,
    rm: routingMode,
    n: name || '',
    wp: trackpoints.map((t) => {
      const ll = t.marker.getLatLng();
      const lat = +ll.lat.toFixed(5);
      const lng = +ll.lng.toFixed(5);
      const out = [lat, lng];
      // Append name/POI/sym only if non-default to keep the payload small.
      if (t.name || t.isPoi) {
        out.push(t.name || '');
        out.push(t.isPoi ? 1 : 0);
        if (t.isPoi && t.sym && t.sym !== 'Flag, Blue') out.push(t.sym);
      }
      return out;
    }),
  };
  if (routingMode !== 'straight') {
    // Geometria por segmento: sg[k] é o caminho que CHEGA em wp[k+1].
    // Segmentos em reta (fallback de fetch falho, ou ainda em voo na hora do
    // share) codificam a reta mesmo — o que o remetente vê é o que vale.
    state.sg = trackpoints.slice(1).map((t) => {
      const path = t.pathFromPrev;
      if (!Array.isArray(path) || path.length < 2) return '';
      return encodePolyline(simplifyForShare(path));
    });
  }
  return state;
}

async function gzipB64Url(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  // String.fromCharCode in chunks to avoid call-stack overflow on large arrays.
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function gzipB64UrlDecode(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

async function buildShareUrl(name) {
  const state = snapshotForShare(name);
  let compressed = await gzipB64Url(JSON.stringify(state));
  // Rota muito longa → hash gigante: refaz sem a geometria embutida (vira um
  // link estilo v1 — quem abrir re-roteia via OSRM, como antes).
  if (state.sg && compressed.length > SHARE_HASH_MAX_CHARS) {
    delete state.sg;
    compressed = await gzipB64Url(JSON.stringify(state));
  }
  const base = location.href.split('#')[0];
  return `${base}#st=${compressed}`;
}

// Aplica um estado de rota no formato de compartilhamento ({wp, sg, rm, n})
// ao editor: restaura waypoints, geometria roteada por segmento (sg), modo de
// roteamento e nome. Reusado pelo link `#st=` E pelas rotas salvas no servidor
// (mesmo formato persistido). Retorna false se o estado não tem waypoints
// válidos. NÃO mexe na URL/toast — quem chama cuida disso.
async function applyShareState(state) {
  if (!state || !Array.isArray(state.wp) || state.wp.length === 0) return false;
  // Valida ANTES de desmontar o traçado atual — sem isto, um estado
  // compartilhado corrompido (todo lat/lng não-numérico) só falhava depois
  // de já ter apagado a rota em edição do usuário à toa.
  if (!state.wp.some((w) => Array.isArray(w) && Number.isFinite(w[0]) && Number.isFinite(w[1]))) {
    return false;
  }

  if (!drawingMode) enterDrawingMode();
  for (const t of trackpoints) map.removeLayer(t.marker);
  trackpoints = [];
  pendingRouteSeq++;

  if (state.rm && ['straight', 'cycling', 'foot', 'energy', 'energy_road'].includes(state.rm)) {
    routingMode = state.rm;
    traceRoutingMode.value = state.rm;
  }

  // sg[i-1] = geometria roteada que CHEGA no waypoint original i. Decodifica
  // direto e pula o re-roteamento lá embaixo — a rota fica idêntica à salva.
  const segs = Array.isArray(state.sg) ? state.sg : null;
  let prevOriginalIdx = -1; // índice ORIGINAL do último waypoint adicionado
  for (let i = 0; i < state.wp.length; i++) {
    const wp = state.wp[i];
    const [lat, lng, name = '', isPoi = 0, sym] = wp;
    // Valida coords antes de criar o marker — um estado corrompido com
    // lat/lng não-numérico geraria L.latLng(NaN,NaN), bounds inválido e
    // métricas quebradas. Pula o waypoint inválido.
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const tp = createTrackpoint(L.latLng(lat, lng), {
      name: name || '',
      isPoi: !!isPoi,
      sym: sym || 'Flag, Blue',
    });
    // Usa o último trackpoint REALMENTE adicionado (não índice i) — um
    // waypoint inválido pulado acima deixaria trackpoints[i-1] desalinhado.
    if (trackpoints.length > 0) {
      // A geometria embutida só vale se o waypoint anterior não foi pulado
      // (senão o segmento ligaria outro par de pontos). Decodificação
      // falha/corrompida degrada pra reta.
      const embedded =
        segs && prevOriginalIdx === i - 1 ? decodePolylineSafe(segs[i - 1]) : null;
      tp.pathFromPrev =
        embedded ||
        straightPath(
          trackpoints[trackpoints.length - 1].marker.getLatLng(),
          tp.marker.getLatLng(),
        );
    }
    prevOriginalIdx = i;
    trackpoints.push(tp);
  }

  if (state.n) defaultSaveName = state.n;
  redrawAndMetrics();
  updateTraceControls();

  const bounds = L.latLngBounds(trackpoints.map((t) => t.marker.getLatLng()));
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] });

  // Só re-roteia quando NÃO há geometria embutida (formato v1) — com sg os
  // caminhos já foram restaurados acima.
  if (routingMode !== 'straight' && !segs) {
    // Up to 4 OSRM requests in flight at once — keeps within the FOSSGIS
    // server's fair use while cutting end-to-end load by ~4× on long routes.
    const indices = Array.from({ length: trackpoints.length - 1 }, (_, i) => i + 1);
    const routeSeq = ++pendingRouteSeq;
    await mapConcurrent(indices, 4, (idx) => refetchPath(idx, routeSeq));
    redrawAndMetrics();
  }
  // Todos os waypoints podem ter sido pulados por coords inválidas (lat/lng
  // não-numérico) — sem trackpoints não há o que desfazer/compartilhar.
  if (!trackpoints.length) return false;
  pushHistory();
  return true;
}

async function tryLoadFromShareHash() {
  if (!('CompressionStream' in window)) return false;
  const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
  const encoded = hashParams.get('st');
  if (!encoded) return false;

  try {
    const json = await gzipB64UrlDecode(encoded);
    const state = JSON.parse(json);
    if (!(await applyShareState(state))) return false;
    // Strip the #st=… so a later page reload doesn't clobber edits with the
    // original shared route. The state lives in localStorage / drawing
    // session memory now; the URL has done its job.
    window.history.replaceState(null, '', location.pathname + location.search);
    showToast(`Link compartilhado carregado · ${trackpoints.length} pontos`);
    return true;
  } catch (err) {
    console.warn('Share hash decode failed:', err);
    showToast(`Link inválido: ${err.message}`);
    return false;
  }
}

// Deep link de rota salva no servidor, POR NOME: /route/<slug> → o backend
// responde 303 pra /#rt=<slug> (FRAGMENTO, como o #st= — nunca é comido pelo
// strip de query da Cloudflare nem pelo cache do service worker) e aqui o
// slug vira GET /saved-route/<slug>. Depois de carregar, tira o #rt= da URL
// (um reload não clobbera as edições) e ADOTA id/nome da rota — re-salvar
// com o mesmo nome atualiza a MESMA rota no servidor; com a unicidade de
// nome, criar uma cópia = salvar com outro nome. (O suporte antigo a
// ?route=<id> foi removido junto com os links por id.)
async function tryLoadSavedRouteFromHash() {
  const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
  const slug = hashParams.get('rt');
  if (!slug) return false;
  try {
    const res = await fetch(`./saved-route/${encodeURIComponent(slug)}`, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(res.status === 404 ? 'rota não encontrada no servidor' : `HTTP ${res.status}`);
    }
    const state = await res.json();
    if (!(await applyShareState(state))) throw new Error('estado sem waypoints');
    if (state.id) currentSavedRouteId = state.id;
    window.history.replaceState(null, '', location.pathname + location.search);
    showToast(`Rota "${state.n || slug}" carregada · ${trackpoints.length} pontos`);
    return true;
  } catch (err) {
    console.warn(`[route] deep link /route/${slug} falhou:`, err);
    showToast(`Não deu pra carregar a rota do link: ${err.message}`);
    return false;
  }
}

function buildGpx(latlngs, name, pois = [], extras = {}) {
  const isoNow = new Date().toISOString();
  const wpts = pois
    .map(
      (p) =>
        `  <wpt lat="${p.lat}" lon="${p.lon}">\n` +
        `    <name>${escapeXml(p.name)}</name>\n` +
        `    <sym>${escapeXml(p.sym)}</sym>\n` +
        `    <type>POI</type>\n` +
        `  </wpt>`,
    )
    .join('\n');
  // Inclui <ele> quando a elevação está no cache (FABDEM ou Open-Meteo).
  const trkpts = latlngs.map(([lat, lon]) => {
    const e = elevationCache.get(elevKey(lat, lon));
    if (Number.isFinite(e)) {
      return `      <trkpt lat="${lat}" lon="${lon}"><ele>${e.toFixed(2)}</ele></trkpt>`;
    }
    return `      <trkpt lat="${lat}" lon="${lon}"/>`;
  }).join('\n');

  // Embed our JSON-LD params + user waypoint snapshot as CDATA in extensions.
  let extensions = '';
  if (extras.paramsJsonLd || extras.userWaypoints) {
    const parts = [];
    if (extras.paramsJsonLd) {
      parts.push(
        `      <phidro:params>${cdata(JSON.stringify(extras.paramsJsonLd))}</phidro:params>`,
      );
    }
    if (extras.userWaypoints) {
      parts.push(
        `      <phidro:userWaypoints>${cdata(JSON.stringify(extras.userWaypoints))}</phidro:userWaypoints>`,
      );
    }
    if (extras.routingMode) {
      parts.push(`      <phidro:routingMode>${escapeXml(extras.routingMode)}</phidro:routingMode>`);
    }
    extensions =
      `  <extensions>\n` +
      `    <phidro:meta>\n` +
      parts.join('\n') + '\n' +
      `    </phidro:meta>\n` +
      `  </extensions>\n`;
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="pedalhidrografico"\n` +
    `     xmlns="http://www.topografix.com/GPX/1/1"\n` +
    `     xmlns:phidro="${PHIDRO_NS}">\n` +
    `  <metadata><name>${escapeXml(name)}</name><time>${isoNow}</time></metadata>\n` +
    (wpts ? wpts + '\n' : '') +
    extensions +
    `  <trk>\n` +
    `    <name>${escapeXml(name)}</name>\n` +
    `    <trkseg>\n${trkpts}\n    </trkseg>\n` +
    `  </trk>\n` +
    `</gpx>\n`
  );
}

function cdata(s) {
  // CDATA cannot contain "]]>". JSON values shouldn't, but split defensively.
  return `<![CDATA[${String(s).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

// ─── Baixar todas as rotas como GPX (ZIP) ────────────────────────────────────
// Exporta cada rota cadastrada como .gpx. Os metadados vão nos campos PADRÃO do
// GPX (name/cmt/desc/number/type/src/link), que o QGIS/OGR lê como colunas de
// atributo SEM opção nenhuma, E num bloco <extensions> phidro:* (colunas extras
// pra quem abre com GPX_USE_EXTENSIONS=YES). Além dos arquivos por rota, o ZIP
// traz um `pedal-hidrografico-rotas.gpx` com TODAS juntas — ideal pro QGIS, que
// o lê como uma única camada "tracks" (uma feição por rota).
const GPX_README =
  'Rotas do Pedal Hidrográfico — exportação GPX\n' +
  'https://amora.pedalhidrografi.co/\n\n' +
  'CONTEÚDO\n' +
  '  pedal-hidrografico-rotas.gpx   Todas as rotas num arquivo só (melhor pro QGIS).\n' +
  '  rotas/*.gpx                    Uma rota por arquivo (bom pra Garmin/Strava/apps).\n\n' +
  'ABRINDO NO QGIS (rotas como vetores)\n' +
  '  Arraste "pedal-hidrografico-rotas.gpx" pro QGIS. Ele vira várias camadas —\n' +
  '  use "tracks" (as rotas como linhas) e "waypoints" (os POIs). Cada rota é uma\n' +
  '  feição com atributos: name, cmt (narrativa), desc (resumo), number, type,\n' +
  '  src e link (abre o passeio no site).\n' +
  '  A coluna "desc" traz o resumo (data, número(s), distância, energia em kJ,\n' +
  '  duração, participantes). Pra campos SEPARADOS (energyKj, distanceKm…), abra\n' +
  '  com a opção GPX_USE_EXTENSIONS=YES (Fonte de dados › Opções abertas), que\n' +
  '  expõe as tags <phidro:*> como colunas.\n';

async function downloadAllRoutesGpx() {
  const entries = [...routes.values()]
    .map((r) => r.entry)
    .filter((e) => e && Array.isArray(e.latlngs) && e.latlngs.length >= 2);
  if (!entries.length) { showToast('Nenhuma rota com traçado pra exportar.'); return; }

  showToast(`Preparando ${entries.length} rotas…`, 4000);
  let JSZip;
  try { JSZip = await ensureJSZip(); }
  catch (e) { showToast(`JSZip indisponível: ${e.message}`); return; }

  // Enriquecimento: metadados dos passeios (energia, narrativa, duração…),
  // join por tourIri. Best-effort — sem tours.ttl, exporta só o que routes.json
  // já traz (nome, data, números, distância, links, id RWGPS).
  let meta = new Map();
  try {
    const [t, i] = await Promise.all([
      fetch('./data/tours.ttl', { cache: 'no-cache' }).then((r) => (r.ok ? r.text() : '')),
      fetch('./data/identities.ttl', { cache: 'no-cache' }).then((r) => (r.ok ? r.text() : '')),
    ]);
    meta = await collectTourMeta(`${t}\n\n${i}`);
  } catch (_) { /* segue sem enriquecimento */ }

  const zip = new JSZip();
  const trkFrags = [];
  const wptFrags = [];
  const isoNow = new Date().toISOString();
  for (const entry of entries) {
    const built = buildRouteGpxParts(entry, meta.get(entry.tourIri) || {});
    trkFrags.push(built.trk);
    if (built.wpts) wptFrags.push(built.wpts);
    zip.file(
      `rotas/${routeGpxFilename(entry)}`,
      wrapGpx(built.trk, built.wpts, built.name, built.desc, entry.tourIri, isoNow),
    );
  }
  zip.file(
    'pedal-hidrografico-rotas.gpx',
    wrapGpx(trkFrags.join('\n'), wptFrags.join('\n'),
      `Rotas do Pedal Hidrográfico (${entries.length})`,
      `Exportado em ${isoNow.slice(0, 10)}`, null, isoNow),
  );
  zip.file('LEIA-ME.txt', GPX_README);

  showToast('Compactando…', 4000);
  const blob = await zip.generateAsync({ type: 'blob' });
  downloadBlob(blob, `pedal-hidrografico-rotas-${isoNow.slice(0, 10)}.zip`);
  showToast(`${entries.length} rotas baixadas.`);
}

// Envelope GPX 1.1 em volta de um ou mais <trk> + <wpt> já montados.
function wrapGpx(trk, wpts, name, desc, link, isoNow) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx version="1.1" creator="Pedal Hidrográfico"\n' +
    '     xmlns="http://www.topografix.com/GPX/1/1"\n' +
    `     xmlns:phidro="${PHIDRO_NS}">\n` +
    '  <metadata>\n' +
    `    <name>${escapeXml(name)}</name>\n` +
    (desc ? `    <desc>${escapeXml(desc)}</desc>\n` : '') +
    (link ? `    <link href="${escapeXml(link)}"><text>Passeio no Pedal Hidrográfico</text></link>\n` : '') +
    `    <time>${isoNow}</time>\n` +
    '  </metadata>\n' +
    (wpts ? `${wpts}\n` : '') +
    `${trk}\n` +
    '</gpx>\n'
  );
}

// Monta o <trk> (+ <wpt> dos POIs) de uma rota, empacotando os metadados nos
// campos padrão do GPX + num bloco <extensions>. Devolve as partes pra serem
// usadas tanto no arquivo individual quanto no arquivo único (todas as rotas).
function buildRouteGpxParts(entry, m) {
  const name = buildLabel(entry);
  const nums = entryNumbers(entry);
  const numbersStr = nums.map((n) => `${n.source} ${n.value}`).join(' · ');
  const distKm = routeDistanceKm(entry.latlngs);
  const desc = packRouteDesc(entry, m, distKm, numbersStr);

  const trkpts = entry.latlngs
    .map(([lat, lon]) => `      <trkpt lat="${lat}" lon="${lon}"/>`)
    .join('\n');

  // <number> exige xsd:nonNegativeInteger — só emite se houver número inteiro
  // puro (ex.: "98"; ignora "3-5" de colisão de edição, que fica só no cmt/ext).
  const intNum = nums.map((n) => n.value).find((v) => /^\d+$/.test(v));

  const ext = [];
  const addExt = (tag, v) => {
    if (v != null && v !== '') ext.push(`        <phidro:${tag}>${escapeXml(String(v))}</phidro:${tag}>`);
  };
  addExt('date', entry.date);
  addExt('numbers', numbersStr);
  addExt('distanceKm', distKm != null ? distKm.toFixed(2) : null);
  addExt('energyKj', m.energyKj);
  addExt('intensity', m.intensity);
  addExt('measuredEnergyKj', m.measuredKj);
  addExt('movingDuration', m.moving);
  addExt('attendees', m.attendees);
  addExt('newcomers', m.newcomers);
  addExt('authors', (m.authors || []).join(', '));
  addExt('tourIri', entry.tourIri);
  addExt(entry.provider === 'amora' ? 'amoraRoute' : 'rwgpsId', entry.id);
  addExt('instagram', entry.igPost);

  const links =
    (entry.tourIri ? `    <link href="${escapeXml(entry.tourIri)}"><text>Passeio</text></link>\n` : '') +
    (entry.igPost ? `    <link href="${escapeXml(entry.igPost)}"><text>Instagram</text></link>\n` : '');

  const trk =
    '  <trk>\n' +
    `    <name>${escapeXml(name)}</name>\n` +
    (m.description ? `    <cmt>${escapeXml(m.description)}</cmt>\n` : '') +
    (desc ? `    <desc>${escapeXml(desc)}</desc>\n` : '') +
    '    <src>Pedal Hidrográfico</src>\n' +
    links +
    (intNum ? `    <number>${intNum}</number>\n` : '') +
    '    <type>cycling</type>\n' +
    (ext.length ? `    <extensions>\n${ext.join('\n')}\n    </extensions>\n` : '') +
    `    <trkseg>\n${trkpts}\n    </trkseg>\n` +
    '  </trk>';

  const wpts = (entry.pois || [])
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
    .map((p) =>
      `  <wpt lat="${p.lat}" lon="${p.lng}">\n` +
      `    <name>${escapeXml(p.name || 'POI')}</name>\n` +
      (p.sym ? `    <sym>${escapeXml(p.sym)}</sym>\n` : '') +
      '    <type>POI</type>\n' +
      `    <cmt>${escapeXml(name)}</cmt>\n` +
      '  </wpt>')
    .join('\n');

  return { trk, wpts, name, desc };
}

// Resumo de uma linha (vira a coluna `desc` no QGIS) — só os campos presentes.
function packRouteDesc(entry, m, distKm, numbersStr) {
  const parts = [];
  if (entry.date) parts.push(`Data: ${entry.date}`);
  if (numbersStr) parts.push(`Nº: ${numbersStr}`);
  if (distKm != null) parts.push(`Distância: ${distKm.toFixed(1)} km`);
  if (m.energyKj) parts.push(`Energia: ${m.energyKj} kJ${m.intensity ? ` (${m.intensity})` : ''}`);
  if (m.moving) parts.push(`Duração: ${fmtIsoDur(m.moving)}`);
  if (m.attendees) parts.push(`Participantes: ${m.attendees}`);
  if (entry.id) parts.push(`RWGPS: ${entry.id}`);
  if (entry.tourIri) parts.push(`Passeio: ${entry.tourIri}`);
  return parts.join(' | ');
}

// ISO 8601 duration compacta: "PT1H51M" → "1h51", "PT18M" → "18min".
function fmtIsoDur(iso) {
  const mt = /^PT(?:(\d+)H)?(?:(\d+)M)?/.exec(iso || '');
  if (!mt) return iso || '';
  const h = mt[1] ? +mt[1] : 0;
  const mn = mt[2] ? +mt[2] : 0;
  if (h && mn) return `${h}h${String(mn).padStart(2, '0')}`;
  if (h) return `${h}h`;
  if (mn) return `${mn}min`;
  return iso || '';
}

function routeDistanceKm(latlngs) {
  if (!Array.isArray(latlngs) || latlngs.length < 2) return null;
  let m = 0;
  for (let i = 1; i < latlngs.length; i++) {
    m += haversine(latlngs[i - 1][0], latlngs[i - 1][1], latlngs[i][0], latlngs[i][1]);
  }
  return m / 1000;
}

// Nome de arquivo humano-amigável e único: "2026-07-04-PH98-<slug>.gpx".
function routeGpxFilename(entry) {
  const slug = (entry.tourIri || '').split('/').pop() || `rota-${entry.id}`;
  const nums = entryNumbers(entry).map((n) => `${n.source}${n.value}`).join('-');
  const base = [entry.date || '', nums, slug].filter(Boolean).join('-');
  return `${base.replace(/[^\w.-]/g, '_')}.gpx`;
}

// Parseia tours.ttl (+ identities.ttl pros nomes) → Map tourIri → metadados.
// Só passeios (pas:<slug>), pula edições de série (pas:<ES>/<seq>).
async function collectTourMeta(text) {
  const map = new Map();
  let Parser;
  try { Parser = await ensureN3(); } catch (_) { return map; }
  const PH = 'https://id.pedalhidrografi.co/terms#';
  const DCT = 'http://purl.org/dc/terms/';
  const PROV = 'http://www.w3.org/ns/prov#';
  const SCHEMA = 'https://schema.org/';
  const PAS = 'https://id.pedalhidrografi.co/passeio/';
  let quads;
  try { quads = new Parser().parse(text); } catch (_) { return map; }
  const subjBy = new Map();
  const names = new Map();
  for (const q of quads) {
    const s = q.subject.value;
    const p = q.predicate.value;
    if (p === SCHEMA + 'name') names.set(s, q.object.value);
    else if (p === SCHEMA + 'alternateName' && !names.has(s)) names.set(s, q.object.value);
    if (!subjBy.has(s)) subjBy.set(s, []);
    subjBy.get(s).push(q);
  }
  const intensityFor = (kj) => {
    if (!Number.isFinite(kj)) return null;
    if (kj < 150) return 'De boa';
    if (kj < 300) return 'Ok';
    if (kj < 500) return 'Endorfinado';
    if (kj < 1000) return 'Frito';
    return 'Insano';
  };
  for (const [s, qs] of subjBy) {
    if (!s.startsWith(PAS) || s.slice(PAS.length).includes('/')) continue;  // pula edições
    const lit = (pred) => {
      for (const q of qs) {
        if (q.predicate.value === pred && q.object.termType === 'Literal') return q.object.value;
      }
      return null;
    };
    const iris = (pred) => qs
      .filter((q) => q.predicate.value === pred && q.object.termType === 'NamedNode')
      .map((q) => q.object.value);
    const energy = lit(PH + 'energyEstimate');
    map.set(s, {
      description: lit(DCT + 'description'),
      energyKj: energy,
      intensity: energy != null ? intensityFor(parseFloat(energy)) : null,
      measuredKj: lit(PH + 'measuredEnergy'),
      moving: lit(PH + 'movingDuration'),
      departed: lit(PH + 'departedAt'),
      arrived: lit(PH + 'arrivedAt'),
      attendees: lit(PH + 'countAttendee'),
      newcomers: lit(PH + 'countNewcomer'),
      authors: iris(PROV + 'wasAttributedTo').map((iri) => names.get(iri) || iri.replace(/^.*[#/]/, '')),
    });
  }
  return map;
}

// ─── Save GPX modal ──────────────────────────────────────────────────────────
const saveModal = document.getElementById('save-modal');
const saveClose = document.getElementById('save-close');
const saveCancel = document.getElementById('save-cancel');
const saveConfirm = document.getElementById('save-confirm');
const saveNameInput = document.getElementById('save-name');
const saveFilenamePreview = document.getElementById('save-filename-preview');

function openSaveModal() {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  saveNameInput.value = defaultSaveName || `Traçado ${stamp}`;
  updateFilenamePreview();
  saveModal.hidden = false;
  setTimeout(() => {
    saveNameInput.focus();
    saveNameInput.select();
  }, 0);
}
function closeSaveModal() { saveModal.hidden = true; }

saveClose.addEventListener('click', closeSaveModal);
saveCancel.addEventListener('click', closeSaveModal);
saveModal.addEventListener('click', (e) => {
  if (e.target === saveModal) closeSaveModal();
});
saveNameInput.addEventListener('input', updateFilenamePreview);
saveNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); doSave(); }
  if (e.key === 'Escape') closeSaveModal();
});
saveConfirm.addEventListener('click', doSave);

// "Copiar link" / "QR" — salvam a rota no servidor (upsert com o nome do
// modal) e compartilham o link POR NOME (/route/<slug>): curto, estável e
// legível. Sem backend alcançável (host estático / kit local), degradam pro
// link #st= com o estado inteiro embutido — funciona offline, só que longo.
const saveCopyLink = document.getElementById('save-copy-link');
const saveQrBtn = document.getElementById('save-qr');

// Devolve { url, server } — ou null quando não dá pra compartilhar agora
// (sem pontos, sem nome, nome já usado: o usuário já foi avisado).
async function shareableRouteUrl() {
  if (trackpoints.length < 2) {
    alert('Adicione pelo menos 2 pontos antes de gerar o link.');
    return null;
  }
  try {
    const saved = await saveRouteToServer();
    if (!saved) return null;   // 409 (nome em uso) ou sem nome — já alertado
    return { url: savedRouteShareUrl(saved.slug), server: true };
  } catch (err) {
    console.warn('[save-route] servidor indisponível, caindo pro link #st=:', err);
  }
  if (!('CompressionStream' in window)) {
    alert('Servidor indisponível, e o navegador não suporta o link #st= (precisa de CompressionStream).');
    return null;
  }
  return { url: await buildShareUrl(saveNameInput.value.trim()), server: false };
}

saveCopyLink?.addEventListener('click', async () => {
  let share = null;
  try {
    share = await shareableRouteUrl();
  } catch (err) {
    alert(`Falha ao gerar link: ${err.message}`);
    return;
  }
  if (!share) return;
  const note = share.server ? 'rota salva no servidor' : 'servidor fora — estado embutido no link';
  try {
    if (!navigator.clipboard) throw new Error('sem clipboard');
    await navigator.clipboard.writeText(share.url);
    showToast(`Link copiado · ${note}`);
  } catch {
    // Fallback: prompt window with the URL pre-selected for manual copy.
    window.prompt(`Copie o link (${note}):`, share.url);
  }
});

// ─── QR-code modal ───────────────────────────────────────────────────────────
const qrModal = document.getElementById('qr-modal');
const qrClose = document.getElementById('qr-close');
const qrImage = document.getElementById('qr-image');
const qrWarning = document.getElementById('qr-warning');
const qrUrlInput = document.getElementById('qr-url');
const qrCopyBtn = document.getElementById('qr-copy');
const qrDownloadSvgBtn = document.getElementById('qr-download-svg');
const qrDownloadPngBtn = document.getElementById('qr-download-png');

let qrCurrentSvg = null;
let qrCurrentUrl = '';

saveQrBtn?.addEventListener('click', async () => {
  if (typeof qrcode === 'undefined') {
    alert('Biblioteca de QR não carregou — verifique conexão.');
    return;
  }
  let share = null;
  try {
    share = await shareableRouteUrl();
  } catch (err) {
    alert(`Falha ao gerar link: ${err.message}`);
    return;
  }
  if (!share) return;
  if (share.server) showToast('Rota salva no servidor');
  showQrModal(share.url);
});

qrClose?.addEventListener('click', () => (qrModal.hidden = true));
qrModal?.addEventListener('click', (e) => {
  if (e.target === qrModal) qrModal.hidden = true;
});
// Esc fecha só o QR — o keydown do modo de edição ignora Esc com modal
// aberto, então sem isto o Esc ficava sem efeito aqui.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && qrModal && !qrModal.hidden) qrModal.hidden = true;
});
qrCopyBtn?.addEventListener('click', async () => {
  if (!qrCurrentUrl) return;
  try {
    await navigator.clipboard.writeText(qrCurrentUrl);
    showToast('URL copiada');
  } catch {
    window.prompt('Copie o URL:', qrCurrentUrl);
  }
});
qrDownloadSvgBtn?.addEventListener('click', () => {
  if (!qrCurrentSvg) return;
  downloadBlob(
    new Blob([qrCurrentSvg], { type: 'image/svg+xml' }),
    `qr-${qrFilenameSlug()}.svg`,
  );
});
qrDownloadPngBtn?.addEventListener('click', () => {
  if (!qrCurrentSvg) return;
  svgToPngBlob(qrCurrentSvg, 1024).then((blob) => {
    downloadBlob(blob, `qr-${qrFilenameSlug()}.png`);
  });
});

function showQrModal(url) {
  qrCurrentUrl = url;
  qrUrlInput.value = url;

  // Pick error correction by URL length: shorter URLs can afford H (more
  // robust to camera blur), longer ones need L just to fit.
  let ec = 'H';
  if (url.length > 350) ec = 'Q';
  if (url.length > 700) ec = 'M';
  if (url.length > 1100) ec = 'L';

  // typeNumber=0 → auto-pick smallest version that fits.
  const qr = qrcode(0, ec);
  qr.addData(url);
  qr.make();

  // 4-px cells with 4-cell quiet zone, scalable so the SVG fills the box.
  qrCurrentSvg = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  qrImage.innerHTML = qrCurrentSvg;

  if (url.length > 1500) {
    qrWarning.textContent =
      `URL longa (${url.length} chars) — o QR fica denso e pode falhar ao escanear. Considere reduzir o número de waypoints.`;
    qrWarning.hidden = false;
  } else {
    qrWarning.hidden = true;
  }

  qrModal.hidden = false;
}

function qrFilenameSlug() {
  const name = (saveNameInput.value || 'rota').trim();
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 50) || 'rota';
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// SVG string → PNG blob via Canvas. Used for the "Baixar PNG" button so the
// QR can be pasted into apps that don't render SVG (some chat clients, IG).
function svgToPngBlob(svgString, size) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(img, 0, 0, size, size);
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('PNG conversion failed'));
      }, 'image/png');
    };
    img.onerror = () => reject(new Error('SVG load failed'));
    // Embed the SVG via data URL — base64 encode to handle UTF-8 safely.
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgString)));
  });
}

function updateFilenamePreview() {
  saveFilenamePreview.textContent = filenameFromName(saveNameInput.value, new Date());
}
function doSave() {
  const name = (saveNameInput.value || '').trim() || `Traçado ${new Date().toISOString().slice(0,16).replace('T',' ')}`;
  closeSaveModal();
  performSave(name);
}

// ─── Instructions modal ──────────────────────────────────────────────────────
const helpBtn = document.getElementById('help-btn');
const helpModal = document.getElementById('help-modal');
const helpClose = document.getElementById('help-close');
function setHelpOpen(open) {
  if (!helpModal) return;
  helpModal.hidden = !open;
  helpBtn?.setAttribute('aria-pressed', String(open));
}
helpBtn?.addEventListener('click', () => {
  if (helpModal && !helpModal.hidden) {
    setHelpOpen(false);
    return;
  }
  closeOtherMobileDialogs('help');
  setHelpOpen(true);
});
helpClose?.addEventListener('click', () => setHelpOpen(false));
helpModal?.addEventListener('click', (e) => {
  if (e.target === helpModal) setHelpOpen(false);
});

// ─── Edit GPX (load a .gpx into the drawing tool) ────────────────────────────
const editGpxInput = document.getElementById('edit-gpx-input');

// "Carregar" (na barra de edição #trace-controls) abre o modal de carregar
// rota (do servidor ou do computador) — o picker de .gpx fica dentro do modal
// ("Carregar GPX do computador"). Carregar com a edição já aberta só troca o
// traçado (os caminhos de load fazem `if (!drawingMode) enterDrawingMode()`).
document.getElementById('trace-load')?.addEventListener('click', () => openSavedRoutesModal());
editGpxInput.addEventListener('change', () => {
  const file = editGpxInput.files?.[0];
  editGpxInput.value = '';
  if (!file) return;
  closeSavedRoutesModal();
  const reader = new FileReader();
  reader.onload = () => loadGpxIntoEditor(String(reader.result));
  reader.readAsText(file);
});

// ─── Modal: como conectar os pontos de um GPX de terceiros ───────────────────
// Carregar um GPX de terceiros pergunta como ligar os pontos. Espelha as opções
// da barra de edição (#trace-routing-mode) e usa os mesmos `params`. 'straight'
// preserva TODOS os pontos (geometria exata do traço); os modos roteados
// reamostram p/ ~100 e recalculam o caminho (rotear centenas de pontos densos
// seria inviável). Promessa: resolve com o modo escolhido ou null se cancelar.
const gpxConnectModal = document.getElementById('gpx-connect-modal');
const gpxConnectClose = document.getElementById('gpx-connect-close');
const gpxConnectMode = document.getElementById('gpx-connect-mode');
const gpxConnectConfirm = document.getElementById('gpx-connect-confirm');
const gpxConnectCount = document.getElementById('gpx-connect-count');
const GPX_CONNECT_MODES = ['straight', 'cycling', 'foot', 'energy', 'energy_road'];
let _gpxConnectResolve = null;

function askGpxConnectMode(pointCount) {
  // Um segundo GPX carregado enquanto o modal ainda está aberto sobrescreveria
  // o resolver pendente e travaria o primeiro loadGpxIntoEditor pra sempre —
  // libera quem estava esperando (com null, como um cancelamento) antes.
  if (_gpxConnectResolve) { const prev = _gpxConnectResolve; _gpxConnectResolve = null; prev(null); }
  return new Promise((resolve) => {
    _gpxConnectResolve = resolve;
    if (gpxConnectCount) gpxConnectCount.textContent = String(pointCount);
    const cur = traceRoutingMode.value || routingMode || 'straight';
    gpxConnectMode.value = GPX_CONNECT_MODES.includes(cur) ? cur : 'straight';
    gpxConnectModal.hidden = false;
  });
}
function settleGpxConnect(mode) {
  if (!gpxConnectModal.hidden) gpxConnectModal.hidden = true;
  const r = _gpxConnectResolve;
  _gpxConnectResolve = null;
  if (r) r(mode);
}
gpxConnectConfirm?.addEventListener('click', () => settleGpxConnect(gpxConnectMode.value || 'straight'));
gpxConnectClose?.addEventListener('click', () => settleGpxConnect(null));
gpxConnectModal?.addEventListener('click', (e) => { if (e.target === gpxConnectModal) settleGpxConnect(null); });

// ─── Rotas salvas no servidor ────────────────────────────────────────────────
// Persistem o MESMO estado dos links de compartilhamento (snapshotForShare:
// waypoints + geometria roteada por segmento + modo) no backend. O salvar
// acontece pelos botões Copiar link / QR do modal Salvar (que compartilham o
// link por nome) — sem backend same-origin eles degradam pro link #st=.

// Id da rota carregada/salva do servidor — re-salvar atualiza ela no lugar.
let currentSavedRouteId = null;

// Link compartilhável de uma rota salva — POR NOME: /route/<slug>, que o
// backend resolve com um 303 pra /#rt=<slug> (tryLoadSavedRouteFromHash).
// Curto, estável e legível, ao contrário do #st= que embute o estado inteiro.
function savedRouteShareUrl(slug) {
  return `${location.origin}/route/${encodeURIComponent(slug)}`;
}

async function copySavedRouteLink(slug) {
  const url = savedRouteShareUrl(slug);
  try {
    if (!navigator.clipboard) throw new Error('sem clipboard');
    await navigator.clipboard.writeText(url);
    showToast('Link da rota copiado');
  } catch {
    // Fallback: prompt com a URL pré-selecionada pra copiar na mão.
    window.prompt('Copie o link:', url);
  }
}

// Salva/atualiza a rota atual no servidor. Devolve {id, slug} em caso de
// sucesso; null quando o usuário precisa agir (sem nome, ou recusou
// sobrescrever a homônima); LANÇA em erro de rede/servidor, pra quem chama
// decidir o fallback (#st=). Nome é a identidade pública da rota: colisão
// com OUTRA rota devolve 409 com o id dela, e aqui perguntamos se o usuário
// quer ATUALIZÁ-LA (re-salva adotando esse id — o link continua o mesmo) ou
// voltar e trocar o nome.
async function saveRouteToServer() {
  const name = saveNameInput.value.trim();
  if (!name) {
    alert('Dê um nome à rota antes de salvar — é ele que vira o endereço.');
    return null;
  }
  const state = snapshotForShare(name);
  // Stats do editor pro card do modal Carregar e pro card OG de
  // compartilhamento (badge de kJ + faixa de intensidade). O estado salvo
  // não carrega elevação, então subida e energia só existem se gravadas
  // AGORA — e só quando o perfil está completo (senão gravaria valores
  // subcontados).
  let stats;
  try {
    const sim = simulateRide(params);
    if (sim && sim.elevMissing === 0) {
      stats = { ascentM: sim.ascentM, descentM: sim.descentM, energyKj: sim.eLegJ / 1000 };
    }
  } catch { /* segue sem stats */ }
  const post = async (id) => {
    const res = await fetch('./save-route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, state, stats, id: id || undefined }),
    });
    return { res, data: await res.json().catch(() => ({})) };
  };
  let { res, data } = await post(currentSavedRouteId);
  if (res.status === 409 && data.id) {
    const ok = confirm(
      `Já existe uma rota chamada "${data.name || name}" no servidor.\n` +
      'Substituir o traçado dela pelo atual? (o link /route/… continua o mesmo)',
    );
    if (!ok) return null;
    ({ res, data } = await post(data.id));   // re-salva EM CIMA da existente
  }
  if (res.status === 409) {
    alert(data.error || 'Já existe uma rota com esse nome — escolha outro.');
    return null;
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  currentSavedRouteId = data.id;
  defaultSaveName = name;
  scheduleTraceDraftSave();   // o rascunho passa a apontar pra rota salva
  return data;
}

// "☁ Salvar no servidor" — salva/atualiza sem copiar link nem abrir QR.
const saveServerBtn = document.getElementById('save-server');
saveServerBtn?.addEventListener('click', async () => {
  if (trackpoints.length < 2) {
    alert('Adicione pelo menos 2 pontos antes de salvar.');
    return;
  }
  try {
    const saved = await saveRouteToServer();
    if (!saved) return;
    showToast(`Rota salva no servidor · /route/${saved.slug}`);
  } catch (err) {
    alert(`Não foi possível salvar no servidor: ${err.message}\n(requer o backend same-origin)`);
  }
});

const savedRoutesModal = document.getElementById('saved-routes-modal');
const savedRoutesClose = document.getElementById('saved-routes-close');
const savedRoutesList = document.getElementById('saved-routes-list');
const savedRoutesEmpty = document.getElementById('saved-routes-empty');
const savedRoutesLocal = document.getElementById('saved-routes-local');

// Botão "Carregar GPX do computador" — dispara o mesmo picker do antigo Editar.
savedRoutesLocal?.addEventListener('click', () => editGpxInput.click());

async function openSavedRoutesModal() {
  savedRoutesModal.hidden = false;
  savedRoutesEmpty.hidden = true;
  savedRoutesList.innerHTML = '<li class="muted">Carregando…</li>';
  try {
    const res = await fetch('./saved-routes', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderSavedRoutes(data.routes || []);
  } catch (err) {
    savedRoutesList.innerHTML =
      `<li class="muted">Indisponível: ${escapeHtml(err.message)} (requer o backend same-origin).</li>`;
  }
}
function closeSavedRoutesModal() { savedRoutesModal.hidden = true; }

// Faixas fixas de intensidade por kJ — espelho do intensityFor do censo.html
// (fonte canônica; o backend repete as mesmas faixas no badge do card OG).
function intensityForKj(kj) {
  if (kj < 150) return 'De boa';
  if (kj < 300) return 'Ok';
  if (kj < 500) return 'Endorfinado';
  if (kj < 1000) return 'Frito';
  return 'Insano';
}

// Miniatura SVG do traçado (polyline `preview` da listagem) — projeção
// equiretangular com correção de longitude por cos(lat média), centrada na
// viewBox. Pontos verde/laranja marcam início/fim. O fundo é a "Morros e
// Águas" (águas + cristas do FGB de hidrografia), preenchido DEPOIS,
// assíncrono, por fillThumbHidro — o card aparece na hora com o traçado e
// as águas pingam quando as range requests voltam.
const THUMB_W = 100, THUMB_H = 64, THUMB_PAD = 7;

// Projeção da miniatura + bbox GEO da viewBox INTEIRA (não só da rota) —
// é essa bbox que a consulta de hidrografia usa, pra água preencher o
// thumbnail até as bordas.
function thumbProjection(pts) {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const [la, lo] of pts) {
    if (la < minLat) minLat = la;
    if (la > maxLat) maxLat = la;
    if (lo < minLng) minLng = lo;
    if (lo > maxLng) maxLng = lo;
  }
  const kx = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const spanX = Math.max((maxLng - minLng) * kx, 1e-6);
  const spanY = Math.max(maxLat - minLat, 1e-6);
  const s = Math.min((THUMB_W - 2 * THUMB_PAD) / spanX, (THUMB_H - 2 * THUMB_PAD) / spanY);
  const ox = (THUMB_W - spanX * s) / 2;
  const oy = (THUMB_H - spanY * s) / 2;
  const xy = (la, lo) => [
    (ox + (lo - minLng) * kx * s).toFixed(1),
    (oy + (maxLat - la) * s).toFixed(1),
  ];
  return {
    xy,
    bb: {   // inversa da projeção nos 4 cantos da viewBox
      west:  minLng - ox / (kx * s),
      east:  minLng + (THUMB_W - ox) / (kx * s),
      north: maxLat + oy / s,
      south: maxLat - (THUMB_H - oy) / s,
    },
  };
}

function routePreviewSvg(pts, proj) {
  if (!proj) return '<div class="saved-route-thumb-empty">sem traçado</div>';
  const coords = pts.map(([la, lo]) => proj.xy(la, lo).join(',')).join(' ');
  const [x0, y0] = proj.xy(pts[0][0], pts[0][1]);
  const [x1, y1] = proj.xy(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  return (
    `<svg viewBox="0 0 ${THUMB_W} ${THUMB_H}" aria-hidden="true">` +
    `<g class="thumb-hidro"></g>` +
    `<polyline class="thumb-casing" points="${coords}"/>` +
    `<polyline class="thumb-line" points="${coords}"/>` +
    `<circle class="thumb-start" cx="${x0}" cy="${y0}" r="3"/>` +
    `<circle class="thumb-end" cx="${x1}" cy="${y1}" r="3"/>` +
    `</svg>`
  );
}

// Fundo "Morros e Águas" de uma miniatura: consulta o FGB de hidrografia (e
// a rede do coletivo) na bbox da viewBox e desenha as linhas no <g> de fundo,
// com o MESMO estilo da camada do mapa (hidroStyleFor) em traço fino. Cache
// por rota (id+updated) — reabrir o modal na sessão não re-consulta.
const _thumbHidroCache = new Map();
const THUMB_HIDRO_MAIN_KM2 = 150;   // acima disso, só rio/canal/crista (legibilidade)
const THUMB_HIDRO_MAX_LINES = 400;  // teto de <polyline> por miniatura
const THUMB_STROKE_SCALE = 0.33;    // pesos da camada (px de mapa) → unidades da viewBox

async function fillThumbHidro(svgEl, proj, cacheKey) {
  const g = svgEl?.querySelector('.thumb-hidro');
  if (!g) return;
  if (_thumbHidroCache.has(cacheKey)) {
    g.innerHTML = _thumbHidroCache.get(cacheKey);
    return;
  }
  const bb = proj.bb;
  const areaKm2 = bboxAreaKm2(bb);
  if (areaKm2 > OSM_FGB_MAX_BBOX_KM2) return;   // rota continental — sem fundo
  const detail = areaKm2 > THUMB_HIDRO_MAIN_KM2 ? DETAIL_MAIN : DETAIL_FULL;
  // Fora do LRU do viário pela mesma razão da camada (encheria os 10 slots).
  // `null` = fetch FALHOU (timeout/offline) — diferente de lista vazia
  // ("não há água aqui"): falha desenha o que deu e NÃO entra no cache da
  // sessão, senão um timeout envenenaria a miniatura até recarregar a página.
  const [hidro, network] = await Promise.all([
    streamFgbFeatures(HIDRO_FGB_URL, bb, false).catch(() => null),
    loadPhCycleNetwork().catch(() => []),
  ]);
  const lines = [];
  const pushFeature = (f, style) => {
    if (!style) return;
    const geom = f.geometry || {};
    const parts = geom.type === 'LineString' ? [geom.coordinates]
      : geom.type === 'MultiLineString' ? geom.coordinates : [];
    for (const coords of parts) {
      if (!Array.isArray(coords) || coords.length < 2) continue;
      if (lines.length >= THUMB_HIDRO_MAX_LINES) return;
      // FGB guarda [lng,lat].
      const points = coords.map(([lo, la]) => proj.xy(la, lo).join(',')).join(' ');
      const w = (style.weight || 2) * THUMB_STROKE_SCALE;
      const dash = style.dashArray
        ? ` stroke-dasharray="${style.dashArray.split(/\s+/).map((n) => n * THUMB_STROKE_SCALE * 2).join(' ')}"`
        : '';
      lines.push(`<polyline points="${points}" stroke="${style.color}" stroke-width="${w.toFixed(2)}"${dash}/>`);
    }
  };
  for (const f of hidro || []) pushFeature(f, hidroStyleFor(f.properties || {}, detail));
  for (const f of network) pushFeature(f, { color: '#2da9ff', weight: 5 });
  const html = lines.join('');
  if (hidro !== null) _thumbHidroCache.set(cacheKey, html);
  // O modal pode ter sido fechado/re-renderizado durante o fetch — só pinta
  // se o <g> ainda está no documento.
  if (g.isConnected) g.innerHTML = html;
}

function renderSavedRoutes(routes) {
  savedRoutesList.innerHTML = '';
  if (!routes.length) { savedRoutesEmpty.hidden = false; return; }
  savedRoutesEmpty.hidden = true;
  const hidroFills = [];   // (svg, proj, key) — preenchidos em lote no final
  for (const r of routes) {
    const li = document.createElement('li');
    li.className = 'saved-route-card';

    // Miniatura clicável = Carregar (a ação primária do card).
    const thumb = document.createElement('button');
    thumb.type = 'button';
    thumb.className = 'saved-route-thumb';
    thumb.title = 'Carregar esta rota no editor';
    thumb.setAttribute('aria-label', `Carregar ${r.name || r.id}`);
    const proj = Array.isArray(r.preview) && r.preview.length >= 2
      ? thumbProjection(r.preview) : null;
    thumb.innerHTML = routePreviewSvg(r.preview, proj);
    if (proj) {
      hidroFills.push([thumb.querySelector('svg'), proj, `${r.id}:${r.updated || r.created || ''}`]);
    }
    thumb.addEventListener('click', () => loadSavedRoute(r.id, r.name));

    const nameEl = document.createElement('div');
    nameEl.className = 'saved-route-name';
    nameEl.textContent = r.name || '(sem nome)';
    nameEl.title = r.name || '';

    // km · ↑subida (se o editor gravou) · última modificação.
    const bits = [];
    if (Number.isFinite(r.distMeters)) bits.push(fmtDistCompact(r.distMeters));
    const asc = r.stats?.ascentM;
    if (Number.isFinite(asc)) bits.push(`↑${Math.round(asc)} m`);
    const mod = r.updated || r.created;
    if (mod) bits.push(String(mod).slice(0, 10));
    const statsEl = document.createElement('div');
    statsEl.className = 'saved-route-stats';
    statsEl.textContent = bits.join(' · ') || `${r.points || 0} pts`;
    // Tooltip: quilojaules + faixa de intensidade (quando o save gravou).
    const kj = r.stats?.energyKj;
    if (Number.isFinite(kj)) {
      statsEl.title = `${Math.round(kj)} kJ · ${intensityForKj(kj)}`;
    }

    const actions = document.createElement('div');
    actions.className = 'saved-route-actions';
    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'saved-route-load';
    loadBtn.textContent = 'Carregar';
    loadBtn.addEventListener('click', () => loadSavedRoute(r.id, r.name));
    const linkBtn = document.createElement('button');
    linkBtn.type = 'button';
    linkBtn.textContent = '🔗';
    linkBtn.setAttribute('aria-label', `Copiar link compartilhável de ${r.name || r.id}`);
    // O link é POR NOME (/route/<slug>) — rota legada sem nome não tem link;
    // carregá-la e salvá-la com um nome resolve.
    if (r.slug) {
      linkBtn.title = 'Copiar link compartilhável';
      linkBtn.addEventListener('click', () => copySavedRouteLink(r.slug));
    } else {
      linkBtn.disabled = true;
      linkBtn.title = 'Sem nome — salve a rota com um nome pra ela ter link';
    }
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'danger';
    delBtn.textContent = '🗑';
    delBtn.title = 'Excluir do servidor';
    delBtn.setAttribute('aria-label', `Excluir ${r.name || r.id} do servidor`);
    delBtn.addEventListener('click', () => deleteSavedRoute(r.id, r.name));
    actions.append(loadBtn, linkBtn, delBtn);

    li.append(thumb, nameEl, statsEl, actions);
    savedRoutesList.appendChild(li);
  }
  // Fundos "Morros e Águas" em lote, 3 por vez — best-effort (offline/timeout
  // deixam o card só com o traçado, que já está na tela).
  mapConcurrent(hidroFills, 3, ([svg, proj, key]) =>
    fillThumbHidro(svg, proj, key).catch((e) => console.warn('[thumb-hidro]', e.message)),
  );
}

async function loadSavedRoute(id, name) {
  try {
    const res = await fetch(`./saved-route/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const state = await res.json();
    if (!(await applyShareState(state))) throw new Error('estado sem waypoints');
    currentSavedRouteId = id;
    if (name) defaultSaveName = name;
    closeSavedRoutesModal();
    showToast(`Rota carregada · ${trackpoints.length} pontos`);
  } catch (err) {
    alert(`Falha ao carregar a rota: ${err.message}`);
  }
}

async function deleteSavedRoute(id, name) {
  if (!confirm(`Excluir a rota "${name || id}" do servidor?`)) return;
  try {
    const res = await fetch(`./delete-route/${encodeURIComponent(id)}`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (currentSavedRouteId === id) currentSavedRouteId = null;
    openSavedRoutesModal(); // refresh a lista
  } catch (err) {
    alert(`Falha ao excluir: ${err.message}`);
  }
}

savedRoutesClose?.addEventListener('click', closeSavedRoutesModal);
savedRoutesModal?.addEventListener('click', (e) => {
  if (e.target === savedRoutesModal) closeSavedRoutesModal();
});

// Pull a sidebar route's polyline straight into the drawing tool so the
// user can edit it without round-tripping through a file. The route's
// stored latlngs are already downsampled to ≤400 points by the build
// script; we further sample them down to ≤MAX_EDIT_WAYPOINTS so the user
// gets a manageable number of draggable handles.
const MAX_EDIT_WAYPOINTS = 100;
async function editEntryInDrawingTool(entry) {
  if (!entry || !Array.isArray(entry.latlngs) || entry.latlngs.length < 2) {
    alert('Este traçado não tem pontos suficientes para editar.');
    return;
  }

  if (!drawingMode) enterDrawingMode();
  for (const t of trackpoints) map.removeLayer(t.marker);
  trackpoints = [];
  pendingRouteSeq++;

  let sampled = entry.latlngs;
  if (entry.latlngs.length > MAX_EDIT_WAYPOINTS) {
    sampled = [];
    const stride = (entry.latlngs.length - 1) / (MAX_EDIT_WAYPOINTS - 1);
    for (let i = 0; i < MAX_EDIT_WAYPOINTS; i++) {
      sampled.push(entry.latlngs[Math.round(i * stride)]);
    }
  }

  // Build the editable list as { lat, lng, name, isPoi, sym }.
  const editable = sampled.map(([lat, lng]) => ({
    lat, lng, name: '', isPoi: false, sym: 'Flag, Blue',
  }));

  // Splice in the route's POIs at the cheapest insertion point so each
  // ends up between the two waypoints it sits closest to on the path.
  for (const poi of entry.pois || []) {
    const wp = {
      lat: poi.lat,
      lng: poi.lng,
      name: poi.name || '',
      isPoi: true,
      sym: rwgpsToGarminSym(poi),
    };
    let bestIdx = editable.length; // default: append at end
    let bestCost = Infinity;
    for (let i = 0; i < editable.length - 1; i++) {
      const a = editable[i], b = editable[i + 1];
      const cost =
        haversine(a.lat, a.lng, wp.lat, wp.lng) +
        haversine(wp.lat, wp.lng, b.lat, b.lng) -
        haversine(a.lat, a.lng, b.lat, b.lng);
      if (cost < bestCost) {
        bestCost = cost;
        bestIdx = i + 1;
      }
    }
    editable.splice(bestIdx, 0, wp);
  }

  for (let i = 0; i < editable.length; i++) {
    const wp = editable[i];
    const tp = createTrackpoint(L.latLng(wp.lat, wp.lng), {
      name: wp.name,
      isPoi: wp.isPoi,
      sym: wp.sym,
    });
    if (i > 0) {
      tp.pathFromPrev = straightPath(
        trackpoints[i - 1].marker.getLatLng(),
        tp.marker.getLatLng(),
      );
    }
    trackpoints.push(tp);
  }
  redrawAndMetrics();
  updateTraceControls();

  const bounds = L.latLngBounds(trackpoints.map((t) => t.marker.getLatLng()));
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] });

  // Pre-fill the save name with the route's display label.
  defaultSaveName = (
    [entry.date, entry.name].filter(Boolean).join(' — ') || `Route ${entry.id}`
  );
  pushHistory();

  const poiCount = (entry.pois || []).length;
  const poiTag = poiCount
    ? ` (${poiCount} POI${poiCount === 1 ? '' : 's'})`
    : ' · sem POIs no routes.json — rode `python scripts/build-routes.py`';
  showToast(
    `Editando "${entry.name || entry.date || `Route ${entry.id}`}" ` +
      `· ${trackpoints.length} pontos${poiTag}`,
  );
}

// Distance between two lat/lng pairs in meters (haversine, no Leaflet dep).
// haversine() now imported from lib/utils.js

async function loadGpxIntoEditor(gpxText) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(gpxText, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('XML inválido');
  } catch (err) {
    alert(`Não foi possível ler o GPX: ${err.message}`);
    return;
  }

  // GPX de arquivo é uma rota nova — desvincula de qualquer rota do servidor
  // pra um "Salvar no servidor" seguinte não sobrescrever a errada.
  currentSavedRouteId = null;

  // 0) Default save name from <metadata><name> if present.
  const metaName = doc.querySelector('metadata > name')?.textContent;
  if (metaName) defaultSaveName = metaName.trim();

  // 1) Extensions (our own format) — restores user waypoints + params
  //    cleanly when the file came from this app.
  const metaEls = doc.getElementsByTagNameNS(PHIDRO_NS, 'meta');
  let savedUserWaypoints = null;
  let savedRoutingMode = null;
  let chosenConnectMode = null;   // modo escolhido no modal p/ GPX de terceiros
  let appliedParams = false;
  if (metaEls.length > 0) {
    const meta = metaEls[0];
    const wpEl = meta.getElementsByTagNameNS(PHIDRO_NS, 'userWaypoints')[0];
    const paramsEl = meta.getElementsByTagNameNS(PHIDRO_NS, 'params')[0];
    const rmEl = meta.getElementsByTagNameNS(PHIDRO_NS, 'routingMode')[0];
    try {
      if (wpEl) savedUserWaypoints = JSON.parse(wpEl.textContent || 'null');
    } catch (e) { console.warn('userWaypoints parse failed:', e); }
    try {
      if (paramsEl) {
        const obj = JSON.parse(paramsEl.textContent || 'null');
        if (obj) {
          params = paramsFromAnyJson(obj);
          saveParams();
          fillParamInputs();
          appliedParams = true;
        }
      }
    } catch (e) { console.warn('embedded params parse failed:', e); }
    if (rmEl) savedRoutingMode = (rmEl.textContent || '').trim();
  }

  // 2) Either restore the user waypoints verbatim, or fall back to sampling
  //    the trkpt list (capped) for third-party GPX files.
  let waypointsToCreate;
  if (savedUserWaypoints && Array.isArray(savedUserWaypoints) && savedUserWaypoints.length > 0) {
    waypointsToCreate = savedUserWaypoints;
  } else {
    const coords = [];
    for (const tag of ['trkpt', 'rtept']) {
      const els = doc.getElementsByTagName(tag);
      for (const p of els) {
        const lat = parseFloat(p.getAttribute('lat'));
        const lng = parseFloat(p.getAttribute('lon'));
        if (Number.isFinite(lat) && Number.isFinite(lng)) coords.push([lat, lng]);
      }
      if (coords.length > 0) break;
    }
    if (coords.length === 0) {
      alert('Não encontrei pontos no arquivo GPX.');
      return;
    }

    // GPX de terceiros: pergunta como conectar os pontos. Cancelar aborta.
    chosenConnectMode = await askGpxConnectMode(coords.length);
    if (chosenConnectMode === null) return;

    // 'straight' preserva TODOS os pontos (geometria exata). Os modos roteados
    // reamostram p/ ~100 antes de recalcular o caminho — rotear centenas de
    // pontos densos seria inviável (centenas de chamadas a DEM/viário).
    const MAX = 100;
    let sampled = coords;
    if (chosenConnectMode !== 'straight' && coords.length > MAX) {
      sampled = [];
      const stride = (coords.length - 1) / (MAX - 1);
      for (let i = 0; i < MAX; i++) sampled.push(coords[Math.round(i * stride)]);
    }
    waypointsToCreate = sampled.map(([lat, lng]) => ({
      lat, lng, name: '', isPoi: false, sym: 'Flag, Blue',
    }));

    // Promote any <wpt> to a POI on the nearest waypoint.
    const wpts = doc.getElementsByTagName('wpt');
    for (const w of wpts) {
      const wlat = parseFloat(w.getAttribute('lat'));
      const wlng = parseFloat(w.getAttribute('lon'));
      if (!Number.isFinite(wlat) || !Number.isFinite(wlng)) continue;
      const nm = w.getElementsByTagName('name')[0]?.textContent || 'POI';
      const sm = w.getElementsByTagName('sym')[0]?.textContent || 'Flag, Blue';
      let bestIdx = -1, bestD = Infinity;
      for (let i = 0; i < waypointsToCreate.length; i++) {
        const wp = waypointsToCreate[i];
        const d = (wp.lat - wlat) ** 2 + (wp.lng - wlng) ** 2;
        if (d < bestD) { bestD = d; bestIdx = i; }
      }
      if (bestIdx >= 0 && bestD < 1e-4) { // ~10m
        waypointsToCreate[bestIdx].isPoi = true;
        waypointsToCreate[bestIdx].name = nm;
        waypointsToCreate[bestIdx].sym = sm;
      } else {
        waypointsToCreate.push({ lat: wlat, lng: wlng, name: nm, isPoi: true, sym: sm });
      }
    }
  }

  if (waypointsToCreate.length === 0) {
    alert('Não encontrei pontos no arquivo GPX.');
    return;
  }

  // 3) Enter drawing mode and instantiate the loaded waypoints.
  if (!drawingMode) enterDrawingMode();
  // Wipe any existing draft from the freshly entered drawing session.
  for (const t of trackpoints) map.removeLayer(t.marker);
  trackpoints = [];

  if (savedRoutingMode && ['straight', 'cycling', 'foot', 'energy', 'energy_road'].includes(savedRoutingMode)) {
    routingMode = savedRoutingMode;
    traceRoutingMode.value = savedRoutingMode;
  } else if (chosenConnectMode) {
    routingMode = chosenConnectMode;
    traceRoutingMode.value = chosenConnectMode;
  }

  for (let i = 0; i < waypointsToCreate.length; i++) {
    const wp = waypointsToCreate[i];
    const tp = createTrackpoint(L.latLng(wp.lat, wp.lng), {
      name: wp.name || '',
      isPoi: !!wp.isPoi,
      sym: wp.sym || 'Flag, Blue',
    });
    if (i > 0) {
      // Restaura a geometria exata salva (path por waypoint); só cai pra reta
      // quando o arquivo não a traz (GPX de terceiros ou versão antiga).
      tp.pathFromPrev = (wp.path && wp.path.length >= 2)
        ? wp.path.map((p) => [p[0], p[1]])
        : straightPath(trackpoints[i - 1].marker.getLatLng(), tp.marker.getLatLng());
      // Restaura a marcação de ponte/túnel salva junto — sem ela,
      // flattenDeckProfile() não teria como achatar o perfil sobre o
      // tabuleiro depois do reload (ver snapshot()/restoreSnapshot() acima,
      // que já preservam isso no undo/redo).
      if (wp.deckFlag && wp.deckFlag.length === tp.pathFromPrev.length) {
        tp.pathFromPrev.deckFlag = wp.deckFlag;
      }
      if (Number.isFinite(wp.routedEnergyJ)) tp.pathFromPrev.routedEnergyJ = wp.routedEnergyJ;
      // Proveniência do segmento (modo de roteamento que o produziu).
      if (wp.mode) tp.pathFromPrev.mode = wp.mode;
    }
    trackpoints.push(tp);
  }
  redrawAndMetrics();
  updateTraceControls();

  const bounds = L.latLngBounds(trackpoints.map((t) => t.marker.getLatLng()));
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] });

  // Re-route em segundo plano só os segmentos SEM geometria salva (GPX de
  // terceiros / antigos). Segmentos com path restaurado ficam intactos — não
  // re-roteamos por cima da rota exata que o usuário salvou.
  if (routingMode !== 'straight') {
    const indices = [];
    for (let i = 1; i < trackpoints.length; i++) {
      const wp = waypointsToCreate[i];
      if (!(wp.path && wp.path.length >= 2)) indices.push(i);
    }
    if (indices.length) {
      const routeSeq = ++pendingRouteSeq;
      await mapConcurrent(indices, 4, (idx) => refetchPath(idx, routeSeq));
      redrawAndMetrics();
    }
  }
  pushHistory();

  const bits = [`${trackpoints.length} pontos`];
  if (appliedParams) bits.push('parâmetros aplicados');
  if (savedUserWaypoints) bits.push('waypoints originais restaurados');
  showToast(`GPX carregado · ${bits.join(' · ')}`);
}

// ─── Acessibilidade centralizada dos modais ─────────────────────────────────
// Todos os modais são `<div class="modal" hidden>`. Em vez de reescrever as ~12
// funções open/close, um MutationObserver no atributo `hidden` de cada modal
// aplica a semântica de diálogo + gestão de foco quando ele abre/fecha:
//   • role="dialog" / aria-modal / aria-labelledby (do <h2>/<h3> do cabeçalho);
//   • guarda e devolve o foco (volta pro elemento que abriu o modal);
//   • foca o 1º controle ao abrir e prende o Tab dentro do modal (focus trap);
//   • inerta o fundo (topbar/mapa/sidebar) enquanto há modal aberto;
//   • trava o scroll do body e desliga o zoom-por-scroll do Leaflet.
// ESC fecha o modal do topo clicando no seu `.close` (reaproveita a limpeza das
// funções close* existentes; idempotente com os listeners já presentes). Modais
// com <iframe> (Enviar/Cadastrar/Censo) não recebem focus trap — o foco entra no
// documento filho e não dá pra gerenciar daqui.
(function setupModalA11y() {
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), ' +
    'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const openStack = [];        // modais abertos, na ordem de abertura
  let returnFocusEl = null;    // pra onde devolver o foco quando tudo fechar
  let inerted = [];            // elementos de fundo inertados

  const focusablesIn = (root) => Array.from(root.querySelectorAll(FOCUSABLE))
    .filter((el) => el.offsetParent !== null || el === document.activeElement);

  const bgEls = () => Array.from(document.body.children).filter((el) =>
    !el.classList.contains('modal') &&
    !el.classList.contains('photo-nav-arrow') &&   // setas de navegação de foto ficam ativas sobre o preview
    el.id !== 'toast' && el.id !== 'route-tooltip' &&
    el.tagName !== 'SCRIPT' && el.tagName !== 'TEMPLATE');

  // Foca já e de novo num macrotask — não via rAF: requestAnimationFrame não
  // dispara de forma confiável em aba sem pintura (headless/segundo plano), e o
  // foco não pode depender de um frame de pintura.
  const focusSoon = (el) => {
    if (!el || typeof el.focus !== 'function') return;
    const go = () => { try { el.focus({ preventScroll: true }); } catch (_) {} };
    go(); setTimeout(go, 0);
  };

  // Ao abrir, foca o CABEÇALHO do diálogo (ou o autofocus/conteúdo), não o 1º
  // controle interativo — é o padrão WAI-ARIA (o leitor de tela anuncia o título
  // do diálogo) e evita o caso em que o 1º focável é um <a>: no macOS, com
  // "navegação por teclado" desligada (padrão), o Chrome NÃO foca <a> via
  // .focus() — só controles de formulário. Damos tabindex=-1 ao alvo (fica fora
  // da ordem de Tab, mas focável por código). Recalcula a cada tentativa porque
  // o layout do bottom-sheet pode não estar pronto no microtask do observer.
  const focusModalSoon = (modal) => {
    const pick = () => {
      const t = modal.querySelector('[autofocus]') ||
        modal.querySelector('.modal-content header h2, .modal-content h2, .modal-content h3, h2, h3') ||
        modal.querySelector('.modal-content') || modal;
      if (t !== modal && t.tabIndex < 0 && !t.hasAttribute('tabindex')) t.setAttribute('tabindex', '-1');
      try { t.focus({ preventScroll: true }); } catch (_) {}
    };
    pick(); setTimeout(pick, 0); setTimeout(pick, 80);
  };

  function onShown(modal) {
    if (openStack.includes(modal)) return;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const heading = modal.querySelector('.modal-content header h2, .modal-content h2, .modal-content h3, h2, h3');
    if (heading) {
      if (!heading.id) heading.id = (modal.id || 'modal') + '-title';
      modal.setAttribute('aria-labelledby', heading.id);
    }
    if (openStack.length === 0) {
      returnFocusEl = document.activeElement;
      document.body.classList.add('modal-open');
      try { map.scrollWheelZoom.disable(); } catch (_) {}
      inerted = bgEls();
      inerted.forEach((el) => { el.inert = true; });
    }
    openStack.push(modal);
    focusModalSoon(modal);
  }

  function onHidden(modal) {
    const i = openStack.indexOf(modal);
    if (i === -1) return;
    openStack.splice(i, 1);
    if (openStack.length === 0) {
      document.body.classList.remove('modal-open');
      try { map.scrollWheelZoom.enable(); } catch (_) {}
      inerted.forEach((el) => { el.inert = false; });
      inerted = [];
      const el = returnFocusEl;
      returnFocusEl = null;
      if (el && document.contains(el)) focusSoon(el);
    } else {
      // Modal aninhado fechou (ex.: QR sobre Salvar): devolve o foco pro modal
      // que ficou por baixo em vez de largar no <body>.
      const top = openStack[openStack.length - 1];
      const f = focusablesIn(top);
      focusSoon(f.find((el) => !el.classList.contains('close')) || f[0]);
    }
  }

  function watch(modal) {
    new MutationObserver(() => {
      if (!modal.hidden) onShown(modal); else onHidden(modal);
    }).observe(modal, { attributes: true, attributeFilter: ['hidden'] });
    if (!modal.hidden) onShown(modal);   // raro: modal já aberto no boot
  }

  document.querySelectorAll('.modal').forEach(watch);
  // Modais criados em runtime (ex.: photo-fallback) também entram no esquema.
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType === 1 && n.classList && n.classList.contains('modal')) watch(n);
    }
  }).observe(document.body, { childList: true });

  // Focus trap: prende o Tab no modal do topo (exceto modais com <iframe>, onde
  // o foco vai pro documento filho). Capture pra rodar antes de outros handlers.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || openStack.length === 0) return;
    const modal = openStack[openStack.length - 1];
    if (modal.querySelector('iframe')) return;
    const f = focusablesIn(modal);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    const active = document.activeElement;
    if (!modal.contains(active)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }, true);

  // ESC fecha o modal do topo via seu `.close`. Cobre os modais que não tinham
  // ESC próprio (Ajuda, Ajustes, rotas salvas, compartilhar). Os listeners já
  // existentes fecham o seu antes deste rodar, então aqui ele já sai da lista
  // (sem duplo-fechamento). O guard do modo de edição (ver onMapClickInDrawing)
  // já ignora ESC quando há `.modal:not([hidden])`.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = document.querySelectorAll('.modal:not([hidden])');
    if (!open.length) return;
    const modal = open[open.length - 1];
    const btn = modal.querySelector('.close');
    if (btn) { e.preventDefault(); btn.click(); } else { modal.hidden = true; }
  });
})();
