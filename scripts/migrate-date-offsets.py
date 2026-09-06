#!/usr/bin/env python3
"""Repara os offsets UTC drifted das datas de mídia (one-shot).

Contexto: o owlrl (inferência rdfs do pyshacl) trocava os conversores de
datatype do rdflib GLOBALMENTE durante cada validação SHACL. Um Turtle
parseado por OUTRA thread nesse intervalo saía com o offset dos xsd:dateTime
deslocado uma hora (-03:00 → -04:00), e como cada gravação re-serializava o
images.ttl inteiro, o desvio se acumulava a cada upload: 435 das 460 datas de
mídia chegaram a offsets entre -04:00 e -23:00 (o RELÓGIO DE PAREDE fica
certo; só o offset drifta — conferido contra o EXIF dos originais). O backend
já não troca mais os conversores (ver _load_validator em backend/main.py);
este script conserta o estrago acumulado.

O reparo é TEXTUAL, não via rdflib (preserva o resto do arquivo byte a byte):
todo `dcterms:date "…T…-HH:00"^^xsd:dateTime` com HH entre 04 e 23 volta pra
`-03:00` (o offset de São Paulo — o Brasil não tem horário de verão desde
2019). Offsets positivos, -03:30 etc. não são tocados (o bug do owlrl só
deslocava horas negativas inteiras).

Uso (round-trip guardado, como qualquer edição de catálogo):
    scripts/pull-cloudrun.sh                       # traz o images.ttl vigente
    python3 scripts/migrate-date-offsets.py        # dry-run: relatório
    python3 scripts/migrate-date-offsets.py --apply
    scripts/deploy-cloudrun.sh --state-only        # sobe o catálogo
    curl -X POST https://amora.pedalhidrografi.co/reload
"""
import argparse
import re
import sys
from collections import Counter
from pathlib import Path

DEFAULT = Path(__file__).resolve().parents[1] / "web" / "data" / "images.ttl"
DRIFTED = re.compile(
    r'(dcterms:date "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)-(0[4-9]|1\d|2[0-3]):00("\^\^xsd:dateTime)')
ANY_DT = re.compile(r'"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?([+-]\d{2}:\d{2}|Z)"\^\^xsd:dateTime')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("path", nargs="?", default=str(DEFAULT), help="images.ttl (default: web/data/images.ttl)")
    ap.add_argument("--apply", action="store_true", help="grava (default: só relata)")
    ap.add_argument("--expected", default="-03:00", help="offset alvo (default -03:00)")
    args = ap.parse_args()
    p = Path(args.path)
    text = p.read_text(encoding="utf-8")

    before = Counter(m.group(1) for m in ANY_DT.finditer(text))
    fixed, n = DRIFTED.subn(lambda m: f"{m.group(1)}{args.expected}{m.group(3)}", text)
    after = Counter(m.group(1) for m in ANY_DT.finditer(fixed))
    print(f"{p}: {n} dcterms:date com offset drifted (-04:00…-23:00)")
    print("  offsets antes:", dict(sorted(before.items())))
    print("  offsets depois:", dict(sorted(after.items())))
    if not args.apply:
        print("dry-run — nada gravado. Rode com --apply pra gravar.")
        return 0
    try:
        from rdflib import Graph
        Graph().parse(data=fixed, format="turtle")
    except Exception as e:  # noqa: BLE001
        print(f"ABORTADO: o resultado não parseia como Turtle: {e}", file=sys.stderr)
        return 2
    p.write_text(fixed, encoding="utf-8")
    print(f"gravado: {p} ({n} datas corrigidas)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
