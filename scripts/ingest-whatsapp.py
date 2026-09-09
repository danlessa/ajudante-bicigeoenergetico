#!/usr/bin/env python3
"""FASE 2 da ingestão do acervo: os arquivos do WHATSAPP (sem EXIF).

A fase 1 (ingest-drive.py) sobe os originais com EXIF/GPS — mídia de primeira
classe, com marcador no mapa. Esta sobe o resto: os ~6.400 JPEGs e ~1.300 MP4s
que passaram pelo WhatsApp, que remove TODO o EXIF ao enviar. Sem GPS não há
marcador (o mixin ph:GeoreferencedImage NÃO é emitido; o mapa os ignora
sozinho), mas eles entram como MEMÓRIA do passeio: ph:capturedDuring, quem
compartilhou, navegáveis na galeria e no modal do passeio.

O que se sabe de verdade sobre cada arquivo, e é só isso que vai pro TTL:
  · o passeio ......... a pasta do acervo casa com o tours.ttl (audit-captura)
  · quando ............ dcterms:date = a data/hora DO PASSEIO (ph:departedAt ou
                        a dcterms:date do tour) — o carimbo no nome do arquivo é
                        a hora do COMPARTILHAMENTO, não da captura, e vai pra
                        schema:datePublished, que é o que ele é.
  · quem compartilhou . o slug do acervo vai SEMPRE como literal em
                        schema:creditText (é o join com identities.ttl via
                        schema:alternateName, como o ph:sweepContributor do
                        passe); quando o whatsapp-slug-map.json resolve a
                        pessoa, também pav:providedBy + prov:wasAttributedTo.
Nada de coordenada inventada, nada de hora inventada.

RODE A FASE 1 ANTES. Como o pHash é o IRI e o WhatsApp só recomprime, uma
cópia de zap e o original colidem no mesmo IRI (Hamming ≤ 5) — com os
originais já lá, as cópias deduplicam contra eles e a versão COM GPS vence.

    ingest-whatsapp.py                          # dry-run: só imagens
    ingest-whatsapp.py --pasta "Água Preta" --apply
    ingest-whatsapp.py --so-resolvidos --apply  # só quem já tem pessoa no mapa
    ingest-whatsapp.py --videos --pasta X --apply   # inclui os MP4 (ffmpeg)

┌─ BAIXA BYTES DO DRIVE ──────────────────────────────────────────────────────┐
│ Os arquivos são stubs: calcular o pHash exige os bytes, então mesmo o       │
│ --dry-run BAIXA (imagens ≈ 4 GiB; vídeos ≈ 5,5 GiB). Rode por pasta.        │
│ O acervo é SOMENTE-LEITURA: nada é escrito, movido ou apagado lá.           │
└─────────────────────────────────────────────────────────────────────────────┘
Vídeos: vhash (8 quadros, voto por bit — como o form), audio.webm (opus 192k),
360p.webm (vp9 700k + opus 128k, 30 fps) e thumb.jpg via ffmpeg; sem 720p (o
mapa só o usa com "HD" ligado). MP4 sem trilha de áudio ganha silêncio
(anullsrc) — o /upload-video exige ph:audio.
"""
from __future__ import annotations

import argparse
import importlib.util
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parents[1]


def _importa(nome_mod: str, arquivo: str):
    caminho = REPO / "scripts" / arquivo
    spec = importlib.util.spec_from_file_location(nome_mod, caminho)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[nome_mod] = mod
    spec.loader.exec_module(mod)
    return mod


# ingest-drive.py é a fonte do pHash, das variantes e do catálogo remoto; ele
# por sua vez importa o audit-captura (varredura, casamento pasta→passeio).
I = _importa("ingest_drive", "ingest-drive.py")
A = I.A

import rdflib  # noqa: E402  (depois dos imports dinâmicos, como o ingest-drive)

PH = rdflib.Namespace(I.PH_NS)
DCTERMS = rdflib.Namespace("http://purl.org/dc/terms/")
TZ_SP = timezone(timedelta(hours=-3))

