"""Die Backend-Brücke (S31): der Prozessor, der aus erkanntem Text einen Zug macht.

In einer üblichen Pipecat-Pipeline steht an dieser Stelle ein LLM-Dienst. Hier steht das
**Gateway** — der Agent dieses Systems ist keine Modell-Antwort, sondern ein Lauf mit Werkzeugen,
Freigaben und einem Gedächtnis, und der gehört hinter dieselbe Tür wie Telegram und Slack. Daraus
folgen drei Dinge, die dieser Prozessor zusätzlich zum Weiterreichen erledigt:

**1. Unterbrechen (das Fertig-Kriterium von S31).** Ohne LLM-Dienst gibt es auch keinen
LLM-Aggregator, und der wäre in einer Standard-Pipeline die Stelle, die bei einsetzender
Nutzerstimme `broadcast_interruption()` auslöst. Also tut es diese Datei: sagt das VAD "der Nutzer
redet", **während die Stimme läuft**, wird unterbrochen — die Ausgabe des Transports fällt sofort
weg, und die Antwort, die gerade unterwegs war, wird **nicht mehr gesprochen**. Ein Zug, der noch
denkt, wird davon nicht angerührt; warum, steht bei `_on_user_started`.

**Was Unterbrechen ausdrücklich nicht heißt: den Lauf abbrechen.** `runner.cancel()` schreibt
`session.canceled` (S05), und die Session der Sprachschicht ist dieselbe durchgehende Unterhaltung
wie im Web und auf Telegram (`gateway/conversation.ts`). Ein Dazwischenreden würde damit das
Gespräch beenden statt es zu lenken. Unterbrechen heißt hier: hör auf zu reden und hör mir zu. Der
angestoßene Zug läuft im Gateway zu Ende und steht dort im Protokoll — er wird nur nicht mehr
vorgelesen.

**2. Freigaben.** Hält das Gateway an (`awaiting_user`), kommt die Frage samt ihrer Optionen
zurück. Sie wird vorgelesen, und die nächste Äußerung wird gegen die Optionen abgeglichen
(`choices.py`) — ohne Modell, ohne Raten. Kein Treffer heißt Nachfragen.

**3. Das Postfach.** Nicht jede Antwort gehört zu einer Frage von hier. Kommt der Bericht eines
Bediensteten Minuten später an, trägt Kuro ihn von sich aus vor (`agent.ts`, `#trageNach`) — ein
eigener Zug, zu dem diese Schicht keinen offenen Aufruf hat. Seine Antwort liegt im Postfach des
Sprach-Kanals, und bis 2026-09-20 blieb sie dort liegen: in der Oberfläche stand sie, zu hören war
sie nie. `_watch_outbox` sieht deshalb nach, solange nichts läuft.

**4. Zustände.** Der Mic-Knopf der Oberfläche kennt sechs Zustände (`ui/mic/state.ts`); diese
Brücke bedient vier davon: `listening`, `thinking`, `speaking`, `idle`. `executing` und `complete`
bleiben aus, und zwar bewusst: hinter einem einzelnen HTTP-Aufruf lässt sich "denkt nach" nicht
von "ruft gerade ein Werkzeug auf" unterscheiden. Wer das sehen will, sieht es am Ereignisstrom
(S21) — dort steht jeder Werkzeugaufruf einzeln. Einen Zustand zu senden, den diese Schicht nicht
kennt, wäre eine Anzeige, die ausgedacht ist.
"""

from __future__ import annotations

import asyncio
import hmac
import os
import re
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from loguru import logger
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    Frame,
    InputTransportMessageFrame,
    InterimTranscriptionFrame,
    InterruptionFrame,
    OutputTransportMessageUrgentFrame,
    TranscriptionFrame,
    TTSSpeakFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from voice.pipeline.choices import Choice, match_choice, spoken_question
from voice.pipeline.config import VoiceConfig
from voice.pipeline.gateway import Approval, GatewayClient, GatewayError, GatewayTurn
from voice.pipeline.latency import LatencyLedger

