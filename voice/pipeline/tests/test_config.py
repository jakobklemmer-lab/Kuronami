"""Die Konfiguration bricht ab, statt zu raten."""

from __future__ import annotations

import pytest

from voice.pipeline.config import ConfigError, config_from_env

BASE = {
    "VOICE_SESSION_TOKEN": "sitzung",
    "VOICE_BRIDGE_TOKEN": "bruecke",
}

LIVE = {
    **BASE,
    "DEEPGRAM_API_KEY": "dg-geheim-4711",
    "ELEVENLABS_API_KEY": "el-geheim-0815",
    "ELEVENLABS_VOICE_ID": "stimme",
}


def test_live_braucht_beide_anbieter() -> None:
    with pytest.raises(ConfigError) as error:
        config_from_env({**BASE, "VOICE_MODE": "live"})
    message = str(error.value)
    assert "DEEPGRAM_API_KEY" in message
    assert "ELEVENLABS_API_KEY" in message
    assert "ELEVENLABS_VOICE_ID" in message


def test_loopback_braucht_keine_anbieter() -> None:
    config = config_from_env({**BASE, "VOICE_MODE": "loopback"})
    assert config.mode == "loopback"
    assert config.live is False


def test_ohne_sitzungsgeheimnis_kein_start() -> None:
    with pytest.raises(ConfigError) as error:
        config_from_env({"VOICE_BRIDGE_TOKEN": "b", "VOICE_MODE": "loopback"})
    assert "VOICE_SESSION_TOKEN" in str(error.value)


def test_ohne_bruecken_token_kein_start() -> None:
    with pytest.raises(ConfigError) as error:
        config_from_env({"VOICE_SESSION_TOKEN": "s", "VOICE_MODE": "loopback"})
    assert "VOICE_BRIDGE_TOKEN" in str(error.value)


def test_unbekannter_modus_wird_abgewiesen() -> None:
    with pytest.raises(ConfigError):
        config_from_env({**BASE, "VOICE_MODE": "halblive"})


def test_vorgaben_stehen_fest() -> None:
    config = config_from_env({**LIVE})
    assert config.mode == "live"
    assert config.host == "127.0.0.1"
    assert config.port == 8790
    assert config.audio_in_sample_rate == 16000
    assert config.audio_out_sample_rate == 24000
    assert config.latency_budget_ms == 800
    assert config.gateway_url == "http://127.0.0.1:8788"


def test_beschreibung_nennt_keinen_schluessel() -> None:
    config = config_from_env({**LIVE})
    text = config.describe()
    assert "dg-geheim-4711" not in text
    assert "el-geheim-0815" not in text
    assert "Deepgram" in text and "ElevenLabs" in text


def test_zahlenwert_muss_eine_zahl_sein() -> None:
    with pytest.raises(ConfigError):
        config_from_env({**LIVE, "VOICE_PORT": "achtzig"})


def test_gateway_url_ohne_abschliessenden_schraegstrich() -> None:
    config = config_from_env({**LIVE, "VOICE_GATEWAY_URL": "http://gateway:8788/"})
    assert config.gateway_url == "http://gateway:8788"
