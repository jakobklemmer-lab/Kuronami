/**
 * Die Risikostufen aus Abschnitt 10 und der Boden, den sie setzen.
 *
 * Sie stehen hier und nicht in `tools/types.ts`, wo sie bis S10 lagen: `policy/README.md`
 * weist die Risikostufen ausdrücklich der Governance-Schicht zu, und die Engine hängt an
 * ihnen mehr als der Toolkatalog. `tools/types.ts` re-exportiert den Typ weiter, damit die
 * Tool-Definitionen unverändert bleiben — die Richtung ist damit `tools → policy`, wie
 * Abschnitt 4.7 sie vorgibt ("Der Tool-Router ruft die Policy-Engine, nicht umgekehrt").
 */

/** Entspricht `kuronami.risk_level` aus Migration 0001, in aufsteigender Schärfe. */
export const RISK_LEVELS = ["read", "soft_write", "hard_write", "destructive"] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Ein Tool ohne (gültige) Risikostufe. */
export class RiskLevelError extends Error {}

/**
 * **Kein Tool ohne Zuordnung.** Das steht im Auftrag von S11 und wird an zwei Stellen
 * geprüft: in der Registry, wenn ein Tool aufgenommen wird, und in der Engine, bevor eine
 * Entscheidung fällt. Zwei Tore, weil TypeScript nur das erste absichert — ein Tool, das
 * aus JSON entsteht (n8n-Bridge, S13), kommt am Compiler vorbei, aber nicht an der Engine.
 * Und die Engine antwortet auf eine fehlende Stufe nicht mit einer Vorgabe: eine geratene
 * Stufe wäre schlimmer als keine, weil sie nach einer Entscheidung aussieht.
 */
export function assertRiskLevel(value: unknown, context: string): asserts value is RiskLevel {
  if (typeof value !== "string" || !(RISK_LEVELS as readonly string[]).includes(value)) {
    throw new RiskLevelError(
      `${context}: Risikostufe "${String(value)}" ist keine der vier aus Abschnitt 10 (${RISK_LEVELS.join(", ")}). Jedes Tool bekommt eine Stufe; ohne Zuordnung wird nicht ausgeführt.`,
    );
  }
}

export function riskRank(level: RiskLevel): number {
  return RISK_LEVELS.indexOf(level);
}

/** Die schärfere der beiden Stufen. Eine Regel kann anheben, nie senken (siehe `rules.ts`). */
export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return riskRank(a) >= riskRank(b) ? a : b;
}

/**
 * Der Geltungsbereich einer Freigabe (Auftrag S11: einmalig / Session / dauerhaft).
 *
 * `once` ist an den Aufruf gebunden und nicht an "die nächste Gelegenheit": eine Freigabe,
 * die der nächste beliebige Aufruf abgreifen kann, ist an einer Stelle wirksam, an der sie
 * niemand erteilt hat. Weil `call_id` stabil aus dem Plan folgt (S07), findet ein
 * wiederaufgenommener Lauf seine eigene Einmal-Freigabe wieder.
 */
export const APPROVAL_SCOPES = ["once", "session", "always"] as const;
export type ApprovalScope = (typeof APPROVAL_SCOPES)[number];

/**
 * Welche Geltungsbereiche eine Stufe überhaupt zulässt.
 *
 * Für `destructive` ist das ausschließlich `once`, und das ist die wörtliche Lesart der
 * Tabelle in Abschnitt 10: dort steht bei "Zerstörend" nicht "Freigabe nötig", sondern
 * **immer** Freigabe. Eine sessionweite oder dauerhafte Vorab-Erlaubnis hebt genau dieses
 * "immer" auf — Löschen, Migration und Produktivaktion würden danach ohne eine einzige
 * weitere Rückfrage laufen. Wer das ändern will, ändert diese Zeile, und das ist eine
 * sichtbare Änderung an einer versionierten Datei (dasselbe Argument wie beim nicht
 * abschaltbaren Redaction-Filter, S07).
 */
export function scopesFor(level: RiskLevel): ApprovalScope[] {
  return level === "destructive" ? ["once"] : ["once", "session", "always"];
}
