"""Der Sprachprozess (S30/S31) — ein eigener Prozess hinter dem Gateway, wie Abschnitt 4.1 sagt.

Er teilt keinen Code mit der Runtime und spricht mit ihr nur über HTTP (`gateway.py`). Das ist die
einzige Ausnahme von "TypeScript auf Node" im ganzen System, und sie hat genau einen Grund:
Pipecat, und damit Python. Die Grenze ist ein Prozess, kein zweiter Stack im Kern.

Der Graph:

    transport.input()      rohes PCM aus dem WebSocket
      → VADProcessor       Silero: wer redet gerade, und seit wann
      → STT                Deepgram (live) oder Stand-in (loopback)
      → KuronamiBridge     Transkript → Gateway → Antworttext, und der Barge-in
      → TTS                ElevenLabs (live) oder Stand-in (loopback)
      → LatencyProbe       markiert das erste Audio-Byte eines Zugs
      → transport.output() PCM zurück in den WebSocket

Die Reihenfolge ist keine Geschmacksfrage. Das VAD muss vor der Erkennung liegen (sonst gäbe es
keinen Zeitpunkt "Nutzer hat aufgehört"), die Brücke zwischen Erkennung und Stimme (sie übersetzt
das eine ins andere), und die Messsonde hinter die Stimme (davor gäbe es kein Audio zu messen).
"""

from __future__ import annotations

import asyncio
import sys
from dataclasses import dataclass

from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker, ProcessorUnusablePolicy
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.transports.websocket.server import (
    SingleClientWebsocketServerParams,
    SingleClientWebsocketServerTransport,
)
from pipecat.workers.runner import WorkerRunner

from voice.pipeline.bridge import KuronamiBridge
from voice.pipeline.config import ConfigError, VoiceConfig, config_from_env
from voice.pipeline.gateway import GatewayClient, HttpGatewayClient
from voice.pipeline.latency import LatencyLedger
from voice.pipeline.protocol import KuronamiVoiceSerializer
from voice.pipeline.services import LatencyProbe, build_stt, build_tts
from voice.pipeline.vad import EnergyVADAnalyzer


@dataclass
class VoiceApp:
    """Die fertig verdrahtete Sprachschicht. Getrennt vom Starten, damit ein Test den Graphen
    bauen kann, ohne einen Port zu öffnen — genau das ist der Nachweis für "Pipecat läuft"."""

    config: VoiceConfig
    transport: SingleClientWebsocketServerTransport
    pipeline: Pipeline
    task: PipelineWorker
    bridge: KuronamiBridge
    ledger: LatencyLedger
    client: GatewayClient
    #: Die Prozessoren in ihrer Reihenfolge. Steht hier, damit ein Test den Graphen prüfen kann,
    #: ohne in Pipecats Innereien zu greifen — die Reihenfolge ist eine Zusage dieser Datei.
    processors: list[FrameProcessor]


def build_app(config: VoiceConfig, *, client: GatewayClient | None = None) -> VoiceApp:
    """Baut den Graphen. Öffnet noch keinen Port und ruft noch keinen Anbieter."""
    ledger = LatencyLedger()

    serializer = KuronamiVoiceSerializer(audio_in_sample_rate=config.audio_in_sample_rate)
    transport = SingleClientWebsocketServerTransport(
        params=SingleClientWebsocketServerParams(
            audio_in_enabled=True,
            audio_in_sample_rate=config.audio_in_sample_rate,
            audio_out_enabled=True,
            audio_out_sample_rate=config.audio_out_sample_rate,
            add_wav_header=False,
            serializer=serializer,
            allowed_origins=list(config.allowed_origins),
        ),
        host=config.host,
        port=config.port,
    )

    vad_params = VADParams(
        confidence=config.vad_confidence,
        start_secs=config.vad_start_secs,
        stop_secs=config.vad_stop_secs,
        min_volume=config.vad_min_volume,
    )
    # Silero im Betrieb, Energie auf dem Messstand — der Unterschied und sein Grund stehen in
    # `vad.py`. Die Zeitzählung (`start_secs`/`stop_secs`) ist in beiden Fällen dieselbe.
    analyzer = (
        EnergyVADAnalyzer(
            sample_rate=config.audio_in_sample_rate,
            params=vad_params,
            threshold=config.vad_energy_threshold,
        )
        if config.vad_kind == "energy"
        else SileroVADAnalyzer(sample_rate=config.audio_in_sample_rate, params=vad_params)
    )
    vad = VADProcessor(vad_analyzer=analyzer)

    gateway_client = client or HttpGatewayClient(
        base_url=config.gateway_url,
        token=config.gateway_token,
        timeout_secs=config.gateway_timeout_secs,
    )

    bridge = KuronamiBridge(config=config, client=gateway_client, ledger=ledger)
    probe = LatencyProbe(ledger=ledger, budget_ms=config.latency_budget_ms)

    processors: list[FrameProcessor] = [
        transport.input(),
        vad,
        build_stt(config),
        bridge,
        build_tts(config),
        probe,
        transport.output(),
    ]
    pipeline = Pipeline(processors)

    task = PipelineWorker(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=config.audio_in_sample_rate,
            audio_out_sample_rate=config.audio_out_sample_rate,
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
        # Ein Sprachkanal, an dem gerade niemand redet, ist kein hängender Lauf. Ohne diese
        # Zeile beendete Pipecat die Sitzung nach fünf Minuten Stille.
        idle_timeout_secs=None,
        # RTVI ist Pipecats eigenes Client-Protokoll. Wir sprechen unser eigenes (protocol.py),
        # und zwei Protokolle auf demselben Draht wären eine Quelle für Nachrichten, die der
        # UI-Client nicht versteht.
        enable_rtvi=False,
        # Gibt Deepgram nach drei Wiederverbindungen auf, bleibt der Erkenner sonst tot, während
        # der Prozess weiterläuft (01.10.). Abbrechen beendet den Prozess, Docker startet neu.
        processor_unusable_policy=ProcessorUnusablePolicy.CANCEL,
    )

    return VoiceApp(
        config=config,
        transport=transport,
        pipeline=pipeline,
        task=task,
        bridge=bridge,
        ledger=ledger,
        client=gateway_client,
        processors=processors,
    )


async def run(config: VoiceConfig) -> None:
    """Baut und fährt. Läuft, bis der Prozess ein Signal bekommt."""
    app = build_app(config)
    logger.info(f"Sprachschicht: {config.describe()}")

    @app.transport.event_handler("on_client_connected")
    async def _on_connected(_transport, _client) -> None:  # type: ignore[no-untyped-def]
        logger.info("Client verbunden — wartet auf hello.")

    @app.transport.event_handler("on_client_disconnected")
    async def _on_disconnected(_transport, _client) -> None:  # type: ignore[no-untyped-def]
        logger.info("Client getrennt.")

    runner = WorkerRunner(handle_sigint=True, handle_sigterm=True)
    await runner.add_workers(app.task)
    try:
        await runner.run()
    finally:
        await app.client.close()


def main() -> int:
    try:
        config = config_from_env()
    except ConfigError as error:
        # Dieselbe Haltung wie im Gateway: lieber hier abbrechen als später schweigen.
        logger.error(str(error))
        return 1
    asyncio.run(run(config))
    return 0


if __name__ == "__main__":
    sys.exit(main())
