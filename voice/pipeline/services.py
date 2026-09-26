"""Erkennung und Stimme: die beiden Anbieter (S30) und ihre lokalen Stand-ins.

**Deepgram, Azure und ElevenLabs sind hier angebunden**, und zwar an genau einer Stelle —
`build_stt` und `build_tts`. Dass der Tausch der Stimme am 2026-09-21 wirklich nur diese Datei
kostete, war die Probe aufs Exempel: die Brücke, das
Protokoll und die Messung kennen keinen Anbieternamen.

Die Stand-ins (`LoopbackSTT`, `LoopbackTTS`) sind kein Ersatz für die Anbieter und geben sich auch
nicht dafür aus. Sie existieren, damit die **Eigenschaften des Graphen** — unterbrechbar, wie
schnell, wie robust — geprüft werden können, ohne für jede Wiederholung eine fremde API zu rufen.
Was sie nicht messen können, steht in `voice/README.md` unter "Was unbelegt bleibt": die Laufzeit
der beiden Anbieter selbst.
"""

from __future__ import annotations

import asyncio
import math
import struct
import time
from typing import Any

from loguru import logger
from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    Frame,
    InputTransportMessageFrame,
    InterruptionFrame,
    OutputTransportMessageUrgentFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    TTSSpeakFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from voice.pipeline.config import VoiceConfig
from voice.pipeline.latency import LatencyLedger
from voice.pipeline.protocol import server_message

#: Die Stand-in-Stimme ist ein Sinuston — hörbar, unverwechselbar nicht-menschlich, und in
#: einem Diagramm sofort als "hier lief Audio" zu erkennen.
LOOPBACK_TONE_HZ = 220.0
#: 20-ms-Häppchen. Klein genug, dass ein Barge-in mitten im Wort greift.
LOOPBACK_CHUNK_MS = 20


def build_stt(config: VoiceConfig) -> FrameProcessor:
    """Die Spracherkennung. `live` = Deepgram, sonst der lokale Stand-in."""
    if not config.live:
        return LoopbackSTT(config=config)

    from pipecat.services.deepgram.stt import DeepgramSTTService

    logger.info(
        f"Erkennung: Deepgram {config.deepgram_model}, Sprache {config.deepgram_language}."
    )
    return DeepgramSTTService(
        api_key=config.deepgram_api_key,
        # Leer heißt Deepgrams eigene Adresse. Gesetzt zeigt sie woanders hin — der Weg, auf dem
        # dieselbe Messung später gegen einen anderen Endpunkt läuft, ohne Codeänderung.
        base_url=config.deepgram_base_url,
        sample_rate=config.audio_in_sample_rate,
        encoding="linear16",
        channels=1,
        # `settings=` statt der Einzelparameter: Pipecat hat die alten mit 1.x abgekündigt, und
        # neuer Code soll nicht auf einem Weg stehen, der mit 2.0 wegfällt.
        settings=DeepgramSTTService.Settings(
            language=config.deepgram_language,
            model=config.deepgram_model,
            # Zwischenstände kommen als `InterimTranscriptionFrame` und gehen an den Client —
            # geschrieben wird davon nichts, aber der Nutzer sieht, dass zugehört wird.
            interim_results=True,
            # Die Satzzeichen sind hier keine Kosmetik: die Brücke liest an ihnen ab, ob eine
            # Äußerung zu Ende ist, und wartet länger, wenn sie es nicht ist (`_SATZ_FERTIG`).
            punctuate=True,
            **({"keyterm": list(config.deepgram_keyterms)} if config.deepgram_keyterms else {}),
        ),
    )


def build_tts(config: VoiceConfig) -> FrameProcessor:
    """Die Stimme. `live` = Azure oder ElevenLabs (`VOICE_TTS`), sonst der lokale Stand-in."""
    if not config.live:
        return LoopbackTTS(config=config)
    if config.tts_provider == "azure":
        return _azure_tts(config)
    return _elevenlabs_tts(config)


def _azure_tts(config: VoiceConfig) -> FrameProcessor:
    """Azure Speech, seit 2026-09-21 der Regelweg."""
    from pipecat.services.azure.tts import AzureTTSService

    logger.info(f"Stimme: Azure, {config.azure_speech_voice} ({config.azure_speech_region}).")
    return AzureTTSService(
        api_key=config.azure_speech_key,
        region=config.azure_speech_region,
        sample_rate=config.audio_out_sample_rate,
        settings=AzureTTSService.Settings(
            voice=config.azure_speech_voice,
            language=config.azure_speech_language,
            # **`force_locale` bleibt aus, und das ist der Punkt der ganzen Umstellung.**
            #
            # Eingeschaltet presst Azure den ganzen Text in die eingestellte Sprache und
            # schaltet die Umschaltung je Abschnitt ab. Kuro redet aber über Backtests,
            # Drawdowns und Buy-and-Hold in deutschen Sätzen; genau dieses Gemisch soll die
            # multilinguale Stimme abschnittsweise richtig aussprechen. Wer hier später ein
            # `True` einsetzt, weil „die Stimme soll doch deutsch sprechen", holt sich den
            # Fehler vom 2026-09-21 zurück — nur mit umgekehrtem Vorzeichen.
            force_locale=False,
        ),
    )


def _elevenlabs_tts(config: VoiceConfig) -> FrameProcessor:
    """ElevenLabs — der bisherige Weg, erhalten für den Vergleich."""
    from pipecat.services.elevenlabs.tts import ElevenLabsTTSService

    logger.info(f"Stimme: ElevenLabs, Modell {config.elevenlabs_model}.")
    return ElevenLabsTTSService(
        api_key=config.elevenlabs_api_key,
        url=config.elevenlabs_url,
        sample_rate=config.audio_out_sample_rate,
        # Wie bei Deepgram: `settings=` statt der mit 1.x abgekündigten Einzelparameter.
        settings=ElevenLabsTTSService.Settings(
            voice=config.elevenlabs_voice_id,
            model=config.elevenlabs_model,
        ),
    )


