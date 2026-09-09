# Mail-Tools über n8n (S14)

`mail.search`, `mail.read`, `mail.draft` — die ersten Assistenz-Tools über n8n (Abschnitt
4.8). Transport ist die Brücke aus S13 (`createN8nBridge`), injiziert wie das Backend von
`web.search`. Loop, Sessions, Checkpoints, Kontext und Governance bleiben in der Runtime; ein
Workflow ist nur ein HTTP-Eingang.

## `mail.send` gibt es nicht

Das Fertig-Kriterium von S14 ist **"Entwurf entsteht, Senden ist technisch unmöglich"**. Das
steht an drei Stellen im Weg:

1. `createMailTools` liefert genau drei Definitionen. Keine heißt `mail.send`.
2. `MAIL_WEBHOOKS` ist die **vollständige, eingefrorene** Liste der n8n-Webhook-Pfade, die
   diese Schicht je aufruft: `mail-search`, `mail-read`, `mail-draft`. Kein Sende-Eintrag,
   und der einzige Ausgang nach n8n ist `deps.bridge.invoke` mit einem dieser drei Pfade.
3. `workflows/mail-draft.json` legt nur im Ordner „Drafts" ab (`draft:create` bzw.
   IMAP-`append`). Es gibt dort keinen `message:send`- und keinen SMTP-Knoten.

Der Test `tools/mail/tools.test.ts` hält beide Kriterien fest: der „ungelesene zusammenfassen
und drei Antworten entwerfen"-Lauf geht durch, und über den ganzen Lauf berührt die Brücke
**nur** `mail-search`/`mail-read`/`mail-draft` — nie einen Sende-Pfad.

## Warum eigene Handler statt generischer n8n-Workflows

S13 hatte angekündigt, S14 reiche `mail.*` als generische `N8nWorkflowDef`s durch. Das trägt
nicht: der generische Handler reicht `structured.body` unverändert durch. S14 verlangt drei
Formen, die nur ein tool-spezifischer Handler herstellt — dieselbe Lage, aus der `web.fetch`
einen eigenen Handler hat:

| Tool | Kontext | Artefakt |
| --- | --- | --- |
| `mail.search` | je Treffer **nur** Betreff, Absender, Datum, Kurzfassung (`MAIL_SEARCH_CONTEXT_MAX` Stück) | volle Kopfzeilen-Liste, **kein Volltext** |
| `mail.read` | normalisierte Kurzfassung (`excerpt`, `MAIL_READ_EXCERPT_MAX_CHARS`) + Kopfzeilen | Volltext wortgetreu; **jeder Anhang als eigenes Artefakt** |
| `mail.draft` | Bestätigung (`draft_id`, `mailbox`, `sent: false`) | — |

`mail.search` baut jede Kopfzeile aus einem festen Satz Skalarfelder **neu** auf — ein
`body`/`text`/`html` aus dem Workflow findet strukturell keinen Weg in die Ausgabe. „Nie
Volltext" ist damit eine Eigenschaft der Funktion, keine Zusage.

## Nicht vertrauenswürdig

Mailinhalt ist externer Inhalt (Abschnitt 4.7). `mail.search` und `mail.read` setzen
`structured.trust: "untrusted"`, beginnen `summary` mit `[nicht vertrauenswürdig ·
Mailinhalt]` und markieren Injection-Muster über `scanForInjection` (aus `web/normalize.ts`)
— **markiert, nicht entfernt**. Eine Anweisung aus einer Mail hebt nie eine Freigabe auf; ein
still gelöschtes Muster wäre ein verstecktes Signal.

Die **Bytes** von Volltext und Anhängen laufen nicht durch den Redaction-Filter (dieselbe
Grenze wie `web.fetch`-Rohbytes, S09): ein Muster über beliebige Bytes beschädigte die
SHA-256-Kette. Der Schutz greift an `summary`/`excerpt`/`injection_flags` — die gehen durch
Protokoll und Prompt-Aufbau, und beide filtern.

## Risikostufen

- `mail.search`, `mail.read` — `read` (Abschnitt 10: `mail.search` steht dort unter „Lesen").
- `mail.draft` — `soft_write` (Abschnitt 10: „Entwürfe erstellen" unter „Weiches Schreiben").
  Ohne Pfad greift keine Zonenregel, der Boden ist `allow` — ein Entwurf entsteht ohne
  Rückfrage. `repeatable: false`: ein zweiter Anlauf legte einen zweiten Entwurf an, deshalb
  wiederholt weder die Brücke noch die Ausführungshülle.

## Im Katalog

Die Mail-Tools kommen in den ausgelieferten Katalog, sobald `N8N_BASE_URL` gesetzt ist
(`buildCatalog({ n8n: { mail: true } })`; `runtime/index.ts` schaltet das anhand der
Umgebung). Ohne n8n-Instanz bleibt der Fingerabdruck der aus S12/S13
(`v1-53a18ba0cb4e49c8`, 10 Tools) — die Tools liefen sonst ohnehin nur in eine
`N8nUnavailableError`-Hülle.

## Workflows einspielen

`workflows/mail-search.json`, `mail-read.json`, `mail-draft.json` sind importierbare n8n-2.x-
Workflows. Der Provider-Knoten ist jeweils **Gmail** (nur lesende Operationen bzw.
`draft:create`); für IMAP/Outlook den Provider-Knoten austauschen — die Ein- und Ausgabeform
der Code-Knoten bleibt. Wie beim Testworkflow aus S13:

```
docker compose up -d n8n
docker compose exec n8n n8n import:workflow --input=/…/mail-search.json
# im Editor die Gmail-Credentials setzen und den Workflow aktivieren
```

Danach sind `http://n8n:5678/webhook/mail-search` usw. aktiv. Die Ein-/Ausgabeverträge:

- **mail-search** rein `{ query?, unread_only?, limit? }` → raus `{ messages: [{ id, subject,
  from, date, summary, unread }] }`.
- **mail-read** rein `{ id }` → raus `{ id, subject, from, to, date, body_text, body_html?,
  body_mime?, attachments: [{ filename, mime_type, content_base64 }] }`.
- **mail-draft** rein `{ to, subject, body, cc?, in_reply_to? }` → raus `{ draft_id, mailbox,
  created }`.