#: Wie oft im Postfach nachgesehen wird, solange gerade nichts läuft.
_OUTBOX_POLL_SECS = 4.0
#: Wie lange nach einem **abgeschlossenen** Satz noch auf eine Fortsetzung gewartet wird.
_SATZ_PAUSE_SECS = float(os.environ.get("VOICE_UTTERANCE_GAP_SECS") or 0.25)
#: Nach dem Loslassen der Sprechtaste: so lange kommt das letzte Stück noch aus VAD-Pause und
#: Erkennung. Ohne das ginge der Satz ohne seine letzten Worte hinaus, und die kämen als eigener
#: Befehl hinterher.
_TASTE_NACHLAUF_SECS = 1.2
#: Dasselbe, wenn der Satz erkennbar **nicht** zu Ende ist.
#:
#: Am 2026-09-21 sagte Jakob "…aber wenn der Paperhandel, also der Paper Trading laufen würde,"
#: — holte Luft — und Kuro fiel ihm mit "Ja, wenn er liefe?" ins Wort. Jakobs Antwort darauf:
#: "Koro, Du hast mir da grad irgendwas unterbrochen." Der Grund war Arithmetik: 0,8 s bis das
#: VAD die Äußerung beendet, 0,25 s Nachlauf, und nach gut einer Sekunde Denkpause galt der
#: halbe Satz als fertiger Befehl. Am 2026-09-20 zerfiel derselbe Mechanismus einen Satz in
#: vier Züge ("Also es ist ja irgendwie jetzt schon" / "länger." / …).
#:
#: **Gewartet wird nicht pauschal länger, sondern nur beim offenen Satz.** Deepgram liefert
#: Interpunktion mit; ein Stück, das auf Komma oder auf gar nichts endet, ist eine Ansage, dass
#: noch etwas kommt. Wer "Wie wird das Wetter?" fragt, wartet weiterhin eine Viertelsekunde.
_SATZ_PAUSE_OFFEN_SECS = float(os.environ.get("VOICE_UTTERANCE_GAP_OPEN_SECS") or 1.2)
#: Woran ein **offener** Satz zu erkennen ist: ein Komma, ein Semikolon, ein Gedankenstrich
#: oder ein Bindewort am Schluss.
#:
#: Bewusst nicht „es fehlt ein Satzzeichen": ein gesprochener Befehl endet oft ohne Punkt
#: ("Sieh mal im Postfach"), und der müsste dann jedes Mal die lange Pause abwarten — Kuro
#: wäre spürbar träger, und zwar in **jedem** Zug, um einen seltenen Fall zu fangen. Ein
#: Komma dagegen ist eine Ansage: hier geht es weiter. Genau die stand am 2026-09-21 im
#: Transkript ("…also der Paper Trading laufen würde,"), und genau die hat niemand gelesen.
_SATZ_OFFEN = re.compile(
    r"(?:[,;]|\s[–-]|\b(?:und|aber|oder|weil|dass|wenn|also|sondern|denn|dann)\s*)$",
    re.IGNORECASE,
)
#: Satzende, gefolgt von Leerraum — dort darf die Stimme anfangen, bevor der Rest da ist.
#:
#: **Der Doppelpunkt stand hier bis 2026-09-21 mit drin, und er war ein Fehler.** Kuro leitet
#: Aufzählungen damit ein ("Dabei läuft mit:", "Wie eng der Takt ist, hängt davon ab:"), und
#: jedes dieser Stücke ging als **eigener** Auftrag an den Sprachdienst. Im Protokoll dieses
#: Abends steht eine einzige Antwort als 13 getrennte Aufrufe, der kürzeste 16 Zeichen lang.
#: Das hört man doppelt: die Sprachmelodie fängt jedes Mal neu an, und ein Anbieter, der die
#: Sprache aus dem Text errät, hat bei 16 Zeichen nichts, woran er sie erkennen könnte —
#: genau dort kippte die Aussprache englischer Fachbegriffe.
_SENTENCE_END = re.compile(r"(?<=[.!?…])\s+")
#: Kürzer als das wird kein Stück allein gesprochen; es wartet auf das nächste.
#:
#: Fängt den Rest, den der Doppelpunkt übrig lässt: Ordnungszahlen ("am 20. September"),
#: Abkürzungen ("z. B.", "u. a.", "ca.") und Ausrufe. Ein Punkt ist im Deutschen eben nicht
#: immer ein Satzende, und eine Liste der Ausnahmen wäre nie vollständig — die Länge ist das
#: Merkmal, das ohne Wörterbuch auskommt.
_MIN_SATZ_ZEICHEN = 60
#: Was vorgelesen keinen Sinn ergibt: Markdown-Auszeichnung, Listenpunkte, Überschriften.
_MARKDOWN_NOISE = re.compile(r"(\*\*|__|`+|^#{1,6}\s+|^\s*[-*]\s+|^\s*\d+\.\s+)", re.MULTILINE)


