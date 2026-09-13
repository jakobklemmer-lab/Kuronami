# Sprachschicht (Phase 9, S30 und S31)

Der eine Python-Prozess dieses Systems. Er nimmt Mikrofon-Audio an, macht Text daraus, schickt den
Text als Nachricht an das Gateway, lässt die Antwort sprechen — und hört auf zu reden, sobald der
Nutzer dazwischenredet.

Abschnitt 4.1 der Architektur nennt ihn ausdrücklich als **die** Ausnahme von "TypeScript auf
Node": Pipecat ist Python, und das bedeutet hier eine **Prozessgrenze, keinen zweiten Stack**. Er
teilt keinen Code mit `runtime/`, `tools/` oder `policy/`. Die einzige Verbindung ist HTTP an den
Sprach-Kanal des Gateways.

```
Browser / Messstand
   │  WebSocket: rohes PCM + JSON (voice/pipeline/protocol.py)
   ▼
┌─────────────────────────────────────────────────────────────┐
│ transport.input()   PCM aus dem Draht                        │
│   → VADProcessor    Silero: wer redet, seit wann             │
│   → STT             Deepgram          (live)                 │
│   → KuronamiBridge  Transkript → Gateway → Antwort, Barge-in │
│   → TTS             ElevenLabs        (live)                 │
│   → LatencyProbe    markiert das erste Audio-Byte            │
│   → transport.output()                                       │
└─────────────────────────────────────────────────────────────┘
   │  HTTP, Bearer VOICE_BRIDGE_TOKEN
   ▼
Gateway  POST /channels/voice/messages  ·  /channels/voice/answers
```

## Starten

```bash
docker compose --profile voice up voice      # der Dienst
docker compose run --rm voice-test           # 65 Tests
docker compose run --rm voice-bench          # der Messstand (S31)
```

Der Prozess **startet nicht**, wenn `VOICE_SESSION_TOKEN` oder `VOICE_BRIDGE_TOKEN` fehlen, und im
Live-Modus nicht ohne Deepgram- und ElevenLabs-Schlüssel. Das ist dieselbe Haltung wie im Gateway:
lieber in der ersten Zeile abbrechen als später schweigen. Alle Variablen stehen mit Begründung in
`.env.example`.

## Die zwei Betriebsarten

| | `VOICE_MODE=live` | `VOICE_MODE=loopback` |
|---|---|---|
| Erkennung | Deepgram | `LoopbackSTT` — liefert einen festen Text am Ende der Äußerung |
| Stimme | ElevenLabs | `LoopbackTTS` — ein Sinuston in Satzlänge |
| Rest | identisch | identisch |

Der Loopback ist ein **Messstand**, keine Attrappe für den Betrieb: Unterbrechbarkeit und Latenz
sind Eigenschaften des Graphen, und die sollen prüfbar sein, ohne für jede Wiederholung eine fremde
API zu bezahlen. Beim Start sagt der Prozess, in welchem Modus er läuft.

## Unterbrechen (S31)

Das VAD meldet "der Nutzer redet". Läuft gerade die Stimme **oder** ist ein Zug unterwegs, dessen
Antwort gleich gesprochen würde, ruft die Brücke `broadcast_interruption()`: der Ausgabepuffer des
Transports fällt weg, und die noch unterwegs befindliche Antwort wird verworfen, statt über den
Nutzer hinwegzureden.

**Unterbrechen heißt nicht abbrechen.** `runner.cancel()` schriebe `session.canceled` (S05), und
die Session der Sprachschicht ist dieselbe durchgehende Unterhaltung wie im Web und auf Telegram.
Dazwischenreden würde damit das Gespräch beenden statt es zu lenken. Der angestoßene Zug läuft im
Gateway zu Ende und steht dort im Protokoll — er wird nur nicht mehr vorgelesen.

## Freigaben per Stimme

Hält das Gateway an (`awaiting_user`), kommt die Frage mit ihren Optionen zurück; sie wird
vorgelesen, und die nächste Äußerung wird gegen die Optionen abgeglichen (`choices.py`) — ohne
Modell, ohne Raten. Kein Treffer heißt Nachfragen mit denselben Optionen. Eine Zustimmung, die
niemand gegeben hat, ist der teuerste denkbare Fehlgriff; deshalb steht die Verneinung in der
Abgleichreihenfolge ganz vorn ("nein, nicht genehmigen" ist keine Genehmigung).

