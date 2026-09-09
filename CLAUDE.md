# Pedal Hidrográfico

Static-PWA web map for an urban cycling collective in São Paulo, plus a
self-hosted backend, Python automation scripts, and an RDF ontology.
Local-first and self-hostable, deliberately built to avoid hard cloud
lock-in — the same backend runs standalone on a laptop or self-hosted server
via `STORAGE_BACKEND=local`, with Cloud Run/GCS (`STORAGE_BACKEND=gcs`) as
one optional hosted deploy target, not a dependency.

## Repo layout

- `web/` — the app. A static PWA: `index.html`, one big `app.js` (single
  file, no build step), `style.css`, `sw.js` (service worker),
  `manifest.json`, icons, `robots.txt`, `sitemap.xml`, `llms.txt` (guia do
  site p/ agentes LLM — aponta pros dumps TTL), `lib/` (vendored deps: `utils.js`,
  `n3.min.js`, `energy-worker.js` + `graph-engine.js` (both vendored verbatim
  from the sibling `sampasimu` repo, the canonical v2 energy engine —
  re-sync by copying both files and re-applying the `AMORA PATCH` reqId
  echo, see the header comment in `energy-worker.js`; `graph-engine.js`
  backs the worker's graph-mode routing, fed by `scripts/build-viario.py`'s
  road network, though amora's own "Menor energia pelo viário" mode
  routes in app.js instead: primary source is the PRE-BAKED binary graph
  `sampa-viario-graph.bin` from `build-viario.py --graph` (per-node elevations
  already sampled at bake time — no DEM/network download per route; see
  `bakedViarioRoute`/`decodeViarioGraph`), falling back to the inline
  `viarioGraphRoute` over the South-America FlatGeobuf (range-request
  bbox reads via the vendored `flatgeobuf-geojson.min.js` —
  `streamFgbFeatures`), then that same FGB's lines rasterized into a
  ~30 m grid mask (`rasterizeRoads`). **There is no Overpass anywhere
  any more** — see "OSM layers come from FlatGeobuf" below),
  `media-pipeline.js` (módulo ES com o pipeline de mídia do `upload_images.html`,
  consumido por `subir.html` — ver acima),
  `flatgeobuf-geojson.min.js` (FGB reader, flatgeobuf 4.4.0),
  `tom-select.complete.min.js`,
  `tom-select.min.css`, `qrcode.js`, `leaflet/` (js+css+images),
  `locatecontrol/` — Leaflet & friends were vendored off unpkg/jsdelivr;
  only app.js's lazy loads (exifr/heic2any/jszip/geotiff) still hit
  jsdelivr; `upload_images.html`/`upload_tour.html` load N3 from the
  vendored `lib/n3.min.js` too — `upload_images.html`'s only remaining CDN
  import is heic2any, prefetched WITHOUT blocking the boot and memoized by
  promise). Leaflet-based map. Also hosts `upload_images.html` (per-photo upload
  form), `upload_tour.html` (per-tour upsert form),
  `backfill_tours.html` (mass-backfill applet for missing tour fields),
  `subir.html` (**envio simplificado**, servido em `/subir` e no modal do
  botão **📤 enviar imgs** da barra — só autora opcional + imagens (fotos,
  vídeos, artes), que sobem ao serem escolhidas; tudo o mais é o default do
  `upload_images.html`: mesmos `POST /upload-image` / `/upload-video` (vídeo
  inteiro, sem recorte nem pré-envio), mesma dedup por pHash/vHash; cada
  imagem enviada ganha ✎ editar (abre `upload_images.html?edit=`) / 🗑
  excluir. O pipeline vem de `lib/media-pipeline.js` — **CÓPIA VERBATIM dos
  helpers do form completo** (pHash/vHash, variantes, EXIF, moov, motores de
  transcodificação), gerada por marcador de função; o form completo NÃO
  importa de lá ainda — mexeu num helper lá, regenere o módulo, senão os dois
  forms divergem e a dedup quebra),
  `censo.html` (aggregated tour metrics + roster, opened as a modal
  iframe from the main app), `upload_videos.html` (permanent redirect
  stub → `upload_images.html`), and the `data/`, `photos/`, `clips/`,
  and `tour_assets/<tour_id>/` directories the app reads from at runtime.
- `backend/` — the self-hosted backend. One Flask service (`main.py`)
  that serves `web/` as static files **and** validates+stores incoming
  photos. No SQLite; state is split across three RDF catalogs:
  `web/data/images.ttl` (media — `ph:StillImage`/`ph:MotionImage` triples;
  was `uploads.ttl` pre-split), `web/data/identities.ttl` (people —
  `schema:Person`, the single source of truth), and `web/data/tours.ttl`
  (tours + associations + route refs), plus
  `web/photos/<phash>/{original,large,thumb}.*` (image variants).
  `web/data/data_graphs.ttl` is a VoID manifest the frontend still follows,
  but the backend no longer mutates it — the dump list is fixed
  (`CATALOG_DUMPS = tours.ttl + images.ttl + identities.ttl`) and
  `/data/data_graphs.ttl` is served from a static shim (`DATA_GRAPHS_SHIM`).
  (`scripts/migrate-split-catalogs.py` is the one-shot that carved
  `uploads.ttl`→`images.ttl`+`identities.ttl` and re-typed the media classes;
  `uploads.ttl` is now obsolete.)
  `phidro.plist` (launchd), `requirements.txt`, `README.md`. Runs locally
  (macOS/Linux) or on Cloud Run. (Was `backend/pi/` — the Raspberry Pi
  deploy was retired; the systemd unit + `pi-deploy.sh` were removed.)
- `research/photos-rdf/` — the RDF research lab. Currently holds
  the seed `data/initial-data.ttl`, `data/tours.csv` (historical
  spreadsheet dump — `build-tours.py`, which regenerated `tours.ttl`
  from it, was removed: `tours.ttl` is now maintained solely via
  `upload_tour.html` / the Tour CRUD endpoints, and a CSV rebuild would
  wipe the backfilled narratives and announcement images),
  `decisions.ttl`, `design.ttl`,
  `conversion-notes.md`, and the legacy `upload-form.html` (kit-download
  form — superseded in production by `web/upload_images.html`). The
  active SHACL `shapes.ttl` and `ontology.ttl` live alongside the data
  in `web/data/`; the backend lazily loads them (bucket-first, container
  copy as fallback) on first validation — a warm-up thread at boot
  (`_warm_caches`, opt-out `PHIDRO_NO_WARMUP=1`) does it in parallel with the
  first request so nobody pays imports + catalog parse on the first upload —
  see `_load_validator` in `backend/main.py`. The former top-level `ontology/`
  dir (v1.1 `pedalhidrografico.ttl` +
  JSON-LD context) was removed — git history is the only reference.
