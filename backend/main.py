"""
Pedal Hidrográfico — backend Flask.

Mesmo código serve dois alvos:

  STORAGE_BACKEND=local (padrão)  — dev/local: estado mutável no filesystem
  STORAGE_BACKEND=gcs              — Cloud Run: estado num bucket GCS

Cada upload contém:
  - `ttl`        : bloco Turtle com exatamente 1 `ph:Image` (texto ou arquivo)
  - `original`   : arquivo da foto fonte (jpg/png/heic). Opcional.
  - `large`      : foto reduzida (~500 KB). Opcional.
  - `thumb`      : miniatura. Opcional.

Validação SHACL contra `web/data/shapes.ttl` (sempre do filesystem do
container/repo); variantes vão para `photos/<phash>/...` no store; triples
deduplicadas em `data/uploads.ttl` no store; manifesto em
`data/data_graphs.ttl` no store.

Rotas:
  GET  /                          serve web/index.html
  GET  /health                    "ok"
  GET  /data/uploads.ttl          do store (mutável)
  GET  /data/data_graphs.ttl      do store (mutável)
  GET  /photos/<path>             do store (redirect p/ URL pública em GCS,
                                  stream local em modo local)
  GET  /clips/<path>              idem (vídeo/áudio/thumb)
  GET  /tour_assets/<path>        idem (arte de anúncio de passeios)
  GET  /<path>                    estáticos de web/ (app.js, shapes.ttl, …)
  POST /upload-image              multipart com `ttl` + variantes
  POST /upload-video              multipart com `ttl` + audio/vídeo/thumb
  POST /upload-tour               upsert de 1 ph:Tour em tours.ttl
  POST /delete-image/<phash>      remove arquivos + triples
  POST /delete-video/<vhash>      remove clipes + triples
  POST /delete-tour/<tour_id>     remove triples do tour + assets
  POST /live-location             upsert da posição ao vivo (efêmera, em memória)
  GET  /live-locations            posições ao vivo não-expiradas
  POST /live-location/stop        remove a própria posição na hora
  POST /reload                    invalida caches in-memory

Sem auth — quem alcança o servidor é de confiança. Todas as mutações são
serializadas por um lock global (ver `serialized` / `_state_lock`) pra que
POSTs concorrentes não corrompam os catálogos TTL compartilhados.

Variáveis de ambiente:
  STORAGE_BACKEND   local | gcs                 (padrão: local)
  GCS_BUCKET        nome do bucket (modo gcs)
  PHIDRO_WEB        pasta do app                (padrão: ../../web)
  PORT              porta HTTP                  (padrão: 8000)
  MAX_UPLOAD_BYTES  teto do multipart por req   (padrão: 256 MiB)
  PUBLIC_BASE_URL   host público deste servidor (ex.: https://amora.example)
                    — usado nas IRIs absolutas que entram no catálogo
                    (schema:image do anúncio) quando o store não tem URL
                    pública própria. Sem ele, cai no host da requisição, que
                    num backend de dev grava `http://localhost:8080/…` no dado.
  STORAGE_EMULATOR_HOST   p/ rodar contra fake-gcs-server localmente
                          (https://github.com/fsouza/fake-gcs-server)
"""
import functools
import json
import math
import os
import traceback
import re
import threading
import time
import uuid
from pathlib import Path

from datetime import datetime, timezone
from flask import Flask, Response, abort, jsonify, redirect, request, send_from_directory

from storage import make_store_from_env

# ── Caminhos ─────────────────────────────────────────────────────────────
# WEB é o filesystem read-only do container/repo: HTML/JS/CSS/icons + os
# TTLs estáticos (shapes, ontology, tours). Resolve em duas tentativas:
#   1. Local/dev:  backend/main.py → repo_root/web ( parents[1] / "web" )
#   2. Container:  /app/main.py    → /app/web      ( parent  / "web" )
# `os.environ.get(k, default)` avalia `default` SEMPRE — não dá pra confiar
# em parents[1] cru porque dá IndexError no container (/app/main.py).
def _default_web_path():
    here = Path(__file__).resolve()
    try:
        repo_layout = here.parents[1] / "web"
        if repo_layout.is_dir():
            return repo_layout
    except IndexError:
        pass
    return here.parent / "web"

WEB = Path(os.environ.get("PHIDRO_WEB") or _default_web_path()).resolve()
DATA_DIR      = WEB / "data"
SHAPES_PATH   = DATA_DIR / "shapes.ttl"
ONTOLOGY_PATH = DATA_DIR / "ontology.ttl"

# Host público deste servidor, sem barra final. Só entra em jogo quando o
# store não expõe URL pública (modo local): é o que impede um backend de dev
# de assar `http://localhost:8080/…` numa IRI do catálogo.
PUBLIC_BASE_URL = (os.environ.get("PUBLIC_BASE_URL") or "").rstrip("/")

# Content-Signal (contentsignals.org) que acompanha as respostas Markdown pra
# agentes — o mesmo default do "Markdown for Agents" da Cloudflare. É sinal de
# política, não bloqueio: declara como o acervo (dados abertos, mídia CC BY-SA)
# pode ser usado. String vazia desliga o header.
CONTENT_SIGNAL = os.environ.get(
    "CONTENT_SIGNAL", "ai-train=yes, search=yes, ai-input=yes").strip()

# Store = estado mutável. Em modo local, raiz = PHIDRO_WEB (layout:
# data/uploads.ttl, photos/<phash>/...); em modo gcs, raiz é o
# bucket GCS. Os "keys" são strings relativas, mesmas em ambos os modos.
STORE = make_store_from_env(WEB)

# Keys de estado mutável (usados como `STORE.read_text(...)` etc.)
# Catálogos separados: images.ttl (mídia ph:StillImage/ph:MotionImage),
# identities.ttl (pessoas schema:Person — fonte única), tours.ttl (passeios +
# associações + rotas). Antes tudo vinha em tours.ttl + uploads.ttl.
KEY_IMAGES   = "data/images.ttl"
KEY_IDENTITIES = "data/identities.ttl"
KEY_TOURS    = "data/tours.ttl"
# routes.json é pré-bakado por scripts/build-routes.py mas também é atualizado
# incrementalmente aqui (upsert/remove de 1 rota por upload/delete de tour).
# Vira estado mutável: servido bucket-first, com o arquivo bakeado no
# container/repo como seed/fallback. Em modo local o root do STORE é `web/`,
# então isto grava o MESMO `web/routes.json` que o script — sem divergência.
KEY_ROUTES   = "routes.json"
# saved_routes.json — biblioteca de rotas que o usuário salva pelo editor
# (waypoints + geometria roteada + parâmetros + modo, no MESMO formato dos
# links de compartilhamento `#st=`). Estado mutável, servido bucket-first,
# sem auth (mesma premissa de acesso confiável do resto do backend).
# Envelope: { "routes": { "<id>": {name, state, points, created, updated} } }.
KEY_SAVED_ROUTES = "saved_routes.json"

# Credenciais do RideWithGPS pra buscar a geometria das rotas (privadas/
# unlisted exigem auth; públicas funcionam sem). Lidas de `os.environ` por
# `rwgps.decorate_rwgps`; carregamos o `.env` do repo best-effort pra que o
# dev local pegue as mesmas chaves que o build-routes.py usa.
try:  # python-dotenv é dep do build-routes; pode faltar no container slim.
    from dotenv import load_dotenv as _load_dotenv
    _load_dotenv(WEB.parent / ".env")
except Exception:  # noqa: BLE001
    pass

PH_NS  = "https://id.pedalhidrografi.co/terms#"
PHD_NS = "https://pedalhidrografi.co/data/"
SCHEMA_NS = "https://schema.org/"
# Namespace de IDENTIDADE de pessoas — neutro (não acoplado ao app) e resolvível:
# https://id.pedalhidrografi.co/pessoas/<slug8> (slug opaco aleatório). A página
# humana é servida pelo amora em /pessoas/<slug> (schema:mainEntityOfPage).
PES_NS = "https://id.pedalhidrografi.co/pessoas/"
# Namespace de LISTAS/álbuns (schema:Collection) — resolvível e fora do catálogo
# de mídia: as Collections vivem em lists.ttl (não mais inline em images.ttl).
# IRI: https://id.pedalhidrografi.co/listas/<slug>.
LST_NS = "https://id.pedalhidrografi.co/listas/"
KEY_LISTS = "data/lists.ttl"
# Mídia (foto/vídeo) — content-addressed pelo hash; o host mudou pra resolvível,
# mas o discriminador image_/video_ (e o hash como identidade) fica no local name
# (blobs, dedup e delete seguem intactos — só o prefixo do IRI muda).
# IRI: https://id.pedalhidrografi.co/midia/image_<phash16> | .../video_<vhash16>.
MED_NS = "https://id.pedalhidrografi.co/midia/"
# Atividade de envio (ph:Upload) — provenance server-side. IRI: .../envio/<ts>.
ENV_NS = "https://id.pedalhidrografi.co/envio/"
# Passeio (ph:Tour) — id agora é um slug aleatório Crockford (não mais o id
# numérico legado). IRI: https://id.pedalhidrografi.co/passeio/<slug8>. O "tour_id"
# no código passa a ser esse slug (localname após o prefixo).
PAS_NS = "https://id.pedalhidrografi.co/passeio/"
# Série de eventos (schema:EventSeries). IRI: .../serie/<ES> (PH/BT/BP/S/SESC).
SER_NS = "https://id.pedalhidrografi.co/serie/"


def _intensity_for(kj):
    """Classificação de intensidade derivada do valor em kJ por faixas fixas.
    Antes vivia em ph:intensityClassification num nó qudt:QuantityValue; agora
    a energia é um literal e a intensidade é derivada na leitura."""
    if kj is None:
        return None
    if kj < 150:
        return "De boa"
    if kj < 300:
        return "Ok"
    if kj < 500:
        return "Endorfinado"
    if kj < 1000:
        return "Frito"
    return "Insano"

# Limite por requisição. Um upload de vídeo manda 360p + 720p (webm) +
# áudio + thumb num único multipart, então o teto precisa acomodar a soma.
# Override via env pra hosts com clipes mais longos.
MAX_PER_UPLOAD = int(os.environ.get("MAX_UPLOAD_BYTES") or (256 * 1024 * 1024))

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_PER_UPLOAD

# Compressão transparente (gzip/brotli) — routes.json sai de ~2 MB pra
# ~210 KB e app.js de ~280 KB pra ~90 KB. Import best-effort (mesmo
# espírito do load do .env): um host que ainda não rodou pip install
# continua servindo, só que sem compressão.
app.config["COMPRESS_MIMETYPES"] = [
    "text/html", "text/css", "text/plain",
    "text/javascript", "application/javascript",
    "application/json", "text/turtle", "image/svg+xml",
    "application/manifest+json", "application/gpx+xml",
    "application/rss+xml", "application/xml", "text/xml",
    "text/markdown", "application/linkset+json",
]
# send_from_directory devolve resposta *streamed* (file wrapper) e o
# flask-compress pula essas por padrão — sem isto app.js/style.css sairiam
# crus. Só afeta os mimetypes de texto acima; mídia (mp4/webm/jpg) segue
# fora da lista e mantém range requests intactos.
app.config["COMPRESS_STREAMS"] = True
try:
    from flask_compress import Compress
    Compress(app)
except ImportError:                                   # pragma: no cover
    print("[main] flask-compress ausente — servindo sem compressão "
          "(pip install -r backend/requirements.txt)")


def _conditional(resp):
    """ETag + suporte a If-None-Match nas respostas construídas de string
    (routes.json e /data/*.ttl). Elas são `Cache-Control: no-cache`, ou
    seja, o browser revalida a cada visita — sem ETag a revalidação baixa
    o corpo inteiro de novo; com ela, vira um 304 vazio. (Os estáticos via
    send_from_directory já ganham ETag/conditional do próprio Flask.)"""
    resp.add_etag()
    return resp.make_conditional(request)

# Todas as mutações fazem read-modify-write num único catálogo TTL
# compartilhado (uploads.ttl / tours.ttl / data_graphs.ttl) sem CAS. Sem
# serialização, dois POSTs concorrentes (o servidor Flask é threaded, e o
# form de upload manda os cards em paralelo) intercalam: o segundo writer
# sobrescreve os triples do primeiro (lost update) ou um leitor pega o
# arquivo truncado no meio da escrita. Um lock global serializa as mutações;
# combinado com a escrita atômica do LocalStateStore, o catálogo fica íntegro.
# (Em Cloud Run multi-instância isto cobre só uma instância — ali ainda
# faltaria precondição de generation no GCS; ver storage.py.)
_state_lock = threading.RLock()
# Lock DEDICADO à validação SHACL. pyshacl (via o parser SPARQL do rdflib/
# pyparsing, disparado pelo sh:sparql das shapes) NÃO é thread-safe: duas
# validações concorrentes corrompem o estado global do parser. Além disso é
# CPU-bound (o GIL serializa de qualquer jeito). Então validação é serializada
# à parte — mas SEM o _state_lock, pra não bloquear o RMW do catálogo (rápido)
# atrás de uma validação lenta (~1,2 s). Ver upload_image.
_validate_lock = threading.Lock()


def serialized(fn):
    """Serializa o handler inteiro sob `_state_lock` (validação + escrita)."""
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        with _state_lock:
            return fn(*args, **kwargs)
    return wrapper


# ── Posições ao vivo (efêmeras, em memória) ──────────────────────────────
# Compartilhamento de localização ao vivo: cada participante faz POST da sua
# posição a cada poucos segundos; todos leem via GET. NADA disto é persistido
# (não toca TTL/disco/bucket) — é um dict em memória no único worker gunicorn,
# com TTL curto. Opt-in, pseudônimo, expira sozinho. Como o estado é
# per-process, depende de --workers 1 / 1 instância (mesma premissa do
# _state_lock); em multi-instância as posições se fragmentariam. Tem lock
# próprio (leve) em vez do _state_lock pra não competir com os uploads.
_live_positions = {}            # token -> {name, lat, lng, ts, accuracy?, heading?, trail}
_live_positions_lock = threading.Lock()
LIVE_TRAIL_S = 3 * 3600         # janela de visibilidade/rastro: 3h
LIVE_TRAIL_MIN_GAP_S = 8        # thinning: tempo mínimo entre pontos guardados (s)
LIVE_TRAIL_MIN_MOVE_M = 12      # thinning: distância mínima entre pontos guardados (m)
LIVE_TRAIL_MAX_POINTS = 500     # teto de pontos de rastro por pessoa (memória)
LIVE_MAX_PEERS = 500            # teto defensivo de participantes

# CORS restrito aos endpoints /live-* — o app rodando dentro do shell nativo
# (Capacitor: capacitor://localhost / https://localhost) bate aqui cross-origin
# se empacotar os assets. NÃO abre CORS nos uploads/CRUD: esses seguem
# same-origin/confiança local. No browser (same-origin) é inócuo.
_LIVE_CORS_ORIGINS = {"capacitor://localhost", "https://localhost",
                      "ionic://localhost", "http://localhost"}


def _prune_live(now):
    """Remove tokens cujo último ponto saiu da janela de retenção e poda os
    pontos de rastro expirados dos que sobram. A janela é por token (`ttl`, em
    segundos, escolhido por quem compartilha; default LIVE_TRAIL_S). Chamar já
    sob _live_positions_lock."""
    dead = []
    for t, p in _live_positions.items():
        cutoff = now - (p.get("ttl") or LIVE_TRAIL_S)
        if p["ts"] <= cutoff:
            dead.append(t)
            continue
        tr = p.get("trail")
        if tr and tr[0][2] <= cutoff:
            p["trail"] = [pt for pt in tr if pt[2] > cutoff]
    for t in dead:
        del _live_positions[t]


def _valid_live_token(t):
    """Token pseudônimo do cliente (crypto.randomUUID() ou hex). Aceita
    hex + hífens, 1–64 chars — não confia em nada do corpo além disto."""
    return isinstance(t, str) and 1 <= len(t) <= 64 and all(
        c in "0123456789abcdefABCDEF-" for c in t)


@app.after_request
def _live_cors(resp):
    if request.path.startswith("/live-location"):  # cobre singular, /stop e plural
        # A resposta varia por origem (ACAO só p/ origens da allowlist), então
        # Origin SEMPRE entra no Vary — inclusive p/ origens fora da lista, senão
        # um cache compartilhado poderia servir a resposta de uma origem a outra.
        # vary.add NÃO sobrescreve um Vary já presente (ex.: Accept-Encoding do
        # flask-compress), ao contrário de `headers["Vary"] = ...`.
        resp.vary.add("Origin")
        origin = request.headers.get("Origin")
        if origin in _LIVE_CORS_ORIGINS:
            resp.headers["Access-Control-Allow-Origin"] = origin
            resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
            resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


@app.route("/live-location", methods=["POST", "OPTIONS"])
def post_live_location():
    """Atualiza a posição ao vivo de um participante e acumula o rastro (3h).
    Efêmero, sem o lock de estado pesado. Body JSON:
    {id, name?, lat, lng, accuracy?, heading?}."""
    if request.method == "OPTIONS":
        return ("", 204)
    data = request.get_json(silent=True) or {}
    token = str(data.get("id") or "").strip()
    if not _valid_live_token(token):
        return jsonify(error="id inválido"), 400
    try:
        lat = float(data.get("lat"))
        lng = float(data.get("lng"))
    except (TypeError, ValueError):
        return jsonify(error="lat/lng inválidos"), 400
    if not (math.isfinite(lat) and math.isfinite(lng)) or \
            not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return jsonify(error="lat/lng fora de faixa"), 400
    now = time.time()
    head = {"name": str(data.get("name") or "").strip()[:40],
            "lat": lat, "lng": lng, "ts": now}
    for k in ("accuracy", "heading"):
        try:
            v = data.get(k)
            if v is not None and math.isfinite(float(v)):
                head[k] = float(v)
        except (TypeError, ValueError):
            pass
    # Retenção escolhida por quem compartilha (segundos): por quanto tempo o
    # servidor guarda o rastro deste token. Default 3h, teto defensivo de 24h.
    ttl = LIVE_TRAIL_S
    try:
        v = data.get("ttl")
        if v is not None and math.isfinite(float(v)):
            ttl = int(max(60, min(24 * 3600, float(v))))
    except (TypeError, ValueError):
        pass
    head["ttl"] = ttl
    from rwgps import haversine_meters   # cacheado em sys.modules; boot barato
    with _live_positions_lock:
        _prune_live(now)
        prev = _live_positions.get(token)
        if prev is None and len(_live_positions) >= LIVE_MAX_PEERS:
            return jsonify(error="muitos participantes ao vivo"), 503
        trail = prev["trail"] if prev else []
        # Thinning: só guarda um ponto novo se passou tempo OU distância
        # suficiente desde o último — limita memória e suaviza a linha. O
        # `head` sempre reflete o último fix (marcador preciso entre pontos).
        if not trail:
            keep = True
        else:
            llat, llng, lts = trail[-1][0], trail[-1][1], trail[-1][2]
            keep = (now - lts >= LIVE_TRAIL_MIN_GAP_S
                    or haversine_meters(llat, llng, lat, lng) >= LIVE_TRAIL_MIN_MOVE_M)
        if keep:
            # Ponto = [lat, lng, ts, accuracy?]. A precisão por ponto alimenta
            # a faixa de incerteza desenhada ao longo do rastro no cliente.
            trail.append([lat, lng, now, head.get("accuracy")])
            if len(trail) > LIVE_TRAIL_MAX_POINTS:
                del trail[:len(trail) - LIVE_TRAIL_MAX_POINTS]
        head["trail"] = trail
        _live_positions[token] = head
    return jsonify(ok=True)


@app.get("/live-locations")
def get_live_locations():
    """Posições ao vivo (janela de 3h) + rastro de cada pessoa. Muda toda hora,
    então SEM ETag/_conditional e com Cache-Control: no-store."""
    now = time.time()
    out = []
    with _live_positions_lock:
        _prune_live(now)
        for t, p in _live_positions.items():
            item = {"id": t, "name": p["name"], "lat": p["lat"], "lng": p["lng"],
                    "ts": p["ts"], "age": round(now - p["ts"], 1),
                    "trail": [[round(pt[0], 5), round(pt[1], 5),
                               (round(pt[3], 1) if len(pt) > 3 and pt[3] is not None else None),
                               round(now - pt[2])]   # idade (s) do ponto, p/ tooltip
                              for pt in p["trail"]]}
            if "accuracy" in p:
                item["accuracy"] = p["accuracy"]
            if "heading" in p:
                item["heading"] = p["heading"]
            out.append(item)
    return Response(json.dumps({"positions": out}, ensure_ascii=False),
                    mimetype="application/json",
                    headers={"Cache-Control": "no-store"})


@app.route("/live-location/stop", methods=["POST", "OPTIONS"])
def post_live_location_stop():
    """Apaga token + rastro na hora. Não é mais chamado automaticamente (o
    rastro fica até expirar da janela de 3h) — fica disponível pra uma ação
    explícita futura de "apagar meu rastro agora"."""
    if request.method == "OPTIONS":
        return ("", 204)
    data = request.get_json(silent=True) or {}
    with _live_positions_lock:   # mesma disciplina dos outros acessos ao dict
        _live_positions.pop(str(data.get("id") or "").strip(), None)
    return jsonify(ok=True)


# ── Validador SHACL (lazy) ───────────────────────────────────────────────
# rdflib + pyshacl são pesados: carregamos só na primeira validação para
# manter o boot do servidor barato.
_validator = None


def _load_validator():
    global _validator
    if _validator is not None:
        return _validator
    import pyshacl
    from rdflib import Graph
    # owlrl (a inferência rdfs do pyshacl) troca os conversores de datatype do
    # rdflib GLOBALMENTE durante cada closure (use_Alt_lexical_conversions) e
    # restaura no fim. Qualquer thread que estivesse parseando Turtle nesse
    # intervalo via os xsd:dateTime passarem pelo conversor alternativo, que
    # desloca o offset UTC uma hora (-03:00 → -04:00, …). Como cada gravação
    # re-serializa o catálogo inteiro, o desvio se acumulava a cada upload
    # (435 das 460 datas de mídia chegaram a -23:00; ver
    # scripts/migrate-date-offsets.py). `improved_datatype_generic = True` faz
    # o owlrl acreditar que os conversores já estão instalados e pular a troca
    # (owlrl/__init__.py, DeductiveClosure.expand); a segunda linha garante os
    # do rdflib caso algum closure anterior tenha trocado.
    try:
        import owlrl
        from owlrl import DatatypeHandling
        owlrl.DeductiveClosure.improved_datatype_generic = True
        DatatypeHandling.use_RDFLib_lexical_conversions()
    except Exception as e:  # noqa: BLE001
        print(f"[shacl] aviso: não consegui travar os conversores do owlrl: {e}")
    # Lê via _load_dump_text — bucket-first (permite override sem redeploy),
    # com fallback pro arquivo baked-in no container. Mesma semântica que
    # o catálogo: bucket é a fonte vigente, container é o seed inicial.
    shapes_text = _load_dump_text("shapes.ttl")
    ont_text    = _load_dump_text("ontology.ttl")
    if not shapes_text:
        raise RuntimeError("shapes.ttl ausente em bucket e container")
    if not ont_text:
        raise RuntimeError("ontology.ttl ausente em bucket e container")
    shapes = Graph().parse(data=shapes_text, format="turtle")
    ont    = Graph().parse(data=ont_text, format="turtle")
    _validator = {
        "pyshacl": pyshacl,
        "Graph":   Graph,
        "shapes":  shapes,
        "ont":     ont,
    }
    print(f"[shacl] carregados shapes={len(shapes)} triples, "
          f"ontology={len(ont)} triples")
    return _validator


# ── Catálogo residente em memória ───────────────────────────────────────
# Cada dump (tours/images/identities/lists + shapes/ontology) fica em memória
# como TEXTO (o que /data/<ttl> serve, com ETag) e, pros catálogos, como GRAFO
# rdflib VIVO — parseado UMA vez por processo e mutado in place pelos RMW
# (upsert/purge) sob _state_lock, em vez de re-ler do store + re-parsear
# ~430 KB a cada gravação (era ~120-240 ms de parse por foto, ×6 leituras num
# save de passeio — e em GCS cada leitura era um HEAD+GET).
#
# Regras:
#  • o grafo VIVO (`_dump_graph`) só é tocado sob _state_lock — mutação E
#    iteração (um add/remove concorrente a uma iteração estoura o store de
#    memória do rdflib). Quem lê fora do lock usa o SNAPSHOT (`_load_catalog`),
#    uma cópia imutável da união dos catálogos, refeita preguiçosamente depois
#    de cada commit (~14k adds, dezenas de ms — nada de I/O nem parse).
#  • `_mutating(fname)` é o jeito de mutar: entrega o grafo vivo sob o lock e,
#    ao sair, `_commit_dump` serializa, grava no store, atualiza o texto em
#    cache e invalida o snapshot. Se o corpo ou a gravação falhar, o grafo vivo
#    é descartado (o próximo acesso re-parseia o texto anterior) — memória e
#    store nunca divergem.
#  • Escritas fora de banda no bucket (state-history restore, deploy --state,
#    edição manual) continuam exigindo POST /reload, que zera tudo
#    (`_reset_dump_caches`). É o protocolo que já valia pro catálogo.
_dumps = {}                 # fname → {"text": str|None, "graph": Graph|None}
_catalog_cache = None       # snapshot (união imutável dos CATALOG_DUMPS)


def _invalidate_catalog():
    """Invalida SÓ o snapshot da união (barato de refazer a partir dos grafos
    vivos). _commit_dump já chama; as chamadas explícitas dos handlers seguem
    válidas (idempotente)."""
    global _catalog_cache
    _catalog_cache = None


def _reset_dump_caches():
    """Descarta texto E grafos de todos os dumps — a próxima leitura volta ao
    store. Pra depois de escritas fora de banda (POST /reload)."""
    global _catalog_cache
    with _state_lock:
        _dumps.clear()
        _catalog_cache = None


def _load_dump_text(fname):
    """Texto de um dump TTL — bucket primeiro, container como fallback —
    cacheado em memória até o próximo commit/reload.

    Bucket-first permite override de shapes/ontology/tours sem redeploy do
    container: basta `gcloud storage cp` pro bucket (+ POST /reload). O
    container traz uma cópia "seed" usada quando o bucket ainda não tem o
    arquivo (boot inicial, rollback, dev local sem GCS). Sem lock: o
    setdefault é atômico e, na pior corrida, duas threads leem o store e uma
    delas vence — nunca sobrescreve um grafo vivo já parseado.
    """
    e = _dumps.get(fname)
    if e is not None:
        return e["text"]
    text = STORE.read_text(f"data/{fname}")
    if not text:
        static_path = DATA_DIR / fname
        if static_path.exists() and static_path.stat().st_size > 0:
            text = static_path.read_text()
        else:
            text = None
    return _dumps.setdefault(fname, {"text": text, "graph": None})["text"]


def _dump_graph(fname):
    """Grafo rdflib VIVO do dump `fname` (parseado uma vez por processo). SÓ
    sob _state_lock (RLock — reentrante): é mutado in place pelos RMW.
    Leitura fora do lock → `_load_catalog()` (snapshot)."""
    with _state_lock:
        text = _load_dump_text(fname)
        e = _dumps[fname]
        if e["graph"] is None:
            g = _load_validator()["Graph"]()
            if text:
                g.parse(data=text, format="turtle")
            e["graph"] = g
        return e["graph"]


def _discard_dump_graph(fname):
    """Joga fora o grafo vivo (o texto em cache fica): o próximo acesso
    re-parseia o último estado PERSISTIDO."""
    with _state_lock:
        e = _dumps.get(fname)
        if e is not None:
            e["graph"] = None
        _invalidate_catalog()


def _commit_dump(fname):
    """Persiste o grafo vivo de `fname`: serializa, grava no store, atualiza o
    texto em cache, invalida o snapshot. Sob _state_lock. Se a gravação
    falhar, o grafo vivo é descartado e a exceção sobe pro handler (500)."""
    with _state_lock:
        e = _dumps[fname]
        text = e["graph"].serialize(format="turtle")
        try:
            STORE.write_text(f"data/{fname}", text)
        except Exception:
            _discard_dump_graph(fname)
            raise
        e["text"] = text
        _invalidate_catalog()


class _mutating:
    """`with _mutating("images.ttl") as g:` — grafo vivo pra mutação, sob
    _state_lock; commita ao sair; descarta o grafo vivo se o corpo levantar.
    Aninhável (RLock): _route_new_persons abre identities.ttl de dentro de um
    bloco de images.ttl/tours.ttl."""
    def __init__(self, fname):
        self.fname = fname
    def __enter__(self):
        _state_lock.acquire()
        try:
            return _dump_graph(self.fname)
        except BaseException:
            _state_lock.release()
            raise
    def __exit__(self, exc_type, exc, tb):
        try:
            if exc_type is not None:
                _discard_dump_graph(self.fname)
            else:
                _commit_dump(self.fname)
        finally:
            _state_lock.release()
        return False


# Dumps que compõem o universo de validação. Era descoberto seguindo os
# void:dataDump do manifesto (data_graphs.ttl); hoje a lista é fixa —
# tours.ttl traz tours/pessoas/séries (referenciados por sh:class) e
# uploads.ttl traz imagens + vídeos. shapes/ontology entram à parte no
# validador. O manifesto vira só um shim estático servido pro frontend.
CATALOG_DUMPS = ("tours.ttl", "images.ttl", "identities.ttl", "lists.ttl")


def _load_catalog():
    """SNAPSHOT imutável da união dos CATALOG_DUMPS — pra leitura fora do lock
    (validadores, resolvers, checagens de existência). Refeito
    preguiçosamente a partir dos grafos vivos depois de cada commit; NUNCA
    mutar o objeto devolvido."""
    global _catalog_cache
    snap = _catalog_cache
    if snap is not None:
        return snap
    with _state_lock:
        if _catalog_cache is not None:
            return _catalog_cache
        catalog = _load_validator()["Graph"]()
        for fname in CATALOG_DUMPS:
            catalog += _dump_graph(fname)
        _catalog_cache = catalog
        return catalog


