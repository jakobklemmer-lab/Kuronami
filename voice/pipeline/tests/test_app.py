"""Der Graph steht — und zwar mit Deepgram und ElevenLabs darin (Fertig-Kriterium S30).

Dieser Test ist der Nachweis für "angebunden": im Live-Modus stehen die beiden echten Dienste an
ihrer Stelle im Graphen, mit den Werten aus der Konfiguration. Er ruft **nicht** bei den Anbietern
an — das braucht Schlüssel und kostet Geld, und keines von beidem ist Teil dieser Aussage. Was er
zeigt, ist genau das, was hier zu zeigen ist: die Verdrahtung stimmt und trägt.
"""

from __future__ import annotations

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService

from voice.pipeline.app import build_app
from voice.pipeline.bridge import KuronamiBridge
from voice.pipeline.config import config_from_env
from voice.pipeline.protocol import KuronamiVoiceSerializer
from voice.pipeline.services import LatencyProbe, LoopbackSTT, LoopbackTTS

LIVE_ENV = {
    "VOICE_MODE": "live",
    "VOICE_TTS": "elevenlabs",
    "VOICE_SESSION_TOKEN": "sitzung",
    "VOICE_BRIDGE_TOKEN": "bruecke",
    "DEEPGRAM_API_KEY": "dg-test",
    "ELEVENLABS_API_KEY": "el-test",
    "ELEVENLABS_VOICE_ID": "stimme-1",
    # Ein freier Port, der nie geöffnet wird — `build_app` bindet nichts.
    "VOICE_PORT": "8799",
}

AZURE_ENV = {
    "VOICE_MODE": "live",
    "VOICE_SESSION_TOKEN": "sitzung",
    "VOICE_BRIDGE_TOKEN": "bruecke",
    "DEEPGRAM_API_KEY": "dg-test",
    "AZURE_SPEECH_KEY": "az-test",
    "AZURE_SPEECH_REGION": "westeurope",
    "VOICE_PORT": "8799",
}

LOOPBACK_ENV = {
    "VOICE_MODE": "loopback",
    "VOICE_SESSION_TOKEN": "sitzung",
    "VOICE_BRIDGE_TOKEN": "bruecke",
}


class NoGateway:
    async def turn(self, text: str, external_id: str):  # pragma: no cover - nie gerufen
        raise AssertionError("Dieser Test ruft kein Backend.")

    async def answer(self, ask_id: str, choice_id: str, external_id: str):  # pragma: no cover
        raise AssertionError("Dieser Test ruft kein Backend.")

    async def close(self) -> None:
        return None


def test_azure_graph_enthaelt_deepgram_und_azure() -> None:
    """Der Regelweg seit 2026-09-21 — und der Beleg, dass nur `build_tts` getauscht wurde.

    Geprüft wird der Graph, nicht die Konfiguration: dass ein Schlüssel ankommt, sagt noch
    nicht, dass die Stimme in der Pipeline steht. Gesprochen wird hier nichts, der
    Azure-Dienst verbindet sich erst beim ersten Satz.
    """
    from pipecat.services.azure.tts import AzureTTSService

    app = build_app(config_from_env(AZURE_ENV), client=NoGateway())
    kinds = [type(processor) for processor in app.processors]

    assert DeepgramSTTService in kinds, "Die Erkennung bleibt Deepgram."
    assert AzureTTSService in kinds, "Die Stimme ist Azure."
    assert ElevenLabsTTSService not in kinds, "Zwei Stimmen in einem Graphen wären eine zu viel."
    assert VADProcessor in kinds and KuronamiBridge in kinds, "Der Rest bleibt, wie er war."


def test_live_graph_enthaelt_deepgram_und_elevenlabs() -> None:
    app = build_app(config_from_env(LIVE_ENV), client=NoGateway())
    kinds = [type(processor) for processor in app.processors]

    assert DeepgramSTTService in kinds, "Die Erkennung ist Deepgram."
    assert ElevenLabsTTSService in kinds, "Die Stimme ist ElevenLabs."
    assert VADProcessor in kinds, "Ohne VAD gäbe es kein Unterbrechen."
    assert KuronamiBridge in kinds, "Ohne Brücke gäbe es kein Backend."
    assert LatencyProbe in kinds, "Ohne Messsonde gäbe es keine Zahl."


def test_reihenfolge_des_graphen_ist_die_zugesagte() -> None:
    app = build_app(config_from_env(LIVE_ENV), client=NoGateway())
    namen = [type(processor).__name__ for processor in app.processors]
    assert namen == [
        "SingleClientWebsocketServerInputTransport",
        "VADProcessor",
        "DeepgramSTTService",
        "KuronamiBridge",
        "ElevenLabsTTSService",
        "LatencyProbe",
        "SingleClientWebsocketServerOutputTransport",
    ]


def test_vad_ist_silero_mit_den_eingestellten_werten() -> None:
    app = build_app(
        config_from_env({**LIVE_ENV, "VOICE_VAD_STOP_SECS": "0.35"}), client=NoGateway()
    )
    vad = next(p for p in app.processors if isinstance(p, VADProcessor))
    analyzer = vad._vad_controller._vad_analyzer  # noqa: SLF001 — es gibt keinen Lesepfad
    assert isinstance(analyzer, SileroVADAnalyzer)
    assert analyzer.params.stop_secs == 0.35


def test_transport_spricht_unser_protokoll() -> None:
    app = build_app(config_from_env(LIVE_ENV), client=NoGateway())
    serializer = app.transport.input()._params.serializer  # noqa: SLF001
    assert isinstance(serializer, KuronamiVoiceSerializer)


def test_loopback_graph_hat_dieselbe_form_mit_stand_ins() -> None:
    app = build_app(config_from_env(LOOPBACK_ENV), client=NoGateway())
    namen = [type(processor).__name__ for processor in app.processors]
    assert namen == [
        "SingleClientWebsocketServerInputTransport",
        "VADProcessor",
        "LoopbackSTT",
        "KuronamiBridge",
        "LoopbackTTS",
        "LatencyProbe",
        "SingleClientWebsocketServerOutputTransport",
    ]
    assert any(isinstance(p, LoopbackSTT) for p in app.processors)
    assert any(isinstance(p, LoopbackTTS) for p in app.processors)
