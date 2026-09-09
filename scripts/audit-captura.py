#!/usr/bin/env python3
"""Auditoria de captura de dados do Pedal Hidrográfico.

Responde uma pergunta só, e responde por passeio: **o que ainda falta
capturar deste pedal?** Cruza as três fontes que hoje vivem separadas:

  1. ANTES  — o chamado (narrativa, arte, rota, Instagram), em `tours.ttl`
  2. DEPOIS — o censo (comparecimento, saída/chegada, energia), em `tours.ttl`
  3. MÍDIA  — as fotos, que vivem em DOIS lugares:
       · o amora (`images.ttl`) — o tier alto, geolocalizado
       · a Biblioteca Hidrográfica no Drive — o que o pessoal mandou no
         zap. O amora NÃO enxerga essa pasta; é por isso que existe o
         "passe de coleta" (ph:MediaSweep), o marcador que traz esse fato
         pra dentro do catálogo.

O passe é a peça que faltava. Sem ele, um passeio sem foto é ambíguo:
ninguém compartilhou nada, ou ninguém foi buscar? Com ele:

    nó ausente               → o passe NUNCA foi feito ("não consta")
    nó com count = 0         → foi feito, e ninguém compartilhou nada
    nó com count = N         → foi feito, N arquivos arquivados

Modos:

    audit-captura.py                    # relatório no terminal
    audit-captura.py --markdown F       # tabela completa em markdown
    audit-captura.py --json F           # dados crus
    audit-captura.py --slug-map         # mapa slug→pessoa p/ revisão humana
    audit-captura.py --sync             # grava os passes que faltam no catálogo
    audit-captura.py --sync --dry-run   # mostra o que gravaria

O `--sync` NUNCA escreve arquivo: ele faz `POST /upload-tour` com
`mode=patch` contra o backend, que é o único escritor legítimo dos
catálogos. Patch preserva todos os predicados que o script não conhece.

O acervo do Drive é lido em MODO ESTRITAMENTE SOMENTE-LEITURA, e apenas
os METADADOS (nome, tamanho, mtime) — nunca o conteúdo. Isso importa: os
arquivos do Google Drive são stubs não materializados, e abrir um força o
download. Ler os 8 mil puxaria ~12 GiB pela rede.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

try:
    import rdflib
except ImportError:
    sys.exit("falta rdflib: pip install rdflib")

REPO = Path(__file__).resolve().parents[1]
DATA = REPO / "web" / "data"

PH      = rdflib.Namespace("https://id.pedalhidrografi.co/terms#")
PAS     = rdflib.Namespace("https://id.pedalhidrografi.co/passeio/")
PES     = rdflib.Namespace("https://id.pedalhidrografi.co/pessoas/")
SCHEMA  = rdflib.Namespace("https://schema.org/")
DCTERMS = rdflib.Namespace("http://purl.org/dc/terms/")
PROV    = rdflib.Namespace("http://www.w3.org/ns/prov#")
RDFS    = rdflib.RDFS

# Raiz do acervo. Sobrescreva com --acervo ou BIBLIOTECA_DIR — o caminho
# abaixo é o do Drive do Danilo e não vale pra mais ninguém.
ACERVO_PADRAO = (
    "/Users/danlessa/Library/CloudStorage/GoogleDrive-danilo.lessa@gmail.com/"
    "My Drive/Biblioteca Hidrográfica/1 - Passeios e Eventos"
)

SERVIDOR_PADRAO = "https://amora.pedalhidrografi.co"
USER_AGENT = "phidro-audit-captura/1.0 (+https://github.com/pedalhidro/amora)"

TZ_SP = timezone(timedelta(hours=-3))

VIDEO_EXT = {".mp4", ".mov", ".m4v", ".avi", ".webm", ".3gp", ".mkv"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".gif", ".tif", ".tiff"}
AUDIO_EXT = {".m4a", ".mp3", ".opus", ".ogg", ".wav", ".aac"}

# ── Os três funis ────────────────────────────────────────────────────────
# (chave, rótulo curto, predicado, onde se preenche)
FUNIL_ANTES = [
    ("descricao",  "narrativa", DCTERMS.description, "upload_tour"),
    ("arte",       "arte",      SCHEMA.image,        "upload_tour"),
    ("rota",       "rota",      PH.linkRoute,        "upload_tour"),
    ("instagram",  "insta",     PH.linkInstagram,    "upload_tour"),
]
FUNIL_DEPOIS = [
    ("participantes", "part",   PH.countAttendee,    "upload_tour"),
    ("iniciantes",    "inic",   PH.countNewcomer,    "upload_tour"),
    ("gravacao",      "gps",    PH.linkActivity,     "upload_tour"),
    ("saida",         "saída",  PH.departedAt,       "backfill"),
    ("chegada",       "cheg",   PH.arrivedAt,        "backfill"),
    ("movimento",     "mov",    PH.movingDuration,   "backfill"),
    ("energia_est",   "kJ est", PH.energyEstimate,   "backfill"),
    ("energia_med",   "kJ med", PH.measuredEnergy,   "backfill"),
]

HOST_LOCAL = re.compile(r"^(https?://(localhost|127\.0\.0\.1|0\.0\.0\.0)|file:)")


def norm(s: str) -> str:
    """Normaliza pra comparação: sem acento, minúsculo, sem pontuação solta."""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "", s.lower())


# ═════════════════════════════════════════════════════════════════════════
# 1. O acervo do Drive
# ═════════════════════════════════════════════════════════════════════════

# Nomes de pasta vistos no acervo, em ordem de especificidade:
#   "2025-09-09 54 Água Preta e Tiburtino"
#   "2026-06-16 PH 96 - Super fantástico: de bike até o balão mágico"
#   "2026-03-03 82"
#   "2025-03-29 SN Bicipassarinhada Raposo"
#   "2026-04-11 - Bicipassarinhar 4"
#   "2026-01-29 Oficina Hidro Cartografia Bordada SESC Consolação"
RE_PASTA = re.compile(
    r"^(?P<data>\d{4}-\d{2}-\d{2})"
    r"(?:\s+(?P<serie>PH|BP|BT|SESC|S)\b)?"
    r"(?:\s*-)?"
    r"(?:\s+(?P<num>\d+))?"
    r"(?:\s+(?P<sn>SN)\b)?"
    r"\s*-?\s*(?P<titulo>.*)$"
)

# "dandanlessa WhatsApp Image 2025-09-10 at 00.46.14.jpeg" → dandanlessa
RE_SLUG_WA = re.compile(r"^(?P<slug>.+?)\s+WhatsApp\s+(?:Image|Video|Audio|Ptt)\b", re.I)
RE_WA = re.compile(r"\bWhatsApp\s+(?:Image|Video|Audio|Ptt)\b", re.I)


@dataclass
class PastaAcervo:
    nome: str
    data: str | None
    serie: str | None
    num: int | None
    titulo: str
    arquivos: int = 0
    imagens: int = 0
    videos: int = 0
    do_whatsapp: int = 0          # EXIF stripado — nunca vira marcador no mapa
    originais: int = 0            # com EXIF — pode virar marcador
    # Os originais em si: (caminho, slug de quem compartilhou). Guardado só pra
    # quem PRECISA do arquivo — o ingest-drive.py, que sobe esses ao amora. A
    # varredura segue lendo apenas METADADOS; ninguém abre nada aqui.
    originais_paths: list[tuple[Path, str | None]] = field(default_factory=list)
    # Os do WhatsApp, idem — pro ingest-whatsapp.py (fase 2). Só metadados.
    whatsapp_paths: list[tuple[Path, str | None]] = field(default_factory=list)
    bytes_: int = 0
    contribuintes: Counter = field(default_factory=Counter)
    mtime_max: float = 0.0
    tem_midia_dir: bool = False
    arte_na_raiz: list[str] = field(default_factory=list)
    ignorados: list[str] = field(default_factory=list)   # mídia fora de pasta reconhecida

    @property
    def data_passe(self) -> str | None:
        """Quando o passe foi feito ≈ quando o último arquivo entrou na pasta.

        É a melhor evidência disponível: ninguém anotou a data do passe, mas
        o mtime do arquivo mais recente é literalmente quando o arquivamento
        aconteceu. Vale pros passes históricos; os novos carimbam a hora real.
        """
        if not self.mtime_max:
            return None
        return datetime.fromtimestamp(self.mtime_max, TZ_SP).replace(microsecond=0).isoformat()


# Ruído que aparece grudado no nome da subpasta e não faz parte do apelido:
# 'fotos pedrokozla' é o pedrokozla, 'Alef - registros' é o Alef.
RE_RUIDO_SUBPASTA = re.compile(
    r"^(fotos?|videos?|v[íi]deos?|m[íi]dias?|registros?|imagens?|arquivos?)\s+", re.I)


def _slug_do_arquivo(nome: str, subpasta: str | None) -> str | None:
    """Quem compartilhou. A subpasta manda: quando o arquivo está dentro de
    'flavio uemori/' ou 'Alef - registros/', o nome da pasta é a autoria e o
    nome do arquivo costuma vir sem prefixo."""
    if subpasta:
        s = subpasta.split(" - ")[0].strip()
        s = RE_RUIDO_SUBPASTA.sub("", s).strip()
        return s or None
    m = RE_SLUG_WA.match(nome)
    return m.group("slug").strip() if m else None


def ler_acervo(raiz: Path, quieto: bool = False) -> list[PastaAcervo]:
    """Varre o acervo lendo SÓ metadados (scandir + stat).

    Jamais abre um arquivo: no Google Drive eles são stubs, e ler o conteúdo
    dispararia o download dos ~12 GiB.
    """
    if not raiz.is_dir():
        raise SystemExit(f"acervo não encontrado: {raiz}\n"
                         f"passe --acervo PATH ou defina BIBLIOTECA_DIR.")
    pastas: list[PastaAcervo] = []
    for ent in sorted(os.scandir(raiz), key=lambda e: e.name):
        if not ent.is_dir() or ent.name.startswith("."):
            continue
        m = RE_PASTA.match(ent.name)
        if not m:
            if not quieto:
                print(f"  ⚠ pasta com nome fora do padrão, ignorada: {ent.name}", file=sys.stderr)
            continue
        p = PastaAcervo(
            nome=ent.name,
            data=m.group("data"),
            serie=m.group("serie"),
            num=int(m.group("num")) if m.group("num") else None,
            titulo=(m.group("titulo") or "").strip(),
        )
        # arquivos soltos na raiz da pasta = material do chamado (arte, gdoc)
        for f in os.scandir(ent.path):
            if f.is_file() and not f.name.startswith("."):
                if Path(f.name).suffix.lower() in IMAGE_EXT:
                    p.arte_na_raiz.append(f.name)

        # A pasta de mídia NÃO tem nome único no acervo: 'midia' (83),
        # 'midia zap' (4), 'midias' (3), 'Midia Danilo' (1), 'fotos' (1).
        # Fixar a string 'midia' perdia 9 passeios e ~430 arquivos calados.
        for sub in os.scandir(ent.path):
            if not sub.is_dir() or sub.name.startswith("."):
                continue
            n = norm(sub.name)
            if n.startswith("midia") or n in ("fotos", "videos", "video"):
                p.tem_midia_dir = True
                _varre_midia(Path(sub.path), p, subpasta=None)
            elif _tem_imagem(Path(sub.path)):
                # Não é pasta de mídia reconhecida, mas tem imagem dentro.
                # Melhor gritar do que descartar: o acervo é o dado.
                p.ignorados.append(sub.name)
        pastas.append(p)
    return pastas


def _tem_imagem(d: Path) -> bool:
    try:
        for f in os.scandir(d):
            if f.is_file() and Path(f.name).suffix.lower() in IMAGE_EXT | VIDEO_EXT:
                return True
    except OSError:
        pass
    return False


def _varre_midia(d: Path, p: PastaAcervo, subpasta: str | None) -> None:
    for f in os.scandir(d):
        if f.name.startswith("."):
            continue
        if f.is_dir():
            _varre_midia(Path(f.path), p, subpasta=f.name)
            continue
        if not f.is_file():
            continue
        ext = Path(f.name).suffix.lower()
        if ext not in IMAGE_EXT | VIDEO_EXT | AUDIO_EXT:
            continue
        st = f.stat()
        p.arquivos += 1
        p.bytes_ += st.st_size
        p.mtime_max = max(p.mtime_max, st.st_mtime)
        if ext in VIDEO_EXT:
            p.videos += 1
        elif ext in IMAGE_EXT:
            p.imagens += 1
        # O WhatsApp remove TODO o EXIF ao enviar: sem GPS, sem data de
        # captura, sem câmera. Esses arquivos podem virar mídia de galeria,
        # mas nunca marcador no mapa. Os originais (AirDrop, cabo, Drive
        # direto) preservam o EXIF e são o material de tier alto do acervo.
        slug = _slug_do_arquivo(f.name, subpasta)
        if RE_WA.search(f.name):
            p.do_whatsapp += 1
            p.whatsapp_paths.append((Path(f.path), slug))
        else:
            p.originais += 1
            p.originais_paths.append((Path(f.path), slug))
        if slug:
            p.contribuintes[slug] += 1


# ═════════════════════════════════════════════════════════════════════════
# 2. Os catálogos
# ═════════════════════════════════════════════════════════════════════════

@dataclass
class Passeio:
    iri: str
    slug: str
    titulo: str
    data: datetime
    serie: str | None
    seq: int | None
    campos: dict = field(default_factory=dict)     # chave → bool (preenchido?)
    arte_local: bool = False                       # schema:image aponta pra localhost
    midia_amora: int = 0
    passe_feito: bool = False
    passe_count: int | None = None
    passe_data: str | None = None
    pasta: PastaAcervo | None = None

    @property
    def edicao(self) -> str:
        if self.serie and self.seq is not None:
            return f"{self.serie}/{self.seq}"
        return "—"

    def faltas(self, funil) -> list[str]:
        return [rot for chave, rot, _, _ in funil if not self.campos.get(chave)]


def carregar_catalogos() -> tuple[list[Passeio], rdflib.Graph]:
    g = rdflib.Graph()
    for f in ("tours.ttl", "images.ttl", "identities.ttl"):
        g.parse(DATA / f, format="turtle")

    # mídia do amora por passeio
    midia = Counter()
    for m, t in g.subject_objects(PH.capturedDuring):
        midia[str(t)] += 1

    passeios: list[Passeio] = []
    for t in g.subjects(rdflib.RDF.type, PH.Tour):
        data = g.value(t, DCTERMS.date)
        if data is None:
            continue
        serie = seq = None
        ed = g.value(t, PH.inSeriesEdition)
        if ed is not None:
            s = g.value(ed, PH.inEventSeries)
            serie = str(s).rsplit("/", 1)[-1] if s else None
            q = g.value(ed, PH.sequenceInSeries)
            seq = int(q) if q is not None else None

        p = Passeio(
            iri=str(t),
            slug=str(t).rsplit("/", 1)[-1],
            titulo=str(g.value(t, DCTERMS.title) or "—"),
            data=data.toPython(),
            serie=serie,
            seq=seq,
            midia_amora=midia.get(str(t), 0),
        )
        for chave, _, pred, _ in FUNIL_ANTES + FUNIL_DEPOIS:
            p.campos[chave] = g.value(t, pred) is not None

        # Uma arte que aponta pra localhost não é uma arte: a IRI não resolve
        # pra ninguém fora da máquina de quem subiu. Conta como lacuna.
        img = g.value(t, SCHEMA.image)
        if img is not None and HOST_LOCAL.match(str(img)):
            p.arte_local = True
            p.campos["arte"] = False

        sweep = g.value(t, PH.mediaSweep)
        if sweep is not None:
            p.passe_feito = True
            c = g.value(sweep, PH.collectedFileCount)
            p.passe_count = int(c) if c is not None else None
            d = g.value(sweep, DCTERMS.date)
            p.passe_data = str(d)[:10] if d else None

        passeios.append(p)

    passeios.sort(key=lambda x: x.data, reverse=True)
    return passeios, g


def casar(passeios: list[Passeio], pastas: list[PastaAcervo]) -> tuple[list, list]:
    """Casa pasta do Drive ↔ passeio do catálogo.

    Por DATA (tolerância de ±1 dia — algumas pastas ficaram na véspera) e,
    quando a data é ambígua, desempata pelo número da edição. Casar SÓ pelo
    número é uma armadilha: os números se repetem no acervo (existe um "28
    Lavapés Aclimação 2" e um "35 Braço Morto do Tietê" que são eventos
    distintos dos PH/28 e PH/35 do catálogo).
    """
    por_data = defaultdict(list)
    for p in passeios:
        por_data[p.data.date().isoformat()].append(p)

    orfas: list[PastaAcervo] = []
    for pasta in pastas:
        if not pasta.data:
            orfas.append(pasta)
            continue
        cands: list[Passeio] = []
        base = datetime.fromisoformat(pasta.data).date()
        for delta in (0, -1, 1):
            d = (base + timedelta(days=delta)).isoformat()
            cands += [p for p in por_data.get(d, []) if p.pasta is None]
        if not cands:
            orfas.append(pasta)
            continue
        if len(cands) > 1 and pasta.num is not None:
            exatos = [c for c in cands if c.seq == pasta.num]
            if exatos:
                cands = exatos
        cands[0].pasta = pasta

    sem_pasta = [p for p in passeios if p.pasta is None]
    return orfas, sem_pasta


# ═════════════════════════════════════════════════════════════════════════
# 3. Slug → pessoa
# ═════════════════════════════════════════════════════════════════════════

def mapa_slugs(g: rdflib.Graph) -> dict[str, str]:
    """Handles conhecidos → IRI da pessoa.

    Reusa o que identities.ttl já modela: schema:alternateName (o handle) e
    rdfs:seeAlso do Instagram (o slug do zap costuma SER o do Instagram).
    Nada de predicado novo — a casa manda reusar antes de mintar.
    """
    conhecidos: dict[str, str] = {}
    for p in g.subjects(rdflib.RDF.type, SCHEMA.Person):
        for a in g.objects(p, SCHEMA.alternateName):
            conhecidos[norm(str(a))] = str(p)
        for s in g.objects(p, RDFS.seeAlso):
            u = str(s)
            if "instagram.com" in u:
                conhecidos.setdefault(norm(urlparse(u).path.strip("/")), str(p))
        for n in g.objects(p, SCHEMA.name):
            conhecidos.setdefault(norm(str(n)), str(p))
    return conhecidos


def emitir_mapa_slugs(pastas, g, destino: Path) -> None:
    conhecidos = mapa_slugs(g)
    total = Counter()
    for pa in pastas:
        total.update(pa.contribuintes)

    nomes = {}
    for p in g.subjects(rdflib.RDF.type, SCHEMA.Person):
        nomes[str(p)] = str(g.value(p, SCHEMA.name) or g.value(p, SCHEMA.alternateName) or "")

    resolvidos, pendentes = {}, {}
    for slug, n in total.most_common():
        iri = conhecidos.get(norm(slug))
        if iri:
            resolvidos[slug] = {"arquivos": n, "pessoa": iri, "nome": nomes.get(iri, "")}
        else:
            pendentes[slug] = {"arquivos": n, "pessoa": None, "nome": ""}

    # Agrupa quase-homônimos: 'fabiotarantes'/'fabioarantes' são a mesma
    # pessoa com um typo, e nenhum algoritmo deveria decidir isso sozinho.
    #
    # Nada de "um contém o outro": slugs de uma letra existem no acervo
    # ('r', 'b', 'n' — apelidos curtos de verdade, com arquivos de verdade) e
    # como substring casam com metade do mundo. Só três regras, todas
    # defensáveis: igualdade normalizada, typo de uma letra em nomes longos,
    # e PREFIXO (apelido quase sempre é prefixo: ana→anajucano).
    sugestoes = defaultdict(list)
    todos = list(total)
    for i, a in enumerate(todos):
        for b in todos[i + 1:]:
            na, nb = norm(a), norm(b)
            curto, longo = (na, nb) if len(na) <= len(nb) else (nb, na)
            if (na == nb
                    or (len(na) >= 5 and len(nb) >= 5 and _perto(na, nb))
                    or (len(curto) >= 3 and longo.startswith(curto))):
                sugestoes[a].append(b)

    destino.write_text(json.dumps({
        "_leia": (
            "Mapa slug do WhatsApp → pessoa. Os slugs vêm do prefixo dos arquivos "
            "arquivados na Biblioteca Hidrográfica. 'resolvidos' casaram sozinhos com "
            "identities.ttl (via schema:alternateName ou o Instagram em rdfs:seeAlso). "
            "'pendentes' precisam de você: preencha 'pessoa' com a IRI "
            "https://id.pedalhidrografi.co/pessoas/<slug8> de quem já existe, ou deixe "
            "null pra pessoa que ainda não foi cadastrada. 'possiveis_duplicatas' são "
            "palpites de que dois slugs são a MESMA pessoa — confira, não confie."
        ),
        "resolvidos": resolvidos,
        "pendentes": pendentes,
        "possiveis_duplicatas": {k: v for k, v in sugestoes.items() if v},
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"  {len(resolvidos)} slugs resolvidos ({sum(v['arquivos'] for v in resolvidos.values())} arquivos)")
    print(f"  {len(pendentes)} slugs pendentes  ({sum(v['arquivos'] for v in pendentes.values())} arquivos)")
    print(f"  {len(sugestoes)} possíveis duplicatas pra conferir")
    print(f"→ {destino}")


def _perto(a: str, b: str) -> bool:
    """Distância de edição ≤ 1 — pega typo de uma letra ('fabiotarantes'/'fabioarantes')."""
    if abs(len(a) - len(b)) > 1 or not a or not b:
        return False
    if len(a) > len(b):
        a, b = b, a
    i = j = dif = 0
    while i < len(a) and j < len(b):
        if a[i] != b[j]:
            dif += 1
            if dif > 1:
                return False
            if len(a) != len(b):
                j += 1
                continue
        i += 1
        j += 1
    return dif + (len(b) - j) <= 1


# ═════════════════════════════════════════════════════════════════════════
# 4. Gravar os passes no catálogo
# ═════════════════════════════════════════════════════════════════════════

TTL_PASSE = """@prefix ph: <https://id.pedalhidrografi.co/terms#> .
@prefix pas: <https://id.pedalhidrografi.co/passeio/> .
@prefix pes: <https://id.pedalhidrografi.co/pessoas/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

