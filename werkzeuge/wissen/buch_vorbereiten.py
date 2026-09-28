#!/usr/bin/env python3
"""Ein Buch als PDF für den Lehrgang vorbereiten (29.09.2026, Murphy).

Liegt in <ordner> eine PDF und noch kein inventar.json, wird der Text Seite für Seite gelesen
(pdftotext), in Kapitel bzw. Abschnitte von höchstens 25 Seiten geteilt und so abgelegt, wie der
Lehrgang Videos kennt: inventar.json (Abschnitte mit `seiten`) und roh/<id>.json (Segmente mit der
PDF-Seite als `start`). Danach arbeitet der Lehrgang das Buch von selbst ab, sobald die Videos
durch sind. Ein zweiter Aufruf tut nichts, solange inventar.json da ist.

    python3 /opt/kuronami/werkzeuge/wissen/buch_vorbereiten.py
"""
import datetime, glob, json, os, re, subprocess, sys

ORDNER = sys.argv[1] if len(sys.argv) > 1 else "/opt/kuronami/workspace/wissen/murphy"
BUCH = "John J. Murphy — Technical Analysis of the Financial Markets"
KENNUNG = os.path.basename(ORDNER.rstrip("/"))
MAX_SEITEN = 25
KAPITEL = re.compile(r"^\s*(?:CHAPTER|Chapter)\s+(\d{1,2}|[IVXL]{1,6}|[A-Z][a-z]+)\b")


def main():
    pdfs = sorted(glob.glob(os.path.join(ORDNER, "*.pdf")))
    if not pdfs:
        sys.exit(f"Keine PDF in {ORDNER}.")
    if os.path.exists(os.path.join(ORDNER, "inventar.json")):
        sys.exit("Schon vorbereitet (inventar.json liegt da).")
    pdf = pdfs[0]
    if subprocess.run(["pdfinfo", pdf], capture_output=True).returncode != 0:
        sys.exit(f"{pdf} lässt sich nicht lesen — ist das Hochladen fertig?")
    text = subprocess.run(["pdftotext", "-enc", "UTF-8", pdf, "-"], capture_output=True, text=True).stdout
    seiten = [re.sub(r"[ \t]+", " ", s).strip() for s in text.split("\f")]
    if sum(len(s) for s in seiten) < 20_000:
        sys.exit("Die PDF hat kaum Text — vermutlich eingescannt. Dafür braucht es erst eine Texterkennung (OCR).")
    # Kapitelanfänge: „Chapter N“ in den ersten Zeilen einer Seite, nicht im Inhaltsverzeichnis.
    starts = []
    for nr, s in enumerate(seiten, start=1):
        zeilen = [z for z in s.splitlines() if z.strip()][:5]
        treffer = sum(1 for z in s.splitlines() if KAPITEL.match(z))
        if treffer == 1 and any(KAPITEL.match(z) for z in zeilen):
            starts.append((nr, " ".join(zeilen[:3])[:90]))
    kapitel = len(starts) >= 10
    if not kapitel:
        starts = [(nr, f"Seiten {nr}–{min(nr + MAX_SEITEN - 1, len(seiten))}") for nr in range(1, len(seiten) + 1, MAX_SEITEN)]
    elif starts[0][0] > 1:
        starts.insert(0, (1, "Vorspann"))
    abschnitte = []
    for k, (von, titel) in enumerate(starts):
        bis = (starts[k + 1][0] - 1) if k + 1 < len(starts) else len(seiten)
        teile = list(range(von, bis + 1, MAX_SEITEN))
        for t, a in enumerate(teile):
            b = min(a + MAX_SEITEN - 1, bis)
            inhalt = [(p, seiten[p - 1]) for p in range(a, b + 1) if seiten[p - 1]]
            if sum(len(x) for _, x in inhalt) < 1500:
                continue
            kid = f"{KENNUNG}-{k:02d}" + (f"-{t + 1}" if len(teile) > 1 else "")
            abschnitte.append((kid, titel + (f" (Teil {t + 1})" if len(teile) > 1 else ""), a, b, inhalt))
    os.makedirs(os.path.join(ORDNER, "roh"), exist_ok=True)
    jetzt = datetime.datetime.now(datetime.timezone.utc).isoformat()
    for kid, titel, a, b, inhalt in abschnitte:
        json.dump({"id": kid, "titel": titel, "sprache": "en", "art": "manuell", "geholt": jetzt,
                   "segmente": [{"start": p, "text": x} for p, x in inhalt]},
                  open(os.path.join(ORDNER, "roh", f"{kid}.json"), "w"), ensure_ascii=False)
    json.dump({"kanal": BUCH, "stand": jetzt, "quelle": os.path.basename(pdf),
               "hinweis": "Abschnitte aus der PDF; seiten = PDF-Seiten, nicht die gedruckten.",
               "videos": [{"id": kid, "titel": titel, "dauer": 0, "seiten": [a, b], "buch": BUCH}
                          for kid, titel, a, b, _ in abschnitte]},
              open(os.path.join(ORDNER, "inventar.json"), "w"), ensure_ascii=False, indent=1)
    print(f"{len(seiten)} Seiten, {len(abschnitte)} Abschnitte ({'nach Kapiteln' if kapitel else 'in festen Blöcken'}) abgelegt.")


if __name__ == "__main__":
    main()
