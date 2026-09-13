"""Eine gesprochene Antwort auf eine Freigabeanfrage einer Option zuordnen.

Ohne diesen Schritt läuft ein Sprachgespräch auf den ersten Freigabepunkt zu und bleibt dort
stehen: Das Gateway hält den Zug an (`awaiting_user`), der Nutzer sagt "ja, mach", und niemand
übersetzt das in eine `choice_id`. Per Telegram gibt es dafür Knöpfe (S16), per Slack eine
Reaktion (S26) — per Stimme gibt es nur Text.

Die Zuordnung ist bewusst **streng und ohne Modell**. Ein Sprachmodell, das aus "eigentlich
lieber nicht" eine Freigabe macht, wäre genau die Art Fehler, die Abschnitt 10 verhindern soll:
eine Zustimmung, die niemand gegeben hat. Kein Treffer heißt deshalb kein Treffer — dann wird
nachgefragt, und zwar mit denselben Optionen.

Fünf Wege, in dieser Reihenfolge:

1. Eine Verneinung, die genau **eine** Option trägt — sie steht vorn, siehe `match_choice`.
2. Die Kennung der Option wörtlich (`genehmigen`).
3. Die Beschriftung wörtlich.
4. Ein Zustimmungswort, das genau **eine** Option trägt.
5. Eine Ordnungszahl ("die erste", "Option zwei").
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass

#: Wörter, die eine Zustimmung sind — und nur solche, die nichts anderes sein können.
YES_WORDS = (
    "ja",
    "jawohl",
    "klar",
    "genau",
    "okay",
    "ok",
    "mach",
    "machs",
    "los",
    "freigeben",
    "genehmigen",
    "erlauben",
    "zustimmen",
)
NO_WORDS = ("nein", "nicht", "stopp", "stop", "abbrechen", "lass", "ablehnen", "nee", "kein")

ORDINALS: dict[str, int] = {
    "erste": 1,
    "ersten": 1,
    "eins": 1,
    "1": 1,
    "zweite": 2,
    "zweiten": 2,
    "zwei": 2,
    "2": 2,
    "dritte": 3,
    "dritten": 3,
    "drei": 3,
    "3": 3,
    "vierte": 4,
    "vierten": 4,
    "vier": 4,
    "4": 4,
}


@dataclass(frozen=True)
class Choice:
    id: str
    label: str


def normalize(text: str) -> str:
    """Kleingeschrieben, ohne Umlaut-Diakritika, ohne Satzzeichen.

    Die Erkennung liefert "Ja, genehmigen!" und die Option heißt `genehmigen` — ohne diese
    Angleichung scheiterte der Vergleich an einem Ausrufezeichen.
    """
    lowered = text.casefold()
    folded = "".join(
        char
        for char in unicodedata.normalize("NFD", lowered)
        if unicodedata.category(char) != "Mn"
    )
    return re.sub(r"[^a-z0-9äöüß ]+", " ", folded)


def _words(text: str) -> list[str]:
    return [word for word in normalize(text).split() if word]


def _unique_match(candidates: Sequence[Choice]) -> str | None:
    return candidates[0].id if len(candidates) == 1 else None


def match_choice(spoken: str, options: Sequence[Choice]) -> str | None:
    """Die `choice_id` zur gesprochenen Antwort, oder `None`. Nie ein geratener Treffer."""
    if not options:
        return None
    words = _words(spoken)
    if not words:
        return None
    joined = " ".join(words)

    # 1. **Erst die Verneinung.** Sie steht vor allem anderen, weil ein "nein, nicht genehmigen"
    #    sonst über die Beschriftung "Genehmigen" stolpert und als Zustimmung gelesen würde. Das
    #    ist kein Randfall, sondern die naheliegendste Art, eine Freigabe abzulehnen — und der
    #    teuerste denkbare Fehlgriff.
    said_no = any(word in NO_WORDS for word in words)
    if said_no:
        negative = [
            option
            for option in options
            if any(word in NO_WORDS for word in _words(f"{option.id} {option.label}"))
        ]
        if (found := _unique_match(negative)) is not None:
            return found

    # 2. Kennung wörtlich.
    by_id = [option for option in options if normalize(option.id).strip() in words]
    if (found := _unique_match(by_id)) is not None:
        return found

    # 3. Beschriftung wörtlich (als zusammenhängende Wortfolge).
    by_label = [
        option for option in options if (label := " ".join(_words(option.label))) and label in joined
    ]
    if (found := _unique_match(by_label)) is not None:
        return found

    # 4. Zustimmung — nur, wenn genau eine Option so zu lesen ist. Zwei Optionen, die beide nach
    #    Zustimmung klingen ("jetzt genehmigen" / "später genehmigen"), sind hier kein Treffer.
    if not said_no and any(word in YES_WORDS for word in words):
        positive = [
            option
            for option in options
            if any(word in YES_WORDS for word in _words(f"{option.id} {option.label}"))
        ]
        if (found := _unique_match(positive)) is not None:
            return found

    # 5. Ordnungszahl.
    for word in words:
        index = ORDINALS.get(word)
        if index is not None and 1 <= index <= len(options):
            return options[index - 1].id

    return None


def spoken_question(question: str, options: Sequence[Choice]) -> str:
    """Die Freigabeanfrage, wie sie vorgelesen wird — mit ihren Optionen, wortgleich.

    Abschnitt 10 verlangt strukturierte Optionen statt Fließtext. Am Sprachkanal heißt das nicht,
    dass die Struktur verschwindet, sondern dass sie vorgelesen wird: sonst bekäme der Nutzer eine
    Frage ohne die Antworten, die sie überhaupt beantwortbar machen.
    """
    if not options:
        return question
    listed = ", ".join(option.label or option.id for option in options)
    return f"{question} Zur Wahl steht: {listed}."
