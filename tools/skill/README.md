# `skill.*` — das Skill-System (S18c)

Progressive Offenlegung für Fähigkeiten aus `skills/<name>/SKILL.md`: der Prompt bekommt nur
Titel, Beschreibung und Auslösebedingung, die volle Anleitung lädt `skill.load` erst bei
tatsächlichem Bedarf nach.

| Datei | Aufgabe |
| --- | --- |
| `catalog.ts` | Scannt `skills/` einmal beim Sessionstart, parst Frontmatter (Wiederverwendung von `tools/memory/frontmatter.ts`) |
| `tools.ts` | `skill.load` |

## Warum kein eigener Frontmatter-Parser

`catalog.ts` importiert `parseNote`/`requireScalar` aus `tools/memory/frontmatter.ts`. Der
Parser dort ist generisch (zwei Formen, `schlüssel: wert` und `schlüssel: [a, b, c]`, ohne
Kopplung an Notizen) — ihn hier ein zweites Mal zu schreiben wäre eine zweite Wahrheit über
dieselbe Frage.

## Warum `execution: "runtime"`

`skill.load` schlägt nur in der beim Sessionstart eingefrorenen `SkillCatalog`-Struktur nach —
keine Platte, kein externer Seiteneffekt, kein Schritt. Dieselbe Bauart wie `tool.load`
(`tools/tool/tools.ts`), nur ohne dessen Zweischritt beim Einfrieren: `skill.load` schaut nicht
in den `ToolCatalog`, den es selbst mitbildet, sondern in eine eigene, unabhängige Struktur.

## `skill.invoked`

Zusätzlich zum generischen `tool.completed` schreibt der Handler ein eigenes `skill.invoked`
mit den geladenen Namen — dieselbe Begründung wie bei `memory.recalled`/`memory.conflicted`:
"welcher Skill wurde wann benutzt" soll beantwortbar sein, ohne einen Filter über alle
`tool.completed`-Payloads zu legen.

Vollständige Begründung und Design-Entscheidungen: `docs/ARCHITEKTUR.md`, Abschnitt 9.
