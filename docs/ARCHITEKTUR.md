# Kuronami · Architektur und Phase-0-Entscheidungen

Diese Datei ist die einzige Kontextquelle für alle Claude-Code-Sessions.
Sie ersetzt die Notion-Seite im Arbeitsalltag. Wenn eine Session etwas braucht,
das hier nicht steht, wird es hier ergänzt und nicht in der Session improvisiert.

Stand: 04.09.2026 · Phase 0 abgeschlossen
Nachträge aus dem Bau sind als **Umsetzung (Sxx)** in den betroffenen Abschnitt gesetzt.
Sie ergänzen die Entscheidung, sie ersetzen sie nicht; wo eine Umsetzung von der
Entscheidung abweicht, steht die Begründung im jeweiligen `progress.md`-Eintrag.

---

## 1. Ziel

Kuronami ist ein persönlicher AI-Assistent, gebaut als vollständiges **Agent Harness**:
eigener Ausführungsmotor, dauerhafter Zustand, ausgelagertes Gedächtnis, erzwungene
Freigaben, austauschbare Oberfläche.

**Kernthese:** Der Modell-Tool-Loop ist Standardware. Der Unterschied entsteht in fünf
anderen Bereichen: Context Engineering, dauerhafter Zustand, Policy-Durchsetzung,
ausgelagerter Speicher, Protokoll-Design.

**Zweite Kernthese:** Das Modell ist die Steuerungsebene für Denken und Planen. Zustand,
Ausführung, Speicher, Freigaben, Transport und Beobachtbarkeit gehören ins Harness.
Je mehr Determinismus außerhalb des Modells liegt, desto zuverlässiger das System.

---

## 2. Die sechs Grundprinzipien

1. **Das Harness zählt mehr als der Loop.**
2. **Zuerst um Cache-Stabilität herum entwerfen.** Stabiler Prompt-Präfix,
   Append-only-Historie, fester Tool-Katalog pro Session, Zustandswechsel als Nachricht
   statt als Prompt-Umschrift.
3. **Dateisystem und Artefaktspeicher sind der Arbeitsspeicher.** Große Tool-Ausgaben,
   Notizen, Pläne und Übergaben leben außerhalb des Modellkontexts, referenziert über Handles.
4. **Der eingebaute Aktionsraum bleibt klein und stabil.** Wenige, hochwirksame Primitive.
5. **Subagenten nur für Kontext-Isolation**, nicht weil Multi-Agent fortschrittlich klingt.
6. **Guardrails gehören in die Laufzeit, nicht in den Prompt.** Das Modell ist nie die
   einzige Kontrollinstanz.

---

## 3. Die fünf Schichten und ihre Ordner

| Schicht | Aufgabe | Ordner |
|---|---|---|
| Execution Runtime | Loop, Sessions, Checkpoints, Wiederaufnahme, Abbruch, Retry | `runtime/` |
| Context System | Prompt-Aufbau, Artefakt-Referenzen, Kompaktierung, Cache-Disziplin | `context/` |
| Capability Surface | Tool-Router, Kern-Tools, n8n-Brücke, Skills, Subagenten | `tools/`, `skills/` |
| Governance | Freigaben, Hooks, Allow/Deny, Sandbox, Risikostufen | `policy/` |
| Surface / Protokoll | Kanal-Normalisierung, Web, Telegram, Mail, Sprache | `gateway/` |

Dazu: `memory/` (Langzeitgedächtnis), `evals/` (Harness-Evals), `docs/` (diese Datei und Folgeentscheidungen).

**Harte Regel:** Die Surface-Schicht ist austauschbar. Die Runtime darf niemals von ihr abhängen.

---

## 4. Phase-0-Entscheidungen (festgeschrieben, nicht mehr diskutieren)

### 4.1 Sprache und Laufzeitumgebung

**TypeScript auf Node.js 24 LTS (Krypton).**

Node 24 ist seit Oktober 2025 Active LTS und wird bis 2028 gepflegt. Node 22 ist seit
Oktober 2025 nur noch Maintenance LTS (Ende April 2027) und damit für ein Projekt, das
jetzt startet, die falsche Wahl. Node 26 ist Current und wird erst im Oktober 2026 LTS.
In `package.json` wird `engines.node` auf `>=24 <25` gesetzt, damit ein versehentlicher
Versionswechsel auffällt.

Begründung: Die Zustandsschicht ist Postgres, das bestehende Dashboard ist Node. Hermes
Agent (Nous Research) dient als Blaupause für State-Schema, Subagent-Muster und
Gateway-Aufbau, wird aber **nicht geforkt**, weil sein Python-Kern einen zweiten Stack
neben Node/Postgres bedeuten würde. Das erhöht Komplexität ohne Gegenwert für ein
Ein-Personen-System.

Ausnahme: Die Sprachschicht in Phase 9 nutzt Pipecat und damit Python. Sie läuft als
eigener Prozess hinter dem Gateway und teilt keinen Code mit der Runtime. Das ist eine
Prozessgrenze, kein zweiter Stack im Kern.

### 4.2 Toolchain

| Zweck | Werkzeug |
|---|---|
| Paketmanager | pnpm |
| Testrunner | vitest |
| Linter und Formatter | Biome (ersetzt ESLint und Prettier) |
| Laufzeit | Node.js 24 LTS, `engines.node` auf `>=24 <25` gepinnt |
| TypeScript | strict, ES2023, ESM, NodeNext |
| Migrationen | einfache nummerierte SQL-Dateien in `runtime/db/migrations/`, kein ORM |

Kein ORM. Die Zustandsschicht ist klein, gut überschaubar und profitiert von direktem SQL
mehr als von einer Abstraktion, die bei Ereignisprotokollen ohnehin im Weg steht.

### 4.3 Runtime-Framework

**Selbst gebaut auf Postgres.** Kein LangGraph, kein Temporal, kein DBOS.

Begründung: Der Sessionplan S02 bis S05 ist bereits genau so geschnitten (Postgres-Schema,
Ereignisprotokoll, Runtime-Skelett, Wiederaufnahme). Die Arbeitslast ist eine einzige
Schleife über typisierte Schritte, keine beliebigen Geschäftsprozesse. Ein Framework würde
hier ein eigenes Nachrichten- und State-Modell mitbringen, das mit Grundprinzip 2
(Cache-Stabilität) und mit der einheitlichen Rückgabehülle konkurriert.

Verworfen und warum:

* **DBOS Transact:** technisch der beste Kompromiss, nimmt Checkpointing ab. Bindet aber an
  eine fremde Workflow-Semantik an genau der Stelle, an der die Kontrolle den Wert ausmacht.
* **LangGraph.js:** viel fertig, eigenes State- und Message-Modell, das die Cache-Disziplin
  unterläuft.
* **Temporal:** stärkste Garantien, kostet einen eigenen Server samt eigener Datenbank.
  Zu viel Infrastruktur für ein System mit einem Nutzer.

**Preis dieser Entscheidung:** Retry-, Idempotenz- und Replay-Kanten gehören uns. Deshalb
gelten die beiden harten Runtime-Regeln in Abschnitt 6 ohne Ausnahme.

### 4.4 Ereignis-Taxonomie

Das Ereignisprotokoll ist die Wahrheit. Der Zustands-Snapshot ist abgeleitet und jederzeit
aus dem Protokoll neu berechenbar.

Namensform: `namensraum.vergangenheitsform`, kleingeschrieben, Punkt als Trenner.

```
session.created      session.resumed     session.completed
session.failed       session.canceled
turn.started         turn.completed
step.started         step.completed      step.failed
model.requested      model.responded
tool.requested       tool.completed      tool.failed
policy.allowed       policy.denied
approval.requested   approval.granted    approval.denied
artifact.created
context.compacted
task.created         task.updated
agent.delegated      agent.returned
error.raised
```

Jedes Ereignis trägt: `event_id`, `session_id`, `seq` (monoton pro Session), `type`,
`payload` (jsonb), `created_at`. `seq` wird in derselben Transaktion vergeben wie die
Einfügung, damit die Reihenfolge deterministisch bleibt.

Neue Ereignistypen kommen dazu, bestehende werden nie umbenannt und nie in ihrer Bedeutung
verändert. Ein Protokoll, dessen Vergangenheit sich ändert, ist kein Protokoll.

**Umsetzung (S07):** Der Tool-Router schreibt `tool.requested` und danach `tool.completed`
bzw. `tool.failed`. Die in der Notion-Checkliste zu S07 genannten `tool.called` und
`tool.returned` werden ausdrücklich **nicht** eingeführt: sie wären zweite Schreibweisen für
bereits vergebene Typen, und `tool.returned` verlöre die Unterscheidung zwischen geglückt und
fehlgeschlagen, die `tool.completed`/`tool.failed` schon tragen.

**Ergänzung (S11):** `policy.secret_accessed`. Kein neuer Namensraum — `policy.*` steht oben —,
aber eine andere Aussage als `policy.allowed`: die beiden sagen, ob ausgeführt werden darf,
dieses sagt, dass ein **Geheimnisträger angefasst** wurde, und zwar auch dann, wenn der Aufruf
ganz normal erlaubt war. Als Feld in `policy.allowed` wäre "wer hat wann welche Zugangsdatei
geöffnet" nur noch über einen Filter auf einem Payload zu beantworten — die Frage, die nach
einem Vorfall als erste gestellt wird.

### 4.5 Artefakt-URI und Ablage

Logische Form: `artifact://<namensraum>/<name>`
Beispiel: `artifact://mail/results-2026-08-28.json`

Physisch: `<ARTIFACT_ROOT>/<namensraum>/<name>` plus eine Zeile in der Tabelle `artifacts`
mit `sha256`, `mime_type`, `summary`, `source` (Tool, Session, Step).

