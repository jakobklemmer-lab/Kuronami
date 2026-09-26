"""Der Messstand für S31: Unterbrechen und Latenz, gegen eine echte Pipeline.

Was hier läuft, ist **kein** Testdouble der Pipeline: es ist dieselbe `build_app`, derselbe
WebSocket-Transport, derselbe Silero-Rahmen, dieselbe Brücke, dieselbe HTTP-Fahrt zum Backend
(`aiohttp`). Ersetzt sind genau drei Dinge, und jedes mit Grund:

* **Das Backend** ist ein kleiner HTTP-Server in diesem Prozess, dessen Antwortzeit einstellbar
  ist. So lässt sich zeigen, was das Kriterium behauptet: dass die Denkzeit des Agenten die
  Sprachschicht nicht langsam macht.
* **Die Anbieter** sind die Stand-ins aus `services.py` — ohne Schlüssel gibt es keinen Deepgram-
  und keinen Aufruf des Sprachanbieters. Was dadurch ungemessen bleibt, sagt der Bericht selbst.
* **Der Sprachdetektor** ist der Energie-Detektor aus `vad.py`, weil Silero synthetischen Ton
  nicht als Stimme annimmt (nachgeprüft, siehe dort). Die Zeitzählung ist identisch.

Aufruf:

    docker compose run --rm voice-bench
    # oder direkt:
    python -m voice.bench.measure --runs 5 --agent-delay 2.0
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import socket
import statistics
import struct
import sys
import time
from dataclasses import dataclass, field
from typing import Any

import websockets
from aiohttp import web
from loguru import logger
from pipecat.workers.runner import WorkerRunner

from voice.pipeline.app import build_app
from voice.pipeline.config import VoiceConfig, config_from_env
from voice.pipeline.gateway import HttpGatewayClient

CHUNK_MS = 20
SESSION_TOKEN = "messstand"
BRIDGE_TOKEN = "messstand-bruecke"


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def speech_chunk(sample_rate: int, phase: int) -> tuple[bytes, int]:
    """Ein lauter Block. Für den Energie-Detektor ist genau das "jemand redet"."""
    count = int(sample_rate * CHUNK_MS / 1000)
    out = bytearray()
    for index in range(count):
        angle = 2 * math.pi * 180 * (phase + index) / sample_rate
        out += struct.pack("<h", int(9000 * math.sin(angle)))
    return bytes(out), phase + count


def silence_chunk(sample_rate: int) -> bytes:
    return b"\x00\x00" * int(sample_rate * CHUNK_MS / 1000)


class FakeBackend:
    """Ein Gateway-Doppel mit einstellbarer Denkzeit. Antwortet in der echten Form."""

    def __init__(self, *, delay_secs: float, reply: str) -> None:
        self.delay_secs = delay_secs
        self.reply = reply
        self.calls: list[str] = []
        self._runner: web.AppRunner | None = None
        self.port = free_port()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    async def _messages(self, request: web.Request) -> web.Response:
        body = await request.json()
        self.calls.append(str(body.get("content", "")))
        await asyncio.sleep(self.delay_secs)
        return web.json_response(
            {
                "sessionId": "sess_messstand",
                "status": "answered",
                "reason": "fertig",
                "delivered": [],
                "deliveries": [
                    {
                        "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                        "message": {"kind": "reply", "text": self.reply},
                    }
                ],
            }
        )

    async def start(self) -> None:
        app = web.Application()
        app.router.add_post("/channels/voice/messages", self._messages)
        app.router.add_post("/channels/voice/answers", self._messages)
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        await web.TCPSite(self._runner, "127.0.0.1", self.port).start()

    async def stop(self) -> None:
        if self._runner is not None:
            await self._runner.cleanup()


@dataclass
class Received:
    """Was der Client gehört und gelesen hat, mit Zeitstempeln."""

    messages: list[tuple[float, dict[str, Any]]] = field(default_factory=list)
    audio: list[tuple[float, int]] = field(default_factory=list)

    def first(self, kind: str) -> tuple[float, dict[str, Any]] | None:
        for at, message in self.messages:
            if message.get("type") == kind:
                return at, message
        return None

    def first_after(self, kind: str, after: float) -> tuple[float, dict[str, Any]] | None:
        """Die erste Nachricht dieser Art **nach** einem Zeitpunkt.

        Ohne diese Einschränkung fände ein Barge-in-Lauf die Unterbrechung des vorigen und
        meldete eine negative Dauer — eine Zahl, die aussieht wie ein Messwert und keiner ist.
        """
        for at, message in self.messages:
            if at >= after and message.get("type") == kind:
                return at, message
        return None

    def clear(self) -> None:
        self.messages.clear()
        self.audio.clear()


class BenchClient:
    """Der Sprachclient des Messstands — dieselbe Rolle wie der Browser, ohne Browser."""

    def __init__(self, url: str, sample_rate: int) -> None:
        self.url = url
        self.sample_rate = sample_rate
        self.received = Received()
        self._socket: Any = None
        self._reader: asyncio.Task[None] | None = None
        self._phase = 0

    async def connect(self) -> dict[str, Any]:
        self._socket = await websockets.connect(self.url, max_size=None)
        self._reader = asyncio.create_task(self._read())
        await self.send({"type": "hello", "token": SESSION_TOKEN})
        return await self.await_message("ready", timeout=10.0)

    async def _read(self) -> None:
        try:
            async for raw in self._socket:
                now = time.perf_counter()
                if isinstance(raw, (bytes, bytearray)):
                    self.received.audio.append((now, len(raw)))
                else:
                    try:
                        self.received.messages.append((now, json.loads(raw)))
                    except ValueError:
                        pass
        except websockets.ConnectionClosed:
            return

    async def send(self, message: dict[str, Any]) -> None:
        await self._socket.send(json.dumps(message))

    async def speak(self, seconds: float) -> float:
        """Sendet "Sprache" in Echtzeit. Gibt den Zeitpunkt des ersten Blocks zurück."""
        started = time.perf_counter()
        for _ in range(max(1, int(seconds * 1000 / CHUNK_MS))):
            chunk, self._phase = speech_chunk(self.sample_rate, self._phase)
            await self._socket.send(chunk)
            await asyncio.sleep(CHUNK_MS / 1000)
        return started

    async def stay_silent(self, seconds: float) -> None:
        for _ in range(max(1, int(seconds * 1000 / CHUNK_MS))):
            await self._socket.send(silence_chunk(self.sample_rate))
            await asyncio.sleep(CHUNK_MS / 1000)

    async def await_message(self, kind: str, timeout: float) -> dict[str, Any]:
        deadline = time.perf_counter() + timeout
        while time.perf_counter() < deadline:
            found = self.received.first(kind)
            if found is not None:
                return found[1]
            await asyncio.sleep(0.01)
        raise TimeoutError(f"Keine Nachricht vom Typ {kind!r} innerhalb von {timeout} s.")

    async def await_audio(self, timeout: float) -> float:
        deadline = time.perf_counter() + timeout
        while time.perf_counter() < deadline:
            if self.received.audio:
                return self.received.audio[0][0]
            await asyncio.sleep(0.005)
        raise TimeoutError(f"Kein Audio innerhalb von {timeout} s.")

    async def settle(self, quiet_secs: float = 0.8, timeout: float = 30.0) -> None:
        """Wartet, bis die Stimme wirklich ausgeredet hat — und schickt dabei Stille.

        Ohne diesen Schritt beginnt ein Messlauf mitten in der Antwort des vorigen: die erste
        Äußerung wäre dann selbst schon ein Barge-in, und was danach gemessen wird, gehört zu
        zwei Zügen gleichzeitig.
        """
        deadline = time.perf_counter() + timeout
        while time.perf_counter() < deadline:
            last = self.received.audio[-1][0] if self.received.audio else 0.0
            if time.perf_counter() - last >= quiet_secs:
                return
            await self._socket.send(silence_chunk(self.sample_rate))
            await asyncio.sleep(CHUNK_MS / 1000)
        raise TimeoutError("Die Stimme hört nicht auf zu reden.")

    async def close(self) -> None:
        if self._socket is not None:
            await self._socket.close()
        if self._reader is not None:
            self._reader.cancel()


def bench_config(*, voice_port: int, gateway_url: str) -> VoiceConfig:
    return config_from_env(
        {
            "VOICE_MODE": "loopback",
            "VOICE_VAD": "energy",
            # Der Energie-Detektor braucht keine Lautheitsschwelle obendrauf: die Energie **ist**
            # hier das Kriterium, und zwei Schwellen für dieselbe Frage machen die Messung nur
            # schwerer zu erklären.
            "VOICE_VAD_MIN_VOLUME": "0.0",
            "VOICE_SESSION_TOKEN": SESSION_TOKEN,
            "VOICE_BRIDGE_TOKEN": BRIDGE_TOKEN,
            "VOICE_PORT": str(voice_port),
            "VOICE_GATEWAY_URL": gateway_url,
            "VOICE_LOOPBACK_SECS_PER_WORD": "0.5",
        }
    )


async def measure_latency(client: BenchClient, runs: int) -> list[dict[str, Any]]:
    """Ein Zug nach dem anderen: reden, aufhören, auf das erste Audio-Byte warten."""
    results: list[dict[str, Any]] = []
    for index in range(runs):
        await client.settle()
        client.received.clear()
        await client.send({"type": "utterance", "text": f"Messlauf Nummer {index + 1}"})
        await client.speak(0.6)
        silence = asyncio.create_task(client.stay_silent(30.0))
        report = await client.await_message("latency", timeout=30.0)
        first_audio = await client.await_audio(timeout=5.0)
        silence.cancel()
        results.append({**report, "client_first_audio_at": first_audio})
    return results


async def measure_barge_in(client: BenchClient, runs: int) -> list[dict[str, Any]]:
    """Dazwischenreden, während die Stimme läuft — und messen, wann sie aufhört.

    Der Messpunkt ist absichtlich beim **Hörer** und nicht in der Pipeline: gemessen wird von dem
    Augenblick, in dem der Client den ersten lauten Block schickt, bis zu dem, in dem der letzte
    Audio-Block bei ihm eintrifft. Das ist die Zahl, die der Nutzer erlebt — alles dazwischen
    (VAD-Anlaufzeit, Unterbrechung, geleerter Ausgabepuffer, Netzweg) steckt mit drin.
    """
    results: list[dict[str, Any]] = []
    for index in range(runs):
        await client.settle()
        client.received.clear()
        await client.send(
            {
                "type": "utterance",
                "text": f"Barge-in Lauf {index + 1} mit einer absichtlich langen Antwort",
            }
        )
        await client.speak(0.6)
        silence = asyncio.create_task(client.stay_silent(30.0))
        await client.await_audio(timeout=30.0)
        # Warten, bis die Ausgabe wirklich **läuft**: ein Barge-in gegen eine Stimme, die schon
        # fertig ist, misst nichts, und der Lauf zählt dann auch nicht mit.
        await asyncio.sleep(0.5)
        last_audio_at = client.received.audio[-1][0]
        flowing = (time.perf_counter() - last_audio_at) < 0.25
        silence.cancel()

        audio_before = len(client.received.audio)
        started = await client.speak(0.6)
        after = [at for at, _ in client.received.audio[audio_before:] if at >= started]
        stopped_at = max(after) if after else started

        interrupted = client.received.first_after("interrupted", started)
        results.append(
            {
                "gilt": flowing,
                "barge_in_ms": round((stopped_at - started) * 1000, 2),
                "interrupted_message_ms": (
                    round((interrupted[0] - started) * 1000, 2) if interrupted else None
                ),
                "audio_chunks_after_barge_in": len(after),
            }
        )
    return results


def summarize(values: list[float]) -> dict[str, float]:
    if not values:
        return {}
    return {
        "n": len(values),
        "min_ms": round(min(values), 2),
        "median_ms": round(statistics.median(values), 2),
        "max_ms": round(max(values), 2),
    }


async def run_bench(runs: int, agent_delay: float) -> dict[str, Any]:
    backend = FakeBackend(
        delay_secs=agent_delay,
        reply="Ich habe drei Termine gefunden und den wichtigsten davon nach vorne gezogen.",
    )
    await backend.start()

    config = bench_config(voice_port=free_port(), gateway_url=backend.url)
    app = build_app(
        config,
        client=HttpGatewayClient(base_url=backend.url, token=BRIDGE_TOKEN, timeout_secs=30.0),
    )

    runner = WorkerRunner(handle_sigint=False, check_dangling_tasks=True)
    await runner.add_workers(app.task)
    pipeline_task = asyncio.create_task(runner.run())
    await asyncio.sleep(1.5)  # dem WebSocket-Server Zeit zum Binden geben

    client = BenchClient(f"ws://127.0.0.1:{config.port}", config.audio_in_sample_rate)
    ready = await client.connect()
    logger.info(f"Verbunden: {ready}")

    try:
        latency = await measure_latency(client, runs)
        barge = await measure_barge_in(client, runs)
    finally:
        await client.close()
        await app.task.cancel(reason="Messung beendet")
        pipeline_task.cancel()
        await asyncio.gather(pipeline_task, return_exceptions=True)
        await app.client.close()
        await backend.stop()

    voice_layer = [entry["voice_layer_ms"] for entry in latency if entry.get("voice_layer_ms")]
    totals = [entry["total_ms"] for entry in latency if entry.get("total_ms")]
    agent = [entry["segments_ms"].get("agent", 0.0) for entry in latency]
    # Nur die Läufe, in denen tatsächlich eine Stimme lief — ein Barge-in gegen Stille ist kein
    # Messwert, und ihn mitzuzählen machte das Ergebnis besser als es ist.
    barge_values = [entry["barge_in_ms"] for entry in barge if entry["gilt"]]

    segments = {
        name: summarize([entry["segments_ms"][name] for entry in latency if name in entry["segments_ms"]])
        for name in ("erkennung", "bruecke", "agent", "uebergabe", "stimme")
    }

    return {
        "modus": config.mode,
        "vad": config.vad_kind,
        "budget_ms": config.latency_budget_ms,
        "agent_delay_secs": agent_delay,
        "laeufe": runs,
        "sprachschicht": summarize(voice_layer),
        "gesamt_mit_agent": summarize(totals),
        "agent": summarize(agent),
        "strecken": segments,
        "barge_in": summarize(barge_values),
        "barge_in_gueltige_laeufe": len(barge_values),
        "budget_gehalten": bool(voice_layer) and max(voice_layer) <= config.latency_budget_ms,
        "barge_in_gehalten": bool(barge_values)
        and max(barge_values) <= config.latency_budget_ms,
        # Was diese Zahlen **nicht** enthalten. Steht im Bericht und nicht nur in der Prosa,
        # damit die Einschränkung mitreist, wenn jemand nur die JSON-Datei weitergibt.
        "unbelegt": (
            []
            if config.live
            else [
                "Deepgram: Laufzeit der Erkennung (Strecke `erkennung` misst hier den Stand-in)",
                "Azure bzw. ElevenLabs: Zeit bis zum ersten Audio-Byte (Strecke `stimme`)",
                "Silero: Rechenzeit je 32-ms-Block (der Messstand nutzt den Energie-Detektor)",
            ]
        ),
        "einzelläufe": {"latenz": latency, "barge_in": barge},
    }


def render(report: dict[str, Any]) -> str:
    lines = [
        "Messstand der Sprachschicht (S31)",
        f"  Modus {report['modus']}, VAD {report['vad']}, "
        f"Denkzeit des Backends {report['agent_delay_secs']} s, {report['laeufe']} Läufe",
        "",
        f"  Sprachschicht (Budget {report['budget_ms']} ms): {report['sprachschicht']}",
        f"  Gesamt inkl. Agent:                              {report['gesamt_mit_agent']}",
        f"  davon Agent:                                     {report['agent']}",
        f"  Barge-in (Reden bis Stille), {report['barge_in_gueltige_laeufe']} gültige Läufe:"
        f" {report['barge_in']}",
        "",
        "  Strecken einzeln:",
        *(f"    {name:<12} {werte}" for name, werte in report["strecken"].items() if werte),
        "",
        f"  Budget gehalten:   {'ja' if report['budget_gehalten'] else 'NEIN'}",
        f"  Barge-in gehalten: {'ja' if report['barge_in_gehalten'] else 'NEIN'}",
    ]
    if report["unbelegt"]:
        lines += ["", "  Nicht in diesen Zahlen enthalten:"]
        lines += [f"    - {entry}" for entry in report["unbelegt"]]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Messstand der Sprachschicht (S31)")
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument(
        "--agent-delay",
        type=float,
        default=2.0,
        help="Antwortzeit des Backend-Doppels in Sekunden. Steht für die Denkzeit des Agenten.",
    )
    parser.add_argument("--out", type=str, default="", help="Bericht zusätzlich als JSON ablegen.")
    args = parser.parse_args()

    logger.remove()
    logger.add(sys.stderr, level="INFO")

    report = asyncio.run(run_bench(args.runs, args.agent_delay))
    print(render(report))
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump(report, handle, ensure_ascii=False, indent=2)
        print(f"\nBericht: {args.out}")
    return 0 if report["budget_gehalten"] and report["barge_in_gehalten"] else 1


if __name__ == "__main__":
    sys.exit(main())
