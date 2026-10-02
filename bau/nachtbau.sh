#!/usr/bin/env bash
# Der Nachtbau (2026-09-27): arbeitet bau/PLAN.md Aufgabe für Aufgabe ab — nachts, allein, auch
# wenn niemand ein Terminal offen hat. Jakob hat ihn am 27.09. ausdrücklich freigegeben, als root
# auf diesem Server. Gestartet vom Timer kuronami-nachtbau.timer (00:30 Wien); von Hand:
#   systemctl start kuronami-nachtbau   ·   Protokoll: bau/protokoll/<Tag>.log
#
# Je Aufgabe ein eigener Claude-Code-Lauf (frischer Kontext = billiger) im Worktree
# /opt/kuronami-nachtbau. Modell nach der Zeile „Modell:" der Aufgabe: `opus` → Opus 5.5 (der Bau
# von Kuro OS), sonst Sonnet 5.5 — Jakob am 02.10., die Aufgaben schreibt dafür Claude im Tag genau
# vor. Unteragenten laufen mit demselben Modell. Übernommen wird nur, was Tests und Typecheck
# besteht; danach Neustart des Gateways und Gesundheitsprüfung — startet er nicht, wird
# zurückgerollt.
#
# Stellschrauben in /opt/kuronami/.env (Vorgabe):
#   NACHTBAU=aus                   schaltet ihn ab
#   NACHTBAU_ENDE (08:00)          Wiener Uhrzeit: dann ist Schluss, auch für einen laufenden Lauf;
#                                  eine neue Aufgabe beginnt nur bis 45 Minuten davor
#   NACHTBAU_GRENZE_SITZUNG (85)   % Sitzungsfenster: darüber wartet er auf das nächste Fenster
#   NACHTBAU_GRENZE_WOCHE (85)     % Wochenfenster: darüber hört er auf, auch wenn die Nacht noch darf
#   NACHTBAU_AUFGABE_MIN (100)     Höchstdauer eines Laufs in Minuten
#
# Das Nachtbudget (02.10., `gateway/nachtbudget.ts`, gerechnet in `bau/grenze.ts`) macht beide
# Grenzen enger: je Nacht höchstens 10 Punkte des Wochenfensters über dem Stand zu Nachtbeginn —
# Nachtbau und Lehrgang zusammen —, und im Sitzungsfenster, das in Jakobs Morgen reicht, höchstens
# 30 %. Jakob: „Pro Nacht darf nur 10 % des Wochenlimits verbraucht werden."
set -uo pipefail

LIVE=/opt/kuronami
BAU=/opt/kuronami-nachtbau
ZWEIG=nachtbau
HAUPT=claude-code-motor
PROT="$LIVE/bau/protokoll"
export TZ=Europe/Vienna
export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin"
TAG=$(date +%F)
mkdir -p "$PROT"
LOGDATEI="$PROT/$TAG.log"