**Artefakte sind unveränderlich.** Ein bestehender Name wird nie überschrieben, bei
Kollision hängt der Speicher `-2`, `-3` an. Das ist die Voraussetzung dafür, dass ein
Replay dieselben Handles auf denselben Inhalt auflöst.

Auslagerungsschwelle: ab 8k bis 16k Token-Äquivalent wandert ein Tool-Ergebnis
automatisch ins Artefakt, und der Kontext bekommt nur Zusammenfassung plus Handle.

**Umsetzung (S06):** Die URI lautet `artifact://<session_id>/<artifact_id>` statt
`artifact://<namensraum>/<name>`; Begründung im `progress.md`-Eintrag zu S06. Ein lesbarer
Alias-Layer über denselben physischen Speicher bleibt möglich (S09/S14).

**Umsetzung (S07):** Der Startwert der Schwelle ist 8000 Token-Äquivalent, also das untere
Ende der Spanne (`tools/offload.ts`). Gerechnet wird mit vier Bytes je Token, und gemessen
wird die vollständige serialisierte Rückgabehülle — nicht der Rohinhalt und nicht das, wofür
ein Tool sich selbst hält. Ausgelagert wird `structured`, der einzige unbegrenzte Teil der
Hülle; `summary`, `preview` und die Handles bleiben im Kontext. Passt die Hülle danach immer
noch nicht unter die Schwelle, sind `summary` oder `preview` selbst zu groß: das ist ein
Fehler des Tools und wird als solcher gemeldet, nicht durch stilles Kürzen geheilt.

### 4.6 Sandbox-Strategie

`exec.run` läuft in einem kurzlebigen Docker-Container:

* Netzwerk standardmäßig **aus**, Freischaltung nur pro Aufruf und mit Freigabe
* Nur das Arbeitsverzeichnis der Session ist beschreibbar eingehängt, sonst nichts
* Grenzen: CPU, Speicher, Laufzeit (Startwert 60 Sekunden)
* Keine Secrets in der Umgebung des Containers
* Auf dem Windows-Entwicklungsrechner über Docker Desktop, auf dem Server nativ

Risikostufe: hartes Schreiben, also immer Freigabe.

### 4.7 Sicherheitsgrenzen

* **Secrets** leben ausschließlich in Umgebungsvariablen des Runtime-Prozesses. Sie
  erreichen nie den Prompt, nie ein Artefakt, nie das Ereignisprotokoll. Vor jedem Schreiben
  ins Protokoll läuft ein Redaction-Filter.

  **Umsetzung (S07, Nachzug aus der verworfenen S05b):** `runtime/redaction/`. Eine Funktion,
  drei Schreibtore: `appendEventInTx` (Ereignisprotokoll), `writeArtifact` (Metadaten, also
  `summary`, `mime_type` und `source`) und `buildPrompt` (Prompt-Aufbau). Der Filter geht
  rekursiv durch verschachtelte Objekte und Arrays und greift auf zwei Wegen — über die Form
  des Wertes (`sk-ant-…`, `postgres://u:p@…`) und über den Namen des Feldes (`api_key`,
  `password`), weil ein Geheimnis ohne erkennbare Form nur über den Namen auffindbar ist.
  Die Musterliste liegt als eigene, erweiterbare Datei in `runtime/redaction/patterns.ts`.
  Seit S11 kommt ein viertes Tor dazu: die Freigabezeilen in `kuronami.approvals`, die mit
  `requested_input` die Eingabe des freigegebenen Aufrufs tragen.

  **Nachtrag (S11), ein gemessenes Leck:** das Fangnetz für Schlüssel-Wert-Paare begann mit
  `\b`, und `\b` setzt keine Grenze zwischen `_` und einem Buchstaben — der Unterstrich ist
  selbst ein Wortzeichen. Damit griff es auf `api_key=…`, aber **nicht** auf
  `ANTHROPIC_API_KEY=…`, also ausgerechnet nicht auf die Schreibweise, in der Geheimnisse in
  `.env`-Dateien und Umgebungen tatsächlich stehen. Ersetzt durch `(?<![A-Za-z0-9])`: ein
  führender Namensteil ist erlaubt, ein Wortanfang weiterhin nicht (`monkey:` bleibt in Ruhe).

  **Der Filter ist nicht abschaltbar.** Kein Flag, kein Parameter, keine Umgebungsvariable.
  Eine Ausnahme wäre irgendwann gesetzt — beim Debuggen, "nur kurz", in genau dem Lauf,
  dessen Protokoll später jemand liest.

  Nicht gefiltert werden die **Bytes** eines Artefakts: ein Artefakt ist die byteweise
  archivierte Wahrheit eines Tool-Laufs, ein Textmuster über beliebige Bytes beschädigte sie
  und die SHA-256-Kette dazu. Der Schutz greift an der anderen Stelle — aus dem Speicher
  heraus führt in den Kontext kein Weg an `summary` und dem Handle vorbei, und beide sind
  gefiltert. Dass ein Tool keine Secrets in ein Artefakt schreibt, bleibt damit eine Pflicht
  des Tools; ab S08 ist das beim Schreiben der Kern-Tools mitzuprüfen.
* **Externe Inhalte** (`web.fetch`, MCP-Ausgaben, Mailtexte, fremde Dokumente) sind
  grundsätzlich nicht vertrauenswürdig. Rohinhalt geht ins Artefakt, in den Kontext geht
  nur eine normalisierte Zusammenfassung. Eine Anweisung aus externem Inhalt hebt nie eine
  Freigabe auf.

  **Umsetzung (S09):** `tools/web/`. `web.fetch` schreibt den Rohinhalt **immer und
  ausschließlich** byteweise ins Artefakt (`readArtifact` gibt ihn bytegleich zurück); in
  den Kontext geht nur `structured.excerpt` — eine tag-freie, gekürzte Fassung
  (`normalize.ts`). Rohinhalt und normalisierte Fassung teilen sich kein Feld der
  Rückgabehülle. `structured.trust` ist `"untrusted"`, die `summary` trägt eine Markierung,
  und Prompt-Injection-Muster werden in `structured.injection_flags` **gekennzeichnet, nicht
  entfernt** (`scanForInjection`, Deutsch und Englisch plus versteckte Steuerzeichen). Der
  Egress ist deny-by-default (`egress.ts`): nur http/https, keine Zugangsdaten in der URL,
  keine lokalen/privaten Adressen, Host muss auf `WEB_EGRESS_ALLOWLIST` stehen.
  Weiterleitungen werden **von Hand** gefolgt (`redirect: "manual"`, höchstens 5 Sprünge),
  und **jede** Zwischenadresse geht erneut durch dieselbe Prüfung — ein `302` von einer
  freigegebenen Seite auf eine interne Adresse wird abgewiesen, nicht verfolgt. Dazu ein
  Zeitfenster (20 s) und eine harte Größenbegrenzung (5 MiB), die den Download abbricht,
  bevor ein Artefakt entsteht. `web.search` gibt eine knappe Trefferliste in den Kontext und
  die vollständige Liste als Artefakt; es braucht ein injiziertes Backend und ist bis dahin
  registriert, aber nicht bedienbar (Anbieter kommt mit der n8n-Bridge, S13). Die **Bytes**
  laufen wie die Artefaktbytes (S07) und `fs.read`-Rohbytes (S08) bewusst nicht durch den
  Redaction-Filter; der `excerpt` tut es über `appendEventInTx` und `buildPrompt`.
  **Nicht** gebaut: die Prüfung der tatsächlich verbundenen IP *nach* der DNS-Auflösung
  (ein öffentlicher Name, der zur Verbindungszeit auf eine interne IP zeigt — DNS-Rebinding).
  Das bräuchte einen eigenen undici-Agent mit `lookup`-Hook; die Weiterleitungs-Variante
  derselben Lücke ist mit der Handprüfung oben geschlossen.
* **`fs.*`** ist auf die Workspace-Wurzel beschränkt. Pfad-Traversal wird abgewiesen, das
  ist das Testkriterium von S08.

  **Umsetzung (S08):** `tools/fs/paths.ts` und `tools/fs/tools.ts`. `resolvePath` löst jeden
  Eingabepfad relativ zur Workspace-Wurzel auf, prüft ihn lexikalisch und danach ein zweites
  Mal nach Auflösung aller Symlinks (`realpath` auf den tiefsten existierenden Vorfahren,
  damit auch noch nicht existierende Zieldateien geprüft werden). Zwei Zonen mit absoluter,
  `realpath`-aufgelöster Wurzel: `artifact` (`ARTIFACT_ROOT`) ist frei beschreibbar,
  `source` (Workspace-Wurzel) nur lesbar — `fs.write`/`fs.edit` dorthin werfen
  `SourceZoneWriteError`, bis die Policy-Engine (S11) eine Freigabe erteilen kann. Bei
  verschachtelten Zonen gewinnt die speziellere. `fs.read` gibt kleine Dateien ganz zurück,
  große als Ausschnitt plus Artefakt auf den vollständigen Inhalt (Selbst-Auslagerung im
  Schritt, wie im Router), und liefert den `sha256`, den `fs.edit` als `expected_sha256`
  gegen zwischenzeitliche Änderungen (stale read) verlangt. `fs.search` gibt Treffer als
  Pfad, Zeilennummer und Trefferzeile zurück, nie ganze Dateien. `fs.list` meldet Symlinks,
  folgt ihnen aber nie; `fs.search` und `fs.list --recursive` lassen `.git` und
  `node_modules` aus. `runtime/index.ts` baut die fünf Tools jetzt in den Katalog (seit S07
  war er leer).
