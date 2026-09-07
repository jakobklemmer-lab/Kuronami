Hierhin gehört die Capability Surface: Tool-Router, Kern-Tools (`fs.*`, `web.*`, `exec.*`, `task.*`, `user.*`, `agent.*`), die n8n-Brücke und Subagenten-Definitionen. Keine Policy-Entscheidungen und keine Kanal-Normalisierung, die gehören in `policy/` beziehungsweise `gateway/`.

Seit S07 steht hier das Tor zu allen Seiteneffekten. `registry.ts` sammelt Tool-Definitionen und friert sie zu einem Katalog ein, dessen Version aus dem Inhalt abgeleitet wird; `router.ts` ruft ein Tool auf und liefert immer die einheitliche Rückgabehülle aus Abschnitt 9, auch im Fehlerfall; `offload.ts` lagert ein zu großes Ergebnis als Artefakt aus und gibt Zusammenfassung plus Handle zurück; `dummies.ts` enthält die zwei Prüf-Tools des Harness, die in keinen produktiven Katalog gehören.

Jeder Aufruf läuft durch die Ausführungshülle aus `runtime/steps/` und ist damit ein Schritt mit Checkpoint davor und danach. Die Policy-Engine kommt mit S11 hierher: der Router ruft sie, nicht umgekehrt (Abschnitt 4.7).
