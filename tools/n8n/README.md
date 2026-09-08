# n8n-Brücke (S13)

n8n ist die **Tool-Schicht, nicht der Loop**. Ein n8n-Workflow ist eine Integration mit
einem HTTP-Eingang; er hält keine Session, kein Ereignisprotokoll, keine Policy. Loop,
Checkpoints, Kontext und Governance bleiben in der Runtime. Diese Brücke macht aus jedem
Workflow genau ein Tool, das der Router aufruft wie `fs.read` oder `web.fetch`.

## Aufbau

| Datei | Inhalt |
| --- | --- |
| `bridge.ts` | `createN8nBridge()` — ruft einen Webhook auf: Timeout, Retry mit Backoff, harte Größenbegrenzung, benannte Fehler. Kennt nur HTTP, keine Hülle. |
| `workflows.ts` | `N8nWorkflowDef` (Name, Beschreibung, Risikostufe, Wiederholbarkeit, Webhook-Pfad, Eingabeschema) und `createN8nTools()`, das daraus native `ToolDefinition`s baut. Dazu der Prüf-Workflow `dev.uppercase`. |
| `workflows/uppercase.json` | Importierbarer n8n-Workflow für `dev.uppercase` (n8n 2.x). |

## Ein Workflow ist ein Tool

`createN8nTools()` gibt `ToolDefinition`s zurück, die durch denselben Router laufen wie
alles andere:

- **Katalog + Schema**: die Registry prüft Namensform (`namensraum.aktion`), Risikostufe
  und die Feldnamen (`path`/`url`-Konvention, `assertPolicyFieldNames`). Ein n8n-Tool, das
  aus JSON entsteht, kommt am Compiler vorbei, aber nicht an der Registry.
- **Policy**: der Router ruft die Engine vor der Ausführung. Ein schreibender Workflow
  (`mail.send`, S14) wird ohne Freigabe blockiert.
- **Ausführungshülle** (`execution: "step"`, Vorgabe): Checkpoint davor und danach,
  Idempotenzschlüssel aus der `call_id`, 60-s-Zeitfenster, Wiederaufnahme nach einem
  Absturz.
- **Einheitliche Rückgabehülle**: der Handler liefert nur `summary`, `structured`,
  `preview`; `status` setzt der Router daran, ob der Handler zurückkam oder warf.
- **Automatische Auslagerung**: der Router misst die fertige Hülle und schreibt
  `structured` in ein Artefakt, wenn sie über der Schwelle liegt (`materializeResult`,
  S07). Die Brücke baut **keine** eigene Auslagerung — ein n8n-Ergebnis hat keine bekannte
  Form, aus der sich ein typisierter Ausschnitt schneiden ließe (anders als `fs.read` mit
  Rohbytes oder `web.fetch` mit excerpt). Der Handler sorgt nur dafür, dass `summary` und
  `preview` auch nach der Auslagerung etwas aussagen.

## Timeout und Retry auf Brückenebene

Beides liegt in `bridge.ts`, nicht nur in n8n:

- **Timeout** je Aufruf, Vorgabe 30 s — unter dem 60-s-Fenster der Hülle, damit ein
  hängender Workflow als sauberer Tool-Fehler endet, nicht als "unbekannter Ausgang".
- **Retry mit exponentiellem Backoff** bei vorübergehenden Fehlern: Netzfehler ohne
  Antwort, HTTP 429/502/503/504. Vorgabe: ein erster Versuch plus zwei Wiederholungen.
- **Nur bei `repeatable`-Workflows.** Ein nicht wiederholbarer Workflow bekommt genau
  einen Versuch. Ob ein zweiter Anlauf sicher wäre, weiß nur der Workflow-Autor — dieselbe
  Haltung wie in der Ausführungshülle. At-least-once bleibt die Zusage: ein 5xx *kann*
  heißen, dass der Workflow lief und nur die Antwort verlorenging.
- **Kein Retry** bei 4xx außer 429 (deterministisch), beim Brücken-Timeout und bei Abbruch
  von außen.

Der Hülle-Retry (über Prozessgrenzen, `attempt` in `kuronami.steps`) und der Brücken-Retry
(HTTP-Versuche in einem Hülle-Versuch) sind verschiedene Fehlerdomänen und beide begrenzt.

## Erreichbarkeit

n8n ist **nur intern erreichbar** (`docker-compose.yml`):

- Der Editor hängt auf `127.0.0.1:5678` — auf diesem Rechner im Browser erreichbar, nicht
  aus dem Netz.
- Die Runtime spricht n8n über das Compose-Netz als `http://n8n:5678` an, ohne
  veröffentlichten Port.
- **Login**: n8n 2.x kennt keine Basic Auth mehr. Das Login ist der Owner-Account, der
  beim ersten Aufruf einmalig im Browser angelegt wird.
- Optionales gemeinsames Geheimnis: `N8N_WEBHOOK_TOKEN` geht als Header `x-kuronami-token`
  mit. In einer Umgebung, in der n8n weiter erreichbar ist, setzt man ihn und schaltet am
  Webhook-Knoten "Header Auth" scharf.

## Den Testworkflow einspielen

```
docker compose up -d n8n
# einmalig: Owner-Account unter http://127.0.0.1:5678 anlegen
docker compose exec n8n n8n import:workflow --input=/…/uppercase.json
# im Editor öffnen und aktivieren (Webhook „uppercase“ wird dann produktiv)
```

Danach ist `http://n8n:5678/webhook/uppercase` aktiv und `createN8nTools({ workflows:
[UPPERCASE_WORKFLOW] })` liefert das Tool `dev.uppercase`.
