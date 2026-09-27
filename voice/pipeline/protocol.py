"""Das Draht-Protokoll der Sprachschicht — bewusst klein genug für einen Browser ohne Bundler.

Pipecat bringt einen Protobuf-Serialisierer mit, und er wäre die naheliegende Wahl. Er scheidet
hier aus einem Grund aus, der nichts mit Geschmack zu tun hat: `ui/` wird seit Phase 6 **ohne
Bundler** ausgeliefert (siehe S29), also ohne npm-Import und damit ohne Protobuf-Bibliothek. Ein
Protokoll, das der eigene Client nicht sprechen kann, ist keines.

Deshalb zwei Sorten Nachricht, mehr nicht:

* **Binär** — rohe PCM-Abtastwerte, 16 Bit, little endian, ein Kanal. Hinein mit
  `VOICE_AUDIO_IN_SAMPLE_RATE` (Vorgabe 16 kHz), hinaus mit `VOICE_AUDIO_OUT_SAMPLE_RATE`
  (Vorgabe 24 kHz). Genau das, was `AudioWorklet` im Browser liefert und `AudioBuffer` abspielt.
* **Text** — eine JSON-Zeile mit einem `type`-Feld. Steuerung in beide Richtungen.

Die Abtastraten stehen **nicht** im Protokoll fest, sondern in der ersten Nachricht des Servers
(`ready`). Ein Client, der sie rät, spielt irgendwann Audio in der falschen Geschwindigkeit ab,
und das fällt erst im Betrieb auf.
"""

from __future__ import annotations

import json
from typing import Any

from pipecat.frames.frames import (
    Frame,
    InputAudioRawFrame,
    InputTransportMessageFrame,
    InterruptionFrame,
    OutputAudioRawFrame,
    OutputTransportMessageFrame,
    OutputTransportMessageUrgentFrame,
)
from pipecat.serializers.base_serializer import FrameSerializer

#: Nachrichtentypen Server → Client. Der UI-Client kennt genau diese Liste
#: (`ui/voice/session.ts`); ein unbekannter Typ wird dort ignoriert, nicht geraten.
SERVER_MESSAGE_TYPES = (
    "ready",  # Abtastraten und Modus, einmal nach dem Verbinden
    "state",  # einer der sechs Agentenzustände aus ui/mic/state.ts
    "transcript",  # erkannter Text, `final` unterscheidet Zwischenstand und Endstand
    "reply",  # die Antwort des Agenten als Text (gesprochen wird sie ohnehin)
    "approval",  # eine Freigabeanfrage samt Optionen, wortgleich aus dem Protokoll
    "interrupted",  # der Nutzer hat dazwischengeredet, die Ausgabe ist verworfen
    "latency",  # die Messpunkte eines Zugs (S31)
    "error",  # ein Fehlschlag, im Klartext (AGENTS.md: nie glätten)
)

#: Nachrichtentypen Client → Server.
CLIENT_MESSAGE_TYPES = (
    "hello",  # trägt das gemeinsame Geheimnis; ohne sie bleibt die Brücke stumm
    "utterance",  # nur im Loopback: der Text, den die Stand-in-Erkennung liefern soll
    "answer",  # die Wahl zu einer Freigabeanfrage, per Klick statt per Stimme
    "taste",  # die Sprechtaste: `unten` true/false — gesprochen ist erst, wenn sie oben ist
)


class KuronamiVoiceSerializer(FrameSerializer):
    """Rohes PCM in beide Richtungen, JSON für alles andere."""

    def __init__(
        self,
        *,
        audio_in_sample_rate: int,
        audio_in_channels: int = 1,
        params: FrameSerializer.InputParams | None = None,
    ) -> None:
        super().__init__(params)
        self._audio_in_sample_rate = audio_in_sample_rate
        self._audio_in_channels = audio_in_channels

    async def serialize(self, frame: Frame) -> str | bytes | None:
        """Frame → Draht. `None` heißt: für diesen Frame gibt es nichts zu senden."""
        if self.should_ignore_frame(frame):
            return None

        # `TTSAudioRawFrame` ist eine Unterart von `OutputAudioRawFrame` und deshalb hier
        # miterfasst — die Reihenfolge der Zweige ist kein Zufall.
        if isinstance(frame, OutputAudioRawFrame):
            return frame.audio

        if isinstance(frame, (OutputTransportMessageUrgentFrame, OutputTransportMessageFrame)):
            return json.dumps(frame.message, ensure_ascii=False)

        if isinstance(frame, InterruptionFrame):
            # Der Client hört das Audio ohnehin abreißen. Diese Zeile sagt ihm **warum**, damit
            # er nicht auf ein Ende wartet, das nie kommt.
            return json.dumps({"type": "interrupted"}, ensure_ascii=False)

        return None

    async def deserialize(self, data: str | bytes) -> Frame | None:
        """Draht → Frame. Unlesbares JSON wird zu einem Fehler-Frame, nicht verschluckt."""
        if isinstance(data, (bytes, bytearray, memoryview)):
            return InputAudioRawFrame(
                audio=bytes(data),
                sample_rate=self._audio_in_sample_rate,
                num_channels=self._audio_in_channels,
            )

        try:
            message: Any = json.loads(data)
        except (TypeError, ValueError):
            return InputTransportMessageFrame(
                message={"type": "malformed", "raw": str(data)[:200]},
            )
        if not isinstance(message, dict):
            return InputTransportMessageFrame(message={"type": "malformed", "raw": str(data)[:200]})
        return InputTransportMessageFrame(message=message)


def server_message(kind: str, **fields: Any) -> dict[str, Any]:
    """Baut eine Servernachricht und prüft dabei ihren Typ.

    Ein Tippfehler in einem Nachrichtentyp fiele sonst erst im Browser auf, und zwar als
    Nichts-passiert — der Client ignoriert, was er nicht kennt.
    """
    if kind not in SERVER_MESSAGE_TYPES:
        raise ValueError(f"Unbekannter Nachrichtentyp {kind!r}. Bekannt: {SERVER_MESSAGE_TYPES}")
    return {"type": kind, **fields}
