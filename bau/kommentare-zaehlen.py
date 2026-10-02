#!/usr/bin/env python3
"""Zählt Kommentarzeilen (//, /* … */) in den genannten Dateien. Für N17: vorher/nachher.

    python3 bau/kommentare-zaehlen.py <datei> …     →  "<Kommentarzeilen> Kommentarzeilen in <n> Dateien"
"""
import sys

gesamt = 0
for pfad in sys.argv[1:]:
    im_block = False
    for zeile in open(pfad, encoding="utf-8", errors="replace"):
        s = zeile.strip()
        if not s:
            continue
        if im_block:
            gesamt += 1
            im_block = "*/" not in s
        elif s.startswith("/*"):
            gesamt += 1
            im_block = "*/" not in s
        elif s.startswith("//"):
            gesamt += 1
print(f"{gesamt} Kommentarzeilen in {len(sys.argv) - 1} Dateien")
