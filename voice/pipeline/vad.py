"""Ein zweiter Sprachdetektor — nicht besser als Silero, sondern für eine andere Frage.

**Silero bleibt die Vorgabe.** Er entscheidet gut, was menschliche Stimme ist, und genau das ist
im Betrieb die Frage: ein Lüfter, ein Türschlag oder Musik dürfen den Agenten nicht unterbrechen.

Für eine **Messung** ist dieselbe Stärke ein Hindernis. Silero sagt zu synthetischem Ton "keine
Stimme" — nachgeprüft, und zwar zu Recht: ein 220-Hz-Sinus, weißes Rauschen und ein gebasteltes
Formantengemisch werden alle drei als `QUIET` eingestuft. Eine wiederholbare Messung braucht aber
einen Reiz, den der Messende **selbst erzeugt** und exakt platziert; sonst misst man am Ende die
Tagesform eines Modells und nicht die Latenz einer Pipeline. Und für Barge-in kommt es auf den
Zeitpunkt an, nicht darauf, was gesagt wurde.

Deshalb `VOICE_VAD=energy`: Sprache ist, was laut genug ist. Die **Zeitmessung dahinter ist
dieselbe** — `start_secs` und `stop_secs` werden in der Basisklasse (`VADAnalyzer._run_analyzer`)
gezählt, nicht hier, und die Blockgröße ist mit 512 Abtastwerten bei 16 kHz bewusst exakt Sileros.
Was sich zwischen den beiden unterscheidet, ist allein die Antwort auf "ist das eine Stimme", nicht
"wann fing sie an".

Was damit **nicht** gemessen ist, steht in `voice/README.md`: Sileros eigene Rechenzeit je Block.
Sie liegt im niedrigen einstelligen Millisekundenbereich und geht in dieselbe Rechnung ein.
"""

from __future__ import annotations

import array
import math

from pipecat.audio.vad.vad_analyzer import VADAnalyzer, VADParams

#: Ab diesem Effektivwert (relativ zur Vollaussteuerung) gilt ein Block als Stimme.
DEFAULT_ENERGY_THRESHOLD = 0.02


class EnergyVADAnalyzer(VADAnalyzer):
    """Sprachdetektion über den Effektivwert. Deterministisch, ohne Modell, ohne Download."""

    def __init__(
        self,
        *,
        sample_rate: int | None = None,
        params: VADParams | None = None,
        threshold: float = DEFAULT_ENERGY_THRESHOLD,
    ) -> None:
        super().__init__(sample_rate=sample_rate, params=params)
        self._threshold = threshold

    def num_frames_required(self) -> int:
        """Dieselbe Blockgröße wie Silero — sonst zählte die Basisklasse `start_secs` anders."""
        return 512 if self.sample_rate == 16000 else 256

    def voice_confidence(self, buffer: bytes) -> float:
        """Effektivwert des Blocks, auf 0…1 abgebildet.

        Kein harter Schalter: die Basisklasse vergleicht gegen `VADParams.confidence`, und ein
        weicher Verlauf lässt dieselbe Schwelle dort weiterhin etwas bedeuten.
        """
        if len(buffer) < 2:
            return 0.0
        samples = array.array("h")
        samples.frombytes(buffer[: len(buffer) - (len(buffer) % 2)])
        if not samples:
            return 0.0

        total = 0.0
        for sample in samples:
            total += float(sample) * float(sample)
        rms = math.sqrt(total / len(samples)) / 32768.0

        if rms <= 0.0:
            return 0.0
        ratio = rms / self._threshold
        return min(1.0, ratio)
