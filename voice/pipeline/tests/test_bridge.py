"""Die Backend-Brücke: Anmeldung, Zug, Unterbrechen, Freigabe, Fehlschlag.

Gefahren mit Pipecats eigenem `run_test` — der Prozessor läuft dabei in einer echten Pipeline
(StartFrame, Task-Manager, beide Richtungen), nicht in einer nachgebauten Umgebung. Was hier grün
ist, ist es also unter denselben Bedingungen wie im Betrieb; ersetzt wird nur das Backend.
"""

from __future__ import annotations

import asyncio

import pytest
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    Frame,
    InputTransportMessageFrame,
    InterruptionFrame,
    OutputTransportMessageUrgentFrame,
    TranscriptionFrame,
    TTSSpeakFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.tests.utils import SleepFrame, run_test

from voice.pipeline import bridge as bridge_modul
from voice.pipeline.bridge import KuronamiBridge
from voice.pipeline.config import config_from_env
from voice.pipeline.gateway import Approval, ApprovalOption, GatewayError, GatewayTurn
from voice.pipeline.latency import LatencyLedger


TOKEN = "sitzungsgeheimnis"


def a_config():
    return config_from_env(
        {
            "VOICE_MODE": "loopback",
            "VOICE_SESSION_TOKEN": TOKEN,
            "VOICE_BRIDGE_TOKEN": "bruecke",
        }
    )


class FakeGateway:
    """Ein Backend, das aufschreibt, was es gefragt wurde."""

    def __init__(
        self,
        *,
        turn: GatewayTurn | None = None,
        answer: GatewayTurn | None = None,
        delay: float = 0.0,
        error: Exception | None = None,
    ) -> None:
        self.turns: list[str] = []
        self.answers: list[tuple[str, str]] = []
        self.closed = False
        self._turn = turn or GatewayTurn(
            session_id="s1", status="answered", reason="fertig", text="Alles erledigt."
        )
        self._answer = answer or self._turn
        self._delay = delay
        self._error = error

    async def turn(self, text: str, external_id: str) -> GatewayTurn:
        self.turns.append(text)
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._error:
            raise self._error
        return self._turn

    async def answer(self, ask_id: str, choice_id: str, external_id: str) -> GatewayTurn:
        self.answers.append((ask_id, choice_id))
        if self._delay:
            await asyncio.sleep(self._delay)
        return self._answer

    async def close(self) -> None:
        self.closed = True


@pytest.fixture(autouse=True)
def _kurze_satzpause(monkeypatch):
    """Die Sammelpause ist im Betrieb eine Viertelsekunde — im Test wäre das nur Wartezeit.

    Der eine Test, dem es auf die Pause selbst ankommt, setzt sie sich selbst wieder hoch.
    """
    monkeypatch.setattr(bridge_modul, "_SATZ_PAUSE_SECS", 0.02)


def bridge(client) -> KuronamiBridge:
    return KuronamiBridge(config=a_config(), client=client, ledger=LatencyLedger())


def hello(token: str = TOKEN) -> Frame:
    return InputTransportMessageFrame(message={"type": "hello", "token": token})


def messages(frames) -> list[dict]:
    return [
        frame.message
        for frame in frames
        if isinstance(frame, OutputTransportMessageUrgentFrame) and isinstance(frame.message, dict)
    ]


def spoken(frames) -> list[str]:
    return [frame.text for frame in frames if isinstance(frame, TTSSpeakFrame)]


def of_type(frames, kind: str) -> list[dict]:
    return [message for message in messages(frames) if message.get("type") == kind]


async def test_ohne_anmeldung_geht_nichts_ins_backend() -> None:
    client = FakeGateway()
    down, _up = await run_test(
        bridge(client),
        frames_to_send=[TranscriptionFrame(text="Lösch alles", user_id="u", timestamp="t")],
        expected_down_frames=None,
    )
    assert client.turns == []
    assert of_type(down, "error"), "Der Client muss erfahren, warum nichts passiert."


async def test_falsches_geheimnis_meldet_nicht_an() -> None:
    client = FakeGateway()
    down, _up = await run_test(
        bridge(client),
        frames_to_send=[
            hello("falsch"),
            TranscriptionFrame(text="Hallo", user_id="u", timestamp="t"),
        ],
        expected_down_frames=None,
    )
    assert client.turns == []
    assert of_type(down, "ready") == []
    assert of_type(down, "error")