log() { echo "$(date +%H:%M:%S) $*" | tee -a "$LOGDATEI"; }
env_wert() { grep -E "^$1=" "$LIVE/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' ; }

if [[ "$(env_wert NACHTBAU)" == "aus" ]]; then log "NACHTBAU=aus — nichts zu tun."; exit 0; fi
exec 9>/run/kuronami-nachtbau.lock
flock -n 9 || { log "Läuft schon."; exit 0; }

ENDE=$(env_wert NACHTBAU_ENDE); ENDE=${ENDE:-08:00}
GS=$(env_wert NACHTBAU_GRENZE_SITZUNG); GS=${GS:-85}
GW=$(env_wert NACHTBAU_GRENZE_WOCHE); GW=${GW:-85}
MIN=$(env_wert NACHTBAU_AUFGABE_MIN); MIN=${MIN:-100}
# NACHTBAU_FREI=<Datum der Nacht, JJJJ-MM-TT>: Jakob hebt für genau diese Nacht alle Grenzen auf
# (Nachtbudget, 85 %); Schluss bleibt NACHTBAU_ENDE. Am nächsten Tag gilt es von selbst nicht mehr.
FREI=0
if [[ "$(env_wert NACHTBAU_FREI)" == "$TAG" ]]; then FREI=1; GS=98; GW=98; fi
PORT=$(env_wert PORT); PORT=${PORT:-3000}
# Fünf Testdateien laufen gegen Postgres. `vitest.setup.ts` lädt sonst die ganze `.env` — im
# Worktree gibt es keine, und dorthin gehört auch keine. Weitergereicht wird nur diese eine Zeile.
DATABASE_URL=$(env_wert DATABASE_URL); export DATABASE_URL
jetzt=$(date +%s)
HART=$(date -d "today $ENDE" +%s)
(( jetzt >= HART )) && HART=$(date -d "tomorrow $ENDE" +%s)
SCHLUSS=$(( HART - 45 * 60 ))
(( FREI == 1 )) && log "=== Jakob hat diese Nacht freigegeben: kein Nachtbudget, Grenzen 98 %."
log "=== Nachtbau beginnt, Schluss für neue Aufgaben $(date -d @"$SCHLUSS" '+%d.%m. %H:%M'), Ende $(date -d @"$HART" '+%H:%M'), Grenzen Sitzung $GS %, Woche $GW % (Nachtbudget: Woche +10, letztes Fenster 30 %)"

STAND=""; WARTE_BIS=0; GSE=$GS; GWE=$GW
# 0 = weiter, 1 = auf nächstes Sitzungsfenster warten (WARTE_BIS), 2 = Schluss
pruefe() {
  local zeile art s w sz wz gs gw letzt
  if (( $(date +%s) >= HART )); then STAND="Ende der Nacht ($ENDE)"; return 2; fi
  zeile=$(cd "$LIVE" && NACHTBAU_ENDE=$ENDE NACHTBAU_GRENZE_SITZUNG=$GS NACHTBAU_GRENZE_WOCHE=$GW NACHTBAU_OHNE_BUDGET=$FREI \
    timeout 90 npx --no-install tsx bau/grenze.ts 2>/dev/null | tail -1)
  read -r art s w sz wz gs gw letzt <<<"$zeile"
  if [[ "$art" != "ok" || -z "${gw:-}" ]]; then STAND="Abo-Stand nicht lesbar ($zeile)"; return 2; fi
  GSE=$gs; GWE=$gw
  local morgen=""; [[ "$letzt" == "letztes" ]] && morgen=", Fenster reicht in den Morgen"
  STAND="Sitzung $s % (Grenze $gs$morgen), Woche $w % (Grenze $gw)"
  if (( w >= GWE )); then return 2; fi
  if (( s >= GSE )); then
    WARTE_BIS=$(( $(date -d "$sz" +%s) + 180 ))
    (( WARTE_BIS < SCHLUSS - 1800 )) && return 1
    return 2
  fi
  return 0
}

# Hat Kuro in den letzten 20 Minuten mit Jakob gesprochen? Dann kein Neustart, keine neue Aufgabe.
jakob_aktiv() {
  python3 - "$LIVE/workspace/verbrauch" <<'PY'
import datetime, glob, json, sys
grenze = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=20)
for f in sorted(glob.glob(sys.argv[1] + "/*.jsonl"))[-2:]:
    for zeile in open(f, encoding="utf-8"):
        try:
            d = json.loads(zeile)
            zeit = datetime.datetime.fromisoformat(d["zeit"].replace("Z", "+00:00"))
        except Exception:
            continue
        if d.get("wer") == "kuro" and d.get("kanal") and zeit > grenze:
            sys.exit(0)
sys.exit(1)
PY
}

bereite_vor() {
  if [[ ! -e "$BAU/.git" ]]; then
    git -C "$LIVE" worktree add -B "$ZWEIG" "$BAU" "$HAUPT" >>"$LOGDATEI" 2>&1 || return 1
  fi
  cd "$BAU" || return 1
  git reset -q --hard && git clean -qfd
  if ! git rebase -q "$HAUPT" >>"$LOGDATEI" 2>&1; then
    git rebase --abort 2>/dev/null
    log "Zweig $ZWEIG lässt sich nicht auf $HAUPT setzen — Konflikt, ich höre auf."
    return 1
  fi
  if [[ ! -d node_modules ]] || ! cmp -s pnpm-lock.yaml node_modules/.nachtbau-lock; then
    pnpm install --frozen-lockfile --prefer-offline >>"$LOGDATEI" 2>&1 || { log "pnpm install scheiterte."; return 1; }
    cp pnpm-lock.yaml node_modules/.nachtbau-lock
  fi
}

