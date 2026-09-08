Hierhin gehört die Governance-Schicht: Freigaben, Hooks, Allow/Deny-Regeln, Sandbox-Konfiguration, Risikostufen. Keine Tool-Implementierungen und keine Business-Logik, die gehören in `tools/` beziehungsweise `runtime/`.

## Aufbau (seit S11)

| Datei | Inhalt |
|---|---|
| `risk.ts` | Die vier Risikostufen, ihre Ordnung, die erlaubten Geltungsbereiche je Stufe |
| `types.ts` | Antrag, Urteil, Regel, Hook, Ressource — reine Daten, kein Import aus `tools/` |
| `secrets.ts` | Geheimnisklassen: welche **Pfade** per Bauart Zugangsdaten tragen |
| `resource.ts` | Was ein Aufruf anfasst (Pfad, Domain, nichts) und der Subjektschlüssel daraus |
| `rules.ts` | Ebene 2: statische Regeln, dazu der ausgelieferte Regelsatz |
| `hooks.ts` | Ebene 1: eigener Code vor der Ausführung, fail closed |
| `engine.ts` | Die Zusammenrechnung aller Ebenen, der Audit-Eintrag, die `PolicyGrant` |
| `approvals.ts` | Freigaben: erteilen, wiederfinden, überdauern (`kuronami.approvals` + Protokoll) |
| `audit.ts` | Faltung des Protokolls zu vollständigen Audit-Einträgen |

## Die vier Ebenen und wie sie zusammengerechnet werden

Abschnitt 10 der Architektur nennt vier Entscheidungsebenen. Sie stimmen nicht ab, sie
sprechen — und es gilt die **schärfste** Aussage, nicht die letzte und nicht die
spezifischste:

1. **Hooks** — eigener Code. Ein Hook, der wirft, gilt als Ablehnung.
2. **Statische Regeln** — Allow/Deny/Ask nach Tool, Pfad, Domain, Geheimnisklasse. Alle
   Regeln werden ausgewertet, die Reihenfolge in der Liste ist bedeutungslos.
3. **Sessionmodus** — `ask`, `accept_edits`, `bypass_in_sandbox`.
4. **Laufzeit-Rückfrage** — der Mensch entscheidet.

Darunter liegt die **Risikostufe als Boden**: was die Tabelle in Abschnitt 10 an Freigabe
verlangt, verlangt sie auch bei leerem Regelsatz.

Zwei Asymmetrien, die den ganzen Aufbau tragen:

* **Ein `allow` senkt nichts.** Es ist eine Abstention mit Namen und steht im Freigabepfad,
  damit sichtbar bleibt, dass die Ebene lief und nichts einzuwenden hatte. Könnte ein `allow`
  den Boden senken, wäre "hartes Schreiben nur mit Freigabe" einen zu breiten Glob weit vom
  Verschwinden entfernt — und zwar lautlos.
* **Nur der Sessionmodus darf senken, und nur den Boden.** Das ist die dokumentierte Ausnahme
  (`accept_edits` für Dateiänderungen, `bypass_in_sandbox` mit nachgewiesener Sandbox). Er
  hebt nie das Wort einer anderen Ebene auf, und er greift nie bei `destructive`.

## Es gibt keinen Weg an der Engine vorbei

Nicht als Vorsatz, sondern im Typsystem: ein Tool-Handler bekommt seine Aufrufdaten nur mit
einer `PolicyGrant` (`ToolInvocation.policy`), und die Klasse dahinter wird nur als **Typ**
exportiert und hat ein privates Feld. Außerhalb von `engine.ts` lässt sich keine herstellen,
auch nicht als Objektliteral. Der Router ruft die Engine vor der Weiche zwischen
`executeStep` und `callRuntimeTool` — ein Tor für beide Wege.

## Freigaben

Drei Geltungsbereiche: `once` (an die `call_id` gebunden), `session`, `always`. Sie werden in
**einer** Transaktion als Ereignis (`approval.granted`/`approval.denied`) und als Zeile in
`kuronami.approvals` geschrieben. Das Ereignis ist die Wahrheit — deshalb ist eine
sessiongebundene Freigabe nach einem Neustart einfach wieder da; die Zeile ist der
Schnappschuss und der einzige Weg an eine dauerhafte Freigabe, die über Sessiongrenzen gilt.

`kuronami.approvals` ist zugleich das **vierte Schreibtor des Redaction-Filters** (nach
Protokoll, Artefaktmetadaten und Prompt-Aufbau).

## Was hier nicht steht

Der Egress-Riegel (`tools/web/egress.ts`) und die Pfadzonen (`tools/fs/paths.ts`) bleiben, wo
sie sind: sie sind Kontrollen an der Tool-Grenze, keine Entscheidungen. Die Policy liegt eine
Ebene darüber und kann sie verschärfen, nicht ersetzen.