async def test_anmeldung_nennt_die_abtastraten() -> None:
    down, _up = await run_test(
        bridge(FakeGateway()),
        frames_to_send=[hello()],
        expected_down_frames=None,
    )
    ready = of_type(down, "ready")
    assert len(ready) == 1
    assert ready[0]["audio_in_sample_rate"] == 16000
    assert ready[0]["audio_out_sample_rate"] == 24000
    assert ready[0]["latency_budget_ms"] == 800


async def test_transkript_wird_ein_zug_und_die_antwort_gesprochen() -> None:
    client = FakeGateway(
        turn=GatewayTurn(
            session_id="s1", status="answered", reason="fertig", text="Drei Termine heute."
        )
    )
    down, _up = await run_test(
        bridge(client),
        frames_to_send=[
            hello(),
            VADUserStoppedSpeakingFrame(),
            TranscriptionFrame(text="Was steht heute an?", user_id="u", timestamp="t"),
            SleepFrame(sleep=0.2),
        ],
        expected_down_frames=None,
    )
    assert client.turns == ["Was steht heute an?"]
    assert "Drei Termine heute." in spoken(down)
    states = [message["state"] for message in of_type(down, "state")]
    assert "thinking" in states and "speaking" in states


async def test_die_bruecke_meldet_die_latenz_nicht_selbst() -> None:
    # Sie **kann** es nicht ehrlich: zu dem Zeitpunkt, an dem sie fertig ist, gibt es noch kein
    # Audio. Gemeldet wird in `LatencyProbe`, hinter der Stimme (siehe services.py).
    client = FakeGateway()
    down, _up = await run_test(
        bridge(client),
        frames_to_send=[
            hello(),
            VADUserStoppedSpeakingFrame(),
            TranscriptionFrame(text="Wie spät?", user_id="u", timestamp="t"),
            SleepFrame(sleep=0.2),
        ],
        expected_down_frames=None,
    )
    assert of_type(down, "latency") == []


async def test_zwei_transkriptstuecke_werden_ein_befehl(monkeypatch) -> None:
    """Eine Äußerung, die Deepgram zweimal abschließt, bleibt ein Befehl.

    Deepgram beendet ein Segment bei jeder Pause, und Pipecat macht aus jedem Abschluss einen
    `TranscriptionFrame`. Wer mitten im Satz Luft holt, schickte damit zwei Befehle — am
    2026-09-20 wurde aus einer Bitte ein Auftrag und ein Rest, auf den Kuro mit „Wie meinen
    Sie das, Jakob?" antwortete.
    """
    monkeypatch.setattr(bridge_modul, "_SATZ_PAUSE_SECS", 0.2)
    client = FakeGateway()
    await run_test(
        bridge(client),
        frames_to_send=[
            hello(),
            VADUserStartedSpeakingFrame(),
            TranscriptionFrame(text="Sieh mal im Postfach", user_id="u", timestamp="t"),
            # Die Atempause: das VAD hört noch Stimme, also ist der Satz nicht zu Ende.
            SleepFrame(sleep=0.1),
            TranscriptionFrame(text="nach, bitte", user_id="u", timestamp="t"),
            VADUserStoppedSpeakingFrame(),
            SleepFrame(sleep=0.6),
        ],
        expected_down_frames=None,
    )
    assert client.turns == ["Sieh mal im Postfach nach, bitte"]


async def test_barge_in_unterbricht_die_laufende_stimme() -> None:
    client = FakeGateway()
    _down, up = await run_test(
        bridge(client),
        frames_to_send=[
            hello(),
            BotStartedSpeakingFrame(),
            VADUserStartedSpeakingFrame(),
            SleepFrame(sleep=0.1),
        ],
        expected_down_frames=None,
    )
    # `broadcast_interruption` schickt den Frame in **beide** Richtungen. Stromaufwärts ist die
    # Richtung, die den Transport seine Ausgabe wegwerfen lässt — das ist das Unterbrechen.
    assert any(isinstance(frame, InterruptionFrame) for frame in up)


async def test_barge_in_verwirft_die_antwort_die_noch_unterwegs_war() -> None:
    # Die Stimme läuft schon, das Backend hat noch nicht fertig geantwortet — und mitten
    # hinein redet der Nutzer. Das ist das echte Dazwischenreden: was noch unterwegs war,
    # will er nicht mehr hören.
    client = FakeGateway(delay=0.3)
    down, _up = await run_test(
        bridge(client),
        frames_to_send=[
            hello(),
            VADUserStoppedSpeakingFrame(),
            TranscriptionFrame(text="Lange Frage", user_id="u", timestamp="t"),
            SleepFrame(sleep=0.05),
            BotStartedSpeakingFrame(),
            VADUserStartedSpeakingFrame(),
            SleepFrame(sleep=0.5),
        ],
        expected_down_frames=None,
    )
    assert client.turns == ["Lange Frage"], "Der Zug ist losgegangen …"
    assert spoken(down) == [], "… aber seine Antwort wird nicht mehr vorgelesen."


