#!/usr/bin/env python3
"""
Welche Aufgabe aus bau/PLAN.md ist als Nächstes dran? Für bau/nachtbau.sh.

Aufruf:  naechste.py <PLAN.md> [bereits versuchte IDs, kommagetrennt]
Ausgabe: "<ID> <modell>" oder nichts, wenn keine Aufgabe bereit ist.

Bereit ist die erste Aufgabe (in Plan-Reihenfolge) mit Status offen, in Arbeit oder wartet, deren
„Braucht" alle erledigt sind und die in dieser Nacht noch nicht versucht wurde.
Setzen:  naechste.py --setze <PLAN.md> <ID> <neuer Status>
"""

import re
import sys

KOPF = re.compile(r"^## (N\d+[a-z]?) · ", re.M)


def aufgaben(text: str) -> list[dict]:
    teile = list(KOPF.finditer(text))
    liste = []
    for i, m in enumerate(teile):
        ende = teile[i + 1].start() if i + 1 < len(teile) else len(text)
        block = text[m.start():ende]
        status = re.search(r"^- Status: (.+)$", block, re.M)
        modell = re.search(r"^- Modell: (\w+)", block, re.M)
        braucht = re.search(r"^- Braucht: (.+)$", block, re.M)
        liste.append({
            "id": m.group(1),
            "status": status.group(1).strip() if status else "offen",
            "modell": modell.group(1) if modell else "sonnet",
            "braucht": re.findall(r"N\d+[a-z]?", braucht.group(1)) if braucht else [],
        })
    return liste


def main() -> None:
    if sys.argv[1] == "--setze":
        pfad, ziel, neu = sys.argv[2], sys.argv[3], sys.argv[4]
        text = open(pfad, encoding="utf-8").read()
        muster = re.compile(rf"(^## {re.escape(ziel)} · .*?^- Status: ).+?$", re.M | re.S)
        text, n = muster.subn(lambda m: m.group(1) + neu, text, count=1)
        if n:
            open(pfad, "w", encoding="utf-8").write(text)
        sys.exit(0 if n else 1)

    liste = aufgaben(open(sys.argv[1], encoding="utf-8").read())
    versucht = set(filter(None, (sys.argv[2] if len(sys.argv) > 2 else "").split(",")))
    erledigt = {a["id"] for a in liste if a["status"].startswith("erledigt")}
    # Eine zerlegte Aufgabe gilt als erledigt, wenn alle ihre Teile erledigt sind.
    for a in liste:
        teile = [b for b in liste if re.fullmatch(rf"{a['id']}[a-z]", b["id"])]
        if teile and all(b["id"] in erledigt for b in teile):
            erledigt.add(a["id"])
    for a in liste:
        if a["id"] in versucht:
            continue
        if not a["status"].startswith(("offen", "in Arbeit", "wartet")):
            continue
        if any(b not in erledigt for b in a["braucht"]):
            continue
        # Eine Aufgabe mit Teilaufgaben wird über ihre Teile gebaut, nicht selbst.
        if any(re.fullmatch(rf"{a['id']}[a-z]", b["id"]) for b in liste):
            continue
        print(a["id"], a["modell"])
        return


if __name__ == "__main__":
    main()
