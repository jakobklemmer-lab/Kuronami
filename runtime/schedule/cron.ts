/**
 * Ein winziger Cron-Parser. **Ohne Bibliothek und bewusst klein** — dieselbe Disziplin wie
 * beim Glob in `policy/rules.ts` und beim JSON-Schema in `tools/types.ts`: was fehlt, fehlt
 * sichtbar und lässt sich nachrüsten, wenn ein echter Zeitplan es braucht.
 *
 * **Stand S19 liegt diese Datei in `runtime/` und nicht mehr in `heartbeat/`.** Ein
 * Cron-Ausdruck ist seit der Agenten-Registry nicht mehr nur die Einstellung des
 * Heartbeat-Dienstes, sondern eine **Eigenschaft eines Agenten** (`kuronami.agents.schedule`),
 * und `agent.create` prüft ihn beim Anlegen — aus demselben Grund, aus dem `heartbeatConfigFromEnv`
 * ihn beim Start prüft: ein kaputter Ausdruck soll sofort auffallen und nicht später stumm nie
 * feuern. `tools/agent/` darf aber nichts aus `heartbeat/` importieren (Abschnitt 3, harte
 * Regel; geprüft in `heartbeat/layering.test.ts`). Ein zweiter Parser daneben wäre eine zweite
 * Wahrheit über dieselbe Form; also ist der eine dorthin gewandert, wo beide Seiten ihn
 * erreichen. `heartbeat/` importiert ihn von hier, die Richtung stimmt.
 *
 * Fünf Felder (`m h dom mon dow`), Minutengranularität. Je Feld: `*`, `*​/n`, `a-b`, `a-b/n`,
 * `a,b,c`, eine Zahl. **Nicht** unterstützt: Namen (`MON`, `JAN`), `?`, `L`/`W`/`#`,
 * Sekundenfeld, Jahresfeld. Ein Ausdruck mit so etwas wirft beim Parsen, statt still etwas
 * anderes zu tun.
 *
 * `dow`: 0–6, 0 ist Sonntag (7 wird als Sonntag akzeptiert). Sind `dom` **und** `dow` beide
 * eingeschränkt, feuert der Ausdruck, wenn **eines von beiden** passt — das ist das
 * Standardverhalten von Vixie-Cron, und ein `0 7 * * *` (nur Uhrzeit) ist davon nicht betroffen.
 */

export class CronParseError extends Error {}

interface CronField {
  /** true, wenn das Feld `*` war — für die dom/dow-Sonderregel. */
  wildcard: boolean;
  matches(value: number): boolean;
}

export interface CronExpr {
  readonly source: string;
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

function parseField(raw: string, min: number, max: number, label: string): CronField {
  const allowed = new Set<number>();
  let wildcard = false;

  for (const part of raw.split(",")) {
    if (part.length === 0) {
      throw new CronParseError(`Cron-Feld ${label}: leerer Listeneintrag in "${raw}"`);
    }

    const [rangePart, stepPart] = part.split("/");
    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step <= 0) {
        throw new CronParseError(
          `Cron-Feld ${label}: Schrittweite "${stepPart}" ist keine positive Zahl`,
        );
      }
    }

    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
      if (stepPart === undefined) wildcard = true;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(rangePart);
      hi = lo;
    }

    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      throw new CronParseError(`Cron-Feld ${label}: "${part}" ist kein gültiger Bereich`);
    }
    // dow 7 == Sonntag == 0.
    if (label === "dow") {
      if (lo === 7) lo = 0;
      if (hi === 7) hi = 0;
    }
    if (lo < min || hi > max || lo > hi) {
      throw new CronParseError(
        `Cron-Feld ${label}: "${part}" liegt außerhalb von ${min}-${max} oder ist rückwärts`,
      );
    }
    for (let value = lo; value <= hi; value += step) allowed.add(value);
  }

  return { wildcard, matches: (value: number) => allowed.has(value) };
}

/** Zerlegt einen Cron-Ausdruck. Wirft `CronParseError` bei allem, was nicht der Form entspricht. */
export function parseCron(source: string): CronExpr {
  const fields = source.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronParseError(
      `Cron-Ausdruck "${source}" hat ${fields.length} Felder, erwartet werden fünf (m h dom mon dow)`,
    );
  }
  const [m, h, dom, mon, dow] = fields;
  return {
    source: source.trim(),
    minute: parseField(m, 0, 59, "minute"),
    hour: parseField(h, 0, 23, "hour"),
    dayOfMonth: parseField(dom, 1, 31, "dom"),
    month: parseField(mon, 1, 12, "mon"),
    dayOfWeek: parseField(dow, 0, 6, "dow"),
  };
}

/** Passt dieser Zeitpunkt (auf die Minute genau, lokale Zeit des Prozesses) auf den Ausdruck? */
export function cronMatches(expr: CronExpr, when: Date): boolean {
  if (!expr.minute.matches(when.getMinutes())) return false;
  if (!expr.hour.matches(when.getHours())) return false;
  if (!expr.month.matches(when.getMonth() + 1)) return false;

  const domOk = expr.dayOfMonth.matches(when.getDate());
  const dowOk = expr.dayOfWeek.matches(when.getDay());

  // Vixie-Cron: sind dom und dow beide eingeschränkt, reicht eines. Ist eines `*`, muss das
  // andere passen.
  if (expr.dayOfMonth.wildcard || expr.dayOfWeek.wildcard) return domOk && dowOk;
  return domOk || dowOk;
}

/** Bis wie weit zurück/vorwärts gesucht wird, in Minuten (400 Tage). Deckt jeden Jahresrhythmus. */
const SEARCH_LIMIT_MINUTES = 400 * 24 * 60;

function truncateToMinute(date: Date): Date {
  const copy = new Date(date.getTime());
  copy.setSeconds(0, 0);
  return copy;
}

/**
 * Der jüngste Feuerzeitpunkt, der **nicht nach** `now` liegt — oder `null`, wenn in den
 * letzten 400 Tagen keiner lag.
 *
 * Das ist der Baustein für "ist der heutige Digest fällig?": der Dienst vergleicht diesen
 * Zeitpunkt mit dem letzten tatsächlich gelaufenen Digest (aus dem Protokoll). So verpasst
 * ein Tick, der ein paar Minuten nach der vollen Stunde kommt, den Lauf nicht — und ein
 * Neustart um 9 Uhr holt den 7-Uhr-Digest desselben Tages nach.
 */
export function previousFireAtOrBefore(expr: CronExpr, now: Date): Date | null {
  const cursor = truncateToMinute(now);
  for (let i = 0; i < SEARCH_LIMIT_MINUTES; i += 1) {
    if (cronMatches(expr, cursor)) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() - 1);
  }
  return null;
}

/** Der nächste Feuerzeitpunkt **nach** `after`. Für die Startmeldung ("nächster Digest um …"). */
export function nextFireAfter(expr: CronExpr, after: Date): Date | null {
  const cursor = truncateToMinute(after);
  cursor.setMinutes(cursor.getMinutes() + 1);
  for (let i = 0; i < SEARCH_LIMIT_MINUTES; i += 1) {
    if (cronMatches(expr, cursor)) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}
