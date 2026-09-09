# Kalender-Tools über n8n (S15)

`cal.list`, `cal.create`, `cal.update` — Kalender-Zugriff über die n8n-Brücke aus S13
(`createN8nBridge`), injiziert wie das Backend von `web.search` und wie `mail.*` (S14). Loop,
Sessions, Checkpoints, Kontext und Governance bleiben in der Runtime; ein Workflow ist nur
ein HTTP-Eingang.

## Warum eigene Handler statt generischer `N8nWorkflowDef`

Dieselbe Lage wie bei `mail.*` (S14) und `web.fetch` (S09): der generische n8n-Handler reicht
`structured.body` unverändert durch. Der Auftrag von S15 verlangt für **lesende** Tools
"Zusammenfassung im Kontext, Volltext als Artefakt" — `cal.list` legt deshalb die vollständige
Terminliste (roh, mit allen Feldern) als Artefakt ab und lässt nur die ersten
`CAL_LIST_CONTEXT_MAX` (25) normalisierten Zeilen im Kontext. Jede Zeile wird aus einem festen
Satz Skalarfelder **neu** gebaut (`toEventRow`); ein `attendees`/`raw_ical`/`organizer_email`
aus dem Workflow findet strukturell keinen Weg in den Kontext.

## Schreiben pausiert immer

| Tool | Risikostufe | Verhalten |
| --- | --- | --- |
| `cal.list` | `read` | automatisch erlaubt, Volltext als Artefakt |
| `cal.create` | `hard_write` | pausiert für eine Freigabe, bevor der Termin entsteht |
| `cal.update` | `hard_write` | pausiert für eine Freigabe |

`cal.create`/`cal.update` nehmen weder `path` noch `url` entgegen — die Policy-Engine ordnet
sie als Ressource `none` ein, der Boden `floorFor("hard_write")` ist `ask`, und der Router
lässt den `ApprovalRequiredError` der Engine durch: der Lauf hält auf `awaiting_user`, der
n8n-Aufruf läuft **erst nach** der Freigabe. `repeatable: false` — ein zweiter Anlauf legte
einen zweiten Termin an bzw. wendete eine relative Verschiebung doppelt an (nur der
Workflow-Autor weiß, ob das sicher wäre; dieselbe Haltung wie `mail.draft`).

`CAL_WEBHOOKS` ist die vollständige, eingefrorene Liste der aufgerufenen Webhook-Pfade:
`cal-list`, `cal-create`, `cal-update`. Es gibt bewusst **keinen** Lösch-Pfad — `cal.delete`
wäre `destructive` und eine eigene, spätere Entscheidung.

## Vertrauensstellung

Kalenderinhalt wird als **vertrauenswürdig** behandelt (der eigene Kalender des Nutzers).
Fremde Meeting-Einladungen mit angreiferkontrolliertem Titel/Text sind ein bekannter, später
zu schließender Spalt — dieselbe Injection-Markierung, die `mail.*` bereits macht. Bewusst
nicht Teil von S15.

## Im Katalog

Die `cal.*`-Tools kommen in den ausgelieferten Katalog, sobald `N8N_BASE_URL` gesetzt ist
(`buildCatalog({ n8n: { cal: true } })`; `runtime/index.ts` schaltet das anhand der
Umgebung). Ohne n8n-Instanz bleibt der Fingerabdruck der aus S12/S13
(`v1-53a18ba0cb4e49c8`, 10 Tools).

## Workflows einspielen

`workflows/cal-list.json`, `cal-create.json`, `cal-update.json` sind importierbare n8n-2.x-
Workflows. Der Provider-Knoten ist jeweils **Google Calendar** (nur `getAll` bzw.
`create`/`update`); für CalDAV/Outlook den Provider-Knoten austauschen — die Ein- und
Ausgabeform der Code-Knoten bleibt. Wie beim Testworkflow aus S13 trägt jede Datei eine feste
`id`, weil `n8n import:workflow` in 2.x ohne `id` an `null value in column "id"` scheitert.

```
docker compose up -d n8n
docker compose exec n8n n8n import:workflow --input=/…/cal-list.json
# im Editor die Google-Credentials setzen und den Workflow aktivieren
```

Ein-/Ausgabeverträge:

- **cal-list** rein `{ start, end, calendar?, limit? }` (ISO 8601) → raus `{ events: [{ id,
  title, start, end, all_day, location, calendar, status, description }] }`.
- **cal-create** rein `{ title, start, end, location?, description?, calendar?, attendees? }`
  → raus `{ event_id, html_link, calendar, created }`.
- **cal-update** rein `{ event_id, title?, start?, end?, location?, description?, calendar? }`
  → raus `{ event_id, html_link, calendar, updated }`.
