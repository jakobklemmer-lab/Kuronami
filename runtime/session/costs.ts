import type { Pool } from "pg";
import {
  type AgentDaySpend,
  type SessionEvents,
  type SpendTotals,
  deriveAgentDaySpend,
  sumSpend,
} from "../../context/costs.js";
import { readEvents } from "../events/log.js";
import { PRICING_AS_OF } from "../model/pricing.js";

/**
 * Die Datenbankseite des Kosten-Trackings (S28): welche Sessions gelesen werden müssen, damit
 * `deriveAgentDaySpend` (`context/costs.ts`) daraus Tagesausgaben falten kann.
 *
 * Ausgewählt wird über die **Ereignisse**, nicht über das Anlegedatum der Session: ein langer
 * Gateway-Faden kann vor Wochen begonnen haben und heute Geld kosten. Eine Auswahl nach
 * `sessions.created_at` — wie sie `listRuns` für seine Liste trifft — würde genau diesen Lauf
 * übersehen, und zwar unbemerkt.
 */

export const DEFAULT_SPEND_DAYS = 7;

/** Obergrenze, damit eine versehentlich große Anfrage nicht das ganze Protokoll faltet. */
export const MAX_SPEND_DAYS = 90;

export interface SpendReport {
  /** Tagesausgaben je Agent, neueste Tage zuerst. */
  days: AgentDaySpend[];
  totals: SpendTotals;
  /** Wie weit das Fenster zurückreicht (Tage). */
  windowDays: number;
  /** Stand der Preistabelle — eine Kostenzahl ohne Preisstand ist eine Behauptung ohne Datum. */
  pricingAsOf: string;
}

const SELECT_ACTIVE_SESSIONS_SQL = `
  SELECT DISTINCT session_id
  FROM kuronami.events
  WHERE created_at >= $1
`;

/**
 * Faltet die Tagesausgaben der letzten `days` Tage.
 *
 * Das Fenster beginnt an der lokalen Tagesgrenze vor `days - 1` Tagen, nicht `days * 24` Stunden
 * vor jetzt: "die letzten sieben Tage" soll sieben ganze Kalendertage bedeuten und nicht sechs
 * plus zwei halbe. Dieselbe Zeitzonen-Konvention wie in `context/costs.ts` (lokale Zeit des
 * Prozesses, siehe die dortige Begründung).
 */
export async function listDailySpend(
  pool: Pool,
  days: number = DEFAULT_SPEND_DAYS,
): Promise<SpendReport> {
  const windowDays = Math.max(1, Math.min(MAX_SPEND_DAYS, Math.floor(days)));

  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (windowDays - 1));

  const found = await pool.query<{ session_id: string }>(SELECT_ACTIVE_SESSIONS_SQL, [since]);

  const sessions: SessionEvents[] = [];
  for (const row of found.rows) {
    sessions.push({ sessionId: row.session_id, events: await readEvents(pool, row.session_id) });
  }

  // Die Faltung sieht auch Ereignisse außerhalb des Fensters (eine ausgewählte Session wird ganz
  // gelesen, weil `agent.returned` und der bezahlte Aufruf nicht am selben Tag liegen müssen).
  // Herausgegeben wird trotzdem nur das Fenster — sonst stünde in einer Sieben-Tage-Ansicht ein
  // Tag von vor einem Monat.
  const sinceDay = dayKeyOf(since);
  const all = deriveAgentDaySpend(sessions);
  const withinWindow = all.filter((entry) => entry.day >= sinceDay);

  return {
    days: withinWindow,
    totals: sumSpend(withinWindow),
    windowDays,
    pricingAsOf: PRICING_AS_OF,
  };
}

function dayKeyOf(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}