# "dandanlessa WhatsApp Image 2025-09-10 at 00.46.14.jpeg" → 2025-09-10T00:46:14-03:00
RE_CARIMBO = re.compile(
    r"WhatsApp\s+(?:Image|Video|Audio|Ptt)\s+(\d{4}-\d{2}-\d{2})\s+at\s+(\d{2})\.(\d{2})\.(\d{2})",
    re.I)

PREFIXOS = I.PREFIXOS + "@prefix pav:     <http://purl.org/pav/> .\n"

VIDEO_BITRATE_360 = "700k"
AUDIO_BITRATE_CLIP = "128k"
AUDIO_BITRATE_ONLY = "192k"


@dataclass
class Item:
    caminho: Path
    pasta: str
    kind: str                       # 'image' | 'video'
    hash: str = ""
    tour_slug: str | None = None
    tour_iri: str | None = None
    data: str | None = None         # dcterms:date (do passeio)
    publicado: str | None = None    # schema:datePublished (carimbo do arquivo)
    slug_bruto: str | None = None
    pessoa_slug: str | None = None
    duracao: float = 0.0
    original: bool = False          # original sem GPS (fase 1 pulou) — data vem do EXIF
    variantes: dict = field(default_factory=dict)


# ═════════════════════════════════════════════════════════════════════════
# 1. Datas
# ═════════════════════════════════════════════════════════════════════════

def carimbo_compartilhamento(nome: str) -> str | None:
    m = RE_CARIMBO.search(nome)
    if not m:
        return None
    d, hh, mm, ss = m.groups()
    return f"{d}T{hh}:{mm}:{ss}-03:00"


def data_do_passeio(g: rdflib.Graph, tour_iri: str) -> str | None:
    """ph:departedAt (a saída de verdade) ou, sem ele, a dcterms:date do tour —
    ambos xsd:dateTime já com offset no catálogo."""
    t = rdflib.URIRef(tour_iri)
    v = g.value(t, PH.departedAt) or g.value(t, DCTERMS.date)
    if v is None:
        return None
    s = str(v)
    if "T" not in s:                       # data pura → meia-noite de SP (raro)
        s += "T00:00:00-03:00"
    return s


# ═════════════════════════════════════════════════════════════════════════
# 2. Vídeo — vhash, transcode e thumb via ffmpeg (o form faz no navegador)
# ═════════════════════════════════════════════════════════════════════════

def ffprobe(caminho: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format",
         str(caminho)], capture_output=True, text=True, check=False)
    if out.returncode != 0 or not out.stdout:
        raise RuntimeError(f"ffprobe: {out.stderr.strip()[:120]}")
    return json.loads(out.stdout)


def _quadro(caminho: Path, t: float) -> Image.Image:
    """Um quadro em t (s), já com a rotação do container aplicada (ffmpeg
    autorotate) — o mesmo que o <video> entrega ao canvas."""
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", f"{t:.3f}", "-i", str(caminho), "-frames:v", "1",
         "-f", "image2pipe", "-vcodec", "png", "-"], capture_output=True, check=False)
    if out.returncode != 0 or not out.stdout:
        raise RuntimeError("ffmpeg quadro")
    return Image.open(io.BytesIO(out.stdout)).convert("RGB")


def vhash(caminho: Path, dur: float, n: int = 8) -> str:
    """computeVideoPHash() do form: N quadros uniformes, pHash de cada, voto
    majoritário por bit. Quadro sem ICC (o <video> entrega sRGB ao canvas)."""
    hist = np.zeros(64, dtype=int)
    got = 0
    for i in range(n):
        t = min(max(0.05, ((i + 0.5) / n) * dur), max(0.05, dur - 0.05))
        try:
            h = I.phash(_quadro(caminho, t), None)
        except Exception:                   # noqa: BLE001 — seek falhou: pula o quadro
            continue
        bits = bin(int(h, 16))[2:].zfill(64)
        hist += np.array([int(b) for b in bits])
        got += 1
    if got == 0:
        raise RuntimeError("nenhum quadro decodificou")
    out = "".join("1" if c > got / 2 else "0" for c in hist)
    hx = f"{int(out, 2):016x}"
    if re.fullmatch(r"(.)\1{15}", hx):     # quadro uniforme → hash degenerado
        raise RuntimeError("vhash uniforme (quadros pretos?)")
    return hx