- `scripts/` — `build-routes.py` (**full rebuild** of `routes.json` from
  `web/data/tours.ttl` + RideWithGPS — NOT the normal path: the backend keeps
  `routes.json` incrementally on every Tour CRUD; this is for bake/recovery
  only, then push via `deploy-cloudrun.sh --state`), `build-clips.py`
  (re-encodes raw videos in `web/clips/raw/` to 360p/720p mp4 + `.m4a` audio +
  thumbnail and writes the triples directly into `web/data/uploads.ttl` as
  `ph:Video` — local **batch** tool; the one remaining local catalog-writer,
  push via `deploy-cloudrun.sh --state-only`), `deploy-cloudrun.sh` (Cloud Run
  deploy + `--state` flag to sync
  mutable state; also enables bucket Object Versioning + a lifecycle rule
  idempotently — see Conventions), `pull-cloudrun.sh` (pull mutable state from
  the GCS bucket back to local), `state-history.sh` (list/diff/restore prior
  GCS object generations of a state file — the recovery UX on top of Object
  Versioning), `sync-guard.sh` (anti-clobber guard sourced by
  deploy/pull-cloudrun — see Conventions), `dev-cloudrun.sh` (run the Cloud
  Run image locally; by DEFAULT in `--hosted-data` mode — `STORAGE_BACKEND=gcs`
  against the PRODUCTION `phidro-state` bucket via the machine's gcloud ADC,
  with `PUBLIC_BASE_URL` pinned to production so tour edits don't bake
  localhost URLs (the PH/96 gotcha) and a best-effort `POST /reload` to
  production on exit (its in-memory caches don't see out-of-band bucket
  writes); `--local-data` keeps state in the repo files, the old behavior —
  the `deploy-amora.sh` / `pull-amora.sh` /
  `push-clips.sh` / `gcloud-ssh-rsync.sh` / `pi-deploy.sh` family for the
  old GCE VM and Raspberry Pi deploys was removed; amora is Cloud Run now),
  `remux-clips-audio.py` (one-shot migration: muxes audio back into
  pre-v225 silent `web/clips/*.webm` that were transcoded before audio
  was embedded — see the upload-flow note below; removable once all
  clips are re-encoded), `migrate-bnodes-to-iris.py` (one-shot migration:
  converted the historical blank nodes in `tours.ttl`/`uploads.ttl` into the
  derived-IRI convention — idempotent, removable once it's clearly not needed
  again), `build-viario.py` (data-prep, not runtime: builds the road-network
  **FlatGeobuf** `south-america-viario.fgb` from Geofabrik's
  `south-america-latest.osm.pbf` (~4 GB, cached in `ignore/`) via
  `osmium tags-filter w/highway` + `ogr2ogr -f FlatGeobuf` with a
  script-written minimal osmconf that promotes `bridge`/`tunnel`/`layer` to
  real columns (raw OSM values — the client normalizes); `--water` emits two
  more FGBs (`south-america-water-areas.fgb` polygons +
  `south-america-water-rivers.fgb` river lines; FGB is single-layer);
  **`--layers`** emits the two MAP-LAYER FGBs that replaced Overpass —
  `south-america-hidro.fgb` (`waterway=*` + `natural=ridge` lines, with
  `tunnel`/`name`) for "Morros e Águas" and `south-america-cicloinfra.fgb`
  for "Cicloinfra OSM" — plus the tiny `ph-cycle-network.geojson`
  (`cycle_network=BR:PedalHidrografico` relations, fetched whole);
  **`--no-viario`** skips the expensive 4.5 GB viário build and is what the
  weekly CI job runs. Two gotchas baked into the script: GDAL **sanitizes
  `cycleway:left` → `cycleway_left`** (that's the name in `-select`, in
  `-where`, and in `props.*` on the client), and `osmium tags-filter` is a
  UNION with no value regex — so cicloinfra pre-filters a cheap superset and
  the exact predicate lives in ogr2ogr's `-where`. All of it —
  feeding the browser's "Menor energia pelo viário" fallback routing and
  terrain-mode water/corridors/portals via **HTTP range requests** against
  FGB's packed Hilbert R-tree (only the bbox's bytes are fetched — that's
  what made continent-wide coverage viable vs the old full-download ~125 MB
  SP-only gpkg); `--graph`/`--graph-only` additionally bakes
  `sampa-viario-graph.bin`, the binary CSR graph with per-node elevations
  (SP DEM ~5 m where covered, FABDEM elsewhere, via /vsicurl) and
  bridge/tunnel decks flattened — the PRIMARY road-routing source the app
  downloads (~33 MB gzipped), still clipped to the SP `GRAPH_BBOX` (DEM
  coverage rules; read from the FGB via the GDAL Python bindings).
  **Elevations get the σ map treatment** (`--graph-sigma`, default 30 m =
  app.js's `demSmoothSigmaM`) over the FUSED mosaic before per-node
  sampling — the baked graph used to be the one routing consumer reading RAW
  relief, and the sub-cell noise inflated h₊ (a flat 5.5 km stretch priced
  110 kJ raw vs 79 kJ treated, against a 66 kJ route-level estimate). The
  fuse also drops SP-DEM cells disagreeing with FABDEM by >100 m
  (`SRC_DISAGREE_MAX_M`): that DEM records ~95k holes as *0 m*, and the old
  bake sampled them straight (production had nodes at 0.2 m inside São
  Paulo). `--graph-src` accepts a `/vsicurl/https://…`, so a re-bake needs
  no 4.5 GB FGB download — the index serves just the bbox. Upload:
  `gcloud storage cp --cache-control="public,max-age=86400" ignore/*.fgb
  gs://telhas/viario/` — **never `-Z` on the .fgb**: `Content-Encoding:
  gzip` breaks GCS range requests, which the client depends on; the graph
  bin keeps `-Z` (`gcloud storage cp -Z ignore/sampa-viario-graph.bin
  gs://telhas/viario/`, downloaded whole). Producer for the consumer
  described under `lib/graph-engine.js` above),
  `migrate-fabdem-r2.py` (migração one-shot do `fabdem/` de `gs://telhas`
  pro R2 da Cloudflare SEM egress do GCS: re-baixa o upstream FABDEM V1-2
  de Bristol em zips 10°×10° via aria2 segmentado (Bristol throttla
  ~0,5 MB/s POR CONEXÃO; 16× escala quase linear) e re-aplica a conversão
  que gerou o espelho — o `fabdem/` do GCS NÃO é o upstream verbatim, é
  **COG** (LZW, blocos 512, overviews 1800/900/450, dos quais o zoom baixo
  do cameratopo depende) — e sobe via rclone pro bucket `fabdem`. Contrato =
  `ignore/fabdem-migration/manifest.tsv` (listagem do espelho); retomável
  (pula o que já está no R2), blocos da América do Sul primeiro, guard de
  disco (a máquina tinha ~14 GB livres — processa 1 zip por vez). `--verify`
  fecha a paridade por NOME (tamanhos divergem por construção); tiles sem
  upstream vão pra `missing-upstream.txt` (cobertos pelo `--egress-fallback`,
  o plano B pago ~US$0,12/GB). Consumidores a repontar depois (Fase 3):
  `web/app.js` `FABDEM_BASE_URL`, `scripts/build-viario.py` `FABDEM_BASE`,
  `cameratopo/render.py`, `quilojaules/app.js`),
  `audit-captura.py` (**o motor da auditoria de captura** — cruza
  `tours.ttl` + `images.ttl` + o acervo do Drive e diz, por passeio, o que
  falta nos três funis; `--sync` grava os passes de coleta via
  `POST /upload-tour mode=patch`, `--slug-map` emite
  `scripts/whatsapp-slug-map.json` pra revisão humana. Lê o Drive em modo
  SOMENTE-LEITURA e só metadados — os arquivos são stubs do Google Drive e
  abrir um força download; ler os 8 mil puxaria ~13 GiB. Ver `docs/CAPTURA.md`),
  `import-activities-censo.py` (importa `ph:linkActivity` da planilha do censo,
  casando por URL da rota → data exata → data ±1; NUNCA por número de edição,
  que colide),
  `backfill-activities.py` (deriva saída/chegada/movimento/energia medida a
  partir da gravação GPS — **atenção: a gravação inclui o trajeto de casa até
  o ponto de encontro; a janela do passeio é um SUBCONJUNTO dela.** No PH/81 a
  gravação inteira dá 927 kJ contra os 328 kJ reais do pedal),
  `ingest-drive.py` (fase 1 da ingestão do acervo: só os originais com
  EXIF/GPS — os 2 achados críticos da revisão de 07/2026 foram corrigidos em
  09/2026: GPS 0/0 é rejeitado (`gps_valido`) e large/thumb saem convertidos
  pra sRGB (`para_srgb`, sem copiar o ICC de volta); dedup só contra fotos;
  rede com certifi + UA próprio), `ingest-whatsapp.py` (**fase 2**: os
  ~6.400 JPEGs + ~1.300 MP4s do WhatsApp, sem EXIF — entram como
  `ph:StillImage` SEM `ph:GeoreferencedImage` (nunca viram marcador),
  `dcterms:date` = data/hora DO PASSEIO (`ph:departedAt` ou a do tour),
  `schema:datePublished` = carimbo de compartilhamento do nome do arquivo,
  `schema:creditText` = slug cru de quem compartilhou (join via
  `schema:alternateName`, como o `ph:sweepContributor`), e
  `pav:providedBy` + `prov:wasAttributedTo` só quando o
  `whatsapp-slug-map.json` resolve a pessoa; vídeos (`--videos`) via ffmpeg —
  vhash de 8 quadros como o form, audio.webm + 360p.webm + thumb, sem 720p;
  rode a fase 1 ANTES: a cópia do zap deduplica contra o original por Hamming
  e a versão com GPS vence). **Os dois pré-baixam os stubs do Drive em
  paralelo** (`prewarm`, 32 threads): lidos um a um materializam a ~250 KB/s
  (latência por arquivo), em paralelo ~5× mais; `ingest-whatsapp` pré-baixa
  em lotes de 256),
  `migrate-captura-fixes.py` (reparos de catálogo: arte em host local, datatype
  de `ph:sequenceInSeries`),
  `migrate-date-offsets.py` (one-shot: repara os offsets UTC das
  `dcterms:date` de mídia que o bug do owlrl deslocou — ver Conventions;
  textual, dry-run por default, `--apply` grava; round-trip pull → script →
  `deploy-cloudrun.sh --state-only` → `POST /reload`),
  `gen-synthetic-rdf.py`, `mock_location.sh` (empurra posições de
  teste da localização ao vivo pro backend — random walk, 1 ponto/3 s; bate no
  remoto amora por padrão, `--local` p/ 127.0.0.1:8080; curl não precisa de
  CORS), `exiftool_ph.config`.
  `build-photos.py` and
  `build-routes.mjs` are legacy artefacts pending removal — see "Open
  loose ends".
- `docs/` — design-reference notes not loaded at runtime. `DESIGN.md`
  (RDF substrate / ontology design rationale), `ICON_DESIGN.md` (PWA
  icon decisions) and `CAPTURA.md` (**captura de dados**: os três funis
  — chamado / censo / mídia —, o passe de coleta `ph:MediaSweep`, o ritual
  semanal e o plano da fase 2 da ingestão do acervo). Excluded from the
  Cloud Run container.
- `capacitor/` — native iOS/Android shell (Capacitor) that wraps the SAME
  web app. `capacitor.config.json` points `server.url` at
  `https://amora.pedalhidrografi.co` (loads the published site —
  `location.origin` stays amora, so no CORS), with the
  `@capacitor-community/background-geolocation` plugin. The one thing it buys
  over the PWA: **Localização ao vivo keeps transmitting with the screen off /
  app backgrounded** (the background bridge lives in `web/app.js` —
  `window.phidroLivePush`). `run-ios.sh` / `run-android.sh` build+deploy to a
  physical device via `npx cap run` without opening Xcode/Android Studio;
  `npm run icons` regenerates app icon + splash from `assets/` via
  `@capacitor/assets`. `README.md`, plus gitignored `android/`, `ios/`,
  `www/`, `node_modules/`. Edits to `web/` alone need NO native rebuild — the
  app loads the remote site (so iterate by deploying `web/`, not rebuilding).