async def test_atemzug_waehrend_des_denkens_verwirft_den_zug_nicht() -> None:
    """Eine Pause mitten im Satz kostet keine Antwort.

    Bis 2026-09-20 genügte ein `VADUserStartedSpeakingFrame`, um einen laufenden Zug
    wegzuwerfen — auch wenn die Stimme gar nicht lief. Im Betrieb heißt das: wer Luft holt,
    verliert seine Antwort, und die zweite Hälfte seines Satzes geht als eigener Befehl
    durch. Solange nichts gesprochen wird, gibt es nichts zu unterbrechen.
    """
    client = FakeGateway(delay=0.3)
    down, up = await run_test(
        bridge(client),
        frames_to_send=[
            hello(),
            VADUserStoppedSpeakingFrame(),
            TranscriptionFrame(text="Sieh mal im Postfach", user_id="u", timestamp="t"),
            SleepFrame(sleep=0.05),
            VADUserStartedSpeakingFrame(),
            SleepFrame(sleep=0.5),
        ],
        expected_down_frames=None,
    )
    assert client.turns == ["Sieh mal im Postfach"]
    assert spoken(down) == ["Alles erledigt."], "Die Antwort wird vorgelesen."
    assert not any(isinstance(frame, InterruptionFrame) for frame in up)


async def test_ohne_laufende_ausgabe_kein_unterbrechen() -> None:
    # Wer zu reden anfängt, während nichts läuft, unterbricht nichts — sonst stünde nach jedem
    # Satzanfang eine Unterbrechung im Protokoll.
    _down, up = await run_test(
        bridge(FakeGateway()),
        frames_to_send=[hello(), VADUserStartedSpeakingFrame(), SleepFrame(sleep=0.1)],
        expected_down_frames=None,
    )
    assert not any(isinstance(frame, InterruptionFrame) for frame in up)


class PostfachGateway(FakeGateway):
    """Ein Backend, das auch ein Postfach hat — für die Nachträge."""

    def __init__(self, *, nachtraege: list[str] | None = None, **kwargs) -> None:
        super().__init__(**kwargs)
        self._nachtraege = list(nachtraege or [])
        self.outbox_calls = 0

    async def outbox(self) -> tuple[str, ...]:
        self.outbox_calls += 1
        texte, self._nachtraege = self._nachtraege, []
        return tuple(texte)


async def test_nachtrag_aus_dem_postfach_wird_vorgetragen(monkeypatch) -> None:
    """Was ohne Aufruf von hier zugestellt wurde, wird gesprochen.

    Der Bericht eines Bediensteten trifft Minuten nach der Frage ein; Kuro trägt ihn dann von
    sich aus vor. Dieser Zug gehört zu keinem offenen Aufruf der Sprachschicht — bis
    2026-09-20 lag seine Antwort deshalb im Postfach und wurde nie gehört.
    """
    monkeypatch.setattr(bridge_modul, "_OUTBOX_POLL_SECS", 0.05)
    client = PostfachGateway(nachtraege=["Zum Postfach: zwei Dinge verdienen einen Blick."])
    down, _up = await run_test(
        bridge(client),
        frames_to_send=[hello(), SleepFrame(sleep=0.3)],
        expected_down_frames=None,
    )
    assert client.outbox_calls >= 1
    assert spoken(down) == ["Zum Postfach: zwei Dinge verdienen einen Blick."]


async def test_postfach_schweigt_solange_ein_zug_laeuft(monkeypatch) -> None:
    """Der Postfachblick redet nicht in einen laufenden Zug hinein.

    Dessen Antwort kommt über seinen eigenen Strom; zwei Stimmen gleichzeitig wären eine zu
    viel.
    """
    monkeypatch.setattr(bridge_modul, "_OUTBOX_POLL_SECS", 0.05)
    client = PostfachGateway(delay=0.6, nachtraege=["Ein Nachtrag."])
    down, _up = await run_test(
        bridge(client),
        frames_to_send=[
            hello(),
            VADUserStoppedSpeakingFrame(),
            TranscriptionFrame(text="Lange Frage", user_id="u", timestamp="t"),
            SleepFrame(sleep=0.3),
        ],
        expected_down_frames=None,
    )
    assert client.outbox_calls == 0, "Solange der Zug lief, wurde nicht nachgesehen."
    assert spoken(down) == []


