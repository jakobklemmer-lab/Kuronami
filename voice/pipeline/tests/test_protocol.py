"""Das Draht-Protokoll: PCM bleibt PCM, JSON bleibt JSON, Unbekanntes wird nichts."""

from __future__ import annotations

import json

import pytest
from pipecat.frames.frames import (
    InputAudioRawFrame,
    InputTransportMessageFrame,
    InterruptionFrame,
    OutputAudioRawFrame,
    OutputTransportMessageUrgentFrame,
    StartFrame,
    TTSAudioRawFrame,
)

from voice.pipeline.protocol import KuronamiVoiceSerializer, server_message



def serializer() -> KuronamiVoiceSerializer:
    return KuronamiVoiceSerializer(audio_in_sample_rate=16000)


async def test_binaer_wird_eingehendes_audio() -> None:
    frame = await serializer().deserialize(b"\x01\x02\x03\x04")
    assert isinstance(frame, InputAudioRawFrame)
    assert frame.audio == b"\x01\x02\x03\x04"
    assert frame.sample_rate == 16000
    assert frame.num_channels == 1


async def test_text_wird_eine_client_nachricht() -> None:
    frame = await serializer().deserialize(json.dumps({"type": "hello", "token": "x"}))
    assert isinstance(frame, InputTransportMessageFrame)
    assert frame.message == {"type": "hello", "token": "x"}


async def test_kaputtes_json_wird_nicht_verschluckt() -> None:
    frame = await serializer().deserialize("{nicht wirklich json")
    assert isinstance(frame, InputTransportMessageFrame)
    assert frame.message["type"] == "malformed"


async def test_ausgehendes_audio_geht_roh_hinaus() -> None:
    data = await serializer().serialize(
        OutputAudioRawFrame(audio=b"\x07\x08", sample_rate=24000, num_channels=1)
    )
    assert data == b"\x07\x08"


async def test_tts_audio_zaehlt_als_ausgehendes_audio() -> None:
    # `TTSAudioRawFrame` ist eine Unterart von `OutputAudioRawFrame`. Ginge die Reihenfolge der
    # Zweige verloren, käme die Stimme nie beim Client an.
    data = await serializer().serialize(
        TTSAudioRawFrame(audio=b"\x09", sample_rate=24000, num_channels=1)
    )
    assert data == b"\x09"


async def test_steuernachricht_wird_json() -> None:
    data = await serializer().serialize(
        OutputTransportMessageUrgentFrame(message={"type": "state", "state": "thinking"})
    )
    assert isinstance(data, str)
    assert json.loads(data) == {"type": "state", "state": "thinking"}


async def test_unterbrechung_wird_angesagt() -> None:
    data = await serializer().serialize(InterruptionFrame())
    assert isinstance(data, str)
    assert json.loads(data)["type"] == "interrupted"


async def test_unbekannter_frame_erzeugt_nichts() -> None:
    assert await serializer().serialize(StartFrame()) is None


async def test_umlaute_bleiben_umlaute() -> None:
    data = await serializer().serialize(
        OutputTransportMessageUrgentFrame(message={"type": "reply", "text": "Grüße"})
    )
    assert isinstance(data, str)
    assert "Grüße" in data


def test_unbekannter_nachrichtentyp_faellt_sofort_auf() -> None:
    with pytest.raises(ValueError):
        server_message("statuss", state="idle")