* **Der Tool-Router ruft die Policy-Engine**, nicht umgekehrt. Es gibt keinen Pfad, auf dem
  ein Tool ohne Policy-Prüfung ausgeführt wird.

  **Umsetzung (S11):** `policy/`. Der Router ruft `engine.check()` zwischen Schema-Prüfung und
  Ausführung — **vor** der Weiche zwischen `executeStep` und `callRuntimeTool`, damit es ein
  Tor gibt und nicht zwei. Dass es keinen Weg daran vorbei gibt, steht im Typsystem und nicht
  in einer Verabredung: ein Handler bekommt seine Aufrufdaten nur mit einer `PolicyGrant`
  (`ToolInvocation.policy`), deren Klasse ausschließlich als Typ exportiert wird und ein
  privates Feld trägt — außerhalb von `engine.ts` ist keine herstellbar, auch nicht als
  Objektliteral. Die Engine hat drei Ausgänge: Freigabe (mit Audit-Eintrag im Protokoll),
  Ablehnung (kommt als Fehlerhülle zurück, damit das Modell sie liest) und Haltepunkt (wirft
  `ApprovalRequiredError`, den der Router durchlässt — der Lauf wartet, er ist nicht
  fehlgeschlagen). `policy/` importiert nichts aus `tools/`; die Pfadauflösung wird als
  Funktion injiziert.
* **Geheimnisträger** sind eine eigene Achse neben dem Redaction-Filter. Der Filter sieht
  Werte, die schon gelesen wurden, und verhindert das Durchsickern; er kann den Zugriff nicht
  verhindern und kennt nicht jedes Format. `policy/secrets.ts` erkennt am **Pfad**, welche
  Dateien per Bauart Zugangsdaten tragen (`.env`, `*.pem`, `.ssh/`, `.aws/`, …). Lesen braucht
  dann eine eigene Freigabe — je Datei, nicht je Zone —, Schreiben wird abgelehnt, und jeder
  freigegebene Zugriff hinterlässt ein `policy.secret_accessed`. Vorlagen (`.env.example` und
  Geschwister) sind ausdrücklich ausgenommen: eine offensichtlich unnötige Rückfrage bringt
  dem Menschen bei, die nächste auch wegzuklicken.
* **Fremde Skills** werden vor der Installation gelesen. Ein Skill ist fremder Code mit
  dauerhaften Zugangsdaten auf dem eigenen Host.

### 4.8 Tool-Namenskonvention

`namensraum.aktion`, kleingeschrieben, Punkt als Trenner, Aktion englisch.

Erlaubte Namensräume: `fs`, `web`, `exec`, `task`, `user`, `agent`, `mail`, `cal`, `notes`,
`memory`, `github`, `server`, `dev`, `tool`, `skill`. Ein neuer Namensraum braucht eine
Begründung in `docs/`.

**`tool` (neu mit S18b), Begründung:** `tool.load` spricht über den Katalog selbst — welches
Tool es gibt, welches Schema es hat — und das ist ein anderes Gebiet als jedes bestehende: kein
Dateisystem, kein Netz, keine Aufgabe, keine Assistenz-Anbindung. Siehe Abschnitt 9,
"Verzögertes Tool-Laden".

**`skill` (neu mit S18c), Begründung:** `skill.load` spricht über den **Skill-Katalog** —
welche Fähigkeit es gibt, welche Anleitung dahintersteht — und das ist ein drittes, eigenes
Gebiet neben `tool` (das über den *Tool*-Katalog spricht, also Handler mit Eingabeschema) und
`memory` (die eigene Ablage des Assistenten, `soft_write`, eigenes Git-Repo). Ein Skill ist
weder ein Tool (kein Handler, kein Eingabeschema, kein Seiteneffekt außer dem, was das Modell
mit den ohnehin vorhandenen Tools daraus macht) noch eine Gedächtnisnotiz (keine Erkenntnis aus
einem vergangenen Lauf, sondern eine vorgefertigte Anleitung). Siehe Abschnitt 9,
"Skills (progressive Offenlegung)".

**`dev` (neu mit S07), Begründung:** Prüf-Tools des Harness selbst — `dev.echo` und
`dev.blob` aus `tools/dummies.ts`, mit denen sich die Auslagerungsschwelle nachweisen lässt.
Sie brauchen einen Namensraum, weil die Registry jeden Namen an dieser Liste prüft und es
keine Hintertür für Tests gibt (eine Hintertür wäre dieselbe Hintertür für alles andere).
Ein bestehender Namensraum wäre falsch: `dev.blob` ist weder Dateisystem noch Web noch
Ausführung, und es unter einem dieser Namen zu führen lehrte das Modell einen Aktionsraum,
den es nicht hat.

**`dev.*` gehört in keinen produktiven Tool-Katalog.** Diese Tools tun nichts, was ein
Assistent für einen Nutzer tun soll. Der Katalog wird pro Session zusammengestellt (S07),
und dort haben sie nichts verloren; sie stehen in Tests und Proben.

---

## 5. Datenmodell

### Session

```json
{
  "session_id": "sess_...",
  "thread_id": "thread_...",
  "channel": "web | telegram | mail | heartbeat | voice",
  "created_at": "2026-09-04T12:00:00Z",
  "mode": "execute",
  "model_profile": "orchestrator-default",
  "tool_catalog_version": "v1",
  "approval_mode": "ask",
  "context_state": { "compacted": false, "recent_summary_ref": "artifact://..." }
}
```

### Task

```json
{
  "task_id": "task_...",
  "title": "Mails der Woche zusammenfassen",
  "status": "in_progress",
  "owner": "main-agent",
  "dependencies": [],
  "blockers": [],
  "artifact_refs": ["artifact://summary.md"],
  "updated_at": "2026-09-04T12:10:00Z"
}
```

Statusmodell, genau acht Werte:
`queued` · `ready` · `in_progress` · `blocked` · `awaiting_user` · `done` · `canceled` · `failed`

### Step

```json
{
  "step_id": "step_...",
  "session_id": "sess_...",
  "kind": "plan | tool_call | verify | message",
  "tool_name": "mail.search",
  "status": "completed",
  "started_at": "...",
  "ended_at": "...",
  "artifact_refs": [],
  "error": null
}
```

### Artifact

```json
{
  "artifact_id": "artifact_...",
  "uri": "artifact://mail/results-2026-08-28.json",
  "mime_type": "application/json",
  "summary": "17 ungelesene Mails, 3 als wichtig eingestuft",
  "sha256": "...",
  "source": { "tool": "mail.search", "session_id": "...", "step_id": "..." }
}
```

### Agent (S19, Phase 5)

```json
{
  "agent_id": "agent_...",
  "name": "mail-waechter",
  "role": "Mail-Agent",
  "purpose": "Sieht alle 20 Minuten nach neuen Mails und meldet, was wichtig ist.",
  "system_prompt": "Du siehst nach neuen Mails und meldest nur, was wirklich wichtig ist.",
  "model": "claude-haiku-4-5-20251001",
  "tools": ["mail.search", "mail.read"],
  "max_risk": "read",
  "max_steps": 12,
  "token_budget": 150000,
  "schedule": "*/20 * * * *",
  "status": "active",
  "created_by": "operator",
  "created_in_session": "sess_..."
}
```

Statusmodell, genau drei Werte: `active` · `paused` · `retired` (kein Löschen — eine
Delegation im Protokoll zeigt auf den Namen).

**Nachgetragen mit S19, nicht aus Phase 0.** Die Felder sind aus den Sätzen abgeleitet, die
diese Architektur über Subagenten ohnehin festlegt: `tools` aus "Werkzeug-Zugriff ist
rollenspezifisch, nie pauschal" (Abschnitt 14), `max_steps` und `token_budget` (S20) aus
"Token-Budget" ebendort — wie oft ein Agent handeln darf und was sein Lauf kosten darf sind
zwei verschiedene Grenzen —, `model` aus "Modell pro Agent bewusst wählen" (Abschnitt 11),
`max_risk` aus der Risikostufen-Tabelle (Abschnitt 10) — als **stehende** Erlaubnis, weshalb
`hard_write`/`destructive` beim Anlegen eine Zusatzbestätigung verlangen —, `schedule` aus
"Cron-Agenten sind der eigentliche Kostentreiber" (Abschnitt 11). Ein gesetzter `schedule`
**ist** die Registrierung beim Heartbeat-Dienst: der liest bei jedem Tick die Registry, es gibt
keine zweite Liste im Speicher eines Prozesses.

Die dritte Obergrenze aus Abschnitt 14, **parallele Worker**, ist keine Spalte: sie gehört dem
Prozess, nicht dem Agenten (`DEFAULT_MAX_PARALLEL_WORKERS`, `AGENT_MAX_PARALLEL`).

Tabellen in Phase 1: `sessions`, `tasks`, `steps`, `artifacts`, `approvals`, `events`.
Dazu in Phase 5: `agents` (Migration 0009).

---

## 6. Zwei harte Runtime-Regeln

1. **Checkpoint vor und nach jedem externen Seiteneffekt.** Ohne das ist Wiederaufnahme
   nicht sicher.
2. **Wiederholung muss deterministisch sein.** Jeder Seiteneffekt läuft in einer
   Ausführungshülle mit `step_id` als Idempotenzschlüssel, damit ein Replay keine Mail
   zweimal verschickt.

Ein Checkpoint ist eine Transaktion, die Ereignis und Snapshot-Version gemeinsam schreibt.
Wiederaufnahme heißt: den letzten offenen Schritt finden und entscheiden, ob er wiederholt
oder als fehlgeschlagen markiert wird. Nie raten.

---

## 7. Context Engineering

### Stabiler Prompt-Aufbau, immer in dieser Reihenfolge

