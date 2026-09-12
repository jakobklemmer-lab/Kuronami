# Die Agenten-Registry (S19)

`kuronami.agents` — wer delegiert werden darf, mit welchen Werkzeugen, welchem Modell, welcher
Risiko-Obergrenze und welchem Zeitplan. Abschnitt 14 der Architektur in Tabellenform: "Neue
Rollen entstehen über `agent.create` per Sprach- oder Textbefehl, nicht durch neuen Code pro
Agent."

| Datei | Aufgabe |
| --- | --- |
| `types.ts` | Felder eines Profils und die Prüfung, die jedes Profil bestehen muss (`checkAgentDraft`) |
| `store.ts` | Anlegen (Zeile + `agent.created` in einer Transaktion), Lesen, Auflisten |
| `besetzung.ts` | Die erste Besetzung (S20): die sieben Rollen aus Abschnitt 14 als Daten |
| `seed.ts` | `pnpm agents:seed` — legt die fehlenden Rollen an, idempotent, `--dry-run` prüft nur |

## Warum die Prüfung hier steht und nicht im Tool

`agent.create` ist nicht der einzige Weg in die Tabelle: S20 legt die erste Besetzung an, ein
Betreiber kann eine Zeile schreiben. Eine Prüfung, die nur an einem von mehreren Wegen hängt,
ist keine — dieselbe Zweitorigkeit wie bei der Risikostufe seit S11 (Registry **und** Engine).

## Warum es keine Faltung "Registry aus dem Protokoll" gibt

Das Ereignisprotokoll ist je Session geführt, die Registry gilt über alle Sessions hinweg. Eine
Faltung müsste jedes Protokoll der Datenbank lesen. Deshalb dieselbe Aufteilung wie bei
`kuronami.artifacts` und bei dauerhaften Freigaben: die **Zeile** ist der Bestand, das
**Ereignis** (`agent.created`, in der Session, in der es geschah) die Herkunft.

## Warum die Besetzung Daten sind und keine Migration

Beides wäre erlaubt gewesen. Eine Migration schriebe sieben Profile als SQL-Literale in eine
Datei, die niemand gegen den Katalog prüft: ein Tippfehler in einem Toolnamen stünde danach in
der Registry und fiele erst auf, wenn der Agent das erste Mal läuft — vielleicht nachts, nach
Zeitplan. Hier gehen alle sieben durch `checkAgentDraft`, also durch dasselbe Tor wie ein Profil
aus `agent.create`. Und `seedFirstCasting` ist idempotent, was eine Migration nicht wäre.

## Risiko-Obergrenze

`max_risk` ist die stehende Erlaubnis eines Agenten, nicht die eines Aufrufs. Ein Werkzeug über
dieser Grenze wird beim Anlegen abgewiesen (nicht später stillschweigend abgelehnt), und ein
Profil, das hartes Schreiben oder Zerstörendes zulässt, verlangt eine **Zusatzbestätigung**
(`needsExtraConfirmation`) — die Aufrufe eines Agenten mit Zeitplan sieht sonst niemand.

Vollständige Begründung: `docs/ARCHITEKTUR.md`, Abschnitte 5, 10, 11 und 14.
