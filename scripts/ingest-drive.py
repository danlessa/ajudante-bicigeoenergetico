#!/usr/bin/env python3
"""FASE 1 da ingestão do acervo: os ORIGINAIS, os que ainda têm EXIF.

O acervo da Biblioteca Hidrográfica tem ~8.174 arquivos, e eles NÃO são todos
a mesma coisa:

  · 7.658 vieram do WhatsApp. O zap remove TODO o EXIF — sem GPS, sem data de
    captura, sem câmera. Sem coordenada não há marcador no mapa, e é por isso
    que eles NÃO entram aqui: são a FASE 2 (galeria/álbum, georreferenciação
    manual ou por passeio). Reconhecidos pelo "WhatsApp Image/Video" no nome.
  · ~516 são ORIGINAIS (IMG_*.HEIC, AirDrop, cabo, cartão) e preservam o EXIF.
    Desses, 439 são imagens — o material desta fase.

Um original com GPS vira mídia de PRIMEIRA CLASSE no amora: marcador no mapa,
idêntico ao que sairia de um envio pelo web/upload_images.html. Este script é,
literalmente, aquele formulário rodando no terminal: mesmo pHash, mesmas três
variantes, mesmo TTL, mesmo POST /upload-image.

O nome do arquivo é só HEURÍSTICA; a PROVA é o EXIF. Todo candidato passa pelo
exiftool e quem não tiver GPS é pulado e reportado.

    ingest-drive.py                     # dry-run (default): não envia nada
    ingest-drive.py --apply             # envia pra valer
    ingest-drive.py --limit 5 --apply   # sobe 5, pra sentir o gosto
    ingest-drive.py --pasta "Água Preta"  # só uma pasta do acervo

┌─ BAIXA BYTES DO DRIVE ──────────────────────────────────────────────────────┐
│ Os arquivos do acervo são STUBS do Google Drive: abrir um força o download.  │
│ Ler o EXIF e calcular o pHash exige os bytes, então mesmo o --dry-run BAIXA. │
│ Hoje são 439 imagens originais ≈ 1,4 GiB. (O acervo inteiro tem 13 GiB — o   │
│ que este script NÃO toca: as 7.658 do zap ficam pra fase 2.) O número exato  │
│ é medido e mostrado antes de qualquer coisa. O acervo é SOMENTE-LEITURA:     │
│ nada é escrito, movido ou apagado lá.                                        │
└─────────────────────────────────────────────────────────────────────────────┘

A varredura do acervo, o casamento pasta→passeio e o mapa slug→pessoa NÃO são
reimplementados aqui: vêm do scripts/audit-captura.py, que é o motor da
auditoria e a fonte única dessas três coisas.
"""
from __future__ import annotations

import argparse
import importlib.util
import io
import json
import math
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

try:
    import numpy as np
except ImportError:
    sys.exit("falta numpy: pip install numpy")
try:
    from PIL import Image, ImageCms, ImageOps
except ImportError:
    sys.exit("falta Pillow: pip install Pillow")
try:
    import rdflib
except ImportError:
    sys.exit("falta rdflib: pip install rdflib")

# HEIC: o iPhone salva assim. Sem decoder, degrada — não explode (ver _abre).
try:
    import pillow_heif
    pillow_heif.register_heif_opener()
    TEM_HEIC = True
except ImportError:
    TEM_HEIC = False

REPO = Path(__file__).resolve().parents[1]
DATA = REPO / "web" / "data"

SERVIDOR_PADRAO = "https://amora.pedalhidrografi.co"
LICENCA_PADRAO = "https://creativecommons.org/licenses/by-sa/4.0/"

# Espelham web/upload_images.html — se mudarem lá, mudam aqui.
PHASH_DUP_THRESHOLD = 5              # distância de Hamming que já é "a mesma foto"
COMPRESS_TARGET_BYTES = 500 * 1024
DIM_LADDER = (2400, 1800, 1400, 1100, 900, 700, 500)
Q_LADDER = (0.85, 0.7, 0.55, 0.4, 0.3)
THUMB_DIM = 256
THUMB_Q = 0.75

MED_NS = "https://id.pedalhidrografi.co/midia/"
PH_NS = "https://id.pedalhidrografi.co/terms#"


def _importa_audit():
    """audit-captura.py é o motor: varredura do acervo, casamento pasta→passeio,
    mapa slug→pessoa. O nome tem hífen, então entra por importlib — e PRECISA
    ser registrado em sys.modules, senão os @dataclass dele não resolvem os
    tipos e o import estoura."""
    caminho = REPO / "scripts" / "audit-captura.py"
    spec = importlib.util.spec_from_file_location("audit_captura", caminho)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["audit_captura"] = mod
    spec.loader.exec_module(mod)
    return mod