1. Statischer System-Prompt und immer vorhandene Tool-Stubs
2. Personengedächtnis und dauerhafte Konventionen
3. Zusammenfassung des Sessionzustands
4. Letzte Nachrichten und Tool-Ergebnisse
5. Aktuelle Nutzereingabe

### Cache-Regeln

Die Cache-Hierarchie läuft von Tools über System-Prompt zu Nachrichten. Eine Änderung an
den Tools entwertet alles darunter.

* Tools **nicht** mitten in der Session hinzufügen oder entfernen
* Modell **nicht** mitten in der Session wechseln, stattdessen Subagent starten
* System-Prompt **nicht** für dynamische Zustandsänderungen umschreiben, Zustand als
  Nachricht schicken
* Serialisierung deterministisch halten, schon Reihenfolgeänderungen brechen den Cache

### Vierstufige Kontextverwaltung

| Stufe | Maßnahme | Auslöser |
|---|---|---|
| 0 | Tool-Ergebnisse von vornherein knapp, typisiert, artefaktgestützt | immer |
| 1 | Große Ergebnisse sofort auslagern, nur Zusammenfassung plus Handle zurück | ab 8k bis 16k Token-Äquivalent |
| 2 | Alte Tool-Ein/Ausgaben in Referenzen umschreiben | ab 80 bis 90 % Fensterauslastung |
| 3 | Historie zusammenfassen: Ziel, Stand, offene Aufgaben, Entscheidungen, Artefakt-Refs, nächster Schritt | wenn Stufe 2 nicht reicht |
| 4 | Frisches Fenster statt Kompaktierung | Ruhepause, Aufgabenabschluss, oder eine Kette aus Stufe-3-Kompaktierungen ohne die beiden ersten |

**Umsetzung (S18a):** `context/compaction.ts`, aufgerufen vom Loop direkt vor dem Aufbau der
Modellanfrage (`runtime/loop/loop.ts`). Beide Stufen rühren das Ereignisprotokoll nicht an —
sie lesen die volle, unveränderte Historie und liefern eine kleinere Fassung nur für den
nächsten Anbieteraufruf; was geschah, steht als eigenes `context.compacted`-Ereignis daneben,
nicht als Korrektur bestehender Ereignisse. Stufe 2 schreibt den Rohinhalt jedes umgeschriebenen
`tool_result`-Blocks als Artefakt und ersetzt ihn durch eine `artifact://`-Referenz; Stufe 3
fasst einen zusammenhängenden älteren Ausschnitt über einen eigenen Modellaufruf zusammen (der
Rohverlauf liegt ebenfalls als Artefakt vor) und schreibt diesen Aufruf als `model.requested`/
`model.responded` mit `purpose: "compaction"` ins Protokoll, damit er in der Kostenrechnung
sichtbar ist. Beide Stufen lesen frühere `context.compacted`-Ereignisse zurück, bevor sie neue
Arbeit erwägen — sonst schriebe jeder weitere Schritt dieselbe Referenz und denselben
Modellaufruf erneut. Schwellenwerte (Fenstergröße, Auslastungsschwelle, geschützte
Nachrichtenzahl) stehen in `CompactionConfig` mit Startwerten und sind pro Lauf überschreibbar.
Die Cache-Trefferquote (Abschnitt 12) landet dabei als Feld im `turn.completed`, das den Zug
abschließt — pro Lauf auslesbar, ohne eine Faltung des ganzen Protokolls anzustoßen.

**Umsetzung (S18b):** `context/section.ts`. Für den Nutzer ist Kuronami **ein** durchgängiger
Assistent, kein Interface mit mehreren Chat-Fenstern — "frischer Abschnitt" ist reine interne
Buchführung, unsichtbar für den Nutzer, wie ein Notizbuch, das im Hintergrund umblättert,
während das Gespräch nahtlos weitergeht. Anders als Stufe 2 und 3 ist Stufe 4 nicht
auslastungsgetrieben, sondern proaktiv, und ihre drei Auslöser sind rein technisch (Auftrag,
wörtlich):

* **Ruhepause** — seit dem letzten Ereignis der Session sind mindestens `idleMs` vergangen
  (Startwert 45 Minuten). Nur beim Eintreffen der nächsten Nachricht erkennbar; kein
  Hintergrund-Zeitgeber weckt eine Session ohne Anlass.
* **Aufgabenabschluss** — seit dem letzten Abschnittswechsel steht ein `task.created`/
  `task.updated` mit `status: "done"` im Protokoll.
* **Stufe-3-Fallback** — seit dem letzten Abschnittswechsel hat Stufe 3 mindestens
  `maxConsecutiveStage3`-mal gegriffen (Startwert 3), ohne dass die beiden ersten Auslöser
  angesprungen wären.

Beide Prüfungen laufen nur beim **Beginn eines neuen Zugs** (`runtime/loop/loop.ts`, vor
`turn.started`, neben dem Langzeitgedächtnis-Recall), nicht mitten in einem laufenden — eine
Ruhepause ist zwischen Zügen ohnehin die einzige Stelle, an der sie auftreten kann. Die
eigentliche Kürzung ist kein zweiter Mechanismus: `context.section_started` trägt `through_seq`
in derselben Zählung wie `context.compacted` (Stufe 3), und `compactHistory` liest die
**höchste** Marke aus beiden Ereignistypen zurück und wendet denselben Schnitt an
(`applyCut`/`latestCut`) — ein frischer Abschnitt ist mechanisch eine größere, proaktiv
ausgelöste Stufe-3-Kürzung, kein eigenes Verfahren.

Die Übergabe ist **kompakt, nur was der nächste Abschnitt braucht** (Auftrag, wörtlich) — drei
knappe Abschnitte (Stand, offen, Artefakt-/Dateibezüge) statt der sechs aus Stufe 3. Länger
geltendes Wissen geht **nicht** über dieses Feld zurück, sondern über das Langzeitgedächtnis aus
S18: jeder abgeschlossene Zug bekommt seit S18b unabhängig von `completeOnDone` die Chance, eine
Notiz zu hinterlassen (`runtime/loop/api.ts`, `summarizeToMemory`, entkoppelt von der Frage, ob
die **Unterhaltung** als Ganzes vorbei ist — sie ist es beim Gateway nie). Über alle drei
Auslöser hinweg gilt: eine Frage zu einem alten Thema trifft nicht auf die (jetzt knappe)
Übergabe, sondern auf den automatischen Gedächtnis-Recall vor jedem Zug — für den Nutzer wirkt
das eine einzige durchgängige Unterhaltung.

### Zwei unterschätzte Regeln

* **Fehler nicht verstecken.** Fehlgeschlagene Aktionen, Stacktraces und Ablehnungsgründe
  bleiben im Verlauf. Das macht aus einem Fehler ein Lernsignal innerhalb derselben Session.
* **Wiederholungen aufbrechen.** Immer gleiche Aktion-Beobachtung-Muster liest das Modell
  unbewusst als Few-Shot-Beispiele und ahmt sie nach. Bei vielen ähnlichen Vorgängen die
  Serialisierung leicht variieren.

---

## 8. Gedächtnis in drei Schichten

| Schicht | Inhalt | Ablage |
|---|---|---|
| Kurzzeit (Session) | Letzte Nachrichten, aktiver Plan, Freigabestatus, Subagenten-Register | Checkpointed Runtime-State |
| Arbeitsspeicher | Große Tool-Ausgaben, Zwischenstände, Notizen, Fortschrittslogs | Dateisystem |
| Langzeit | Konventionen, Vorlieben, wiederkehrende Regeln, Personenwissen | Markdown plus SQLite-Volltextindex |

Keine Vektordatenbank. Markdown ist menschenlesbar und über Git versionierbar, ein
Volltextindex reicht für den Umfang eines persönlichen Gedächtnisses.

### Dateikonventionen im Repo

```
AGENTS.md      dauerhafte Konventionen und Arbeitsregeln
progress.md    menschenlesbares Fortschrittslog
tasks.json     strukturierter Aufgabengraph
artifacts/     große Zwischenergebnisse
plans/         Planentwürfe
reports/       fertige Ergebnisse
memory/        Langzeitnotizen als Markdown
skills/        Skill-Verzeichnisse
```

Für strukturierte Zustände ist JSON besser als Markdown, weil das Modell es seltener
beiläufig umschreibt.

---

## 9. Tool-Katalog

### Kern-Primitive, nativ in der Runtime

```
fs.list · fs.read · fs.write · fs.edit · fs.search
web.search · web.fetch
exec.run
task.set · task.update
user.ask
agent.delegate
notes.read · notes.write
```

### Assistenz-Tools über n8n

```
mail.search · mail.read · mail.draft   (mail.send bewusst nicht gebaut, s. u.)
cal.list · cal.create · cal.update
github.issues · github.branch · github.pr
server.metrics
```

n8n ist die **Tool-Schicht, nicht der Loop**. Jeder Workflow wird zu genau einem Tool, das
die Runtime aufrufen kann. Die Runtime besitzt Loop, Sessions, Checkpoints, Kontext und Policy.

**`mail.send` gibt es nicht (S14).** Das Fertig-Kriterium von Session 14 ist "Entwurf
entsteht, Senden ist technisch unmöglich". Umgesetzt in `tools/mail/tools.ts`: `createMailTools`
liefert genau `mail.search`/`mail.read`/`mail.draft`, `MAIL_WEBHOOKS` ist die vollständige und
eingefrorene Liste der n8n-Webhook-Pfade (keiner sendet), und der Draft-Workflow legt nur im
Ordner "Drafts" ab. Ein Versand ist eine bewusste spätere Ergänzung mit `hard_write`-Freigabe,
kein Nachtrag an dieser Stelle.

### Verzögertes Tool-Laden

