# gateway — Surface / Protokoll

Die Kanal-Normalisierung: Web, Telegram, später Mail und Sprache. **Eigener Prozess**
(`pnpm gateway`), nicht in die Runtime eingebaut.

**Harte Regel (Architektur, Abschnitt 3):** Die Runtime darf niemals von dieser Schicht
abhängen. Es gibt keinen Import aus `gateway/` in `runtime/`, `context/`, `tools/` oder
`policy/` — `layering.test.ts` liest die Quellen und prüft das. Umgekehrt ist erlaubt und
gewollt: das Gateway benutzt die Runtime als Bibliothek.

**Was hier nicht liegt:** Ausführungs- und Zustandslogik. Was ein Zug tut, entscheidet der
Loop (S12); ob ein Aufruf durchgeht, die Policy-Engine (S11); was wiederholbar ist, die
Ausführungshülle (S05). Das Gateway ordnet zu — Nachricht → Unterhaltung → Zug, und
Rückfrage → Kanal → Antwort → derselbe Zug.

## Die drei Entscheidungen

### 1. Ein Nutzer, ein Gedächtnis — die Session läuft auf dem Kanal `gateway`

Das Gedächtnis einer Unterhaltung ist ihr Ereignisprotokoll, und das ist je Session geführt
(S03). Damit Web und Telegram dasselbe Gedächtnis haben, müssen beide in **dieselbe** Session
schreiben. Eine Session wird über `(thread_id, channel)` wiedergefunden (UNIQUE seit S04) —
also folgt der Faden aus der **Nutzerkennung** (`thread_user_<id>`) und der Kanal ist die
Konstante `gateway` (Migration 0008).

Der Kanal der einzelnen **Nachricht** steht damit nicht mehr in der Session, sondern im
`gateway.received`-Ereignis. Das ist die richtige Stelle: er ändert sich je Nachricht, die
Session nicht.

### 2. Authentifizierung am Gateway, nicht in der Runtime

Die Runtime hat kein Feld, keinen Parameter und keine Tabelle für "wer war das". Sie kennt
eine Session, und dass dahinter ein berechtigter Mensch steht, ist entschieden, bevor
irgendetwas aus `runtime/` gerufen wird.

Erzwungen über den Typ, wie die `PolicyGrant` in S11: `receiveMessage`/`receiveDecision`
verlangen einen `Principal`, und den stellt allein `identity.ts` aus. Ein Objektliteral kann
keinen Nutzer vortäuschen.

* **Web** — Bearer-Token (`GATEWAY_WEB_TOKEN`), Vergleich in konstanter Zeit.
* **Telegram** — **zwei** Prüfungen: das Webhook-Geheimnis beweist, dass das Update von
  Telegram kommt, nicht *von wem*. Jeder Mensch kann dem Bot schreiben, und sein Update trägt
  dasselbe gültige Geheimnis. Deshalb zusätzlich `TELEGRAM_ALLOWED_USER_IDS`. Beim
  Long-Polling entfällt die erste Prüfung (kein Header), die zweite trägt dort allein.

### 3. Freigabeanfragen gehen an den passenden Kanal — aus dem Protokoll, nicht aus einer Map

Der passende Kanal ist der, über den zuletzt etwas hereinkam, bevor der Lauf anhielt. Eine
`Map<askId, channel>` im Speicher wäre genau so lange richtig, bis das Gateway neu startet:
danach stünde eine offene Rückfrage da, zu der niemand mehr wüsste, wohin sie gehört.

Also `deriveAskRoutes(events)` — eine reine Funktion über Ereignisse, wie
`deriveSessionState` (S05) und `deriveLoopState` (S12). Möglich durch zwei Ereignistypen:

* `gateway.received` trägt Kanal und Absender jeder Nachricht **und jeder Entscheidung**.
  Auch eine Entscheidung verschiebt die Herkunft: wer per Telegram entscheidet, bekommt die
  nächste Rückfrage desselben Laufs ebenfalls per Telegram.
* `gateway.delivered` hält fest, was schon hinausging — sonst schickte ein Neustart jede
  offene Rückfrage erneut. `redeliverPending` beim Start holt nach, was nie ankam.

## Die normalisierte Nachrichtenform

`types.ts`, fünf Felder aus dem Auftrag plus eine Kennung:

| Feld | |
| --- | --- |
| `channel` | `web` \| `telegram` |
| `sender` | `channelUserId` (Authentifizierung) und `replyTo` (Zustellung) getrennt — im Telegram-Einzelchat gleich, in einer Gruppe nicht |
| `content` | Text |
| `attachments` | bereits als Bytes; der Kanal löst seine `file_id` selbst ein |
| `receivedAt` | |
| `externalId` | Kennung des Kanals. Ein erneut zugestelltes Update wird daran erkannt (`hasReceived`) und löst keinen zweiten Zug aus |

Anhänge werden **Artefakte** (S06), nicht Text im Prompt: in den Zug geht das
`artifact://`-Handle plus eine Zeile Beschreibung. Herkunft `gateway:web` bzw.
`gateway:telegram` mit `step_id: null` — der erste Fall, für den S06 das Feld nullbar
angelegt hat, weil ein Anhang vor jedem Schritt entsteht.

## Prozess und Endpunkte

```
pnpm gateway                          # Prozess starten (Port GATEWAY_PORT, Vorgabe 8788)
pnpm say "Was steht heute an?"        # die umgehängte Prompt-Zeile, über den Web-Kanal
pnpm say --pending                    # offene Rückfragen
pnpm say --answer <ask_id> <option>   # eine Rückfrage beantworten
```

| Endpunkt | |
| --- | --- |
| `POST /channels/web/messages` | Nachricht. Bearer-Token. Antwortet mit dem Ausgang und allem, was währenddessen zugestellt wurde |
| `POST /channels/web/answers` | Entscheidung zu einer offenen Rückfrage |
| `GET /channels/web/outbox` | holt ab, was außerhalb eines Aufrufs zugestellt wurde, und leert das Fach |
| `GET /channels/web/pending` | was offen ist — aus dem **Protokoll** gefaltet, übersteht also einen Neustart |
| `POST /channels/telegram/webhook` | Update von Telegram. Header `X-Telegram-Bot-Api-Secret-Token` |
| `GET /health` | |

**Telegram läuft in der Vorgabe über Long-Polling**, weil das ohne öffentliche Adresse
auskommt. `TELEGRAM_MODE=webhook` schaltet es ab und erwartet Updates auf dem Endpunkt oben.
Beide Wege münden in dasselbe `handleUpdate` — der Umzug auf einen Server ist eine
Einstellung, keine Codeänderung.

### Warum `callback_data` eine kurze Referenz trägt

Telegram erlaubt einem Inline-Knopf **64 Byte** `callback_data`, sonst weist die API die
ganze Nachricht ab (`BUTTON_DATA_INVALID`) und die Freigabe käme nie an. Eine `ask_id` ist
`policy:<call_id>`, und `call_id` ist die `tool_use`-Kennung des Anbieters — heute rund
dreißig Zeichen, morgen so lang, wie der Anbieter will. Also geht `askRef(askId)` mit: die
ersten zwölf Hexstellen aus SHA-256. Zustandslos und stabil — `resolveAskRef` bildet sie für
jede offene Rückfrage neu und vergleicht, ein Knopf von vorhin funktioniert auch nach einem
Neustart.

## Einrichten

1. `.env` füllen: `GATEWAY_USER_ID`, `GATEWAY_WEB_TOKEN`, und für Telegram
   `TELEGRAM_BOT_TOKEN` plus `TELEGRAM_ALLOWED_USER_IDS`.
2. Bot bei `@BotFather` anlegen (`/newbot`), Token übernehmen.
3. Die eigene Telegram-Kennung: dem Bot schreiben und `pnpm gateway` beobachten — ein
   abgewiesener Absender steht mit seiner Kennung in der Prozessausgabe. Sie in
   `TELEGRAM_ALLOWED_USER_IDS` eintragen und neu starten.
4. Für den Webhook-Betrieb zusätzlich `TELEGRAM_WEBHOOK_SECRET` setzen,
   `TELEGRAM_MODE=webhook`, und bei Telegram `setWebhook` mit `secret_token` registrieren.

## Was hier (noch) nicht steht

* **Mail und Sprache** als Kanäle. Die Form steht (`ChannelPort`), die Kanäle sind S23/S24
  bzw. später.
* **Mehr als ein Nutzer.** Phase 3 hat einen. Ein zweiter wäre eine Tabelle statt einer
  Konstanten in `identity.ts` und sonst keine Änderung an diesem Aufbau; ihn jetzt zu bauen
  hieße, eine ungeprüfte Vermutung darüber festzuschreiben, wie er aussehen müsste.
* **Der Heartbeat** (S17). Er wird über denselben Weg zustellen — `ChannelPort` reicht dafür,
  und `gateway.delivered` hält fest, was hinausging.