def _validation_universe(data, catalog, exclude, own_subjects, inverse_preds=()):
    """Grafo que o pyshacl valida: o fragmento + a ontologia + SÓ a fatia do
    catálogo que as shapes consultam sobre os nós que o fragmento referencia.

    As shapes só olham pro catálogo em dois lugares: `sh:class` nos OBJETOS do
    fragmento (autora → schema:Person, ph:capturedDuring → ph:Tour, edição →
    ph:SeriesEdition, série → schema:EventSeries, lista → schema:Collection…),
    que precisa das triples rdf:type desses objetos; e o `sh:inversePath
    ph:inSeriesEdition` da SeriesEditionShape (cada edição é realizada por
    EXATAMENTE um passeio), que precisa das arestas dos OUTROS passeios que
    apontam pra mesma edição. Mesclar o catálogo inteiro (~14k triples) só pra
    isso custava ~1,3-1,6 s de closure rdfs + SHACL por gravação — e, como o
    pyshacl roda sob _validate_lock, serializava todos os uploads atrás disso.
    Com o universo referenciado cai pra milissegundos, com os MESMOS
    vereditos (violations e warnings) pros sujeitos do fragmento (paridade
    checada sobre todos os passeios e mídias do catálogo).

    `exclude` = o sujeito em curso + seus nós derivados (re-upload não pode
    sobrepor triples antigas às novas); `inverse_preds` = predicados cujas
    arestas de ENTRADA (do catálogo) nos nós do fragmento entram no universo."""
    from rdflib import URIRef, RDF
    v = _load_validator()
    merged = data + v["ont"]
    refs = {o for o in data.objects()
            if isinstance(o, URIRef) and o not in exclude and o not in own_subjects}
    for o in refs:
        for t in catalog.triples((o, RDF.type, None)):
            merged.add(t)
    for p in inverse_preds:
        for node in own_subjects | refs:
            for s, _p, _o in catalog.triples((None, p, node)):
                if s not in exclude:
                    merged.add((s, _p, _o))
    return merged


def validate_image_ttl(ttl_text):
    """Verifica que o TTL contém exatamente 1 ph:Image e satisfaz as shapes.
    Retorna (ok, phash, errors). `errors` traz só violations (warnings passam)
    cujo focusNode está no TTL recebido — ruído do catálogo (passeios velhos
    com warnings, etc.) não bloqueia o upload."""
    v = _load_validator()
    from rdflib import URIRef, Namespace
    data = v["Graph"]().parse(data=ttl_text, format="turtle")

    RDFT = URIRef("http://www.w3.org/1999/02/22-rdf-syntax-ns#type")
    images = list(data.subjects(RDFT, URIRef(PH_NS + "StillImage")))
    if len(images) != 1:
        return False, None, [
            f"TTL deve conter exatamente 1 ph:Image (achou {len(images)})"
        ]
    image_iri = str(images[0])
    # IRI de mídia é opaco: med:<hash> (sem discriminador image_/video_ — o tipo
    # vem da CLASSE). phash = pHash de 64 bits → exatamente 16 hex (evita cunhar
    # diretórios photos/<phash>/ de tamanho arbitrário).
    if not image_iri.startswith(MED_NS):
        return False, None, [
            f"IRI da Image deve começar com med: (atual: {image_iri})"
        ]
    phash = image_iri[len(MED_NS):]
    if len(phash) != 16 or not all(c in "0123456789abcdef" for c in phash.lower()):
        return False, phash, [f"phash inválido na IRI (esperado 16 hex): {phash}"]

    img_uri = URIRef(image_iri)
    catalog = _load_catalog()
    # Guarda de colisão CROSS-TYPE: sem o discriminador, um phash igual a um
    # vhash existente viraria o MESMO IRI. Rejeita antes de sobrescrever o vídeo.
    if (img_uri, RDFT, URIRef(PH_NS + "MotionImage")) in catalog:
        return False, phash, [
            f"colisão: med:{phash} já existe como VÍDEO (ph:MotionImage) — "
            f"phash colidiu com um vhash. Não dá pra reusar o IRI."
        ]
    # Mescla data + ontology + catálogo, MAS exclui triples do catálogo cujo
    # subject é a imagem em curso (ou bnodes alcançáveis a partir dela). Sem
    # isso, re-upload da mesma foto sobrepõe os triples antigos aos novos, e
    # SHACL flagra cardinalidade > 1 em `dcterms:date` etc.
    # Exclui o próprio sujeito + seus nós derivados (hash, locationCreated).
    exclude = {img_uri} | _derived_subjects(catalog, img_uri)
    # Universo de validação: fragmento + ontologia + tipos dos nós referenciados
    # (ver _validation_universe). A colisão cross-type e o `exclude` seguem
    # calculados sobre o catálogo COMPLETO (dedup/re-upload inalterados).
    own_subjects = set(data.subjects())
    merged = _validation_universe(data, catalog, exclude, own_subjects)
    with _validate_lock:   # pyshacl não é thread-safe (parser SPARQL) — ver _validate_lock
        conforms, results_graph, _txt = v["pyshacl"].validate(
            merged, shacl_graph=v["shapes"], inference="rdfs", advanced=True)
    if conforms:
        return True, phash, []

    # Reporta apenas violations cujo focusNode é um sujeito do TTL recebido.
    # Catálogo (tours.ttl) pode ter warnings legítimos; não são problema do
    # upload em curso.
    own_subjects = set(data.subjects())
    SH = Namespace("http://www.w3.org/ns/shacl#")
    errors = []
    for r in results_graph.subjects(SH.resultSeverity, SH.Violation):
        focus = next(results_graph.objects(r, SH.focusNode), None)
        if focus is None or focus in own_subjects:
            msg = next(results_graph.objects(r, SH.resultMessage), None)
            errors.append(str(msg) if msg else "(sem mensagem)")
    if not errors:
        return True, phash, []
    return False, phash, errors


def _upload_filename():
    """Timestamp único (microssegundos) — `upload_20260526T012345-678901Z.ttl`."""
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S-%f")
    return f"upload_{ts}Z.ttl"


def _ttl_escape(s):
    return (s or "").replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


# ── Mapa de IRIs de passeio (migração P4) ────────────────────────────────
# tour-iri-map.json: id numérico legado ↔ slug novo. Só os 109 passeios da
# migração precisam dele — passeios novos já nascem com slug e não têm id
# antigo. Usado pra: (a) alias 303 de deep links ?tour=<id-numérico> antigos,
# (b) guids estáveis no feed (emite o IRI antigo pra não churnar o RSS).
_TOUR_MAP_PATH = WEB / "data" / "tour-iri-map.json"
_tour_map_cache = None


def _tour_iri_map():
    """{'byOldId': {<numid>: <slug>}, 'byNewSlug': {<slug>: <numid>}}.
    Estático (baked no container); cache em processo. Vazio se ausente."""
    global _tour_map_cache
    if _tour_map_cache is None:
        try:
            _tour_map_cache = json.loads(_TOUR_MAP_PATH.read_text())
        except Exception:  # noqa: BLE001 — sem mapa = degrada sem alias/guid antigo
            _tour_map_cache = {"byOldId": {}, "byNewSlug": {}}
    return _tour_map_cache


def _legacy_tour_iri(slug):
    """IRI antigo (phd:tour_<numid>) de um passeio migrado, ou None. Pra guid
    estável do feed — o IRI antigo é opaco/permanente, o slug novo churna."""
    numid = _tour_iri_map().get("byNewSlug", {}).get(slug)
    return (PHD_NS + "tour_" + numid) if numid else None


# ── Slug legível por passeio (schema:identifier) ─────────────────────────
# Além do slug8 (a IDENTIDADE — o IRI pas:<slug8> não muda), cada passeio
# ganha um slug legível derivado do título, gravado como schema:identifier
# em tours.ttl. É o endereço "bonito" /passeio/foz-do-tamanduatei-…, usado
# em todos os links gerados (compartilhar, sitemap, feed, memória); o slug8
# segue resolvendo e 303a pra forma legível. Mintado server-side UMA vez na
# criação (imutável — renomear o passeio não apodrece links compartilhados).

def _slugify_title(title):
    """Título → slug de URL: sem acentos, minúsculo, [a-z0-9-], ~60 chars
    cortados em fronteira de palavra. Vazio se o título não render nada
    slugificável (só emoji etc.) — aí o slug8 segue sendo o endereço."""
    import re
    import unicodedata
    s = unicodedata.normalize("NFKD", title or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    if len(s) > 60:
        cut = s[:60]
        s = cut.rsplit("-", 1)[0] if "-" in cut else cut
    return s


def _tour_pretty_of(g, t):
    """schema:identifier (slug legível) de um passeio no grafo, ou None.
    Aceita as duas formas do namespace (catálogos antigos podem ter http)."""
    from rdflib import URIRef
    for ns in ("https://schema.org/", "http://schema.org/"):
        v = g.value(t, URIRef(ns + "identifier"))
        if v is not None:
            return str(v)
    return None


def _tour_pretty_maps():
    """(by_pretty: slug legível→slug8, by_id: slug8→slug legível) a partir
    dos schema:identifier de tours.ttl. Deriva do grafo cacheado por digest
    (_tours_graph) — barato o suficiente pra montar por request."""
    from rdflib import RDF, Namespace
    g = _tours_graph()
    PH = Namespace(PH_NS)
    by_pretty, by_id = {}, {}
    for t in g.subjects(RDF.type, PH.Tour):
        if not str(t).startswith(PAS_NS):
            continue
        pretty = _tour_pretty_of(g, t)
        if not pretty:
            continue
        tid = str(t)[len(PAS_NS):]
        by_pretty[pretty] = tid
        by_id[tid] = pretty
    return by_pretty, by_id


def _ensure_tour_slug(ttl_text, tour_id):
    """Garante o slug legível (schema:identifier) no documento final do tour.

    Mintado do dcterms:title na criação e IMUTÁVEL dali em diante (mesma
    filosofia do hash das mídias): um patch carrega o identifier existente
    pelo merge; um replace re-herda do estado persistido. Colisão de título
    → sufixo -2, -3… A unicidade cobre os três espaços que resolvem em
    /passeio/<slug>: slugs legíveis, slug8 (identidade) e ids numéricos
    legados.

    Levanta ValueError se o cliente postou um identifier que já pertence a
    OUTRO passeio (ambiguidade no resolver). Sem título slugificável, o doc
    passa sem identifier.
    """
    from rdflib import Graph, RDF, URIRef
    from rdflib.namespace import DCTERMS
    tour_uri = URIRef(PAS_NS + tour_id)
    ident_preds = (URIRef("https://schema.org/identifier"),
                   URIRef("http://schema.org/identifier"))
    g = Graph().parse(data=ttl_text, format="turtle")
    by_pretty, by_id = _tour_pretty_maps()
    posted = next((str(o) for p in ident_preds for o in g.objects(tour_uri, p)),
                  None)
    if posted is not None:
        owner = by_pretty.get(posted)
        if owner and owner != tour_id:
            raise ValueError(
                f"schema:identifier {posted!r} já pertence ao passeio {owner}")
        return ttl_text
    slug = by_id.get(tour_id)   # já mintado antes → re-herda (imutabilidade)
    if not slug:
        base = _slugify_title(str(g.value(tour_uri, DCTERMS.title) or ""))
        if not base:
            return ttl_text
        gcat = _tours_graph()
        taken = set(by_pretty)
        taken |= {str(t)[len(PAS_NS):]
                  for t in gcat.subjects(RDF.type, URIRef(PH_NS + "Tour"))
                  if str(t).startswith(PAS_NS)}
        taken |= set(_tour_iri_map().get("byOldId", {}))
        taken.discard(tour_id)
        slug, n = base, 2
        while slug in taken:
            slug, n = f"{base}-{n}", n + 1
    return (ttl_text
            + "\n# Slug legível da URL /passeio/<slug> (mintado server-side).\n"
            + f'<{PAS_NS}{tour_id}> <https://schema.org/identifier> '
            + f'"{_ttl_escape(slug)}" .\n')


def _build_audit_ttl(upload_local, phash):
    """Bloco PROV server-side anexado ao TTL do upload. A atividade de envio vira
    env:<ts> (resolvível) e aponta pra mídia em med:<phash>."""
    ts = datetime.now(timezone.utc).isoformat(timespec="microseconds")
    ts = ts.replace("+00:00", "Z")
    # env:<ts> — descarta o prefixo `upload_` do local (o path `/envio/` já diz).
    env_local = upload_local[len("upload_"):] if upload_local.startswith("upload_") else upload_local
    return (
        "\n# Registro de envio (provenance) — adicionado server-side.\n"
        "@prefix prov: <http://www.w3.org/ns/prov#> .\n"
        "@prefix ph:   <https://id.pedalhidrografi.co/terms#> .\n"
        "@prefix med:  <https://id.pedalhidrografi.co/midia/> .\n"
        "@prefix env:  <https://id.pedalhidrografi.co/envio/> .\n"
        "@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .\n"
        "\n"
        f"env:{env_local} a ph:Upload ;\n"
        f"    prov:startedAtTime \"{ts}\"^^xsd:dateTime ;\n"
        f"    prov:generated med:{phash} .\n"
    )


# Manifesto VoID servido em /data/data_graphs.ttl. O frontend (e os agentes
# via llms.txt) seguem os void:dataDump pra achar os dumps. Antes era um Graph
# mutado a cada upload (registrava uploads.ttl on-the-fly); hoje a lista é fixa
# (= CATALOG_DUMPS) e isto é só um shim estático de compatibilidade pros
# clientes/SWs em cache que ainda buscam o manifesto.
DATA_GRAPHS_SHIM = """\
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix void:    <http://rdfs.org/ns/void#> .

<> a void:Dataset ;
    dcterms:title "Pedal Hidrográfico — grafos de dados"@pt ;
    dcterms:license <https://creativecommons.org/licenses/by-sa/4.0/> ;
    void:dataDump <tours.ttl>, <images.ttl>, <identities.ttl>, <lists.ttl> .
"""


def _derived_subjects(graph, root):
    """Sujeitos `<root>_*` — os nós que antes eram bnodes aninhados (geo, hash,
    energy, measured, route) e hoje são IRIs derivadas com o IRI do pai como
    prefixo. O `_` final evita casar IRIs irmãs (phd:tour_1 não pega
    phd:tour_10). Substitui o antigo walk de bnodes alcançáveis."""
    from rdflib import URIRef
    prefix = str(root) + "_"
    return {s for s in set(graph.subjects())
            if isinstance(s, URIRef) and str(s).startswith(prefix)}


def _purge_subject(graph, root):
    """Apaga as triples de `root` e dos seus nós derivados `<root>_*`, mais a
    closure de 1 nível de objetos bnode (geo/hash legados, pré-migração pra
    IRI derivada — ver _resource_slice_ttl, mesmo padrão). Não recursa além
    de 1 nível: nós aninhados são sempre IRIs mintadas, não cadeias de bnode.
    Retorna nº de triples removidas."""
    from rdflib import BNode
    removed = 0
    for subj in {root} | _derived_subjects(graph, root):
        for s, p, o in list(graph.triples((subj, None, None))):
            graph.remove((s, p, o))
            removed += 1
            if isinstance(o, BNode):
                for bs, bp, bo in list(graph.triples((o, None, None))):
                    graph.remove((bs, bp, bo))
                    removed += 1
    return removed


# ── Dereferência (Linked Data) — content negotiation + slice de recurso ──────
# id.pedalhidrografi.co/<tipo>/<slug> é o IRI das coisas; a Cloudflare faz um
# 303 path-preserving pra amora.pedalhidrografi.co/<tipo>/<slug>, onde estes
# handlers respondem: Accept: text/turtle → as triples do recurso; senão a
# página humana (SSR/SPA). Padrão httpRange-14: o IRI nunca devolve 200, o
# documento sobre ele sim.
_RDF_MIMES = ("text/turtle", "application/x-turtle", "application/ld+json",
              "application/rdf+xml", "application/n-triples")


# Markdown pra agentes ("Markdown for Agents" — Cloudflare / isitagentready):
# Accept: text/markdown devolve a MESMA página em Markdown limpo, sem o chrome
# do app (mapa, modais, formulários) — a terceira representação, ao lado do
# HTML (default) e do Turtle. Nas páginas que se montam client-side o Markdown
# é um resumo + ponteiros pros dados; nas SSR'adas (passeio, Memória, série,
# vocabulário, pessoa, mídia, lista) é o conteúdo inteiro.
_MD_MIMES = ("text/markdown", "text/x-markdown")


def _negotiated_format(request):
    """'ttl' | 'md' | 'html' — a representação que o cliente prefere.
    `?format=` força (ttl|turtle|rdf, md|markdown, html|web); senão negocia
    pelo Accept. HTML é o default: curl/browser com */* ou text/html caem
    nele, e um Accept que lista html e markdown com a mesma qualidade também
    (o primeiro da lista desempata). Só um pedido que PREFERE markdown ou
    turtle (ex.: `Accept: text/markdown`) sai do HTML."""
    fmt = (request.args.get("format") or "").lower()
    if fmt in ("ttl", "turtle", "rdf"):
        return "ttl"
    if fmt in ("md", "markdown"):
        return "md"
    if fmt in ("html", "web"):
        return "html"
    best = request.accept_mimetypes.best_match(
        ["text/html", *_RDF_MIMES, *_MD_MIMES])
    if best in _RDF_MIMES:
        return "ttl"
    if best in _MD_MIMES:
        return "md"
    return "html"


def _wants_turtle(request):
    """True quando o cliente prefere RDF/turtle a HTML (ver _negotiated_format)."""
    return _negotiated_format(request) == "ttl"


def _wants_markdown(request):
    """True quando o cliente prefere Markdown a HTML (ver _negotiated_format)."""
    return _negotiated_format(request) == "md"


def _negotiated(resp):
    """Resposta GERADA que varia por Accept (HTML | Markdown | Turtle na mesma
    URL): `Vary: Accept` pra caches guardarem uma variante por representação
    (o `add` preserva o Accept-Encoding do flask-compress) + ETag/conditional.
    NÃO usar nos estáticos que o service worker pré-cacheia (index.html,
    pessoas.html, imagens.html): o Cache API compara os headers listados no
    Vary entre o request guardado (addAll por string, SEM Accept) e o de
    navegação (COM Accept) — com Vary: Accept o shell offline pararia de casar."""
    resp.vary.add("Accept")
    return _conditional(resp)


def _estimate_tokens(text):
    """Estimativa de tokens do corpo (~4 caracteres por token, a heurística
    usual dos tokenizadores BPE) — informativa, como o x-markdown-tokens da
    Cloudflare."""
    return max(1, math.ceil(len(text) / 4))


def _markdown_response(md):
    """text/markdown + os headers da convenção "Markdown for Agents":
    x-markdown-tokens (estimativa), Content-Signal (política de uso — ver
    CONTENT_SIGNAL) e Vary: Accept. no-cache + ETag como as páginas SSR."""
    resp = Response(md, mimetype="text/markdown",
                    headers={"Cache-Control": "no-cache"})
    resp.headers["x-markdown-tokens"] = str(_estimate_tokens(md))
    if CONTENT_SIGNAL:
        resp.headers["Content-Signal"] = CONTENT_SIGNAL
    return _negotiated(resp)


def _md_inline(s):
    """Texto de uma linha pra heading/item de lista Markdown: colapsa quebras
    e espaços (um dcterms:title com \n quebraria o heading)."""
    return " ".join(str(s or "").split())


# ── Descoberta pra agentes (RFC 8288 / RFC 9727 §3) ─────────────────────────
# Link header nas páginas (HTML e Markdown) apontando pros recursos legíveis
# por máquina: o catálogo de APIs (/.well-known/api-catalog, linkset RFC 9264),
# a descrição OpenAPI (service-desc, web/openapi.json — mantido à mão), o guia
# llms.txt (service-doc), o manifesto VoID dos dumps (describedby) e o feed
# RSS (alternate). Referências relativas — resolvem contra a URL da resposta,
# então valem em qualquer host self-hosted. É o equivalente na origem da
# Transform Rule que a Cloudflare sugere.
_DISCOVERY_LINK = ", ".join((
    '</.well-known/api-catalog>; rel="api-catalog"',
    '</openapi.json>; rel="service-desc"; type="application/json"',
    '</llms.txt>; rel="service-doc"; type="text/plain"',
    '</data/data_graphs.ttl>; rel="describedby"; type="text/turtle"',
    '</feed.xml>; rel="alternate"; type="application/rss+xml"',
))


@app.after_request
def _discovery_links(resp):
    """Anexa o Link de descoberta a toda página 200 (HTML/Markdown) — inclusive
    a home, que é onde a RFC 9727 manda o cliente olhar. `add`, não `set`:
    preserva um Link que o handler já tenha posto."""
    if (request.method == "GET" and resp.status_code == 200
            and resp.mimetype in ("text/html", "text/markdown")):
        resp.headers.add("Link", _DISCOVERY_LINK)
    return resp


@app.get("/.well-known/api-catalog")
def api_catalog():
    """Catálogo de APIs (RFC 9727): um linkset JSON (RFC 9264) com uma entrada
    por "API" publicada aqui — a HTTP do amora (OpenAPI + llms.txt + /health)
    e o Linked Data em id.pedalhidrografi.co (VoID + vocabulário). Hrefs
    absolutos em SITE_URL, como o formato pede."""
    catalog = {"linkset": [
        {
            "anchor": SITE_URL,
            "service-desc": [{"href": f"{SITE_URL}openapi.json",
                              "type": "application/json",
                              "title": "OpenAPI 3.1 — API HTTP do amora (leitura)"}],
            "service-doc": [{"href": f"{SITE_URL}llms.txt",
                             "type": "text/plain",
                             "title": "llms.txt — guia do site pra agentes"}],
            "status": [{"href": f"{SITE_URL}health"}],
        },
        {
            "anchor": "https://id.pedalhidrografi.co/",
            "service-doc": [{"href": f"{SITE_URL}llms.txt",
                             "type": "text/plain"}],
            "describedby": [
                {"href": f"{SITE_URL}data/data_graphs.ttl", "type": "text/turtle",
                 "title": "Manifesto VoID — todos os dumps RDF"},
                {"href": f"{SITE_URL}terms", "type": "text/turtle",
                 "title": "Vocabulário ph: (ontology.ttl)"},
            ],
        },
    ]}
    body = json.dumps(catalog, ensure_ascii=False, indent=2)
    return _conditional(Response(body, mimetype="application/linkset+json",
                                 headers={"Cache-Control": "public, max-age=3600"}))


def _resource_slice_ttl(subject_iri, *dump_keys):
    """Turtle descrevendo `subject_iri`: suas triples + os nós derivados
    `<iri>_*` (geo/hash/route) + a closure de 1 nível dos objetos bnode (geo/hash
    legados). Referências a IRIs nomeadas (pessoas, passeios, edições) ficam como
    referência — cada uma dereferencia por conta própria. Lê os dumps dados
    (bucket-first). Devolve turtle str, ou None se o sujeito não tem triples."""
    v = _load_validator()
    Graph = v["Graph"]
    from rdflib import URIRef, BNode
    # Snapshot da união em memória (os dump_keys são sempre CATALOG_DUMPS e a
    # fatia é por sujeito, então a união dá o mesmo resultado — sem re-parsear
    # dumps por request).
    cat = _load_catalog()
    subj = URIRef(subject_iri)
    roots = {subj} | _derived_subjects(cat, subj)
    out = Graph()
    for pfx, ns in (("ph", PH_NS), ("phd", PHD_NS), ("pes", PES_NS),
                    ("schema", SCHEMA_NS), ("dcterms", "http://purl.org/dc/terms/"),
                    ("prov", "http://www.w3.org/ns/prov#"), ("pav", "http://purl.org/pav/"),
                    ("nfo", "http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#"),
                    ("exif", "http://www.w3.org/2003/12/exif/ns#"),
                    ("rdfs", "http://www.w3.org/2000/01/rdf-schema#")):
        out.bind(pfx, ns)
    seen = set()
    for r in roots:
        for s, p, o in cat.triples((r, None, None)):
            out.add((s, p, o))
            if isinstance(o, BNode) and o not in seen:   # closure só p/ bnodes
                seen.add(o)
                for t in cat.triples((o, None, None)):
                    out.add(t)
    if len(out) == 0:
        return None
    return out.serialize(format="turtle")


def _route_new_persons(graph):
    """Move definições de schema:Person do `graph` (fragmento de tour/mídia sendo
    persistido) pra identities.ttl (upsert), deixando o `graph` sem pessoas.

    Pós-split, pessoas vivem SÓ em identities.ttl; tours.ttl/images.ttl apenas as
    referenciam. Quando um cadastro de passeio ou upload de mídia declara uma
    pessoa NOVA inline (Tom Select create-on-the-fly), esta função a desvia pro
    arquivo certo — senão a pessoa vazaria de volta pro catálogo de mídia/passeio
    e recriaria o problema de definição duplicada. Referências (posição de
    objeto) não são tocadas; só definições (sujeito `a schema:Person`)."""
    from rdflib import URIRef
    RDFT = URIRef("http://www.w3.org/1999/02/22-rdf-syntax-ns#type")
    person_cls = (URIRef(SCHEMA_NS + "Person"), URIRef("http://schema.org/Person"))
    persons = set()
    for c in person_cls:
        persons |= set(graph.subjects(RDFT, c))
    if not persons:
        return
    with _mutating("identities.ttl") as idg:
        for p in persons:
            _purge_subject(idg, p)   # upsert: limpa def anterior (pessoas não têm derivados)
            for t in list(graph.triples((p, None, None))):
                idg.add(t)
                graph.remove(t)


def _route_new_collections(graph):
    """Move definições de schema:Collection (listas/álbuns) do `graph` pra
    lists.ttl (upsert), deixando o `graph` de mídia sem Collections.

    Pós-split as listas vivem SÓ em lists.ttl; images.ttl só as referencia via
    schema:isPartOf. Quando um upload/edição de mídia declara uma lista NOVA
    inline (create-on-the-fly na galeria/form), esta função a desvia pro arquivo
    certo — mesma mecânica de [_route_new_persons]. Só definições (sujeito
    `a schema:Collection`) são movidas; referências (isPartOf) ficam."""
    from rdflib import URIRef
    RDFT = URIRef("http://www.w3.org/1999/02/22-rdf-syntax-ns#type")
    coll_cls = (URIRef(SCHEMA_NS + "Collection"), URIRef("http://schema.org/Collection"))
    colls = set()
    for c in coll_cls:
        colls |= set(graph.subjects(RDFT, c))
    if not colls:
        return
    with _mutating("lists.ttl") as lg:
        for li in colls:
            _purge_subject(lg, li)   # upsert: substitui def anterior (listas não têm derivados)
            for t in list(graph.triples((li, None, None))):
                lg.add(t)
                graph.remove(t)


PROV_GEN_URI = "http://www.w3.org/ns/prov#generated"


def upsert_image_in_uploads(image_ttl, phash, audit_ttl):
    """Mescla os blocos da imagem + da activity no único `uploads.ttl`,
    sobrescrevendo qualquer dado prévio para essa mesma imagem."""
    v = _load_validator()
    Graph = v["Graph"]
    from rdflib import URIRef
    image_iri = URIRef(MED_NS + phash)
    # Parse do fragmento ANTES de tocar o grafo vivo: um TTL malformado não
    # pode deixar o catálogo em memória meio-purgado.
    incoming = Graph().parse(data=image_ttl + audit_ttl, format="turtle")
    with _mutating("images.ttl") as catalog:
        # 1) Tira da imagem (+ nós derivados de hash/loc).
        _purge_subject(catalog, image_iri)
        # 2) Tira qualquer ph:Upload activity que tenha gerado essa imagem.
        for s in list(catalog.subjects(URIRef(PROV_GEN_URI), image_iri)):
            _purge_subject(catalog, s)
        # 3) Mescla os novos blocos (imagem + nova activity).
        catalog += incoming
        # 4) Desvia pessoas novas (autora criada on-the-fly) pra identities.ttl
        #    e listas novas inline pra lists.ttl.
        _route_new_persons(catalog)
        _route_new_collections(catalog)


def remove_image_from_uploads(phash):
    """Remove triples da imagem + da sua activity de envio. Retorna nº de triples."""
    from rdflib import URIRef
    image_iri = URIRef(MED_NS + phash)
    with _mutating("images.ttl") as catalog:
        n = _purge_subject(catalog, image_iri)
        for s in list(catalog.subjects(URIRef(PROV_GEN_URI), image_iri)):
            n += _purge_subject(catalog, s)
    return n


# ── Media metadata patch (edição, sem blobs) ─────────────────────────────
# Análogo ao synthesize_tour_patch, mas pra med:<hash> (foto ou vídeo) em
# uploads.ttl. Usado por /update-image e /update-video (edição de metadados +
# listas pelo popup e pelo modo de edição do form) — NÃO toca nos blobs nem
# regenera a activity ph:Upload (sujeito à parte, preservado).
def synthesize_media_patch(media_iri, patch_ttl, remove_preds):
    """Transforma um patch por-predicado (só os predicados afirmados no patch
    sobre a mídia + os listados em `remove_preds`) no documento full-replace
    equivalente. O estado atual da mídia em uploads.ttl é copiado verbatim; os
    predicados a substituir (e a closure `<iri>_*` dos objetos derivados
    descartados) são removidos; o patch inteiro é somado (inclusive sujeitos
    auxiliares novos, ex.: schema:Collection inline). SHACL valida o ESTADO
    FINAL. Retorna o TTL sintetizado."""
    v = _load_validator()
    Graph = v["Graph"]
    from rdflib import URIRef
    media_uri = URIRef(media_iri)
    patch = Graph().parse(data=patch_ttl, format="turtle")
    preds_to_replace = set(patch.predicates(media_uri)) | set(remove_preds)

    result = Graph()
    from rdflib import BNode
    with _state_lock:   # leitura do grafo vivo — sob o lock (ver _dump_graph)
        catalog = _dump_graph("images.ttl")
        for subj in {media_uri} | _derived_subjects(catalog, media_uri):
            for s, p, o in catalog.triples((subj, None, None)):
                result.add((s, p, o))
                # Copia também a closure de 1 nível dos objetos bnode (geo/hash
                # antigos ainda são bnodes na maioria das mídias). Sem isso, um
                # predicado NÃO substituído (ex.: schema:locationCreated) ficaria
                # apontando pra um bnode sem triples → SHACL sh:class falharia.
                if isinstance(o, BNode):
                    for s2, p2, o2 in catalog.triples((o, None, None)):
                        result.add((s2, p2, o2))

    for p in preds_to_replace:
        for o in list(result.objects(media_uri, p)):
            result.remove((media_uri, p, o))
            if isinstance(o, URIRef) and str(o).startswith(str(media_uri) + "_"):
                _purge_subject(result, o)
    for triple in patch:
        result.add(triple)
    return result.serialize(format="turtle")


def upsert_media_node(media_iri, node_ttl):
    """Substitui as triples da mídia (sujeito + nós derivados) em images.ttl
    pelo node_ttl, PRESERVANDO os blobs e a activity ph:Upload (sujeito à parte).
    node_ttl pode trazer schema:Collection novos inline — desviados pra lists.ttl
    por _route_new_collections, nunca persistidos em images.ttl."""
    v = _load_validator()
    Graph = v["Graph"]
    from rdflib import URIRef
    media_uri = URIRef(media_iri)
    incoming = Graph().parse(data=node_ttl, format="turtle")
    with _mutating("images.ttl") as catalog:
        _purge_subject(catalog, media_uri)
        catalog += incoming
        _route_new_collections(catalog)   # listas novas inline → lists.ttl


# ── Tour upserts ─────────────────────────────────────────────────────────
# Mesma mecânica de validação/merge das imagens, mas pra pas:<slug>
# e gravando em tours.ttl em vez de uploads.ttl. Pra dar suporte ao form
# upload_tour.html, que cria/edita 1 tour por vez.

def _single_tour_id(data):
    """Acha exatamente 1 ph:Tour no graph `data` e devolve (tour_id, errors).

    `tour_id` é o sufixo após `pas:` (o slug do passeio). Compartilhado entre a
    validação e a síntese de patch (que precisa do ID antes de montar o resultado).
    """
    from rdflib import URIRef
    RDFT = URIRef("http://www.w3.org/1999/02/22-rdf-syntax-ns#type")
    tours = list(data.subjects(RDFT, URIRef(PH_NS + "Tour")))
    if len(tours) != 1:
        return None, [
            f"TTL deve conter exatamente 1 ph:Tour (achou {len(tours)})"
        ]
    tour_iri = str(tours[0])
    if not tour_iri.startswith(PAS_NS):
        return None, [
            f"IRI do Tour deve começar com pas: (atual: {tour_iri})"
        ]
    tour_id = tour_iri[len(PAS_NS):]
    if not tour_id:
        return None, ["IRI do Tour vazio"]
    # Mesmo charset que delete_tour exige. Sem isso, um IRI completo tipo
    # <https://id.pedalhidrografi.co/passeio/../x> passa (a forma full-IRI
    # aceita "/" e "."), e o tour_id vira componente de path no store
    # (tour_assets/<id>/...) — traversal pra qualquer lugar sob web/ — além
    # de criar tours que o delete-tour depois recusa. `_` é REJEITADO: é o
    # separador dos nós derivados (pas:<slug>_route), então um slug com `_`
    # colidiria com um irmão derivado na hora do purge.
    if not all(c.isalnum() or c == "-" for c in tour_id):
        return None, [
            f"tour_id inválido (apenas [A-Za-z0-9-], sem '_'): {tour_id!r}"
        ]
    return tour_id, []


def validate_tour_ttl(ttl_text):
    """Verifica que o TTL contém exatamente 1 ph:Tour e satisfaz TourShape.

    Retorna (ok, tour_id, errors). `tour_id` é o slug (sufixo após `pas:`).
    """
    v = _load_validator()
    from rdflib import URIRef, Namespace
    data = v["Graph"]().parse(data=ttl_text, format="turtle")

    tour_id, id_errors = _single_tour_id(data)
    if tour_id is None:
        return False, None, id_errors

    # Mescla com ontology + catálogo (excluindo o próprio tour + seus nós
    # derivados pra evitar cardinalidade falsa por sobreposição de re-upload).
    tour_uri = URIRef(PAS_NS + tour_id)
    catalog = _load_catalog()
    exclude = {tour_uri} | _derived_subjects(catalog, tour_uri)
    # Além dos tipos dos nós referenciados, as arestas ph:inSeriesEdition dos
    # OUTROS passeios que apontam pras edições deste (SeriesEditionShape:
    # exatamente um passeio por edição).
    own_subjects = set(data.subjects())
    merged = _validation_universe(
        data, catalog, exclude, own_subjects,
        inverse_preds=(URIRef(PH_NS + "inSeriesEdition"),))

    with _validate_lock:   # pyshacl não é thread-safe (parser SPARQL) — ver _validate_lock
        conforms, results_graph, _txt = v["pyshacl"].validate(
            merged, shacl_graph=v["shapes"], inference="rdfs", advanced=True)
    if conforms:
        return True, tour_id, []

    own_subjects = set(data.subjects())
    SH = Namespace("http://www.w3.org/ns/shacl#")
    errors = []
    for r in results_graph.subjects(SH.resultSeverity, SH.Violation):
        focus = next(results_graph.objects(r, SH.focusNode), None)
        if focus is None or focus in own_subjects:
            msg = next(results_graph.objects(r, SH.resultMessage), None)
            errors.append(str(msg) if msg else "(sem mensagem)")
    if not errors:
        # Só warnings (severidade != Violation) — tratamos como ok.
        return True, tour_id, []
    return False, tour_id, errors


def upsert_tour_in_tours_ttl(tour_ttl, tour_id):
    """Mescla os blocos do tour novo em tours.ttl, sobrescrevendo qualquer
    dado prévio para o mesmo tour IRI. Mantém pessoas/associações antigas
    intactas (não cleanup orfanizados — git history preserva)."""
    v = _load_validator()
    Graph = v["Graph"]
    from rdflib import URIRef
    tour_iri = URIRef(PAS_NS + tour_id)
    incoming = Graph().parse(data=tour_ttl, format="turtle")
    with _mutating("tours.ttl") as catalog:
        _purge_subject(catalog, tour_iri)
        # Mescla os novos blocos (tour + eventual associação/pessoa nova).
        catalog += incoming
        # Desvia pessoas novas (participante/autora criada on-the-fly) pra
        # identities.ttl — tours.ttl só referencia pessoas, não as define.
        _route_new_persons(catalog)


# Prefixos aceitos no campo `remove` do mode=patch (CURIEs → IRIs).
TOUR_PATCH_PREFIXES = {
    "ph":      PH_NS,
    "phd":     PHD_NS,
    "schema":  "https://schema.org/",
    "dcterms": "http://purl.org/dc/terms/",
    "dct":     "http://purl.org/dc/terms/",
    "prov":    "http://www.w3.org/ns/prov#",
    "pav":     "http://purl.org/pav/",
    "qudt":    "http://qudt.org/schema/qudt/",
    "exif":    "http://www.w3.org/2003/12/exif/ns#",
}


def _expand_remove_preds(remove_field):
    """Expande o form field `remove` ("ph:departedAt,dcterms:description")
    num set de URIRefs. Aceita CURIEs dos prefixos conhecidos ou IRIs
    completas; `schema:` expande pras formas https E http (catálogos antigos
    podem carregar qualquer uma). Levanta ValueError em token inválido."""
    from rdflib import URIRef
    preds = set()
    for tok in (remove_field or "").split(","):
        tok = tok.strip()
        if not tok:
            continue
        if tok.startswith("http://") or tok.startswith("https://"):
            preds.add(URIRef(tok))
            continue
        pfx, sep, local = tok.partition(":")
        ns = TOUR_PATCH_PREFIXES.get(pfx)
        if not sep or ns is None or not local:
            raise ValueError(f"predicado inválido em remove: {tok!r}")
        preds.add(URIRef(ns + local))
        if pfx == "schema":
            preds.add(URIRef("http://schema.org/" + local))
    return preds


def synthesize_tour_patch(patch_ttl, remove_preds, replace_image=False):
    """Transforma um patch (mode=patch) no documento full-replace equivalente.

    Merge-patch por predicado: cada predicado afirmado no patch sobre o tour
    (ou listado em `remove_preds`) substitui os triples existentes desse
    predicado — incluindo a closure de bnodes dos objetos descartados (um
    ph:energyEstimate antigo não deixa órfãos). Todo o resto do tour atual é
    copiado verbatim pro documento sintetizado, então clientes não precisam
    round-tripar predicados que não conhecem. Sujeitos auxiliares do patch
    (pessoas/assocs/séries novas) passam adiante intactos, como no replace.

    `replace_image=True` (announcement novo no request) descarta também o
    schema:image atual, pro handler injetar a URL fresca do upload.

    O resultado segue o pipeline normal (validate_tour_ttl → upsert →
    route-sync), ou seja, o SHACL valida o ESTADO FINAL do tour.

    Retorna (tour_id, result_ttl). Levanta ValueError se o patch não contém
    exatamente 1 ph:Tour com IRI pas:<slug> válido.
    """
    v = _load_validator()
    Graph = v["Graph"]
    from rdflib import URIRef

    patch = Graph().parse(data=patch_ttl, format="turtle")
    tour_id, errors = _single_tour_id(patch)
    if tour_id is None:
        raise ValueError("; ".join(errors))
    tour_uri = URIRef(PAS_NS + tour_id)

    preds_to_replace = set(patch.predicates(tour_uri)) | set(remove_preds)
    if replace_image:
        preds_to_replace.add(URIRef("https://schema.org/image"))
        preds_to_replace.add(URIRef("http://schema.org/image"))

    # Estado atual do tour (subject + nós derivados energy/measured/route) em
    # tours.ttl, copiado verbatim pro documento sintetizado.
    result = Graph()
    with _state_lock:   # leitura do grafo vivo — sob o lock (ver _dump_graph)
        catalog = _dump_graph("tours.ttl")
        for subj in {tour_uri} | _derived_subjects(catalog, tour_uri):
            for s, p, o in catalog.triples((subj, None, None)):
                result.add((s, p, o))

    # Substituição por predicado: tira (tour, p, *) + as triples do nó
    # derivado que esse predicado apontava, depois soma o patch inteiro.
    for p in preds_to_replace:
        for o in list(result.objects(tour_uri, p)):
            result.remove((tour_uri, p, o))
            if isinstance(o, URIRef) and str(o).startswith(str(tour_uri) + "_"):
                _purge_subject(result, o)
    for triple in patch:
        result.add(triple)
    return tour_id, result.serialize(format="turtle")


def remove_tour_from_tours_ttl(tour_id):
    """Remove o tour (e bnodes alcançáveis) do tours.ttl. Não toca em pessoas
    nem associações — git history preserva e elas podem ser referenciadas
    por outros tours. Retorna nº de triples removidos."""
    from rdflib import URIRef
    tour_iri = URIRef(PAS_NS + tour_id)
    with _mutating("tours.ttl") as catalog:
        n = _purge_subject(catalog, tour_iri)
    return n


# ── routes.json (geometria pré-bakada) ───────────────────────────────────
# Atualização incremental: um upload/edit de tour faz upsert da rota daquele
# passeio; um delete (ou edit que tira o linkRoute) remove a entrada. O fetch
# da geometria no RideWithGPS NÃO roda sob o lock global — só o read-modify-
# write do JSON é serializado. Assim um POST /upload-tour não trava uploads de
# fotos concorrentes durante os (até 60 s de) IO de rede.
def _load_routes_payload():
    """Lê routes.json — bucket-first, arquivo bakeado como seed/fallback.

    Devolve o dict `{generatedAt, source, routes:[...]}`. AUSENTE em ambos
    os lugares → payload vazio válido (seed). CORROMPIDO/formato inesperado
    → levanta — coagir pra vazio aqui faria o próximo upsert PERSISTIR o
    catálogo zerado (data loss silencioso); melhor falhar o sync (que é
    best-effort no caller) e deixar o catálogo intacto pra diagnóstico.
    """
    text = STORE.read_text(KEY_ROUTES)
    if text is None:
        baked = WEB / "routes.json"
        if baked.exists() and baked.stat().st_size > 0:
            text = baked.read_text(encoding="utf-8")
    if not text:
        return {"routes": []}
    data = json.loads(text)
    if not isinstance(data, dict) or not isinstance(data.get("routes"), list):
        raise ValueError("routes.json com formato inesperado (sem lista 'routes')")
    return data


def _write_routes_payload(routes):
    """Persiste a lista de entradas (ordenada por data desc, como o build-
    routes.py), regravando metadados do envelope. Sob `_state_lock` pelo
    caller."""
    routes = sorted(routes, key=lambda e: e.get("dateMs") or 0, reverse=True)
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": {"file": "web/data/tours.ttl", "updatedBy": "backend/upload-tour"},
        "routes": routes,
    }
    STORE.write_text(
        KEY_ROUTES,
        json.dumps(payload, indent=2, ensure_ascii=False),
        content_type="application/json; charset=utf-8",
    )


