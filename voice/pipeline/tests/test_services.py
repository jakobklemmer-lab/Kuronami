"""Stand-ins, Messsonde und der zweite Sprachdetektor."""

from __future__ import annotations

import math
import struct

from pipecat.audio.vad.vad_analyzer import VADParams, VADState
from pipecat.frames.frames import (
    InputTransportMessageFrame,
    InterruptionFrame,
    OutputTransportMessageUrgentFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    TTSSpeakFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.tests.utils import SleepFrame, run_test

from voice.pipeline.config import config_from_env
from voice.pipeline.latency import LatencyLedger
from voice.pipeline.services import LatencyProbe, LoopbackSTT, LoopbackTTS
from voice.pipeline.vad import EnergyVADAnalyzer

LOOPBACK = {
    "VOICE_MODE": "loopback",
    "VOICE_SESSION_TOKEN": "s",
    "VOICE_BRIDGE_TOKEN": "b",
}

RATE = 16000


def loud(ms: int, amplitude: int = 9000) -> bytes:
    count = int(RATE * ms / 1000)
    return b"".join(
        struct.pack("<h", int(amplitude * math.sin(2 * math.pi * 180 * i / RATE)))
        for i in range(count)
    )


def quiet(ms: int) -> bytes:
    return b"\x00\x00" * int(RATE * ms / 1000)


async def test_loopback_stt_liefert_am_ende_der_aeusserung_ein_transkript() -> None:
    config = config_from_env({**LOOPBACK, "VOICE_LOOPBACK_TRANSCRIPT": "Vorgabesatz"})
    down, _up = await run_test(
        LoopbackSTT(config=config),
        frames_to_send=[VADUserStoppedSpeakingFrame(), SleepFrame(sleep=0.05)],
        expected_down_frames=None,
    )
    transcripts = [frame.text for frame in down if isinstance(frame, TranscriptionFrame)]
    assert transcripts == ["Vorgabesatz"]


async def test_der_client_bestimmt_den_text_und_zwar_genau_einmal() -> None:
    config = config_from_env({**LOOPBACK, "VOICE_LOOPBACK_TRANSCRIPT": "Vorgabesatz"})
    down, _up = await run_test(
        LoopbackSTT(config=config),
        frames_to_send=[
            InputTransportMessageFrame(message={"type": "utterance", "text": "Mein Satz"}),
            VADUserStoppedSpeakingFrame(),
            SleepFrame(sleep=0.05),
            VADUserStoppedSpeakingFrame(),
            SleepFrame(sleep=0.05),
        ],
        expected_down_frames=None,
    )
    transcripts = [frame.text for frame in down if isinstance(frame, TranscriptionFrame)]
    # Der zweite Zug bekommt wieder die Vorgabe — ein einmal gesetzter Satz wäre sonst für den
    # Rest der Sitzung die Antwort auf alles.
    assert transcripts == ["Mein Satz", "Vorgabesatz"]


async def test_loopback_tts_erzeugt_hoerbares_audio() -> None:
    config = config_from_env({**LOOPBACK, "VOICE_LOOPBACK_SECS_PER_WORD": "0.1"})
    down, _up = await run_test(
        LoopbackTTS(config=config),
        frames_to_send=[TTSSpeakFrame(text="eins zwei drei"), SleepFrame(sleep=0.3)],
        expected_down_frames=None,
    )
    audio = [frame for frame in down if isinstance(frame, TTSAudioRawFrame)]
    assert len(audio) >= 10, "0,3 s Ton in 20-ms-Häppchen sind mindestens 15 Blöcke."
    assert all(frame.sample_rate == 24000 for frame in audio)
    assert any(any(byte != 0 for byte in frame.audio) for frame in audio)


async def test_loopback_tts_hoert_beim_unterbrechen_auf() -> None:
    config = config_from_env({**LOOPBACK, "VOICE_LOOPBACK_SECS_PER_WORD": "2.0"})
    down, _up = await run_test(
        LoopbackTTS(config=config),
        frames_to_send=[
            TTSSpeakFrame(text="ein sehr langer satz mit vielen woertern"),
            SleepFrame(sleep=0.05),
            InterruptionFrame(),
            SleepFrame(sleep=0.3),
        ],
        expected_down_frames=None,
    )
    audio = [frame for frame in down if isinstance(frame, TTSAudioRawFrame)]
    # Acht Wörter à 2 s sind 16 s Ton, also 800 Blöcke à 20 ms. Wie viele davon in den 50 ms vor
    # der Unterbrechung entstehen, hängt von der Maschine ab — dass der Rest **nicht** mehr
    # entsteht, hängt nicht davon ab. Deshalb eine Grenze, die den Unterschied zeigt und nicht
    # die Taktrate misst.
    assert len(audio) < 400, f"Nach der Unterbrechung kamen noch {len(audio)} von 800 Blöcken."


async def test_messsonde_meldet_beim_ersten_audio_byte() -> None:
    ledger = LatencyLedger()
    ledger.begin("t1")
    ledger.mark("speech_stopped")
    ledger.mark("transcript_final")
    ledger.mark("gateway_sent")
    ledger.mark("gateway_replied")
    ledger.mark("speech_queued")

    probe = LatencyProbe(ledger=ledger, budget_ms=800)
    down, _up = await run_test(
        probe,
        frames_to_send=[
            TTSAudioRawFrame(audio=b"\x00\x01", sample_rate=24000, num_channels=1),
            TTSAudioRawFrame(audio=b"\x00\x02", sample_rate=24000, num_channels=1),
            SleepFrame(sleep=0.05),
        ],
        expected_down_frames=None,
    )
    reports = [
        frame.message
        for frame in down
        if isinstance(frame, OutputTransportMessageUrgentFrame)
        and frame.message.get("type") == "latency"
    ]
    assert len(reports) == 1, "Ein Zug, ein Bericht — nicht einer je Audio-Block."
    assert reports[0]["turn_id"] == "t1"
    assert reports[0]["total_ms"] is not None
    assert reports[0]["within_budget"] is True


async def test_messsonde_reicht_das_audio_weiter() -> None:
    ledger = LatencyLedger()
    ledger.begin("t1")
    probe = LatencyProbe(ledger=ledger, budget_ms=800)
    down, _up = await run_test(
        probe,
        frames_to_send=[
            TTSAudioRawFrame(audio=b"\x00\x01", sample_rate=24000, num_channels=1),
            SleepFrame(sleep=0.05),
        ],
        expected_down_frames=None,
    )
    assert any(isinstance(frame, TTSAudioRawFrame) for frame in down)


async def test_energie_detektor_erkennt_lauten_ton_als_stimme() -> None:
    analyzer = EnergyVADAnalyzer(
        sample_rate=RATE,
        params=VADParams(confidence=0.7, start_secs=0.2, stop_secs=0.2, min_volume=0.0),
    )
    analyzer.set_sample_rate(RATE)
    block = analyzer.num_frames_required() * 2
    data = loud(600)
    state = VADState.QUIET
    for offset in range(0, len(data) - block, block):
        state = await analyzer.analyze_audio(data[offset : offset + block])
    assert state == VADState.SPEAKING


async def test_energie_detektor_haelt_stille_fuer_stille() -> None:
    analyzer = EnergyVADAnalyzer(
        sample_rate=RATE,
        params=VADParams(confidence=0.7, start_secs=0.2, stop_secs=0.2, min_volume=0.0),
    )
    analyzer.set_sample_rate(RATE)
    block = analyzer.num_frames_required() * 2
    data = quiet(600)
    state = VADState.QUIET
    for offset in range(0, len(data) - block, block):
        state = await analyzer.analyze_audio(data[offset : offset + block])
    assert state == VADState.QUIET


def test_energie_detektor_nutzt_sileros_blockgroesse() -> None:
    # Die Zeitzählung (`start_secs`/`stop_secs`) läuft in der Basisklasse über Blöcke. Eine
    # andere Blockgröße hieße: eine andere Anlaufzeit bei gleicher Einstellung — und damit wäre
    # die Messung nicht mehr auf den Betrieb übertragbar.
    analyzer = EnergyVADAnalyzer(sample_rate=RATE)
    analyzer.set_sample_rate(RATE)
    assert analyzer.num_frames_required() == 512
