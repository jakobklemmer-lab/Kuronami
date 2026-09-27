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


# --- Wie eine Antwort in Stücke zerfällt (2026-09-21) --------------------------------------
#
# Der Anlass steht im Protokoll dieses Abends: eine einzige Antwort ging als 13 getrennte
# Aufrufe an den Sprachdienst, der kürzeste 16 Zeichen lang ("Dabei läuft mit:"). Jakob hörte
# eine Stimme, die sich alle paar Worte neu sortiert.


async def _stuecke(*texte: str, flush: bool = True) -> list[str]:
    """Füttert `LiveSentences` und gibt zurück, was wirklich zum Sprechen ging."""
    gesagt: list[str] = []

    async def speak(text: str) -> None:
        gesagt.append(text)

    live = bridge_modul.LiveSentences(speak)
    for text in texte:
        await live.feed(text)
    if flush:
        await live.flush()
    return gesagt


async def test_der_doppelpunkt_zerschneidet_die_antwort_nicht_mehr() -> None:
    gesagt = await _stuecke(
        "Der Prozess schaltet sich selbst ab, sobald eine von drei Schwellen reißt: "
        "zwanzig Prozent Rückschlag, sechs Verluste in Folge, oder ein Rückstand auf den "
        "Backtest. "
    )
    assert len(gesagt) == 1, "Ein Satz mit Doppelpunkt ist ein Satz, kein Paar."
    assert gesagt[0].startswith("Der Prozess schaltet")
    assert "zwanzig Prozent" in gesagt[0]


async def test_kurze_stuecke_warten_auf_das_naechste() -> None:
    """Ein Anbieter, der die Sprache aus dem Text errät, braucht Text.

    Bei „Dabei läuft mit:" hat er nichts, woran er sie erkennen könnte — und genau dort kippte
    die Aussprache englischer Fachbegriffe.
    """
    gesagt = await _stuecke("Ja. Gut. Sehr wohl. ", flush=False)
    assert gesagt == [], "Drei Kurzsätze allein lösen noch nichts aus."

    gesagt = await _stuecke(
        "Ja. Gut. Und bevor überhaupt etwas in den Papierhandel darf, muss der Prüfer es "
        "gegengerechnet haben. ",
        flush=False,
    )
    assert len(gesagt) == 1
    assert gesagt[0].startswith("Ja. Gut. Und bevor")


async def test_flush_gibt_auch_den_kurzen_rest_heraus() -> None:
    """Gesammelt wird, um zusammen zu sprechen — nicht, um etwas zu verschlucken."""
    gesagt = await _stuecke("Sehr wohl.")
    assert gesagt == ["Sehr wohl."]


def test_ein_offener_satz_ist_als_solcher_erkennbar() -> None:
    offen = bridge_modul._SATZ_OFFEN
    assert offen.search("aber wenn das Paper Trading laufen würde,")
    assert offen.search("Ich wollte fragen, ob das geht und")
    assert not offen.search("Wie wird das Wetter?")
    assert not offen.search("Sieh im Postfach nach.")
    # Ein Befehl ohne Satzzeichen ist der Normalfall gesprochener Sprache und darf nicht
    # jedes Mal die lange Pause auslösen.
    assert not offen.search("Sieh mal im Postfach")


async def test_der_offene_satz_wird_nicht_zum_befehl(monkeypatch) -> None:
    """Jakobs Fall vom 2026-09-21, 18:58 Uhr.

    Er sagte „…also der Paper Trading laufen würde," — holte Luft — und Kuro fiel ihm mit
    „Ja, wenn er liefe?" ins Wort. Das Komma stand schon im Transkript; gefehlt hat nur, dass
    jemand es liest.
    """
    monkeypatch.setattr(bridge_modul, "_SATZ_PAUSE_OFFEN_SECS", 0.4)
    client = FakeGateway()
    await run_test(
        bridge(client),
        frames_to_send=[
            hello(),
            VADUserStoppedSpeakingFrame(),
            TranscriptionFrame(
                text="aber wenn das Paper Trading laufen würde,", user_id="u", timestamp="t"
            ),
            SleepFrame(sleep=0.2),
            TranscriptionFrame(text="bräuchte das einen Takt?", user_id="u", timestamp="t"),
            SleepFrame(sleep=0.5),
        ],
        expected_down_frames=None,
    )
    assert client.turns == ["aber wenn das Paper Trading laufen würde, bräuchte das einen Takt?"]