def _current_tour_route_id(tour_id):
    """Lê o tours.ttl VIGENTE e devolve o id da rota do tour (id RWGPS ou
    slug de rota salva do amora) — ou None se o tour não existe ou não tem
    `ph:linkRoute` reconhecido. Usado pra re-checar, sob o
    lock, que o estado não mudou durante o fetch de geometria fora do lock
    (TOCTOU: um delete-tour ou re-edit concorrente durante os até ~120 s de
    IO de rede não pode ser ressuscitado/sobrescrito por um upsert cego)."""
    import rwgps
    from rdflib import URIRef as _URIRef
    try:
        # _tours_graph: tours+identities, cacheado por digest do texto — só
        # re-parseia depois de um commit (era um parse de 280 KB por chamada).
        meta = rwgps.tour_entry_from_graph(_tours_graph(), _URIRef(PAS_NS + tour_id))
    except Exception:  # noqa: BLE001
        return None
    return meta["id"] if meta else None


def _sync_tour_route(tour_id):
    """Sincroniza a entrada de routes.json do tour `tour_id` com o estado atual.

    • Se o tour (no tours.ttl persistido) tem `ph:linkRoute` → RideWithGPS:
      busca a geometria (fora do lock) e faz upsert da entrada (keyed por
      tourIri).
    • `ph:linkRoute` → rota salva do próprio amora (/route/<slug>): a
      geometria vem do saved_routes.json local (sem rede) — e, ao contrário
      do RWGPS, é MUTÁVEL (re-salvar a rota no editor muda o traçado), então
      o curto-circuito de cache de geometria não se aplica: recalcula sempre
      (barato) e o guard `old == entry` evita reescritas sem mudança.
    • Senão (sem linkRoute): remove qualquer entrada existente daquele tour.

    Lê o CATÁLOGO persistido, não o TTL postado: a entrada precisa resolver
    `ph:inSeriesEdition` → assoc → `ph:inEventSeries`/`ph:sequenceInSeries`
    (a numeração de série da sidebar), e os sujeitos `phd:assoc_*` moram fora
    do fragmento do tour — um doc sintetizado pelo mode=patch (e qualquer
    fragmento que referencie assocs já existentes) não os carrega; parsear só
    o fragmento zerava o `number` da entrada. Roda depois do upsert, então o
    catálogo é a fonte da verdade.

    Best-effort: o caller (upload_tour) envolve a chamada em try/except — o
    tour já foi salvo no tours.ttl; uma falha aqui só significa que a
    geometria não entrou (re-rodar build-routes.py conserta). Retorna um
    dict de status pro handler reportar ao form.
    """
    import rwgps
    from rdflib import URIRef as _URIRef

    tour_iri = PAS_NS + tour_id
    try:
        meta = rwgps.tour_entry_from_graph(_tours_graph(), _URIRef(tour_iri))
    except Exception as e:  # noqa: BLE001
        return {"status": "error", "error": f"parse: {e}"}

    # Sem rota RWGPS → garante que a entrada não fica órfã no JSON.
    if meta is None:
        with _state_lock:
            if _current_tour_route_id(tour_id) is not None:
                # Outro edit concorrente (re)adicionou um linkRoute depois
                # deste request; deixa o sync DELE mandar.
                return {"status": "stale"}
            payload = _load_routes_payload()
            before = len(payload["routes"])
            payload["routes"] = [r for r in payload["routes"] if r.get("tourIri") != tour_iri]
            removed = before - len(payload["routes"])
            if removed:
                _write_routes_payload(payload["routes"])
        return {"status": "removed" if removed else "absent"}

    # A geometria já está em routes.json, pra ESTA mesma rota? Então não busca
    # de novo. Traçado de rota é imutável na prática (o próprio código abaixo
    # já apostava nisso ao preservar a geometria antiga quando o fetch falha),
    # enquanto os METADADOS da entrada (título, data, numeração de série) sim
    # mudam a cada patch — e são recalculados do catálogo, de graça.
    #
    # Sem esse curto-circuito, todo patch de qualquer predicado puxava um GPX
    # inteiro do RideWithGPS. Passes em lote (audit-captura.py --sync: 87
    # passeios) e o backfill de gravações (~40) viravam ~130 fetches inúteis,
    # cada um seguido de um rewrite do routes.json de 2 MB — e como o bucket
    # tem Object Versioning, cada rewrite deixa uma geração noncurrent parada
    # por 90 dias. Pra forçar a rebusca da geometria: scripts/build-routes.py.
    cached = None
    if meta.get("provider") != "amora":   # geometria amora é mutável — sem cache
        with _state_lock:
            _p = _load_routes_payload()
            _old = next((r for r in _p["routes"] if r.get("tourIri") == tour_iri), None)
            if _old and _old.get("id") == meta["id"] and _old.get("latlngs"):
                cached = {"latlngs": _old["latlngs"], "pois": _old.get("pois") or []}

    if cached is not None:
        entry = {**meta, **cached}
    elif meta.get("provider") == "amora":
        # Geometria local: estado da rota salva (share format) do catálogo.
        _rid, saved = _find_saved_route(meta["id"])
        state = saved.get("state") if isinstance(saved, dict) else None
        entry = rwgps.build_route_entry(meta, amora_state=state)
    else:
        # Fetch da geometria FORA do lock (IO de rede, pode demorar).
        entry = rwgps.build_route_entry(meta)

    with _state_lock:
        # Re-checa sob o lock: o tour ainda existe e ainda aponta pra MESMA
        # rota? Se não (deletado ou re-editado durante o fetch), descarta —
        # o estado vigente já foi/será sincronizado por quem o mudou.
        if _current_tour_route_id(tour_id) != entry["id"]:
            return {"status": "stale", "rwgpsId": entry["id"]}
        payload = _load_routes_payload()
        old = next((r for r in payload["routes"] if r.get("tourIri") == tour_iri), None)
        # Fetch falhou mas a entrada antiga tem geometria DA MESMA rota →
        # preserva (metadados novos, latlngs/pois antigos). Clobberar com
        # null fazia a rota sumir do mapa a cada save com o RWGPS fora do
        # ar / sem credenciais. Geometria de rota é quase imutável; se um
        # dia precisar forçar, scripts/build-routes.py rebuilda do zero.
        kept = False
        if (not entry.get("latlngs") and old and old.get("latlngs")
                and old.get("id") == entry["id"]):
            entry["latlngs"] = old["latlngs"]
            entry["pois"] = old.get("pois") or []
            kept = True
        # Entrada idêntica à que já está lá → não reescreve. routes.json tem
        # ~2 MB e cada escrita cria uma geração noncurrent no bucket (Object
        # Versioning), que fica ocupando espaço por 90 dias. Um patch que não
        # mexe na rota não tem por que deixar rastro.
        if old == entry:
            return {"status": "unchanged", "rwgpsId": entry["id"]}
        payload["routes"] = [r for r in payload["routes"] if r.get("tourIri") != tour_iri]
        payload["routes"].append(entry)
        _write_routes_payload(payload["routes"])

    prov = entry.get("provider") or "rwgps"
    if kept:
        return {"status": "fetch_failed", "rwgpsId": entry["id"], "provider": prov,
                "error": entry.get("error"), "kept": True}
    if entry.get("latlngs"):
        return {"status": "ok", "rwgpsId": entry["id"], "provider": prov,
                "points": len(entry["latlngs"])}
    return {"status": "fetch_failed", "rwgpsId": entry["id"], "provider": prov,
            "error": entry.get("error")}


def _remove_tour_route(tour_id):
    """Remove a entrada de routes.json do tour (chamado no delete-tour).
    Retorna nº de entradas removidas. Sob lock curto (sem IO de rede)."""
    tour_iri = PAS_NS + tour_id
    with _state_lock:
        payload = _load_routes_payload()
        before = len(payload["routes"])
        payload["routes"] = [r for r in payload["routes"] if r.get("tourIri") != tour_iri]
        removed = before - len(payload["routes"])
        if removed:
            _write_routes_payload(payload["routes"])
    return removed


def _resync_amora_route_tours(slug):
    """Re-sincroniza as entradas de routes.json dos tours cujo `ph:linkRoute`
    aponta pra rota salva `slug` do próprio amora. Chamado (best-effort) pelo
    /save-route: ao contrário do RWGPS, o traçado de uma rota salva MUDA
    quando alguém re-salva no editor — sem isto, o mapa mostraria a geometria
    velha até o próximo edit do passeio. Sem IO de rede (geometria local);
    devolve o nº de tours re-sincronizados."""
    import rwgps
    try:
        g = _tours_graph()
    except Exception:  # noqa: BLE001
        return 0
    from rdflib import Namespace
    PH_ = Namespace(PH_NS)
    SCHEMA_ = Namespace("https://schema.org/")
    n = 0
    for ref in set(g.objects(None, PH_.linkRoute)):
        for url in g.objects(ref, SCHEMA_.url):
            if rwgps.extract_amora_slug(str(url)) != slug:
                continue
            for tour in g.subjects(PH_.linkRoute, ref):
                tour_iri = str(tour)
                if not tour_iri.startswith(PAS_NS):
                    continue
                try:
                    r = _sync_tour_route(tour_iri[len(PAS_NS):])
                    if r.get("status") in ("ok", "unchanged"):
                        n += 1
                except Exception as e:  # noqa: BLE001
                    print(f"[save-route] resync do tour {tour_iri} falhou: {e}")
    return n


# ── Rotas ────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return "ok\n"


@app.post("/reload")
def reload_caches():
    """Invalida os caches do validador (shapes/ontology) e do catálogo
    (uploads, tours). Chame após mexer manualmente em qualquer TTL no
    bucket pra forçar a próxima requisição a re-ler do GCS.

    Sem auth — quem alcança o servidor é de confiança (mesma política
    do resto da API). Restrinja na borda (Cloudflare Worker / Access)
    se isso deixar de valer.

    Em Cloud Run com múltiplas instâncias, isto só invalida o cache
    *desta* instância. Pra forçar todas as instâncias a recarregar,
    role um novo deploy ou:
       gcloud run services update-traffic phidro --to-latest \\
         --region=southamerica-east1 --project=pedal-hidrografico
    (Touchar o traffic recria todas as instâncias.)"""
    global _validator
    _validator = None
    _reset_dump_caches()
    return jsonify(ok=True, reloaded=["validator", "catalog"])


@app.get("/")
@app.get("/index.html")
def index():
    """index.html — deep links por passeio (?tour=<id>) 303am pro endereço
    canônico /passeio/<slug legível ou slug8>, onde mora o SSR (ver
    tour_page). Ids numéricos legados resolvem pelo tour-iri-map.

    Também registrado em /index.html: a Cloudflare reescreve `/` → `/index.html`
    antes do worker, então o deep link /?tour= chega na origem como
    /index.html?tour= — sem esta rota, cairia no static file (sem alias).
    (E quando a CF come a query string, o cliente resolve — tryOpenTourFromQuery.)

    Best-effort: qualquer falha (catálogo corrompido, id desconhecido)
    degrada pro index estático, que é o comportamento de sempre."""
    import re
    tour_id = (request.args.get("tour") or "").strip()
    if tour_id and re.fullmatch(r"[A-Za-z0-9\-]+", tour_id):
        try:
            from rdflib import RDF, Namespace, URIRef
            by_pretty, by_id = _tour_pretty_maps()
            tid = by_pretty.get(tour_id, tour_id)
            # Continuidade (F4): ?tour=<id-numérico> antigo → slug migrado.
            legacy = _tour_iri_map().get("byOldId", {}).get(tour_id)
            if legacy:
                tid = legacy
            if (URIRef(PAS_NS + tid), RDF.type,
                    Namespace(PH_NS).Tour) in _tours_graph():
                return redirect(f"/passeio/{by_id.get(tid, tid)}", code=303)
        except Exception as e:  # noqa: BLE001
            print(f"[tour-page] alias falhou pra ?tour={tour_id}: {e}")
    # Agente (Accept: text/markdown): o guia do site + passeios recentes, em
    # vez do shell do app. O index.html em si segue sem Vary (pré-cacheado
    # pelo service worker — ver _negotiated).
    if _wants_markdown(request):
        return _markdown_response(_render_home_markdown())
    return send_from_directory(WEB, "index.html")


@app.get("/pessoas/<slug>")
def person_page(slug):
    """Dereferência de uma pessoa. O IRI é https://id.pedalhidrografi.co/pessoas/
    <slug> (a Cloudflare faz 303 path-preserving pra cá).

    Conneg (httpRange-14): `Accept: text/turtle` (ou `?format=ttl`) devolve as
    triples da pessoa fatiadas de identities.ttl; senão serve pessoas.html — a
    página humana, que foca a pessoa pelo slug da URL. O arquivo servido é SEMPRE
    pessoas.html (slug ignorado no servidor → sem risco de path); as URLs
    relativas do app resolvem via `<base href="/">`."""
    fmt = _negotiated_format(request)
    if fmt == "ttl":
        ttl = _resource_slice_ttl(PES_NS + slug, "identities.ttl")
        if ttl is None:
            abort(404)
        return _negotiated(Response(ttl, mimetype="text/turtle",
                                    headers={"Cache-Control": "no-cache"}))
    if fmt == "md":   # Accept: text/markdown → ficha da pessoa (ver _render_person_markdown)
        md = _render_person_markdown(slug)
        if md is None:
            abort(404)
        return _markdown_response(md)
    return send_from_directory(WEB, "pessoas.html")


def _terms_model():
    """Modelo do vocabulário ph: lido de ontology.ttl (bucket-first) — o que a
    página humana (HTML) e a de agente (Markdown) do /terms compartilham:
    título/descrição/versão da ontologia + classes e propriedades ph: com
    label, comentário, flag de deprecação e linhas de metadados (em CURIEs).
    None se o ontology.ttl não existe (o handler cai pro turtle)."""
    from rdflib import Graph, URIRef, RDF, RDFS, Namespace
    OWL = Namespace("http://www.w3.org/2002/07/owl#")
    DCT = Namespace("http://purl.org/dc/terms/")
    text = _load_dump_text("ontology.ttl")
    if not text:
        return None
    g = Graph()
    g.parse(data=text, format="turtle")
    NS = {
        "https://id.pedalhidrografi.co/terms#": "ph:",
        "https://schema.org/": "schema:", "http://schema.org/": "schema:",
        "http://www.w3.org/ns/prov#": "prov:",
        "http://purl.org/dc/terms/": "dcterms:",
        "http://www.w3.org/2001/XMLSchema#": "xsd:",
        "http://www.w3.org/2000/01/rdf-schema#": "rdfs:",
        "http://www.w3.org/2002/07/owl#": "owl:",
        "http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#": "nfo:",
        "http://www.w3.org/2003/12/exif/ns#": "exif:",
        "http://purl.org/pav/": "pav:",
    }

    def curie(u):
        s = str(u)
        for full, pfx in NS.items():
            if s.startswith(full):
                return pfx + s[len(full):]
        return s

    def label(subj):
        return next((str(o) for o in g.objects(subj, RDFS.label)), None)

    def comment(subj):
        return next((str(o) for o in g.objects(subj, RDFS.comment)), None)

    def objs(subj, pred):
        return sorted(curie(o) for o in g.objects(subj, pred))

    PH = Namespace("https://id.pedalhidrografi.co/terms#")
    onto = URIRef("https://id.pedalhidrografi.co/terms")
    title = next((str(o) for o in g.objects(onto, DCT.title)), "Vocabulário ph:")
    desc = next((str(o) for o in g.objects(onto, DCT.description)), "")
    ver = next((str(o) for o in g.objects(onto, OWL.versionInfo)), "")

    def is_ph(subj):
        return isinstance(subj, URIRef) and str(subj).startswith(str(PH))
    classes = sorted((s for s in g.subjects(RDF.type, OWL.Class) if is_ph(s)), key=str)
    props = sorted(
        (s for s in set(g.subjects(RDF.type, OWL.ObjectProperty))
         | set(g.subjects(RDF.type, OWL.DatatypeProperty)) if is_ph(s)),
        key=str)

    def term(subj, extra_rows):
        dep = (subj, OWL.deprecated, None) in g \
            and next(g.objects(subj, OWL.deprecated)) \
            and str(next(g.objects(subj, OWL.deprecated))).lower() == "true"
        return {"loc": str(subj)[len(str(PH)):], "label": label(subj),
                "comment": comment(subj), "deprecated": bool(dep),
                "rows": [(k, v) for k, v in extra_rows if v]}

    prop_kind = {p: ("ObjectProperty" if (p, RDF.type, OWL.ObjectProperty) in g
                     else "DatatypeProperty") for p in props}
    return {
        "title": title, "desc": desc, "version": ver,
        "classes": [term(c, [
            ("subclasse de", ", ".join(objs(c, RDFS.subClassOf)) or None),
        ]) for c in classes],
        "props": [term(p, [
            ("tipo", prop_kind[p]),
            ("domínio", ", ".join(objs(p, RDFS.domain)) or None),
            ("imagem", ", ".join(objs(p, RDFS.range)) or None),
            ("subpropriedade de", ", ".join(objs(p, RDFS.subPropertyOf)) or None),
        ]) for p in props],
    }


def _render_terms_markdown():
    """O vocabulário ph: em Markdown (Accept: text/markdown em /terms): mesmo
    conteúdo da página humana — classes e propriedades com label, comentário e
    metadados. None se o ontology.ttl não existe."""
    m = _terms_model()
    if m is None:
        return None

    def section(t):
        head = f"### `ph:{t['loc']}`"
        if t["label"]:
            head += f" — {_md_inline(t['label'])}"
        if t["deprecated"]:
            head += " *(deprecado)*"
        out = [head, ""]
        if t["comment"]:
            out += [str(t["comment"]).strip(), ""]
        for k, v in t["rows"]:
            out.append(f"- {k}: `{v}`")
        if t["rows"]:
            out.append("")
        return out

    out = [f"# {_md_inline(m['title'])}", ""]
    if m["desc"]:
        out += [str(m["desc"]).strip(), ""]
    out.append(f"`@prefix ph: <{PH_NS}>`"
               + (f" · versão {m['version']}" if m["version"] else ""))
    out += ["",
            f"Turtle completo: [{SITE_URL}terms?format=ttl]({SITE_URL}terms?format=ttl) "
            "(ou `Accept: text/turtle` nesta URL). Cada termo dereferencia em "
            f"`{PH_NS}<Termo>`.", "",
            "## Classes", ""]
    for c in m["classes"]:
        out += section(c)
    out += ["## Propriedades", ""]
    for p in m["props"]:
        out += section(p)
    out += ["Pedal Hidrográfico · vocabulário servido de `ontology.ttl`. "
            "Reusa PROV-O, schema.org, Dublin Core, NFO, EXIF, GeoSPARQL.", ""]
    return "\n".join(out)