def speakable(text: str) -> str:
    """Text, wie er gesprochen wird: ohne Markdown-Zeichen, die als Wörter vorgelesen würden."""
    return _MARKDOWN_NOISE.sub("", text).strip()


class LiveSentences:
    """Sammelt Textstücke und spricht jeden Satz, sobald er vollständig ist (Streaming, 2026-09-16).

    Das ist der Unterschied zwischen einem Assistenten, der eine Minute schweigt und dann
    vorliest, und einem, der beim ersten Satz zu reden anfängt, während er noch arbeitet. Der
    Rest, der beim Ende noch ohne Satzzeichen dasteht, geht per `flush`.
    """

    def __init__(self, speak: Callable[[str], Awaitable[None]]) -> None:
        self._speak = speak
        self._buffer = ""
        #: Fertige Sätze, die für sich allein zu kurz zum Sprechen wären.
        self._offen = ""
        self.spoken = False
        #: Was tatsächlich zum Sprechen ging. Nach einem Barge-in ist das die Grenze zwischen
        #: dem, was Jakob gehört hat, und dem, was er nicht gehört hat.
        self.gesprochen = ""

    async def feed(self, text: str) -> None:
        self._buffer += text
        parts = _SENTENCE_END.split(self._buffer)
        # Der Rest hinter dem letzten Satzzeichen bleibt liegen — er ist noch nicht fertig.
        fertig, self._buffer = parts[:-1], parts[-1]
        for sentence in fertig:
            self._offen = f"{self._offen} {sentence}".strip() if self._offen else sentence
            if len(self._offen) >= _MIN_SATZ_ZEICHEN:
                satz, self._offen = self._offen, ""
                await self._say(satz)

    async def flush(self) -> None:
        """Zum Schluss geht alles raus — auch das, was für sich zu kurz wäre."""
        rest, self._buffer = self._buffer, ""
        offen, self._offen = self._offen, ""
        await self._say(f"{offen} {rest}".strip() if offen else rest)

    async def _say(self, text: str) -> None:
        cleaned = speakable(text)
        if not cleaned:
            return
        self.spoken = True
        self.gesprochen = f"{self.gesprochen} {cleaned}".strip() if self.gesprochen else cleaned
        await self._speak(cleaned)
from voice.pipeline.protocol import server_message


