#!/usr/bin/env python3
"""
Holt die Untertitel der TradingLab-Videos auf Jakobs PC und lädt sie zu Kuro hoch.

Warum auf dem PC: YouTube sperrt dem Server jede Video-Seite ("Sign in to confirm you're not a
bot", gemessen am 27.09.2026). Eine Heimleitung ist nicht gesperrt.

Einmal einrichten:
    pip install -U yt-dlp
    (schluessel.txt liegt neben diesem Skript — oder das Skript fragt beim ersten Start danach)

Starten:
    python tradinglab_transkripte.py            # alles, was dem Server noch fehlt
    python tradinglab_transkripte.py --probe    # nur ein Video, zum Ausprobieren

Das Skript fragt den Server, welche Videos noch fehlen, holt je Video die Untertitel (vom Kanal
hochgeladene zuerst, sonst die von YouTube erkannten) und schickt sie hoch. Zwischen zwei Videos
wartet es, damit YouTube nicht bremst. Abbrechen mit Strg+C ist jederzeit in Ordnung: beim
nächsten Start geht es beim nächsten fehlenden Video weiter.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

SERVER = "https://gateway.203-0-113-7.sslip.io"
KANAL = "tradinglab"
HIER = Path(__file__).resolve().parent
LOG = HIER / "tradinglab_transkripte.log"

try:
    sys.stdout.reconfigure(errors="replace")  # Windows-Konsole
except Exception:
    pass


def log(text: str) -> None:
    zeile = f"{time.strftime('%H:%M:%S')}  {text}"
    print(zeile, flush=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(zeile + "\n")


def schluessel() -> str:
    datei = HIER / "schluessel.txt"
    if os.environ.get("KURO_WISSEN_SCHLUESSEL"):
        return os.environ["KURO_WISSEN_SCHLUESSEL"].strip()
    if datei.exists():
        return datei.read_text(encoding="utf-8").strip()
    s = input("Wissensschlüssel (KURO_WISSEN_SCHLUESSEL aus der .env des Servers): ").strip()
    datei.write_text(s + "\n", encoding="utf-8")
    return s


def server(methode: str, pfad: str, key: str, daten: dict | None = None) -> dict:
    anfrage = urllib.request.Request(
        SERVER + pfad,
        method=methode,
        data=None if daten is None else json.dumps(daten).encode("utf-8"),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(anfrage, timeout=60) as antwort:
            return json.loads(antwort.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        grund = e.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"Server antwortet {e.code}: {grund}") from None


def segmente_aus_json3(roh: bytes) -> list[dict]:
    """YouTubes json3: je Ereignis eine Startzeit und Textstücke."""
    daten = json.loads(roh.decode("utf-8"))
    segmente = []
    for ereignis in daten.get("events", []):
        stuecke = ereignis.get("segs") or []
        text = "".join(s.get("utf8", "") for s in stuecke).replace("\n", " ").strip()
        if not text:
            continue
        segmente.append({"start": ereignis.get("tStartMs", 0) / 1000, "text": text})
    return segmente


def waehle_spur(info: dict) -> tuple[str, str, str] | None:
    """(art, sprache, url) — vom Kanal hochgeladene Untertitel vor den erkannten."""
    def json3(spuren: list[dict]) -> str | None:
        for s in spuren:
            if s.get("ext") == "json3":
                return s.get("url")
        return None

    manuell = info.get("subtitles") or {}
    for sprache in ["en", "en-US", "en-GB", *[k for k in manuell if k.startswith("en")]]:
        if sprache in manuell and (url := json3(manuell[sprache])):
            return "manuell", sprache, url
    auto = info.get("automatic_captions") or {}
    for sprache in ["en-orig", "en"]:
        if sprache in auto and (url := json3(auto[sprache])):
            return "automatisch", sprache, url
    return None


def hole(ydl, video_id: str) -> dict:
    info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
    spur = waehle_spur(info)
    if spur is None:
        return {"id": video_id, "art": "ohne", "sprache": "en", "segmente": []}
    art, sprache, url = spur
    segmente = segmente_aus_json3(ydl.urlopen(url).read())
    if not segmente:
        return {"id": video_id, "art": "ohne", "sprache": sprache, "segmente": []}
    return {"id": video_id, "art": art, "sprache": sprache, "segmente": segmente}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--probe", action="store_true", help="nur ein Video")
    parser.add_argument("--pause", type=int, default=35, help="mittlere Pause in Sekunden")
    args = parser.parse_args()

    try:
        import yt_dlp
    except ImportError:
        print("yt-dlp fehlt. Bitte zuerst:  pip install -U yt-dlp")
        return 1

    key = schluessel()
    offen = server("GET", f"/wissen/{KANAL}/offen", key)["offen"]
    log(f"{len(offen)} Videos fehlen dem Server noch.")
    if args.probe:
        offen = offen[:1]

    fehler_in_folge = 0
    optionen = {"skip_download": True, "quiet": True, "no_warnings": False, "noprogress": True}
    with yt_dlp.YoutubeDL(optionen) as ydl:
        for nr, video in enumerate(offen, 1):
            titel = video["titel"][:70]
            try:
                t = hole(ydl, video["id"])
                antwort = server("POST", f"/wissen/{KANAL}/transkript", key, t)
                log(f"[{nr}/{len(offen)}] {titel} — {antwort['art']}, {antwort['segmente']} Zeilen")
                fehler_in_folge = 0
            except KeyboardInterrupt:
                log("Abgebrochen. Beim nächsten Start geht es hier weiter.")
                return 0
            except Exception as e:  # noqa: BLE001 — jede Art Fehler wird gemeldet und gezählt
                fehler_in_folge += 1
                meldung = str(e).splitlines()[0][:300]
                log(f"[{nr}/{len(offen)}] {titel} — FEHLER: {meldung}")
                if "Sign in to confirm" in meldung or "429" in meldung:
                    if fehler_in_folge >= 3:
                        log("YouTube bremst weiter. Später noch einmal starten.")
                        return 2
                    log("YouTube bremst — 15 Minuten Pause.")
                    time.sleep(900)
                    continue
                if "JavaScript" in meldung or "js runtime" in meldung.lower():
                    log("Hinweis: yt-dlp möchte eine JavaScript-Laufzeit. Unter Windows:  "
                        "winget install DenoLand.Deno  — danach neu starten.")
                if fehler_in_folge >= 5:
                    log("Fünf Fehler hintereinander — ich höre auf. Log liegt neben dem Skript.")
                    return 2
            if nr < len(offen):
                time.sleep(random.uniform(args.pause * 0.6, args.pause * 1.4))

    stand = server("GET", f"/wissen/{KANAL}/offen", key)["offen"]
    log(f"Fertig. Dem Server fehlen noch {len(stand)} Videos.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