def _render_terms_html():
    """Página humana do vocabulário ph: — gerada de ontology.ttl (bucket-first).
    Cada termo ganha um âncora = seu localname, então o fragmento do IRI
    (id.pedalhidrografi.co/terms#StillImage) rola até a definição certa depois
    do 303 pra cá. Best-effort: se o ontology.ttl não parsear, devolve None e o
    handler cai pro turtle."""
    m = _terms_model()
    if m is None:
        return None
    title, desc, ver = m["title"], m["desc"], m["version"]

    def esc(s):
        return (str(s).replace("&", "&amp;").replace("<", "&lt;")
                .replace(">", "&gt;").replace('"', "&quot;"))

    def term_card(t):
        loc, lab, com = t["loc"], t["label"], t["comment"]
        rows = "".join(
            f'<div class="row"><span class="k">{esc(k)}</span>'
            f'<span class="v">{esc(v)}</span></div>'
            for k, v in t["rows"])
        badge = ' <span class="dep">deprecado</span>' if t["deprecated"] else ""
        return (
            f'<section id="{esc(loc)}" class="term">'
            f'<h3><code>ph:{esc(loc)}</code>{" — " + esc(lab) if lab else ""}{badge}</h3>'
            f'{f"<p>{esc(com)}</p>" if com else ""}'
            f'<div class="meta">{rows}</div></section>')

    class_html = "".join(term_card(c) for c in m["classes"])
    prop_html = "".join(term_card(p) for p in m["props"])

    return f"""<!doctype html><html lang="pt"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<style>
:root{{color-scheme:dark}}
body{{margin:0;background:#12141a;color:#e6e8ee;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:0 1rem 4rem}}
.wrap{{max-width:820px;margin:0 auto}}
header{{padding:2rem 0 1rem;border-bottom:1px solid #2a2e39}}
h1{{margin:0 0 .3rem;font-size:1.6rem}}
h2{{margin:2.4rem 0 .6rem;font-size:1.15rem;color:#9fd3c7;border-bottom:1px solid #2a2e39;padding-bottom:.3rem}}
h3{{margin:0 0 .35rem;font-size:1rem;font-weight:600}}
code{{background:#1c2029;padding:.08em .35em;border-radius:4px;color:#cfe3ff;font-size:.92em}}
a{{color:#7fb2ff}}
p{{margin:.35rem 0 .5rem;color:#c2c6d2}}
.lede{{color:#c2c6d2}}
.term{{padding:.9rem 0;border-bottom:1px solid #21252f;scroll-margin-top:1rem}}
.meta{{display:flex;flex-direction:column;gap:.15rem;margin-top:.3rem}}
.row{{display:flex;gap:.5rem;font-size:.86rem}}
.k{{color:#7d8296;min-width:9.5rem;flex:0 0 auto}}
.v{{color:#d7dbe6;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}}
.dep{{color:#f2a5a5;font-size:.72rem;border:1px solid #6a3a3a;border-radius:4px;padding:.05em .4em;vertical-align:middle}}
.ttl-link{{margin-top:.8rem;font-size:.9rem}}
footer{{margin-top:3rem;color:#7d8296;font-size:.82rem}}
</style></head><body><div class="wrap">
<header>
<h1>{esc(title)}</h1>
<p class="lede">{esc(desc)}</p>
<p class="lede"><code>@prefix ph: &lt;https://id.pedalhidrografi.co/terms#&gt;</code>{f" · versão {esc(ver)}" if ver else ""}</p>
<p class="ttl-link"><a href="/terms?format=ttl">↓ ontology.ttl (Turtle)</a></p>
</header>
<h2>Classes</h2>
{class_html}
<h2>Propriedades</h2>
{prop_html}
<footer>Pedal Hidrográfico · vocabulário servido de <code>ontology.ttl</code>.
Reusa PROV-O, schema.org, Dublin Core, NFO, EXIF, GeoSPARQL.</footer>
</div></body></html>"""


@app.get("/terms")
def terms_vocab():
    """Dereferência do vocabulário ph:. O namespace é
    https://id.pedalhidrografi.co/terms# — o fragmento (#StillImage) é
    resolvido pelo cliente contra o documento inteiro (F8). Conneg:
    Accept: text/turtle (ou ?format=ttl) → ontology.ttl; senão a página humana
    gerada de ontology.ttl (com âncora por termo). Sem `#` no path — a CF já
    tira o fragmento antes do 303 pra cá."""
    fmt = _negotiated_format(request)
    if fmt == "ttl":
        text = _load_dump_text("ontology.ttl")
        if text is None:
            abort(404)
        return _negotiated(Response(text, mimetype="text/turtle",
                                    headers={"Cache-Control": "no-cache"}))
    try:
        page = _render_terms_markdown() if fmt == "md" else _render_terms_html()
    except Exception as e:  # noqa: BLE001
        print(f"[terms] render ({fmt}) falhou: {e}")
        page = None
    if page is None:  # fallback: entrega o turtle mesmo sem Accept
        text = _load_dump_text("ontology.ttl") or ""
        return _negotiated(Response(text, mimetype="text/turtle",
                                    headers={"Cache-Control": "no-cache"}))
    if fmt == "md":
        return _markdown_response(page)
    return _negotiated(Response(page, mimetype="text/html",
                                headers={"Cache-Control": "no-cache"}))


@app.get("/listas/<slug>")
def list_page(slug):
    """Dereferência de uma lista/álbum (schema:Collection). IRI:
    https://id.pedalhidrografi.co/listas/<slug> (CF 303 pra cá). Conneg:
    Accept: text/turtle (ou ?format=ttl) → a Collection (de lists.ttl) + seus
    membros como schema:hasPart (calculados de images.ttl via schema:isPartOf
    inverso); senão 303 pra galeria JÁ FILTRADA por esta lista
    (imagens.html?list=<slug> — a galeria pré-seleciona a faceta Listas)."""
    list_iri = LST_NS + slug
    fmt = _negotiated_format(request)
    if fmt == "md":   # Accept: text/markdown → a lista + membros (ver _render_list_markdown)
        md = _render_list_markdown(slug)
        if md is None:
            abort(404)
        return _markdown_response(md)
    if fmt != "ttl":
        from urllib.parse import quote
        return redirect(f"/imagens.html?list={quote(slug, safe='')}", code=303)
    from rdflib import URIRef, Literal
    Graph = _load_validator()["Graph"]
    ISPARTOF = URIRef(SCHEMA_NS + "isPartOf")
    HASPART = URIRef(SCHEMA_NS + "hasPart")
    lu = URIRef(list_iri)
    lists_text = _load_dump_text("lists.ttl")
    out = Graph()
    for pfx, ns in (("lst", LST_NS), ("phd", PHD_NS), ("schema", SCHEMA_NS)):
        out.bind(pfx, ns)
    if lists_text:
        lg = Graph().parse(data=lists_text, format="turtle")
        for t in lg.triples((lu, None, None)):
            out.add(t)
    # Membros: mídias que declaram schema:isPartOf <lista> em images.ttl.
    img_text = _load_dump_text("images.ttl")
    if img_text:
        ig = Graph().parse(data=img_text, format="turtle")
        for m in ig.subjects(ISPARTOF, lu):
            out.add((lu, HASPART, m))
    if len(out) == 0:
        abort(404)
    return _negotiated(Response(out.serialize(format="turtle"),
                                mimetype="text/turtle",
                                headers={"Cache-Control": "no-cache"}))


@app.get("/passeio/<slug>")
def tour_page(slug):
    """Dereferência de um passeio. IRI: https://id.pedalhidrografi.co/passeio/
    <slug8> (CF 303 pra cá). Aceita o slug8 (identidade) E o slug legível
    (schema:identifier — ver _ensure_tour_slug); id numérico legado 303a pro
    endereço novo. Conneg: Accept: text/turtle (ou ?format=ttl) → as triples
    do passeio fatiadas de tours.ttl (sujeito canônico pas:<slug8>, em
    qualquer forma da URL); senão a página humana: o index SSR'ado servido
    AQUI MESMO (com <base href="/"> — o app abre o modal pelo path e a URL
    legível fica na barra). slug8 de passeio COM slug legível → 303 canônico
    pra forma legível. Caminho é imune ao strip de query da Cloudflare.
    (A forma de 2 segmentos /passeio/<ES>/<seq> é a edição — rota à parte.)"""
    try:
        by_pretty, by_id = _tour_pretty_maps()
    except Exception as e:  # noqa: BLE001 — catálogo quebrado degrada pro slug cru
        print(f"[tour-page] mapa de slugs falhou: {e}")
        by_pretty, by_id = {}, {}
    tour_id, via_pretty = slug, False
    if slug in by_pretty:
        tour_id, via_pretty = by_pretty[slug], True
    else:
        legacy = _tour_iri_map().get("byOldId", {}).get(slug)
        if legacy:
            return redirect(f"/passeio/{by_id.get(legacy, legacy)}", code=303)
    fmt = _negotiated_format(request)
    if fmt == "ttl":
        ttl = _resource_slice_ttl(PAS_NS + tour_id, "tours.ttl")
        if ttl is None:
            abort(404)
        return _negotiated(Response(ttl, mimetype="text/turtle",
                                    headers={"Cache-Control": "no-cache"}))
    pretty = by_id.get(tour_id)
    if pretty and not via_pretty:
        return redirect(f"/passeio/{pretty}", code=303)
    if fmt == "md":
        # Agente: 404 seco pra passeio desconhecido — o 303 pro deep link
        # antigo (abaixo) só faz sentido pro app, que abre o toast.
        try:
            md = _render_tour_markdown(tour_id)
        except Exception as e:  # noqa: BLE001
            print(f"[tour-page] render markdown falhou pra {tour_id}: {e}")
            abort(500)
        if md is None:
            abort(404)
        return _markdown_response(md)
    try:
        page = _render_tour_index(tour_id)
    except Exception as e:  # noqa: BLE001
        print(f"[tour-page] render falhou pra {tour_id}: {e}")
        page = None
    if page is not None:
        return _negotiated(Response(page, mimetype="text/html",
                                    headers={"Cache-Control": "no-cache"}))
    # Passeio desconhecido (ou render falhou): cai pro deep link antigo — o
    # app abre com o toast de "não encontrado" em vez de um 404 seco.
    return redirect(f"/?tour={slug}", code=303)


def _series_rows(g, editions):
    """Linhas (seq, segmento, título, data, slug do passeio) das edições de uma
    série, mais recente primeiro — compartilhadas pelas páginas HTML e
    Markdown da série."""
    from rdflib import Namespace
    DCT = Namespace("http://purl.org/dc/terms/")
    PH = Namespace(PH_NS)
    INSERIES = PH.inSeriesEdition
    SEQ = PH.sequenceInSeries
    rows = []
    for ed in editions:
        seq_lit = g.value(ed, SEQ)
        try:
            seq_n = int(seq_lit)
        except (TypeError, ValueError):
            seq_n = 0
        seg = str(ed)[len(PAS_NS):]   # "<ES>/<n>" — segmento pro link da edição
        realizer = next(iter(g.subjects(INSERIES, ed)), None)
        tour_title = str(g.value(realizer, DCT.title)) if realizer is not None else None
        tour_date = g.value(realizer, DCT.date) if realizer is not None else None
        tour_slug = None
        if realizer is not None:
            tour_slug = (_tour_pretty_of(g, realizer)
                         or str(realizer)[len(PAS_NS):])
        rows.append((seq_n, seg, tour_title, tour_date, tour_slug))
    rows.sort(key=lambda r: r[0], reverse=True)
    return rows


def _render_series_markdown(g, series_iri, es, editions):
    """A série em Markdown (Accept: text/markdown): edições mais recentes
    primeiro, cada uma linkando pro passeio que a realizou."""
    from rdflib import Namespace
    DCT = Namespace("http://purl.org/dc/terms/")
    title = _md_inline(g.value(series_iri, DCT.title) or es)
    rows = _series_rows(g, editions)
    n = len(rows)
    out = [f"# {title}", "",
           f"Série de eventos do Pedal Hidrográfico (`ser:{es}`) · {n} "
           f"{'edições' if n != 1 else 'edição'}, mais recentes primeiro.", ""]
    for seq_n, seg, tour_title, tour_date, tour_slug in rows:
        label = _md_inline(tour_title) or "(passeio sem título)"
        date_s = str(tour_date)[:10] if tour_date else ""
        link = f"{SITE_URL}passeio/{tour_slug or seg}"
        out.append(f"- [{es} {seq_n}]({link}) — {label}"
                   + (f" · {date_s}" if date_s else ""))
    if not rows:
        out.append("Sem edições.")
    out += ["", "## Dados", "",
            f"- **IRI:** `{SER_NS}{es}`",
            f"- **RDF (Turtle):** [{SITE_URL}serie/{es}?format=ttl]"
            f"({SITE_URL}serie/{es}?format=ttl) — ou `Accept: text/turtle` na mesma URL",
            f"- Cada edição também dereferencia: `{PAS_NS}{es}/<nº>` (303 pro passeio)",
            ""]
    return "\n".join(out)


def _render_series_html(g, series_iri, es, editions):
    """Página humana de uma série de eventos — lista as edições (mais recente
    primeiro), cada uma linkando pro passeio que a realizou. Mesmo estilo
    escuro de _render_terms_html; best-effort (nunca falha o request)."""
    from rdflib import URIRef, Namespace
    DCT = Namespace("http://purl.org/dc/terms/")
    SCHEMA = Namespace(SCHEMA_NS)
    PH = Namespace(PH_NS)
    INSERIES = PH.inSeriesEdition
    SEQ = PH.sequenceInSeries

    def esc(s):
        return (str(s).replace("&", "&amp;").replace("<", "&lt;")
                .replace(">", "&gt;").replace('"', "&quot;"))

    title = str(g.value(series_iri, DCT.title) or es)

    rows = _series_rows(g, editions)

    def row_html(seq_n, seg, tour_title, tour_date, tour_slug):
        label = tour_title or "(passeio sem título)"
        date_s = str(tour_date)[:10] if tour_date else ""
        link = f"/passeio/{esc(tour_slug or seg)}"
        return (
            f'<div class="row"><span class="k"><a href="{esc(link)}">'
            f'{esc(es)} {seq_n}</a></span>'
            f'<span class="v">{esc(label)}{f" · {esc(date_s)}" if date_s else ""}</span></div>')

    rows_html = "".join(row_html(*r) for r in rows) or '<p class="lede">Sem edições.</p>'

    return f"""<!doctype html><html lang="pt"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)} — série</title>
<style>
:root{{color-scheme:dark}}
body{{margin:0;background:#12141a;color:#e6e8ee;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:0 1rem 4rem}}
.wrap{{max-width:640px;margin:0 auto}}
header{{padding:2rem 0 1rem;border-bottom:1px solid #2a2e39}}
h1{{margin:0 0 .3rem;font-size:1.6rem}}
code{{background:#1c2029;padding:.08em .35em;border-radius:4px;color:#cfe3ff;font-size:.92em}}
a{{color:#7fb2ff;text-decoration:none}}
a:hover{{text-decoration:underline}}
p{{margin:.35rem 0 .5rem;color:#c2c6d2}}
.lede{{color:#c2c6d2}}
.row{{display:flex;gap:.8rem;padding:.55rem 0;border-bottom:1px solid #21252f;font-size:.92rem}}
.k{{min-width:5.5rem;flex:0 0 auto;font-weight:600}}
.v{{color:#d7dbe6}}
.ttl-link{{margin-top:.8rem;font-size:.9rem}}
footer{{margin-top:2rem;color:#7d8296;font-size:.82rem}}
</style></head><body><div class="wrap">
<header>
<h1>{esc(title)}</h1>
<p class="lede"><code>ser:{esc(es)}</code> · {len(rows)} {'edições' if len(rows) != 1 else 'edição'}</p>
<p class="ttl-link"><a href="/serie/{esc(es)}?format=ttl">↓ Turtle</a></p>
</header>
{rows_html}
<footer>Pedal Hidrográfico · série de eventos, servida de tours.ttl.</footer>
</div></body></html>"""


@app.get("/serie/<es>")
def series_page(es):
    """Dereferência de uma série de eventos (schema:EventSeries). IRI:
    https://id.pedalhidrografi.co/serie/<ES> (ex.: .../serie/PH). Conneg:
    Accept: text/turtle (ou ?format=ttl) → a série + suas edições
    (ph:SeriesEdition, via ph:inEventSeries inverso) + o passeio que realiza
    cada uma; senão uma página HTML gerada listando as edições (mais recente
    primeiro), cada uma linkando pro passeio realizador."""
    from rdflib import URIRef
    Graph = _load_validator()["Graph"]
    tours_text = _load_dump_text("tours.ttl")
    if not tours_text:
        abort(404)
    g = Graph().parse(data=tours_text, format="turtle")
    series_iri = URIRef(SER_NS + es)
    if (series_iri, None, None) not in g:
        abort(404)
    INEVENTSERIES = URIRef(PH_NS + "inEventSeries")
    INSERIES = URIRef(PH_NS + "inSeriesEdition")
    editions = list(g.subjects(INEVENTSERIES, series_iri))
    fmt = _negotiated_format(request)
    if fmt != "ttl":
        try:
            page = (_render_series_markdown if fmt == "md"
                    else _render_series_html)(g, series_iri, es, editions)
        except Exception as e:  # noqa: BLE001
            print(f"[series] render ({fmt}) falhou pra ser:{es}: {e}")
            page = None
        if page is not None:
            if fmt == "md":
                return _markdown_response(page)
            return _negotiated(Response(page, mimetype="text/html",
                                        headers={"Cache-Control": "no-cache"}))
    out = Graph()
    for pfx, ns in (("pas", PAS_NS), ("ser", SER_NS), ("ph", PH_NS),
                    ("dcterms", "http://purl.org/dc/terms/")):
        out.bind(pfx, ns)
    for t in g.triples((series_iri, None, None)):
        out.add(t)
    for ed in editions:
        for t in g.triples((ed, None, None)):
            out.add(t)
        realizer = next(iter(g.subjects(INSERIES, ed)), None)
        if realizer is not None:
            out.add((realizer, INSERIES, ed))
    return _negotiated(Response(out.serialize(format="turtle"),
                                mimetype="text/turtle",
                                headers={"Cache-Control": "no-cache"}))


@app.get("/passeio/<es>/<seq>")
def edition_page(es, seq):
    """Dereferência de uma EDIÇÃO de série (ph:SeriesEdition). IRI:
    https://id.pedalhidrografi.co/passeio/<ES>/<seq> (ex.: .../passeio/BP/4,
    .../passeio/BP/3-5). 2 segmentos — não confunde com o passeio (1 segmento,
    /passeio/<slug>). Conneg: turtle → as triples da edição (de tours.ttl) + a
    aresta do passeio que a realiza; senão 303 pro passeio realizador
    (/passeio/<slug>), resolvido via ph:inSeriesEdition inverso em tours.ttl."""
    from rdflib import URIRef
    edition_iri = f"{PAS_NS}{es}/{seq}"
    Graph = _load_validator()["Graph"]
    tours_text = _load_dump_text("tours.ttl")
    if not tours_text:
        abort(404)
    g = Graph().parse(data=tours_text, format="turtle")
    ed = URIRef(edition_iri)
    INSERIES = URIRef(PH_NS + "inSeriesEdition")
    realizer = next(iter(g.subjects(INSERIES, ed)), None)
    if not _wants_turtle(request):
        if realizer is None:
            abort(404)
        slug = _tour_pretty_of(g, realizer) or str(realizer)[len(PAS_NS):]
        return redirect(f"/passeio/{slug}", code=303)
    out = Graph()
    for pfx, ns in (("pas", PAS_NS), ("ser", SER_NS), ("ph", PH_NS)):
        out.bind(pfx, ns)
    for t in g.triples((ed, None, None)):
        out.add(t)
    if len(out) == 0:
        abort(404)
    if realizer is not None:
        out.add((realizer, INSERIES, ed))
    return _negotiated(Response(out.serialize(format="turtle"),
                                mimetype="text/turtle",
                                headers={"Cache-Control": "no-cache"}))


@app.get("/midia/<local>")
def media_page(local):
    """Dereferência de uma mídia (foto/vídeo). IRI opaco:
    https://id.pedalhidrografi.co/midia/<hash16> (o tipo vem da classe, não do
    IRI). CF 303 pra cá. Conneg: Accept: text/turtle (ou ?format=ttl) → as
    triples da mídia fatiadas de images.ttl; senão 303 pra galeria com a mídia
    pré-selecionada (imagens.html?pick=<hash>). Aceita a forma legada
    /midia/image_<hash> / video_<hash> (tira o prefixo)."""
    for pfx in ("image_", "video_"):
        if local.startswith(pfx):
            local = local[len(pfx):]
            break
    if len(local) != 16 or not all(c in "0123456789abcdef" for c in local.lower()):
        abort(404)
    fmt = _negotiated_format(request)
    if fmt == "md":   # Accept: text/markdown → ficha da mídia (ver _render_media_markdown)
        md = _render_media_markdown(local)
        if md is None:
            abort(404)
        return _markdown_response(md)
    if fmt != "ttl":
        return redirect("/imagens.html?pick=" + local, code=303)
    ttl = _resource_slice_ttl(MED_NS + local, "images.ttl")
    if ttl is None:
        abort(404)
    return _negotiated(Response(ttl, mimetype="text/turtle",
                                headers={"Cache-Control": "no-cache"}))


@app.get("/data/<filename>")
def get_data_ttl(filename):
    """Handler único pra /data/*.ttl — bucket-first, container fallback.

    Inclui os mutáveis (uploads.ttl, data_graphs.ttl) e os estáticos
    overrideables (shapes.ttl, ontology.ttl, tours.ttl). Quando o arquivo
    não existe em nenhum dos dois lugares, devolve um seed razoável pros
    dois mutáveis ou 404 pros demais.
    """
    # Mapa de IRIs de passeio (JSON, estático): o app precisa dele client-side
    # pra resolver deep links ?tour=<id-numérico> antigos → slug (a Cloudflare
    # tira a query string antes de chegar no backend, então o 303 do index()
    # não roda via amora — a continuidade é feita no app.js). Servido do
    # container (byOldId só; byNewSlug não interessa ao cliente).
    if filename == "tour-iri-map.json":
        body = json.dumps({"byOldId": _tour_iri_map().get("byOldId", {})},
                          ensure_ascii=False, separators=(",", ":"))
        return _conditional(Response(body, mimetype="application/json",
                                     headers={"Cache-Control": "no-cache",
                                              "X-Robots-Tag": "noindex"}))
    # O converter padrão do Flask bloqueia "/" mas não um ".." solto —
    # `DATA_DIR / ".."` é um diretório existente e o read_text estourava
    # IsADirectoryError → 500 feio. Só servimos *.ttl de nome simples.
    if not filename.endswith(".ttl") or "/" in filename or ".." in filename:
        abort(404)
    text = _load_dump_text(filename)
    if text is None:
        if filename in ("images.ttl", "identities.ttl", "uploads.ttl", "lists.ttl"):
            text = ""             # catálogo vazio — válido (uploads.ttl: legado)
        elif filename == "data_graphs.ttl":
            text = DATA_GRAPHS_SHIM  # manifesto estático (tours + images + identities)
        else:
            abort(404)
    # robots.txt agora PERMITE o crawl dos dumps que as páginas compõem
    # client-side (senão o renderer do Googlebot via memoria.html/index.html
    # em branco); este header impede que os .ttl em si apareçam como
    # resultado de busca — noindex controla indexação, robots.txt só crawl.
    return _conditional(Response(text, mimetype="text/turtle",
                                 headers={"Cache-Control": "no-cache",
                                          "X-Robots-Tag": "noindex"}))


@app.get("/tour_assets/<path:p>")
def get_tour_asset(p):
    """Imagens de anúncio + qualquer arquivo associado a um tour. Mesma
    lógica de /photos: redireciona pra GCS público quando o store tiver
    URL, stream local caso contrário."""
    key = f"tour_assets/{p}"
    url = STORE.public_url(key)
    if url:
        return redirect(url, code=302)
    local = WEB / "tour_assets" / p
    if local.is_file():
        resp = send_from_directory(WEB / "tour_assets", p)
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return resp
    abort(404)


@app.get("/photos/<path:p>")
def get_photo(p):
    key = f"photos/{p}"
    # Se o store expõe URL pública (GCS), redireciona — muito mais eficiente
    # que streamar via Flask. Local store retorna None e cai no fallback.
    url = STORE.public_url(key)
    if url:
        return redirect(url, code=302)
    # Fallback: serve diretamente do filesystem (modo local).
    if (WEB / "photos" / p).is_file():
        resp = send_from_directory(WEB / "photos", p)
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return resp
    abort(404)


@app.get("/clips/<path:p>")
def get_clip(p):
    """Mesma lógica do /photos/<p>: redireciona pro bucket em modo GCS,
    senão serve do filesystem. Cobre uploads via /upload-video (vivem em
    gs://<bucket>/clips/<vhash>.*) E os transcodes de build-clips.py (que
    em modo local ficam em web/clips/<stem>.* / web/clips/audio/<stem>.m4a;
    em modo GCS o sync push-eles via deploy-cloudrun.sh --state)."""
    key = f"clips/{p}"
    url = STORE.public_url(key)
    if url:
        return redirect(url, code=302)
    if (WEB / "clips" / p).is_file():
        resp = send_from_directory(WEB / "clips", p)
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return resp
    abort(404)


@app.get("/routes.json")
def get_routes_json():
    """routes.json — bucket-first, arquivo bakeado como seed/fallback.

    Mutável: além do rebuild completo via scripts/build-routes.py, o backend
    faz upsert/remove incremental por upload/delete de tour. Bucket-first faz
    o Cloud Run servir a versão atualizada server-side sem redeploy; em modo
    local o store é o próprio `web/`, então é o mesmo arquivo."""
    text = STORE.read_text(KEY_ROUTES)
    if text is None:
        baked = WEB / "routes.json"
        if baked.exists() and baked.stat().st_size > 0:
            text = baked.read_text(encoding="utf-8")
    if text is None:
        text = '{"routes": []}'
    return _conditional(Response(text, mimetype="application/json",
                                 headers={"Cache-Control": "no-cache"}))


# ── Rotas salvas (biblioteca de rotas do editor) ─────────────────────────
def _read_saved_routes(strict=False):
    """Catálogo de rotas salvas — bucket-first, {"routes": {}} se ausente.

    Por padrão (strict=False, uso em GET) um arquivo corrompido também
    degrada pra vazio, pra não derrubar o endpoint de leitura. Em strict=True
    (uso nos mutadores save/delete-route) um arquivo PRESENTE mas corrompido
    levanta em vez de degradar — coagir pra vazio ali faria o upsert/delete
    seguinte PERSISTIR o catálogo zerado (mesmo raciocínio de
    `_load_routes_payload` pro routes.json)."""
    text = STORE.read_text(KEY_SAVED_ROUTES)
    if not text:
        return {"routes": {}}
    try:
        obj = json.loads(text)
        if not isinstance(obj, dict) or not isinstance(obj.get("routes"), dict):
            raise ValueError("saved_routes.json com formato inesperado (sem dict 'routes')")
    except (ValueError, TypeError):
        if strict:
            raise
        return {"routes": {}}
    return obj


def _write_saved_routes(catalog):
    STORE.write_text(KEY_SAVED_ROUTES, json.dumps(catalog, ensure_ascii=False),
                     content_type="application/json")


def _route_slug(name):
    """Slug do link /route/<slug> — derivado do NOME da rota (a identidade
    humana dela). Implementação única em `rwgps.route_slug` (compartilhada
    com build-routes.py); mesmo algoritmo do filenameFromName do app.js,
    pra link e arquivo baterem."""
    import rwgps
    return rwgps.route_slug(name)


def _entry_slug(entry):
    """Slug de uma entrada do catálogo — o gravado, ou derivado do nome
    (entradas legadas, salvas antes do slug existir)."""
    return entry.get("slug") or _route_slug(entry.get("name"))


_PREVIEW_MAX_PTS = 80   # pontos por miniatura no modal Carregar


def _route_preview_and_dist(state):
    """(preview, distMeters) da geometria de uma rota salva — preview é a
    polyline decodificada (wp + sg) reamostrada a ≤_PREVIEW_MAX_PTS e
    arredondada a 4 casas (~11 m, suficiente pra miniatura); distMeters é o
    haversine sobre a geometria CHEIA. Computado na listagem (barato pro
    catálogo pequeno; nada é persistido por um GET). (None, None) se o
    estado não decodifica."""
    import rwgps
    try:
        latlngs = rwgps.amora_route_geometry(state)["latlngs"]
    except Exception:  # noqa: BLE001
        return None, None
    dist = 0.0
    for i in range(1, len(latlngs)):
        a, b = latlngs[i - 1], latlngs[i]
        dist += rwgps.haversine_meters(a[0], a[1], b[0], b[1])
    pts = latlngs
    if len(pts) > _PREVIEW_MAX_PTS:
        stride = (len(pts) - 1) / (_PREVIEW_MAX_PTS - 1)
        pts = [pts[round(i * stride)] for i in range(_PREVIEW_MAX_PTS)]
    return [[round(la, 4), round(lo, 4)] for la, lo in pts], round(dist)


@app.get("/saved-routes")
def list_saved_routes():
    """Lista das rotas salvas — mais novas primeiro. Cada item leva, além dos
    metadados, o que o modal Carregar mostra nos cards: `preview` (polyline
    reamostrada pra miniatura), `distMeters` (da geometria) e `stats`
    (subida acumulada etc., gravada pelo editor no save — o estado salvo não
    tem elevação, então o servidor não tem como derivá-la)."""
    cat = _read_saved_routes()
    items = []
    for rid, r in cat.get("routes", {}).items():
        if not isinstance(r, dict):
            continue
        preview, dist = _route_preview_and_dist(r.get("state") or {})
        items.append({
            "id": rid,
            "name": r.get("name") or "",
            "slug": _entry_slug(r),
            "created": r.get("created"),
            "updated": r.get("updated"),
            "points": r.get("points"),
            "stats": r.get("stats") if isinstance(r.get("stats"), dict) else None,
            "preview": preview,
            "distMeters": dist,
        })
    items.sort(key=lambda x: x.get("updated") or x.get("created") or "", reverse=True)
    text = json.dumps({"routes": items}, ensure_ascii=False)
    return _conditional(Response(text, mimetype="application/json",
                                 headers={"Cache-Control": "no-cache"}))


def _find_saved_route(ref):
    """Resolve `ref` (id hex OU slug do nome) → (rid, entrada) do catálogo de
    rotas salvas, ou (None, None). Empate de slug (nomes duplicados legados,
    de antes da unicidade) → vence a atualizada mais recentemente."""
    ref = (ref or "").strip()
    if not ref:
        return None, None
    routes = _read_saved_routes().get("routes", {})
    r = routes.get(ref)
    if isinstance(r, dict):
        return ref, r
    matches = [(k, v) for k, v in routes.items()
               if isinstance(v, dict) and _entry_slug(v) == ref]
    if not matches:
        return None, None
    return max(matches, key=lambda kv: kv[1].get("updated")
               or kv[1].get("created") or "")


@app.get("/saved-route/<ref>")
def get_saved_route(ref):
    """Estado completo (formato de compartilhamento) de uma rota salva.

    `ref` é o id hex OU o slug do nome (é o que o deep link /route/<slug>
    resolve). A resposta leva `id`/`slug` junto do estado — o cliente adota o
    id pra um re-salvar atualizar a MESMA rota (applyShareState ignora chaves
    desconhecidas)."""
    rid, r = _find_saved_route(ref)
    if not isinstance(r, dict) or not isinstance(r.get("state"), dict):
        abort(404)
    payload = dict(r["state"])
    payload["id"] = rid
    payload["slug"] = _entry_slug(r)
    text = json.dumps(payload, ensure_ascii=False)
    return _conditional(Response(text, mimetype="application/json",
                                 headers={"Cache-Control": "no-cache"}))


