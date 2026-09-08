Die zwei Web-Kern-Primitive `web.search` und `web.fetch` (S09, Abschnitt 9). Sie laufen über
`tools/router.ts` und damit durch die Ausführungshülle aus `runtime/steps/` — Checkpoint
davor und danach, Idempotenzschlüssel, Zeitfenster.

`egress.ts` ist der harte Riegel und steht bewusst getrennt, mit einer eigenen Testdatei
ohne Datenbank (Muster von `tools/fs/paths.ts`). `buildEgressPolicy` + `assertEgressAllowed`
prüfen **deny-by-default**: nur `http`/`https`, keine Zugangsdaten in der URL, keine
lokalen/privaten/Loopback/Link-Local-Adressen, und der Host muss auf der Allowlist stehen
(ein Eintrag deckt seine Subdomains mit ab, aber nur auf Punktgrenze). Die Allowlist kommt
aus `WEB_EGRESS_ALLOWLIST`; ist sie leer, ruft `web.*` nichts ab. `web.fetch` folgt
Weiterleitungen **von Hand** (`followWithGuardedRedirects`, `redirect: "manual"`, höchstens
5 Sprünge) und schickt jede Zwischenadresse erneut durch `assertEgressAllowed` — ein `302`
auf eine interne Adresse wird abgewiesen, nicht verfolgt. **Nicht** gebaut: die IP-Prüfung
nach der DNS-Auflösung (DNS-Rebinding) — dokumentierte Grenze.

`normalize.ts` sind zwei reine Funktionen ohne Datenbank: `normalizeContent` macht aus
rohem HTML eine knappe, tag-freie Fassung (script/style/Kommentare raus, Blockgrenzen zu
Zeilenumbrüchen, Entities dekodiert), `scanForInjection` sucht bekannte
Prompt-Injection-Muster (Deutsch und Englisch, dazu versteckte Steuerzeichen) und gibt sie
als Fundstellen zurück — **es entfernt nichts**.

`tools.ts` baut die zwei Definitionen und Handler. Die drei tragenden Zusagen:

1. **Rohinhalt und normalisierte Fassung sind strikt getrennt.** Der Rohinhalt geht immer
   und ausschließlich ins Artefakt (`readArtifact` gibt ihn bytegleich zurück); in den
   Kontext geht nur `structured.excerpt` (bei `web.fetch`) bzw. die knappe Trefferliste (bei
   `web.search`). Die vollständige Trefferliste liegt ebenfalls als Artefakt bei.
2. **Abgerufener Inhalt ist nicht vertrauenswürdig** — `structured.trust: "untrusted"`, die
   `summary` beginnt mit einer Markierung, Injection-Muster stehen in
   `structured.injection_flags` (Muster-Kennung, gekürzter Ausriss, Offset), der Text bleibt
   unangetastet.
3. **Egress-Allowlist, Zeitfenster (20 s), Größenbegrenzung (5 MiB).** Die Größengrenze
   bricht den Download ab, bevor ein Artefakt entsteht.

Die **Bytes** eines abgerufenen Inhalts laufen nicht durch den Redaction-Filter (dieselbe
bewusste Grenze wie bei Artefaktbytes seit S07 und `fs.read`-Rohbytes seit S08). Der Schutz
greift am `excerpt`: der geht über `appendEventInTx` und `buildPrompt` und wird dort
gefiltert.

`web.search` braucht ein injiziertes Backend (`WebSearchBackend`). Ohne eins ist das Tool
registriert, aber nicht bedienbar und meldet eine Fehlerhülle — der Anbieter wird später
verdrahtet (n8n-Bridge, S13).