**Umsetzung (S18b).** Der Katalog wächst — n8n-Workflows, Skills (S18d), Subagenten-Rollen
(S19/S20) — und jedes zusätzliche Tool ist ein volles Eingabeschema, das bei jedem Zug erneut
im Prompt steht, gelesen oder nicht. `ToolDefinition.deferred` (Vorgabe `false`) trennt die
**Kern-Primitive** (immer mit vollem Schema in der Werkzeugliste der Anfrage) von den
**Assistenz-Tools** (`mail.*`, `cal.*`, `memory.*`, `server.*`, generische n8n-Workflows): ein
`deferred`-Tool steht nur mit Name und Kurzbeschreibung in einem `<deferred_tools>`-Block neben
den Konventionen (`context/request.ts`) — nicht in der `tools`-Liste der Anfrage, solange
niemand danach gefragt hat.

`tool.load` (`tools/tool/tools.ts`, Namensraum `tool`) ist der Weg zurück: ein Aufruf mit einer
Liste von Toolnamen liefert deren volles Schema als Ergebnis und macht sie ab dem nächsten
Modellaufruf nativ aufrufbar — `deriveLoadedToolNames` liest zurückgelesen aus dem Protokoll,
welche Namen das schon betrifft (`tool.completed` von `tool.load`), dieselbe
Wiederanwenden-statt-wiederholen-Idempotenz wie bei Kontextstufe 2 und 3. `tool.load` selbst ist
nie `deferred` — ohne einen von Anfang an sichtbaren Weg, ein Tool nachzuladen, gäbe es keinen
Ausweg aus dem `<deferred_tools>`-Block. Der **Katalog** selbst bleibt unberührt: er kennt jedes
Tool die ganze Zeit, der Router führt es unverändert aus, ob geladen oder nicht — betroffen ist
nur, was in der an den Anbieter gesendeten Werkzeugliste steht. `deferred` zählt deshalb auch
nicht in den Katalog-Fingerabdruck, aus derselben Begründung wie bei `execution`.

### Skills (progressive Offenlegung)

**Umsetzung (S18c).** Ein Skill (Abschnitt 3, Capability Surface — `skills/`) ist ein
Verzeichnis `skills/<name>/` mit genau einer `SKILL.md` darin: Frontmatter mit drei Feldern
(`titel`, `beschreibung`, `wann` — die Auslösebedingung), danach die vollständige Anleitung als
Markdown-Rumpf, beliebig lang. `loadSkillCatalog` (`tools/skill/catalog.ts`) scannt die
Skill-Wurzel **einmal beim Sessionstart** — dieselbe Bauart wie `loadConventions()` für
`AGENTS.md` (Abschnitt 7): Titel, Beschreibung, Auslösebedingung **und** der volle Rumpf jedes
Skills stehen schon nach dieser einen Lesung im Speicher.

**Die Kurzliste, nicht die volle Anleitung, steht im Prompt.** `context/request.ts` legt einen
`<skills>`-Block neben die Konventionen — Titel, Beschreibung und Auslösebedingung jedes
Skills, eine Zeile je Skill, nach demselben Muster wie der `<deferred_tools>`-Block aus S18b.
Leer, wenn kein Skill konfiguriert ist oder `skills/` keinen trägt: derselbe Block bleibt dann
ganz weg, dieselbe Zurückhaltung wie beim `<memory>`-Block. Anders als `<deferred_tools>`
**schrumpft** die Liste nicht, wenn ein Skill benutzt wurde — ein Skill kann in einem späteren
Zug erneut gebraucht werden, und es gibt keine native Zweitrepräsentation (wie ein geladenes
Tool-Schema in der `tools`-Liste), die den Kurzeintrag ersetzen könnte.

**`skill.load`** (`tools/skill/tools.ts`, Namensraum `skill`) ist der Weg zur vollständigen
Anleitung: ein Aufruf mit einem oder mehreren Namen liefert Titel, Beschreibung,
Auslösebedingung und den **vollen Rumpf** jedes Skills als Ergebnis — die Anleitung steht damit
ab diesem Zug im Kontext, genau wie jedes andere Tool-Ergebnis. `execution: "runtime"` wie
`tool.load`: eine reine Nachschlage-Operation auf dem beim Sessionstart eingefrorenen
Skill-Katalog, kein externer Seiteneffekt, kein Schritt. Anders als bei `tool.load` braucht das
Einfrieren keinen Zweischritt — `skill.load` schlägt in einer eigenen Struktur nach
(`SkillCatalog`), nicht im `ToolCatalog`, den es selbst mitbildet, also kein Henne-Ei-Problem.
`skill.load` selbst ist **nie** `deferred`, aus demselben Grund wie `tool.load`: ohne einen von
Anfang an sichtbaren Weg gäbe es keinen Ausweg aus dem `<skills>`-Block.

**Skill-Nutzung als eigener Ereignistyp.** `skill.load` schreibt wie jedes Tool ein generisches
`tool.completed`, aber zusätzlich — direkt aus dem Handler, wie `memory.conflicted` neben
`tool.completed` von `memory.write` — ein `skill.invoked` mit den geladenen Namen. Ohne dieses
Ereignis wäre "welcher Skill wurde wann benutzt" nur über einen Filter auf den Payloads aller
`tool.completed` beantwortbar, genau die Frage, die zuerst gestellt wird, wenn ein Skill sich
falsch verhalten hat.

**Fremde Skills werden vor Aktivierung gelesen, nicht blind ausgeführt** (Abschnitt 4.7) ist
hier keine Verabredung, sondern eine Eigenschaft der Bauart: es gibt in diesem System keinen
zweiten Weg, auf dem eine Skill-Anleitung wirksam werden könnte. Der `<skills>`-Block trägt nie
mehr als die Kurzfassung, und es gibt kein `skill.run` oder Ähnliches, das eine Anleitung
ausführte, ohne sie vorher in den Kontext zu legen — jeder Weg, auf dem ein Skill etwas
bewirkt, führt zwingend zuerst durch `skill.load` (oder durch `fs.read` auf dieselbe Datei, mit
demselben Ergebnis: der volle Text im Kontext, bevor irgendetwas daraus befolgt wird). Ein
Skill, dessen Text niemand gelesen hat, kann nichts bewirken, weil seine Anweisungen nirgends
sonst stehen.

**Bewusst nicht Teil dieser Session:** eine Installation neuer Skills aus einer externen
Quelle (Abschnitt 4.7 spricht von "vor der Installation gelesen" — das ist eine spätere
Ergänzung, kein Nachtrag hier), eine feinere Freigabe-Granularität für `skill.load` (es ist
`read`, wie `tool.load`), und automatische Auslagerung für außergewöhnlich große Skills (wie
bei `tool.load` wirft `callRuntimeTool` stattdessen `ToolOutputTooLargeError` — ein Skill muss
knapp genug bleiben, um in einem Zug geladen zu werden). Die ersten eigenen Skills (Mail-Triage,
Wochenrückblick, Recherche-Ablauf) sind S18d.

### MCP absichern