@app.get("/route/<slug>")
def route_deep_link(slug):
    """Link compartilhável de uma rota salva, POR NOME: /route/<slug>.

    Serve uma página mínima com as OG tags da ROTA (título = nome, descrição
    = km/subida, og:image = /route/<slug>/og.png — o traçado renderizado com
    o logo) e redireciona o humano NA HORA pra /#rt=<slug> (script +
    meta-refresh; fragmento nunca chega na Cloudflare nem no service worker,
    mesma razão do #st=). Crawlers de preview (WhatsApp/FB/Telegram) não
    executam JS: leem as tags e montam o card. Slug desconhecido degrada pro
    303 antigo — o app abre e mostra o toast de "rota não encontrada"."""
    import html as _html
    slug = (slug or "").strip().lower()
    if not re.fullmatch(r"[a-z0-9][a-z0-9\-]{0,80}", slug):
        abort(404)
    rid, r = _find_saved_route(slug)
    if not isinstance(r, dict) or not isinstance(r.get("state"), dict):
        return redirect(f"/#rt={slug}", code=303)
    name = r.get("name") or slug
    _, dist = _route_preview_and_dist(r.get("state") or {})
    bits = []
    if dist:
        bits.append(f"{dist / 1000:.1f} km".replace(".", ","))
    st = r.get("stats") if isinstance(r.get("stats"), dict) else {}
    asc = (st or {}).get("ascentM")
    if isinstance(asc, (int, float)) and math.isfinite(asc):
        bits.append(f"↑{round(asc)} m")
    # Quilojaules + faixa de intensidade do censo (De boa…Insano).
    kj = (st or {}).get("energyKj")
    if isinstance(kj, (int, float)) and math.isfinite(kj):
        bits.append(f"{round(kj)} kJ ({_intensity_for(float(kj))})")
    desc = (" · ".join(bits) + " — " if bits else "") + \
        "rota traçada no amora, o mapa do Pedal Hidrográfico"
    target = f"/#rt={slug}"
    page_url = f"{SITE_URL}route/{slug}"
    og_img = f"{page_url}/og.png"
    esc = _html.escape
    page = f"""<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(name)} · amora</title>
<link rel="canonical" href="{esc(page_url)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="amora · Pedal Hidrográfico">
<meta property="og:title" content="{esc(name)}">
<meta property="og:description" content="{esc(desc)}">
<meta property="og:url" content="{esc(page_url)}">
<meta property="og:image" content="{esc(og_img)}">
<meta property="og:image:width" content="{_ROUTE_OG_W}">
<meta property="og:image:height" content="{_ROUTE_OG_H}">
<meta name="twitter:card" content="summary_large_image">
<meta name="description" content="{esc(desc)}">
<meta http-equiv="refresh" content="0;url={esc(target)}">
</head><body>
<p>Abrindo a rota <strong>{esc(name)}</strong> no amora…
<a href="{esc(target)}">clique aqui se não abrir sozinho</a>.</p>
<script>location.replace({json.dumps(target)});</script>
</body></html>"""
    return Response(page, mimetype="text/html",
                    headers={"Cache-Control": "no-cache"})


# ── Imagem OG da rota (preview de link em WhatsApp/redes) ────────────────
# O traçado renderizado server-side (Pillow) sobre a "Morros e Águas" (águas
# e cristas do MESMO FGB de hidrografia que a camada do mapa, lidas por range
# request com bbox via o pacote flatgeobuf) — com o logo do amora no canto
# superior direito e o badge de energia (kJ + faixa de intensidade do censo)
# no inferior direito. 1200×630 (proporção padrão de og:image), renderizado a
# 2× e reduzido com LANCZOS (anti-aliasing).
#
# O card é PRÉ-RENDERIZADO no /save-route (fora do lock, ainda no request —
# a CPU do Cloud Run só é garantida durante requests) e persistido no store
# (route_og/<id>.png), então o crawler do WhatsApp recebe na hora e o card
# sobrevive a restart de instância; o render on-the-fly fica de fallback pra
# rotas salvas antes do pré-render existir.
_ROUTE_OG_W, _ROUTE_OG_H = 1200, 630
_ROUTE_OG_KEY = "route_og/{rid}.png"
_route_og_cache = {}            # (rid, updated) → bytes PNG
_ROUTE_OG_CACHE_MAX = 32

# FGB/GeoJSON via storage.googleapis.com, NÃO telhas.pedalhidrografi.co: a
# Cloudflare 403a user-agents não-browser (urllib), e do Cloud Run o GCS
# direto é mais perto de qualquer jeito. Mesmos arquivos.
_OG_HIDRO_FGB = "https://storage.googleapis.com/telhas/viario/south-america-hidro.fgb"
_OG_PH_NETWORK = "https://storage.googleapis.com/telhas/viario/ph-cycle-network.geojson"
_OG_HIDRO_MAIN_KM2 = 150        # acima disso, só rio/canal/crista (como as miniaturas)
_OG_HIDRO_MAX_FEATURES = 2500
_OG_HIDRO_TIMEOUT_S = 12

# Faixas de intensidade do censo (fonte canônica: intensityFor em
# censo.html) + as cores da pill de lá: (teto exclusivo kJ, rótulo, bg, fg).
# NÃO chame de _intensity_for: esse nome é o helper de módulo (só o rótulo)
# usado pelo feed e pelo SSR — a colisão de nomes fazia o repr da tupla
# vazar pro <article> e pro RSS ("510 quilojaules (('Frito', …))").
_INTENSITY_BANDS = [
    (150,  "De boa",      (211, 242, 224), (20, 83, 45)),
    (300,  "Ok",          (230, 244, 207), (63, 98, 18)),
    (500,  "Endorfinado", (253, 238, 199), (138, 90, 6)),
    (1000, "Frito",       (255, 225, 212), (154, 52, 18)),
    (None, "Insano",      (251, 213, 213), (140, 31, 31)),
]


def _intensity_badge_for(kj):
    for cap, label, bg, fg in _INTENSITY_BANDS:
        if cap is None or kj < cap:
            return label, bg, fg


_og_ttf_bytes = None


def _og_font(size):
    """IBM Plex Mono do próprio repo (web/fonts/, woff2) convertida pra TTF
    em memória via fontTools — Pillow não lê woff2. Conversão uma vez por
    processo; ImageFont por tamanho."""
    global _og_ttf_bytes
    import io
    from PIL import ImageFont
    if _og_ttf_bytes is None:
        from fontTools.ttLib import TTFont
        f = TTFont(str(WEB / "fonts" / "ibm-plex-mono-600.woff2"))
        f.flavor = None
        buf = io.BytesIO()
        f.save(buf)
        _og_ttf_bytes = buf.getvalue()
    return ImageFont.truetype(io.BytesIO(_og_ttf_bytes), size)


_og_network_cache = None


def _og_ph_network():
    """Rede cicloviária do coletivo (GeoJSON minúsculo) — baixada uma vez por
    processo. Falha não cacheia (tenta de novo no próximo render)."""
    global _og_network_cache
    if _og_network_cache is None:
        try:
            import urllib.request
            with urllib.request.urlopen(_OG_PH_NETWORK, timeout=8) as resp:
                _og_network_cache = json.loads(resp.read()).get("features") or []
        except Exception as e:  # noqa: BLE001
            print(f"[route-og] rede do coletivo indisponível: {e}")
            return []
    return _og_network_cache


def _fetch_og_hidro(bb):
    """Feições da Morros e Águas pra bbox do card, numa thread com timeout —
    o /save-route não pode pendurar num range request lento. None = falhou/
    estourou o tempo (o card sai sem águas; melhor card sem fundo que save
    travado)."""
    out = {}

    def work():
        try:
            import flatgeobuf
            fc = flatgeobuf.load_http(
                _OG_HIDRO_FGB,
                bbox=(bb["west"], bb["south"], bb["east"], bb["north"]))
            out["feats"] = fc["features"] if isinstance(fc, dict) else list(fc)
        except Exception as e:  # noqa: BLE001
            print(f"[route-og] hidro FGB indisponível: {e}")
    t = threading.Thread(target=work, daemon=True)
    t.start()
    t.join(_OG_HIDRO_TIMEOUT_S)
    return out.get("feats")


def _bbox_area_km2(bb):
    """Área aproximada da bbox em km² — espelho do bboxAreaKm2 do app.js."""
    mid = math.radians((bb["south"] + bb["north"]) / 2)
    height = (bb["north"] - bb["south"]) * 111.32
    width = (bb["east"] - bb["west"]) * 111.32 * math.cos(mid)
    return abs(height * width)


def _og_hidro_style(p, main_only):
    """Espelho do hidroStyleFor do app.js (folha JOSM "Morros e Águas"):
    rio verde w5, demais águas ocre w3, crista laranja w3; tracejado quando
    em túnel/canalizado. main_only (bbox grande) filtra a renda ilegível."""
    tunnel = bool(p.get("tunnel")) and p.get("tunnel") != "no"
    if p.get("natural") == "ridge":
        return (239, 122, 48), 3, False
    ww = p.get("waterway")
    if ww == "river":
        return (166, 192, 69), 5, tunnel
    if main_only and ww not in ("canal", "riverbank"):
        return None
    if ww:
        return (221, 184, 79), 3, tunnel
    return None if main_only else ((136, 136, 136), 2, False)


def _draw_dashed(d, pts, fill, width, dash, gap):
    """Polyline tracejada — Pillow não tem dash nativo: caminha os segmentos
    acumulando distância e alterna a caneta a cada dash/gap px."""
    on, rem = True, dash
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
        seg = math.hypot(x2 - x1, y2 - y1)
        pos = 0.0
        while pos < seg:
            step = min(rem, seg - pos)
            t0, t1 = pos / seg, (pos + step) / seg
            if on:
                d.line([(x1 + (x2 - x1) * t0, y1 + (y2 - y1) * t0),
                        (x1 + (x2 - x1) * t1, y1 + (y2 - y1) * t1)],
                       fill=fill, width=width)
            pos += step
            rem -= step
            if rem <= 0:
                on = not on
                rem = dash if on else gap


def _render_route_og(entry):
    import io
    import rwgps
    from PIL import Image, ImageDraw
    latlngs = rwgps.amora_route_geometry(entry["state"])["latlngs"]
    ss = 2
    w, h, pad = _ROUTE_OG_W * ss, _ROUTE_OG_H * ss, 90 * ss
    min_lat = min(p[0] for p in latlngs)
    max_lat = max(p[0] for p in latlngs)
    min_lng = min(p[1] for p in latlngs)
    max_lng = max(p[1] for p in latlngs)
    kx = math.cos(math.radians((min_lat + max_lat) / 2))
    span_x = max((max_lng - min_lng) * kx, 1e-6)
    span_y = max(max_lat - min_lat, 1e-6)
    s = min((w - 2 * pad) / span_x, (h - 2 * pad) / span_y)
    ox = (w - span_x * s) / 2
    oy = (h - span_y * s) / 2

    def to_px(la, lo):
        return (ox + (lo - min_lng) * kx * s, oy + (max_lat - la) * s)
    pts = [to_px(la, lo) for la, lo in latlngs]

    img = Image.new("RGB", (w, h), (238, 241, 244))     # --surface do app
    d = ImageDraw.Draw(img)

    # ── Basemap Morros e Águas: bbox GEO da viewBox INTEIRA (inversa da
    # projeção nos cantos), pra água preencher o card até as bordas.
    bb = {
        "west":  min_lng - ox / (kx * s),
        "east":  min_lng + (w - ox) / (kx * s),
        "north": max_lat + oy / s,
        "south": max_lat - (h - oy) / s,
    }
    main_only = _bbox_area_km2(bb) > _OG_HIDRO_MAIN_KM2
    hidro = _fetch_og_hidro(bb) or []
    network = [(f, ((45, 169, 255), 5, False)) for f in _og_ph_network()]
    drawn = 0
    for feat, forced_style in [(f, None) for f in hidro] + network:
        if drawn >= _OG_HIDRO_MAX_FEATURES:
            break
        style = forced_style or _og_hidro_style(feat.get("properties") or {}, main_only)
        if not style:
            continue
        rgb, weight, dashed = style
        geom = feat.get("geometry") or {}
        parts = [geom.get("coordinates")] if geom.get("type") == "LineString" \
            else geom.get("coordinates") if geom.get("type") == "MultiLineString" else []
        for coords in parts or []:
            if not isinstance(coords, list) or len(coords) < 2:
                continue
            ppts = [to_px(c[1], c[0]) for c in coords]   # FGB/GeoJSON: [lng,lat]
            # Fora do canvas inteiro (rede do coletivo cobre a cidade toda) → pula.
            if (max(p[0] for p in ppts) < 0 or min(p[0] for p in ppts) > w
                    or max(p[1] for p in ppts) < 0 or min(p[1] for p in ppts) > h):
                continue
            if dashed:
                _draw_dashed(d, ppts, rgb, weight * ss, 8 * ss, 10 * ss)
            else:
                d.line(ppts, fill=rgb, width=weight * ss, joint="curve")
            drawn += 1

    # ── Traçado por cima (casing branco, como as miniaturas).
    d.line(pts, fill=(255, 255, 255), width=17 * ss, joint="curve")   # casing
    d.line(pts, fill=(255, 91, 58), width=9 * ss, joint="curve")      # --route

    def dot(p, rgb, radius):
        rim = radius + 3 * ss
        d.ellipse([p[0] - rim, p[1] - rim, p[0] + rim, p[1] + rim],
                  fill=(255, 255, 255))
        d.ellipse([p[0] - radius, p[1] - radius, p[0] + radius, p[1] + radius],
                  fill=rgb)
    dot(pts[0], (46, 139, 87), 12 * ss)      # início (verde)
    dot(pts[-1], (179, 67, 30), 10 * ss)     # fim (laranja-escuro)

    # ── Badge de energia (quilojaules + faixa do censo), canto inferior
    # direito — pill com as cores da coluna Intensidade do censo. Só quando o
    # editor gravou stats.energyKj no save (o estado salvo não tem elevação).
    st = entry.get("stats") if isinstance(entry.get("stats"), dict) else None
    kj = st.get("energyKj") if st else None
    if isinstance(kj, (int, float)) and math.isfinite(kj):
        try:
            label, bg_rgb, fg_rgb = _intensity_badge_for(float(kj))
            text = f"{round(kj)} kJ · {label}"
            font = _og_font(24 * ss)
            tb = d.textbbox((0, 0), text, font=font)
            tw, th = tb[2] - tb[0], tb[3] - tb[1]
            px_, py_ = 18 * ss, 11 * ss
            x1, y1 = w - 36 * ss, h - 36 * ss
            x0, y0 = x1 - tw - 2 * px_, y1 - th - 2 * py_
            d.rounded_rectangle([x0, y0, x1, y1], radius=(th + 2 * py_) // 2,
                                fill=bg_rgb, outline=(255, 255, 255), width=2 * ss)
            d.text((x0 + px_ - tb[0], y0 + py_ - tb[1]), text, font=font, fill=fg_rgb)
        except Exception as e:  # noqa: BLE001 — sem fontTools/brotli, card sai sem badge
            print(f"[route-og] badge de energia falhou: {e}")

    logo = Image.open(WEB / "img" / "amora-icon.png").convert("RGBA")
    lw = 120 * ss
    logo = logo.resize((lw, lw), Image.LANCZOS)
    img.paste(logo, (w - lw - 36 * ss, 36 * ss), logo)

    img = img.resize((_ROUTE_OG_W, _ROUTE_OG_H), Image.LANCZOS)
    # PNG-8 (paleta adaptativa): a arte é de cores chapadas, quantiza sem
    # perda visível e corta o peso ~3× — o WhatsApp rejeita og:image grande.
    img = img.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def _og_cache_put(key, png):
    _route_og_cache[key] = png
    while len(_route_og_cache) > _ROUTE_OG_CACHE_MAX:
        _route_og_cache.pop(next(iter(_route_og_cache)))


_og_render_lock = threading.RLock()   # um render por vez (thread do save × GET lazy)


def _refresh_route_og(rid, r=None):
    """(Re)renderiza e PERSISTE o card OG da rota `rid` no store. Chamado em
    thread pelo /save-route (ver _refresh_route_og_async) e, lazy, no primeiro
    GET de uma rota antes do pré-render existir. Falha → apaga o blob antigo
    (melhor card nenhum do que o card de um traçado que já mudou) e devolve
    None. Serializado por _og_render_lock."""
    with _og_render_lock:
        return _render_and_store_route_og(rid, r)


def _refresh_route_og_async(rid, r):
    """Pré-render do card OG DEPOIS da resposta do /save-route: FGB por range
    request + Pillow levam ~2 s e o usuário esperava isso tudo pra ver o
    link/QR. Best-effort — o GET do og.png segue com o render lazy como rede
    de segurança (no Cloud Run a CPU fora de request é throttled e a thread
    pode demorar; o lazy cobre, e o _og_render_lock evita render duplo)."""
    def _run():
        try:
            _refresh_route_og(rid, r)
        except Exception as e:  # noqa: BLE001
            print(f"[route-og] pré-render em thread falhou pra {rid}: {e}")
    threading.Thread(target=_run, name=f"route-og-{rid}", daemon=True).start()


def _render_and_store_route_og(rid, r=None):
    if r is None:
        _, r = _find_saved_route(rid)
    if not isinstance(r, dict) or not isinstance(r.get("state"), dict):
        return None
    key = _ROUTE_OG_KEY.format(rid=rid)
    try:
        png = _render_route_og(r)
    except Exception as e:  # noqa: BLE001 — sem Pillow/estado degenerado
        print(f"[route-og] render falhou pra {rid}: {e}")
        try:
            STORE.delete(key)
        except Exception:  # noqa: BLE001
            pass
        _route_og_cache.pop((rid, r.get("updated") or ""), None)
        return None
    try:
        STORE.write_bytes(key, png, content_type="image/png")
    except Exception as e:  # noqa: BLE001
        print(f"[route-og] persistência falhou pra {rid}: {e}")
    _og_cache_put((rid, r.get("updated") or ""), png)
    return png


@app.get("/route/<slug>/og.png")
def route_og_png(slug):
    """Imagem do card de compartilhamento da rota. Ordem: cache em memória
    (id+updated) → blob pré-renderizado pelo /save-route → render lazy (rota
    salva antes do pré-render existir), que também persiste. A borda
    (Cloudflare) pode cachear por 1 h (max-age)."""
    slug = (slug or "").strip().lower()
    rid, r = _find_saved_route(slug)
    if not isinstance(r, dict) or not isinstance(r.get("state"), dict):
        abort(404)
    key = (rid, r.get("updated") or "")
    png = _route_og_cache.get(key)
    if png is None:
        try:
            png = STORE.read_bytes(_ROUTE_OG_KEY.format(rid=rid))
        except Exception:  # noqa: BLE001
            png = None
        if png is not None:
            _og_cache_put(key, png)
    if png is None:
        with _og_render_lock:
            # A thread do /save-route pode ter acabado de renderizar este card.
            png = _route_og_cache.get(key) or _refresh_route_og(rid, r)
    if png is None:
        abort(404)
    return Response(png, mimetype="image/png",
                    headers={"Cache-Control": "public, max-age=3600"})


@app.post("/save-route")
def save_route():
    """Upsert de uma rota salva. Body JSON: {name, state, stats?, id?}.
    Devolve {id, slug}. `state` é o objeto de snapshotForShare() do editor
    (wp + sg + rm + n); `stats` (ascentM/descentM/energyKj) vem do editor —
    o estado salvo não tem elevação, então é a única fonte de ↑ e kJ. Passar
    `id` (de uma rota existente) sobrescreve in-place; sem id, gera um. O
    NOME é obrigatório e único (case/acento-insensível, via slug): é ele que
    vira o link /route/<slug> — colisão com outra rota devolve 409 com o
    id/name da existente, e o cliente pergunta se o usuário quer atualizá-la
    (re-salva com esse id) ou trocar o nome.

    SEM @serialized de propósito: só o miolo read-modify-write roda sob o
    _state_lock. O resync dos tours (trava por conta própria) roda depois,
    fora do lock; o PRÉ-RENDER do card OG (FGB + Pillow — ~2 s) vai pra uma
    thread depois da resposta (ver _refresh_route_og_async)."""
    data = request.get_json(silent=True) or {}
    state = data.get("state")
    if (not isinstance(state, dict) or not isinstance(state.get("wp"), list)
            or not state["wp"]):
        return jsonify(error="state inválido (sem waypoints)"), 400
    name = str(data.get("name") or state.get("n") or "").strip()
    if not name:
        return jsonify(error="dê um nome à rota (é ele que vira o link)"), 400
    slug = _route_slug(name)
    if not slug:
        return jsonify(error="nome inválido pro link — use ao menos uma letra ou número"), 400
    rid = str(data.get("id") or "").strip() or uuid.uuid4().hex[:12]
    if not (1 <= len(rid) <= 32) or not all(c in "0123456789abcdef" for c in rid):
        return jsonify(error="id inválido (esperado hex)"), 400
    with _state_lock:
        try:
            cat = _read_saved_routes(strict=True)
        except (ValueError, TypeError) as e:
            return jsonify(error=f"saved_routes.json corrompido, recusando salvar: {e}"), 500
        routes = cat.setdefault("routes", {})
        for other_id, other in routes.items():
            if other_id == rid or not isinstance(other, dict):
                continue
            if _entry_slug(other) == slug:
                # id/name da rota existente vão junto: o cliente pergunta se o
                # usuário quer ATUALIZÁ-LA (re-salva com esse id) ou renomear.
                return jsonify(
                    error=f'já existe uma rota chamada "{other.get("name") or slug}"',
                    slug=slug, id=other_id, name=other.get("name") or slug), 409
        existing = routes.get(rid)
        now = datetime.now(timezone.utc).isoformat()
        # Stats do editor — só números finitos entram. energyKj alimenta o
        # badge do card OG e a faixa de intensidade (De boa…Insano).
        stats_in = data.get("stats")
        stats = None
        if isinstance(stats_in, dict):
            stats = {k: round(float(v), 1) for k, v in stats_in.items()
                     if k in ("ascentM", "descentM", "energyKj")
                     and isinstance(v, (int, float)) and math.isfinite(v)}
            stats = stats or None
        routes[rid] = {
            "name": name,
            "slug": slug,
            "state": state,
            "points": len(state["wp"]),
            "stats": stats,
            "created": (existing or {}).get("created") if isinstance(existing, dict) else None,
            "updated": now,
        }
        if not routes[rid]["created"]:
            routes[rid]["created"] = now
        try:
            _write_saved_routes(cat)
        except Exception as e:  # noqa: BLE001
            return jsonify(error=f"persistência: {e}"), 500
    print(f"[save-route] id={rid} slug={slug} pts={routes[rid]['points']} name={name!r}")
    # Passeios que usam esta rota salva como ph:linkRoute (provider amora)
    # ganham a geometria nova em routes.json na hora. Best-effort e local
    # (sem rede); _sync_tour_route trava o que precisa por conta própria.
    synced = 0
    try:
        synced = _resync_amora_route_tours(slug)
    except Exception as e:  # noqa: BLE001
        print(f"[save-route] resync de tours falhou: {e}")
    # Pré-render do card OG (WhatsApp/redes) em thread, depois da resposta.
    _refresh_route_og_async(rid, routes[rid])
    return jsonify(id=rid, slug=slug, syncedTours=synced)


@app.post("/delete-route/<rid>")
@serialized
def delete_route(rid):
    rid = (rid or "").strip()
    try:
        cat = _read_saved_routes(strict=True)
    except (ValueError, TypeError) as e:
        return jsonify(error=f"saved_routes.json corrompido, recusando apagar: {e}"), 500
    if rid not in cat.get("routes", {}):
        return jsonify(error="rota não encontrada", id=rid), 404
    del cat["routes"][rid]
    try:
        _write_saved_routes(cat)
    except Exception as e:  # noqa: BLE001
        return jsonify(error=f"persistência: {e}"), 500
    # Card OG pré-renderizado sai junto (best-effort).
    try:
        STORE.delete(_ROUTE_OG_KEY.format(rid=rid))
    except Exception:  # noqa: BLE001
        pass
    print(f"[delete-route] id={rid}")
    return jsonify(id=rid, deleted=True)


# URL pública canônica — usada no feed RSS (links absolutos). Override por
# env pra quem servir o app em outro domínio.
SITE_URL = (os.environ.get("PUBLIC_BASE_URL")
            or "https://amora.pedalhidrografi.co").rstrip("/") + "/"

# Cache do XML do feed, chaveado pelo hash do tours.ttl — parsear 100 KB de
# Turtle por request seria caro; assim só re-renderiza quando o
# catálogo de tours muda (upload/delete de tour ou edição out-of-band).
_feed_cache = {"digest": None, "xml": None}
_feed_lock = threading.Lock()


def _fmt_moving_duration(dur):
    """xsd:duration 'PT3H30M' → '3h30' / 'PT45M' → '45min'. None se não parsear."""
    import re
    m = re.fullmatch(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:[\d.]+S)?", str(dur))
    if not m or (m.group(1) is None and m.group(2) is None):
        return None
    h, mi = int(m.group(1) or 0), int(m.group(2) or 0)
    return f"{h}h{mi:02d}" if h else f"{mi}min"


def _person_name(g, p):
    """Nome de exibição: schema:name (nome real), senão schema:alternateName
    (apelido/handle), senão o slug opaco da IRI (pes:<slug8> → '<slug8>') como
    último recurso — alternateName é só Warning no PersonShape, não obrigatório."""
    from rdflib import Namespace
    SCHEMA = Namespace("https://schema.org/")
    name = g.value(p, SCHEMA.name)
    if name:
        return str(name)
    alt = g.value(p, SCHEMA.alternateName)
    if alt:
        return str(alt)
    return str(p).split("/")[-1].split("#")[-1]


def _tour_display_title(g, t):
    """dcterms:title com prefixo de série(s): "PH 95: …" / "PH 79 & BP 4: …".
    Código = slug da IRI da série (phd:PH → "PH"), como no app. Ordena por
    sequência decrescente pra série de longa data vir primeiro — o grafo RDF
    não preserva a ordem do Turtle."""
    from rdflib import Namespace
    PH = Namespace(PH_NS)
    DCT = Namespace("http://purl.org/dc/terms/")
    title = str(g.value(t, DCT.title) or t).strip()
    editions = []
    for assoc in g.objects(t, PH.inSeriesEdition):
        ev = g.value(assoc, PH.inEventSeries)
        seq = g.value(assoc, PH.sequenceInSeries)
        if ev is not None and seq is not None:
            code = str(ev).split("/")[-1].split("#")[-1]
            try:
                editions.append((code, int(seq)))
            except (TypeError, ValueError):
                pass
    editions.sort(key=lambda e: e[1], reverse=True)
    if editions:
        title = " & ".join(f"{c} {n}" for c, n in editions) + f": {title}"
    return title


def _tour_date_sort_key(dt):
    """Chave de ordenação p/ (None | datetime naive | datetime aware) sem
    TypeError: datetimes naive e aware não são comparáveis entre si, e um
    único dcterms:date sem timezone junto de outros com timezone derrubava
    /feed.xml e /sitemap.xml de vez (500 permanente até o dado ser corrigido).
    Datas naive são tratadas como UTC — mesma convenção do resto do backend."""
    if dt is None:
        return (False, 0.0)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (True, dt.timestamp())


def _tours_with_identities_text():
    """tours.ttl + identities.ttl concatenados. Pós-split de catálogos, pessoas
    (schema:name/alternateName) vivem só em identities.ttl — qualquer render
    que resolve nomes de autoria (feed, página SSR do passeio) via
    prov:wasAttributedTo precisa das duas, senão _person_name cai pro slug
    opaco da IRI (pes:<slug8>) por falta da definição da pessoa no grafo."""
    tours = _load_dump_text("tours.ttl") or ""
    idents = _load_dump_text("identities.ttl") or ""
    return tours + "\n\n" + idents


def _build_feed_xml(tours_text):
    import re
    from email.utils import format_datetime
    from xml.sax.saxutils import escape
    from rdflib import Graph, Namespace, RDF

    def attr_escape(v):
        # escape() só cobre &/</> — sem isso um valor com `"` fecha o
        # atributo antes da hora (injeção de handler/atributo).
        return escape(v, {'"': "&quot;", "'": "&#39;"})

    PH = Namespace(PH_NS)
    SCHEMA = Namespace("https://schema.org/")
    DCT = Namespace("http://purl.org/dc/terms/")
    PROV = Namespace("http://www.w3.org/ns/prov#")

    g = Graph().parse(data=tours_text, format="turtle")

    tours = []
    for t in g.subjects(RDF.type, PH.Tour):
        date = g.value(t, DCT.date)
        try:
            dt = datetime.fromisoformat(str(date)) if date else None
        except ValueError:
            dt = None
        tours.append((dt, t))
    tours.sort(key=lambda x: _tour_date_sort_key(x[0]), reverse=True)

    items = []
    for dt, t in tours[:50]:
        title = _tour_display_title(g, t)

        ig = g.value(t, PH.linkInstagram)
        # Sem post no IG, o link do item é a página canônica do passeio.
        _lslug = str(t)[len(PAS_NS):] if str(t).startswith(PAS_NS) else None
        link = (str(ig) if ig
                else f"{SITE_URL}passeio/{_tour_pretty_of(g, t) or _lslug}"
                if _lslug else SITE_URL)

        # Métricas pós-pedal (sem energia — ela vai junto da rota no corpo).
        metrics = []

        energy_line = None
        kj = g.value(t, PH.energyEstimate)
        if kj is not None:
            try:
                kj_val = float(kj)
            except (TypeError, ValueError):
                # Forma legada (IRI de QuantityValue) ou lixo — não 500a o
                # feed inteiro por causa de um tour com dado malformado.
                kj_val = None
            if kj_val is not None:
                intensity = _intensity_for(kj_val)
                energy_line = (f"{kj_val:.0f} quilojaules"
                               + (f" ({intensity})" if intensity else ""))

        # <description>: resumo plano — fallback pra leitores que ignoram
        # content:encoded.
        desc = " · ".join(metrics + ([energy_line] if energy_line else [])) \
            or "Passeio do Pedal Hidrográfico."

        # <content:encoded>: corpo rico em HTML — arte do anúncio, narrativa,
        # rota + energia, métricas, elaboradores.
        html = []
        img = g.value(t, SCHEMA.image)
        if img:
            html.append(f'<p><img src="{attr_escape(str(img))}" '
                        f'alt="{attr_escape(title)}" style="max-width:100%"/></p>')
        narrative = g.value(t, DCT.description)
        if narrative:
            for para in re.split(r"\r?\n+", str(narrative).strip()):
                if para.strip():
                    html.append(f"<p>{escape(para.strip())}</p>")
        route_ref = g.value(t, PH.linkRoute)
        route_url = g.value(route_ref, SCHEMA.url) if route_ref else None
        route_block = []
        if route_url:
            u = escape(str(route_url))
            route_block.append(f'Rota: <a href="{attr_escape(str(route_url))}">{u}</a>')
        if energy_line:
            route_block.append(escape(energy_line))
        if route_block:
            html.append("<p>" + "<br/>".join(route_block) + "</p>")
        if metrics:
            html.append(f"<p>{escape(' · '.join(metrics))}</p>")
        authors = sorted(_person_name(g, p) for p in g.objects(t, PROV.wasAttributedTo))
        if authors:
            html.append(f"<p>Alguns elaboradores: {escape(', '.join(authors))}</p>")
        # "]]>" dentro de CDATA encerraria a seção — quebra o token em duas.
        content = "\n".join(html).replace("]]>", "]]]]><![CDATA[>")

        # guid ESTÁVEL (F4): p/ passeios migrados emite o IRI legado
        # (phd:tour_<numid>), que é opaco e permanente — assim a troca do IRI
        # pra pas:<slug> não faz todos os itens reaparecerem como novos no RSS.
        _slug = str(t)[len(PAS_NS):] if str(t).startswith(PAS_NS) else None
        guid = (_legacy_tour_iri(_slug) if _slug else None) or str(t)

        items.append(
            "    <item>\n"
            f"      <title>{escape(title)}</title>\n"
            f"      <link>{escape(link)}</link>\n"
            f"      <guid isPermaLink=\"false\">{escape(guid)}</guid>\n"
            + (f"      <pubDate>{format_datetime(dt)}</pubDate>\n" if dt else "")
            + f"      <description>{escape(desc)}</description>\n"
            + (f"      <content:encoded><![CDATA[{content}]]></content:encoded>\n"
               if content else "")
            + "    </item>"
        )

    newest = next((dt for dt, _ in tours if dt), None)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" '
        'xmlns:content="http://purl.org/rss/1.0/modules/content/" '
        'xmlns:webfeeds="http://webfeeds.org/rss/1.0">\n'
        "  <channel>\n"
        "    <title>Passeios Pedal Hidrográfico</title>\n"
        f"    <link>{escape(SITE_URL)}</link>\n"
        "    <description>Passeios do coletivo de ciclismo urbano Pedal "
        "Hidrográfico na Grande São Paulo — rotas, fotos e histórias.</description>\n"
        "    <language>pt-br</language>\n"
        f"    <atom:link href=\"{escape(SITE_URL)}feed.xml\" rel=\"self\" "
        "type=\"application/rss+xml\"/>\n"
        # Logo do canal — derivado 144px de web/logo-phidro.jpg (o original
        # de 3543px/5MB pesaria nos leitores de feed; o spec do RSS 2.0
        # limita a largura a 144 de todo jeito). Título deve casar com o
        # do canal.
        "    <image>\n"
        f"      <url>{escape(SITE_URL)}logo-phidro-144.jpg</url>\n"
        "      <title>Passeios Pedal Hidrográfico</title>\n"
        f"      <link>{escape(SITE_URL)}</link>\n"
        "      <width>144</width>\n"
        "      <height>144</height>\n"
        "    </image>\n"
        # A maioria dos leitores modernos IGNORA o <image> do RSS 2.0 e usa
        # a extensão webfeeds (Feedly & cia) ou o favicon do domínio do
        # <link>. O webfeeds:icon cobre o primeiro grupo; derivado 512px
        # (buscado uma vez só pelo agregador, peso importa menos).
        f"    <webfeeds:icon>{escape(SITE_URL)}logo-phidro-512.jpg</webfeeds:icon>\n"
        f"    <webfeeds:accentColor>0f1721</webfeeds:accentColor>\n"
        + (f"    <lastBuildDate>{format_datetime(newest)}</lastBuildDate>\n" if newest else "")
        + "\n".join(items) + "\n"
        "  </channel>\n"
        "</rss>\n"
    )