def _dims_360(w: int, h: int) -> tuple[int, int]:
    if w >= h:
        oh, ow = 360, round(360 * w / h)
    else:
        ow, oh = 360, round(360 * h / w)
    return ow - ow % 2, oh - oh % 2


def transcoda_video(caminho: Path, info: dict) -> tuple[dict[str, tuple[str, bytes]], float]:
    """audio.webm + 360p.webm + thumb.jpg, como o transcodeClip() do form
    (sem 720p). Devolve (variantes, duração)."""
    vs = next((s for s in info["streams"] if s.get("codec_type") == "video"), None)
    aus = next((s for s in info["streams"] if s.get("codec_type") == "audio"), None)
    if not vs:
        raise RuntimeError("sem trilha de vídeo")
    dur = float(info.get("format", {}).get("duration") or vs.get("duration") or 0)
    if dur <= 0.1:
        raise RuntimeError("duração inválida")
    if dur > 600.5:
        raise RuntimeError("vídeo > 10 min")
    w, h = int(vs["width"]), int(vs["height"])
    rot = 0
    for sd in vs.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(sd["rotation"])
    if rot % 180:
        w, h = h, w
    ow, oh = _dims_360(w, h)
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        entrada = ["-i", str(caminho)]
        # Sem áudio: silêncio da mesma duração — o catálogo exige ph:audio.
        mapa_a = ["-map", "0:a:0"] if aus else ["-f", "lavfi", "-t", f"{dur:.3f}",
                                                 "-i", "anullsrc=r=48000:cl=stereo"]
        if not aus:
            entrada = entrada + mapa_a
            mapa_a = ["-map", "1:a:0"]
        base = ["ffmpeg", "-v", "error", "-y", *entrada]
        subprocess.run([*base, *mapa_a, "-vn", "-c:a", "libopus", "-b:a", AUDIO_BITRATE_ONLY,
                        str(td / "audio.webm")], check=True, capture_output=True)
        subprocess.run([*base, "-map", "0:v:0", *mapa_a,
                        "-vf", f"scale={ow}:{oh}", "-r", "30",
                        "-c:v", "libvpx-vp9", "-b:v", VIDEO_BITRATE_360,
                        "-deadline", "realtime", "-cpu-used", "5", "-row-mt", "1",
                        "-c:a", "libopus", "-b:a", AUDIO_BITRATE_CLIP,
                        str(td / "360p.webm")], check=True, capture_output=True)
        t_thumb = min(0.5, dur * 0.05)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t_thumb:.3f}", "-i", str(caminho),
                        "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4",
                        str(td / "thumb.jpg")], check=True, capture_output=True)
        return {
            "audio": ("audio.webm", (td / "audio.webm").read_bytes()),
            "video360": ("360p.webm", (td / "360p.webm").read_bytes()),
            "thumb": ("thumb.jpg", (td / "thumb.jpg").read_bytes()),
        }, dur


# ═════════════════════════════════════════════════════════════════════════
# 3. TTL — contratos do /upload-image e do /upload-video
# ═════════════════════════════════════════════════════════════════════════