**Umsetzung (S27).** Bis hierhin war MCP nur eine Warnung (Anti-Muster 10: "MCP, ACP und A2A
vermischen") und eine offene Frage ("welche MCP-Server zuerst", Abschnitt 17) — nirgends im
Repo implementiert. Diese Session baut den Mechanismus, mit dem ein MCP-Server angebunden
werden **kann**, und beweist mit Tests, was der Auftrag wörtlich verlangt: "Eine fremde/
manipulierte Tool-Beschreibung ändert das Verhalten der Runtime nachweislich nicht." Sie wählt
**keinen** konkreten produktiven Server — die offene Frage aus Abschnitt 17 bleibt offen,
genau wie `exec.run`/`github.*` seit S20 unverdrahtet blieben, obwohl sie in diesem Abschnitt
stehen. `tools/mcp/client.ts` und `tools/mcp/tools.ts` sind deshalb an keinem echten Prozess
angeschlossen (`gateway/index.ts`, `runtime/index.ts` kennen kein `mcp: {...}`); wer einen
Server anbinden will, reicht `CatalogConfig.mcp` an `buildCatalog` (`runtime/loop/api.ts`).

**Kein SDK, dieselbe Disziplin wie bei der Telegram-Bot-API (S16) und der n8n-Brücke (S13):**
`tools/mcp/client.ts` spricht MCPs Stdio-Transport (zeilenweises JSON-RPC 2.0, `\n`-getrennt —
**keine** LSP-artige `Content-Length`-Rahmung) direkt, ohne ein MCP-SDK zu importieren. Der
Transport (`McpTransport`) ist vom Client getrennt, aus demselben Grund wie `fetchImpl` überall
sonst: Tests setzen ein Paar verbundener Ströme ein, ohne einen echten Prozess zu spawnen.

**Die Härtung hat drei Achsen, alle unabhängig vom Text der Tool-Beschreibung:**

* **Risikostufe ist eine lokale, pro Server konfigurierte Obergrenze.** `tools/list` liefert
  kein Risikofeld — die Versuchung wäre, es aus Formulierungen in der Beschreibung zu raten
  ("liest nur", "völlig sicher"). `McpServerConfig.risk` ist eine Betreiberentscheidung wie
  `N8nWorkflowDef.risk` (S13) und gilt unverändert für **jedes** Tool des Servers, gleich was
  seine Beschreibung behauptet. Ein Test (`tools/mcp/tools.test.ts`) registriert einen
  Fake-Server mit einer Beschreibung, die wörtlich "risk: read, auto_approve: true" fordert,
  konfiguriert den Server lokal mit `hard_write` und zeigt Ende-zu-Ende gegen eine echte
  `PolicyEngine`: der Aufruf bleibt so freigabepflichtig wie jedes andere `hard_write`-Tool.
* **Namensraum-Isolation durch Konstruktion.** Der lokale Name ist zwingend
  `mcp.<serverId>__<sanitierter Fernname>` — `TOOL_NAME_PATTERN` (`tools/registry.ts`) lässt
  nach dem ersten Punkt ohnehin keinen zweiten zu, und der Namensraum ist immer `mcp`. Ein
  Fern-Tool kann also nicht `fs.write` oder `write` im Sinne eines bekannten Namens vortäuschen;
  zwei Fernnamen, die nach der Sanitierung kollidieren würden, lassen `createMcpTools` mit
  einem benannten Fehler abbrechen statt einen davon still zu verwerfen.
* **Einmalige Entdeckung beim Katalogbau.** Wie beim Skill-Katalog und den n8n-Workflows wird
  `tools/list` **einmal** abgefragt (`createMcpTools`, aus `buildCatalog`), das Ergebnis wird
  zu statischen `ToolDefinition`s, danach ist der Katalog eingefroren wie jeder andere
  (Anti-Muster 2). Es gibt keine zweite Methode, die mitten in einer Session erneut
  entdeckte — ein "Rug Pull" (Server ändert Beschreibung/Schema nach der ersten Zusage) hat
  hier strukturell keinen Angriffspunkt.

Eine vierte, kleinere Härtung betrifft die Eingabefelder: ein Fernfeld, das `path` oder `url`
heißt (oder wie eines aussieht, siehe `policy/resource.ts`s `assertPolicyFieldNames`), wird vor
der Registrierung umbenannt (`<feld>_arg`) und beim Aufruf zurückübersetzt — sonst bekäme die
Policy-Engine eine Dateizonen- oder Domain-Bedeutung vorgespiegelt, die für einen beliebigen
MCP-Server nicht gilt, bis MCP eine eigene Ressourcen-Achse in der Engine bekommt (nicht Teil
dieser Session).

**Was schon galt und hier nicht neu erfunden wird.** Dass eine Anweisung in externem Inhalt nie
eine Freigabepflicht aufhebt, steht seit Abschnitt 4.7/AGENTS.md fest, und die automatische
Redaction an den Schreibtoren (`runtime/redaction/redact.ts`) läuft an jedem Pfad ins Protokoll
oder den Prompt — auch an der Beschreibung eines MCP-Tools, ohne dass dieses Modul sie selbst
aufruft. S27 beweist diese beiden Zusagen konkret für MCP, es ersetzt sie nicht.

**Bewusst nicht gebaut:** ein echter, produktiv angebundener Server (siehe oben); MCP-
Ressourcen/Prompts (nur `tools/list`/`tools/call`, die einzigen beiden Operationen, die der
Auftrag braucht); eine feinere Risikostufe je Fern-Tool statt je Server (der Auftrag verlangt
eine Obergrenze, keine Feinsteuerung, und eine zusätzliche Stellschraube wäre eine zweite
Stelle, an der sich dieselbe Umgehung einschleichen könnte, die diese Session gerade
verhindert); ein zweiter Transport (HTTP+SSE) — Stdio deckt den Anwendungsfall "ein lokal
gestarteter MCP-Server" vollständig ab.

### Wann etwas ein eigenes Tool verdient

Nur wenn mindestens einer dieser Punkte zutrifft: besondere Darstellung in der Oberfläche,
deterministischer Prüfpunkt für Guardrails, Nebenläufigkeit oder Transaktionssemantik,
saubere Ereignisgrenze für Beobachtbarkeit, abweichende Freigabepolitik.
Sonst bleibt es in der Shell oder Code-Sandbox.

### Einheitliche Rückgabehülle, verbindlich für jedes Tool

```json
{
  "status": "ok",
  "summary": "2 passende Mails gefunden",
  "structured": { "matches": 2 },
  "artifact_refs": ["artifact://mail/results.json"],
  "preview": ["Betreff A", "Betreff B"]
}
```

`status` ist `ok` oder `error`. Bei `error` bleibt der Fehlertext erhalten und wird nicht
geglättet.

**Umsetzung (S07):** `tools/router.ts` ist die einzige Stelle, die diese Hülle herstellt —
deshalb kann kein Tool eine andere Form zurückgeben. Ein Handler liefert nur `summary`,
`structured`, `artifact_refs` und `preview`; `status` setzt der Router daran, ob der Handler
zurückkam oder geworfen hat, und nicht das Tool an einem Feld, das es auch falsch setzen
könnte.

Als Ergebnis (`status: "error"`) kommen zurück: unbekannter Toolname, Schema-Verstoß,
geworfener Handler, Zeitüberschreitung und die Weigerung der Ausführungshülle, einen
zweiten Versuch zuzulassen. Der volle Fehlertext samt Stacktrace steht in
`structured.error`, der maschinenlesbare Grund in `structured.reason`.

**Geworfen** wird genau eine Lage: die Session trägt eine andere Tool-Katalogversion als der
aufrufende Prozess. Das ist keine Antwort auf einen Tool-Aufruf, sondern die Aussage, dass
dieser Prozess diese Session nicht bedienen darf — dieselbe Trennlinie wie in der
Ausführungshülle aus S05 (das Ergebnis eines Laufs kommt zurück, die Weigerung zu laufen
fliegt).

Der Katalog ist pro Session eingefroren. Seine Version ist ein Fingerabdruck über Name,
Beschreibung, Eingabeschema, Risikostufe und Wiederholbarkeit aller Tools und wird bei der
Neuanlage in `sessions.tool_catalog_version` festgehalten. Eine von Hand gepflegte Version
wäre die Hoffnung darauf, dass jemand sie beim Ändern hochzählt; der Handler-Rumpf zählt
bewusst nicht mit, damit eine Fehlerbehebung keine laufende Session ungültig macht.

**Umsetzung (S10):** `task.set`/`task.update` (`runtime/tasks/`, `tools/task/tools.ts`) und
`user.ask` (`runtime/session/user-input.ts`, `tools/user/tools.ts`) haben keinen externen
Seiteneffekt und laufen deshalb **nicht** durch die Ausführungshülle aus S05 — ein neues
Feld `ToolDefinition.execution` (Vorgabe `"step"`, neu `"runtime"`) markiert das im Router.
`callRuntimeTool` prüft Katalog und Schema wie jedes Tool und schreibt weiter
`tool.requested`/`tool.completed`, ruft den Handler aber direkt statt über `executeStep`.
`execution` zählt bewusst **nicht** in `fingerprintTools` — dieselbe Begründung wie beim
Handler-Rumpf: es ist eine interne Weiche, kein Teil des Vertrags, den das Modell sieht.
`task.set` schreibt den kompletten Plan neu (kein Anhängen), `task.update` patcht eine
Aufgabe; beide halten Zeile (`kuronami.tasks`, seit S10 mit `session_id` und `position`,
Migration `0006`) und Ereignis (`task.created`/`task.updated`) in derselben Transaktion
identisch — dieselbe Snapshot-gleich-Replay-Disziplin wie bei Schritten (S05) und
Artefakten (S06).

---

## 10. Governance und Freigaben

**Grundannahme:** Das Modell ist kompetent, aber nicht vertrauenswürdig genug, um die
einzige Kontrollinstanz zu sein.

### Vier Entscheidungsebenen

1. **Hooks**: eigener Code vor der Ausführung
2. **Statische Regeln**: Allow/Deny/Ask nach Tool, Pfad, Domain, Geheimnisklasse
3. **Permission Mode**: grober Sessionmodus (`ask`, `accept_edits`, `bypass_in_sandbox`)
4. **Laufzeit-Rückfrage**: der Mensch entscheidet

**Umsetzung (S11):** `policy/`, aufgerufen vom Tool-Router. Die Ebenen stimmen nicht ab, sie
sprechen — und es gilt die **schärfste** Aussage, nicht die letzte und nicht die
spezifischste (`deny` > `ask` > `allow`). Daraus folgen drei Dinge, die keine Detailfragen
sind:

* **Die Reihenfolge der Regeln ist bedeutungslos.** Es werden alle ausgewertet. Bei "erste
  passende Regel gewinnt" hinge die Sicherheit an der Position in einer Liste, und ein breites
  `allow` weiter oben schaltete jede spätere Verschärfung ab, ohne dass man es der Liste ansieht.
* **Ein `allow` senkt nichts.** Es ist eine Abstention mit Namen: es steht im Freigabepfad,
  damit sichtbar bleibt, dass die Ebene gelaufen ist und nichts einzuwenden hatte, aber es hebt
  keine Freigabepflicht auf. Sonst wäre die stärkste Zusage des Systems einen zu breit
  geratenen Glob weit vom Verschwinden entfernt — lautlos, weil sich ein zu breites `allow`
  wie ein funktionierendes System anfühlt.
* **Regeln heben die Risikostufe an, sie senken sie nie.** Eine Regel, die senken darf, ist
  eine, mit der sich jede Stufe wegkonfigurieren lässt; dann stünde die Tabelle unten unter dem
  Vorbehalt der Regeldatei.

Unter allen vier Ebenen liegt die Risikostufe als **Boden**: was die Tabelle verlangt, verlangt
sie auch bei leerem Regelsatz. Die einzige Ebene, die den Boden senken darf, ist der
Sessionmodus — `accept_edits` für Aufrufe, die einen Pfad betreffen, `bypass_in_sandbox` nur
mit nachgewiesener Sandbox (die es bis `exec.run` nicht gibt, weshalb der Modus sichtbar auf
`ask` zurückfällt statt still zu wirken). Er hebt nie das Wort einer anderen Ebene auf und
greift nie bei `destructive`. Ein Hook, der wirft, gilt als Ablehnung; eine Ressource, die die
Engine nicht einordnen kann, ebenfalls (fail closed).

### Risikostufen

| Stufe | Beispiele | Default |
|---|---|---|
| Lesen | `fs.read` · `web.search` · `mail.search` · `cal.list` | automatisch erlaubt |
| Weiches Schreiben | Artefakte anlegen, Notizen schreiben, Entwürfe erstellen | automatisch im Arbeitsverzeichnis |
| Hartes Schreiben | Mail senden, Shell, DB-Änderung, Secrets, PR öffnen | Freigabe nötig |
| Zerstörend | Löschen, Migration, Produktivaktion | immer Freigabe |

Weitere Regeln:

* `user.ask` ist ein synchroner Haltepunkt mit **strukturierten Optionen**, kein Fließtext,
  auf dessen Parsbarkeit man hofft

  **Umsetzung (S10):** Der Mechanismus steckt vollständig im Ereignisprotokoll, ohne eigene
  Tabelle und ohne eigene Spalte. `user.ask` schreibt `approval.requested` mit Frage und
  strukturierten Optionen unter dem stabilen Schlüssel `ask:<call_id>`; solange kein
  `approval.granted`/`approval.denied` mit derselben `ask_id` folgt, faltet
  `deriveSessionState` (`runtime/session/state.ts`) den Sessionstatus zu `awaiting_user` —
  neu in `SessionStatus`, kein eigener Ereignistyp, dieselbe Lesart wie bei `canceled`. Ein
  offener Aufruf lässt `UserInputRequiredError` **durch** den Router (wie
  `ToolCatalogMismatchError`): der Lauf ist nicht fehlgeschlagen, er wartet, und
  `runtime.stopped` wird trotzdem sauber geschrieben. `answerUserInput` schreibt
  `approval.granted` mit dem vollständigen Freigabepfad (gewählte Option, `decided_by`,
  Zeitstempel); ein erneuter `user.ask` mit derselben `call_id` — die ein wiederaufnehmender
  Lauf aus seinem Plan wieder herleitet — findet die Antwort und läuft weiter. Der
  Neustart-Nachweis (`runtime/session/user-input.test.ts`) spawnt dafür einen echten
  zweiten Betriebssystem-Prozess, nicht nur einen zweiten Testlauf im selben Modul.
* Freigaben der Form "für diese Session erlauben" werden gespeichert und bei Wiederaufnahme
  wiederhergestellt

  **Umsetzung (S11):** drei Geltungsbereiche — `once`, `session`, `always` (der dritte ist
  eine Erweiterung gegenüber dem Satz oben und in Migration `0007` begründet). Freigabe und
  Ereignis (`approval.granted`/`approval.denied`) entstehen in **einer** Transaktion; das
  Ereignis ist die Wahrheit, die Zeile in `kuronami.approvals` der Schnappschuss. Deshalb ist
  eine sessiongebundene Freigabe nach einem Neustart einfach wieder da — sie lag nie im
  Speicher. Nachgewiesen mit einem echten zweiten Betriebssystem-Prozess. `once` ist an die
  `call_id` gebunden und nicht an "die nächste Gelegenheit"; eine Ablehnung ebenso, damit ein
  wiederaufgenommener Lauf nicht dieselbe Frage noch einmal stellt. Wofür eine Freigabe gilt,
  steht als **Subjektschlüssel** in der Zeile (`fs.write|zone/source`,
  `fs.read|secret/dotenv/.env`, `web.fetch|host/example.com`) — Geheimnisse je Datei, Pfade je
  Zone, Adressen je Host. Bei `destructive` gibt es ausschließlich `once`: "immer Freigabe"
  heißt jedes Mal, und `session`/`always` werden dort gar nicht erst angeboten.
* Jede ausgeführte Aktion hinterlässt: Auslöser, Eingaben, Freigabepfad, Ausgaben, Zeitstempel

  **Umsetzung (S11):** `policy/audit.ts`. Die fünf Angaben stehen nicht in einer eigenen
  Tabelle und nicht in einem einzigen Ereignis, sondern werden über die `call_id` aus
  `tool.requested` (Auslöser, Eingaben, Zeitstempel), `policy.allowed`/`policy.denied`
  (Freigabepfad) und `tool.completed`/`tool.failed` (Ausgaben) **gefaltet** — wie der
  Sessionzustand seit S05. Ein sechstes Ereignis, das alles noch einmal zusammen trägt, wäre
  eine zweite Wahrheit neben dem Protokoll und könnte von ihm abweichen. Der Freigabepfad ist
  dabei nicht eine Begründung, sondern die Kette: was jede Ebene gesagt hat und warum. Dass es
  keinen Ausgang ohne Entscheidung gibt, prüft `auditGaps` über einen ganzen Lauf — getragen
  wird die Zusage aber vom Typsystem (siehe 4.7), nicht vom Test.

---

## 11. Modell-Routing und Kosten

| Schritt-Typ | Modellklasse |
|---|---|
| Klassifikation, Routing, Extraktion, "ist das fertig?" | klein und günstig, später lokal |
| Zusammenfassen, einfache Tool-Auswahl | mittel |
| Planen, mehrstufiges Reasoning, Formulieren | stark, Cloud |

Kuronami läuft über die **Claude API**, nutzungsbasiert abgerechnet. Das Pro-Abo deckt
keinen API-Zugriff ab, das sind getrennte Produkte.

Hebel gegen unkontrollierte Kosten: Modell pro Agent bewusst wählen, Prompt-Caching für
wiederkehrenden Kontext, Batch-Verarbeitung für Hintergrundläufe ohne Zeitdruck,
Kosten-Tracking pro Agent und Tag ab dem ersten Modellaufruf mitloggen.

Cron-Agenten sind der eigentliche Kostentreiber, nicht der Chat mit dem Nutzer.

Lokale Modelle: der aktuelle Server (3,7 GB RAM, keine GPU) reicht nicht. Kein Blocker für
Phase 0 bis 4, sondern eine spätere Kostenoptimierung.

---

## 12. Beobachtbarkeit

Nicht nur das Modell instrumentieren, sondern das Harness: Modellaufrufe, Tool-Aufrufe,
Wartezeiten auf Freigaben, Kompaktierungsereignisse, Subagenten-Fächerung,
Artefakterzeugung, Wiederaufnahme, Fehlerpfade.

Kennzahlen ab Tag eins:

* Wiederaufnahme-Erfolgsquote · Schrittfehlerquote · mittlere Schrittzahl pro Aufgabe
* Cache-Trefferquote · Kompaktierungshäufigkeit · Anteil ausgelagerter Tool-Ergebnisse
* Tool-Auswahlgenauigkeit · Tool-Latenz
* Freigaben pro Aufgabe · Wartezeit auf Freigabe · Überstimmungsquote

Diese Kennzahlen sind gleichzeitig der Inhalt der späteren UI-Panels. Sie werden nicht
extra für die Oberfläche erfunden.

**Umsetzung (S18a):** Cache-Trefferquote und Kompaktierungshäufigkeit stehen seit S12 als
Faltung über das Protokoll bereit (`context/metrics.ts`, `RunMetrics`), sind damit aber nur so
sichtbar, wie jemand die Faltung aufruft. Die Cache-Trefferquote landet zusätzlich als Feld im
`turn.completed`, das einen Zug abschließt — pro Lauf direkt auslesbar, ohne das ganze
Protokoll erneut zu falten. Die Kompaktierungshäufigkeit bleibt bewusst nur über
`context.compacted`-Ereignisse zählbar (kein zweites Feld dafür): eine Kennzahl, die nur die
Anzahl eines bereits vorhandenen Ereignistyps ist, verdoppelte sonst eine Wahrheit
(Abschnitt 4.4).

---

## 13. Startwerte

| Stellgröße | Startwert |
|---|---|
| Max. Schritte pro Turn | 50 bis 100 |
| Max. Wiederholungen pro Schritt | 2 bis 3 |
| Reservierter Kontext | 20 bis 25 % des Fensters |
| Auslagerungsschwelle große Ergebnisse | 8k bis 16k Token-Äquivalent |
| Verschachtelte Subagenten | aus |
| Freigabemodus | Fragen bei Schreiben, Shell, Netzwerk, Löschen |
| Artefakt-Persistenz | immer an für Suche, Abruf, Code-Ausgaben |
| Sandbox-Timeout | 60 Sekunden |

---

## 14. Subagenten

**Erste Regel: nicht mit vielen Agenten anfangen.** Multi-Agent bringt Komplexität, Latenz
und Kosten. Anthropic berichtet aus dem eigenen Research-System von etwa dem 15-fachen
Token-Verbrauch gegenüber normalem Chat.

Standardmuster ist **Orchestrator-Worker**, nicht Peer-to-Peer:

* Hauptagent hält den Vertrag mit dem Nutzer und den Aufgabenzustand
* Worker bekommen enge Aufträge und isolierte Kontexte
* Worker liefern nur Endergebnis plus Artefakt-Referenzen zurück
* Worker teilen keine Gesprächshistorie
* Keine rekursiven Subagenten, explizite Tool-Beschränkung pro Subagent, Obergrenze für
  parallele Worker und Token-Budget

Erste Besetzung (Phase 5): Coder, Visualizer, UI-Designer, Lore-Writer (Game-Projekt) ·
Trading-Agent, Backtest-Agent (Trading) · Mail-Agent (persönlich, günstiges Modell).

Neue Rollen entstehen über `agent.create` per Sprach- oder Textbefehl, nicht durch neuen
Code pro Agent. Werkzeug-Zugriff ist rollenspezifisch, nie pauschal.

**Umsetzung (S19):** `kuronami.agents` (Abschnitt 5), `tools/agent/` und `runtime/agents/`.
Vier Sätze von oben stehen dabei nicht als Bitte im Prompt, sondern als Form im Code:

* **Isolierter Kontext** — ein Arbeiter bekommt eine **eigene Session** auf dem neuen Kanal
  `agent`, also ein eigenes Ereignisprotokoll. Der Kontext einer Session *ist* die Faltung
  ihres Protokolls; die Unterhaltung des Hauptagenten kommt darin nicht vor, und es gibt
  keinen Schalter, der sie hereinließe. Alles, was der Arbeiter wissen soll, steht in `task`
  bzw. `context` seines Auftrags.
* **Nur Endergebnis plus Artefakt-Referenzen zurück** — `agent.delegate` gibt Abschlusstext,
  Artefakt-Handles und Kennzahlen zurück, keine Historie.
* **Explizite Tool-Beschränkung** — der Katalog des Arbeiters ist die Schnittmenge aus der
  Werkzeugliste seines Profils und dem Katalog des Prozesses, neu eingefroren.
* **Keine rekursiven Subagenten** — `runtime/loop/api.ts` registriert die `agent.*`-Tools
  zuletzt und übergibt ihnen den Katalog, wie er **vorher** aussah. Ein Arbeiter kann nicht
  weiterdelegieren, weil es in seinem Katalog nichts gibt, womit er es täte.

`agent.delegate` läuft mit Ausführungshülle (`repeatable: false`, eigenes Zeitfenster): ein
Arbeiterlauf ist ein externer Seiteneffekt im Sinn von Abschnitt 6, und ein Absturz darf ihn
nicht ein zweites Mal starten. Ein Arbeiter, der auf eine Freigabe warten müsste, endet als
Fehlschlag statt still zu hängen — er hat kein Gegenüber, das antwortet.

**Umsetzung (S20):** die erste Besetzung steht als Daten im Quellbaum
(`runtime/agents/besetzung.ts`, angelegt über `pnpm agents:seed`) und nicht als INSERT in einer
Migration — so geht jedes der sieben Profile durch dasselbe Tor wie eines aus `agent.create`
(Namensform, bekannte Werkzeuge, Obergrenzen), und der Lauf ist wiederholbar. Jede Rolle nennt
eine **Modellklasse** statt eines Modellnamens; aufgelöst wird sie über dieselbe Konfiguration,
aus der auch der Modell-Router seit S18e wählt.

Die drei Obergrenzen dieses Abschnitts sind damit vollständig umgesetzt, jede an der Stelle,
an der sie hingehört:

* **Tool-Beschränkung** — zweifach. Der Katalog des Arbeiters enthält nur seine Werkzeuge (ein
  anderes ist für ihn ein unbekanntes Tool), **und** ein Policy-Hook am Profil lehnt jeden
  Aufruf außerhalb der Liste ab (`tools/agent/policy.ts`). Das zweite Tor hält auch dann, wenn
  jemand einen Arbeiter künftig mit einem breiteren Katalog startet — dieselbe Doppelung wie
  bei der Risikostufe (Registry und Engine, S11).
* **Parallele Worker** — ein Kontingent je Prozess (Vorgabe zwei). Wer darüber hinaus
  delegiert, **wartet**, statt abgewiesen zu werden: ein abgewiesener Arbeiter wäre für das
  Modell ein Fehlschlag, den es nicht beheben kann.
* **Token-Budget** — als Hülle um den Modell-Client des Arbeiters, geprüft vor jedem Aufruf.
  Ist es aufgebraucht, endet der Lauf sichtbar (`stop: "token_budget"`), statt weiterzulaufen.

---

## 15. Anti-Muster

1. Den Agenten als "nur ein Prompt" behandeln
2. Den Toolsatz mitten in der Session umbauen
3. Rohe Tool-Ausgaben in den Kontext fluten lassen
4. Multi-Agent einsetzen, weil es fortgeschritten klingt
5. Sich darauf verlassen, dass das Modell riskante Aktionen selbst zurückhält
6. Ausführliche, menschlich formulierte Tool-Antworten zurückgeben
7. Fehler vor dem Modell verstecken
8. Den System-Prompt mit allen denkbaren Anweisungen überladen
9. Das Harness selbst nicht evaluieren, Tool-Tests reichen nicht
10. MCP, ACP und A2A vermischen

---

## 16. Sessionplan, 24 Sessions

Reihenfolge ist bindend. Eine Session ergibt ein überprüfbares Ergebnis. Lässt sich das
Ergebnis nicht mit einem Befehl testen, ist die Session zu groß geschnitten.

| # | Session | Phase | Fertig, wenn |
|---|---|---|---|
| 01 | Repo-Grundgerüst | 0 | Struktur steht, `.claudeignore` und `AGENTS.md` da, Testlauf grün |
| 02 | Postgres-Schema | 1 | Migration läuft durch, alle Tabellen existieren |
| 03 | Ereignisprotokoll | 1 | Ereignisse schreibbar und in Reihenfolge lesbar |
| 04 | Runtime-Skelett | 1 | Session überlebt einen Prozess-Neustart |
| 05 | Wiederaufnahme und Abbruch | 1 | Killen und Fortsetzen mitten im Lauf funktioniert |
| 06 | Artefaktspeicher | 1 | Datei über `artifact://`-Handle les- und schreibbar |
| 07 | Tool-Router | 1 | Dummy-Tool antwortet in der einheitlichen Hülle |
| 08 | Kern-Tools `fs.*` | 1 | Pfad-Traversal-Test wird abgewiesen |
| 09 | `web.search` / `web.fetch` | 1 | Große Antwort landet automatisch als Artefakt |
| 10 | `task.*` und `user.ask` | 1 | Lauf pausiert sauber bei `awaiting_user` |
| 11 | Policy-Engine | 1 | Schreibendes Tool wird ohne Freigabe blockiert |
| 12 | Erster echter Loop | 1 | Aufgabe mit 30 Schritten läuft vollständig durch |
| 13 | n8n-Brücke | 2 | Ein n8n-Workflow antwortet im Tool-Schema |
| 14 | Mail-Tools | 2 | Entwurf entsteht, Senden ist technisch unmöglich |
| 15 | Kalender und Obsidian | 2 | Termine und Obsidian-Notizen lesbar |
| 16 | Gateway | 3 | Zwei Kanäle, ein Agent, ein Gedächtnis |
| 17 | Heartbeat | 3 | Morgen-Digest läuft ohne manuellen Anstoß |
| 18 | Langzeitgedächtnis | 3 | Alte Notiz wird bei neuem Lauf automatisch gefunden |
| 19 | Agenten-Registry und `agent.create` | 5 | Neuer Agent per Sprachbefehl anlegbar, sofort aktiv |
| 20 | Erste Subagent-Besetzung | 5 | Alle sieben Rollen angelegt, Tools rollenspezifisch begrenzt |
| 21 | Kosten-Tracking und Modell-Routing | 8 | Tagesausgaben pro Agent sichtbar |
| 22 | Tauri-Desktop-Wrapper | 9 | Installierbare Desktop-App aus demselben Code |
| 23 | Sprachschicht-Grundgerüst | 9 | Pipecat läuft, Deepgram und ElevenLabs angebunden |
| 24 | Barge-in und Backend-Brücke | 9 | Unterbrechen funktioniert, unter 800 ms End-zu-End |

### Ablauf jeder Session

1. `progress.md` und `tasks.json` lesen, **nicht** den Kontext aus der Codebasis rekonstruieren
2. Tests der Vorsession laufen lassen
3. Die eine Aufgabe der Session erledigen
4. Fertig-Kriterium nachweisen
5. `progress.md` und `tasks.json` aktualisieren, dann `/clear`

---

## 17. Noch offene Entscheidungen

Diese gehören nicht in Phase 0 und blockieren den Bau nicht.

* Hardware: aufrüsten für lokale Modelle, oder vorerst rein Cloud
* Kanal-Reihenfolge: Telegram oder Mail als zweiter Kanal
* Bestehendes Dashboard: parallel weiterlaufen lassen oder irgendwann hart abschalten
* Subagenten in der 3D-Welt: eigene Figuren oder bleibt es eine
* Welche MCP-Server zuerst: Game-Tools oder Trading-Tools
* Separates API-Billing-Konto einrichten, Budget-Obergrenze festlegen
* Server für den Dauerbetrieb ab Phase 3 (Gateway, Heartbeat): bestehende Hardware
  aufrüsten oder Cloud-VM. Keine Eile, wird erst mit S16/S17 relevant.

**Entschieden (04.09.2026): Postgres für die Entwicklung läuft lokal über Docker Desktop
auf dem Windows-Rechner**, nicht auf dem bestehenden Server. Begründung: Entwicklung ist
Iteration, jeder Umweg über einen entfernten Rechner kostet bei jedem Schritt Zeit ohne
Gegenwert in dieser Phase. Der bestehende Server (3,7 GB RAM, keine GPU) ist für
Datenbank plus n8n plus Runtime parallel ohnehin zu schwach und wird erst als
Deployment-Ziel für den 24/7-Betrieb relevant, nicht als Entwicklungsumgebung.

---

## 18. Quellen

* Modern Agent Harness Blueprint 2026: https://gist.github.com/amazingvince/52158d00fb8b3ba1b8476bc62bb562e3
* Anthropic Engineering: Effective harnesses for long-running agents, Effective context engineering, Writing tools for agents, Multi-agent research system
* LangChain: Deep Agents, LangGraph durable execution, Choosing the right multi-agent architecture
* Hermes Agent (Nous Research), als Blaupause geprüft, nicht geforkt
* OpenJarvis (Stanford SAIL / Hazy Research): https://github.com/open-jarvis/OpenJarvis
* awesome-harness-engineering: https://github.com/ai-boost/awesome-harness-engineering
* Notion-Masterseite: https://app.notion.com/p/3c9251f9ae70817a823af96428f3030d
