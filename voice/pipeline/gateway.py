"""Die Backend-Brücke, Transportseite (S31): wie die Sprachschicht mit dem Gateway spricht.

**Warum HTTP an das Gateway und nicht direkt an die Runtime.** Weil es sonst zwei Wege in
denselben Lauf gäbe, und der zweite wäre einer ohne Authentifizierung, ohne normalisierte
Nachrichtenform und ohne `gateway.received` im Protokoll. Abschnitt 3 sagt dazu: die Runtime hängt
nie an der Surface-Schicht, und jede Außenwelt geht durch das Gateway. Die Sprachschicht ist
Außenwelt — ein eigener Prozess, in einer anderen Sprache, hinter einer Prozessgrenze.

Sie ist damit derselbe Fall wie Telegram oder Slack, nur dass der Kanal `voice` heißt und der
Client hier steht statt in `gateway/channels/`. Die Gegenstelle ist `POST /channels/voice/messages`
und `POST /channels/voice/answers`.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

import aiohttp

#: Ein Textstück des Modells, sobald es da ist (Streaming, 2026-09-16). Asynchron, weil der
#: Empfänger es sprechen will, und Sprechen ist ein Frame in der Pipeline.
OnDelta = Callable[[str], Awaitable[None]]


@dataclass(frozen=True)
class ApprovalOption:
    id: str
    label: str


@dataclass(frozen=True)
class Approval:
    ask_id: str
    question: str
    options: tuple[ApprovalOption, ...]


@dataclass(frozen=True)
class GatewayTurn:
    """Was ein Zug zurückgibt — dieselbe Form wie im Web-Kanal, nur ausgepackt."""

    session_id: str
    status: str
    reason: str
    #: Was gesprochen werden soll. Leer, wenn der Zug nur eine Freigabeanfrage hinterlassen hat.
    text: str
    approvals: tuple[Approval, ...] = field(default=())

    @property
    def awaiting_user(self) -> bool:
        return self.status == "awaiting_user" or bool(self.approvals)


class GatewayError(RuntimeError):
    """Das Gateway hat abgelehnt oder war nicht erreichbar. Der Text geht so an den Nutzer."""


class GatewayClient(Protocol):
    """Was die Brücke vom Backend braucht. Zwei Verben — mehr kennt ein Sprachzug nicht."""

    async def turn(self, text: str, external_id: str) -> GatewayTurn: ...

    async def answer(self, ask_id: str, choice_id: str, external_id: str) -> GatewayTurn: ...

    async def close(self) -> None: ...


def parse_turn(payload: dict[str, Any]) -> GatewayTurn:
    """Liest die Antwort des Gateways.

    Gesprochen wird, was im **Postfach** liegt (`deliveries`), nicht das `reason`-Feld: das
    Postfach trägt genau die Zustellungen dieses Aufrufs, in ihrer Reihenfolge, und darin steht
    auch eine Freigabeanfrage, die mitten im Zug entstanden ist. `reason` ist die Begründung für
    den Betreiber und wäre vorgelesen oft eine Zumutung ("Schrittobergrenze erreicht").
    """
    replies: list[str] = []
    approvals: list[Approval] = []

    for delivery in payload.get("deliveries") or []:
        message = delivery.get("message") if isinstance(delivery, dict) else None
        if not isinstance(message, dict):
            continue
        kind = message.get("kind")
        if kind == "reply" and isinstance(message.get("text"), str):
            replies.append(message["text"])
        elif kind == "approval":
            options = tuple(
                ApprovalOption(id=str(option.get("id")), label=str(option.get("label")))
                for option in message.get("options") or []
                if isinstance(option, dict) and option.get("id") is not None
            )
            approvals.append(
                Approval(
                    ask_id=str(message.get("askId", "")),
                    question=str(message.get("question", "")),
                    options=options,
                )
            )

    status = str(payload.get("status", "unbekannt"))
    reason = str(payload.get("reason", ""))
    # Ein Zug ohne einzige Zustellung ist kein Fehler (eine doppelte Nachricht wird still
    # verworfen, siehe `hasReceived`) — dann bleibt nur die Begründung, und die ist ehrlicher
    # als Schweigen.
    text = "\n\n".join(replies) if replies else ("" if approvals else reason)

    return GatewayTurn(
        session_id=str(payload.get("sessionId", "")),
        status=status,
        reason=reason,
        text=text,
        approvals=tuple(approvals),
    )


class HttpGatewayClient:
    """Der echte Client. Eine Sitzung für den ganzen Prozess, wie überall sonst."""

    def __init__(
        self,
        *,
        base_url: str,
        token: str,
        reply_to: str = "voice",
        display_name: str = "Sprache",
        timeout_secs: float = 180.0,
        session: aiohttp.ClientSession | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._reply_to = reply_to
        self._display_name = display_name
        self._timeout = aiohttp.ClientTimeout(total=timeout_secs)
        self._session = session
        self._owns_session = session is None

    async def _ensure_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=self._timeout)
            self._owns_session = True
        return self._session

    #: Die Brücke fragt danach, bevor sie `on_delta` mitgibt — die Test-Fakes kennen den
    #: Parameter nicht und sollen ihn auch nicht kennen müssen.
    supports_streaming = True

    async def _post(
        self,
        path: str,
        body: dict[str, Any],
        on_delta: OnDelta | None = None,
    ) -> GatewayTurn:
        session = await self._ensure_session()
        url = f"{self._base_url}{path}"
        headers = {"authorization": f"Bearer {self._token}"}
        if on_delta is not None:
            # Streaming (2026-09-16): der Gateway antwortet dann als Ereignisstrom — Textstücke,
            # sobald das Modell sie hat, und am Ende dieselbe JSON-Antwort wie ohne Strom.
            headers["accept"] = "text/event-stream"
        try:
            async with session.post(
                url,
                json={
                    **body,
                    "displayName": self._display_name,
                    "replyTo": self._reply_to,
                },
                headers=headers,
            ) as response:
                if on_delta is not None and response.content_type == "text/event-stream":
                    return await self._read_stream(url, response, on_delta)
                payload = await response.json(content_type=None)
                if response.status >= 400:
                    detail = ""
                    if isinstance(payload, dict):
                        detail = str(payload.get("error") or payload.get("reason") or "")
                    raise GatewayError(f"{url} antwortet {response.status}: {detail or 'ohne Text'}")
                if not isinstance(payload, dict):
                    raise GatewayError(f"{url} antwortet kein JSON-Objekt.")
                return parse_turn(payload)
        except aiohttp.ClientError as error:
            raise GatewayError(f"{url} ist nicht erreichbar: {error}") from error

    async def _read_stream(
        self, url: str, response: aiohttp.ClientResponse, on_delta: OnDelta
    ) -> GatewayTurn:
        """Liest `event:`/`data:`-Blöcke. `delta` trägt Text, `done` die fertige Antwort,
        `error` einen Fehlschlag. Endet der Strom ohne `done`, ist das ein Fehler — eine
        halbe Antwort ist keine."""
        event = ""
        data: list[str] = []
        async for raw in response.content:
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            if line == "":
                if event and data:
                    payload = json.loads("\n".join(data))
                    if event == "delta":
                        text = payload.get("text")
                        if isinstance(text, str) and text:
                            await on_delta(text)
                    elif event == "done":
                        if not isinstance(payload, dict):
                            raise GatewayError(f"{url} antwortet kein JSON-Objekt.")
                        return parse_turn(payload)
                    elif event == "error":
                        detail = str(payload.get("error") or payload.get("reason") or "ohne Text")
                        raise GatewayError(f"{url} meldet: {detail}")
                event = ""
                data = []
                continue
            if line.startswith("event:"):
                event = line[len("event:") :].strip()
            elif line.startswith("data:"):
                data.append(line[len("data:") :].lstrip())
        raise GatewayError(f"{url}: der Ereignisstrom endete ohne Antwort.")

    async def turn(
        self, text: str, external_id: str, on_delta: OnDelta | None = None
    ) -> GatewayTurn:
        return await self._post(
            "/channels/voice/messages",
            {"content": text, "externalId": external_id},
            on_delta,
        )

    async def answer(
        self, ask_id: str, choice_id: str, external_id: str, on_delta: OnDelta | None = None
    ) -> GatewayTurn:
        return await self._post(
            "/channels/voice/answers",
            {"askId": ask_id, "choiceId": choice_id, "externalId": external_id},
            on_delta,
        )

    async def close(self) -> None:
        if self._session is not None and self._owns_session and not self._session.closed:
            await self._session.close()