A = _importa_audit()


# ═════════════════════════════════════════════════════════════════════════
# 1. pHash — o coração, e a única parte que NÃO pode errar
# ═════════════════════════════════════════════════════════════════════════
# O IRI da mídia é med:<phash16>. O phash é calculado HOJE pelo NAVEGADOR, em
# upload_images.html: canvas 32×32 → cinza → DCT 2D → bloco 8×8 → bit = coef >
# mediana. Se o phash do Python divergir do phash do JS, a mesma foto ganha dois
# IRIs e a dedup morre. Então isto aqui é uma PORTABILIDADE, não uma releitura.
#
# A DCT, o cinza, a mediana e a ordem dos bits são cópia literal do JS. O que dá
# trabalho é o passo ANTERIOR: como o navegador reduz 4032×3024 → 32×32 em
# `drawImage(bitmap, 0, 0, 32, 32)`. Foi medido contra 352 fotos que já estão em
# web/data/images.ttl (o nome da pasta web/photos/<hash>/ É o phash do navegador)
# e, decisivamente, contra o PRÓPRIO Chrome rodando o JS verbatim:
#
#   · média de área (PIL BOX/BILINEAR/LANCZOS) …… 1% de acerto. NÃO é isso.
#   · bilinear estilo GPU, sem pré-filtro ……… 69%
#   · + conversão ICC do perfil pra sRGB …… 96,6%  ← este
#
# São DOIS achados, e os dois são contraintuitivos:
#
#  (a) O canvas NÃO faz média de área. O Skia rasteriza canvas pequeno na CPU
#      com kLinear e SEM mipmap: para cada pixel de saída ele lê os 4 texels ao
#      redor do ponto amostrado e interpola. De 12 milhões de pixels, só ~4.096
#      são olhados; o resto é ignorado. Por isso NEAREST chega mais perto que
#      LANCZOS — o que parece bug e não é.
#  (b) Foto de iPhone é Display P3, e o navegador converte pra sRGB ao desenhar
#      no canvas. Sem converter, 28% das fotos mudam de hash.
#
# A conversão de cor é PONTUAL, então comuta com a coleta dos texels: converto
# os ~4.096 amostrados em vez dos 12 milhões. Mesmo resultado, ~1000× mais rápido.
#
# PARIDADE MEDIDA (352 fotos, contra o Chrome rodando o JS verbatim):
#   96,6% idênticas bit a bit; as outras 3,4% ficam a 1–2 bits (máximo 2).
#   NENHUMA passa de 2 — bem dentro do PHASH_DUP_THRESHOLD=5 que o próprio
#   formulário usa pra recusar re-envio. Ou seja: o resíduo NÃO duplica.
#   O resto é ruído do decodificador JPEG (libjpeg-turbo do Chrome vs o do
#   Pillow diverge ±1 em pixels isolados) — e como a amostragem lê pixels
#   isolados, esse ±1 às vezes vira 1 bit. Irredutível sem embutir o Chrome.
#
# E o aviso que importa pra quem for "melhorar" isto: recalcular o phash dos
# blobs de web/photos/ e comparar com o IRI dá no MÁXIMO ~78%, e isso NÃO é
# defeito do port — o próprio Chrome, rodando o próprio JS, só reproduz 76%
# daqueles hashes. Os outros 24% foram gerados noutros aparelhos/navegadores
# (a rasterização por GPU dá hash diferente da por CPU). O critério de aceite é
# contra o NAVEGADOR, não contra o histórico.

N = 32
_k = np.arange(N)[:, None]
_n = np.arange(N)[None, :]
_COS = np.cos((2 * _n + 1) * np.pi * _k / (2 * N))   # DCT-II NÃO normalizada, como o dct1d() do JS

_v = np.arange(256) / 255.0
_EOTF = np.where(_v <= 0.04045, _v / 12.92, ((_v + 0.055) / 1.055) ** 2.4)

_XYZ_TO_SRGB = np.array([                 # XYZ(D65) → sRGB linear
    [3.2404542, -1.5371385, -0.4985314],
    [-0.9692660, 1.8760108, 0.0415560],
    [0.0556434, -0.2040259, 1.0572252],
])
_BRADFORD_D50_D65 = np.array([            # perfil ICC guarda colorant em D50
    [0.9555766, -0.0230393, 0.0631636],
    [-0.0282895, 1.0099416, 0.0210077],
    [0.0122982, -0.0204830, 1.3299098],
])


def _oetf(v):
    v = np.clip(v, 0.0, 1.0)
    return np.where(v <= 0.0031308, v * 12.92, 1.055 * v ** (1 / 2.4) - 0.055) * 255.0