async def test_nach_einem_barge_in_erfaehrt_der_naechste_zug_davon(monkeypatch) -> None:
    """Der Rest verfällt weiterhin — aber nicht mehr unbemerkt.

    Bis 2026-09-21 stand im Gesprächsverlauf des Motors die vollständige Antwort als gesagt,
    während Jakob nur den Anfang gehört hatte. Auf seinen Vorhalt konnte Kuro deshalb nur
    raten.
    """
    monkeypatch.setattr(bridge_modul, "_SATZ_PAUSE_SECS", 0.1)
    client = FakeGateway()
    await run_test(
        bridge(client),
        frames_to_send=[
            hello(),
            VADUserStoppedSpeakingFrame(),
            TranscriptionFrame(text="Wie läuft der Papierhandel?", user_id="u", timestamp="t"),
            SleepFrame(sleep=0.3),
            BotStartedSpeakingFrame(),
            VADUserStartedSpeakingFrame(),
            SleepFrame(sleep=0.1),
            VADUserStoppedSpeakingFrame(),
            TranscriptionFrame(text="Das war abgeschnitten.", user_id="u", timestamp="t"),
            SleepFrame(sleep=0.4),
        ],
        expected_down_frames=None,
    )
    assert len(client.turns) == 2
    vermerk = client.turns[1]
    assert vermerk.startswith("[Hinweis der Sprachschicht:"), vermerk
    assert "unterbrochen" in vermerk
    assert vermerk.endswith("Das war abgeschnitten.")


async def test_ohne_barge_in_kein_vermerk(monkeypatch) -> None:
    """Eine zu Ende gesprochene Antwort hinterlässt keinen Hinweis — sonst stünde er überall."""
    monkeypatch.setattr(bridge_modul, "_SATZ_PAUSE_SECS", 0.1)
    client = FakeGateway()
    await run_test(
        bridge(client),
        frames_to_send=[
            hello(),
            VADUserStoppedSpeakingFrame(),
            TranscriptionFrame(text="Erste Frage.", user_id="u", timestamp="t"),
            SleepFrame(sleep=0.3),
            BotStartedSpeakingFrame(),
            BotStoppedSpeakingFrame(),
            VADUserStoppedSpeakingFrame(),
            TranscriptionFrame(text="Zweite Frage.", user_id="u", timestamp="t"),
            SleepFrame(sleep=0.3),
        ],
        expected_down_frames=None,
    )
    assert client.turns == ["Erste Frage.", "Zweite Frage."]


async def test_kein_nachtrag_waehrend_die_bruecke_noch_sammelt(monkeypatch) -> None:
    """Das Loch zwischen Äußerung und Befehl (2026-09-21).

    Zwischen dem Ende einer Äußerung und dem Absenden wartet die Brücke auf eine Fortsetzung.
    In dieser Zeit galt kein Zug als unterwegs, und der Postfachblick trug einen nachgereichten
    Bericht vor — mitten hinein. Jakob: „Koro, Du hast mir da grad irgendwas unterbrochen."
    """
    monkeypatch.setattr(bridge_modul, "_OUTBOX_POLL_SECS", 0.02)
    monkeypatch.setattr(bridge_modul, "_SATZ_PAUSE_OFFEN_SECS", 0.4)
    client = PostfachGateway(delay=0.05, nachtraege=["Ein Bericht vom Handelstisch."])
    down, _up = await run_test(
        bridge(client),
        frames_to_send=[
            hello(),
            VADUserStoppedSpeakingFrame(),
            # Das Komma sagt: hier kommt noch etwas. Die Brücke wartet — und schweigt.
            TranscriptionFrame(text="Und wenn das liefe,", user_id="u", timestamp="t"),
            SleepFrame(sleep=0.2),
        ],
        expected_down_frames=None,
    )
    assert client.outbox_calls == 0, "Während gesammelt wird, wird nicht nachgesehen."
    assert spoken(down) == [], "Und schon gar nicht gesprochen."


