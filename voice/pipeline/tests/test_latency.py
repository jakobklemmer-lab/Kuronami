"""Die Messung selbst: was gezählt wird, und was ausdrücklich nicht."""

from __future__ import annotations

import pytest

from voice.pipeline.latency import LatencyLedger


class Clock:
    """Eine Uhr, die nur weitergeht, wenn der Test es sagt."""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def tick(self, ms: float) -> None:
        self.now += ms / 1000


def test_strecken_entstehen_aus_zwei_marken() -> None:
    clock = Clock()
    ledger = LatencyLedger(clock)
    ledger.begin("t1")
    ledger.mark("speech_stopped")
    clock.tick(120)
    ledger.mark("transcript_final")
    clock.tick(5)
    ledger.mark("gateway_sent")
    clock.tick(2400)
    ledger.mark("gateway_replied")
    clock.tick(10)
    ledger.mark("speech_queued")
    clock.tick(180)
    ledger.mark("first_audio")

    segments = ledger.current.segments()
    assert segments["erkennung"] == 120.0
    assert segments["bruecke"] == 5.0
    assert segments["agent"] == 2400.0
    assert segments["stimme"] == 180.0


def test_budget_gilt_ohne_die_denkzeit_des_agenten() -> None:
    clock = Clock()
    ledger = LatencyLedger(clock)
    ledger.begin("t1")
    ledger.mark("speech_stopped")
    clock.tick(120)
    ledger.mark("transcript_final")
    ledger.mark("gateway_sent")
    clock.tick(4000)  # Ein langsamer Agent …
    ledger.mark("gateway_replied")
    ledger.mark("speech_queued")
    clock.tick(200)
    ledger.mark("first_audio")

    report = ledger.current.report(budget_ms=800)
    assert report["total_ms"] == 4320.0
    # … macht die Sprachschicht nicht langsam. 120 + 200 = 320.
    assert report["voice_layer_ms"] == 320.0
    assert report["within_budget"] is True


def test_zu_langsame_sprachschicht_reisst_das_budget() -> None:
    clock = Clock()
    ledger = LatencyLedger(clock)
    ledger.begin("t1")
    ledger.mark("speech_stopped")
    clock.tick(600)
    ledger.mark("transcript_final")
    ledger.mark("gateway_sent")
    ledger.mark("gateway_replied")
    ledger.mark("speech_queued")
    clock.tick(500)
    ledger.mark("first_audio")

    report = ledger.current.report(budget_ms=800)
    assert report["voice_layer_ms"] == 1100.0
    assert report["within_budget"] is False


def test_unvollstaendige_messung_behauptet_nichts() -> None:
    ledger = LatencyLedger(Clock())
    ledger.begin("t1")
    ledger.mark("speech_stopped")
    report = ledger.current.report(budget_ms=800)
    assert report["total_ms"] is None
    assert report["within_budget"] is None, "Kein `False` für eine Messung, die es nicht gibt."


def test_erste_marke_gewinnt() -> None:
    clock = Clock()
    ledger = LatencyLedger(clock)
    ledger.begin("t1")
    ledger.mark("first_audio")
    clock.tick(50)
    ledger.mark("first_audio")
    ledger.mark("speech_stopped")
    # `first_audio` heißt erstes Byte. Das zweite darf die Zahl nicht verschieben.
    assert ledger.current.marks["first_audio"] == 0.0


def test_vorgemerkte_marke_landet_im_naechsten_zug() -> None:
    clock = Clock()
    ledger = LatencyLedger(clock)
    ledger.pre_mark("speech_stopped")
    clock.tick(140)
    ledger.begin_with_pending("t1")
    ledger.mark("transcript_final")
    assert ledger.current.segments()["erkennung"] == 140.0


def test_ein_neuer_zug_verliert_den_alten_nicht() -> None:
    ledger = LatencyLedger(Clock())
    ledger.begin("t1")
    ledger.begin("t2")
    assert [turn.turn_id for turn in ledger.finished] == ["t1"]
    assert ledger.current.turn_id == "t2"


def test_unbekannte_marke_faellt_sofort_auf() -> None:
    ledger = LatencyLedger(Clock())
    ledger.begin("t1")
    with pytest.raises(ValueError):
        ledger.mark("erstes_audio")
