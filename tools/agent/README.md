# `agent.*` — Subagenten (S19)

Die beiden Hälften von Abschnitt 14: eine Rolle **anlegen** (`agent.create`) und ihr einen
Auftrag **abgeben** (`agent.delegate`).

| Datei | Aufgabe |
| --- | --- |
| `tools.ts` | `agent.create` (Entwurf → Bestätigung → Eintrag) und `agent.delegate` |
| `draft.ts` | Der Prompt, der aus einem Satz ein Profil-JSON macht, und sein Parser |
| `worker.ts` | Der Arbeiterlauf: eigene Session, eigener Katalog, ein Zug, ein Ergebnis |
| `policy.ts` | Die Werkzeugliste als Policy-Hook — das zweite Tor (S20) |
| `budget.ts` | Das Token-Budget als Hülle um den Modell-Client (S20) |

## Der Weg von einem Satz zu einem Agenten

1. Der Nutzer sagt, was er will. Das Modell reicht den Satz unverändert an `agent.create`.
2. Ein Modellaufruf entwirft ein Profil — mit dem **echten** Katalog samt Risikostufen als
   Auswahl, nicht aus dem Gedächtnis des Modells.
3. `checkAgentDraft` (`runtime/agents/types.ts`) prüft: Namensform, bekannte Werkzeuge,
   Obergrenze über dem schärfsten Werkzeug, Schrittbudget, Cron-Ausdruck.
4. Der Nutzer bestätigt — strukturierte Optionen, derselbe Haltepunkt wie `user.ask` (S10).
5. Bei `hard_write`/`destructive` folgt eine **zweite**, schärfere Frage.
6. Eintrag in `kuronami.agents`. Bei gesetztem `schedule` ist der Eintrag zugleich die
   Registrierung beim Heartbeat-Dienst — es gibt keine zweite Liste im Speicher.

Der Modellaufruf aus Schritt 2 läuft **genau einmal**, auch wenn der Handler nach jeder Pause
erneut läuft: der Entwurf steht in der Rückfrage (`approval.requested`, `details.profile`) und
wird von dort zurückgelesen. Was eingetragen wird, ist damit nachweislich das, was der Nutzer
gesehen hat.

## Keine rekursiven Subagenten — als Form, nicht als Regel

`runtime/loop/api.ts` registriert die `agent.*`-Tools **zuletzt** und übergibt ihnen den
Katalog, wie er vorher aussah. Ein Profil kann daraus kein `agent.delegate` wählen, und ein
Arbeiter bekommt keins: es existiert in seinem Katalog nicht. Die Liste
`FORBIDDEN_AGENT_TOOLS` ist nur die zweite Sicherung für den Tag, an dem jemand die
Registrierreihenfolge ändert.

## Die drei Obergrenzen (S20)

| Grenze | Wo sie sitzt | Was passiert, wenn sie greift |
| --- | --- | --- |
| Werkzeuge | Katalog des Arbeiters **und** `agentToolsHook` | Unbekanntes Tool bzw. `policy.denied` — eine Auskunft im Kontext, kein Absturz |
| Parallele Arbeiter | Kontingent je Prozess (`AGENT_MAX_PARALLEL`, Vorgabe 2) | Der nächste Arbeiter **wartet**, statt abgewiesen zu werden |
| Token | `budgetedModel` um den Modell-Client, geprüft **vor** jedem Aufruf | Lauf endet mit `stop: "token_budget"`, Session wird abgebrochen |

Zwei Tore für die Werkzeugliste, weil sie aus verschiedenen Gründen halten: der Katalog, weil
das Werkzeug für diesen Arbeiter nicht existiert; der Hook, weil **dieser Agent** es nicht
aufrufen darf — auch dann, wenn ihn jemand künftig mit einem breiteren Katalog startet.

## Warum `worker.ts` nicht `createRunner` benutzt

`runtime/loop/api.ts` baut den Katalog und registriert dabei genau diese Tools. Ein Import von
hier nach dort wäre ein Kreis zwischen dem Katalogbau und einem seiner Tools. Also die Ebene
darunter: `startRuntime` (S04) und `runTurn` (S12).

Vollständige Begründung: `docs/ARCHITEKTUR.md`, Abschnitt 14.