## Die Messung und was sie bedeutet

Ein Sprachzug besteht aus fünf Stücken, und nur vier gehören dieser Schicht (siehe
`pipeline/latency.py`):

| Strecke | von → bis | gehört zu |
|---|---|---|
| `erkennung` | Ende des Sprechens → endgültiges Transkript | Deepgram |
| `bruecke` | Transkript → Anfrage am Gateway | dieser Schicht |
| `agent` | Anfrage → Antwort | dem Modell und seinen Werkzeugen |
| `uebergabe` | Antwort → Sprechauftrag | dieser Schicht |
| `stimme` | Sprechauftrag → erstes Audio-Byte | ElevenLabs |

**Das Budget von 800 ms gilt für alles außer `agent`** (`voice_layer_ms` im Bericht). Die Denkzeit
des Agenten mit hineinzurechnen hieße, eine Eigenschaft des Modells als Eigenschaft dieser Schicht
auszugeben — und sie ließe sich durch keine Verbesserung hier drücken. Ausgewiesen wird sie
trotzdem: vier Sekunden Antwortzeit sind für ein Gespräch eine schlechte Nachricht, auch wenn sie
nicht hierher gehören.

### Gemessen am 13.09.2026 (loopback, Energie-VAD, Backend-Doppel mit 1,5 s Denkzeit, 5 Läufe)

| | min | median | max |
|---|---|---|---|
| Sprachschicht (Budget 800 ms) | 1,08 ms | 1,22 ms | 1,86 ms |
| Gesamt inkl. Agent | 1502,7 ms | 1503,1 ms | 1505,6 ms |
| Barge-in (Reden bis Stille, beim Hörer) | 137,8 ms | 140,3 ms | 175,7 ms |

Die Barge-in-Zahl ist eine **echte End-zu-End-Zahl**: gemessen vom ersten lauten Block, den der
Client schickt, bis zum letzten Audio-Block, der bei ihm ankommt. Sie hängt an keinem Anbieter —
VAD, Unterbrechung, Puffer und Draht sind dieselben wie im Betrieb.

### Was unbelegt bleibt

* **Deepgram und ElevenLabs sind verdrahtet, aber nie gerufen worden.** Es gibt keine Schlüssel
  (`.env` trägt bis heute nicht einmal `ANTHROPIC_API_KEY`). Nachgewiesen ist, dass die beiden
  Dienste im Graphen stehen und er mit ihnen baut (`tests/test_app.py`) — nicht, wie schnell sie
  antworten. Die Strecken `erkennung` und `stimme` messen oben die Stand-ins.
* **Sileros Rechenzeit je 32-ms-Block** steckt nicht in den Zahlen: der Messstand nutzt den
  Energie-Detektor, weil Silero synthetischen Ton zu Recht nicht für Stimme hält (nachgeprüft:
  Sinus, Rauschen und ein Formantengemisch sind alle drei `QUIET`). Die Zeitzählung ist identisch,
  die Blockgröße auch.
* **Mit Schlüsseln ist die echte Messung eine Umgebungsvariable entfernt:** `VOICE_MODE=live`
  gesetzt, derselbe Messstand, dieselbe Rechnung.

## Dateien

| Datei | Inhalt |
|---|---|
| `pipeline/app.py` | baut den Graphen und fährt ihn |
| `pipeline/config.py` | die einzige Stelle, die die Umgebung liest |
| `pipeline/protocol.py` | das Draht-Protokoll (rohes PCM + JSON) |
| `pipeline/bridge.py` | Transkript → Gateway → Stimme, Barge-in, Freigaben |
| `pipeline/gateway.py` | der HTTP-Client zum Sprach-Kanal |
| `pipeline/services.py` | Deepgram/ElevenLabs und ihre Stand-ins, die Messsonde |
| `pipeline/vad.py` | der Energie-Detektor für den Messstand |
| `pipeline/choices.py` | gesprochene Antwort → `choice_id` |
| `pipeline/latency.py` | die Messpunkte eines Zugs |
| `bench/measure.py` | der Messstand (S31) |

Die Gegenstelle in TypeScript: `gateway/channels/voice/channel.ts` (der Kanal),
`gateway/identity.ts` (`authenticateVoice`), `ui/voice/` (der Client der Oberfläche).