def _turtle_str(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')


def _props_comuns(it: Item) -> list[str]:
    props = [f"dcterms:license <{I.LICENCA_PADRAO}>"]
    if it.data:
        props.append(f'dcterms:date "{it.data}"^^xsd:dateTime')
    if it.publicado:
        props.append(f'schema:datePublished "{it.publicado}"^^xsd:dateTime')
    if it.tour_slug:
        props.append(f"ph:capturedDuring pas:{it.tour_slug}")
    if it.pessoa_slug:
        props.append(f"prov:wasAttributedTo pes:{it.pessoa_slug}")
        props.append(f"pav:providedBy pes:{it.pessoa_slug}")
    if it.slug_bruto:
        props.append(f'schema:creditText "{_turtle_str(it.slug_bruto)}"')
    return props


def monta_ttl_imagem(it: Item) -> str:
    ident = f"med:{it.hash}"
    props = ["a ph:StillImage",              # SEM ph:GeoreferencedImage: não há GPS
             f"nfo:hasHash {ident}_hash",
             *_props_comuns(it)]
    if it.original:
        _, mime = I.formato_original(it.caminho)
        if mime != "image/jpeg":
            props.append(f'schema:encodingFormat "{mime}"')
    corpo = " ;\n".join(f"    {p}" for p in props)
    derivados = (f"{ident}_hash a nfo:FileHash ;\n"
                 f'    nfo:hashAlgorithm "pHash" ;\n'
                 f'    nfo:hashValue "{it.hash}" .')
    return f"{PREFIXOS}\n{ident}\n{corpo} .\n\n{derivados}\n"


def monta_ttl_video(it: Item) -> str:
    ident = f"med:{it.hash}"
    iso = f"PT{round(it.duracao * 100) / 100}S"
    props = ["a ph:MotionImage",
             f'schema:duration "{iso}"^^xsd:duration',
             f'ph:audio "{it.hash}.audio.webm"',
             f'schema:thumbnail "{it.hash}.thumb.jpg"',
             f'ph:video360p "{it.hash}.360p.webm"',
             'ph:availableResolution "audio", "360p"',
             *_props_comuns(it)]
    corpo = " ;\n".join(f"    {p}" for p in props)
    return f"{PREFIXOS}\n{ident}\n{corpo} .\n"


def envia(servidor: str, endpoint: str, campos: dict, arquivos: dict) -> tuple[bool, str]:
    body, headers = I._multipart(campos, arquivos)
    headers["User-Agent"] = A.USER_AGENT
    req = urllib.request.Request(f"{servidor}{endpoint}", data=body, headers=headers,
                                 method="POST")
    try:
        with urllib.request.urlopen(req, timeout=600, context=A._contexto_ssl()) as r:
            j = json.loads(r.read().decode("utf-8"))
            return True, ",".join(j.get("files", [])) or "ok"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}: {e.read().decode('utf-8', errors='replace')[:200]}"
    except Exception as e:                  # noqa: BLE001
        return False, str(e)


# ═════════════════════════════════════════════════════════════════════════
# 4. O laço
# ═════════════════════════════════════════════════════════════════════════

