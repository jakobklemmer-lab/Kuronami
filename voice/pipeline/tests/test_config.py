"""Die Konfiguration bricht ab, statt zu raten."""

from __future__ import annotations

import pytest

from voice.pipeline.config import ConfigError, config_from_env

BASE = {
    "VOICE_SESSION_TOKEN": "sitzung",
    "VOICE_BRIDGE_TOKEN": "bruecke",
}

#: Der bisherige Weg. Seit der Anbieterwahl (2026-09-21) muss er sich ausdrücklich nennen —
#: die Vorgabe ist Azure.
LIVE = {
    **BASE,
    "VOICE_TTS": "elevenlabs",
    "DEEPGRAM_API_KEY": "dg-geheim-4711",
    "ELEVENLABS_API_KEY": "el-geheim-0815",
    "ELEVENLABS_VOICE_ID": "stimme",
}

LIVE_AZURE = {
    **BASE,
    "DEEPGRAM_API_KEY": "dg-geheim-4711",
    "AZURE_SPEECH_KEY": "az-geheim-2342",
    "AZURE_SPEECH_REGION": "westeurope",
}


def test_live_braucht_beide_anbieter() -> None:
    with pytest.raises(ConfigError) as error:
        config_from_env({**BASE, "VOICE_MODE": "live", "VOICE_TTS": "elevenlabs"})
    message = str(error.value)
    assert "DEEPGRAM_API_KEY" in message
    assert "ELEVENLABS_API_KEY" in message
    assert "ELEVENLABS_VOICE_ID" in message


def test_azure_ist_die_vorgabe() -> None:
    config = config_from_env({**LIVE_AZURE})
    assert config.tts_provider == "azure"
    assert config.azure_speech_region == "westeurope"


def test_azure_stimme_ist_multilingual_vorbelegt() -> None:
    """Die Vorgabe entscheidet, ob „Backtest" englisch klingt — deshalb steht sie im Test.

    Eine einsprachig deutsche Stimme wäre derselbe Fehler wie die englische „George" vom
    2026-09-21, nur mit umgekehrtem Vorzeichen.
    """
    config = config_from_env({**LIVE_AZURE})
    assert config.azure_speech_voice == "de-DE-FlorianMultilingualNeural"
    assert config.azure_speech_language == "de-DE"


def test_azure_verlangt_seine_eigenen_schluessel() -> None:
    with pytest.raises(ConfigError) as error:
        config_from_env({**BASE, "VOICE_MODE": "live", "DEEPGRAM_API_KEY": "dg"})
    message = str(error.value)
    assert "AZURE_SPEECH_KEY" in message
    assert "AZURE_SPEECH_REGION" in message


def test_der_ungenutzte_anbieter_ist_keine_startbedingung() -> None:
    """Azure läuft ohne ElevenLabs-Schlüssel — und umgekehrt.

    Beides zu verlangen hieße, den Wechsel an dem Konto scheitern zu lassen, das man gerade
    verlässt. Am 2026-09-21 klebte genau dieses Konto am Zeichenlimit.
    """
    azure = config_from_env({**LIVE_AZURE})
    assert azure.elevenlabs_api_key == ""
    eleven = config_from_env({**LIVE})
    assert eleven.azure_speech_key == ""


def test_unbekannter_stimmanbieter_wird_abgewiesen() -> None:
    with pytest.raises(ConfigError) as error:
        config_from_env({**LIVE_AZURE, "VOICE_TTS": "papagei"})
    assert "VOICE_TTS" in str(error.value)


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


def test_beschreibung_nennt_die_azure_stimme_aber_nicht_den_schluessel() -> None:
    text = config_from_env({**LIVE_AZURE}).describe()
    assert "az-geheim-2342" not in text
    assert "Azure" in text
    assert "de-DE-FlorianMultilingualNeural" in text


def test_zahlenwert_muss_eine_zahl_sein() -> None:
    with pytest.raises(ConfigError):
        config_from_env({**LIVE, "VOICE_PORT": "achtzig"})


def test_gateway_url_ohne_abschliessenden_schraegstrich() -> None:
    config = config_from_env({**LIVE, "VOICE_GATEWAY_URL": "http://gateway:8788/"})
    assert config.gateway_url == "http://gateway:8788"
