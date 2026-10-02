#!/usr/bin/env python3
"""
Lässt keinen Commit mit privaten Daten durch. Das Repo ist öffentlich.

Aufruf: als pre-commit-Hook (bau/hooks/pre-commit) oder von Hand:
    python3 bau/privat-pruefen.py            # prüft, was gestaged ist
    python3 bau/privat-pruefen.py <basis>    # prüft alles seit <basis> (für die Historie)
    python3 bau/privat-pruefen.py --alles    # prüft jede versionierte Datei, wie sie jetzt ist

Die privaten Werte selbst stehen nicht hier, sondern werden aus der .env gelesen (Postfächer,
Anmeldename, Kapital) und vom Rechner (eigene IP-Adressen). Dazu allgemeine Muster: fremde
Mailadressen außer Beispiel-Domains, Dateien aus dem Arbeitsbereich und die Sitzungsprotokolle.
Ausgabe bei Fund: Datei:Zeile und die Art des Funds — nie der Wert selbst.
"""

import os
import re
import subprocess
import sys
from pathlib import Path

ERLAUBTE_DOMAINS = re.compile(
    r"@(example\.(com|org|net)|[\w.-]+\.example|anthropic\.com|users\.noreply\.github\.com|"
    r"localhost|test|invalid|b\.de|x\.y)$",
    re.I,
)
MAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
VERBOTENE_PFADE = re.compile(r"^(workspace/(?!CLAUDE\.md$).+|progress(-archiv)?\.md|.*\.env)$")


def env_datei() -> Path | None:
    for kandidat in (os.environ.get("KURONAMI_ENV"), "/opt/kuronami/.env", ".env"):
        if kandidat and Path(kandidat).is_file():
            return Path(kandidat)
    return None


def private_werte() -> dict[str, str]:
    """Wert → Art. Nur Werte, die lang genug sind, um nicht zufällig im Code zu stehen."""
    werte: dict[str, str] = {}
    datei = env_datei()
    if datei:
        for zeile in datei.read_text(encoding="utf-8", errors="replace").splitlines():
            m = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*\"?([^\"#]*)\"?", zeile)
            if not m:
                continue
            name, wert = m.group(1), m.group(2).strip()
            if not wert:
                continue
            if re.fullmatch(r"MAIL_\d+_USER", name):
                werte[wert.lower()] = "Postfach"
                werte[wert.split("@")[0].lower()] = "Postfachname"
            elif name == "WEB_LOGIN_USER":
                werte[wert.lower()] = "Anmeldename"
            elif re.search(r"(TOKEN|KEY|SECRET|PASS|HASH|CLIENT_ID|_GOOGLE)$|^NOTION_\w+_(DB|PAGE)$", name):
                werte[wert.lower()] = "Wert aus der .env"
            elif name == "KURO_KAPITAL_EURO" and wert.replace(".", "").isdigit():
                n = int(float(wert))
                for form in (f"{n:,}".replace(",", ".") + " €", f"{n} €", f"{n}€"):
                    werte[form.lower()] = "Kapital"
    try:
        for adresse in subprocess.run(["hostname", "-I"], capture_output=True, text=True).stdout.split():
            if re.fullmatch(r"\d+\.\d+\.\d+\.\d+", adresse) and not adresse.startswith(("10.", "127.", "172.", "192.168.")):
                werte[adresse] = "Server-IP"
                werte[adresse.replace(".", "-")] = "Server-IP"
    except OSError:
        pass
    return {w: a for w, a in werte.items() if len(w) >= 6}


def diff(basis: str | None) -> str:
    if basis == "--alles":
        # Jede versionierte Datei als „neu" — dieselbe Prüfung wie für einen Commit.
        args = ["git", "diff", "--no-color", "-U0", "--no-ext-diff", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "HEAD"]
    else:
        args = ["git", "diff", "--no-color", "-U0", "--no-ext-diff"]
        args += [basis, "HEAD"] if basis else ["--cached"]
    return subprocess.run(args, capture_output=True, text=True, errors="replace").stdout


def main() -> int:
    basis = sys.argv[1] if len(sys.argv) > 1 else None
    werte = private_werte()
    funde: list[str] = []
    datei, zeile_nr = "", 0
    for zeile in diff(basis).splitlines():
        if zeile.startswith("+++ "):
            datei = zeile[6:] if zeile.startswith("+++ b/") else ""
            if datei and VERBOTENE_PFADE.match(datei):
                funde.append(f"{datei}: Datei darf nicht ins Repo")
            continue
        m = re.match(r"^@@ -\d+(?:,\d+)? \+(\d+)", zeile)
        if m:
            zeile_nr = int(m.group(1))
            continue
        if not zeile.startswith("+") or not datei:
            continue
        text = zeile[1:]
        klein = text.lower()
        for wert, art in werte.items():
            if wert in klein:
                funde.append(f"{datei}:{zeile_nr}: {art}")
        for adresse in MAIL.findall(text):
            if not ERLAUBTE_DOMAINS.search(adresse):
                funde.append(f"{datei}:{zeile_nr}: Mailadresse")
        zeile_nr += 1
    if funde:
        print("Private Daten im Commit — das Repo ist öffentlich:", file=sys.stderr)
        for f in sorted(set(funde)):
            print(f"  {f}", file=sys.stderr)
        print("Werte gehören in die .env, Arbeitsdaten nach workspace/ (ignoriert).", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