def _matriz_gamut(icc_bytes: bytes):
    """RGB(perfil) linear → RGB(sRGB) linear, derivada do PRÓPRIO perfil.

    Tirada dos colorants do ICC em vez de cravada pro Display P3: assim um
    perfil sRGB vira identidade sozinho (e devolve None, pra não pagar o
    arredondamento de um round-trip inútil) e um Adobe RGB também funciona."""
    try:
        prof = ImageCms.ImageCmsProfile(io.BytesIO(icc_bytes)).profile
        r, g, b = prof.red_colorant[0], prof.green_colorant[0], prof.blue_colorant[0]
    except Exception:                       # noqa: BLE001 — perfil ilegível: trata como sRGB
        return None
    rgb_to_xyz_d50 = np.array([[r[0], g[0], b[0]],
                               [r[1], g[1], b[1]],
                               [r[2], g[2], b[2]]])
    M = _XYZ_TO_SRGB @ _BRADFORD_D50_D65 @ rgb_to_xyz_d50
    if np.allclose(M, np.eye(3), atol=2e-3):
        return None
    return M


def phash(img: Image.Image, icc: bytes | None) -> str:
    """pHash de 64 bits (16 hex) — o MESMO que o navegador calcularia."""
    M = _matriz_gamut(icc) if icc else None
    arr = np.asarray(img)
    h, w = arr.shape[:2]
    # Amostragem bilinear do canvas: centro do pixel de saída, 4 texels vizinhos.
    u = (np.arange(N) + 0.5) * (w / N) - 0.5
    v = (np.arange(N) + 0.5) * (h / N) - 0.5
    x0 = np.floor(u).astype(int)
    y0 = np.floor(v).astype(int)
    fx = (u - x0)[None, :, None]
    fy = (v - y0)[:, None, None]
    xa, xb = np.clip(x0, 0, w - 1), np.clip(x0 + 1, 0, w - 1)
    ya, yb = np.clip(y0, 0, h - 1), np.clip(y0 + 1, 0, h - 1)
    q = [arr[np.ix_(yy, xx)] for yy in (ya, yb) for xx in (xa, xb)]
    if M is not None:
        q = [np.rint(_oetf(_EOTF[t] @ M.T)) for t in q]   # pontual → comuta com a coleta
    else:
        q = [t.astype(np.float64) for t in q]
    top = q[0] * (1 - fx) + q[1] * fx
    bot = q[2] * (1 - fx) + q[3] * fx
    px = top * (1 - fy) + bot * fy

    g = px[:, :, 0] * 0.299 + px[:, :, 1] * 0.587 + px[:, :, 2] * 0.114
    tmp = (g.astype(np.float64) @ _COS.T).astype(np.float32)     # linhas
    dct = (_COS @ tmp.astype(np.float64)).astype(np.float32)     # colunas
    blk = dct[:8, :8].reshape(64)
    mediana = np.sort(blk[1:])[31]        # exclui o DC, como o JS (floor(63/2))
    return "".join(
        f"{sum((1 if blk[r * 8 + c] > mediana else 0) << (7 - c) for c in range(8)):02x}"
        for r in range(8)
    )


def gps_valido(lat, lon) -> bool:
    try:
        la, lo = float(lat), float(lon)
    except (TypeError, ValueError):
        return False
    if math.isnan(la) or math.isnan(lo):
        return False
    if abs(la) > 90 or abs(lo) > 180:
        return False
    return not (abs(la) < 1e-6 and abs(lo) < 1e-6)


def hamming(a: str, b: str) -> int:
    return bin(int(a, 16) ^ int(b, 16)).count("1")


def para_srgb(img: Image.Image, icc: bytes | None) -> Image.Image:
    """Pixels convertidos pro sRGB — é o que o canvas do navegador entrega
    a compressToTarget()/makeThumbnail() no form. Sem isto, large/thumb
    saíam com os pixels Display P3 crus e SEM perfil (achado nº 2 da revisão):
    cores lavadas em ~90% das fotos de iPhone. O pHash NÃO usa isto — ele
    converte só os texels amostrados (ver phash())."""
    if not icc or _matriz_gamut(icc) is None:
        return img
    try:
        origem = ImageCms.ImageCmsProfile(io.BytesIO(icc))
        return ImageCms.profileToProfile(img, origem, ImageCms.createProfile("sRGB"),
                                         outputMode="RGB")
    except Exception:                       # noqa: BLE001 — perfil ilegível: segue cru
        return img


def _abre(caminho: Path) -> tuple[Image.Image, bytes | None]:
    """Decodifica pro estado em que o navegador vê a foto: EXIF Orientation já
    aplicada (é o que `createImageBitmap(..., {imageOrientation:'from-image'})`
    faz) e RGB. Devolve também o ICC cru, que o pHash precisa."""
    im = Image.open(caminho)
    icc = im.info.get("icc_profile")
    return ImageOps.exif_transpose(im).convert("RGB"), icc