def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--acervo", default=os.environ.get("BIBLIOTECA_DIR", A.ACERVO_PADRAO))
    ap.add_argument("--servidor", default=os.environ.get("PHIDRO_SERVER", I.SERVIDOR_PADRAO))
    ap.add_argument("--apply", action="store_true", help="envia pra valer (default: dry-run)")
    ap.add_argument("--limit", type=int, help="processa no máximo N arquivos")
    ap.add_argument("--pasta", help="só as pastas do acervo cujo nome contém isto")
    ap.add_argument("--pessoa", help="só arquivos cujo slug (normalizado) é este")
    ap.add_argument("--so-resolvidos", action="store_true",
                    help="só arquivos cujo slug já resolve pra uma pessoa no slug-map")
    ap.add_argument("--videos", action="store_true", help="inclui os MP4 (ffmpeg, lento)")
    ap.add_argument("--originais", action="store_true",
                    help="inclui também os ORIGINAIS que a fase 1 pulou por não terem GPS "
                         "(têm data de captura no EXIF → dcterms:date real; sem marcador)")
    ap.add_argument("--so-videos", action="store_true", help="só os MP4")
    a = ap.parse_args()

    servidor = a.servidor.rstrip("/")
    print("═" * 72)
    print("  INGESTÃO DO ACERVO — FASE 2 (WhatsApp: sem EXIF, sem marcador)")
    print("═" * 72)

    pastas = A.ler_acervo(Path(a.acervo), quieto=True)
    passeios, g = A.carregar_catalogos()
    A.casar(passeios, pastas)
    por_pasta = {p.pasta.nome: p for p in passeios if p.pasta}
    pessoas = I.mapa_pessoas()
    quer_img = not a.so_videos
    quer_vid = a.videos or a.so_videos

    cands: list[Item] = []
    sem_passeio: set[str] = set()
    for pa in pastas:
        if a.pasta and a.pasta.lower() not in pa.nome.lower():
            continue
        p = por_pasta.get(pa.nome)
        if p is None and pa.whatsapp_paths:
            sem_passeio.add(pa.nome)
            continue                         # sem passeio não há o que ancorar: fica pra depois
        fontes = [(c, sl, False) for c, sl in pa.whatsapp_paths]
        if a.originais:
            fontes += [(c, sl, True) for c, sl in pa.originais_paths]
        for caminho, slug, original in fontes:
            ext = caminho.suffix.lower()
            if ext in A.IMAGE_EXT and quer_img:
                kind = "image"
            elif ext in A.VIDEO_EXT and quer_vid:
                kind = "video"
            else:
                continue
            if original and ext not in (".jpg", ".jpeg", ".png", ".heic", ".heif", *A.VIDEO_EXT):
                continue                     # o backend só aceita esses como original
            it = Item(caminho=caminho, pasta=pa.nome, kind=kind, original=original)
            # Originais "dandanlessa DSC09460.JPG": 1º token como slug SÓ se
            # já resolve pra pessoa (mesmo fallback da fase 1).
            if not slug and " " in caminho.name and A.norm(caminho.name.split(" ", 1)[0]) in pessoas:
                slug = caminho.name.split(" ", 1)[0]
            it.slug_bruto = slug
            it.pessoa_slug = pessoas.get(A.norm(slug)) if slug else None
            if a.pessoa and (not slug or A.norm(slug) != A.norm(a.pessoa)):
                continue
            if a.so_resolvidos and not it.pessoa_slug:
                continue
            it.tour_slug, it.tour_iri = p.slug, p.iri
            it.data = data_do_passeio(g, p.iri)
            it.publicado = carimbo_compartilhamento(caminho.name)   # None nos originais
            cands.append(it)
    if a.limit:
        cands = cands[:a.limit]
    if sem_passeio:
        print(f"  ⚠ pastas com zap mas sem passeio casado (puladas): {', '.join(sorted(sem_passeio))}")
    if not cands:
        sys.exit("nenhum arquivo do WhatsApp com esses filtros.")

    total_b = sum(c.caminho.stat().st_size for c in cands)
    n_img = sum(1 for c in cands if c.kind == "image")
    n_vid = len(cands) - n_img
    print(f"\n{n_img} imagens + {n_vid} vídeos em {len({c.pasta for c in cands})} pastas")
    print(f"BAIXANDO ~{total_b / 1024**3:.2f} GiB do Drive\n")

    por_classe = I.hashes_no_servidor(servidor)
    fotos, videos = por_classe["StillImage"], por_classe["MotionImage"]
    print(f"catálogo do amora: {len(fotos)} fotos + {len(videos)} vídeos já lá\n")

    originais = [c for c in cands if c.original and c.kind == "image"]
    exif = {}
    fase1 = []
    if originais:
        I.prewarm([c.caminho for c in originais])
        exif = I.le_exif([c.caminho for c in originais])
        for it in originais:
            meta = exif.get(str(it.caminho), {})
            if I.gps_valido(meta.get("GPSLatitude"), meta.get("GPSLongitude")):
                fase1.append(it)             # tem GPS: é da fase 1, não daqui
            elif I.data_xsd(meta):
                it.data = I.data_xsd(meta)   # data de captura REAL, do EXIF
        cands = [c for c in cands if c not in fase1]
        if fase1:
            print(f"  {len(fase1)} originais COM GPS pulados (são da fase 1: ingest-drive.py)")

    dups, erros, prontos, sem_pessoa = [], [], [], []
    LOTE = 256                                  # pré-baixa em lotes (não o acervo inteiro de uma vez)
    for i, it in enumerate(cands, 1):
        if (i - 1) % LOTE == 0:
            I.prewarm([c.caminho for c in cands[i - 1:i - 1 + LOTE] if not c.original])
        conhecidos = fotos if it.kind == "image" else videos
        try:
            if it.kind == "image":
                img, icc = I._abre(it.caminho)
                it.hash = I.phash(img, icc)
            else:
                info = ffprobe(it.caminho)
                it.duracao = float(info.get("format", {}).get("duration") or 0)
                it.hash = vhash(it.caminho, it.duracao)
        except Exception as e:              # noqa: BLE001
            erros.append((it, f"hash: {e}"))
            continue
        antigo = I.ja_existe(it.hash, conhecidos)
        if antigo:
            dups.append((it, antigo))
            continue
        if not it.pessoa_slug:
            sem_pessoa.append(it)

        rot = (f"{'pas:' + it.tour_slug if it.tour_slug else '(sem passeio)'} "
               f"{'pes:' + it.pessoa_slug if it.pessoa_slug else '(' + (it.slug_bruto or 'sem slug') + ')'}")
        if a.apply:
            try:
                if it.kind == "image":
                    it.variantes = I.monta_variantes(it.caminho, img, icc)
                    ok, msg = envia(servidor, "/upload-image",
                                    {"ttl": monta_ttl_imagem(it)}, it.variantes)
                else:
                    it.variantes, it.duracao = transcoda_video(it.caminho, info)
                    ok, msg = envia(servidor, "/upload-video",
                                    {"ttl": monta_ttl_video(it), "id": it.hash}, it.variantes)
            except subprocess.CalledProcessError as e:
                ok, msg = False, f"ffmpeg: {(e.stderr or b'').decode(errors='replace')[:160]}"
            except Exception as e:          # noqa: BLE001
                ok, msg = False, f"variantes: {e}"
            if not ok:
                erros.append((it, msg))
                print(f"  [{i}/{len(cands)}] ✗ {it.caminho.name[:44]:46} {msg[:90]}")
                continue
            conhecidos.add(it.hash)
            print(f"  [{i}/{len(cands)}] ✓ {it.caminho.name[:44]:46} med:{it.hash} {rot}")
        else:
            conhecidos.add(it.hash)
            print(f"  [{i}/{len(cands)}] · {it.caminho.name[:44]:46} med:{it.hash} {rot}")
        prontos.append(it)

    print("\n" + "─" * 72)
    print(f"  candidatos ……………… {len(cands)}  ({n_img} imagens, {n_vid} vídeos)")
    print(f"  já no amora (dedup) … {len(dups)}")
    print(f"  {'ENVIADOS' if a.apply else 'a enviar (dry-run)'} …………… {len(prontos)}")
    if sem_pessoa:
        print(f"  sem pessoa mapeada …… {len(sem_pessoa)}  (entram só com schema:creditText)")
    if erros:
        print(f"  ERROS ………………… {len(erros)}")
        for it, msg in erros[:10]:
            print(f"      {it.caminho.name[:40]:42} {msg[:80]}")
    faltando = sorted({it.slug_bruto for it in sem_pessoa if it.slug_bruto})
    if faltando:
        print(f"\n  slugs sem pessoa: {', '.join(faltando[:15])}{'…' if len(faltando) > 15 else ''}")
        print("  → preencha 'pessoa' em scripts/whatsapp-slug-map.json; um patch posterior atribui")
    if not a.apply:
        print("\n(--dry-run é o default: nada foi enviado. Use --apply.)")


if __name__ == "__main__":
    main()