async def test_nachtrag_nach_einem_abgebrochenen_zug_wird_trotzdem_gesprochen(monkeypatch) -> None:
    """Ein Abbruch darf den **nächsten** Nachtrag nicht mitnehmen.

    Genau das ist am 2026-09-20 passiert: ein Zähler für „abgebrochene Antworten" verschluckte
    den Bericht des Handelstischs, auf den Jakob drei Minuten gewartet hatte. Die abgebrochene
    Antwort landet gar nicht im Postfach — der Gateway leert es am Ende desselben Aufrufs.
    """
    monkeypatch.setattr(bridge_modul, "_OUTBOX_POLL_SECS", 0.05)
    client = PostfachGateway(delay=0.3, nachtraege=["Der Bericht des Handelstischs ist da."])
    down, _up = await run_test(
        bridge(client),
        frames_to_send=[
            hello(),
            VADUserStoppedSpeakingFrame(),
            TranscriptionFrame(text="Lange Frage", user_id="u", timestamp="t"),
            SleepFrame(sleep=0.05),
            BotStartedSpeakingFrame(),
            VADUserStartedSpeakingFrame(),
            BotStoppedSpeakingFrame(),
            VADUserStoppedSpeakingFrame(),
            SleepFrame(sleep=0.5),
        ],
        expected_down_frames=None,
    )
    assert spoken(down) == ["Der Bericht des Handelstischs ist da."]


async def test_freigabe_wird_vorgelesen_und_gesprochen_beantwortet() -> None:
    approval = Approval(
        ask_id="policy:call-1",
        question="Darf ich die Datei überschreiben?",
        options=(
            ApprovalOption(id="genehmigen", label="Genehmigen"),
            ApprovalOption(id="ablehnen", label="Ablehnen"),
        ),
    )
    client = FakeGateway(
        turn=GatewayTurn(
            session_id="s1",
            status="awaiting_user",
            reason="wartet",
            text="",
            approvals=(approval,),
        ),
        answer=GatewayTurn(
            session_id="s1", status="answered", reason="fertig", text="Erledigt."
        ),
    )
    down, _up = await run_test(
        bridge(client),
        frames_to_send=[
            hello(),
            VADUserStoppedSpeakingFrame(),
            TranscriptionFrame(text="Schreib die Notiz", user_id="u", timestamp="t"),
            SleepFrame(sleep=0.2),
            VADUserStoppedSpeakingFrame(),
            TranscriptionFrame(text="Ja, genehmigen.", user_id="u", timestamp="t"),
            SleepFrame(sleep=0.2),
        ],
        expected_down_frames=None,
    )
    said = " ".join(spoken(down))
    assert "Darf ich die Datei überschreiben?" in said
    assert "Genehmigen" in said and "Ablehnen" in said
    assert client.answers == [("policy:call-1", "genehmigen")]
    assert "Erledigt." in spoken(down)


async def test_unverstandene_antwort_fragt_nach_statt_zu_raten() -> None:
    approval = Approval(
        ask_id="policy:call-2",
        question="Jetzt oder später?",
        options=(
            ApprovalOption(id="jetzt", label="Jetzt"),
            ApprovalOption(id="spaeter", label="Später"),
        ),
    )
    client = FakeGateway(
        turn=GatewayTurn(
            session_id="s1", status="awaiting_user", reason="", text="", approvals=(approval,)
        )
    )
    down, _up = await run_test(
        bridge(client),
        frames_to_send=[
            hello(),
            VADUserStoppedSpeakingFrame(),
            TranscriptionFrame(text="Mach was", user_id="u", timestamp="t"),
            SleepFrame(sleep=0.2),
            VADUserStoppedSpeakingFrame(),
            TranscriptionFrame(text="Hm, weiß nicht so recht", user_id="u", timestamp="t"),
            SleepFrame(sleep=0.2),
        ],
        expected_down_frames=None,
    )
    assert client.answers == [], "Eine Zustimmung, die niemand gegeben hat, wird nicht erfunden."
    assert any("nicht als Antwort erkannt" in text for text in spoken(down))


async def test_backend_fehler_wird_gesagt_nicht_geglaettet() -> None:
    client = FakeGateway(error=GatewayError("http://gateway:8788 ist nicht erreichbar: kaputt"))
    down, _up = await run_test(
        bridge(client),
        frames_to_send=[
            hello(),
            VADUserStoppedSpeakingFrame(),
            TranscriptionFrame(text="Irgendwas", user_id="u", timestamp="t"),
            SleepFrame(sleep=0.2),
        ],
        expected_down_frames=None,
    )
    errors = of_type(down, "error")
    assert errors and "nicht erreichbar" in errors[0]["message"]
    assert any("fehlgeschlagen" in text for text in spoken(down))