# ═════════════════════════════════════════════════════════════════════════
# 2. EXIF — a prova de que o arquivo é original mesmo
# ═════════════════════════════════════════════════════════════════════════

CAMPOS_EXIF = [
    "-GPSLatitude", "-GPSLongitude", "-GPSImgDirection",
    "-FocalLengthIn35mmFormat", "-DateTimeOriginal", "-OffsetTimeOriginal",
    "-CreateDate",
]


def prewarm(caminhos: list[Path], workers: int = 32, rotulo: str = "materializando") -> None:
    """Força o Drive a baixar os stubs EM PARALELO antes do processamento.

    Lidos um a um (é o que o exiftool/Pillow fazem), os stubs do Drive for
    Desktop materializam a ~250 KB/s — latência por arquivo, não banda: 16
    leituras simultâneas medem ~1,1 MB/s, e 32 escalam mais. Só lê e descarta;
    o Drive guarda o arquivo no cache local e o passo seguinte lê do disco."""
    import time
    from concurrent.futures import ThreadPoolExecutor, as_completed
    if not caminhos:
        return
    total, feito, lidos, t0 = len(caminhos), 0, 0, time.monotonic()

    def _le(c: Path) -> int:
        n = 0
        try:
            with open(c, "rb") as fh:
                while True:
                    b = fh.read(1 << 20)
                    if not b:
                        break
                    n += len(b)
        except OSError:
            pass
        return n

    with ThreadPoolExecutor(max_workers=workers) as ex:
        for f in as_completed([ex.submit(_le, c) for c in caminhos]):
            feito += 1
            lidos += f.result()
            if feito % 50 == 0 or feito == total:
                dt = max(time.monotonic() - t0, 1e-6)
                print(f"  {rotulo}: {feito}/{total} ({lidos / 1048576:.0f} MB, "
                      f"{lidos / 1024 / dt:.0f} KB/s)", flush=True)


def le_exif(caminhos: list[Path]) -> dict[str, dict]:
    """Uma chamada só do exiftool pro lote inteiro (a lista vai por -@ pra não
    estourar o ARG_MAX). ATENÇÃO: é AQUI que o Drive materializa os arquivos."""
    if not caminhos:
        return {}
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as fh:
        fh.write("\n".join(str(c) for c in caminhos))
        arglist = fh.name
    try:
        out = subprocess.run(
            ["exiftool", "-n", "-json", *CAMPOS_EXIF, "-@", arglist],
            capture_output=True, text=True, check=False,
        )
        if not out.stdout.strip():
            return {}
        return {j["SourceFile"]: j for j in json.loads(out.stdout)}
    except FileNotFoundError:
        sys.exit("falta exiftool: brew install exiftool")
    except json.JSONDecodeError:
        return {}
    finally:
        os.unlink(arglist)


def data_xsd(meta: dict) -> str | None:
    """dcterms:date como o formulário emite: xsd:dateTime COM offset.

    DateTimeOriginal é a hora do disparo; OffsetTimeOriginal é o fuso. Sem o
    fuso (câmera velha), assume-se São Paulo — é onde os pedais acontecem."""
    bruta = meta.get("DateTimeOriginal") or meta.get("CreateDate")
    if not bruta:
        return None
    try:
        dt = datetime.strptime(str(bruta)[:19], "%Y:%m:%d %H:%M:%S")
    except ValueError:
        return None
    off = meta.get("OffsetTimeOriginal")
    if not off:
        off = datetime.now(A.TZ_SP).strftime("%z")
        off = f"{off[:3]}:{off[3:]}"
    return dt.strftime("%Y-%m-%dT%H:%M:%S") + str(off)


# ═════════════════════════════════════════════════════════════════════════
# 3. As três variantes — do jeitinho que o formulário faz
# ═════════════════════════════════════════════════════════════════════════
# original: os bytes CRUS do disco (o form só re-encoda se marcarem
#           comprimir/anonimizar — aqui nunca marcamos, então preserva).
# large:    JPEG re-encodado até caber em 500 KiB, descendo dimensão e qualidade
#           na mesma escada do form, com o EXIF copiado de volta.
# thumb:    JPEG de 256 px.

EXT_ORIGINAL_OK = {"jpg", "png", "heic", "heif"}
MIME_ORIGINAL = {"jpg": "image/jpeg", "png": "image/png",
                 "heic": "image/heic", "heif": "image/heif"}


def ext_original(caminho: Path) -> str:
    return {"jpeg": "jpg"}.get(
        caminho.suffix.lstrip(".").lower(), caminho.suffix.lstrip(".").lower())