## IRIs são dereferenciáveis (Linked Data) — esquema atual

**Todos os IRIs de instância + o vocabulário migraram pra
`https://id.pedalhidrografi.co/` e DEREFERENCIAM** (padrão httpRange-14). A
Cloudflare faz um 303 path-preserving de `id.pedalhidrografi.co/<path>` →
`amora.pedalhidrografi.co/<path>`, onde handlers Flask respondem por content
negotiation: `Accept: text/turtle` (ou `?format=ttl`) → as triples do recurso;
senão a página/documento humano. Esquema (prefixos usados nos TTLs e no código):

| Coisa | Prefixo | IRI | Resolver (amora) |
|---|---|---|---|
| Vocabulário | `ph:` | `…/terms#<Termo>` | `GET /terms` (turtle=ontology.ttl \| HTML doc) |
| Pessoa | `pes:` | `…/pessoas/<slug8>` | `GET /pessoas/<slug>` (turtle \| pessoas.html) |
| Passeio | `pas:` | `…/passeio/<slug8>` | `GET /passeio/<slug>` (turtle \| index SSR'ado servido NO path) — aceita também o **slug legível** (`schema:identifier`, mintado do título no save e IMUTÁVEL; slug8 com legível disponível 303a pra ele; `?tour=` e id numérico legado 303am pra cá). É a URL canônica dos links (compartilhar/sitemap/feed/memória); routes.json espelha em `entry.slug` |
| Edição de série | (IRI full) | `…/passeio/<ES>/<seq>` (ex.: `…/passeio/BP/4`) | `GET /passeio/<es>/<seq>` (turtle \| 303 pro passeio) |
| Série | `ser:` | `…/serie/<ES>` (PH/BT/BP/S/SESC) | `GET /serie/<es>` (turtle=série+edições \| HTML gerada, edições mais recentes primeiro, linkando pro passeio) |
| Mídia | `med:` | `…/midia/<hash16>` (opaco — foto OU vídeo) | `GET /midia/<hash>` (turtle \| 303 `/imagens.html?pick=`) |
| Lista/álbum | `lst:` | `…/listas/<slug>` | `GET /listas/<slug>` (turtle \| 303 `/imagens.html`) |
| Envio (ph:Upload) | `env:` | `…/envio/<ts>` | (sem resolver; provenance interna) |

Invariantes: o hash é a IDENTIDADE da mídia e o localname do IRI é ele SOZINHO
(`med:<hash16>`, opaco — sem discriminador image_/video_; uniforme com pessoas/
passeios). O TIPO (foto/vídeo) vem SEMPRE da CLASSE `ph:StillImage`/
`ph:MotionImage`, nunca do IRI; os blobs `photos/<phash>/…` e a dedup dependem do
hash. Como phash e vhash compartilham o espaço de 16 hex, o backend tem uma
GUARDA cross-type no upload: rejeita um phash que já existe como vídeo (e
vice-versa), senão os dois virariam o mesmo IRI. Links de compartilhamento
antigos (`?p=`/`?pick=image_<hash>`) e `/midia/image_<hash>` seguem funcionando
(o prefixo é tirado na leitura). Nós derivados mantêm o sufixo
`_` (`pas:<slug>_route`, `med:image_<ph>_geo|_hash`) — o purge do backend é
aritmética de prefixo `str(root)+"_"`, agnóstica ao formato do IRI. Slug =
Crockford base32 (`0123456789abcdefghjkmnpqrstvwxyz`, 8 chars) pra pessoas e
passeios; validador de tour REJEITA `_` (colidiria com o nó derivado). Séries e
edições são chaves naturais (edição = `…/passeio/<ES>/<seq>`, realizada por
EXATAMENTE um passeio — colisão de numeração vira edição distinta, ex.: `BP/3-5`;
SHACL `ph:SeriesEditionShape` impõe isso).

**`phd:` = `https://pedalhidrografi.co/data/` (host ANTIGO) ainda aparece:** só em
`ph:capturedDuring`→`pas:` (migrado), nos IRIs derivados como convenção, e em
menções históricas nos comentários deste arquivo — onde o texto abaixo diz
`phd:image_`/`phd:video_`/`phd:tour_`/`phd:assoc_`, leia `med:<hash>` (foto E
vídeo)/`pas:<slug>`/`<…/passeio/<ES>/<seq>>`. `phd:org_` (organizadores) NÃO
migrou (fora de escopo). A migração foi feita por scripts idempotentes
(`scripts/migrate-{georeferenced,lists-split,media-host,tour-iris,editions}.py`),
com `scripts/tour-iri-map.json` (id-numérico antigo ↔ slug) baked no container.

**Continuidade de deep link + gotcha da Cloudflare.** Links antigos
`?tour=<id-numérico>` são preservados: o worker da Cloudflare que fronteia amora
reescreve `/` → `/index.html` ANTES de chegar na origem, então `index()` está
registrado em `@app.get("/")` E `@app.get("/index.html")` — senão o SSR por
passeio e o 303 de alias (`?tour=<numid>` → `?tour=<slug>`, via
`_tour_iri_map`/`_legacy_tour_iri`) não rodariam via amora. `app.js` também
resolve o alias no cliente (busca `/data/tour-iri-map.json` sob demanda) como
defesa. Guid do feed emite o IRI legado `phd:tour_<numid>` pra passeios migrados
(RSS estável). Resolvers path-based não sofrem com o strip de query (só `?query=`
era afetado; paths sempre chegam). **Só `amora.pedalhidrografi.co/?query=` era
afetado — os IRIs `id.…/<path>` sempre preservam.**

**Markdown pra agentes (3ª representação) + descoberta.** Toda página HTML
negocia também Markdown: `Accept: text/markdown` (ou `?format=md`) devolve a
mesma URL em Markdown limpo. `_negotiated_format()` é o ÚNICO negociador
(`ttl`|`md`|`html`; `_wants_turtle`/`_wants_markdown` são atalhos) e
`_markdown_response()` monta a resposta (`text/markdown`, `x-markdown-tokens`
estimado a ~4 chars/token, `Content-Signal` — env `CONTENT_SIGNAL`, default
igual ao do "Markdown for Agents" da Cloudflare, vazio desliga — e
`Vary: Accept`). Renderers: home = `llms.txt` + passeios recentes
(`_render_home_markdown`); passeio (`_render_tour_markdown`, fatos via
`_tour_facts`, compartilhados com o SSR HTML); Memória
(`_build_memoria_markdown`, cache por digest como o HTML); série
(`_series_rows` alimenta HTML e MD), pessoa, mídia, lista (os três leem o
`_load_catalog()` cacheado), `/terms` (`_terms_model` alimenta HTML e MD);
qualquer outro `.html` estático vira um resumo — título + descrição +
ponteiros pros dados (`_html_shell_markdown`). HTML segue o default: `*/*` e
`text/html` caem nele; só um Accept que PREFERE markdown/turtle sai dele.
**`Vary: Accept` só vai em resposta GERADA** (`_negotiated()`), nunca nos
estáticos que o SW pré-cacheia (index/pessoas/imagens.html): o Cache API
compara o Accept do request guardado (addAll por string, sem Accept) com o de
navegação, e o shell offline pararia de casar. Descoberta (RFC 8288/9727): o
`after_request _discovery_links` põe um `Link` em toda resposta 200
HTML/Markdown — `api-catalog` → `/.well-known/api-catalog` (linkset JSON
gerado, `api_catalog()`), `service-desc` → `web/openapi.json` (**mantido à
mão** — atualizar quando um endpoint de leitura mudar), `service-doc` →
`llms.txt`, `describedby` → o manifesto VoID, `alternate` → o feed. Gotcha
Cloudflare: se uma cache rule cachear o HTML de `/` ignorando o Accept, um
agente pode receber o HTML cacheado — ou bypassar o cache pra
`Accept: text/markdown`, ou ligar o "Markdown for Agents" da zona (coexiste:
a CF só converte HTML e passa o `text/markdown` da origem intacto).

## Architecture

The app is fully static and works offline (service worker). It reads
pre-baked `routes.json` and resolves Turtle dumps via the manifest at
`web/data/data_graphs.ttl` (which currently lists `tours.ttl` and
`uploads.ttl`). When served by the backend (local or Cloud Run), uploads hit
`POST /upload-image` or `POST /upload-video` same-origin; on a static-only
host (CDN) the form is offline-friendly but uploads have nowhere to go.

**Photos and videos are described in RDF/Turtle** in the
`web/data/images.ttl` catalog. Both are subclasses of an **abstract base
`ph:Image`** ("mídia visual"), which carries the shared shape (date,
`schema:locationCreated`→`schema:GeoCoordinates`, `ph:capturedDuring`,
author, license, provider, `schema:isPartOf`) via `ph:VisualMediaShape`
(`sh:targetClass ph:Image`, applied to both subclasses through the
validator's `inference="rdfs"`). SHACL shapes live in `web/data/shapes.ttl`:

- `ph:StillImage` (foto; `rdfs:subClassOf ph:Image, schema:ImageObject`) —
  `phd:image_<phash16>` IRI; `phash` is a 64-bit perceptual hash (DCT-based,
  computed in the browser); near-duplicate uploads share an IRI and
  naturally cluster. `StillImageShape` adds the still-only constraints:
  bearing (`exif:gpsImgDirection`), focal (`exif:focalLengthIn35mmFilm`),
  `nfo:hasHash`, `ph:anonymized`, `ph:compressed`.
- `ph:MotionImage` (vídeo; `rdfs:subClassOf ph:Image, schema:VideoObject`) —
  `phd:video_<vhash16>` IRI; `vhash` is computed by sampling N=8
  evenly-spaced frames, taking each frame's pHash, and majority-voting per
  bit into a single 16-hex fingerprint. Doesn't inherit bearing/focal
  (which don't apply to video). `MotionImageShape` adds `schema:duration`,
  `ph:availableResolution` (`sh:in` of `audio/360p/480p/720p/1080p`),
  `ph:audio`, optional `ph:video360p` / `ph:video720p`, and
  `schema:thumbnail`. (Was `ph:Video`, renamed in the class-hierarchy
  refactor; the `phd:video_` IRI prefix is unchanged.)

**Nested nodes are minted IRIs, not blank nodes.** The `schema:GeoCoordinates`
(`schema:locationCreated`), `nfo:FileHash` (`nfo:hasHash`), and
`ph:RouteReference` (`ph:linkRoute`) sub-objects use deterministic IRIs derived
from the parent — `<parent>_geo`, `_hash`, `_route` (e.g.
`phd:image_<phash>_geo`, `phd:tour_1_route`). (`ph:energyEstimate` /
`ph:measuredEnergy` used to mint `_energy` / `_measured` `qudt:QuantityValue`
nodes too, but were **flattened to plain `xsd:decimal` kJ literals on the tour**
— the unit is implicit (kJ) and `ph:intensityClassification` was dropped, since
intensity is derivable from the kJ value by fixed bands and is computed in
readers.) The trailing `_` keeps siblings
distinct (`phd:tour_1` never prefix-matches `phd:tour_10`). This is what makes
deletion/merge trivial: purging a subject = removing `(subject, *, *)` plus the
`<subject>_*` derived IRIs (`_derived_subjects` / `_purge_subject` in
`backend/main.py`), with no blank-node-reachability walk. Both the TTL emitters
(`upload_images.html`, `upload_tour.html`, `backfill_tours.html`,
`scripts/build-clips.py`) and the validator's re-upload `exclude` set rely on
this prefix convention. (`scripts/migrate-bnodes-to-iris.py` converted the
historical bnode data — git history holds the pre-IRI form.)

Key flows:

- **OSM layers come from FlatGeobuf — there is NO Overpass.** "Morros e
  Águas" and "Cicloinfra OSM" used to live-query the Overpass API on every
  pan/zoom. They now range-request `south-america-hidro.fgb` /
  `south-america-cicloinfra.fgb` from the same host as the viário, through
  one shared driver (`makeOsmFgbLayer` in `web/app.js`) whose only per-layer
  parts are `styleFor(props, detail)` / `tipFor(props)`. Notes:
  - **The layer id stays `osm-overpass`** even though Overpass is gone — it
    is the localStorage key for that layer's visibility/opacity, and
    renaming it would orphan every user's saved preference (same reasoning
    as the historical `useViarioGpkg` key).
  - **Gating is by bbox AREA, not zoom.** The old `zoom >= 13` rule existed
    to spare a shared public server; that reason died with Overpass. What
    still costs is bytes fetched + Leaflet render, and both scale with
    viewport area (which depends on screen size, not zoom level). So:
    `> OSM_FGB_MAX_BBOX_KM2` (8000) → don't query; `> OSM_FGB_FULL_BBOX_KM2`
    (1200) → `DETAIL_MAIN`, where `styleFor` returns **null** for the
    long tail (ditch/drain/stream, painted bike lanes) so only rivers,
    canals, ridges and segregated cycleways draw. `OSM_FGB_MAX_FEATURES`
    is the last-resort cap.
  - These layers call `streamFgbFeatures(url, bb, **false**)` — the third
    arg bypasses the shared 10-slot LRU, which they would otherwise fill
    with whole viewports of features (they re-query on every pan and
    re-render from scratch anyway; the *bytes* stay in the browser's HTTP
    cache).
  - Rebuilt **weekly** by `.github/workflows/build-fgb.yml` (free: the repo
    is public). It reuses deploy.yml's keyless WIF and is inert until those
    repo vars exist. It runs `--no-viario --water --layers`, so the 4.5 GB
    viário FGB and the baked graph are NOT in the weekly path —
    `workflow_dispatch` has a `viario` input for those.
  - **Coverage regressed to South America** (the extract the pipeline
    already used). Overpass worked worldwide. Outside SA the layers are
    empty and "pelo viário" falls through to free-energy routing.
- **Display.** `web/app.js` fetches `./data/data_graphs.ttl`, follows each
  `void:dataDump` IRI to load the constituent graphs (currently `tours.ttl`
  and `uploads.ttl`), parses them with the bundled N3.js
  (`web/lib/n3.min.js`), and renders one Leaflet marker per `ph:Image`
  AND `ph:Video` (videos use the same `photoDivIcon` markup as photos with
  a red-orange border modifier `.photo-dot-video`; both participate in the
  same density-based clustering via `relaxPhotoMarkers`). GPS from
  `schema:locationCreated`, popup from triples. The **layer panel** gained
  per-row action icons (fixed column: ▲/▼ to stack inline — the old ordering
  modal was removed — plus an action icon: ☰ Rotas / 📍 Compartilhar / ✨
  Animação / ⬆ Enviar / ✎ or ⚙ config / 🗑) and persists per-layer
  visibility + opacity across sessions. The **Destacar rota ★** button in a
  route's modal draws a ~1.5×-thicker copy and materializes the **Rota
  destacada** layer (hidden until a highlight exists; its 🗑 clears it —
  `addRouteHighlight` / `clearRouteHighlight` / `setRouteHighlightRow`). In the
  trace-edit toolbar the old **Editar** is now **📂 Carregar** (`#trace-load`,
  opens the load-route modal). The **Configurações** modal
  (gear icon in the topbar) lets the user switch between Servidor
  (same-origin; persisted source value `'server'`, legacy `'pi'` is migrated
  on load), CDN, or Local (kit ZIP file picker — stored in memory, image
  URLs become blob URLs). Import/export buttons live there.
- **Upload (unified — images AND videos in one page).**
  `web/upload_images.html` accepts `image/*,video/*` via a single picker;
  each card detects media type from the file MIME and renders the
  appropriate body. Image cards: EXIF auto-fill, anonymize/compress
  toggles, three variants (`original`/`large`/`thumb`) POSTed to
  `/upload-image`. Video cards: trim sliders + steppers, GPS extraction
  from moov ISO 6709 atom, recording-date extraction from
  `com.apple.quicktime.creationdate` (ISO 8601 with TZ regex; falls back
  to mvhd binary uint32 seconds-since-1904), browser-side transcoding to
  webm/(vp9 or vp8)+opus 360p+720p with the **audio embedded in the video
  webm** (so the ghost-video player has sound on iOS Safari, which mutes
  `MediaElementAudioSourceNode` in some configs); a separate `audio.webm`
  (opus) is *also* emitted so the audio loop can play without downloading
  the full video. Thumbnail from frame ~5% in,
  per-card "Apenas áudio" toggle for audio-only clips, POSTed to
  `/upload-video`. Both flows share tour auto-detection (±2h/+12h window)
  and the Tom Select people picker with create-on-the-fly. pHash/vHash
  dedup prevents accidental re-uploads in the same batch AND against
  what's already on the server (catalog includes both hash sets at boot).
  `upload_videos.html` is a permanent redirect stub to
  `upload_images.html` for bookmarked URLs.
  **O vídeo é preparado em segundo plano e pré-enviado** (v400): o recorte
  é identificado por `clipParams(card).key` (início|fim|áudio-só|hd);
  `ensureProcessed` memoiza o processamento por key em `card.proc` (um
  `AbortController` cancela o de key diferente em voo) e a preparação
  ESPECULATIVA (`scheduleSpeculativeTranscode`, debounced) dispara na
  ativação do card e a cada `change` do recorte/checkboxes; ao terminar,
  `stageClip` sobe os blobs pra `POST /stage-video/<vhash>` e o Enviar manda
  só o TTL (`staged=1`) — 409 `staging-missing` faz o cliente reenviar com os
  blobs. `processClip` escolhe o motor: **WebCodecs** via a `mediabunny`
  vendorada (`lib/mediabunny.min.mjs`, MPL-2.0, import dinâmico; só quando o
  browser ENCODA VP9/VP8 + opus — Safari não, cai fora) → `transcodeClip`
  (MediaRecorder, passe único, tempo real) → sequencial. A miniatura sai do
  próprio passe (CanvasSink / canvas no primeiro quadro ≥ 5 % do recorte).
  **720p é opcional por card** (checkbox HD, default = não-touch, persistido
  em `phidro:uploadHd`); o TTL só emite `ph:video720p`/`"720p"` quando o blob
  existe — `app.js` já cai pro 360p. `?slow=1` força o MediaRecorder (debug).
  Testado headless (Chrome, `scratchpad/e2e.mjs`-style): clipe de 8 s
  preparado+pré-enviado em ~1,5 s, Enviar em 0,3 s.
- **Validation.** `pyshacl` loads `web/data/shapes.ttl` +
  `web/data/ontology.ttl` once per process. The validator merges the
  incoming TTL with the ontology before checking — `pyshacl`'s `ont_graph`
  parameter does NOT expose ontology-declared instances (like
  `ph:rwgps a schema:Organization`) to `sh:class` checks, so manual
  merging is mandatory. See `docs/DESIGN.md` §2 for the
  full gotcha. `validate_image_ttl` and `validate_video_ttl` are siblings
  that each pin to their target class + IRI prefix. **The validation
  universe is scoped** (`_validation_universe`): fragment + ontology + only
  the `rdf:type` triples of the nodes the fragment references (what the
  shapes' `sh:class` checks need) — plus, for tours, the incoming
  `ph:inSeriesEdition` edges from OTHER tours (the SeriesEditionShape's
  "exactly one tour per edition" inverse-path count). Merging the whole
  catalog (~14k triples) cost ~1.3–1.6 s of rdfs closure + SHACL per save
  under `_validate_lock` — i.e. it serialized every upload; the scoped
  universe takes ~30 ms with byte-identical verdicts (violations AND
  warnings, parity-checked over every tour/video and 60 photos). If a shape
  ever needs OTHER catalog context (a new inverse path, a `sh:sparql`),
  extend `_validation_universe` — don't go back to merging the catalog.
- **Clips / Animação.** The "Animação" topbar button toggles both the
  marker spotlight pulse AND a ghost-video overlay (translucent `<video>`
  over the map). The app reads `ph:Video` entries from `uploads.ttl` via
  `loadClipsFromUploadsTtl()` — files live under `./clips/`. Plays through
  clips in random order with a 5-state marker handoff (green intro →
  pulsing white → orange outro). Clips with `audioOnly: true` (no
  `ph:video360p`/`ph:video720p`) are skipped by the ghost-video player but
  still participate in the audio loop. An independent "Loop de áudio"
  plays the same clips' audio-only tracks with a longer crossfade for
  ambient use. Both have controls in Ajustes and the layer panel.
- **Deletion.** `POST /delete-image/<phash>` and
  `POST /delete-video/<vhash>` purge the IRI's triples (plus its `<iri>_*`
  derived IRIs) from `uploads.ttl` AND delete the underlying blobs from the
  store. The frontend popups have a red-orange Excluir button gated by a
  `confirm()` dialog.
- **Localização ao vivo.** A camada "Pessoas ao vivo" (painel de camadas;
  ligada por default só p/ VER — nunca arranca transmitindo, por privacidade)
  faz polling de `GET /live-locations` e desenha cada pessoa: marcador
  `divIcon` com anel colorido + inicial + (opcional) seta de rumo, esmaecendo
  via `.is-stale` quando o fix envelhece. O rastro é uma linha ligando os
  fixes + pontos cujo tamanho reflete a `accuracy` de cada um (o slider da
  camada controla a opacidade dos pontos, `_liveBandOpacity`). Clicar numa
  pessoa abre um popup p/ ajustar cor/opacidade/esconder o histórico dela
  (persistido em `phidro:livePersonOverrides`). O ícone 📍 da linha abre um
  modal (apelido + retenção hh/mm do rastro, default 3 h) e liga/desliga a
  transmissão da própria posição (token = `crypto.randomUUID()` por
  dispositivo, POST `/live-location`; no browser via `watchPosition`, no shell
  nativo via background-geolocation com a tela apagada). Ver e transmitir são
  flags independentes (`_liveViewing` / `_liveSharing`), reconciliados por
  `applyLiveLocation` a cada mudança de Ajustes / `visibilitychange` /
  `pageshow`.
- **Tour CRUD & Censo.** `POST /upload-tour` accepts a TTL fragment
  describing exactly one `phd:tour_<id> a ph:Tour` (plus any new
  `phd:pessoa*` / `phd:assoc_*` declarations it references) and upserts
  it into `web/data/tours.ttl`. Two modes via the `mode` form field:
  `replace` (default — the TTL is the tour's complete new state,
  purge-and-replace; right for creation) and `patch` (predicate-level
  merge-patch — only predicates asserted in the TTL, plus those listed
  in the comma-separated `remove` form field as CURIEs/IRIs, replace
  the existing ones; everything else survives, so clients don't have
  to round-trip predicates they don't know about). Patch is synthesized
  server-side into the equivalent full document inside the state lock
  (`synthesize_tour_patch`), so SHACL validates the FINAL state and the
  rest of the pipeline (announcement injection, route sync) is shared.
  Both forms use patch for edits; creation stays on replace. An optional
  `announcement` file field is saved under
  `tour_assets/<tour_id>/announcement.<ext>` and wired in as
  `schema:image <URL>` before the triples are persisted (under `patch`,
  a new file also replaces the current `schema:image`).
  `POST /delete-tour/<tour_id>` removes the tour's triples + its `<iri>_*`
  derived IRIs and purges `tour_assets/<tour_id>/`; it deliberately does NOT
  delete referenced `phd:pessoa*` or series — git history preserves
  those and they may be referenced by other tours.
  On every `/upload-tour` and `/delete-tour`, the backend also **syncs
  `routes.json` incrementally**: if the tour (read from the PERSISTED
  `tours.ttl`, not the posted fragment — the entry's series numbering
  resolves `phd:assoc_*` subjects that live outside the fragment) has a
  `ph:linkRoute` pointing at a RideWithGPS route **ou numa rota salva do
  próprio amora** (`…/route/<slug>`, provider `ph:amora` — o segundo provedor
  suportado), it fetches the geometry and upserts that tour's entry (keyed by
  `tourIri`, with a `provider` field: `"rwgps"`/`"amora"`, ausente = rwgps
  legado); if the link is absent (new/edited tour with no route) or the tour
  is deleted, it removes the entry. The RWGPS
  fetch runs **outside** the global state lock (only the JSON read-modify-
  write is serialized) and is best-effort — a fetch failure never fails the
  tour save (the entry is kept with `latlngs:null` + `error`, same convention
  as `build-routes.py`). Rotas amora não têm fetch de rede: a geometria é
  decodificada do `saved_routes.json` (wp + polyline5 `sg`; POIs dos wp com
  `isPoi`) — e como esse traçado é MUTÁVEL (re-salvar no editor muda), o
  curto-circuito de cache de geometria não vale pra elas e o `/save-route`
  re-sincroniza (best-effort, local) os tours que referenciam o slug
  (`_resync_amora_route_tours`). The shared fetch/parse/entry-building logic
  lives in `backend/rwgps.py`, imported by both the backend and
  `scripts/build-routes.py` (single source of truth). The backend reads
  `RWGPS_API_KEY` / `RWGPS_AUTH_TOKEN` from its environment (best-effort
  `.env` load) — required for private/unlisted routes; public routes work
  without. `routes.json` is **mutable state served bucket-first** (like
  `uploads.ttl`) via `GET /routes.json`, with the baked file as seed/fallback.
  `web/upload_tour.html` is the per-tour form (series, sequence, energy
  estimate, intensity, attendee/newcomer counts, announcement art; edit
  mode via `?id=` submits `mode=patch` + a `remove` list of the form-
  managed predicates left empty); `web/backfill_tours.html` is the
  mass-backfill applet (one card per tour, only the seven backfill
  fields — description, departed/arrived, moving duration, energies,
  announcement image — sends a per-tour patch of just the changed
  fields); `web/censo.html` shows aggregated metrics + a sortable tour
  roster with "Editar" links pointing at `upload_tour.html?id=<tour_id>`.
  The main app exposes Censo through a modal iframe — opened by the
  "Censo →" sidebar link in the Routes panel — and the iframe is
  re-pointed to `./censo.html` on every open so navigating into the edit
  form internally doesn't strand the user there on re-open.
- **`/data/images-geo.ttl` é a fatia que o MAPA carrega.** `app.js` só usa
  mídia com coordenada, mas baixava e parseava o `images.ttl` inteiro DUAS
  vezes por boot (manifesto + `loadClipsFromUploadsTtl`) e descartava o
  resto — com a fase 2 da ingestão (~7.500 fotos sem GPS) o dump cresce ~10×.
  `_images_geo_text()` deriva do snapshot: mídia com `schema:locationCreated`
  ou `ph:GeoreferencedImage` + nós `<iri>_*` + closure de bnodes + os `env:`
  `ph:Upload` que a geraram; cache por digest do texto do `images.ttl`
  (padrão do `_tours_graph`), servida por `get_data_ttl` com o mesmo
  ETag/gzip. **É derivada — nunca vai pro bucket nem entra em
  `CATALOG_DUMPS`** (duplicaria as triples no universo SHACL). O manifesto
  VoID segue listando o `images.ttl` completo (galeria, censo, pessoas,
  memória e agentes precisam do resto); `loadAllGraphs` troca a URL no
  cliente, e o SW trata `images-geo.ttl` como network-first. Um kit local
  exportado carrega a fatia geo (o que o mapa mostra).
- **Backend endpoint summary.** Static: `GET /` (deep links `?tour=<id>`
  — slug8, slug legível ou id numérico legado — 303am pra URL canônica
  `/passeio/<slug legível ou slug8>`; id desconhecido degrada pro index
  estático). O SSR por passeio mora em `GET /passeio/<slug>`: troca
  title/description/canonical/OG, injeta JSON-LD NewsArticle + um
  `<article>` renderizado de `tours.ttl` pra crawlers/no-JS, servido NO
  path com `<base href="/">` injetado (o app abre o modal pelo path e
  remove o nó; render best-effort degrada pro 303 `/?tour=`). `GET /<path:p>`,
  `GET /data/<filename>`, `GET /photos/<path:p>`, `GET /clips/<path:p>`,
  `GET /tour_assets/<path:p>` (in `gcs` mode the last three 302-redirect
  to the bucket's public URL), `GET /feed.xml` (RSS 2.0 dos passeios,
  renderizado de `tours.ttl` e cacheado por hash do catálogo — atualiza
  sozinho a cada tour CRUD; link do item = IG, senão a página do passeio),
  `GET /memoria` (a Memória Hidrográfica SSR'ada — URL canônica desde a v404;
  `/memoria.html` faz 301 pra cá preservando a query, as âncoras `#<slug8>`
  seguem funcionando), `GET /sitemap.xml` (dinâmico, sobrepõe o
  estático: home + `/passeio/<slug legível ou slug8>` por passeio — o app
  abre no modal da rota — com bloco Google News pros passeios das últimas
  48 h; cache por hash + TTL de 1 h). Ops: `GET /health`, `POST /reload`
  (force re-read of the on-disk TTL catalog after an out-of-band edit).
  Mutations: `POST /upload-image`, `POST /upload-video` (`staged=1` = só o
  TTL, blobs já pré-enviados), `POST /stage-video/<vhash>` (pré-envio dos
  blobs de um vídeo AINDA não catalogado: grava nas chaves finais
  `clips/<vhash>.*` em paralelo + marcador `clips/_staging/<vhash>` com o
  instante; 409 se o vhash já está no catálogo), `POST
  /stage-video/<vhash>/discard` (apaga um pré-envio não confirmado — só com
  marcador e sem entrada no catálogo; o form chama via `sendBeacon` ao
  remover o card / `pagehide`). Pré-envios abandonados são varridos por
  `_sweep_staging` (boot via `_warm_caches` + 1×/h disparado por
  `/stage-video`): marcador mais velho que `STAGING_MAX_AGE_S` (6 h) cujo
  vhash não está no catálogo → blobs + marcador somem; se está, só o
  marcador. O `/upload-video` que fecha um pré-envio apaga o marcador E as
  variantes pré-enviadas que o TTL final não referencia (HD desligado depois
  do pré-envio). Não há auth: o pré-envio expõe os blobs na URL pública do
  bucket por até 6 h mesmo sem upload — aceito (quem abre o form vai subir).
  `POST /upload-tour` (`mode=replace|patch` + `remove` — see Tour CRUD),
  `POST /delete-image/<phash>`, `POST /delete-video/<vhash>`,
  `POST /delete-tour/<tour_id>`. Rotas salvas (biblioteca do editor de
  traçado, `web/saved_routes.json`): `GET /saved-routes` (lista resumida,
  mais novas primeiro), `GET /saved-route/<id|slug>` (estado completo, formato
  de compartilhamento, + `id`/`slug` da rota), `POST /save-route` (upsert;
  body `{name, state, id?}`; o NOME é obrigatório e ÚNICO — vira o slug do
  link; colisão com outra rota → 409; responde logo depois do JSON write +
  resync dos tours — o card OG renderiza em THREAD), `POST /delete-route/<id>`. Cada rota
  salva tem um **link compartilhável POR NOME** `/route/<slug>` —
  `GET /route/<slug>` serve uma página mínima com as OG tags da rota
  (og:image = `/route/<slug>/og.png` — o card de WhatsApp/redes: traçado
  renderizado com Pillow sobre a **Morros e Águas** (o MESMO FGB de
  hidrografia da camada, lido server-side por range request via o pacote
  `flatgeobuf` em storage.googleapis.com — a Cloudflare 403a UAs não-browser)
  + logo no canto superior direito + **badge de kJ/intensidade** (faixas do
  censo, fonte woff2 do repo convertida via fontTools) no inferior direito.
  O card é **pré-renderizado numa THREAD disparada pelo /save-route DEPOIS
  da resposta** (`_refresh_route_og_async` — FGB + Pillow levam ~2 s e o
  usuário esperava isso tudo pra ver o link/QR; save_route não usa
  @serialized de propósito, só o miolo read-modify-write trava) e
  persistido em `route_og/<id>.png` no store; o GET cai em memória → blob →
  render lazy (rede de segurança: no Cloud Run a CPU fora de request é
  throttled e a thread pode atrasar; `_og_render_lock` evita render duplo);
  delete-route apaga o blob; max-age 1 h)
  e redireciona o humano na hora
  (script + meta-refresh) pra `/#rt=<slug>` (FRAGMENTO, como o `#st=`:
  nunca é comido pelo strip de query da Cloudflare nem pelo cache do SW —
  e o SW trata `/route/<slug>` como network-first pra rename não servir
  redirect velho); o cliente resolve (`tryLoadSavedRouteFromHash` → fetch de
  `/saved-route/<slug>`); depois de carregar tira o `#rt=` da URL e ADOTA
  id/nome (re-salvar atualiza a MESMA rota; cópia = salvar com outro nome).
  Slug inexistente segue no 303 antigo (o app abre com o toast de erro).
  O suporte antigo a `/?route=<id>` foi REMOVIDO. No modal Salvar, **☁ Salvar
  no servidor**, **Copiar link** e **QR** salvam no servidor (link/QR também
  compartilham; sem backend degradam pro `#st=`); colisão de nome com OUTRA
  rota → 409 com id/name da existente e o cliente pergunta se é pra
  atualizá-la (re-salva adotando o id). **⤓ Exportar GPX** é o download. O
  modal 📂 Carregar lista as rotas em GRADE de cards (miniatura SVG do
  traçado via `preview`/`distMeters`/`stats` que o `GET /saved-routes` agora
  devolve — a subida vem de `stats.ascentM`, gravada pelo editor no save
  porque o estado salvo não tem elevação); o 🔗 de cada card copia o link.
  O rascunho do traçado persiste em localStorage (`phidro:traceDraft:v1`,
  gravação debounced a cada mutação): Cancelar/Esc só fecham o editor e o
  próximo Traçar restaura; o descarte real é o 🗑 da barra de edição. Localização ao vivo (efêmera, EM MEMÓRIA —
  NÃO toca os catálogos): `POST /live-location` (upsert da posição + rastro de
  um token pseudônimo; body JSON `{id, name?, lat, lng, accuracy?, heading?,
  ttl?}`; rastro thinned por tempo/distância, teto 500 pts/pessoa e 500
  pessoas), `GET /live-locations` (posições não-expiradas + rastro de cada
  uma; `Cache-Control: no-store`, sem ETag), `POST /live-location/stop` (apaga
  o próprio token na hora — NÃO chamado automaticamente; fica p/ um "apagar
  meu rastro" explícito). Estado em `_live_positions` (dict por token sob
  `_live_positions_lock`), retenção por token (`ttl` em s, default 3 h, teto
  24 h, podada em `_prune_live`). CORS é aberto SÓ nestes endpoints
  (`_LIVE_CORS_ORIGINS` = `capacitor://` / `ionic://` / `http(s)://localhost`,
  via `@app.after_request _live_cors`) pro shell nativo Capacitor — uploads/
  CRUD seguem same-origin. Estado por-processo: no Cloud Run **exige a
  instância fixa em 1** — `deploy-cloudrun.sh` pina `--max-instances=1`
  (default; o serviço rodou com max=5 até 09/2026, quando o catálogo também
  ficava exposto a lost update entre instâncias — o store não tem
  precondição de geração). min=0 continua o default por custo; o warm-up de
  boot amortece o cold start.

## Clips workflow

Source videos in `web/clips/raw/` (`.MOV`/`.mp4`/`.m4v`). Run:

```sh
python scripts/build-clips.py
```

Requires `ffmpeg` and `exiftool` in `$PATH` (Homebrew on macOS, `apt` on
Linux). For each source the script:

- Reads GPS via `exiftool` (clips with no GPS are skipped); reads both
  `CreateDate` (mvhd) and Apple `CreationDate` (iOS, with TZ) and prefers
  the Apple value — Apple's is the real recording time; mvhd is the save
  time and is often misleading. Pass `-api QuickTimeUTC=0` so the TZ is
  preserved.
- Transcodes a `<stem>.360p.mp4` (always) and `<stem>.720p.mp4`
  (best-effort, opt-in via `clipsGhost.useHd`) into `web/clips/`.
- Extracts the audio track to `web/clips/audio/<stem>.m4a` (AAC 96k).
- Extracts a thumbnail from the middle of the clip into
  `web/clips/<stem>.thumb.jpg` (~256px short side, JPEG quality 4).
- Reads `web/data/tours.ttl` and associates each clip with the closest
  tour within ±12 h via `ph:capturedDuring` (skipped if no tour matches).
- Writes the triples directly into `web/data/uploads.ttl` as a `ph:Video`
  with deterministic IRI `phd:video_<md5(stem)[:16]>`, with default
  author/provider `phd:pessoaDandan` and CC BY-SA 4.0 license. Idempotent
  upsert — re-running purges + rewrites the same IRI's triples cleanly.

The mtime check on the transcoded files makes re-runs cheap. Adding a new
clip = drop into `raw/` and re-run.

There is **no `clips.json`** — that intermediary was removed; `build-clips.py`
writes RDF directly. App.js reads `ph:Video` from `uploads.ttl` only.

## Conventions — please follow

- **`index.html` carrega `<base href="/">`.** Abrir um passeio reescreve a
  barra pra `/passeio/<slug>` (`_setTourUrl`, replaceState) e, sem o base,
  toda URL relativa construída DEPOIS (`./data/tours.ttl` do resumo do
  modal, `./saved-routes`, `./upload_tour.html`…) resolvia um nível abaixo →
  404 silencioso (o resumo do passeio nunca carregava pra quem entrava pela
  home). O SSR de `/passeio/<slug>` já injetava esse base; agora o estático
  traz e a injeção é idempotente (`if "<base " not in html_text`). CSP tem
  `base-uri 'self'`; os `href="#"` do app são todos preventDefault'ados.
- **Catálogo residente em memória (`_dumps`).** Cada dump fica em memória
  como TEXTO (o que `/data/<ttl>` serve) e como GRAFO rdflib VIVO, parseado
  uma vez e mutado in place pelos RMW — nada de `STORE.read_text` + parse +
  serialize de ~430 KB por gravação (era ~120–240 ms por foto, ×6 leituras
  num save de passeio, e em GCS cada leitura era HEAD+GET). Regras: mutação
  SEMPRE via `with _mutating("images.ttl") as g:` (grafo vivo sob
  `_state_lock`; commita ao sair — serializa, grava, atualiza o texto,
  invalida o snapshot; se o corpo ou a gravação levantar, descarta o grafo
  vivo e o próximo acesso re-parseia o último estado PERSISTIDO — memória e
  store nunca divergem); o grafo vivo (`_dump_graph`) só é tocado sob o lock,
  iteração inclusive (add/remove concorrente a uma iteração estoura o store
  de memória do rdflib); leitura fora do lock usa `_load_catalog()`, um
  SNAPSHOT imutável da união refeito preguiçosamente depois de cada commit
  (~14k adds, dezenas de ms). `_tours_graph()` (feed/SSR/route-sync) segue
  cacheado por digest do texto. Escritas fora de banda no bucket
  (`state-history.sh restore`, `deploy --state`, edição manual) continuam
  exigindo `POST /reload`, que agora zera texto E grafos.
- **Nunca deixar o owlrl trocar os conversores de datatype do rdflib.**
  `_load_validator` seta `owlrl.DeductiveClosure.improved_datatype_generic =
  True` + `use_RDFLib_lexical_conversions()`. Sem isso, cada closure rdfs do
  pyshacl instalava `use_Alt_lexical_conversions()` GLOBALMENTE e restaurava
  no fim — e um Turtle parseado por OUTRA thread nesse intervalo saía com o
  offset dos `xsd:dateTime` deslocado uma hora (`-03:00` → `-04:00`). Como
  cada gravação re-serializava o catálogo, o desvio acumulava: 435 das 460
  datas de mídia chegaram a offsets até `-23:00` (wall-clock certo, offset
  errado — conferido contra o EXIF dos originais). Reprodutível com um
  harness de threads; `scripts/migrate-date-offsets.py` repara o acumulado.
- **Uploads não seguram o lock global durante a transferência.**
  `/upload-image` E `/upload-video` (este era `@serialized` inteiro) recebem
  o corpo, validam (só o `pyshacl.validate` serializa, sob `_validate_lock`)
  e gravam blobs FORA do `_state_lock`; só o RMW do catálogo, com
  re-checagem TOCTOU da colisão cross-type, roda sob o lock. Não reintroduzir
  `@serialized` num handler que lê `request.files`.
- **Os forms avisam o app-pai por `postMessage`** — `phidro-media-changed`
  (upload_images.html: envio, edição) e `phidro-tour-changed`
  (upload_tour.html: save, delete). O app marca o modal como "sujo" e só
  chama `reloadPhotos()` ao fechar se algo foi salvo; fechar sem salvar não
  custa mais 4 dumps + rebuild de marcadores. Um novo caminho de escrita num
  form precisa emitir a mensagem, senão o mapa só atualiza no próximo reload.
- **Vídeo transcoda num passe só** (`transcodeClip` em upload_images.html:
  um `<video>`, dois canvases no mesmo rAF, três MediaRecorders — áudio-only,
  720p, 360p — com a trilha de áudio clonada). MediaRecorder é tempo real:
  os três passes em série custavam 3× a duração do recorte. Falhou (browser
  recusa 3 recorders)? Cai pro sequencial antigo, que fica no arquivo por
  isso. Acima dos dois está o caminho **WebCodecs** (`transcodeClipFast`,
  mediabunny — segundos em vez de tempo real); a cadeia mora em
  `processClip`. Uma mudança no modelo de saída (bitrates, lado curto,
  codecs) tem que ser feita nos DOIS motores (`VIDEO_BITRATE` é compartilhado).
- **`/upload-video` grava os blobs em paralelo** (`_write_clip_blobs`,
  ThreadPoolExecutor — eram 4 round-trips em série no GCS) e lê
  `request.files` antes de qualquer thread; continua fora do `_state_lock`.
- **Bump `sw.js` `VERSION`** on *any* change to files in `web/` —
  otherwise the service worker serves stale cached copies and the change
  won't reach users. It's a monotonic `phidro-vN` integer counter; just
  increment. For user-visible changes, also add an entry to the collapsed
  changelog `<details class="help-changelog">` at the top of the Ajuda
  modal in `index.html` (dated, keyed to the new vN).
- **Compression + ETags are load-bearing.** The backend uses
  `flask-compress` (best-effort import; `COMPRESS_STREAMS = True` is
  required or `send_from_directory` responses — app.js, style.css — go out
  raw) and the string-built responses (`/routes.json`, `/data/<ttl>`) get
  `resp.add_etag()` + `make_conditional()` via `_conditional()`. Without
  the ETags, the SW's network-first strategy re-downloads the full 2 MB
  `routes.json` every visit instead of getting a 304. Don't strip either
  when touching those handlers. `index.html` also `<link rel="preload">`s
  `routes.json`, and app.js fetches it *without* `cache: 'no-cache'` so
  the two requests coalesce — keep them matched.
- **No backend auth.** Anyone who can reach the server can upload/delete —
  this is an intentional decision (trusted access assumed). Don't reintroduce
  a token; restrict at the edge if needed.
- **Captura: a ausência do passe é um dado, não um vazio.** O `ph:MediaSweep`
  (nó derivado `pas:<slug>_sweep`) registra o passe de coleta no grupo do zap —
  quando foi feito, quantos arquivos vieram, quem compartilhou. Os três estados
  são semanticamente distintos e não devem ser colapsados: **nó ausente** = o
  passe nunca foi feito; **`ph:collectedFileCount 0`** = foi feito e ninguém
  compartilhou; **`n`** = n arquivos. Os contribuintes ficam como LITERAL (o
  slug cru do nome do arquivo), não como IRI de pessoa — assim o passe nunca
  trava esperando alguém ser cadastrado; a resolução é um join via
  `schema:alternateName`. `ph:mediaCount` é a versão velha disso, está
  `owl:deprecated`, e **não se escreve mais nele**. Ver `docs/CAPTURA.md`.
- **Predicados que penduram em nó aninhado têm `rdfs:domain` da CLASSE DO NÓ.**
  O validador roda com `inference="rdfs"`: um `rdfs:domain ph:Tour` num
  predicado do nó do passe tiparia `pas:<slug>_sweep` como `ph:Tour`, jogando-o
  na `ph:TourShape` (que exige título e data) → Violation. Vale pra
  `ph:MediaSweep`, `ph:RouteReference`, `ph:SeriesEdition`.
- **`ph:totalDuration` é fallback, não fonte.** O tempo total (saída→chegada)
  é DERIVADO de `ph:arrivedAt − ph:departedAt` sempre que os dois existem; o
  literal `ph:totalDuration` (xsd:duration) só é gravado quando NENHUM dos
  dois horários existe (o form `upload_tour.html` deduz o horário que falta
  quando há só um, e REMOVE o predicado no patch quando há os dois). Leitores
  (censo) derivam primeiro e caem no literal. Não gravar os dois juntos.
- **Um patch que não mexe na rota não rebusca a geometria.** `_sync_tour_route`
  reusa os `latlngs` já em `routes.json` quando o `ph:linkRoute` não mudou, e
  não reescreve o arquivo se a entrada ficou idêntica. Sem isso, escritas em
  lote (87 passes, 87 gravações) viravam centenas de fetches de GPX no RWGPS +
  centenas de rewrites de um JSON de 2 MB — e, com Object Versioning, cada
  rewrite deixa uma geração noncurrent parada por 90 dias. Pra forçar a
  rebusca: `scripts/build-routes.py`.
- **`PUBLIC_BASE_URL`**: sem ela, o backend grava no catálogo o host pelo qual
  o cliente chegou (`request.host_url`) — e um backend de dev assa
  `http://localhost:8080/…` num `schema:image` que depois sobe pra produção
  (foi o que aconteceu com o PH/96). Quem auto-hospeda deve setá-la. As shapes
  avisam e o painel de captura mostra a arte local como lacuna.
- **Ontology:** reuse consolidated vocabularies (schema.org, PROV-O, QUDT,
  GeoSPARQL, Dublin Core); mint `ph:` terms only for what is specific to
  Pedal Hidrográfico.
- **Cloud Run is the hosted deploy target** at
  `https://amora.pedalhidrografi.co/` via `scripts/deploy-cloudrun.sh`;
  the same backend (`backend/main.py`) also runs locally for dev or
  self-hosting — `storage.py` abstracts state via `STORAGE_BACKEND=local`
  (filesystem) vs `gcs` (bucket). The old Raspberry Pi deploy was retired.
  The old read-only static mirror at `tiles.pedalhidrografi.co/rotas_app`
  (deployed by the now-removed `scripts/deploy.sh`) is retired.
- **gunicorn runs with `--workers 1` everywhere** (Dockerfile, .plist).
  The mutation lock (`_state_lock`) is per-process; with 2+
  workers, concurrent uploads land in different processes and the second
  read-modify-write of the TTL catalogs silently discards the first (lost
  update). Concurrency comes from threads; Cloud Run scales by instances.
  Don't "tune" the worker count up.
- **Local↔bucket sync is guarded against lost updates.** The dual-writer
  state files — `uploads.ttl`, `tours.ttl`, `routes.json` — are mutated both
  locally (build scripts, edits) and server-side (uploads, Tour CRUD via the
  bucket). `data_graphs.ttl` is pushed alongside them but is NOT itself
  dual-writer: the backend never mutates it (it's a static VoID shim, see
  Architecture above), so it only ever changes if you hand-edit it locally.
  `web/saved_routes.json` (the route-editor's save library, `/save-route` /
  `/delete-route`) is also server-mutated bucket-first state but currently
  sits outside this guarded sync — there's no local↔bucket round-trip for it
  yet. `scripts/sync-guard.sh`
  (sourced by `deploy-cloudrun.sh` and `pull-cloudrun.sh`) stashes the MD5
  of the last successful sync in `.sync-state/` (gitignored, per-machine)
  and refuses any copy whose destination changed since that baseline AND
  differs from the source — exit 3 with reconciliation instructions.
  `--force` overrides (and establishes the baseline on first use on a new
  machine). Don't bypass the guard with raw `gcloud storage cp`; photos/
  and clips/ are content-addressed and additive, so they stay unguarded.
- **The server is the sole writer of the catalogs in normal ops.** Photo/
  video uploads, Tour CRUD, and deletes all go through the backend
  (`upload_*.html` forms → POST); `routes.json` is server-owned (incremental
  sync on Tour CRUD). The only local catalog-writers left are the **batch/
  recovery** scripts: `build-clips.py` (writes `uploads.ttl`) and
  `build-routes.py` (full `routes.json` rebuild). Treat them as round-trip:
  `pull-cloudrun.sh` → run → `deploy-cloudrun.sh --state[-only]` (sync-guarded).
  Don't hand-edit `tours.ttl`/`uploads.ttl` — edit tours via
  `upload_tour.html?id=` (`mode=patch`) or `backfill_tours.html`; if you must
  hand-edit, pull first and push immediately through the guarded scripts.
- **The bucket has Object Versioning + a lifecycle rule** (enabled idempotently
  on every `deploy-cloudrun.sh`, mirroring the CORS block). Every server write
  to a state file keeps the prior generation; noncurrent versions expire after
  90 days (`daysSinceNoncurrentTime` — never `age`, which would delete live
  objects). This is the recovery net for a clobber / bad purge / lost update.
  Browse + recover with `scripts/state-history.sh list|diff|restore <file>`;
  `restore` is non-destructive (writes a new current generation) — follow it
  with `POST /reload` so the backend re-reads. Local (`STORAGE_BACKEND=local`)
  has no equivalent; history there is just git for the tracked TTLs.
- **GCS read gotcha (Cloud Run).** Always use `bucket.get_blob(key)`
  rather than `bucket.blob(key) + download_as_text()` — the bare-blob form
  produced silently-stale content in Cloud Run despite the bucket having
  one current generation. See `GCSStateStore.read_text` in
  `backend/storage.py` for the fix.
- **Cloud Run container stays magrinho.** `.gcloudignore` /
  `.dockerignore` exclude `web/photos/` and `web/clips/` entirely (not
  just `raw/`). The runtime handlers `/photos/<path>` and `/clips/<path>`
  redirect to the bucket's public URL in `gcs` mode (302 → much faster
  than streaming through Flask). To populate the bucket with local
  `build-clips.py` outputs and locally-collected uploads, run
  `scripts/deploy-cloudrun.sh --state-only`.
- Comments and UI strings are in Portuguese; code identifiers in English.

## Verify before finishing

- JS in `web/`: load it in a browser (or the existing dev server) — the
  browser surfaces syntax errors immediately. No standalone JS tooling here.
- Bump `web/sw.js` `VERSION` if any file under `web/` changed.
- `python -m py_compile backend/main.py`
- Ontology / shapes / data: parse with `rdflib` after editing `*.ttl`.

## Build & deploy

- `python scripts/build-routes.py` — **full rebuild** of `web/routes.json` by
  reading `web/data/tours.ttl` (the Tour catalog) and fetching each
  referenced GPX from RideWithGPS. Requires `python-dotenv` plus
  `RWGPS_API_KEY` / `RWGPS_AUTH_TOKEN` in `.env`. **Not the normal path** —
  the backend keeps `routes.json` incrementally on every Tour CRUD; use this
  only for bake/recovery, then push via `deploy-cloudrun.sh --state`.
- `python scripts/build-clips.py` — re-encode anything in `web/clips/raw/`
  to 360p/720p mp4 + `.m4a` audio + thumbnail, and upsert each as a
  `ph:Video` in `web/data/uploads.ttl` (associates with nearest tour
  within ±12 h). See "Clips workflow" above. Requires `ffmpeg` + `exiftool`.
- `bash scripts/deploy-cloudrun.sh` — build + deploy backend to Cloud Run
  (project `pedal-hidrografico`, region `southamerica-east1`, service
  `phidro`, bucket `phidro-state`). Reads `RWGPS_API_KEY`/`RWGPS_AUTH_TOKEN`
  from the local `.env` and injects them as service env vars (the `.env`
  itself never enters the build context — it's in `.gcloudignore`). Flags:
  - `--state` build + deploy + sync mutable state (`uploads.ttl`,
    `data_graphs.ttl`, `routes.json`, `photos/`, `clips/`, `tour_assets/`)
    to the bucket
  - `--state-only` just sync mutable state, skip rebuild
  - `--mirror` make the bucket an exact mirror of local (deletes objects
    that no longer exist locally; pairs with `--state`/`--state-only`)
  - `--force` override the anti-clobber guard (see Conventions)
  - `--dry-run` preview without executing
- Local backend: `pip install -r backend/requirements.txt && python backend/main.py`
  (defaults to port 8000; override with `PORT=…`). See `backend/README.md`.

## Open loose ends

- **Retire legacy build scripts.** `scripts/build-routes.mjs` (the old
  Node port — now orphaned; `package.json`'s `build:routes` already points
  at `build-routes.py`) and `scripts/build-photos.py` (predates the upload
  form) are both superseded. User-deletes when ready:
  `git rm scripts/build-routes.mjs scripts/build-photos.py`. The
  `coletor_*.py` family was already removed.
- **`scripts/gen-synthetic-rdf.py` is stale.** It targets the removed
  top-level `ontology/` dir (`--out-dir ontology/v2`) and emits the old
  `censo/1.0/` namespace with classes absent from the current
  `web/data/ontology.ttl` — its output can't validate against current
  shapes. User-deletes when ready: `git rm scripts/gen-synthetic-rdf.py`
  (or retarget it at `web/data/` if synthetic data is still useful).
- **`research/photos-rdf/upload-form.html`** is the legacy "build a kit ZIP"
  form. Production uploads go through `web/upload_images.html`. Keep the
  research one only if you still use it for batch-export experiments.
- **`web/data/uploads.ttl` and `web/photos/<phash>/`** are runtime artifacts
  of the backend — gitignore or commit per your deploy strategy. The CDN
  mirror shows no photos until those files exist at the destination.
- **`web/clips/raw/`** holds source videos (large; ~800 MB total).
  Probably want gitignored. The build artifacts (`*.360p.mp4`,
  `*.720p.mp4`, `audio/*.m4a`, `*.thumb.jpg`) are smaller and can be
  committed if you want the static mirror to ship clips, or generated in
  CI. The catalog of triples lives in `web/data/uploads.ttl` (single
  source of truth for both images and videos). For Cloud Run, all of
  `web/clips/` and `web/photos/` is excluded from the container and lives
  in the `phidro-state` bucket — push local outputs with
  `scripts/deploy-cloudrun.sh --state-only`.
- **`web/upload_videos.html`** is a permanent redirect stub pointing at
  `upload_images.html` (which now handles both media types). Safe to
  delete once you're sure no bookmark uses the old URL.

## Notes

- Working files we changed this cycle are likely uncommitted — check
  `git status` and commit with meaningful messages.
- Permanent deletions (files, data) should be left to the user — provide the
  commands rather than running them.
