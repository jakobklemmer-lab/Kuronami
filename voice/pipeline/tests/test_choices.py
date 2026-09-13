"""Gesprochene Antworten auf Freigaben: treffen oder nicht treffen, nie raten."""

from __future__ import annotations

from voice.pipeline.choices import Choice, match_choice, spoken_question

JA_NEIN = [Choice(id="genehmigen", label="Genehmigen"), Choice(id="ablehnen", label="Ablehnen")]


def test_kennung_woertlich() -> None:
    assert match_choice("genehmigen", JA_NEIN) == "genehmigen"


def test_beschriftung_im_satz() -> None:
    assert match_choice("Bitte ablehnen, das passt nicht.", JA_NEIN) == "ablehnen"


def test_satzzeichen_und_grossschreibung_stoeren_nicht() -> None:
    assert match_choice("Genehmigen!", JA_NEIN) == "genehmigen"


def test_ja_trifft_die_zustimmende_option() -> None:
    assert match_choice("Ja, mach das.", JA_NEIN) == "genehmigen"


def test_nein_trifft_die_ablehnende_option() -> None:
    assert match_choice("Nein, lieber nicht.", JA_NEIN) == "ablehnen"


def test_ordnungszahl() -> None:
    options = [Choice(id="a", label="Erste Möglichkeit"), Choice(id="b", label="Andere")]
    assert match_choice("Nimm die zweite", options) == "b"


def test_unverstandenes_bleibt_unverstanden() -> None:
    assert match_choice("Hmm, schwierig", JA_NEIN) is None


def test_leere_eingabe_trifft_nichts() -> None:
    assert match_choice("   ", JA_NEIN) is None


def test_ohne_optionen_kein_treffer() -> None:
    assert match_choice("ja", []) is None


def test_zwei_zustimmende_optionen_sind_kein_treffer() -> None:
    # "Jetzt genehmigen" und "Später genehmigen" klingen beide nach Zustimmung. Ein "ja" darf
    # hier nichts auswählen — sonst entschiede der Zufall der Reihenfolge.
    options = [
        Choice(id="jetzt", label="Ja, jetzt genehmigen"),
        Choice(id="spaeter", label="Ja, später genehmigen"),
    ]
    assert match_choice("ja", options) is None


def test_ablehnung_gewinnt_vor_zustimmung() -> None:
    # "Nein, nicht genehmigen" enthält beides. Das Nein wiegt schwerer — eine Freigabe aus einer
    # Ablehnung zu lesen wäre der teuerste mögliche Fehler.
    assert match_choice("Nein, nicht genehmigen", JA_NEIN) == "ablehnen"


def test_frage_traegt_ihre_optionen_mit() -> None:
    text = spoken_question("Darf ich?", JA_NEIN)
    assert "Darf ich?" in text
    assert "Genehmigen" in text and "Ablehnen" in text


def test_frage_ohne_optionen_bleibt_die_frage() -> None:
    assert spoken_question("Darf ich?", []) == "Darf ich?"