def formato_original(caminho: Path) -> tuple[str, str]:
    """Espelha originalFormat() do form + o whitelist do backend.

    Só é chamado pra extensão JÁ validada (ver EXT_ORIGINAL_OK no laço): o form
    manda qualquer extensão desconhecida como `original.jpg` mas envia os bytes
    CRUS — um .tif viraria um "jpg" que não é jpg. Aqui a gente prefere pular e
    reportar a subir um blob com a extensão mentindo sobre o conteúdo."""
    raw = ext_original(caminho)
    return raw, MIME_ORIGINAL[raw]


def _encode_jpeg(img: Image.Image, dim: int, q: float) -> bytes:
    w, h = img.size
    escala = min(1.0, dim / max(w, h))
    novo = (max(1, round(w * escala)), max(1, round(h * escala)))
    buf = io.BytesIO()
    img.resize(novo, Image.LANCZOS).save(buf, "JPEG", quality=int(q * 100))
    return buf.getvalue()


def comprime(img: Image.Image, alvo: int = COMPRESS_TARGET_BYTES) -> bytes:
    for dim in DIM_LADDER:
        for q in Q_LADDER:
            b = _encode_jpeg(img, dim, q)
            if len(b) <= alvo:
                return b
    return _encode_jpeg(img, 500, 0.3)


def _copia_exif(origem: Path, jpeg: bytes) -> bytes:
    """Copia o EXIF do original pro JPEG re-encodado, NORMALIZANDO a Orientation
    pra 1 — os pixels já saíram rotacionados do exif_transpose, e manter a tag
    original faria o navegador girar de novo. Mesma lógica do copyExifSegment()
    + normalizeExifOrientation() do form. Best-effort: se falhar, vai sem EXIF."""
    tmp = None
    try:
        with tempfile.NamedTemporaryFile("wb", suffix=".jpg", delete=False) as fh:
            fh.write(jpeg)
            tmp = fh.name
        subprocess.run(
            # --ICC_Profile:all: os pixels já foram convertidos pra sRGB
            # (para_srgb); copiar o perfil P3 de volta desfaria a conversão.
            # O form também não copia ICC (só o segmento EXIF APP1).
            ["exiftool", "-q", "-overwrite_original", "-TagsFromFile", str(origem),
             "-all:all", "--ICC_Profile:all", "-Orientation=1", "-n", tmp],
            capture_output=True, check=False,
        )
        return Path(tmp).read_bytes()
    except Exception:                       # noqa: BLE001
        return jpeg
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass


def monta_variantes(caminho: Path, img: Image.Image, icc: bytes | None) -> dict[str, tuple[str, bytes]]:
    """`img` é o decodificado cru (o que o pHash usa); large/thumb saem do
    convertido pra sRGB."""
    ext, _ = formato_original(caminho)
    srgb = para_srgb(img, icc)
    return {
        "original": (f"original.{ext}", caminho.read_bytes()),
        "large": ("large.jpg", _copia_exif(caminho, comprime(srgb))),
        "thumb": ("thumb.jpg", _encode_jpeg(srgb, THUMB_DIM, THUMB_Q)),
    }


# ═════════════════════════════════════════════════════════════════════════
# 4. O TTL — contrato do POST /upload-image
# ═════════════════════════════════════════════════════════════════════════

PREFIXOS = """@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix exif:    <http://www.w3.org/2003/12/exif/ns#> .
@prefix nfo:     <http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#> .
@prefix ph:      <https://id.pedalhidrografi.co/terms#> .
@prefix pes:     <https://id.pedalhidrografi.co/pessoas/> .
@prefix pas:     <https://id.pedalhidrografi.co/passeio/> .
@prefix med:     <https://id.pedalhidrografi.co/midia/> .
@prefix prov:    <http://www.w3.org/ns/prov#> .
@prefix schema:  <https://schema.org/> .
@prefix xsd:     <http://www.w3.org/2001/XMLSchema#> .
"""


def _dec(v) -> str:
    """Decimal em Turtle: sem notação científica e sempre com ponto."""
    f = float(v)
    return str(int(f)) if f.is_integer() else repr(f)


