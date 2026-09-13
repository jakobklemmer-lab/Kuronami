"""Die Messpunkte eines Sprachzugs (S31) — eine Uhr, keine Schätzung.

Das Fertig-Kriterium von S31 lautet "unter 800 ms End-zu-End". Damit diese Zahl etwas bedeutet,
muss gesagt sein, **was** gemessen wird, und zwar bevor gemessen wird. Ein Sprachzug besteht aus
fünf Stücken, und nur vier davon gehören der Sprachschicht:

1. ``erkennung``  — vom Ende des Sprechens (VAD) bis zum endgültigen Transkript (Deepgram).
2. ``bruecke``    — vom Transkript bis zur abgeschickten Anfrage an das Gateway.
3. ``agent``      — die Antwortzeit des Gateways: Modell, Werkzeuge, Freigaben.
4. ``stimme``     — von der Antwort bis zum ersten Audio-Byte (ElevenLabs).
5. ``ausgabe``    — vom ersten Byte bis es beim Hörer ankommt; misst der Client, nicht wir.

**Das Budget gilt für 1, 2 und 4 zusammen** — in den Feldern unten ``sprachschicht_ms``. Punkt 3
ist die Denkzeit des Agenten; sie in dieselbe Zahl zu rechnen hieße, eine Eigenschaft des Modells
als Eigenschaft der Sprachschicht auszugeben, und sie ließe sich durch keine Verbesserung an
dieser Pipeline drücken. Sie wird trotzdem mitgemessen und mit ausgewiesen: eine Antwortzeit von
vier Sekunden ist für ein Gespräch eine schlechte Nachricht, auch wenn sie nicht dieser Schicht
gehört.

Gemessen wird mit `time.perf_counter`, also monoton — eine Systemzeit, die während der Messung
nachgestellt wird, verfälscht hier nichts.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

#: Die Messpunkte in ihrer natürlichen Reihenfolge.
MARKS = (
    "speech_stopped",
    "transcript_final",
    "gateway_sent",
    "gateway_replied",
    "speech_queued",
    "first_audio",
)

#: Welche Strecke aus welchen zwei Marken entsteht.
SEGMENTS: tuple[tuple[str, str, str], ...] = (
    ("erkennung", "speech_stopped", "transcript_final"),
    ("bruecke", "transcript_final", "gateway_sent"),
    ("agent", "gateway_sent", "gateway_replied"),
    ("uebergabe", "gateway_replied", "speech_queued"),
    ("stimme", "speech_queued", "first_audio"),
)


@dataclass
class TurnLatency:
    """Die Marken eines einzelnen Zugs."""

    turn_id: str
    marks: dict[str, float] = field(default_factory=dict)

    def segments(self) -> dict[str, float]:
        """Die Strecken in Millisekunden. Fehlende Marken fehlen auch hier — kein Nullwert,
        der aussähe, als wäre die Strecke gemessen und null gewesen."""
        out: dict[str, float] = {}
        for name, start, end in SEGMENTS:
            if start in self.marks and end in self.marks:
                out[name] = round((self.marks[end] - self.marks[start]) * 1000, 2)
        return out

    def total_ms(self) -> float | None:
        if "speech_stopped" in self.marks and "first_audio" in self.marks:
            return round((self.marks["first_audio"] - self.marks["speech_stopped"]) * 1000, 2)
        return None

    def voice_layer_ms(self) -> float | None:
        """Gesamt **ohne** die Denkzeit des Agenten. Das ist die Zahl, für die S31 ein Budget hat."""
        total = self.total_ms()
        if total is None:
            return None
        agent = self.segments().get("agent")
        return round(total - agent, 2) if agent is not None else total

    def report(self, budget_ms: int) -> dict[str, Any]:
        voice_layer = self.voice_layer_ms()
        return {
            "turn_id": self.turn_id,
            "segments_ms": self.segments(),
            "total_ms": self.total_ms(),
            "voice_layer_ms": voice_layer,
            "budget_ms": budget_ms,
            # `None`, solange der Zug nicht vollständig gemessen ist. Ein `False` wäre hier eine
            # Aussage über eine Messung, die es nicht gibt.
            "within_budget": None if voice_layer is None else voice_layer <= budget_ms,
        }


class LatencyLedger:
    """Hält die Marken des laufenden Zugs. Ein neuer Zug beginnt bei null."""

    def __init__(self, clock: Callable[[], float] = time.perf_counter) -> None:
        self._clock = clock
        self._current: TurnLatency | None = None
        self._finished: list[TurnLatency] = []
        self._pending: tuple[str, float] | None = None

    @property
    def current(self) -> TurnLatency | None:
        return self._current

    @property
    def finished(self) -> list[TurnLatency]:
        return list(self._finished)

    def begin(self, turn_id: str) -> TurnLatency:
        """Beginnt einen Zug. Ein noch offener wird abgelegt, nicht überschrieben — auch ein
        abgebrochener Zug ist eine Messung (er sagt, wie weit es kam)."""
        if self._current is not None:
            self._finished.append(self._current)
        self._current = TurnLatency(turn_id=turn_id)
        return self._current

    def mark(self, name: str) -> float | None:
        """Setzt eine Marke im laufenden Zug. Ohne laufenden Zug passiert nichts."""
        if name not in MARKS:
            raise ValueError(f"Unbekannte Marke {name!r}. Bekannt: {MARKS}")
        if self._current is None:
            return None
        # Die erste Marke gewinnt: `first_audio` heißt erstes Byte, nicht letztes.
        if name in self._current.marks:
            return self._current.marks[name]
        at = self._clock()
        self._current.marks[name] = at
        return at

    def pre_mark(self, name: str) -> None:
        """Setzt eine Marke, die **vor** dem Zug liegt (das Ende des Sprechens), indem sie in
        einen frisch begonnenen Zug übernommen wird.

        Nötig, weil das Ende des Sprechens früher eintrifft als das Transkript, das dem Zug
        seinen Namen gibt. Ohne diesen Weg begänne jede Messung erst beim Transkript — und
        genau die Erkennungsstrecke, die am längsten dauert, fiele heraus.
        """
        if name not in MARKS:
            raise ValueError(f"Unbekannte Marke {name!r}. Bekannt: {MARKS}")
        self._pending = (name, self._clock())

    def begin_with_pending(self, turn_id: str) -> TurnLatency:
        """Beginnt einen Zug und übernimmt die vorgemerkte Marke, falls es eine gibt."""
        turn = self.begin(turn_id)
        if self._pending is not None:
            name, at = self._pending
            turn.marks[name] = at
            self._pending = None
        return turn

    def close(self) -> TurnLatency | None:
        """Schließt den laufenden Zug ab und legt ihn in die Historie."""
        turn = self._current
        if turn is not None:
            self._finished.append(turn)
            self._current = None
        return turn
