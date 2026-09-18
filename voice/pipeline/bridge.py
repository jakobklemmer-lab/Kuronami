"""Die Backend-Brücke (S31): der Prozessor, der aus erkanntem Text einen Zug macht.

In einer üblichen Pipecat-Pipeline steht an dieser Stelle ein LLM-Dienst. Hier steht das
**Gateway** — der Agent dieses Systems ist keine Modell-Antwort, sondern ein Lauf mit Werkzeugen,
Freigaben und einem Gedächtnis, und der gehört hinter dieselbe Tür wie Telegram und Slack. Daraus
folgen drei Dinge, die dieser Prozessor zusätzlich zum Weiterreichen erledigt:

**1. Unterbrechen (das Fertig-Kriterium von S31).** Ohne LLM-Dienst gibt es auch keinen
LLM-Aggregator, und der wäre in einer Standard-Pipeline die Stelle, die bei einsetzender
Nutzerstimme `broadcast_interruption()` auslöst. Also tut es diese Datei: sagt das VAD "der Nutzer
redet", während die Stimme läuft oder ein Zug in der Luft ist, wird unterbrochen — die Ausgabe des
Transports fällt sofort weg, und die Antwort, die gerade unterwegs war, wird **nicht mehr
gesprochen**.

**Was Unterbrechen ausdrücklich nicht heißt: den Lauf abbrechen.** `runner.cancel()` schreibt
`session.canceled` (S05), und die Session der Sprachschicht ist dieselbe durchgehende Unterhaltung
wie im Web und auf Telegram (`gateway/conversation.ts`). Ein Dazwischenreden würde damit das
Gespräch beenden statt es zu lenken. Unterbrechen heißt hier: hör auf zu reden und hör mir zu. Der
angestoßene Zug läuft im Gateway zu Ende und steht dort im Protokoll — er wird nur nicht mehr
vorgelesen.

**2. Freigaben.** Hält das Gateway an (`awaiting_user`), kommt die Frage samt ihrer Optionen
zurück. Sie wird vorgelesen, und die nächste Äußerung wird gegen die Optionen abgeglichen
(`choices.py`) — ohne Modell, ohne Raten. Kein Treffer heißt Nachfragen.

**3. Zustände.** Der Mic-Knopf der Oberfläche kennt sechs Zustände (`ui/mic/state.ts`); diese
Brücke bedient vier davon: `listening`, `thinking`, `speaking`, `idle`. `executing` und `complete`
bleiben aus, und zwar bewusst: hinter einem einzelnen HTTP-Aufruf lässt sich "denkt nach" nicht
von "ruft gerade ein Werkzeug auf" unterscheiden. Wer das sehen will, sieht es am Ereignisstrom
(S21) — dort steht jeder Werkzeugaufruf einzeln. Einen Zustand zu senden, den diese Schicht nicht
kennt, wäre eine Anzeige, die ausgedacht ist.
"""

from __future__ import annotations

import asyncio
import hmac
import re
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

#: Satzende, gefolgt von Leerraum — dort darf die Stimme anfangen, bevor der Rest da ist.
_SENTENCE_END = re.compile(r"(?<=[.!?…:])\s+")
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
        self.spoken = False

    async def feed(self, text: str) -> None:
        self._buffer += text
        parts = _SENTENCE_END.split(self._buffer)
        for sentence in parts[:-1]:
            await self._say(sentence)
        self._buffer = parts[-1]

    async def flush(self) -> None:
        rest, self._buffer = self._buffer, ""
        await self._say(rest)

    async def _say(self, text: str) -> None:
        cleaned = speakable(text)
        if not cleaned:
            return
        self.spoken = True
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
        self._turn_seq = 0
        self._turn_task: asyncio.Task[None] | None = None
        self._pending_approval: Approval | None = None

    # -- Zustand nach außen ---------------------------------------------------------------

    @property
    def authenticated(self) -> bool:
        return self._authenticated

    @property
    def pending_approval(self) -> Approval | None:
        return self._pending_approval

    @property
    def turn_in_flight(self) -> bool:
        return self._turn_task is not None and not self._turn_task.done()

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
            # Der Startpunkt der Messung. Er liegt **vor** dem Transkript, das dem Zug erst
            # seinen Namen gibt — deshalb vorgemerkt und nicht schon gesetzt.
            self._ledger.pre_mark("speech_stopped")
        elif isinstance(frame, BotStartedSpeakingFrame):
            self._bot_speaking = True
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._bot_speaking = False
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
            else:
                logger.warning("Sprachsitzung abgewiesen: VOICE_SESSION_TOKEN stimmt nicht.")
                await self._emit("error", message="Das Sitzungsgeheimnis stimmt nicht.")
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
        await self._emit_state("listening")
        # Der eigentliche Barge-in. Zwei Auslöser, nicht einer: die Stimme läuft noch **oder**
        # ein Zug ist unterwegs, dessen Antwort gleich gesprochen würde. Ohne den zweiten Fall
        # redete der Agent los, nachdem der Nutzer längst neu angesetzt hat.
        if self._bot_speaking or self.turn_in_flight:
            logger.debug("Barge-in: Nutzer redet dazwischen.")
            await self.broadcast_interruption()
            # `broadcast_interruption` erreicht die **anderen** Prozessoren, nicht den Absender.
            # Der eigene Zug muss deshalb hier fallengelassen werden — sonst spräche die Antwort,
            # die schon unterwegs war, gleich über den Nutzer hinweg.
            await self._abandon_turn()

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

        approval = self._pending_approval
        if approval is not None:
            options = [Choice(id=option.id, label=option.label) for option in approval.options]
            choice = match_choice(cleaned, options)
            if choice is None:
                await self._speak(
                    "Das habe ich nicht als Antwort erkannt. "
                    + spoken_question(approval.question, options)
                )
                return
            self._pending_approval = None
            self._start(self._answer(approval.ask_id, choice))
            return

        self._start(self._turn(cleaned))

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
        """Was nach einem Barge-in passiert: nichts mehr sprechen, nichts mehr abwarten."""
        self._turn_seq += 1
        task = self._turn_task
        self._turn_task = None
        if task is not None and not task.done():
            task.cancel()
        await self._emit_state("listening")

    async def _turn(self, text: str) -> None:
        mine = self._turn_seq
        self._ledger.begin_with_pending(str(uuid.uuid4()))
        self._ledger.mark("transcript_final")
        await self._emit_state("thinking")

        self._ledger.mark("gateway_sent")
        live, kwargs = self._live(mine)
        try:
            result = await self._client.turn(text, str(uuid.uuid4()), **kwargs)
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
        await super().cleanup()

    async def _fail(self, message: str) -> None:
        """Ein Fehlschlag wird gesagt, nicht geglättet (AGENTS.md)."""
        logger.error(f"Sprachzug fehlgeschlagen: {message}")
        await self._emit("error", message=message)
        await self._speak(f"Der Lauf ist fehlgeschlagen. {message}")