class KuronamiBridge(FrameProcessor):
    """Erkannter Text rein, gesprochene Antwort raus — über das Gateway."""

    def __init__(
        self,
        *,
        config: VoiceConfig,
        client: GatewayClient,
        ledger: LatencyLedger,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self._config = config
        self._client = client
        self._ledger = ledger

        self._authenticated = False
        self._bot_speaking = False
        self._user_speaking = False
        self._turn_seq = 0
        self._turn_task: asyncio.Task[None] | None = None
        self._pending_approval: Approval | None = None
        self._outbox_task: asyncio.Task[None] | None = None
        #: Das zuletzt zum Sprechen gegebene Stück — der Anhaltspunkt, an dem ein Barge-in
        #: die Antwort zerschnitten hat.
        self._zuletzt_gesprochen = ""
        #: Gesetzt, wenn eine Antwort ungehört verfallen ist. Geht als Vermerk in den nächsten
        #: Zug und wird dabei verbraucht.
        self._verfallen: str | None = None
        #: Die Stücke der laufenden Äußerung, bis feststeht, dass sie zu Ende ist.
        self._satz: list[str] = []
        self._satz_task: asyncio.Task[None] | None = None
        #: Hält Jakob die Sprechtaste (Leertaste im Browser)? Dann ist nichts zu Ende gesagt,
        #: was er zwischendurch mit Pausen spricht — der Satz geht erst nach dem Loslassen.
        self._taste_unten = False
        self._taste_los = 0.0

    # -- Zustand nach außen ---------------------------------------------------------------

    @property
    def authenticated(self) -> bool:
        return self._authenticated

    @property
    def pending_approval(self) -> Approval | None:
        return self._pending_approval

    @property
    def turn_in_flight(self) -> bool:
        """Ob gerade ein Zug läuft — **einschließlich der Sekunde, in der noch gesammelt wird.**

        Bis 2026-09-21 zählte nur der abgeschickte Zug. Dazwischen lag aber ein Loch: zwischen
        dem Ende einer Äußerung und dem Absenden des Befehls wartet die Brücke auf eine
        mögliche Fortsetzung (`_satz_abwarten`), und in dieser Zeit hielt sich der Postfachblick
        für berechtigt, einen nachgereichten Bericht vorzutragen. Jakob hat am selben Abend
        genau das gehört und gesagt: „Koro, Du hast mir da grad irgendwas unterbrochen."
        """
        laufend = self._turn_task is not None and not self._turn_task.done()
        sammelnd = self._satz_task is not None and not self._satz_task.done()
        return laufend or sammelnd

    # -- Nachrichten an den Client --------------------------------------------------------

    async def _emit(self, kind: str, **fields: Any) -> None:
        """Eine Steuernachricht an den Client. **Urgent**, damit sie nicht hinter dem Audio
        wartet: ein `state`-Wechsel, der nach der Stimme ankommt, beschreibt die Vergangenheit."""
        await self.push_frame(
            OutputTransportMessageUrgentFrame(message=server_message(kind, **fields)),
            FrameDirection.DOWNSTREAM,
        )

    async def _emit_state(self, state: str) -> None:
        await self._emit("state", state=state)

    async def _speak(self, text: str) -> None:
        cleaned = speakable(text)
        if not cleaned:
            return
        self._ledger.mark("speech_queued")
        self._zuletzt_gesprochen = cleaned
        await self._emit_state("speaking")
        await self.push_frame(TTSSpeakFrame(text=cleaned), FrameDirection.DOWNSTREAM)

    def _live(self, mine: int) -> tuple[LiveSentences, dict[str, Any]]:
        """Die satzweise Stimme für einen Zug — und die Argumente, mit denen der Client sie
        bekommt. Nur bei einem Client, der streamen kann; die Fakes der Tests kennen den
        Parameter nicht und sollen ihn nicht kennen müssen."""
        live = LiveSentences(self._speak)
        if not getattr(self._client, "supports_streaming", False):
            return live, {}

        async def on_delta(text: str) -> None:
            if mine != self._turn_seq:
                return
            await live.feed(text)

        return live, {"on_delta": on_delta}

    # -- Frames ---------------------------------------------------------------------------

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, InputTransportMessageFrame):
            await self._on_client_message(frame.message)
        elif isinstance(frame, VADUserStartedSpeakingFrame):
            await self._on_user_started()
        elif isinstance(frame, VADUserStoppedSpeakingFrame):
            self._user_speaking = False
            # Der Startpunkt der Messung. Er liegt **vor** dem Transkript, das dem Zug erst
            # seinen Namen gibt — deshalb vorgemerkt und nicht schon gesetzt.
            self._ledger.pre_mark("speech_stopped")
        elif isinstance(frame, BotStartedSpeakingFrame):
            self._bot_speaking = True
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._bot_speaking = False
            # Zu Ende gesprochen heißt: nichts ist verfallen, es gibt nichts zu vermerken.
            self._zuletzt_gesprochen = ""
            if not self.turn_in_flight:
                await self._emit_state("idle")
        elif isinstance(frame, InterruptionFrame):
            await self._abandon_turn()
        elif isinstance(frame, InterimTranscriptionFrame):
            await self._emit("transcript", text=frame.text, final=False)
        elif isinstance(frame, TranscriptionFrame):
            await self._on_transcript(frame.text)

        # Alles wird weitergereicht, auch was oben schon behandelt wurde: dieser Prozessor ist
        # ein Abzweig, keine Schleuse. Ein verschluckter Frame fehlte der Stimme oder dem
        # Transport, und zwar ohne Spur.
        await self.push_frame(frame, direction)

    async def _on_client_message(self, message: Any) -> None:
        if not isinstance(message, dict):
            return
        kind = message.get("type")

        if kind == "hello":
            presented = str(message.get("token") or "")
            if hmac.compare_digest(presented, self._config.session_token):
                self._authenticated = True
                logger.info("Sprachsitzung angemeldet.")
                await self._emit(
                    "ready",
                    mode=self._config.mode,
                    audio_in_sample_rate=self._config.audio_in_sample_rate,
                    audio_out_sample_rate=self._config.audio_out_sample_rate,
                    latency_budget_ms=self._config.latency_budget_ms,
                )
                await self._emit_state("idle")
                self._start_outbox_watch()
            else:
                logger.warning("Sprachsitzung abgewiesen: VOICE_SESSION_TOKEN stimmt nicht.")
                await self._emit("error", message="Das Sitzungsgeheimnis stimmt nicht.")
            return

        if kind == "taste" and self._authenticated:
            await self._taste(bool(message.get("unten")))
            return

        if kind == "answer" and self._authenticated:
            ask_id = str(message.get("askId") or "")
            choice_id = str(message.get("choiceId") or "")
            if ask_id and choice_id:
                self._start(self._answer(ask_id, choice_id))
            return

    async def _on_user_started(self) -> None:
        if not self._authenticated:
            return
        self._user_speaking = True
        await self._emit_state("listening")
        # Der eigentliche Barge-in: **die Stimme läuft**, und der Nutzer redet dazwischen.
        #
        # Hier stand bis 2026-09-20 ein zweiter Auslöser — "oder ein Zug ist unterwegs". Der
        # war gut gemeint und in der Praxis der Grund, warum gesprochene Befehle nur halb
        # ankamen: das VAD beendet eine Äußerung nach kurzer Stille, und wer mitten im Satz
        # Luft holt, fängt danach neu an. Genau das lag am 2026-09-20 im Protokoll — 254 ms
        # Pause, und der gerade abgeschickte Zug war weggeworfen, während die Fortsetzung als
        # eigener Befehl durchging ("Wie meinen Sie das, Jakob?"). Dazu kam, dass der Abbruch
        # ohnehin nichts spart: der Zug läuft im Gateway zu Ende, er wird nur nicht gehört.
        #
        # Ein Befehl, der wirklich neu ist, verdrängt den alten weiter — das erledigt `_start`,
        # sobald ein Transkript vorliegt. Der Unterschied ist, dass dafür jetzt Worte nötig
        # sind und nicht ein Atemzug.
        if self._bot_speaking:
            logger.debug("Barge-in: Nutzer redet dazwischen.")
            await self.broadcast_interruption()
            # `broadcast_interruption` erreicht die **anderen** Prozessoren, nicht den Absender.
            # Der eigene Zug muss deshalb hier fallengelassen werden — sonst spräche die Antwort,
            # die schon unterwegs war, gleich über den Nutzer hinweg.
            await self._abandon_turn()

    async def _taste(self, unten: bool) -> None:
        """Die Sprechtaste (2026-09-27).

        Jakob sprach mit gehaltener Leertaste, machte Pausen, und Kuro antwortete auf jedes
        Bruchstück („Ich höre." / „Und der zweite Punkt?"). Mit der Taste gibt es ein
        eindeutiges Zeichen, das das VAD nicht hat: **solange sie unten ist, ist nichts zu
        Ende gesagt.** Und wer sie drückt, will reden — Kuros laufende Antwort bricht sofort
        ab, nicht erst, wenn das VAD ein Wort gehört hat.
        """
        self._taste_unten = unten
        if not unten:
            self._taste_los = time.monotonic()
        if unten:
            if self._bot_speaking or self.turn_in_flight:
                await self.broadcast_interruption()
                await self._abandon_turn()
            await self._emit_state("listening")
            return
        # Losgelassen: was gesammelt ist, geht nach der üblichen Pause hinaus. Kommt das letzte
        # Stück erst noch aus der Erkennung, startet `_on_transcript` das Warten selbst.
        if self._satz and (self._satz_task is None or self._satz_task.done()):
            self._satz_task = self.create_task(self._satz_abwarten())

    async def _on_transcript(self, text: str) -> None:
        if not self._authenticated:
            # Kein Transkript geht ins Backend, bevor sich jemand ausgewiesen hat. Der
            # WebSocket-Rand selbst kann das nicht prüfen (die Pipecat-Transporte nehmen die
            # Verbindung an, bevor ein Frame entsteht) — also prüft es die Stelle, an der aus
            # Ton eine Handlung würde.
            await self._emit("error", message="Nicht angemeldet: zuerst eine hello-Nachricht.")
            return

        cleaned = text.strip()
        await self._emit("transcript", text=cleaned, final=True)
        if not cleaned:
            return

        # **Ein Transkriptstück ist noch kein Befehl.**
        #
        # Deepgram schließt ein Segment ab, sobald es eine Pause hört, und Pipecat macht aus
        # *jedem* dieser Abschlüsse einen `TranscriptionFrame` (`stt.py`: `if is_final: …
        # push_frame(TranscriptionFrame(...))`). Wer mitten im Satz Luft holt, schickt damit
        # zwei Befehle statt einem — am 2026-09-20 wurde aus „sieh mal im Postfach nach" ein
        # Auftrag und ein Rest, auf den Kuro mit „Wie meinen Sie das, Jakob?" antwortete.
        #
        # Deshalb wird gesammelt und erst abgeschickt, wenn zweierlei zutrifft: seit dem
        # letzten Stück ist eine kurze Pause vergangen, **und** das VAD sagt, dass nicht mehr
        # geredet wird. Das kostet eine Viertelsekunde und spart die halbe Frage.
        self._satz.append(cleaned)
        if self._satz_task is not None and not self._satz_task.done():
            self._satz_task.cancel()
        self._satz_task = self.create_task(self._satz_abwarten())

    async def _satz_abwarten(self) -> None:
        """Wartet das Ende der Äußerung ab und schickt sie dann als einen Befehl."""
        offen = bool(_SATZ_OFFEN.search(self._satz[-1].strip())) if self._satz else False
        await asyncio.sleep(_SATZ_PAUSE_OFFEN_SECS if offen else _SATZ_PAUSE_SECS)
        # Solange das VAD noch Stimme hört, kommt noch etwas nach — und solange die Sprechtaste
        # unten ist, auch (höchstens zwei Minuten: eine verlorene Taste hält nicht ewig fest).
        gewartet = 0.0
        while self._user_speaking or (self._taste_unten and gewartet < 120):
            await asyncio.sleep(0.1)
            gewartet += 0.1
        # Eben losgelassen? Dann das letzte Stück abwarten. Kommt es, beginnt `_on_transcript`
        # dieses Warten neu, und alles geht zusammen hinaus.
        rest = self._taste_los + _TASTE_NACHLAUF_SECS - time.monotonic()
        if rest > 0:
            await asyncio.sleep(rest)
            while self._user_speaking:
                await asyncio.sleep(0.1)
        teile, self._satz = self._satz, []
        satz = " ".join(teile).strip()
        if satz:
            await self._ausfuehren(satz)

    async def _ausfuehren(self, satz: str) -> None:
        approval = self._pending_approval
        if approval is not None:
            options = [Choice(id=option.id, label=option.label) for option in approval.options]
            choice = match_choice(satz, options)
            if choice is None:
                await self._speak(
                    "Das habe ich nicht als Antwort erkannt. "
                    + spoken_question(approval.question, options)
                )
                return
            self._pending_approval = None
            self._start(self._answer(approval.ask_id, choice))
            return

        self._start(self._turn(satz))

    # -- Züge -----------------------------------------------------------------------------

    def _start(self, coro: Any) -> None:
        """Startet einen Zug und macht jeden früheren ungültig.

        Der Zähler ist die eigentliche Absicherung: eine Antwort, die nach einem Barge-in
        eintrifft, gehört zu einem Zug, den niemand mehr hören will. Ohne ihn spräche sie
        trotzdem — das Abbrechen der Aufgabe allein genügt nicht, weil der Abbruch mitten in
        einem `await` auch einmal zu spät kommen kann.
        """
        self._turn_seq += 1
        previous = self._turn_task
        if previous is not None and not previous.done():
            previous.cancel()
        self._turn_task = self.create_task(coro)

    async def _abandon_turn(self) -> None:
        """Was nach einem Barge-in passiert: nichts mehr sprechen, nichts mehr abwarten.

        **Und: es wird vermerkt.** Bis 2026-09-21 verfiel der Rest der Antwort ersatzlos,
        während im Gesprächsverlauf des Motors die *vollständige* Antwort als gesagt stand.
        Kuro konnte deshalb nicht wissen, was Jakob gehört hatte. Als der ihm an diesem Abend
        vorhielt, den Bericht des Handelstischs nicht zu Ende vorgelesen zu haben, blieb ihm
        nur zu raten ("Entschuldigung, das war keine Absicht — ich hatte nur kurz bestätigt…").
        Der Vermerk unten fährt beim nächsten Zug mit und macht aus dem Raten ein Wissen.
        """
        if self._bot_speaking and self._zuletzt_gesprochen:
            self._verfallen = self._zuletzt_gesprochen
            self._zuletzt_gesprochen = ""
        self._turn_seq += 1
        task = self._turn_task
        self._turn_task = None
        if task is not None and not task.done():
            task.cancel()
        await self._emit_state("listening")

    def _mit_vermerk(self, text: str) -> str:
        """Hängt dem Befehl an, was Jakob von der letzten Antwort nicht gehört hat."""
        verfallen, self._verfallen = self._verfallen, None
        if not verfallen:
            return text
        marke = verfallen[:120] + ("…" if len(verfallen) > 120 else "")
        return (
            "[Hinweis der Sprachschicht: Deine vorige Antwort wurde unterbrochen; ab "
            f"\u201e{marke}\u201c hat Jakob sie nicht mehr gehört. Frage nicht danach und "
            "wiederhole nichts von selbst — greife den Rest nur auf, wenn er ihn verlangt.]"
            "\n\n" + text
        )

    async def _turn(self, text: str) -> None:
        mine = self._turn_seq
        self._ledger.begin_with_pending(str(uuid.uuid4()))
        self._ledger.mark("transcript_final")
        await self._emit_state("thinking")

        self._ledger.mark("gateway_sent")
        live, kwargs = self._live(mine)
        try:
            result = await self._client.turn(self._mit_vermerk(text), str(uuid.uuid4()), **kwargs)
        except asyncio.CancelledError:
            raise
        except GatewayError as error:
            await self._fail(str(error))
            return
        except Exception as error:  # noqa: BLE001 — der Text geht unverändert an den Nutzer
            await self._fail(f"{type(error).__name__}: {error}")
            return
        self._ledger.mark("gateway_replied")

        if mine != self._turn_seq:
            logger.debug("Antwort verworfen: der Zug wurde unterbrochen.")
            return
        await self._deliver(result, live)

    async def _answer(self, ask_id: str, choice_id: str) -> None:
        mine = self._turn_seq
        await self._emit_state("thinking")
        live, kwargs = self._live(mine)
        try:
            result = await self._client.answer(ask_id, choice_id, str(uuid.uuid4()), **kwargs)
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 — der Text geht unverändert an den Nutzer
            await self._fail(str(error))
            return
        if mine != self._turn_seq:
            return
        await self._deliver(result, live)

    async def _deliver(self, result: GatewayTurn, live: LiveSentences | None = None) -> None:
        """Was vom Zug übrig ist, wird gesprochen — Antwort oder Frage, nie beides verschluckt.

        Lief die Stimme schon während des Zugs (`live.spoken`), ist die Antwort bereits
        gesprochen bis auf den Rest ohne Satzzeichen — der geht jetzt, und `result.text` wird
        nicht ein zweites Mal vorgelesen. Kam nichts unterwegs (eine Absage des Gateways, eine
        Antwort ohne Modellaufruf), wird gesprochen wie bisher.
        """
        await self._emit("reply", text=result.text, status=result.status, reason=result.reason)

        if live is not None:
            await live.flush()

        if result.approvals:
            approval = result.approvals[0]
            self._pending_approval = approval
            options = [Choice(id=option.id, label=option.label) for option in approval.options]
            await self._emit(
                "approval",
                askId=approval.ask_id,
                question=approval.question,
                options=[{"id": option.id, "label": option.label} for option in approval.options],
            )
            await self._speak(spoken_question(approval.question, options))
        elif live is None or not live.spoken:
            await self._speak(result.text)

    # -- Das Postfach ---------------------------------------------------------------------

    def _start_outbox_watch(self) -> None:
        """Sieht nach der Anmeldung nach, ob etwas Unaufgefordertes zugestellt wurde."""
        if self._outbox_task is not None and not self._outbox_task.done():
            return
        if not hasattr(self._client, "outbox"):
            # Ein Client ohne Postfach (die Fakes der Tests) — dann gibt es nichts zu holen.
            return
        self._outbox_task = self.create_task(self._watch_outbox())

    async def _watch_outbox(self) -> None:
        """Trägt vor, was ohne Aufruf von hier zugestellt wurde.

        Gesprochen wird nur in der Stille: nicht während ein Zug läuft (dessen Antwort kommt
        über seinen eigenen Strom), nicht während die Stimme schon redet, und nicht, während
        der Nutzer spricht.

        **Hier stand kurzzeitig ein Zähler für abgebrochene Züge** — und er war falsch. Die
        Überlegung war, dass ein abgebrochener Zug im Gateway zu Ende läuft und seine Antwort
        trotzdem ins Fach legt. Das stimmt, aber sie bleibt dort nicht liegen: der Gateway
        leert das Fach am Ende **desselben** Aufrufs (`respondVoiceTurn`, `voice.drain`), auch
        wenn niemand mehr zuhört. Der Zähler traf deshalb nie die Antwort, für die er gedacht
        war, sondern die nächste unschuldige — am 2026-09-20 den Bericht des Handelstischs,
        auf den Jakob drei Minuten gewartet hatte.
        """
        while True:
            await asyncio.sleep(_OUTBOX_POLL_SECS)
            if not self._authenticated:
                continue
            if self.turn_in_flight or self._bot_speaking or self._user_speaking:
                continue
            if self._pending_approval is not None:
                continue
            try:
                texte = await self._client.outbox()  # type: ignore[attr-defined]
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 — ein stummes Postfach ist kein Absturz
                logger.debug(f"Postfach nicht abrufbar: {error}")
                continue
            for text in texte:
                logger.info("Nachtrag aus dem Postfach wird vorgetragen.")
                await self._speak(text)

    async def cleanup(self) -> None:
        """Beim Herunterfahren bleibt kein Zug in der Luft hängen.

        Ohne diese Zeile meldet Pipecat beim Beenden eine "dangling task" — und die wäre kein
        kosmetischer Hinweis, sondern ein HTTP-Aufruf ins Backend, dessen Antwort niemand mehr
        entgegennimmt.
        """
        task = self._turn_task
        self._turn_task = None
        if task is not None and not task.done():
            await self.cancel_task(task)
        satz = self._satz_task
        self._satz_task = None
        if satz is not None and not satz.done():
            await self.cancel_task(satz)
        watch = self._outbox_task
        self._outbox_task = None
        if watch is not None and not watch.done():
            await self.cancel_task(watch)
        await super().cleanup()

    async def _fail(self, message: str) -> None:
        """Ein Fehlschlag wird gesagt, nicht geglättet (AGENTS.md)."""
        logger.error(f"Sprachzug fehlgeschlagen: {message}")
        await self._emit("error", message=message)
        await self._speak(f"Der Lauf ist fehlgeschlagen. {message}")
