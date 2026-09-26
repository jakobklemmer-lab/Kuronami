"""Konfiguration der Sprachschicht (S30) — genau eine Stelle, an der die Umgebung gelesen wird.

Dieselbe Haltung wie `gateway/identity.ts`: fehlende Werte schalten etwas **ab** oder brechen den
Start ab, sie werden nie geraten. Ein Sprachprozess, der ohne Deepgram-Schlüssel startet und
stillschweigend nichts erkennt, wäre schlimmer als einer, der gar nicht erst hochkommt — der
Fehler stünde dann nicht in der ersten Zeile, sondern in der Frage, warum niemand antwortet.

Zwei Betriebsarten, und der Unterschied ist keine Feinheit:

* ``live`` — Deepgram für die Erkennung, Azure oder ElevenLabs für die Stimme (``VOICE_TTS``).
  Die Schlüssel des gewählten Anbieters sind Pflicht.
* ``loopback`` — dieselbe Pipeline, dieselbe Verdrahtung, aber mit lokalen Stand-ins statt der
  beiden Anbieter (``services.py``). Dafür gibt es genau einen Grund: Unterbrechen und Latenz
  (S31) sind Eigenschaften des **Graphen**, nicht der Anbieter, und sie sollen messbar sein, ohne
  dass für jede Messung eine fremde API bezahlt und befragt wird. Der Modus ist als Messstand
  gebaut und sagt das im Protokoll bei jedem Start; er ist keine Attrappe, die sich für den
  Betrieb ausgeben soll.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Literal

VoiceMode = Literal["live", "loopback"]
#: Wer im Live-Betrieb spricht. Seit 2026-09-21 eine Wahl und nicht mehr fest verdrahtet.
#:
#: Der Wechsel kam nicht aus Geschmack, sondern aus einer Rechnung: ElevenLabs stellt zwischen
#: 121.000 Zeichen (11 $) und 600.000 Zeichen (99 $) nichts dazwischen, und Jakob spricht
#: mehrmals täglich mit Kuro. Azure nimmt 15 $ je Million Zeichen (Neural) bzw. 22 $ (HD) und
#: hat ein Freikontingent von 500.000 Zeichen im Monat — derselbe Betrieb kostet dort einstellig.
#: ElevenLabs bleibt als Weg erhalten; der Code soll den Vergleich zulassen, nicht verbieten.
VoiceTTS = Literal["azure", "elevenlabs"]

#: Die Obergrenze aus dem Fertig-Kriterium von S31. Sie steht hier und nicht als Zahl im
#: Messskript, damit Budget und Messung dieselbe Quelle haben.
DEFAULT_LATENCY_BUDGET_MS = 800


class ConfigError(RuntimeError):
    """Die Umgebung trägt den gewünschten Betrieb nicht. Der Prozess startet dann nicht."""


def _text(env: Mapping[str, str], name: str, default: str = "") -> str:
    return (env.get(name) or "").strip() or default


def _number(env: Mapping[str, str], name: str, default: int) -> int:
    raw = _text(env, name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as error:
        raise ConfigError(f"{name} ist keine Zahl: {raw!r}") from error


def _decimal(env: Mapping[str, str], name: str, default: float) -> float:
    raw = _text(env, name)
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError as error:
        raise ConfigError(f"{name} ist keine Zahl: {raw!r}") from error


def _list(env: Mapping[str, str], name: str) -> tuple[str, ...]:
    return tuple(part.strip() for part in _text(env, name).split(",") if part.strip())


@dataclass(frozen=True)
class VoiceConfig:
    """Alles, was die Sprachschicht über ihre Umgebung weiß."""

    mode: VoiceMode
    host: str
    port: int
    #: Erlaubte Browser-Ursprünge des WebSocket-Rands. Leer = die Prüfung entfällt (kein
    #: Browser-Ursprung wird verlangt), was für die Messung ohne Browser der Normalfall ist.
    allowed_origins: tuple[str, ...]
    #: Das gemeinsame Geheimnis, das ein Client als erste Nachricht vorzeigt (`voice.hello`).
    #: Ohne ihn startet der Prozess nicht — siehe `from_env`.
    session_token: str

    #: Wohin die Brücke spricht (S31). Ohne Token nimmt der Gateway-Kanal nichts an.
    gateway_url: str
    gateway_token: str
    gateway_timeout_secs: float

    deepgram_api_key: str
    #: Leer = Deepgrams eigene Adresse. Gesetzt zeigt auf einen eigenen Endpunkt — der Weg,
    #: auf dem dieselbe Messung später gegen einen echten Anbieter läuft.
    deepgram_base_url: str
    deepgram_language: str
    #: Das Erkennungsmodell. `multi` als Sprache verlangt `nova-3`.
    deepgram_model: str
    #: Begriffe, die Deepgram bevorzugt erkennen soll (Nova-3 „keyterm prompting"), eine
    #: Liste. Leer = keine Vorgabe.
    deepgram_keyterms: tuple[str, ...]

    #: Wer die Stimme stellt. Wirkt nur im Live-Betrieb; im Loopback spricht immer der Stand-in.
    tts_provider: VoiceTTS

    azure_speech_key: str
    azure_speech_region: str
    #: Der Stimmname, wie Azure ihn schreibt (``de-DE-FlorianMultilingualNeural``).
    azure_speech_voice: str
    #: Die Sprache, in der gesprochen wird. Geht als ``xml:lang`` ins SSML.
    azure_speech_language: str

    elevenlabs_api_key: str
    elevenlabs_voice_id: str
    elevenlabs_model: str
    elevenlabs_url: str

    audio_in_sample_rate: int
    audio_out_sample_rate: int

    #: `silero` (Vorgabe, Betrieb) oder `energy` (Messstand, siehe `vad.py`).
    vad_kind: str
    vad_confidence: float
    vad_start_secs: float
    vad_stop_secs: float
    vad_min_volume: float
    vad_energy_threshold: float

    latency_budget_ms: int

    #: Nur im Loopback: der Text, den die Stand-in-Erkennung liefert, wenn der Client keinen
    #: eigenen nennt. Ein fester Satz, damit eine Messung wiederholbar ist.
    loopback_transcript: str
    #: Nur im Loopback: wie lange die Stand-in-Stimme je Wort spricht. Bestimmt, wie viel Audio
    #: zum Unterbrechen überhaupt da ist.
    loopback_secs_per_word: float

    #: Rein dokumentierend, wird beim Start protokolliert.
    started_from: str = field(default="env")

    @property
    def live(self) -> bool:
        return self.mode == "live"

    def describe(self) -> str:
        """Eine Zeile für das Prozessprotokoll. Nennt nie einen Schlüssel, nur ob er da ist."""
        stt = "Deepgram" if self.live else "Loopback-STT"
        if not self.live:
            tts = "Loopback-TTS"
        elif self.tts_provider == "azure":
            tts = f"Azure ({self.azure_speech_voice})"
        else:
            tts = "ElevenLabs"
        return (
            f"Modus {self.mode} · VAD {self.vad_kind} · {stt} → Brücke → {tts} · "
            f"ws://{self.host}:{self.port} · Gateway {self.gateway_url} · "
            f"Audio {self.audio_in_sample_rate} Hz rein / {self.audio_out_sample_rate} Hz raus · "
            f"Budget {self.latency_budget_ms} ms"
        )


def config_from_env(env: Mapping[str, str] | None = None) -> VoiceConfig:
    """Baut die Konfiguration. Wirft `ConfigError`, wenn der gewünschte Betrieb nicht trägt."""
    source = os.environ if env is None else env

    mode_raw = _text(source, "VOICE_MODE", "live").lower()
    if mode_raw not in ("live", "loopback"):
        raise ConfigError(f"VOICE_MODE kennt nur live oder loopback, nicht {mode_raw!r}.")
    mode: VoiceMode = "live" if mode_raw == "live" else "loopback"

    session_token = _text(source, "VOICE_SESSION_TOKEN")
    if not session_token:
        raise ConfigError(
            "VOICE_SESSION_TOKEN fehlt. Der WebSocket-Rand der Sprachschicht nimmt ohne "
            "gemeinsames Geheimnis nichts an — ein offener Port auf diesem Rechner wäre eine "
            "Fernbedienung für den Agenten."
        )

    vad_kind = _text(source, "VOICE_VAD", "silero").lower()
    if vad_kind not in ("silero", "energy"):
        raise ConfigError(f"VOICE_VAD kennt nur silero oder energy, nicht {vad_kind!r}.")

    gateway_token = _text(source, "VOICE_BRIDGE_TOKEN")
    if not gateway_token:
        raise ConfigError(
            "VOICE_BRIDGE_TOKEN fehlt. Ohne ihn weist der Sprach-Kanal des Gateways jede "
            "Nachricht ab (siehe gateway/identity.ts, authenticateVoice)."
        )

    tts_raw = _text(source, "VOICE_TTS", "azure").lower()
    if tts_raw not in ("azure", "elevenlabs"):
        raise ConfigError(f"VOICE_TTS kennt nur azure oder elevenlabs, nicht {tts_raw!r}.")
    tts_provider: VoiceTTS = "azure" if tts_raw == "azure" else "elevenlabs"

    deepgram = _text(source, "DEEPGRAM_API_KEY")
    azure_key = _text(source, "AZURE_SPEECH_KEY")
    azure_region = _text(source, "AZURE_SPEECH_REGION")
    elevenlabs = _text(source, "ELEVENLABS_API_KEY")
    voice_id = _text(source, "ELEVENLABS_VOICE_ID")
    if mode == "live":
        # Verlangt wird nur, was der gewählte Anbieter braucht. Beide Schlüsselsätze zu fordern
        # hieße, den ungenutzten Anbieter zur Startbedingung zu machen — und genau daran wäre
        # der Wechsel gescheitert, solange das ElevenLabs-Konto noch am Limit klebt.
        gebraucht: tuple[tuple[str, str], ...] = (
            (("AZURE_SPEECH_KEY", azure_key), ("AZURE_SPEECH_REGION", azure_region))
            if tts_provider == "azure"
            else (("ELEVENLABS_API_KEY", elevenlabs), ("ELEVENLABS_VOICE_ID", voice_id))
        )
        missing = [
            name for name, value in (("DEEPGRAM_API_KEY", deepgram), *gebraucht) if not value
        ]
        if missing:
            raise ConfigError(
                "VOICE_MODE=live verlangt bei VOICE_TTS=" + tts_provider + " die Werte "
                + ", ".join(missing) + ". Ohne sie gibt es keine Erkennung und keine Stimme; "
                "für einen Lauf ohne Anbieter ist VOICE_MODE=loopback gedacht."
            )

    return VoiceConfig(
        mode=mode,
        host=_text(source, "VOICE_HOST", "127.0.0.1"),
        port=_number(source, "VOICE_PORT", 8790),
        allowed_origins=_list(source, "VOICE_ALLOWED_ORIGINS"),
        session_token=session_token,
        gateway_url=_text(source, "VOICE_GATEWAY_URL", "http://127.0.0.1:8788").rstrip("/"),
        gateway_token=gateway_token,
        gateway_timeout_secs=_decimal(source, "VOICE_GATEWAY_TIMEOUT_SECS", 180.0),
        deepgram_api_key=deepgram,
        deepgram_base_url=_text(source, "DEEPGRAM_BASE_URL"),
        # **`multi` statt `de`, seit 2026-09-21.** Ein rein deutsches Modell macht aus
        # „Heartbeat" ein „Hardbeat" und aus „Kuro" ein „Koro" oder „Guro" — alles drei steht
        # so im Protokoll vom 20./21.09. Jakob spricht über Paper Trading, Backtests und
        # Tickersymbole; die Erkennung muss innerhalb eines Satzes umschalten können. `multi`
        # ist Deepgrams Betriebsart dafür und setzt `nova-3` voraus.
        # Zurück geht es mit DEEPGRAM_LANGUAGE=de und DEEPGRAM_MODEL=nova-2.
        deepgram_language=_text(source, "DEEPGRAM_LANGUAGE", "multi"),
        deepgram_model=_text(source, "DEEPGRAM_MODEL", "nova-3"),
        deepgram_keyterms=_list(source, "DEEPGRAM_KEYTERMS"),
        tts_provider=tts_provider,
        azure_speech_key=azure_key,
        azure_speech_region=azure_region,
        # Warum ausgerechnet diese Stimme als Vorgabe: sie ist **multilingual**. Die Vorgängerin
        # war „George", eine englische Premade-Stimme, die deutschen Text las — Jakob hörte am
        # 2026-09-21 einen britischen Erzähler und sagte, Kuro kenne „plötzlich nicht mehr alle
        # englischen Begriffe". Eine einsprachig deutsche Stimme dreht denselben Fehler nur um:
        # Kuro redet über Backtests, Drawdowns und Buy-and-Hold, und die müssen englisch klingen
        # dürfen, ohne dass der Satz drumherum den Akzent wechselt.
        azure_speech_voice=_text(source, "AZURE_SPEECH_VOICE", "de-DE-FlorianMultilingualNeural"),
        azure_speech_language=_text(source, "AZURE_SPEECH_LANGUAGE", "de-DE"),
        elevenlabs_api_key=elevenlabs,
        elevenlabs_voice_id=voice_id,
        elevenlabs_model=_text(source, "ELEVENLABS_MODEL", "eleven_flash_v2_5"),
        elevenlabs_url=_text(source, "ELEVENLABS_URL", "wss://api.elevenlabs.io"),
        audio_in_sample_rate=_number(source, "VOICE_AUDIO_IN_SAMPLE_RATE", 16000),
        audio_out_sample_rate=_number(source, "VOICE_AUDIO_OUT_SAMPLE_RATE", 24000),
        vad_kind=vad_kind,
        vad_confidence=_decimal(source, "VOICE_VAD_CONFIDENCE", 0.7),
        vad_start_secs=_decimal(source, "VOICE_VAD_START_SECS", 0.2),
        # 0,2 s galten bis 2026-09-20 und waren zu kurz für einen deutschen Satz: wer mitten
        # im Befehl Luft holt, beendete damit seine Äußerung, und die Fortsetzung kam als
        # zweiter Befehl an ("…sieh mal im Postfach" / "…nach"). Im Protokoll dieses Tages
        # liegen 254 ms zwischen zwei Hälften derselben Bitte. 0,8 s ist auch Pipecats eigene
        # Vorgabe; die Verzögerung kostet weniger als eine halbe Frage.
        vad_stop_secs=_decimal(source, "VOICE_VAD_STOP_SECS", 0.8),
        vad_min_volume=_decimal(source, "VOICE_VAD_MIN_VOLUME", 0.6),
        vad_energy_threshold=_decimal(source, "VOICE_VAD_ENERGY_THRESHOLD", 0.02),
        latency_budget_ms=_number(source, "VOICE_LATENCY_BUDGET_MS", DEFAULT_LATENCY_BUDGET_MS),
        loopback_transcript=_text(
            source, "VOICE_LOOPBACK_TRANSCRIPT", "Fasse meinen Tag in einem Satz zusammen."
        ),
        loopback_secs_per_word=_decimal(source, "VOICE_LOOPBACK_SECS_PER_WORD", 0.34),
    )