gruen() { (cd "$BAU" && pnpm test >>"$LOGDATEI" 2>&1 && pnpm typecheck >>"$LOGDATEI" 2>&1); }

gesund() {
  local i
  for i in $(seq 1 30); do
    sleep 3
    curl -sf -m 3 "http://127.0.0.1:$PORT/health" >/dev/null && return 0
  done
  return 1
}

setze_status() {  # im Worktree, als eigener Commit
  (cd "$BAU" && python3 "$LIVE/bau/naechste.py" --setze bau/PLAN.md "$1" "$2" \
    && git commit -q -am "Nachtbau $1: $2" -m "Co-Authored-By: Claude <noreply@anthropic.com>")
}

uebernimm() {  # $1 = Aufgabe; neue Commits auf nachtbau ins laufende System
  local id=$1 vorher neu warte
  neu=$(git -C "$BAU" rev-list --count "$HAUPT..$ZWEIG")
  (( neu == 0 )) && { log "$id: keine neuen Commits."; return 0; }
  if ! gruen; then
    local marke="nachtbau-rot-$TAG-$id"
    git -C "$BAU" tag -f "$marke" >/dev/null
    git -C "$BAU" reset -q --hard "$HAUPT"
    log "$id: Tests oder Typecheck rot — nicht übernommen, Stand unter Marke $marke."
    setze_status "$id" "blockiert (Tests rot nach dem Lauf vom $TAG, Marke $marke)"
    git -C "$LIVE" merge -q --ff-only "$ZWEIG" >>"$LOGDATEI" 2>&1   # nur der Status, kein Code
    return 1
  fi
  vorher=$(git -C "$LIVE" rev-parse HEAD)
  if ! git -C "$LIVE" merge -q --ff-only "$ZWEIG" >>"$LOGDATEI" 2>&1; then
    log "$id: Übernahme ins laufende System scheiterte (Arbeitsbaum?) — bleibt auf $ZWEIG."
    return 1
  fi
  # Nur neu starten, wenn Code betroffen ist, und nie mitten in Jakobs Gespräch.
  if git -C "$LIVE" diff --name-only "$vorher" HEAD | grep -qvE '^(bau/|docs/|.*\.md$)'; then
    warte=0
    while jakob_aktiv && (( warte < 6 )); do log "Jakob spricht mit Kuro — Neustart wartet."; sleep 300; warte=$((warte+1)); done
    systemctl restart kuronami-gateway
    git -C "$LIVE" diff --name-only "$vorher" HEAD | grep -q '^ui/' && systemctl restart kuronami-ui
    if gesund; then
      log "$id: übernommen ($neu Commits), Gateway gesund."
    else
      log "$id: Gateway startet nicht — rolle zurück."
      git -C "$LIVE" revert --no-edit "$vorher..HEAD" >>"$LOGDATEI" 2>&1
      systemctl restart kuronami-gateway
      gesund && log "Zurückgerollt, Gateway wieder gesund." || log "ACHTUNG: Gateway auch nach dem Zurückrollen nicht gesund."
      git -C "$BAU" reset -q --hard "$HAUPT"
      setze_status "$id" "blockiert (Gateway startete nach der Übernahme vom $TAG nicht, zurückgerollt)"
      git -C "$LIVE" merge -q --ff-only "$ZWEIG" >>"$LOGDATEI" 2>&1
      return 1
    fi
  else
    log "$id: übernommen ($neu Commits, nur Plan/Doku — kein Neustart)."
  fi
}