def taste(unten: bool) -> Frame:
    return InputTransportMessageFrame(message={"type": "taste", "unten": unten})


async def test_mit_gedrueckter_sprechtaste_ist_erst_nach_dem_loslassen_gesagt(monkeypatch) -> None:
    """Jakobs Fall vom 2026-09-27, 12:44 Uhr.

    Er hielt die Leertaste, sprach mit Pausen, und Kuro antwortete auf jedes Stück: „Ich höre."
    — „Und der zweite Punkt?". Solange die Taste unten ist, ist nichts zu Ende gesagt; nach dem
    Loslassen kommt noch das letzte Stück aus der Erkennung, und alles geht als ein Befehl.
    """
    monkeypatch.setattr(bridge_modul, "_SATZ_PAUSE_SECS", 0.1)
    monkeypatch.setattr(bridge_modul, "_TASTE_NACHLAUF_SECS", 0.4)
    client = FakeGateway()
    await run_test(
        bridge(client),
        frames_to_send=[
            hello(),
            taste(True),
            VADUserStoppedSpeakingFrame(),
            TranscriptionFrame(text="Hätte gerne zwei Sachen.", user_id="u", timestamp="t"),
            SleepFrame(sleep=0.5),
            TranscriptionFrame(text="Schau dir alle Analysen an.", user_id="u", timestamp="t"),
            SleepFrame(sleep=0.5),
            taste(False),
            SleepFrame(sleep=0.2),
            TranscriptionFrame(text="Und fasse sie zusammen.", user_id="u", timestamp="t"),
            SleepFrame(sleep=0.8),
        ],
        expected_down_frames=None,
    )
    assert client.turns == [
        "Hätte gerne zwei Sachen. Schau dir alle Analysen an. Und fasse sie zusammen."
    ]


async def test_fertig_gemeldet_wird_der_ganze_befehl_nicht_jedes_stueck(monkeypatch) -> None:
    """Jakobs Fall vom 2026-09-27, 12:50 Uhr.

    Der Befehl ging als einer hinaus, aber die Brücke meldete dem Browser jedes Stück als
    `final` — und die Welle stellte jedes als eigene Frage in den Faden, mit „Kuro denkt nach …"
    dazwischen. `final` kommt jetzt genau einmal, mit dem Wortlaut, der auch an Kuro geht.
    """
    monkeypatch.setattr(bridge_modul, "_SATZ_PAUSE_SECS", 0.1)
    monkeypatch.setattr(bridge_modul, "_TASTE_NACHLAUF_SECS", 0.4)
    client = FakeGateway()
    down, _up = await run_test(
        bridge(client),
        frames_to_send=[
            hello(),
            taste(True),
            VADUserStoppedSpeakingFrame(),
            TranscriptionFrame(text="Fasse die Analysen zusammen.", user_id="u", timestamp="t"),
            SleepFrame(sleep=0.5),
            TranscriptionFrame(text="Und archiviere den Rest.", user_id="u", timestamp="t"),
            SleepFrame(sleep=0.3),
            taste(False),
            SleepFrame(sleep=0.8),
        ],
        expected_down_frames=None,
    )
    ganz = "Fasse die Analysen zusammen. Und archiviere den Rest."
    fertig = [m["text"] for m in of_type(down, "transcript") if m.get("final")]
    zwischen = [m["text"] for m in of_type(down, "transcript") if not m.get("final")]
    assert client.turns == [ganz]
    assert fertig == [ganz], "Einmal fertig, mit genau dem, was an Kuro ging."
    assert zwischen[-1] == ganz, "Der Zwischenstand wächst mit, statt neu anzufangen."