def monta_ttl(item: "Item") -> str:
    """Espelha buildImageBlock()/buildSingleImageTtl() do form. Os nós aninhados
    são IRIs DERIVADAS (<id>_hash, <id>_geo), nunca bnodes: é isso que deixa a
    purga do backend ser aritmética de prefixo."""
    ident = f"med:{item.phash}"
    props = [
        # Tem GPS por construção (é o critério de entrada) → sempre georreferenciada.
        "a ph:StillImage, ph:GeoreferencedImage",
        f"nfo:hasHash {ident}_hash",
        f"dcterms:license <{LICENCA_PADRAO}>",
    ]
    if item.data:
        props.append(f'dcterms:date "{item.data}"^^xsd:dateTime')
    props.append(f"schema:locationCreated {ident}_geo")
    if item.bearing is not None:
        props.append(f'exif:gpsImgDirection "{_dec(item.bearing)}"^^xsd:decimal')
    if item.focal is not None:
        props.append(f'exif:focalLengthIn35mmFilm "{_dec(item.focal)}"^^xsd:decimal')
    if item.tour_slug:
        props.append(f"ph:capturedDuring pas:{item.tour_slug}")
    if item.pessoa_slug:
        props.append(f"prov:wasAttributedTo pes:{item.pessoa_slug}")
    _, mime = formato_original(item.caminho)
    if mime != "image/jpeg":
        props.append(f'schema:encodingFormat "{mime}"')

    corpo = " ;\n".join(f"    {p}" for p in props)
    derivados = (
        f"{ident}_hash a nfo:FileHash ;\n"
        f'    nfo:hashAlgorithm "pHash" ;\n'
        f'    nfo:hashValue "{item.phash}" .\n\n'
        f"{ident}_geo a schema:GeoCoordinates ;\n"
        f'    schema:latitude "{item.lat:.6f}"^^xsd:decimal ;\n'
        f'    schema:longitude "{item.lon:.6f}"^^xsd:decimal .'
    )
    return f"{PREFIXOS}\n{ident}\n{corpo} .\n\n{derivados}\n"


def _multipart(campos: dict[str, str],
               arquivos: dict[str, tuple[str, bytes]]) -> tuple[bytes, dict]:
    """Mesmo espírito do _multipart do audit-captura, mas com partes binárias."""
    bnd = "----phidroingest" + os.urandom(8).hex()
    corpo = bytearray()
    for k, v in campos.items():
        corpo += (f"--{bnd}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n"
                  f"{v}\r\n").encode("utf-8")
    for k, (nome, dados) in arquivos.items():
        corpo += (f"--{bnd}\r\nContent-Disposition: form-data; name=\"{k}\"; "
                  f"filename=\"{nome}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
                  ).encode("utf-8")
        corpo += dados + b"\r\n"
    corpo += f"--{bnd}--\r\n".encode("utf-8")
    return bytes(corpo), {"Content-Type": f"multipart/form-data; boundary={bnd}"}


def envia(item: "Item", servidor: str) -> tuple[bool, str]:
    ttl = monta_ttl(item)
    body, headers = _multipart({"ttl": ttl}, item.variantes)
    headers["User-Agent"] = A.USER_AGENT
    req = urllib.request.Request(f"{servidor}/upload-image", data=body,
                                 headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=300, context=A._contexto_ssl()) as r:
            j = json.loads(r.read().decode("utf-8"))
            return True, f"phash={j.get('phash')} files={','.join(j.get('files', []))}"
    except urllib.error.HTTPError as e:
        detalhe = e.read().decode("utf-8", errors="replace")[:300]
        return False, f"HTTP {e.code}: {detalhe}"
    except Exception as e:                  # noqa: BLE001
        return False, str(e)


# ═════════════════════════════════════════════════════════════════════════
# 5. O catálogo que já existe (pra não subir o que já está lá)
# ═════════════════════════════════════════════════════════════════════════

def hashes_no_servidor(servidor: str) -> dict[str, set[str]]:
    """Os hashes que o amora já tem, POR CLASSE ('StillImage' / 'MotionImage').
    A dedup por Hamming só compara foto com foto (o form mantém os dois
    conjuntos separados — achado nº 4); a colisão exata foto×vídeo é o backend
    quem recusa (409). Busca no SERVIDOR (é ele o dono do catálogo); se não
    der, cai no images.ttl local e avisa."""
    g = rdflib.Graph()
    try:
        req = urllib.request.Request(f"{servidor}/data/images.ttl",
                                     headers={"User-Agent": A.USER_AGENT})
        with urllib.request.urlopen(req, timeout=60, context=A._contexto_ssl()) as r:
            g.parse(data=r.read().decode("utf-8"), format="turtle")
    except Exception as e:                  # noqa: BLE001
        print(f"  ⚠ não li o catálogo do servidor ({e}); usando o images.ttl local")
        g.parse(DATA / "images.ttl", format="turtle")
    hs = {"StillImage": set(), "MotionImage": set()}
    for classe in hs:
        for s in g.subjects(rdflib.RDF.type, rdflib.URIRef(PH_NS + classe)):
            s = str(s)
            if s.startswith(MED_NS):
                # Links antigos ainda carregam o discriminador image_/video_.
                h = s[len(MED_NS):].removeprefix("image_").removeprefix("video_")
                if len(h) == 16:
                    hs[classe].add(h.lower())
    return hs