VERSUCHT=""
while :; do
  if (( $(date +%s) >= SCHLUSS )); then log "Ende des Nachtfensters."; break; fi
  pruefe; r=$?
  if (( r == 2 )); then log "Schluss: $STAND."; break; fi
  if (( r == 1 )); then
    log "$STAND — warte bis $(date -d @"$WARTE_BIS" +%H:%M) aufs nächste Sitzungsfenster."
    sleep $(( WARTE_BIS - $(date +%s) > 0 ? WARTE_BIS - $(date +%s) : 60 )); continue
  fi
  if jakob_aktiv; then log "Jakob spricht mit Kuro — 10 Minuten Pause."; sleep 600; continue; fi
  bereite_vor || break

  read -r ID MODELL <<<"$(python3 "$LIVE/bau/naechste.py" "$BAU/bau/PLAN.md" "$VERSUCHT")"
  if [[ -z "${ID:-}" ]]; then log "Keine Aufgabe bereit."; break; fi
  # Ohne genaue Anweisung (bau/aufgaben/<ID>.md) kein Lauf — Sonnet rät sonst (Jakob, 02.10.).
  if [[ ! -f "$BAU/bau/aufgaben/$ID.md" ]]; then
    log "$ID: keine Anweisung unter bau/aufgaben/$ID.md — übersprungen."
    VERSUCHT="$VERSUCHT,$ID"; continue
  fi
  if [[ "${MODELL,,}" == opus* ]]; then MODELL_ID=claude-opus-5-5; else MODELL_ID=claude-sonnet-5-5; fi
  VERSUCHT="$VERSUCHT,$ID"
  vorher_stand=$STAND
  log "--- $ID mit $MODELL_ID beginnt ($STAND)"

  AUFTRAG=$(sed "s/{AUFGABE}/$ID/g" "$LIVE/bau/auftrag.md")
  ( cd "$BAU" && ENABLE_CLAUDEAI_MCP_SERVERS=false CLAUDE_CODE_SUBAGENT_MODEL=$MODELL_ID exec timeout --signal=INT --kill-after=120 "$((MIN * 60))" \
      claude -p "$AUFTRAG" --model "$MODELL_ID" --permission-mode auto \
        --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
        --settings '{"enabledPlugins":{"hyperframes@claude-plugins-official":false}}' \
        --output-format stream-json --verbose ) >"$PROT/$TAG-$ID.jsonl" 2>>"$LOGDATEI" &
  PID=$!
  tick=0; abgebrochen=0
  while kill -0 "$PID" 2>/dev/null; do
    sleep 20; tick=$((tick + 1))
    (( tick % 15 == 0 )) || continue          # alle fünf Minuten
    kill -0 "$PID" 2>/dev/null || break
    pruefe; r=$?
    if (( r != 0 )); then
      log "Wächter: $STAND — beende $ID."
      pkill -INT -P "$PID" 2>/dev/null; kill -INT "$PID" 2>/dev/null; sleep 60
      pkill -TERM -P "$PID" 2>/dev/null; kill -TERM "$PID" 2>/dev/null
      abgebrochen=1; break
    fi
  done
  wait "$PID" 2>/dev/null; rc=$?
  schluss=$(python3 - "$PROT/$TAG-$ID.jsonl" <<'PY'
import json, sys
text = ""
for z in open(sys.argv[1], encoding="utf-8", errors="replace"):
    try:
        d = json.loads(z)
    except Exception:
        continue
    if d.get("type") == "result":
        text = (d.get("result") or d.get("subtype") or "").strip()
print(" ".join(text.split())[:900])
PY
)
  wie=""; (( abgebrochen == 1 )) && wie=", vom Wächter"
  log "$ID beendet (Code $rc$wie): ${schluss:-ohne Zusammenfassung}"
  # Halbfertiges ohne Commit verwerfen — Committetes bleibt.
  (cd "$BAU" && git reset -q --hard && git clean -qfd)
  (( abgebrochen == 1 )) && VERSUCHT=${VERSUCHT%,"$ID"}   # nach dem Warten noch einmal
  uebernimm "$ID"
  pruefe >/dev/null; log "Verbrauch für $ID: vorher $vorher_stand, nachher $STAND"
done

# Für Kuro und für Jakob am Morgen: eine kurze Notiz, was in der Nacht geschah.
mkdir -p "$LIVE/workspace/notizen"
{
  echo "# Nachtbau vom $(date '+%d.%m.%Y')"
  echo
  # Beginnt die Nacht vor Mitternacht, stehen die Berichte in zwei Dateien.
  berichte="bau/berichte/$TAG.md"
  [[ "$(date +%F)" != "$TAG" ]] && berichte="$berichte und bau/berichte/$(date +%F).md"
  echo "Stand am Ende: $STAND. Bericht für Jakob: $berichte (im Quellbaum /opt/kuronami)."
  echo
  grep -E " (--- |beendet|übernommen|blockiert|Schluss|Wächter|zurück|ACHTUNG)" "$LOGDATEI" | tail -40
} > "$LIVE/workspace/notizen/nachtbau.md"
log "=== Nachtbau Ende."