@app.get("/feed.xml")
def get_feed():
    """Feed RSS 2.0 dos passeios, derivado de tours.ttl (50 mais recentes).

    Cada item: título + data do tour, link pro post do IG quando houver
    (senão a home), métricas no description e a arte de anúncio quando o
    tour tiver schema:image. ETag igual aos demais mutáveis — leitores de
    feed revalidam de graça."""
    import hashlib
    text = _tours_with_identities_text()
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()
    with _feed_lock:
        if _feed_cache["digest"] != digest:
            _feed_cache["xml"] = _build_feed_xml(text)
            _feed_cache["digest"] = digest
        xml = _feed_cache["xml"]
    return _conditional(Response(xml, mimetype="application/rss+xml",
                                 headers={"Cache-Control": "no-cache"}))


# Sitemap dinâmico (sobrepõe o web/sitemap.xml estático, que fica como
# fallback de host estático): home + uma URL por passeio (/passeio/<slug
# legível ou slug8> — o app abre o modal da rota). Passeios com data nas últimas
# 48 h ganham o bloco <news:news> do Google News; o cache expira em 1 h
# pra essa janela deslizar mesmo sem mudança no tours.ttl.
_NEWS_WINDOW_S = 48 * 3600
_sitemap_cache = {"digest": None, "xml": None, "built_at": None}


def _build_sitemap_xml(tours_text):
    from xml.sax.saxutils import escape
    from rdflib import Graph, Namespace, RDF

    PH = Namespace(PH_NS)
    DCT = Namespace("http://purl.org/dc/terms/")

    tours = []
    if tours_text:
        g = Graph().parse(data=tours_text, format="turtle")
        for t in g.subjects(RDF.type, PH.Tour):
            date = g.value(t, DCT.date)
            try:
                dt = datetime.fromisoformat(str(date)) if date else None
            except ValueError:
                dt = None
            tour_id = str(t)[len(PAS_NS):] if str(t).startswith(PAS_NS) else str(t).rsplit("/", 1)[-1]
            title = str(g.value(t, DCT.title) or tour_id).strip()
            # URL anunciada = a canônica /passeio/<slug legível ou slug8>.
            tours.append((dt, _tour_pretty_of(g, t) or tour_id, title))
    tours.sort(key=lambda x: _tour_date_sort_key(x[0]), reverse=True)

    now = datetime.now(timezone.utc)
    urls = [
        "  <url>\n"
        f"    <loc>{escape(SITE_URL)}</loc>\n"
        "    <changefreq>weekly</changefreq>\n"
        "  </url>"
    ]
    # Memória Hidrográfica — a linha do tempo muda junto com o catálogo,
    # então o lastmod é a data do passeio mais recente.
    memoria = ["  <url>",
               f"    <loc>{escape(SITE_URL)}memoria.html</loc>"]
    newest = next((dt for dt, _, _ in tours if dt), None)
    if newest:
        memoria.append(f"    <lastmod>{newest.date().isoformat()}</lastmod>")
    memoria += ["    <changefreq>weekly</changefreq>", "  </url>"]
    urls.append("\n".join(memoria))
    for dt, tour_id, title in tours:
        lines = ["  <url>",
                 f"    <loc>{escape(f'{SITE_URL}passeio/{tour_id}')}</loc>"]
        if dt:
            lines.append(f"    <lastmod>{dt.date().isoformat()}</lastmod>")
            # Google News só considera artigos das últimas ~48 h; usamos a
            # data do passeio como publication_date (anúncios futuros dentro
            # da janela também entram — o |Δ| cobre os dois lados).
            if (dt.tzinfo is not None
                    and abs((now - dt.astimezone(timezone.utc)).total_seconds())
                    < _NEWS_WINDOW_S):
                lines.append(
                    "    <news:news>\n"
                    "      <news:publication>\n"
                    "        <news:name>Pedal Hidrográfico</news:name>\n"
                    "        <news:language>pt</news:language>\n"
                    "      </news:publication>\n"
                    f"      <news:publication_date>{escape(dt.isoformat())}</news:publication_date>\n"
                    f"      <news:title>{escape(title)}</news:title>\n"
                    "    </news:news>"
                )
        lines.append("  </url>")
        urls.append("\n".join(lines))

    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n'
        '        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">\n'
        + "\n".join(urls) + "\n"
        "</urlset>\n"
    )


@app.get("/sitemap.xml")
def get_sitemap():
    """Sitemap (com extensão Google News) renderizado de tours.ttl.

    Mesma mecânica de cache do feed, mais um TTL de 1 h porque o bloco
    de news depende do relógio, não só do conteúdo do catálogo."""
    import hashlib
    text = _load_dump_text("tours.ttl") or ""
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()
    now = datetime.now(timezone.utc)
    with _feed_lock:
        stale = (_sitemap_cache["digest"] != digest
                 or _sitemap_cache["built_at"] is None
                 or (now - _sitemap_cache["built_at"]).total_seconds() > 3600)
        if stale:
            _sitemap_cache["xml"] = _build_sitemap_xml(text)
            _sitemap_cache["digest"] = digest
            _sitemap_cache["built_at"] = now
        xml = _sitemap_cache["xml"]
    return _conditional(Response(xml, mimetype="application/xml",
                                 headers={"Cache-Control": "no-cache"}))


# ── Página por passeio (SSR mínimo) ───────────────────────────────────────
# GET /?tour=<id> devolve o index.html com <title>/description/canonical/OG
# trocados pros do passeio, um JSON-LD NewsArticle e um <article> com o
# corpo renderizado de tours.ttl — é o que crawlers e bots de preview (que
# não rodam JS) leem. No browser o app abre o modal da rota (deep link) e
# remove o <article>; o conteúdo SSR fica abaixo do mapa (grid 100vh),
# então não pisca pra usuários com JS.
_tours_graph_cache = {"digest": None, "graph": None}

_MONTHS_PT = ["janeiro", "fevereiro", "março", "abril", "maio", "junho",
              "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"]


def _tours_graph():
    """Grafo parseado de tours.ttl + identities.ttl (autoria via
    prov:wasAttributedTo resolve nome de pessoa — ver _tours_with_identities_text),
    cacheado por hash do texto (parsear ~100 KB de Turtle por request seria o
    custo dominante da página)."""
    import hashlib
    from rdflib import Graph
    text = _tours_with_identities_text()
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()
    with _feed_lock:
        if _tours_graph_cache["digest"] != digest:
            _tours_graph_cache["graph"] = Graph().parse(data=text, format="turtle")
            _tours_graph_cache["digest"] = digest
        return _tours_graph_cache["graph"]


def _render_tour_index(tour_id):
    """index.html com meta/OG/JSON-LD/<article> do passeio — None se o
    tour não existe no catálogo."""
    import json
    import re
    from html import escape as h
    from rdflib import Namespace, RDF, URIRef

    PH = Namespace(PH_NS)
    SCHEMA = Namespace("https://schema.org/")
    DCT = Namespace("http://purl.org/dc/terms/")
    PROV = Namespace("http://www.w3.org/ns/prov#")

    g = _tours_graph()
    t = URIRef(PAS_NS + tour_id)
    if (t, RDF.type, PH.Tour) not in g:
        return None

    # Fatos compartilhados com a representação Markdown (ver _tour_facts).
    d = _tour_facts(g, t)
    title, page_url, dt, date_label = d["title"], d["page_url"], d["dt"], d["date_label"]
    narrative, img_url, energy_line = d["narrative"], d["img_url"], d["energy_line"]
    route_url, ig_url, authors = d["route_url"], d["ig_url"], d["author_names"]

    # Descrição pra <meta>/OG: primeiro parágrafo da narrativa (truncado),
    # senão um resumo do que houver.
    if narrative:
        first = re.split(r"\r?\n+", narrative)[0].strip()
        meta_desc = first if len(first) <= 200 else first[:197].rstrip() + "…"
    else:
        bits = [b for b in (date_label, energy_line) if b]
        meta_desc = ("Passeio do Pedal Hidrográfico"
                     + (" — " + " · ".join(bits) if bits else "."))

    # <article> que o crawler lê (e quem está sem JS).
    a = ['<article id="tour-article" class="tour-article">',
         f"  <h1>{h(title)}</h1>"]
    meta_bits = []
    if dt:
        meta_bits.append(f'<time datetime="{h(dt.isoformat())}">{h(date_label)}</time>')
    meta_bits.append("Pedal Hidrográfico")
    a.append('  <p class="tour-article-meta">' + " · ".join(meta_bits) + "</p>")
    if img_url:
        a.append(f'  <figure><img src="{h(img_url)}" alt="{h(title)}"/></figure>')
    for para in re.split(r"\r?\n+", narrative):
        if para.strip():
            a.append(f"  <p>{h(para.strip())}</p>")
    facts = []
    if route_url:
        facts.append(f'Rota: <a href="{h(str(route_url))}">{h(str(route_url))}</a>')
    if energy_line:
        facts.append(h(energy_line))
    if ig_url:
        facts.append(f'<a href="{h(str(ig_url))}">Post no Instagram</a>')
    if facts:
        a.append("  <p>" + "<br/>".join(facts) + "</p>")
    if authors:
        a.append(f"  <p>Alguns elaboradores: {h(', '.join(authors))}</p>")
    a.append(f'  <p><a href="{h(SITE_URL)}">← mapa do Pedal Hidrográfico</a> · '
             f'<a href="{h(SITE_URL)}memoria.html#{h(tour_id)}">este passeio na '
             "Memória Hidrográfica</a></p>")
    a.append("</article>")
    article = "\n".join(a)

    jsonld = {
        "@context": "https://schema.org",
        "@type": "NewsArticle",
        "headline": title,
        "mainEntityOfPage": page_url,
        "url": page_url,
        "inLanguage": "pt-BR",
        "publisher": {
            "@type": "Organization",
            "name": "Pedal Hidrográfico",
            "url": "https://pedalhidrografi.co/",
            "logo": {"@type": "ImageObject",
                     "url": f"{SITE_URL}logo-phidro-512.jpg"},
        },
    }
    if dt:
        jsonld["datePublished"] = dt.isoformat()
        jsonld["dateModified"] = dt.isoformat()
    if img_url:
        jsonld["image"] = [img_url]
    if meta_desc:
        jsonld["description"] = meta_desc
    if authors:
        jsonld["author"] = [{"@type": "Person", "name": n} for n in authors]
    # Escapa &/</> pra um tour com "</script>" no título/narrativa não
    # fechar a tag e injetar markup no <head> (crawlers/preview bots não
    # têm o CSP da página pra segurar isso). & primeiro, senão o <
    # e > que a gente escreve depois seriam re-escapados.
    jsonld_body = (json.dumps(jsonld, ensure_ascii=False)
                   .replace("&", "\\u0026")
                   .replace("<", "\\u003c")
                   .replace(">", "\\u003e"))
    jsonld_tag = ('<script type="application/ld+json">'
                  + jsonld_body + "</script>")

    html_text = (WEB / "index.html").read_text(encoding="utf-8")
    # Servido também em /passeio/<slug> (não só na raiz): o <base> faz as
    # URLs relativas do app (./app.js, ./data/…) resolverem na raiz do host,
    # como em pessoas.html. CSP tem base-uri 'self'; os href="#" do app são
    # todos preventDefault'ados, então o base não os transforma em navegação.
    if "<base " not in html_text:   # index.html já traz o <base> (idempotente)
        html_text = html_text.replace("<head>", '<head>\n    <base href="/">', 1)

    def attr(pattern, value, text):
        # lambda no replacement: o valor pode conter '\' e '\1' literais.
        return re.sub(pattern, lambda m: m.group(1) + value + m.group(2),
                      text, count=1)

    full_title = f"{title} — amora · Pedal Hidrográfico"
    html_text = re.sub(r"<title>.*?</title>",
                       lambda m: f"<title>{h(full_title)}</title>",
                       html_text, count=1, flags=re.S)
    html_text = attr(r'(<meta name="description" content=")[^"]*(")',
                     h(meta_desc), html_text)
    html_text = attr(r'(<link rel="canonical" href=")[^"]*(")',
                     h(page_url), html_text)
    html_text = attr(r'(<meta property="og:title" content=")[^"]*(")',
                     h(full_title), html_text)
    html_text = attr(r'(<meta property="og:description" content=")[^"]*(")',
                     h(meta_desc), html_text)
    html_text = attr(r'(<meta property="og:url" content=")[^"]*(")',
                     h(page_url), html_text)
    if img_url:
        html_text = attr(r'(<meta property="og:image" content=")[^"]*(")',
                         h(img_url), html_text)
        # As dimensões fixas são do ícone 512×512 — não valem pra arte.
        html_text = re.sub(
            r'\s*<meta property="og:image:(?:width|height)" content="[^"]*" />',
            "", html_text)
    html_text = html_text.replace("</head>", "    " + jsonld_tag + "\n  </head>", 1)
    html_text = html_text.replace("</body>", article + "\n</body>", 1)
    return html_text


# ── Markdown pra agentes: fatos de passeio + renderers ─────────────────────
# Accept: text/markdown nas páginas (ver _negotiated_format). Os renderers
# leem os mesmos grafos cacheados do SSR (_tours_graph: tours+identities;
# _load_catalog: os 4 dumps, pra mídia/lista/pessoa) e escrevem Markdown
# simples — links absolutos em SITE_URL, ficha em lista, narrativa em
# parágrafos. Nunca escapam o texto do catálogo: é dado do coletivo.

