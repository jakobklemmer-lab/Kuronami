Hierhin gehören Skill-Verzeichnisse, die die Capability Surface um abrufbare Fähigkeiten
erweitern. Keine Kern-Tools der Runtime, die gehören in `tools/`.

## Ein Skill anlegen

Ein Verzeichnis unter `skills/<name>/` (Name wie ein Toolname: kleingeschrieben, Ziffern und
Bindestriche, beginnt mit einem Buchstaben) mit genau einer Datei `SKILL.md` darin:

```markdown
---
titel: Kurzer, sprechender Titel
beschreibung: Ein bis zwei Sätze, was der Skill tut.
wann: Die Auslösebedingung — wann das Modell diesen Skill ziehen sollte.
---

Die vollständige Anleitung, beliebig lang. Alles, was das Modell braucht, um die Aufgabe
tatsächlich auszuführen, gehört hierher — Schritte, Beispiele, Fallstricke.
```

Alle drei Frontmatter-Felder sind Pflicht, jedes einzeilig (kein Zeilenumbruch). Nach dem
Frontmatter muss ein nicht leerer Anleitungstext folgen — eine `SKILL.md` ohne Rumpf wird
übersprungen (es gäbe nichts, das `skill.load` nachladen könnte).

## Progressive Offenlegung (S18c)

Der Prompt bekommt nur die **Kurzliste**: Titel, Beschreibung und Auslösebedingung jedes
Skills, eine Zeile je Skill. Die **vollständige Anleitung** lädt das Modell erst bei
tatsächlichem Bedarf über `skill.load` nach — danach steht sie vollständig im Kontext, bevor
irgendetwas aus ihr befolgt wird. Details und Begründung stehen in `docs/ARCHITEKTUR.md`,
Abschnitt 9, "Skills (progressive Offenlegung)".

## Fremde Skills

Ein Skill ist fremder Text mit Anweisungen für das Modell. Es gibt keinen Weg, auf dem eine
Anleitung wirksam wird, ohne vorher vollständig im Kontext zu stehen — lies sie trotzdem,
bevor du ihr folgst, genau wie bei jedem anderen ungeprüften Text.

## Vorhandene Skills (S18d)

- `mail-triage/` — sichtet ungelesene Post, ordnet nach Dringlichkeit, entwirft Antworten für
  die wichtigsten Mails.
- `wochenrueckblick/` — fasst die vergangene Woche zusammen (Termine, Plan, ältere Notizen) und
  legt das Ergebnis als Gedächtnisnotiz ab.
- `recherche-ablauf/` — recherchiert eine Frage im Web, liest die relevantesten Treffer im
  Volltext und beantwortet mit Quellenangabe.

Jeder dieser drei läuft mit Testdaten durch — siehe `skills.test.ts` in diesem Verzeichnis.