class LoopbackSTT(FrameProcessor):
    """Erkennung ohne Anbieter: liefert am Ende einer Äußerung einen festen Text.

    Welchen, bestimmt der Client mit einer `utterance`-Nachricht — sonst der Satz aus
    `VOICE_LOOPBACK_TRANSCRIPT`. Damit ist eine Messung wiederholbar: dieselbe Eingabe, dasselbe
    Transkript, und Unterschiede in der Zahl kommen aus der Pipeline und nicht aus der Erkennung.
    """

    def __init__(self, *, config: VoiceConfig, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._config = config
        self._next_text: str | None = None

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)

        if isinstance(frame, InputTransportMessageFrame):
            message = frame.message
            if isinstance(message, dict) and message.get("type") == "utterance":
                text = message.get("text")
                if isinstance(text, str):
                    self._next_text = text
            return

        if isinstance(frame, VADUserStoppedSpeakingFrame):
            text = self._next_text or self._config.loopback_transcript
            self._next_text = None
            await self.push_frame(
                TranscriptionFrame(
                    text=text,
                    user_id="loopback",
                    timestamp=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                    finalized=True,
                ),
                FrameDirection.DOWNSTREAM,
            )


class LoopbackTTS(FrameProcessor):
    """Stimme ohne Anbieter: ein Ton in der Länge, die der Satz brauchen würde.

    Die Länge ist kein Schmuck. Ohne genug Audio gäbe es nichts zu unterbrechen, und der
    Barge-in-Test prüfte eine Stille.
    """

    def __init__(self, *, config: VoiceConfig, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._config = config
        self._speaking: asyncio.Task[None] | None = None

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, TTSSpeakFrame):
            # Der Sprechauftrag selbst geht nicht weiter — ab hier ist er Audio.
            await self._start_speaking(frame.text)
            return

        await self.push_frame(frame, direction)

        if isinstance(frame, (InterruptionFrame, CancelFrame, EndFrame)):
            await self._stop_speaking()

    async def _start_speaking(self, text: str) -> None:
        await self._stop_speaking()
        self._speaking = self.create_task(self._speak(text))

    async def _stop_speaking(self) -> None:
        task = self._speaking
        self._speaking = None
        if task is not None and not task.done():
            await self.cancel_task(task)

    async def _speak(self, text: str) -> None:
        words = max(1, len(text.split()))
        seconds = words * self._config.loopback_secs_per_word
        rate = self._config.audio_out_sample_rate
        chunk_samples = int(rate * LOOPBACK_CHUNK_MS / 1000)
        total_chunks = max(1, int(seconds * 1000 / LOOPBACK_CHUNK_MS))

        await self.push_frame(TTSStartedFrame(), FrameDirection.DOWNSTREAM)
        phase = 0
        for _ in range(total_chunks):
            samples = bytearray()
            for index in range(chunk_samples):
                angle = 2 * math.pi * LOOPBACK_TONE_HZ * (phase + index) / rate
                samples += struct.pack("<h", int(12000 * math.sin(angle)))
            phase += chunk_samples
            await self.push_frame(
                TTSAudioRawFrame(audio=bytes(samples), sample_rate=rate, num_channels=1),
                FrameDirection.DOWNSTREAM,
            )
            # Dem Ereignisschleifen-Takt Luft lassen: ohne diese Zeile erzeugt ein langer Satz
            # sein ganzes Audio in einem Stück, und ein Barge-in käme erst danach an die Reihe.
            await asyncio.sleep(0)
        await self.push_frame(TTSStoppedFrame(), FrameDirection.DOWNSTREAM)


class LatencyProbe(FrameProcessor):
    """Steht **hinter** der Stimme, markiert das erste Audio-Byte eines Zugs und meldet ihn.

    Warum ein eigener Prozessor: die Brücke liegt vor der Stimme, an ihr kommt das erzeugte Audio
    nie vorbei. Die Marke dort zu setzen, wo der Sprechauftrag rausgeht, wäre die Messung "wie
    lange braucht die Brücke" und nicht "wann hört der Nutzer etwas".

    Und warum der Bericht **hier** hinausgeht und nicht in der Brücke: die Brücke ist fertig,
    sobald sie gesprochen hat — zu diesem Zeitpunkt gibt es noch kein Audio, und ihr Bericht
    trüge genau an der entscheidenden Stelle ein Loch. Gemeldet wird in dem Augenblick, in dem
    die Zahl vollständig ist.
    """

    def __init__(self, *, ledger: LatencyLedger, budget_ms: int, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._ledger = ledger
        self._budget_ms = budget_ms
        self._reported_turn: str | None = None

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)

        if not isinstance(frame, TTSAudioRawFrame):
            return

        turn = self._ledger.current
        if turn is None or turn.turn_id == self._reported_turn:
            return
        self._ledger.mark("first_audio")
        self._reported_turn = turn.turn_id
        report = turn.report(self._budget_ms)
        logger.info(
            f"Latenz: Sprachschicht {report['voice_layer_ms']} ms "
            f"(Budget {self._budget_ms} ms), gesamt {report['total_ms']} ms."
        )
        await self.push_frame(
            OutputTransportMessageUrgentFrame(message=server_message("latency", **report)),
            FrameDirection.DOWNSTREAM,
        )