def _tour_facts(g, t):
    """Fatos de um passeio (grafo tours+identities) que as representações
    humana e de agente compartilham — SSR HTML, Markdown do passeio, Memória e
    home em Markdown. Best-effort campo a campo: dado malformado vira None,
    nunca derruba a página."""
    import re
    from rdflib import Namespace
    PH = Namespace(PH_NS)
    SCHEMA = Namespace("https://schema.org/")
    DCT = Namespace("http://purl.org/dc/terms/")
    PROV = Namespace("http://www.w3.org/ns/prov#")

    def dt_of(v):
        try:
            return datetime.fromisoformat(str(v)) if v else None
        except ValueError:
            return None

    def num(v):
        # Forma legada (IRI de QuantityValue) ou lixo → None, sem derrubar o
        # SSR do passeio inteiro por causa de um dado malformado.
        try:
            return float(v) if v is not None else None
        except (TypeError, ValueError):
            return None

    def count(v):
        try:
            return int(v) if v is not None else None
        except (TypeError, ValueError):
            return None

    def hhmm(secs):
        h, mi = int(secs // 3600), int(secs % 3600 // 60)
        return f"{h}h{mi:02d}" if h else f"{mi}min"

    tour_id = (str(t)[len(PAS_NS):] if str(t).startswith(PAS_NS)
               else str(t).rsplit("/", 1)[-1])
    pretty = _tour_pretty_of(g, t)
    dt = dt_of(g.value(t, DCT.date))
    narrative = str(g.value(t, DCT.description) or "").strip()
    img = g.value(t, SCHEMA.image)
    energy = num(g.value(t, PH.energyEstimate))
    intensity = _intensity_for(energy) if energy is not None else None
    route_ref = g.value(t, PH.linkRoute)
    route_url = g.value(route_ref, SCHEMA.url) if route_ref else None
    ig_url = g.value(t, PH.linkInstagram)
    authors = sorted(
        (_person_name(g, p),
         str(p)[len(PES_NS):] if str(p).startswith(PES_NS) else None)
        for p in g.objects(t, PROV.wasAttributedTo))
    editions = []
    for ed in g.objects(t, PH.inSeriesEdition):
        ev = g.value(ed, PH.inEventSeries)
        seq = g.value(ed, PH.sequenceInSeries)
        if ev is not None and seq is not None:
            editions.append((str(ev).split("/")[-1].split("#")[-1], str(seq)))
    editions.sort()
    departed = dt_of(g.value(t, PH.departedAt))
    arrived = dt_of(g.value(t, PH.arrivedAt))
    # Tempo total: derivado de chegada − saída quando os dois existem (e são
    # comparáveis — naive e aware não se subtraem); senão o literal
    # ph:totalDuration, que é o fallback por convenção.
    total = None
    if (departed and arrived
            and (departed.tzinfo is None) == (arrived.tzinfo is None)):
        secs = (arrived - departed).total_seconds()
        if secs > 0:
            total = hhmm(secs)
    if total is None:
        total_lit = g.value(t, PH.totalDuration)
        total = _fmt_moving_duration(total_lit) if total_lit else None
    moving_lit = g.value(t, PH.movingDuration)
    return {
        "id": tour_id, "pretty": pretty, "iri": str(t),
        "title": _tour_display_title(g, t),
        # URL canônica: o slug legível (schema:identifier) quando existe, senão
        # o slug8 — mesmo formato do sitemap/feed/compartilhar.
        "page_url": f"{SITE_URL}passeio/{pretty or tour_id}",
        "dt": dt,
        "date_label": (f"{dt.day} de {_MONTHS_PT[dt.month - 1]} de {dt.year}"
                       if dt else None),
        "narrative": narrative,
        "paragraphs": [p.strip() for p in re.split(r"\r?\n+", narrative) if p.strip()],
        "img_url": str(img) if img else None,
        "energy": energy, "intensity": intensity,
        "energy_line": ((f"{energy:.0f} quilojaules"
                         + (f" ({intensity})" if intensity else ""))
                        if energy is not None else None),
        "measured": num(g.value(t, PH.measuredEnergy)),
        "route_url": str(route_url) if route_url else None,
        "ig_url": str(ig_url) if ig_url else None,
        "authors": authors,                       # [(nome, slug | None)]
        "author_names": [a[0] for a in authors],
        "editions": editions,                     # [(código da série, nº)]
        "attendees": count(g.value(t, PH.countAttendee)),
        "newcomers": count(g.value(t, PH.countNewcomer)),
        "departed": departed, "arrived": arrived,
        "total": total,
        "moving": _fmt_moving_duration(moving_lit) if moving_lit else None,
    }


def _tours_sorted():
    """Todos os passeios como _tour_facts, mais recentes primeiro."""
    from rdflib import Namespace, RDF
    g = _tours_graph()
    facts = [_tour_facts(g, t) for t in g.subjects(RDF.type, Namespace(PH_NS).Tour)]
    facts.sort(key=lambda d: _tour_date_sort_key(d["dt"]), reverse=True)
    return facts


def _tour_md_meta_line(d):
    """Linha de fatos de um passeio (data · energia · gente · rota · IG) pras
    listas em Markdown (home, Memória)."""
    bits = []
    if d["date_label"]:
        bits.append(d["date_label"])
    if d["energy_line"]:
        bits.append(d["energy_line"].replace("quilojaules", "kJ"))
    if d["measured"] is not None:
        bits.append(f"{d['measured']:.0f} kJ medidos")
    if d["attendees"] is not None:
        bits.append(f"{d['attendees']} pessoas")
    if d["route_url"]:
        bits.append(f"[Rota]({d['route_url']})")
    if d["ig_url"]:
        bits.append(f"[Instagram]({d['ig_url']})")
    return " · ".join(bits)


def _render_tour_markdown(tour_id):
    """A página do passeio em Markdown (Accept: text/markdown): o mesmo
    conteúdo do <article> SSR'ado, mais a ficha completa (série, energias,
    horários, participantes) e os ponteiros pros dados — sem o chrome do app.
    None se o passeio não existe."""
    from rdflib import Namespace, RDF, URIRef
    g = _tours_graph()
    t = URIRef(PAS_NS + tour_id)
    if (t, RDF.type, Namespace(PH_NS).Tour) not in g:
        return None
    d = _tour_facts(g, t)
    title = _md_inline(d["title"])
    out = [f"# {title}", "",
           " · ".join(b for b in (d["date_label"], "Pedal Hidrográfico") if b), ""]
    if d["img_url"]:
        out += [f"![Arte do chamado — {title}]({d['img_url']})", ""]
    for para in d["paragraphs"]:
        out += [para, ""]
    facts = []
    if d["dt"]:
        facts.append(f"- **Data:** {d['date_label']} (`{d['dt'].isoformat()}`)")
    for code, seq in d["editions"]:
        facts.append(f"- **Edição:** {code} {seq} — [série {code}]({SITE_URL}serie/{code})")
    if d["energy_line"]:
        facts.append("- **Energia estimada:** "
                     + d["energy_line"].replace("quilojaules", "kJ"))
    if d["measured"] is not None:
        facts.append(f"- **Energia medida:** {d['measured']:.0f} kJ")
    if d["departed"] or d["arrived"]:
        dep = d["departed"].strftime("%H:%M") if d["departed"] else "?"
        arr = d["arrived"].strftime("%H:%M") if d["arrived"] else "?"
        facts.append(f"- **Saída → chegada:** {dep} → {arr}"
                     + (f" ({d['total']} no total)" if d["total"] else ""))
    elif d["total"]:
        facts.append(f"- **Tempo total:** {d['total']}")
    if d["moving"]:
        facts.append(f"- **Tempo em movimento:** {d['moving']}")
    if d["attendees"] is not None:
        who = f"{d['attendees']} pessoas"
        if d["newcomers"] is not None:
            who += f", {d['newcomers']} pela primeira vez"
        facts.append(f"- **Participantes:** {who}")
    if d["route_url"]:
        facts.append(f"- **Rota:** <{d['route_url']}>")
    if d["ig_url"]:
        facts.append(f"- **Instagram:** <{d['ig_url']}>")
    if d["authors"]:
        names = ", ".join(
            f"[{_md_inline(n)}]({SITE_URL}pessoas/{s})" if s else _md_inline(n)
            for n, s in d["authors"])
        facts.append(f"- **Alguns elaboradores:** {names}")
    if facts:
        out += ["## Ficha", "", *facts, ""]
    out += ["## Dados", "",
            f"- **IRI:** `{d['iri']}`",
            f"- **RDF (Turtle):** [{d['page_url']}?format=ttl]({d['page_url']}?format=ttl)"
            " — ou `Accept: text/turtle` na mesma URL",
            f"- [Este passeio na Memória Hidrográfica]({SITE_URL}memoria.html#{d['id']})",
            f"- [Mapa do Pedal Hidrográfico]({SITE_URL})", ""]
    return "\n".join(out)


HOME_MD_RECENT_TOURS = 20


def _render_home_markdown():
    """A home em Markdown (Accept: text/markdown em `/`): o llms.txt — o guia
    do site pra agentes, que já é Markdown — mais a lista dos passeios mais
    recentes, cada um linkando pra sua página (que também negocia Markdown).
    É o que um agente lê ao chegar aqui, em vez do shell do app (mapa +
    modais, vazio de conteúdo sem JS)."""
    guide = (WEB / "llms.txt").read_text(encoding="utf-8").strip()
    try:
        tours = _tours_sorted()
    except Exception as e:  # noqa: BLE001
        print(f"[home-md] catálogo de passeios falhou: {e}")
        tours = []
    out = [guide, "", "## Passeios recentes", ""]
    for d in tours[:HOME_MD_RECENT_TOURS]:
        out.append(f"- [{_md_inline(d['title'])}]({d['page_url']}) — {_tour_md_meta_line(d)}")
    if tours:
        out += ["", f"Todos os {len(tours)} passeios, com narrativa: "
                    f"[Memória Hidrográfica]({SITE_URL}memoria.html) "
                    "(também em Markdown com `Accept: text/markdown`)."]
    else:
        out.append("(catálogo de passeios indisponível no momento)")
    out.append("")
    return "\n".join(out)


def _render_person_markdown(slug):
    """Ficha da pessoa em Markdown: nome/apelido/links (identities.ttl), os
    passeios que elaborou (tours.ttl) e quantas mídias assinou (images.ttl,
    via o catálogo cacheado). None se a pessoa não existe."""
    from rdflib import Namespace, RDF, RDFS, URIRef
    SCHEMA = Namespace("https://schema.org/")
    PROV = Namespace("http://www.w3.org/ns/prov#")
    PH = Namespace(PH_NS)
    g = _tours_graph()
    p = URIRef(PES_NS + slug)
    if (p, RDF.type, SCHEMA.Person) not in g:
        return None
    name = _md_inline(_person_name(g, p))
    out = [f"# {name}", "", "Pessoa do Pedal Hidrográfico.", ""]
    facts = []
    alt = g.value(p, SCHEMA.alternateName)
    if alt and _md_inline(alt) != name:
        facts.append(f"- **Apelido:** {_md_inline(alt)}")
    for pred, label in ((RDFS.seeAlso, "Ver também"), (SCHEMA.sameAs, "Mesmo que"),
                        (SCHEMA.url, "Site")):
        for o in sorted(str(o) for o in g.objects(p, pred)):
            facts.append(f"- **{label}:** <{o}>")
    if facts:
        out += [*facts, ""]
    tours = [_tour_facts(g, t) for t in g.subjects(PROV.wasAttributedTo, p)
             if (t, RDF.type, PH.Tour) in g]
    tours.sort(key=lambda d: _tour_date_sort_key(d["dt"]), reverse=True)
    out += [f"## Passeios elaborados ({len(tours)})", ""]
    for d in tours:
        out.append(f"- [{_md_inline(d['title'])}]({d['page_url']}) — {_tour_md_meta_line(d)}")
    if not tours:
        out.append("Nenhum passeio registrado com esta pessoa na elaboração.")
    try:
        cat = _load_catalog()
        signed = list(cat.subjects(PROV.wasAttributedTo, p))
        stills = sum(1 for m in signed if (m, RDF.type, PH.StillImage) in cat)
        videos = sum(1 for m in signed if (m, RDF.type, PH.MotionImage) in cat)
        out += ["", "## Mídias", "",
                f"Assinou {stills} foto{'s' if stills != 1 else ''} e {videos} "
                f"vídeo{'s' if videos != 1 else ''} do acervo "
                f"([galeria]({SITE_URL}imagens.html))."]
    except Exception as e:  # noqa: BLE001
        print(f"[person-md] contagem de mídias falhou pra {slug}: {e}")
    out += ["", "## Dados", "",
            f"- **IRI:** `{PES_NS}{slug}`",
            f"- **RDF (Turtle):** [{SITE_URL}pessoas/{slug}?format=ttl]"
            f"({SITE_URL}pessoas/{slug}?format=ttl) — ou `Accept: text/turtle` na mesma URL",
            f"- [Página no app]({SITE_URL}pessoas/{slug})", ""]
    return "\n".join(out)


def _render_list_markdown(slug):
    """Lista/álbum em Markdown: nome + membros (mídias com schema:isPartOf →
    a lista), cada um linkando pra sua página e pro passeio em que foi
    capturado. Lê o catálogo cacheado (lists + images + tours). None se a
    lista não existe."""
    from rdflib import Namespace, RDF, URIRef
    SCHEMA = Namespace(SCHEMA_NS)
    PH = Namespace(PH_NS)
    DCT = Namespace("http://purl.org/dc/terms/")
    cat = _load_catalog()
    lu = URIRef(LST_NS + slug)
    if (lu, None, None) not in cat:
        return None
    name = _md_inline(cat.value(lu, SCHEMA.name) or slug)
    desc = cat.value(lu, SCHEMA.description)
    members = []
    for m in cat.subjects(SCHEMA.isPartOf, lu):
        if (m, RDF.type, PH.MotionImage) in cat:
            kind = "vídeo"
        elif (m, RDF.type, PH.StillImage) in cat:
            kind = "foto"
        else:
            kind = "mídia"
        local = str(m)[len(MED_NS):] if str(m).startswith(MED_NS) else str(m)
        members.append((str(cat.value(m, DCT.date) or ""), kind, local,
                        cat.value(m, PH.capturedDuring)))
    members.sort(key=lambda x: (x[0], x[2]), reverse=True)
    n = len(members)
    out = [f"# {name}", "",
           f"Lista/álbum do acervo do Pedal Hidrográfico (`lst:{slug}`) · {n} "
           f"mídia{'s' if n != 1 else ''}.", ""]
    if desc:
        out += [str(desc).strip(), ""]
    out += ["## Mídias", ""]
    for date, kind, local, tour in members:
        line = f"- [{kind} {local}]({SITE_URL}midia/{local})"
        if date:
            line += f" — {date[:10]}"
        if tour is not None and (tour, RDF.type, PH.Tour) in cat:
            tid = str(tour)[len(PAS_NS):] if str(tour).startswith(PAS_NS) else str(tour)
            line += (f" · [{_md_inline(_tour_display_title(cat, tour))}]"
                     f"({SITE_URL}passeio/{_tour_pretty_of(cat, tour) or tid})")
        out.append(line)
    if not members:
        out.append("Lista vazia.")
    out += ["", "## Dados", "",
            f"- **IRI:** `{LST_NS}{slug}`",
            f"- **RDF (Turtle):** [{SITE_URL}listas/{slug}?format=ttl]"
            f"({SITE_URL}listas/{slug}?format=ttl) — ou `Accept: text/turtle` na mesma URL",
            f"- [Galeria filtrada por esta lista]({SITE_URL}imagens.html?list={slug})", ""]
    return "\n".join(out)


def _render_media_markdown(local):
    """Ficha de uma mídia (foto/vídeo) em Markdown: tipo, data, local, passeio,
    autoria, licença, listas e arquivos. Lê o catálogo cacheado. None se a
    mídia não existe."""
    from rdflib import Namespace, RDF, URIRef
    SCHEMA = Namespace(SCHEMA_NS)
    PH = Namespace(PH_NS)
    DCT = Namespace("http://purl.org/dc/terms/")
    PROV = Namespace("http://www.w3.org/ns/prov#")
    PAV = Namespace("http://purl.org/pav/")
    EXIF = Namespace("http://www.w3.org/2003/12/exif/ns#")
    cat = _load_catalog()
    m = URIRef(MED_NS + local)
    is_video = (m, RDF.type, PH.MotionImage) in cat
    is_still = (m, RDF.type, PH.StillImage) in cat
    if not (is_video or is_still):
        return None
    kind = "Vídeo" if is_video else "Foto"

    def person_link(p):
        nm = _md_inline(_person_name(cat, p))
        if str(p).startswith(PES_NS):
            return f"[{nm}]({SITE_URL}pessoas/{str(p)[len(PES_NS):]})"
        return nm

    out = [f"# {kind} `{local}`", "",
           f"{kind} do acervo do Pedal Hidrográfico (`med:{local}` — o hash é a "
           "identidade da mídia; o tipo vem da classe).", ""]
    facts = []
    date = cat.value(m, DCT.date)
    if date:
        facts.append(f"- **Data:** {_md_inline(date)}")
    geo = cat.value(m, SCHEMA.locationCreated)
    if geo is not None:
        lat, lng = cat.value(geo, SCHEMA.latitude), cat.value(geo, SCHEMA.longitude)
        if lat is not None and lng is not None:
            facts.append(f"- **Local:** {lat}, {lng} "
                         f"([OpenStreetMap](https://www.openstreetmap.org/"
                         f"?mlat={lat}&mlon={lng}#map=17/{lat}/{lng}))")
    tour = cat.value(m, PH.capturedDuring)
    if tour is not None:
        tid = str(tour)[len(PAS_NS):] if str(tour).startswith(PAS_NS) else str(tour)
        if (tour, RDF.type, PH.Tour) in cat:
            facts.append(f"- **Passeio:** [{_md_inline(_tour_display_title(cat, tour))}]"
                         f"({SITE_URL}passeio/{_tour_pretty_of(cat, tour) or tid})")
        else:
            facts.append(f"- **Passeio:** `{tour}`")
    authors = sorted(person_link(p) for p in cat.objects(m, PROV.wasAttributedTo))
    if authors:
        facts.append(f"- **Autoria:** {', '.join(authors)}")
    providers = sorted(person_link(p) for p in cat.objects(m, PAV.providedBy))
    if providers:
        facts.append(f"- **Enviado por:** {', '.join(providers)}")
    lic = cat.value(m, DCT.license)
    if lic:
        facts.append(f"- **Licença:** <{lic}>")
    lists = sorted((str(cat.value(l, SCHEMA.name) or str(l)[len(LST_NS):]), str(l))
                   for l in cat.objects(m, SCHEMA.isPartOf))
    if lists:
        facts.append("- **Listas:** " + ", ".join(
            f"[{_md_inline(nm)}]({SITE_URL}listas/{iri[len(LST_NS):]})"
            if iri.startswith(LST_NS) else _md_inline(nm) for nm, iri in lists))
    if is_video:
        dur = cat.value(m, SCHEMA.duration)
        if dur:
            facts.append(f"- **Duração:** `{dur}`")
        res = sorted(str(r) for r in cat.objects(m, PH.availableResolution))
        if res:
            facts.append(f"- **Versões:** {', '.join(res)}")
    else:
        focal = cat.value(m, EXIF.focalLengthIn35mmFilm)
        if focal is not None:
            facts.append(f"- **Distância focal (equiv. 35 mm):** {focal} mm")
        bearing = cat.value(m, EXIF.gpsImgDirection)
        if bearing is not None:
            facts.append(f"- **Rumo da câmera:** {bearing}°")
    if facts:
        out += ["## Ficha", "", *facts, ""]
    files = []
    if is_video:
        for pred, label in ((PH.video720p, "720p"), (PH.video360p, "360p"),
                            (PH.audio, "áudio"), (SCHEMA.thumbnail, "miniatura")):
            v = cat.value(m, pred)
            if v:
                files.append(f"- {label}: {SITE_URL}clips/{v}")
    else:
        files += [f"- grande: {SITE_URL}photos/{local}/large.jpg",
                  f"- miniatura: {SITE_URL}photos/{local}/thumb.jpg",
                  f"- original: `{SITE_URL}photos/{local}/original.<ext>` "
                  "(extensão do arquivo enviado)"]
    out += ["## Arquivos", "", *files, "",
            "## Dados", "",
            f"- **IRI:** `{MED_NS}{local}`",
            f"- **RDF (Turtle):** [{SITE_URL}midia/{local}?format=ttl]"
            f"({SITE_URL}midia/{local}?format=ttl) — ou `Accept: text/turtle` na mesma URL",
            f"- [Na galeria]({SITE_URL}imagens.html?pick={local})", ""]
    return "\n".join(out)


def _html_shell_markdown(p):
    """Markdown mínimo pra uma página do app que se compõe client-side
    (galeria, censo, pessoas, formulários): título + descrição da própria
    página e os ponteiros pros dados que ela consome — o que um agente
    consegue usar, em vez de um shell HTML vazio de conteúdo."""
    import re
    from html import unescape
    text = (WEB / p).read_text(encoding="utf-8")
    m = re.search(r"<title>(.*?)</title>", text, re.S)
    title = _md_inline(unescape(m.group(1))) if m else p
    m = re.search(r'<meta name="description" content="([^"]*)"', text)
    desc = unescape(m.group(1)).strip() if m else None
    out = [f"# {title}", ""]
    if desc:
        out += [desc, ""]
    out += [f"Esta página ({SITE_URL}{p}) é uma aplicação que se monta no navegador "
            "a partir dos dados abertos do acervo; sua versão Markdown é só este "
            "resumo. Pra ler o acervo em si:", "",
            f"- [llms.txt]({SITE_URL}llms.txt) — guia do site pra agentes (a home em "
            "Markdown traz o mesmo guia + os passeios recentes)",
            f"- [data_graphs.ttl]({SITE_URL}data/data_graphs.ttl) — manifesto VoID com "
            "todos os dumps RDF",
            f"- [Memória Hidrográfica]({SITE_URL}memoria.html) — todos os passeios com "
            "narrativa (também em Markdown)",
            f"- [openapi.json]({SITE_URL}openapi.json) — descrição da API HTTP", ""]
    return "\n".join(out)


# ── Memória Hidrográfica (SSR da linha do tempo) ──────────────────────────
# GET /memoria.html injeta uma versão texto da linha do tempo no lugar do
# marcador <!-- SSR:MEMORIA --> — é o que crawlers e quem está sem JS leem
# (a página compõe tudo client-side dos dumps, que o robots.txt bloqueava
# pro renderer do Google; ver get_data_ttl). Com JS, o script da página
# remove o nó #memoria-ssr depois de compor a linha do tempo viva.
_memoria_cache = {"digest": None, "html": None}


def _build_memoria_ssr():
    """<section id="memoria-ssr"> com um <article> por passeio (texto só:
    título, data, energia, rota, narrativa) — mais recentes primeiro."""
    import re
    from html import escape as h
    from rdflib import Namespace, RDF

    PH = Namespace(PH_NS)
    SCHEMA = Namespace("https://schema.org/")
    DCT = Namespace("http://purl.org/dc/terms/")

    g = _tours_graph()
    items = []
    for t in g.subjects(RDF.type, PH.Tour):
        date = g.value(t, DCT.date)
        try:
            dt = datetime.fromisoformat(str(date)) if date else None
        except ValueError:
            dt = None
        items.append((dt, t))
    items.sort(key=lambda x: _tour_date_sort_key(x[0]), reverse=True)

    def kj_float(v):
        try:
            return float(v) if v is not None else None
        except (TypeError, ValueError):
            return None

    n = len(items)
    out = ['<section id="memoria-ssr">',
           f'  <p class="meta">{n} passeio{"s" if n != 1 else ""} — '
           "versão texto da linha do tempo; com JavaScript ela vira a "
           "versão completa, com artes e galerias.</p>"]
    for dt, t in items:
        slug = (str(t)[len(PAS_NS):] if str(t).startswith(PAS_NS)
                else str(t).rsplit("/", 1)[-1])
        title = _tour_display_title(g, t)
        # Âncora = slug8 (estável, usado por memoria.html#<slug8>); o link
        # navegável usa o slug legível quando existe.
        out.append(f'  <article id="{h(slug)}">')
        out.append(f'    <h2><a href="{h(SITE_URL)}passeio/'
                   f'{h(_tour_pretty_of(g, t) or slug)}">'
                   f"{h(title)}</a></h2>")
        if dt:
            date_label = f"{dt.day} de {_MONTHS_PT[dt.month - 1]} de {dt.year}"
            out.append(f'    <p class="meta"><time datetime="{h(dt.isoformat())}">'
                       f"{h(date_label)}</time></p>")
        facts = []
        est = kj_float(g.value(t, PH.energyEstimate))
        med = kj_float(g.value(t, PH.measuredEnergy))
        if est is not None:
            label = _intensity_for(est)
            facts.append(f"{est:.0f} quilojaules"
                         + (f" ({label})" if label else ""))
        if med is not None:
            facts.append(f"{med:.0f} kJ medidos")
        route_ref = g.value(t, PH.linkRoute)
        route_url = g.value(route_ref, SCHEMA.url) if route_ref else None
        if route_url:
            facts.append(f'Rota: <a href="{h(str(route_url))}">'
                         f"{h(str(route_url))}</a>")
        ig_url = g.value(t, PH.linkInstagram)
        if ig_url:
            facts.append(f'<a href="{h(str(ig_url))}">Post no Instagram</a>')
        if facts:
            out.append('    <p class="meta">' + " · ".join(facts) + "</p>")
        narrative = str(g.value(t, DCT.description) or "").strip()
        for para in re.split(r"\r?\n+", narrative):
            if para.strip():
                out.append(f"    <p>{h(para.strip())}</p>")
        out.append("  </article>")
    out.append("</section>")
    return "\n".join(out)


def _render_memoria_html():
    """memoria.html com o SSR injetado, cacheado pelo hash do catálogo
    (mesma mecânica do feed/sitemap). O build roda FORA do _feed_lock —
    _tours_graph() o adquire internamente e o lock não é reentrante."""
    import hashlib
    text = _tours_with_identities_text()
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()
    with _feed_lock:
        if _memoria_cache["digest"] == digest and _memoria_cache["html"]:
            return _memoria_cache["html"]
    section = _build_memoria_ssr()
    html_text = (WEB / "memoria.html").read_text(encoding="utf-8")
    marker = "<!-- SSR:MEMORIA -->"
    if marker in html_text:
        html_text = html_text.replace(marker, section, 1)
    with _feed_lock:
        _memoria_cache["digest"] = digest
        _memoria_cache["html"] = html_text
    return html_text


_memoria_md_cache = {"digest": None, "md": None}


def _build_memoria_markdown():
    """A Memória Hidrográfica em Markdown: um bloco por passeio (título
    linkado, linha de fatos, narrativa), mais recentes primeiro — o mesmo
    conteúdo do SSR, sem o chrome da página."""
    tours = _tours_sorted()
    n = len(tours)
    out = ["# Memória Hidrográfica", "",
           f"A linha do tempo dos passeios do Pedal Hidrográfico — {n} "
           f"passeio{'s' if n != 1 else ''}, mais recentes primeiro. Cada título "
           "linka pra página do passeio, que também responde em Markdown "
           "(`Accept: text/markdown`) e Turtle (`Accept: text/turtle`).", ""]
    for d in tours:
        out += [f"## [{_md_inline(d['title'])}]({d['page_url']})", ""]
        meta = _tour_md_meta_line(d)
        if meta:
            out += [meta, ""]
        for para in d["paragraphs"]:
            out += [para, ""]
    out += [f"Mapa: <{SITE_URL}> · dados: [data_graphs.ttl]({SITE_URL}data/data_graphs.ttl)", ""]
    return "\n".join(out)


def _render_memoria_markdown():
    """Markdown da Memória cacheado pelo hash do catálogo (mesma mecânica do
    HTML SSR; build fora do _feed_lock — _tours_graph o adquire)."""
    import hashlib
    text = _tours_with_identities_text()
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()
    with _feed_lock:
        if _memoria_md_cache["digest"] == digest and _memoria_md_cache["md"]:
            return _memoria_md_cache["md"]
    md = _build_memoria_markdown()
    with _feed_lock:
        _memoria_md_cache["digest"] = digest
        _memoria_md_cache["md"] = md
    return md


@app.get("/memoria.html")
def memoria_page():
    """memoria.html com a linha do tempo pré-renderizada — best-effort:
    qualquer falha degrada pro arquivo estático (a página compõe tudo
    client-side de qualquer jeito). Accept: text/markdown → a linha do tempo
    inteira em Markdown (falha degrada pro resumo genérico da página)."""
    if _wants_markdown(request):
        try:
            return _markdown_response(_render_memoria_markdown())
        except Exception:  # noqa: BLE001
            app.logger.exception("[memoria] Markdown falhou; servindo o resumo")
            return _markdown_response(_html_shell_markdown("memoria.html"))
    try:
        html_text = _render_memoria_html()
    except Exception:  # noqa: BLE001
        app.logger.exception("[memoria] SSR falhou; servindo o estático")
        return web_files("memoria.html")
    return _negotiated(Response(html_text, mimetype="text/html",
                                headers={"Cache-Control": "no-cache"}))


@app.get("/<path:p>")
def web_files(p):
    """Estáticos de web/ — inclui ./data/{shapes,ontology,tours}.ttl e tudo
    o que não é mutável. Os mutáveis (uploads, data_graphs, photos/*) têm
    handlers próprios acima e nunca caem aqui."""
    if (WEB / p).is_file():
        # Accept: text/markdown numa página do app (galeria, censo, forms):
        # resumo + ponteiros pros dados, em vez do shell vazio de conteúdo.
        if p.endswith(".html") and _wants_markdown(request):
            return _markdown_response(_html_shell_markdown(p))
        resp = send_from_directory(WEB, p)
        if p.endswith(".ttl") or p.endswith(".json"):
            resp.headers["Cache-Control"] = "no-cache"
        return resp
    abort(404)


# NOTA: este handler NÃO usa @serialized (nem /upload-video — mesma divisão;
# o Tour CRUD trava a seção crítica explicitamente). O _state_lock global serializaria TAMBÉM a transferência do corpo
# (originais de vários MB) e as gravações de blob — fazendo um lote de N fotos
# subir estritamente em série. Aqui o trabalho é dividido por lock:
#  - transferência do corpo (Werkzeug faz o parse do multipart no 1º acesso a
#    request.form/files) e gravação dos 3 blobs no store: FORA de qualquer lock
#    (I/O — solta o GIL; sobrepõe entre requests concorrentes + com o cliente
#    mandando vários em voo);
#  - validação SHACL: sob _validate_lock (pyshacl não é thread-safe e é CPU-
#    bound — serializada à parte, sem travar o RMW);
#  - read-modify-write do catálogo: sob _state_lock (curto), com re-checagem
#    TOCTOU da colisão cross-type. Mesmo espírito do fetch RWGPS do Tour CRUD.
# Seguro porque validate_image_ttl só LÊ o snapshot cacheado (nunca o muta), as
# keys de blob são content-addressed por phash (idempotentes) e o upsert lê
# images.ttl fresco sob o lock.
@app.post("/upload-image")
def upload_image():
    # `ttl` pode vir como campo de formulário ou como arquivo. (O acesso a
    # request.form/files aqui dispara a transferência/parse do corpo inteiro —
    # de propósito FORA dos locks, pra sobrepor entre uploads concorrentes.)
    ttl_text = request.form.get("ttl")
    if not ttl_text:
        f = request.files.get("ttl")
        if f:
            ttl_text = f.read().decode("utf-8", errors="replace")
    if not ttl_text:
        return jsonify(error="ttl ausente"), 400

    # Validação FORA do _state_lock. O parse/merge (por-call, local) roda
    # concorrente; só a chamada pyshacl.validate() lá dentro serializa sob
    # _validate_lock (thread-safety) — compartilhado com vídeo/tour.
    try:
        ok, phash, errors = validate_image_ttl(ttl_text)
    except Exception as e:  # noqa: BLE001
        return jsonify(error=f"parse: {e}"), 400
    if not ok:
        return jsonify(error="shacl", details=errors, phash=phash), 400

    # Variantes — pelo menos uma é obrigatória. Blobs gravados FORA do lock
    # (keys content-addressed por phash — idempotente).
    written = []
    for variant in ("original", "large", "thumb"):
        f = request.files.get(variant)
        if not f:
            continue
        # `large` e `thumb` são sempre re-encodadas em JPEG; `original`
        # preserva extensão (heic/png/jpg).
        if variant == "original":
            ext = (os.path.splitext(f.filename or "")[1].lstrip(".") or "jpg").lower()
            if ext not in ("jpg", "jpeg", "png", "heic", "heif"):
                ext = "jpg"
            if ext == "jpeg":
                ext = "jpg"
        else:
            ext = "jpg"
        key = f"photos/{phash}/{variant}.{ext}"
        # MIME por extensão; deixamos o store inferir se ausente.
        ct = {
            "jpg": "image/jpeg", "png": "image/png",
            "heic": "image/heic", "heif": "image/heif",
        }.get(ext)
        data = f.read()
        STORE.write_bytes(key, data, content_type=ct)
        written.append(f"{variant}.{ext}")
    if not written:
        return jsonify(error="nenhuma variante de imagem enviada"), 400

    def _cleanup_orphans():
        # Blobs já gravados sem triples = órfãos invisíveis. Limpa best-effort
        # (re-upload regrava as mesmas keys de qualquer jeito).
        try:
            STORE.delete_prefix(f"photos/{phash}/")
        except Exception as e2:  # noqa: BLE001
            print(f"[upload-image] aviso limpando órfãos de {phash}: {e2}")

    # Single-file mode: upsert no images.ttl, deduplicando por phash. Só o RMW do
    # catálogo é serializado (sob _state_lock); o timestamp da activity é gerado
    # aqui dentro pra garantir IRI única entre uploads concorrentes.
    from rdflib import RDF as _RDF, URIRef as _URIRef
    _img_uri = _URIRef(MED_NS + phash)
    _motion = _URIRef(PH_NS + "MotionImage")
    collision = False
    upload_local = None
    try:
        with _state_lock:
            # Re-checagem TOCTOU: a colisão cross-type foi checada na validação
            # FORA do lock — re-confere contra o catálogo ATUAL antes de gravar.
            if (_img_uri, _RDF.type, _motion) in _load_catalog():
                collision = True
            else:
                upload_local = _upload_filename()[:-len(".ttl")]   # phd:upload_TIMESTAMP
                audit_block  = _build_audit_ttl(upload_local, phash)
                upsert_image_in_uploads(ttl_text, phash, audit_block)
                _invalidate_catalog()
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()   # o 500 devolve só str(e); o stack só existe aqui
        _cleanup_orphans()
        return jsonify(
            error=f"persistência ttl: {e}", phash=phash, files=written,
        ), 500
    if collision:
        _cleanup_orphans()
        return jsonify(
            error=f"colisão: med:{phash} já existe como VÍDEO (ph:MotionImage) — "
                  f"phash colidiu com um vhash.", phash=phash,
        ), 409
    print(f"[upload-image] phash={phash} files={written} activity={upload_local}")
    return jsonify(phash=phash, files=written, activity=upload_local, ok=True)


def validate_video_ttl(ttl_text):
    """Espelha validate_image_ttl pra ph:Video: verifica que tem exatamente
    1 ph:Video com IRI phd:video_<vhash16>, e dispara SHACL contra shapes+
    ontology+catálogo (catálogo é mesclado MENOS os triples do próprio vídeo
    em curso, pra que re-uploads não disparem violações de cardinalidade).
    Retorna (ok, vhash, errors)."""
    v = _load_validator()
    from rdflib import URIRef, Namespace
    data = v["Graph"]().parse(data=ttl_text, format="turtle")

    RDFT = URIRef("http://www.w3.org/1999/02/22-rdf-syntax-ns#type")
    videos = list(data.subjects(RDFT, URIRef(PH_NS + "MotionImage")))
    if len(videos) != 1:
        return False, None, [
            f"TTL deve conter exatamente 1 ph:Video (achou {len(videos)})"
        ]
    video_iri = str(videos[0])
    # IRI opaco med:<hash> (tipo vem da CLASSE, não do prefixo).
    if not video_iri.startswith(MED_NS):
        return False, None, [
            f"IRI do Video deve começar com med: (atual: {video_iri})"
        ]
    vhash = video_iri[len(MED_NS):]
    if len(vhash) != 16 or not all(c in "0123456789abcdef" for c in vhash.lower()):
        return False, vhash, [f"vhash inválido na IRI (esperado 16 hex): {vhash}"]

    vid_uri = URIRef(video_iri)
    catalog = _load_catalog()
    # Guarda de colisão CROSS-TYPE: vhash igual a um phash existente viraria o
    # MESMO IRI. Rejeita antes de sobrescrever a foto.
    if (vid_uri, RDFT, URIRef(PH_NS + "StillImage")) in catalog:
        return False, vhash, [
            f"colisão: med:{vhash} já existe como FOTO (ph:StillImage) — "
            f"vhash colidiu com um phash. Não dá pra reusar o IRI."
        ]
    # Exclui o próprio sujeito + seus nós derivados (locationCreated).
    exclude = {vid_uri} | _derived_subjects(catalog, vid_uri)
    own_subjects = set(data.subjects())
    merged = _validation_universe(data, catalog, exclude, own_subjects)
    with _validate_lock:   # pyshacl não é thread-safe (parser SPARQL) — ver _validate_lock
        conforms, results_graph, _txt = v["pyshacl"].validate(
            merged, shacl_graph=v["shapes"], inference="rdfs", advanced=True)
    if conforms:
        return True, vhash, []

    own_subjects = set(data.subjects())
    SH = Namespace("http://www.w3.org/ns/shacl#")
    errors = []
    for r in results_graph.subjects(SH.resultSeverity, SH.Violation):
        focus = next(results_graph.objects(r, SH.focusNode), None)
        if focus is None or focus in own_subjects:
            msg = next(results_graph.objects(r, SH.resultMessage), None)
            errors.append(str(msg) if msg else "(sem mensagem)")
    if not errors:
        return True, vhash, []
    return False, vhash, errors


def upsert_video_in_uploads(ttl_text, vid_id):
    """Substitui as triples do vídeo (+ nós derivados) em images.ttl pelo TTL
    recebido; pessoas/listas novas inline vão pros catálogos delas."""
    from rdflib import URIRef
    Graph = _load_validator()["Graph"]
    incoming = Graph().parse(data=ttl_text, format="turtle")
    with _mutating("images.ttl") as catalog:
        _purge_subject(catalog, URIRef(MED_NS + vid_id))   # vídeo + nós derivados (geo)
        catalog += incoming
        _route_new_persons(catalog)        # autora nova → identities.ttl
        _route_new_collections(catalog)    # lista nova inline → lists.ttl


# NOTA: sem @serialized, pelo mesmo motivo do /upload-image (ver a nota lá):
# o lock global cobria a transferência do corpo (webms de vários MB) e as
# gravações de blob, então cada clipe em voo bloqueava TODAS as outras
# mutações pelo tempo do upload. Agora corpo + validação + blobs rodam fora do
# lock; só o RMW do catálogo (com re-checagem TOCTOU da colisão cross-type)
# roda sob _state_lock.
# ── Vídeo: gravação dos blobs + pré-envio (staging) ──────────────────────
# O form prepara o vídeo em segundo plano e PRÉ-ENVIA os blobs pra
# `POST /stage-video/<vhash>` assim que ficam prontos; o `/upload-video` final
# então só traz o TTL (`staged=1`). Chaves são as FINAIS (`clips/<vhash>.*`,
# content-addressed pelo vhash — idempotente), mais um marcador
# `clips/_staging/<vhash>` com o instante do pré-envio. Um pré-envio que nunca
# vira upload (card removido, aba fechada) é varrido depois de
# STAGING_MAX_AGE_S se o vhash não estiver no catálogo — na hora pelo
# `/discard` (best-effort do cliente), senão pela varredura (boot + 1×/h).
STAGING_PREFIX = "clips/_staging/"
STAGING_MAX_AGE_S = int(os.environ.get("STAGING_MAX_AGE_S") or 6 * 3600)
_CLIP_VARIANTS = (
    # form field, sufixo da chave, content-type
    ("audio", "audio.webm", "audio/webm"),
    ("thumb", "thumb.jpg", "image/jpeg"),
    ("video360", "360p.webm", "video/webm"),
    ("video720", "720p.webm", "video/webm"),
)
_last_staging_sweep = 0.0


def _is_vhash(s):
    return bool(s) and len(s) == 16 and all(c in "0123456789abcdef" for c in s)


def _clip_keys(vid_id):
    return [f"clips/{vid_id}.{suffix}" for _, suffix, _ in _CLIP_VARIANTS]


def _media_in_catalog(vid_id):
    """O IRI de mídia (foto OU vídeo) já tem tipo no catálogo?"""
    from rdflib import RDF, URIRef
    return (URIRef(MED_NS + vid_id), RDF.type, None) in _load_catalog()


def _write_clip_blobs(vid_id):
    """Lê os blobs de `request.files` e grava todos EM PARALELO (eram quatro
    round-trips em série no GCS). Devolve as chaves gravadas."""
    from concurrent.futures import ThreadPoolExecutor
    jobs = []
    for field, suffix, ctype in _CLIP_VARIANTS:
        f = request.files.get(field)
        if f:
            jobs.append((f"clips/{vid_id}.{suffix}", f.read(), ctype))
    if not jobs:
        return []
    with ThreadPoolExecutor(max_workers=len(jobs)) as ex:
        # list() re-levanta a primeira exceção de gravação
        list(ex.map(lambda j: STORE.write_bytes(j[0], j[1], content_type=j[2]), jobs))
    return [k for k, _, _ in jobs]


def _clip_keys_from_ttl(ttl_text, vid_id):
    """Chaves de blob que o TTL do vídeo referencia (ph:audio, ph:video360p,
    ph:video720p, schema:thumbnail — relativas a clips/). Valores fora do
    padrão `<vhash>.<sufixo>` levantam ValueError (o TTL vem do cliente)."""
    from rdflib import Graph, URIRef
    g = Graph()
    g.parse(data=ttl_text, format="turtle")
    subj = URIRef(MED_NS + vid_id)
    allowed = {f"{vid_id}.{suffix}" for _, suffix, _ in _CLIP_VARIANTS}
    keys = []
    for pred in (PH_NS + "audio", PH_NS + "video360p", PH_NS + "video720p",
                 "https://schema.org/thumbnail"):
        for o in g.objects(subj, URIRef(pred)):
            rel = str(o).strip()
            if rel not in allowed:
                raise ValueError(f"caminho de blob inesperado no TTL: {rel!r}")
            keys.append(f"clips/{rel}")
    return keys


def _sweep_staging(max_age_s=STAGING_MAX_AGE_S):
    """Apaga pré-envios abandonados: marcador mais velho que max_age_s cujo
    vhash NÃO está no catálogo → blobs + marcador vão embora; se está no
    catálogo (upload concluiu e o marcador sobrou), só o marcador."""
    try:
        keys = STORE.list_keys(STAGING_PREFIX)
    except Exception as e:  # noqa: BLE001
        print(f"[staging] varredura: não listou {STAGING_PREFIX}: {e}")
        return 0
    if not keys:
        return 0
    now = datetime.now(timezone.utc)
    n = 0
    for key in keys:
        vid_id = key.rsplit("/", 1)[-1]
        if not _is_vhash(vid_id):
            continue
        try:
            stamp = datetime.fromisoformat((STORE.read_text(key) or "").strip())
        except Exception:  # noqa: BLE001
            stamp = None
        if stamp is not None and (now - stamp).total_seconds() < max_age_s:
            continue
        try:
            if not _media_in_catalog(vid_id):
                for k in _clip_keys(vid_id):
                    STORE.delete(k)
            STORE.delete(key)
            n += 1
        except Exception as e:  # noqa: BLE001
            print(f"[staging] varredura: falha em {vid_id}: {e}")
    if n:
        print(f"[staging] varredura apagou {n} pré-envio(s) abandonado(s)")
    return n


def _maybe_sweep_staging_async(min_interval_s=3600):
    global _last_staging_sweep
    import time as _time
    now = _time.monotonic()
    if now - _last_staging_sweep < min_interval_s:
        return
    _last_staging_sweep = now
    threading.Thread(target=_sweep_staging, name="staging-sweep", daemon=True).start()


@app.post("/stage-video/<vid_id>")
def stage_video(vid_id):
    """Pré-envio dos blobs de um vídeo ainda não catalogado (ver bloco acima).
    Mesmos campos de arquivo do /upload-video, sem TTL."""
    vid_id = (vid_id or "").strip().lower()
    if not _is_vhash(vid_id):
        return jsonify(error="id inválido (esperado vhash de 16 hex)"), 400
    if not request.files.get("audio"):
        return jsonify(error="audio ausente (sempre obrigatório)"), 400
    # Nunca sobrescreve blobs de mídia já catalogada (o form deduplica antes,
    # mas o servidor não confia nisso).
    if _media_in_catalog(vid_id):
        return jsonify(error=f"med:{vid_id} já existe no catálogo", id=vid_id), 409
    try:
        written = _write_clip_blobs(vid_id)
        STORE.write_text(STAGING_PREFIX + vid_id, datetime.now(timezone.utc).isoformat(),
                         content_type="text/plain")
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        return jsonify(error=f"pré-envio: {e}", id=vid_id), 500
    _maybe_sweep_staging_async()
    print(f"[stage-video] id={vid_id} files={written}")
    return jsonify(id=vid_id, files=written, staged=True, ok=True)


@app.post("/stage-video/<vid_id>/discard")
def discard_staged_video(vid_id):
    """Apaga um pré-envio não confirmado (card removido / aba fechada). Só
    mexe em vhash COM marcador e SEM entrada no catálogo."""
    vid_id = (vid_id or "").strip().lower()
    if not _is_vhash(vid_id):
        return jsonify(error="id inválido"), 400
    marker = STAGING_PREFIX + vid_id
    if not STORE.exists(marker):
        return jsonify(ok=True, discarded=False)
    discarded = False
    if not _media_in_catalog(vid_id):
        for k in _clip_keys(vid_id):
            STORE.delete(k)
        discarded = True
    STORE.delete(marker)
    return jsonify(ok=True, discarded=discarded)


@app.post("/upload-video")
def upload_video():
    """Recebe um clipe já processado no browser:
      - `audio`     : opus dentro de webm (sempre presente, alta qualidade)
      - `video360`  : webm 360p (opcional, audio-only mode)
      - `video720`  : webm 720p (opcional, audio-only mode)
      - `ttl`       : TTL auto-suficiente com 1 ph:MotionImage e seus metadados
      - `id`        : pHash de vídeo (16 hex)
      - `staged`    : "1" → os blobs já subiram via /stage-video; só o TTL vem
    Valida com SHACL (MotionImageShape), persiste os arquivos em `clips/<id>.*`
    e mescla os triples em `data/images.ttl` (que serve imagens E vídeos — o
    tipo vem da CLASSE StillImage/MotionImage, não do IRI)."""
    ttl_text = request.form.get("ttl")
    if not ttl_text:
        f = request.files.get("ttl")
        if f:
            ttl_text = f.read().decode("utf-8", errors="replace")
    if not ttl_text:
        return jsonify(error="ttl ausente"), 400

    vid_id = (request.form.get("id") or "").strip().lower()
    if not vid_id or len(vid_id) != 16 or not all(c in "0123456789abcdef" for c in vid_id):
        return jsonify(error="id inválido (esperado vhash de 16 hex)"), 400

    staged = (request.form.get("staged") or "").strip().lower() in ("1", "true")
    # Audio é obrigatório (a SHACL MotionImageShape exige ph:audio).
    if not staged and not request.files.get("audio"):
        return jsonify(error="audio ausente (sempre obrigatório)"), 400

    # Valida antes de gravar — evita lixo em disco se o TTL não bate com a id.
    # Um TTL malformado faz o parse levantar → 400 limpo em vez de 500.
    try:
        ok, vhash, errors = validate_video_ttl(ttl_text)
    except Exception as e:  # noqa: BLE001
        return jsonify(error=f"parse: {e}"), 400
    if not ok and not vhash:
        return jsonify(error="; ".join(errors)), 400
    if vhash != vid_id:
        return jsonify(error=f"id (form) {vid_id} != vhash (ttl) {vhash}"), 400
    if not ok:
        return jsonify(error="SHACL violations", details=errors), 422

    marker = STAGING_PREFIX + vid_id
    had_marker = STORE.exists(marker)
    if staged:
        # Blobs já no servidor (pré-envio): confere que os que o TTL referencia
        # existem — varridos/perdidos → 409 e o cliente reenvia com os blobs.
        try:
            written = _clip_keys_from_ttl(ttl_text, vid_id)
        except Exception as e:  # noqa: BLE001
            return jsonify(error=str(e)), 400
        missing = [k for k in written if not STORE.exists(k)]
        if missing:
            return jsonify(error="pré-envio não encontrado no servidor",
                           code="staging-missing", missing=missing, id=vid_id), 409
    else:
        # Grava (fora do lock; keys content-addressed pelo vhash — idempotente):
        # audio.webm sempre; webms só se vieram (audio-only mode); thumb
        # opcional. Todos em paralelo.
        try:
            written = _write_clip_blobs(vid_id)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return jsonify(error=f"gravação dos blobs: {e}", id=vid_id), 500

    def _cleanup_orphans():
        # Blobs já gravados sem triples = órfãos invisíveis. Limpa best-effort.
        for key in written:
            try:
                STORE.delete(key)
            except Exception as e2:  # noqa: BLE001
                print(f"[upload-video] aviso limpando órfão {key}: {e2}")

    # RMW do catálogo sob o lock, com re-checagem TOCTOU da colisão cross-type
    # (checada na validação FORA do lock — re-confere contra o catálogo ATUAL).
    from rdflib import RDF as _RDF, URIRef as _URIRef
    _vid_uri = _URIRef(MED_NS + vid_id)
    _still = _URIRef(PH_NS + "StillImage")
    collision = False
    try:
        with _state_lock:
            if (_vid_uri, _RDF.type, _still) in _load_catalog():
                collision = True
            else:
                upsert_video_in_uploads(ttl_text, vid_id)
                _invalidate_catalog()
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()   # o 500 devolve só str(e); o stack só existe aqui
        _cleanup_orphans()
        return jsonify(error=f"persistência ttl: {e}", id=vid_id, files=written), 500
    if collision:
        _cleanup_orphans()
        return jsonify(
            error=f"colisão: med:{vid_id} já existe como FOTO (ph:StillImage) — "
                  f"vhash colidiu com um phash.", id=vid_id,
        ), 409

    if had_marker:
        # Fecha o pré-envio: some o marcador e qualquer variante pré-enviada
        # que este upload NÃO referencia (ex.: 720p pré-enviado, HD desligado
        # antes do Enviar) — senão viraria blob órfão público.
        try:
            STORE.delete(marker)
            for k in _clip_keys(vid_id):
                if k not in written:
                    STORE.delete(k)
        except Exception as e:  # noqa: BLE001
            print(f"[upload-video] aviso fechando pré-envio de {vid_id}: {e}")
    print(f"[upload-video] id={vid_id} files={written}{' (pré-enviados)' if staged else ''}")
    return jsonify(id=vid_id, files=written, ok=True, staged=staged)


def remove_video_from_uploads(vhash):
    """Lê os caminhos dos arquivos do vídeo, purga triples (vídeo + bnodes
    alcançáveis), persiste, e devolve (paths, n_triples) — pra que o caller
    delete os blobs no STORE."""
    from rdflib import URIRef
    vid_iri = URIRef(MED_NS + vhash)
    SCHEMA = "https://schema.org/"
    paths = []
    with _mutating("images.ttl") as catalog:
        for pred in (PH_NS + "audio", PH_NS + "video360p", PH_NS + "video720p",
                     SCHEMA + "thumbnail"):
            for o in catalog.objects(vid_iri, URIRef(pred)):
                paths.append(str(o))
        n = _purge_subject(catalog, vid_iri)
    return paths, n


@app.post("/delete-video/<vhash>")
@serialized
def delete_video(vhash):
    vhash = (vhash or "").strip().lower()
    if not vhash or len(vhash) != 16 or not all(c in "0123456789abcdef" for c in vhash):
        return jsonify(error="vhash inválido"), 400
    try:
        paths, removed_triples = remove_video_from_uploads(vhash)
        _invalidate_catalog()
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()   # o 500 devolve só str(e); o stack só existe aqui
        return jsonify(error=f"persistência ttl: {e}", vhash=vhash), 500
    removed_files = 0
    for rel in paths:
        # `rel` é relativo a web/clips/ (ex.: "audio/IMG_X.m4a", "IMG_X.360p.mp4").
        # Vem do TTL armazenado (que qualquer cliente pode ter escrito — não
        # há auth), então sanitiza: um valor tipo "../app.js" viraria
        # web/app.js, dentro do root do store, e seria apagado de verdade.
        rel = str(rel).strip()
        if (not rel or rel.startswith(("/", "\\")) or "\\" in rel
                or ".." in rel.split("/") or "://" in rel):
            print(f"[delete-video] caminho suspeito ignorado: {rel!r}")
            continue
        key = f"clips/{rel}"
        try:
            STORE.delete(key)
            removed_files += 1
        except Exception as e:  # noqa: BLE001
            print(f"[delete-video] aviso ao remover {key}: {e}")
    print(f"[delete-video] vhash={vhash} files={removed_files} triples={removed_triples}")
    return jsonify(vhash=vhash, files=removed_files, triples=removed_triples)


@app.post("/delete-image/<phash>")
@serialized
def delete_image(phash):
    phash = (phash or "").strip().lower()
    if len(phash) != 16 or not all(c in "0123456789abcdef" for c in phash):
        return jsonify(error="phash inválido (esperado 16 hex)"), 400
    prefix = f"photos/{phash}/"
    removed_files = len(STORE.list_keys(prefix)) if hasattr(STORE, "list_keys") else 0
    # Triples primeiro, blobs depois (mesma ordem do delete-video): se a
    # purga do TTL falhar, os arquivos ainda existem e o catálogo continua
    # consistente — um retry conserta. Na ordem inversa, uma falha deixava
    # markers apontando pra imagens já apagadas (404 permanente).
    try:
        removed_triples = remove_image_from_uploads(phash)
        _invalidate_catalog()
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()   # o 500 devolve só str(e); o stack só existe aqui
        return jsonify(
            error=f"persistência ttl: {e}", phash=phash, files=0,
        ), 500
    try:
        STORE.delete_prefix(prefix)
    except Exception as e:  # noqa: BLE001
        print(f"[delete-image] erro removendo {prefix}: {e}")
    print(f"[delete-image] phash={phash} files={removed_files} triples={removed_triples}")
    return jsonify(phash=phash, files=removed_files, triples=removed_triples)


def _do_update_media(kind, hash_):
    """Handler compartilhado de /update-image e /update-video: patch de
    metadados por-predicado (mode=patch), SEM reenvio de blobs. `kind` =
    'image'|'video'. Body: `ttl` (predicados alterados + eventuais
    schema:Collection inline) + `remove` (CURIEs de predicados a limpar)."""
    from rdflib import URIRef
    hash_ = (hash_ or "").strip().lower()
    if len(hash_) != 16 or not all(c in "0123456789abcdef" for c in hash_):
        return jsonify(error=f"{kind} hash inválido (esperado 16 hex)"), 400
    ttl_text = request.form.get("ttl")
    if not ttl_text:
        f = request.files.get("ttl")
        if f:
            ttl_text = f.read().decode("utf-8", errors="replace")
    if not ttl_text:
        return jsonify(error="ttl ausente"), 400

    media_iri = MED_NS + hash_
    cls_local = "StillImage" if kind == "image" else "MotionImage"
    RDFT = URIRef("http://www.w3.org/1999/02/22-rdf-syntax-ns#type")
    if (URIRef(media_iri), RDFT, URIRef(PH_NS + cls_local)) not in _load_catalog():
        return jsonify(error=f"{kind} não encontrado: {hash_}"), 404

    try:
        remove_preds = _expand_remove_preds(request.form.get("remove", ""))
        result_ttl = synthesize_media_patch(media_iri, ttl_text, remove_preds)
    except Exception as e:  # noqa: BLE001
        return jsonify(error=f"patch: {e}"), 400

    validator = validate_image_ttl if kind == "image" else validate_video_ttl
    try:
        ok, _hash, errors = validator(result_ttl)
    except Exception as e:  # noqa: BLE001
        return jsonify(error=f"parse: {e}"), 400
    if not ok:
        return jsonify(error="shacl", details=errors), 400

    try:
        upsert_media_node(media_iri, result_ttl)
        _invalidate_catalog()
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()   # o 500 devolve só str(e); o stack só existe aqui
        return jsonify(error=f"persistência ttl: {e}"), 500
    print(f"[update-{kind}] {hash_} remove={request.form.get('remove','')!r}")
    return jsonify(ok=True, **{("phash" if kind == "image" else "vhash"): hash_})


@app.post("/update-image/<phash>")
@serialized
def update_image(phash):
    return _do_update_media("image", phash)


@app.post("/update-video/<vhash>")
@serialized
def update_video(vhash):
    return _do_update_media("video", vhash)


@app.post("/assign-media-lists")
@serialized
def assign_media_lists():
    """Operação em lote de pertencimento a listas (galeria): adiciona/remove
    schema:isPartOf em várias mídias num único ciclo de lock. Body JSON:
    {iris:[...], add:[listIri...], remove:[listIri...], newLists:[{iri,name}...]}.
    Só toca phd:image_/phd:video_; add/remove/newLists só aceitam lst: (listas).
    Como isPartOf é a única aresta tocada (range schema:Collection, garantido
    pelas listas declaradas), o resultado é SHACL-válido por construção — não
    revalidamos cada nó (seria N validações no lote). As arestas isPartOf ficam
    em images.ttl; as Collections (defs de lista) vivem em lists.ttl."""
    from rdflib import URIRef, Literal
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify(error="body JSON ausente/inválido"), 400
    iris = body.get("iris") or []
    add = body.get("add") or []
    remove = body.get("remove") or []
    new_lists = body.get("newLists") or []
    if not isinstance(iris, list) or not iris:
        return jsonify(error="iris vazio"), 400
    if not isinstance(add, list) or not isinstance(remove, list):
        return jsonify(error="add/remove devem ser listas"), 400

    LIST_PREFIX = LST_NS
    ISPARTOF = URIRef(SCHEMA_NS + "isPartOf")
    RDFT = URIRef("http://www.w3.org/1999/02/22-rdf-syntax-ns#type")
    COLLECTION = URIRef(SCHEMA_NS + "Collection")
    NAME = URIRef(SCHEMA_NS + "name")
    IMG_CLS = URIRef(PH_NS + "StillImage")
    VID_CLS = URIRef(PH_NS + "MotionImage")

    def _is_list(x):
        return isinstance(x, str) and x.startswith(LIST_PREFIX)
    def _is_media(x):
        # med:<16hex> — foto ou vídeo (o tipo vem da classe no catálogo).
        return isinstance(x, str) and x.startswith(MED_NS) and len(x[len(MED_NS):]) == 16
    if not all(_is_list(x) for x in add) or not all(_is_list(x) for x in remove):
        return jsonify(error="add/remove devem ser IRIs lst: (listas)"), 400
    for m in iris:
        if not _is_media(m):
            return jsonify(error=f"iri de mídia inválida: {m}"), 400

    # Grafos vivos (sob o lock do @serialized; ver _dump_graph). Toda validação
    # do body acontece ANTES de qualquer mutação — um 400 não pode deixar o
    # grafo em memória diferente do persistido.
    catalog = _dump_graph("images.ttl")
    # Listas (schema:Collection) vivem em lists.ttl — grafo à parte.
    lists_g = _dump_graph("lists.ttl")

    new_by_iri = {}
    for nl in new_lists:
        li = (nl or {}).get("iri")
        nm = (nl or {}).get("name")
        if not _is_list(li) or not nm:
            return jsonify(error=f"newList inválida: {nl}"), 400
        new_by_iri[li] = str(nm)
    # Toda lista em `add` precisa existir como Collection (range de isPartOf)
    # — já em lists.ttl ou declarada em newLists.
    for li in add:
        if (URIRef(li), RDFT, COLLECTION) not in lists_g and li not in new_by_iri:
            return jsonify(error=f"lista inexistente (declare em newLists): {li}"), 400

    # Garante que as listas novas existam como schema:Collection em lists.ttl
    # (persistem como sujeitos à parte, iguais a pessoas em identities.ttl).
    lists_dirty = False
    for li, nm in new_by_iri.items():
        lu = URIRef(li)
        if (lu, RDFT, COLLECTION) not in lists_g:
            lists_g.add((lu, RDFT, COLLECTION))
            lists_g.add((lu, NAME, Literal(nm)))
            lists_dirty = True

    touched = 0
    for m in iris:
        mu = URIRef(m)
        if (mu, RDFT, IMG_CLS) not in catalog and (mu, RDFT, VID_CLS) not in catalog:
            continue   # mídia inexistente — pula (idempotente)
        for li in remove:
            catalog.remove((mu, ISPARTOF, URIRef(li)))
        for li in add:
            catalog.add((mu, ISPARTOF, URIRef(li)))
        touched += 1

    if lists_dirty:
        _commit_dump("lists.ttl")
    _commit_dump("images.ttl")
    _invalidate_catalog()
    print(f"[assign-media-lists] iris={len(iris)} touched={touched} add={add} remove={remove}")
    return jsonify(ok=True, touched=touched)


@app.post("/update-person/<slug>")
@serialized
def update_person(slug):
    """Edita os metadados de uma pessoa em identities.ttl (fonte única).

    Pós-split, pessoas vivem SÓ em identities.ttl (tours/images apenas as
    referenciam). Form fields:
      - `alternateName` (obrigatório) — apelido/handle, o rótulo curto
      - `name` (opcional) — nome real (schema:name)
      - `url` (opcional) — página pessoal (schema:url)
      - `seeAlso` (opcional, repetível) — perfis/links relacionados
        (rdfs:seeAlso — Instagram, Mastodon, etc.; associa sem afirmar
        identidade, ao contrário de schema:sameAs)
    Reescreve só esses predicados; rdf:type e schema:mainEntityOfPage são
    preservados. url/seeAlso precisam ser http(s). Se a pessoa não existe mas é
    referenciada em algum catálogo, a definição é criada. O PersonShape é soft
    (não bloqueia). Sem routes.json, sem auth.
    """
    import re as _re
    from rdflib import URIRef, Literal
    slug = (slug or "").strip()
    if not slug or not all(c.isalnum() or c in "_-" for c in slug):
        return jsonify(error="slug inválido"), 400
    alt = (request.form.get("alternateName") or "").strip()
    real_name = (request.form.get("name") or "").strip()
    url = (request.form.get("url") or "").strip()
    see_also = [u.strip() for u in request.form.getlist("seeAlso") if u.strip()]
    if not alt:
        return jsonify(error="alternateName ausente (apelido é obrigatório)"), 400
    if len(alt) > 200 or len(real_name) > 200:
        return jsonify(error="nome longo demais (máx. 200)"), 400
    for u in ([url] if url else []) + see_also:
        if not _re.match(r"^https?://", u):
            return jsonify(error=f"URL inválida (precisa http/https): {u}"), 400

    v = _load_validator()
    Graph = v["Graph"]
    person = URIRef(PES_NS + slug)
    RDFT = URIRef("http://www.w3.org/1999/02/22-rdf-syntax-ns#type")
    # schema.org aparece nas duas formas (https/http) no acervo — trata ambas.
    PERSON_CLS = (URIRef(SCHEMA_NS + "Person"), URIRef("http://schema.org/Person"))
    def _sc(local):
        return (URIRef(SCHEMA_NS + local), URIRef("http://schema.org/" + local))
    ALT_P, NAME_P, URL_P = _sc("alternateName"), _sc("name"), _sc("url")
    SEEALSO = URIRef("http://www.w3.org/2000/01/rdf-schema#seeAlso")

    idg = _dump_graph("identities.ttl")   # grafo vivo — sob o lock do @serialized
    defined = (any((person, RDFT, c) in idg for c in PERSON_CLS)
               or any((person, p, None) in idg for p in ALT_P))
    if not defined and (None, None, person) not in _load_catalog():
        # Nem definida em identities nem referenciada em lugar nenhum.
        return jsonify(error=f"pessoa desconhecida: {slug}"), 404

    def _clear(preds):
        for p in preds:
            for o in list(idg.objects(person, p)):
                idg.remove((person, p, o))
    _clear(ALT_P); idg.add((person, URIRef(SCHEMA_NS + "alternateName"), Literal(alt)))
    _clear(NAME_P)
    if real_name:
        idg.add((person, URIRef(SCHEMA_NS + "name"), Literal(real_name)))
    _clear(URL_P)
    if url:
        idg.add((person, URIRef(SCHEMA_NS + "url"), URIRef(url)))
    for o in list(idg.objects(person, SEEALSO)):
        idg.remove((person, SEEALSO, o))
    for u in see_also:
        idg.add((person, SEEALSO, URIRef(u)))
    if not any((person, RDFT, c) in idg for c in PERSON_CLS):
        idg.add((person, RDFT, URIRef(SCHEMA_NS + "Person")))
    _commit_dump("identities.ttl")
    _invalidate_catalog()
    print(f"[update-person] {slug} alt={alt!r} name={real_name!r} "
          f"url={bool(url)} seeAlso={len(see_also)}")
    return jsonify(ok=True, slug=slug, alternateName=alt, name=real_name,
                   url=url, seeAlso=see_also, files=["identities.ttl"])


@app.post("/upload-tour")
def upload_tour():
    """Cria/atualiza 1 ph:Tour em tours.ttl.

    Espera `ttl` (form field ou file) com exatamente 1 `pas:<slug> a ph:Tour`
    + opcionalmente declarações novas de `phd:assoc_*`, `phd:pessoa*`, etc.

    Dois modos (form field `mode`):
      - `replace` (padrão): o TTL é o estado COMPLETO do tour — purge-and-
        replace de todos os triples do IRI. Certo pra criação.
      - `patch`: merge-patch por predicado — só os predicados afirmados no
        TTL (mais os listados no form field `remove`, CURIEs/IRIs separados
        por vírgula) substituem os existentes; o resto do tour sobrevive
        intacto. Certo pra edição: o cliente não precisa round-tripar
        predicados que não conhece. Com `announcement`, o schema:image atual
        também é substituído pela URL fresca. O SHACL valida o estado final.

    Opcionalmente, `announcement` (file): salvo em
    `tour_assets/<tour_id>/announcement.<ext>` no store e injetado como
    `schema:image <URL>` no TTL antes de persistir.

    Depois de persistir, sincroniza routes.json: se o tour tem `ph:linkRoute`
    → RideWithGPS, busca a geometria e faz upsert da rota; senão remove a
    entrada órfã. O fetch (IO de rede) roda FORA do lock — por isso este
    handler não usa `@serialized` no corpo inteiro, só envolve a seção crítica
    (validação + escrita do tours.ttl) em `with _state_lock`.

    Sem auth — mesma política do resto da API.
    """
    ttl_text = request.form.get("ttl")
    if not ttl_text:
        f = request.files.get("ttl")
        if f:
            ttl_text = f.read().decode("utf-8", errors="replace")
    if not ttl_text:
        return jsonify(error="ttl ausente"), 400

    mode = (request.form.get("mode") or "replace").strip().lower()
    if mode not in ("replace", "patch"):
        return jsonify(error=f"mode inválido: {mode!r} (replace|patch)"), 400

    # Seção crítica: validação + announcement + escrita do tours.ttl, tudo
    # serializado. O fetch da rota acontece depois, sem o lock. O patch é
    # sintetizado aqui dentro (lê tours.ttl) pra não perder updates entre a
    # leitura do estado atual e a escrita do resultado.
    with _state_lock:
        if mode == "patch":
            ann = request.files.get("announcement")
            try:
                remove_preds = _expand_remove_preds(request.form.get("remove"))
                _tid, ttl_text = synthesize_tour_patch(
                    ttl_text, remove_preds,
                    replace_image=bool(ann and ann.filename))
            except ValueError as e:
                return jsonify(error=str(e)), 400
            except Exception as e:  # noqa: BLE001
                return jsonify(error=f"patch: {e}"), 400
        try:
            ok, tour_id, errors = validate_tour_ttl(ttl_text)
        except Exception as e:  # noqa: BLE001
            return jsonify(error=f"parse: {e}"), 400
        if not ok:
            return jsonify(error="shacl", details=errors, tour_id=tour_id), 400

        # Slug legível (schema:identifier) — mintado na criação, re-herdado
        # nos saves seguintes; ver _ensure_tour_slug. Best-effort: uma falha
        # no mint não derruba o save (o slug8 segue sendo o endereço), mas um
        # identifier postado que colide com outro passeio é rejeitado.
        try:
            ttl_text = _ensure_tour_slug(ttl_text, tour_id)
        except ValueError as e:
            return jsonify(error=str(e), tour_id=tour_id), 400
        except Exception as e:  # noqa: BLE001
            print(f"[upload-tour] aviso mintando slug de {tour_id}: {e}")

        # Upload opcional do anúncio: salva no store e injeta `schema:image`.
        announcement_url = None
        f = request.files.get("announcement")
        if f and f.filename:
            ext = (os.path.splitext(f.filename or "")[1].lstrip(".") or "jpg").lower()
            if ext not in ("jpg", "jpeg", "png", "webp", "gif", "heic", "heif"):
                ext = "jpg"
            if ext == "jpeg":
                ext = "jpg"
            key = f"tour_assets/{tour_id}/announcement.{ext}"
            ct = {
                "jpg": "image/jpeg", "png": "image/png",
                "webp": "image/webp", "gif": "image/gif",
                "heic": "image/heic", "heif": "image/heif",
            }.get(ext, "application/octet-stream")
            try:
                STORE.write_bytes(key, f.read(), content_type=ct)
            except Exception as e:  # noqa: BLE001
                return jsonify(
                    error=f"persistência announcement: {e}", tour_id=tour_id,
                ), 500
            # URL ABSOLUTA obrigatoriamente: um caminho relativo
            # ("./tour_assets/…") injetado como IRI no TTL é resolvido pelo
            # rdflib contra o CWD do processo na re-serialização → vira
            # file:///… inutilizável.
            #
            # A ordem importa. `request.host_url` é o ÚLTIMO recurso porque ele
            # grava no catálogo o host pelo qual ESTE cliente chegou — e um
            # backend de desenvolvimento assa `http://localhost:8080/…` num
            # dado que depois sobe pra produção pelo `deploy-cloudrun.sh
            # --state` (foi o que aconteceu com o PH/96). Quem auto-hospeda
            # deve setar PUBLIC_BASE_URL com o host público de verdade.
            announcement_url = (
                STORE.public_url(key)
                or (PUBLIC_BASE_URL
                    and f"{PUBLIC_BASE_URL}/tour_assets/{tour_id}/announcement.{ext}")
                or (request.host_url.rstrip("/")
                    + f"/tour_assets/{tour_id}/announcement.{ext}"))
            # Injeta schema:image se ainda não estiver no TTL (cliente pode
            # ter posto um URL externo; respeitamos a escolha do cliente).
            # Checagem via triple (não substring): um TTL usando a IRI completa
            # `<https://schema.org/image>` passava no teste antigo de substring
            # `"schema:image" in ttl_text` e ganhava um image duplicado.
            from rdflib import Graph as _RdfGraph, URIRef as _URIRef
            _tour_uri = _URIRef(PAS_NS + tour_id)
            _img_preds = (_URIRef("https://schema.org/image"), _URIRef("http://schema.org/image"))
            try:
                _g = _RdfGraph().parse(data=ttl_text, format="turtle")
                _has_image = any((_tour_uri, p, None) in _g for p in _img_preds)
            except Exception:  # noqa: BLE001
                _has_image = "schema:image" in ttl_text  # fallback conservador
            if not _has_image:
                # IRI completa no subject: o TTL pode ser sintetizado pelo
                # mode=patch (serialização rdflib), que não garante o
                # prefixo pas: — a forma <...> é válida em qualquer doc.
                inject = (
                    f"\n# Imagem do anúncio (uploaded server-side)\n"
                    f"<{PAS_NS}{tour_id}> <https://schema.org/image> "
                    f"<{announcement_url}> .\n"
                )
                ttl_text = ttl_text + inject

        try:
            upsert_tour_in_tours_ttl(ttl_text, tour_id)
            _invalidate_catalog()
        except Exception as e:  # noqa: BLE001
            # Anúncio já gravado sem triples referenciando-o = órfão invisível.
            # Limpa best-effort (mesmo padrão do upload-image/upload-video).
            if f and f.filename:
                try:
                    STORE.delete(key)
                except Exception as e2:  # noqa: BLE001
                    traceback.print_exc()   # o 500 devolve só str(e); o stack só existe aqui
                    print(f"[upload-tour] aviso limpando anúncio órfão de {tour_id}: {e2}")
            return jsonify(
                error=f"persistência ttl: {e}", tour_id=tour_id,
            ), 500

    # Fora do lock: sincroniza a geometria da rota (best-effort, IO de rede).
    # O try/except garante que NENHUMA falha aqui (import, storage, bug)
    # transforma um save bem-sucedido do tour em 500.
    try:
        route_status = _sync_tour_route(tour_id)
    except Exception as e:  # noqa: BLE001
        route_status = {"status": "error", "error": str(e)}
        print(f"[upload-tour] erro sincronizando routes.json: {e}")
    print(f"[upload-tour] tour_id={tour_id} announcement={announcement_url} "
          f"route={route_status.get('status')}")
    return jsonify(
        tour_id=tour_id, announcement_url=announcement_url,
        route=route_status, mode=mode, ok=True,
    )


@app.post("/delete-tour/<tour_id>")
@serialized
def delete_tour(tour_id):
    """Remove um ph:Tour (e seus bnodes) do tours.ttl + apaga seus assets
    (tour_assets/<id>/) do store. Não toca em pessoas/séries — git history
    preserva e elas podem ser referenciadas por outros tours."""
    tour_id = (tour_id or "").strip()
    if not tour_id or not all(c.isalnum() or c in "_-" for c in tour_id):
        return jsonify(error="tour_id inválido"), 400
    asset_prefix = f"tour_assets/{tour_id}/"
    removed_assets = len(STORE.list_keys(asset_prefix)) if hasattr(STORE, "list_keys") else 0
    # Triples primeiro, assets depois (mesma ordem do delete-image): se a
    # purga do TTL falhar, os assets ainda existem e `schema:image` continua
    # apontando pra algo válido — um retry conserta. Na ordem inversa, uma
    # falha deixava o tour com `schema:image` quebrado (assets já apagados)
    # até o próximo retry.
    try:
        removed_triples = remove_tour_from_tours_ttl(tour_id)
        _invalidate_catalog()
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()   # o 500 devolve só str(e); o stack só existe aqui
        return jsonify(
            error=f"persistência ttl: {e}", tour_id=tour_id,
            assets=0,
        ), 500
    try:
        STORE.delete_prefix(asset_prefix)
    except Exception as e:  # noqa: BLE001
        print(f"[delete-tour] erro removendo {asset_prefix}: {e}")
    # Remove a entrada do tour de routes.json (sem IO de rede — lock curto).
    try:
        removed_routes = _remove_tour_route(tour_id)
    except Exception as e:  # noqa: BLE001
        removed_routes = 0
        print(f"[delete-tour] erro removendo rota de routes.json: {e}")
    print(f"[delete-tour] tour_id={tour_id} assets={removed_assets} "
          f"triples={removed_triples} routes={removed_routes}")
    return jsonify(tour_id=tour_id, assets=removed_assets,
                   triples=removed_triples, routes=removed_routes)


# ── Aquecimento (boot) ───────────────────────────────────────────────────
# O validador (pyshacl + shapes/ontology) e o catálogo eram carregados na
# PRIMEIRA mutação — quem subia a primeira foto depois de um deploy/idle do
# Cloud Run pagava imports + leitura de todos os dumps do bucket. Uma thread
# no boot faz isso em paralelo com o primeiro request (best-effort; os locks
# serializam se um request chegar antes). PHIDRO_NO_WARMUP=1 desliga (scripts
# que importam este módulo só pelas funções).
def _warm_caches():
    import time as _time
    t0 = _time.monotonic()
    try:
        _load_validator()
        _load_catalog()
        print(f"[warmup] validador + catálogo prontos em {_time.monotonic() - t0:.1f}s")
        _sweep_staging()
    except Exception as e:  # noqa: BLE001
        print(f"[warmup] falhou (segue lazy): {e}")


if not os.environ.get("PHIDRO_NO_WARMUP"):
    threading.Thread(target=_warm_caches, name="warmup", daemon=True).start()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