def ja_existe(ph: str, conhecidos) -> str | None:
    """Dedup pela distância de Hamming, NÃO por igualdade: é a MESMA regra que o
    formulário aplica (PHASH_DUP_THRESHOLD). E é o que torna o resíduo de 3,4%
    de divergência do pHash inofensivo — 2 bits de folga cabem sobrando em 5."""
    for h in conhecidos:
        if hamming(ph, h) <= PHASH_DUP_THRESHOLD:
            return h
    return None


# ═════════════════════════════════════════════════════════════════════════
# 6. O laço
# ═════════════════════════════════════════════════════════════════════════

@dataclass
class Item:
    caminho: Path
    pasta: str
    phash: str = ""
    lat: float = 0.0
    lon: float = 0.0
    data: str | None = None
    bearing: float | None = None
    focal: float | None = None
    tour_slug: str | None = None
    slug_bruto: str | None = None    # o apelido cru do acervo (pode não ter pessoa)
    pessoa_slug: str | None = None
    variantes: dict = None


def mapa_pessoas() -> dict[str, str]:
    """slug do acervo → IRI da pessoa, do whatsapp-slug-map.json (gerado pelo
    audit-captura --slug-map e revisado a mão). Só entram os já resolvidos: slug
    sem pessoa ingere assim mesmo, sem prov:wasAttributedTo."""
    f = REPO / "scripts" / "whatsapp-slug-map.json"
    if not f.exists():
        return {}
    d = json.loads(f.read_text(encoding="utf-8"))
    out = {}
    for grupo in ("resolvidos", "pendentes"):
        for slug, v in d.get(grupo, {}).items():
            if v.get("pessoa"):
                out[A.norm(slug)] = str(v["pessoa"]).rsplit("/", 1)[-1]
    return out


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--acervo", default=os.environ.get("BIBLIOTECA_DIR", A.ACERVO_PADRAO),
                    help="raiz da Biblioteca Hidrográfica (SOMENTE LEITURA)")
    ap.add_argument("--servidor", default=os.environ.get("PHIDRO_SERVER", SERVIDOR_PADRAO))
    ap.add_argument("--apply", action="store_true",
                    help="envia pra valer (sem isto é dry-run: não sai nada da máquina)")
    ap.add_argument("--limit", type=int, help="processa no máximo N imagens")
    ap.add_argument("--pasta", help="só as pastas do acervo cujo nome contém isto")
    a = ap.parse_args()

    servidor = a.servidor.rstrip("/")
    print("═" * 72)
    print("  INGESTÃO DO ACERVO — FASE 1 (originais com EXIF/GPS)")
    print("═" * 72)

    pastas = A.ler_acervo(Path(a.acervo), quieto=True)
    passeios, g = A.carregar_catalogos()
    A.casar(passeios, pastas)
    por_pasta = {p.pasta.nome: p for p in passeios if p.pasta}
    pessoas = mapa_pessoas()

    # Candidatos: originais QUE SÃO IMAGEM. Vídeo original fica pra depois; o
    # /upload-video tem outro contrato (vhash, trim, transcode).
    cands: list[Item] = []
    for pa in pastas:
        if a.pasta and a.pasta.lower() not in pa.nome.lower():
            continue
        for caminho, slug in pa.originais_paths:
            if caminho.suffix.lower() in A.IMAGE_EXT:
                it = Item(caminho=caminho, pasta=pa.nome)
                # O slug já vem da varredura (audit-captura decide se é da
                # subpasta ou do prefixo do nome) — não redescobrir aqui.
                # Originais fora de subpasta vêm como "dandanlessa DSC09460.JPG":
                # o RE_SLUG_WA (que exige "WhatsApp") não casa. Fallback SEGURO:
                # o 1º token só vale como slug se já resolve pra uma pessoa.
                if not slug:
                    primeiro = caminho.name.split(" ", 1)[0]
                    if " " in caminho.name and A.norm(primeiro) in pessoas:
                        slug = primeiro
                it.slug_bruto = slug
                it.pessoa_slug = pessoas.get(A.norm(slug)) if slug else None
                p = por_pasta.get(pa.nome)
                it.tour_slug = p.slug if p else None
                cands.append(it)
    if a.limit:
        cands = cands[:a.limit]

    if not cands:
        sys.exit("nenhuma imagem original encontrada com esses filtros.")

    total_b = sum(c.caminho.stat().st_size for c in cands)   # stat NÃO baixa
    print(f"\n{len(cands)} imagens originais em {len({c.pasta for c in cands})} pastas")
    print(f"BAIXANDO ~{total_b / 1024**3:.2f} GiB do Drive (os arquivos são stubs; "
          f"ler o EXIF materializa)\n")

    prewarm([c.caminho for c in cands])
    print("lendo EXIF…", flush=True)
    exif = le_exif([c.caminho for c in cands])

    por_classe = hashes_no_servidor(servidor)
    conhecidos = por_classe["StillImage"]
    print(f"catálogo do amora: {len(conhecidos)} fotos + {len(por_classe['MotionImage'])} vídeos já lá\n")

    sem_gps, gps_invalido, sem_pessoa, sem_tour, dups, erros, prontos = [], [], [], [], [], [], []
    com_gps = 0
    for i, it in enumerate(cands, 1):
        meta = exif.get(str(it.caminho), {})
        lat, lon = meta.get("GPSLatitude"), meta.get("GPSLongitude")
        if lat is None or lon is None:
            sem_gps.append(it)
            continue
        # Achado nº 1: câmera que grava a tag GPS sem ter fix escreve
        # exatamente 0,0 (Ilha Nula, Golfo da Guiné) — e a checagem acima só
        # pegava ausência. Fora de faixa / NaN entram no mesmo balaio.
        if not gps_valido(lat, lon):
            gps_invalido.append(it)
            continue
        com_gps += 1
        ext = ext_original(it.caminho)
        if ext not in EXT_ORIGINAL_OK:
            # O backend só aceita jpg/png/heic/heif como `original`; qualquer
            # outra coisa iria pro bucket com a extensão errada. Ver formato_original.
            erros.append((it, f"formato não suportado no original: .{ext}"))
            continue
        if ext in ("heic", "heif") and not TEM_HEIC:
            erros.append((it, "HEIC sem decoder (pip install pillow-heif)"))
            continue
        try:
            img, icc = _abre(it.caminho)
            it.phash = phash(img, icc)
        except Exception as e:              # noqa: BLE001
            erros.append((it, f"decode: {e}"))
            continue

        it.lat, it.lon = float(lat), float(lon)
        it.data = data_xsd(meta)
        it.bearing = meta.get("GPSImgDirection")
        it.focal = meta.get("FocalLengthIn35mmFormat")

        antigo = ja_existe(it.phash, conhecidos)
        if antigo:
            dups.append((it, antigo))
            continue
        if not it.pessoa_slug:
            sem_pessoa.append(it)
        if not it.tour_slug:
            sem_tour.append(it)

        if a.apply:
            try:
                it.variantes = monta_variantes(it.caminho, img, icc)
            except Exception as e:          # noqa: BLE001
                erros.append((it, f"variantes: {e}"))
                continue
            ok, msg = envia(it, servidor)
            if not ok:
                erros.append((it, msg))
                continue
            conhecidos.add(it.phash)        # o próximo do lote já vê este
            print(f"  [{i}/{len(cands)}] ✓ {it.caminho.name[:44]:46} {msg}")
        else:
            conhecidos.add(it.phash)        # dedup DENTRO do lote também no dry-run
            print(f"  [{i}/{len(cands)}] · {it.caminho.name[:44]:46} med:{it.phash} "
                  f"{it.lat:.5f},{it.lon:.5f} "
                  f"{'pas:' + it.tour_slug if it.tour_slug else '(sem passeio)'} "
                  f"{'pes:' + it.pessoa_slug if it.pessoa_slug else '(sem autoria)'}")
        prontos.append(it)

    print("\n" + "─" * 72)
    print(f"  candidatas ……………… {len(cands)}")
    print(f"  COM GPS (ingeríveis) … {com_gps}")
    print(f"  sem GPS (puladas) …… {len(sem_gps)}")
    if gps_invalido:
        print(f"  GPS 0/0 ou inválido … {len(gps_invalido)}  (puladas — tag sem fix)")
    print(f"  já no amora (dedup) … {len(dups)}")
    print(f"  {'ENVIADAS' if a.apply else 'a enviar (dry-run)'} …………… {len(prontos)}")
    if sem_tour:
        print(f"  sem passeio casado …… {len(sem_tour)}  (entram sem ph:capturedDuring)")
    if sem_pessoa:
        print(f"  sem pessoa mapeada …… {len(sem_pessoa)}  (entram sem prov:wasAttributedTo)")
    if erros:
        print(f"  ERROS ………………… {len(erros)}")
        for it, msg in erros[:10]:
            print(f"      {it.caminho.name[:40]:42} {msg[:80]}")

    faltando = sorted({it.slug_bruto for it in sem_pessoa if it.slug_bruto})
    if faltando:
        print(f"\n  slugs sem pessoa: {', '.join(faltando[:12])}")
        print("  → preencha 'pessoa' em scripts/whatsapp-slug-map.json e rode de novo")

    if not a.apply:
        print("\n(--dry-run é o default: nada foi enviado. Use --apply.)")


if __name__ == "__main__":
    main()