pas:{slug} a ph:Tour ;
    ph:mediaSweep pas:{slug}_sweep .

pas:{slug}_sweep a ph:MediaSweep ;
    dcterms:date "{data}"^^xsd:dateTime ;
    ph:archiveFolder {pasta} ;
{contribuintes}    prov:wasAssociatedWith <{quem}> ;
    ph:collectedFileCount {count} .
"""


def ttl_do_passe(p: Passeio, quem: str) -> str:
    """Monta o fragmento do passe. `ph:collectedFileCount` fica por ÚLTIMO de
    propósito: é o único predicado sempre presente, então é ele que fecha o
    TTL com `.` — assim nenhuma combinação de campos opcionais vazios pode
    gerar um Turtle sintaticamente quebrado."""
    pasta = p.pasta
    contrib = ""
    if pasta.contribuintes:
        linhas = ",\n        ".join(
            rdflib.Literal(s).n3() for s, _ in pasta.contribuintes.most_common())
        contrib = f"    ph:sweepContributor {linhas} ;\n"
    return TTL_PASSE.format(
        slug=p.slug,
        data=pasta.data_passe,
        count=pasta.arquivos,
        pasta=rdflib.Literal(pasta.nome).n3(),
        contribuintes=contrib,
        quem=quem,
    )


def _contexto_ssl():
    """Contexto TLS que funciona no Python do sistema (macOS).

    O Python de sistema não vem com o bundle de CAs, então um POST em https://
    morre com CERTIFICATE_VERIFY_FAILED. `certifi` resolve; sem ele, devolve
    None (contexto padrão) em vez de explodir.
    """
    try:
        import certifi
        import ssl
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return None


def sincronizar(passeios, servidor: str, quem: str | None, dry: bool) -> None:
    import urllib.request
    import urllib.error

    alvos = [p for p in passeios
             if p.pasta and p.pasta.arquivos > 0
             and (not p.passe_feito or p.passe_count != p.pasta.arquivos)]
    if not alvos:
        print("nada a sincronizar — todo passe já está registrado e com a contagem certa.")
        return

    novos = [p for p in alvos if not p.passe_feito]
    atualiza = [p for p in alvos if p.passe_feito]
    print(f"{len(novos)} passes novos, {len(atualiza)} com contagem desatualizada\n")

    ctx = _contexto_ssl()
    ok, falhas = 0, []
    for p in alvos:
        ttl = ttl_do_passe(p, quem)
        marca = "novo " if not p.passe_feito else f"{p.passe_count}→"
        print(f"  {marca:>5} {p.data.date()} {p.edicao:8} {p.pasta.arquivos:4} arq  "
              f"{len(p.pasta.contribuintes):2} pessoas  {p.titulo[:38]}")
        if dry:
            continue
        body, headers = _multipart({"ttl": ttl, "mode": "patch"})
        req = urllib.request.Request(f"{servidor}/upload-tour", data=body,
                                     headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=120, context=ctx) as r:
                if r.status == 200:
                    ok += 1
                else:
                    falhas.append((p, f"HTTP {r.status}"))
                    print(f"        ✗ HTTP {r.status}")
        except urllib.error.HTTPError as e:
            msg = f"HTTP {e.code}: {e.read().decode()[:160]}"
            falhas.append((p, msg))
            print(f"        ✗ {msg}")
        except Exception as e:  # noqa: BLE001
            falhas.append((p, str(e)))
            print(f"        ✗ {e}")

    if dry:
        print("\n(--dry-run: nada foi enviado)")
        return

    # Relatório honesto: um "✓" incondicional depois de N falhas é como não
    # ter relatório nenhum.
    print(f"\n{ok}/{len(alvos)} passes gravados via {servidor}/upload-tour (mode=patch)")
    if falhas:
        print(f"✗ {len(falhas)} FALHARAM:")
        for p, motivo in falhas[:10]:
            print(f"    {p.data.date()} {p.edicao:8} {motivo[:88]}")
        if len(falhas) > 10:
            print(f"    … e mais {len(falhas) - 10}")
        sys.exit(1)


def _multipart(campos: dict[str, str]) -> tuple[bytes, dict]:
    bnd = "----phidroaudit" + os.urandom(8).hex()
    partes = []
    for k, v in campos.items():
        partes.append(f"--{bnd}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n")
    partes.append(f"--{bnd}--\r\n")
    body = "".join(partes).encode("utf-8")
    return body, {
        "Content-Type": f"multipart/form-data; boundary={bnd}",
        # A Cloudflare que fronteia o amora responde 403 pro User-Agent padrão
        # do urllib (`Python-urllib/3.x`). Um UA próprio passa — e ainda diz
        # quem bateu na porta, o que é melhor pro log do que fingir ser curl.
        "User-Agent": USER_AGENT,
    }


# ═════════════════════════════════════════════════════════════════════════
# 5. Relatórios
# ═════════════════════════════════════════════════════════════════════════

def relatorio(passeios, pastas, orfas, sem_pasta, g) -> None:
    n = len(passeios)
    completos = [p for p in passeios
                 if not p.faltas(FUNIL_ANTES) and not p.faltas(FUNIL_DEPOIS)]
    sem_midia = [p for p in passeios if p.midia_amora == 0 and not p.passe_feito
                 and not (p.pasta and p.pasta.arquivos)]

    print("═" * 72)
    print(f"  AUDITORIA DE CAPTURA — {n} passeios no catálogo")
    print("═" * 72)

    for nome, funil in (("ANTES  (o chamado)", FUNIL_ANTES),
                        ("DEPOIS (o censo)", FUNIL_DEPOIS)):
        print(f"\n{nome}")
        for chave, rot, _, onde in funil:
            falta = [p for p in passeios if not p.campos.get(chave)]
            barra = "█" * round(28 * (n - len(falta)) / n)
            print(f"  {rot:8} {n - len(falta):3}/{n}  {barra:<28} falta em {len(falta):3}"
                  + (f"  → {onde}" if falta else ""))

    print("\nMÍDIA")
    com_amora = sum(1 for p in passeios if p.midia_amora)
    com_passe = sum(1 for p in passeios if p.passe_feito)
    print(f"  {com_amora:3}/{n} passeios com mídia no amora  ({sum(p.midia_amora for p in passeios)} arquivos)")
    print(f"  {com_passe:3}/{n} passeios com passe de coleta registrado")
    if pastas:
        arq = sum(pa.arquivos for pa in pastas)
        wa  = sum(pa.do_whatsapp for pa in pastas)
        og  = sum(pa.originais for pa in pastas)
        gib = sum(pa.bytes_ for pa in pastas) / 1024**3
        print(f"  {len(pastas):3} pastas no acervo do Drive — {arq} arquivos, {gib:.1f} GiB")
        print(f"      {wa:5} do WhatsApp (EXIF stripado — só galeria, nunca marcador)")
        print(f"      {og:5} originais   (com EXIF/GPS — viram marcador no mapa)")

    # `ph:linkActivity` está em 0/109, então incluí-lo na conta faz a completude
    # dar 0 e não dizer mais nada. Reporta-se sem ele (a foto de hoje) E com ele
    # (o alvo), porque a gravação GPS é justamente o que destrava o resto.
    sem_gps = [c for c, _, _, _ in FUNIL_DEPOIS if c != "gravacao"]
    quase = [p for p in passeios
             if not p.faltas(FUNIL_ANTES) and all(p.campos.get(c) for c in sem_gps)]
    print(f"\nCOMPLETUDE\n  {len(quase)}/{n} passeios completos, ignorando a gravação GPS")
    print(f"  {len(completos)}/{n} completos DE VERDADE (com ph:linkActivity)")
    if not completos and quase:
        print("  ↑ nenhum passeio tem a URL da gravação. É ela que permite backfillar")
        print("    saída/chegada/movimento/energia medida — sem ela, esses campos só")
        print("    entram na mão. Ver scripts/backfill-activities.py.")

    ignorados = [(pa.nome, pa.ignorados) for pa in pastas if pa.ignorados]
    if ignorados:
        print(f"\nMÍDIA FORA DE PASTA RECONHECIDA — {len(ignorados)} pastas")
        print("  (tem imagem dentro, mas não numa pasta chamada midia/fotos)")
        for nome, subs in ignorados[:8]:
            print(f"    {nome[:44]:46} → {', '.join(subs)}")

    pend = [p for p in passeios if not p.passe_feito and (not p.pasta or not p.pasta.arquivos)]
    if pend:
        print(f"\nPASSE DE COLETA NUNCA FEITO — {len(pend)} passeios")
        print("  (pasta ausente ou midia/ vazia: ninguém foi buscar no zap)")
        for p in pend[:14]:
            estado = "sem pasta" if not p.pasta else "midia/ vazia"
            amora = f"{p.midia_amora} no amora" if p.midia_amora else "ZERO mídia"
            print(f"    {p.data.date()}  {p.edicao:8} {estado:13} {amora:12} {p.titulo[:34]}")
        if len(pend) > 14:
            print(f"    … e mais {len(pend) - 14}")

    if orfas:
        print(f"\nPASTAS NO DRIVE SEM PASSEIO NO CATÁLOGO — {len(orfas)}")
        print("  (eventos reais que nunca entraram no tours.ttl)")
        for o in orfas:
            print(f"    {o.data or '????-??-??'}  {o.arquivos:4} arq  {o.nome[:50]}")

    arte_local = [p for p in passeios if p.arte_local]
    if arte_local:
        print(f"\nARTE APONTANDO PRA HOST LOCAL — {len(arte_local)}")
        for p in arte_local:
            print(f"    {p.edicao:8} {p.titulo[:44]}  → reenvie a arte")

    print()


def markdown(passeios, destino: Path) -> None:
    L = ["# Auditoria de captura", "",
         f"Gerado em {datetime.now(TZ_SP).isoformat(timespec='seconds')}.", "",
         "Legenda: `·` preenchido · `—` falta · passe: `n` arquivos, `∅` feito e vazio, `?` nunca feito.", "",
         "| Data | Edição | Título | " +
         " | ".join(r for _, r, _, _ in FUNIL_ANTES) + " | " +
         " | ".join(r for _, r, _, _ in FUNIL_DEPOIS) + " | amora | passe | Drive |",
         "|---|---|---|" + "---|" * (len(FUNIL_ANTES) + len(FUNIL_DEPOIS) + 3)]
    for p in passeios:
        cel = ["·" if p.campos.get(k) else "—" for k, _, _, _ in FUNIL_ANTES + FUNIL_DEPOIS]
        passe = "?" if not p.passe_feito else ("∅" if not p.passe_count else str(p.passe_count))
        drive = str(p.pasta.arquivos) if p.pasta else "—"
        L.append(f"| {p.data.date()} | {p.edicao} | {p.titulo[:44]} | " + " | ".join(cel)
                 + f" | {p.midia_amora or '—'} | {passe} | {drive} |")
    destino.write_text("\n".join(L) + "\n", encoding="utf-8")
    print(f"→ {destino}")


def como_json(passeios, pastas, orfas, destino: Path) -> None:
    destino.write_text(json.dumps({
        "gerado": datetime.now(TZ_SP).isoformat(timespec="seconds"),
        "passeios": [{
            "iri": p.iri, "slug": p.slug, "titulo": p.titulo,
            "data": p.data.isoformat(), "edicao": p.edicao,
            "antes": {k: p.campos.get(k) for k, _, _, _ in FUNIL_ANTES},
            "depois": {k: p.campos.get(k) for k, _, _, _ in FUNIL_DEPOIS},
            "arte_host_local": p.arte_local,
            "midia_amora": p.midia_amora,
            "passe": None if not p.passe_feito else {
                "data": p.passe_data, "arquivos": p.passe_count},
            "drive": None if not p.pasta else {
                "pasta": p.pasta.nome, "arquivos": p.pasta.arquivos,
                "whatsapp": p.pasta.do_whatsapp, "originais": p.pasta.originais,
                "contribuintes": dict(p.pasta.contribuintes)},
        } for p in passeios],
        "orfas": [{"pasta": o.nome, "data": o.data, "arquivos": o.arquivos} for o in orfas],
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"→ {destino}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--acervo", default=os.environ.get("BIBLIOTECA_DIR", ACERVO_PADRAO),
                    help="raiz da Biblioteca Hidrográfica (só leitura)")
    ap.add_argument("--sem-acervo", action="store_true",
                    help="não varre o Drive (só o que o catálogo já sabe)")
    ap.add_argument("--markdown", type=Path, help="grava a tabela completa")
    ap.add_argument("--json", type=Path, help="grava os dados crus")
    ap.add_argument("--slug-map", action="store_true",
                    help="emite scripts/whatsapp-slug-map.json pra revisão humana")
    ap.add_argument("--sync", action="store_true",
                    help="grava no catálogo os passes de coleta que faltam")
    ap.add_argument("--dry-run", action="store_true", help="com --sync: só mostra")
    ap.add_argument("--servidor", default=os.environ.get("PHIDRO_SERVER", SERVIDOR_PADRAO))
    ap.add_argument("--quem", default=str(PES["1fhkjnba"]),
                    help="IRI de quem passou o zap (default: dandan)")
    a = ap.parse_args()

    passeios, g = carregar_catalogos()
    pastas, orfas, sem_pasta = [], [], []
    if not a.sem_acervo:
        pastas = ler_acervo(Path(a.acervo))
        orfas, sem_pasta = casar(passeios, pastas)

    if a.slug_map:
        if not pastas:
            sys.exit("--slug-map precisa do acervo")
        emitir_mapa_slugs(pastas, g, REPO / "scripts" / "whatsapp-slug-map.json")
        return

    if a.sync:
        if not pastas:
            sys.exit("--sync precisa do acervo (é ele que diz o que foi coletado)")
        sincronizar(passeios, a.servidor.rstrip("/"), a.quem, a.dry_run)
        return

    relatorio(passeios, pastas, orfas, sem_pasta, g)
    if a.markdown:
        markdown(passeios, a.markdown)
    if a.json:
        como_json(passeios, pastas, orfas, a.json)


if __name__ == "__main__":
    main()
