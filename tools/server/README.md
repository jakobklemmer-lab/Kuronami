# Server-Tool über n8n (S15)

`server.metrics` — aktuelle Server-Kennzahlen (CPU, RAM, Disk, Load, Uptime u. a.) aus
**derselben Quelle wie das bestehende Dashboard** (Abschnitt 4.1). Transport ist die
n8n-Brücke aus S13; die Tool-Semantik steht in `tools/server/`.

## Warum ein eigener Handler

Wie `cal.list` und `mail.*`: der generische n8n-Handler reicht `structured.body` unverändert
durch, der Auftrag von S15 verlangt für lesende Tools aber "Zusammenfassung im Kontext,
Volltext als Artefakt". `server.metrics` legt den vollständigen Kennzahlen-Block als Artefakt
ab und lässt nur eine knappe, aus bekannten Feldern synthetisierte Zusammenfassung plus
Handle im Kontext:

- `recognize()` zieht `host`, `cpu_percent`, `memory_percent`, `disk_percent`, `load1` und
  `uptime_seconds` aus einem Block mit unbekannter, aber flacher Form (mehrere Feldnamen je
  Kennzahl).
- Sind keine bekannten Felder da, fällt `summary` auf "N Feld(er): …" zurück (wie der
  generische n8n-Handler).

`server.metrics` ist `read` — automatisch erlaubt, keine Freigabe. `SERVER_WEBHOOKS` ist die
vollständige, eingefrorene Pfadliste: nur `server-metrics`.

## Im Katalog

Kommt in den Katalog, sobald `N8N_BASE_URL` gesetzt ist (`buildCatalog({ n8n: { server: true
} })`; `runtime/index.ts` schaltet das anhand der Umgebung).

## Workflow einspielen

`workflows/server-metrics.json` ist ein importierbarer n8n-2.x-Workflow. Der
Postgres-Knoten darin ist ein **Platzhalter**: die konkrete Abfrage hängt an der Schema-Form
des bestehenden Dashboards (`public.*`) und wird beim Einrichten gesetzt. Alternativ ein
HTTP-Request-Knoten auf den Metrik-Endpunkt des Dashboards. Feste `id` wie bei den anderen
Workflows (n8n 2.x, sonst `null value in column "id"`).

Ein-/Ausgabevertrag:

- **server-metrics** rein `{ window? }` → raus ein **flaches** JSON-Objekt mit `host`,
  `cpu_percent`, `memory_percent`, `disk_percent`, `load1`, `uptime_seconds` und beliebigen
  weiteren Feldern. Prozentwerte als Zahl (0–100).
