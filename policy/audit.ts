import type { Pool } from "pg";
import { type EventRecord, readEvents } from "../runtime/events/log.js";
import type { JsonValue } from "../runtime/steps/types.js";
import type { ApprovalRef, PolicyVerdict } from "./types.js";

/**
 * Der Audit-Pfad. Abschnitt 10, letzter Satz: "Jede ausgeführte Aktion hinterlässt: Auslöser,
 * Eingaben, Freigabepfad, Ausgaben, Zeitstempel."
 *
 * Diese fünf Angaben stehen **nicht** in einer eigenen Tabelle und auch nicht in einem
 * einzigen Ereignis, sondern werden aus dem Protokoll gefaltet — dieselbe Bauweise wie
 * `deriveSessionState` (S05) und `derivePlan` (S10):
 *
 *   * `tool.requested` → Auslöser, Eingaben, Zeitstempel des Antrags
 *   * `policy.allowed` / `policy.denied` → Freigabepfad, wirksame Risikostufe, Freigabe
 *   * `policy.secret_accessed` → Zugriff auf einen Geheimnisträger
 *   * `tool.completed` / `tool.failed` → Ausgaben, Zeitstempel des Abschlusses
 *
 * Ein sechstes Ereignis, das alles noch einmal zusammen trägt, wäre eine zweite Wahrheit
 * neben dem Protokoll: es könnte von ihm abweichen, und dann wäre offen, welche der beiden
 * Fassungen der Audit ist. Die Faltung kann das nicht — sie hat keine eigenen Daten.
 *
 * Verbunden wird über die `call_id`. Sie ist die Kennung des Aufrufs (S07), sie steht in
 * jedem der beteiligten Ereignisse, und sie ist stabil über einen Neustart hinweg.
 */

export interface AuditOutcome {
  status: "ok" | "error";
  summary: string;
  stepId: string | null;
  /** false, wenn das Ergebnis aus einem schon abgeschlossenen Schritt kam (S05). */
  executed: boolean;
  artifactRefs: string[];
  /** Maschinenlesbarer Grund im Fehlerfall (`policy_denied`, `handler_failed`, …). */
  reason: string | null;
  at: Date;
}

export interface AuditEntry {
  callId: string;
  toolName: string;
  /** Der Auslöser: wer den Aufruf abgesetzt hat (`model`, `operator`, `heartbeat`, …). */
  origin: string;
  input: JsonValue;
  requestedAt: Date;
  auditId: string | null;
  decision: "allow" | "deny" | null;
  declaredRisk: string | null;
  effectiveRisk: string | null;
  subject: string | null;
  approval: ApprovalRef | null;
  /** Der Freigabepfad: was jede Ebene gesagt hat. */
  path: PolicyVerdict[];
  decidedAt: Date | null;
  secretAccess: { secretClass: string; path: string }[];
  outcome: AuditOutcome | null;
}

/**
 * Gründe, aus denen ein Aufruf scheitert, **bevor** die Policy überhaupt zuständig ist: den
 * Toolnamen gibt es nicht, oder die Eingabe passt nicht zum Schema. Ein Audit-Eintrag ohne
 * Freigabepfad ist in diesen beiden Fällen kein Loch, sondern die richtige Auskunft — es
 * wurde nichts ausgeführt und nichts freigegeben.
 */
const PRE_POLICY_REASONS = new Set(["unknown_tool", "invalid_input"]);

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** Faltet das Protokoll zu Audit-Einträgen, einer je `call_id`, in Aufrufreihenfolge. */
export function deriveAuditTrail(events: EventRecord[]): AuditEntry[] {
  const byCall = new Map<string, AuditEntry>();

  for (const event of events) {
    const callId = event.payload.call_id;
    if (typeof callId !== "string") continue;

    switch (event.type) {
      case "tool.requested": {
        // Ein zweiter Antrag zur selben call_id (Wiederaufnahme) beginnt den Eintrag neu:
        // maßgeblich ist der Lauf, der tatsächlich zum Ergebnis geführt hat.
        byCall.set(callId, {
          callId,
          toolName: String(event.payload.tool_name ?? ""),
          origin: String(event.payload.origin ?? "unbekannt"),
          input: (event.payload.input as JsonValue | undefined) ?? {},
          requestedAt: event.createdAt,
          auditId: null,
          decision: null,
          declaredRisk: (event.payload.risk as string | null) ?? null,
          effectiveRisk: null,
          subject: null,
          approval: null,
          path: [],
          decidedAt: null,
          secretAccess: [],
          outcome: null,
        });
        break;
      }

      case "policy.allowed":
      case "policy.denied": {
        const entry = byCall.get(callId);
        if (!entry) break;
        entry.auditId = (event.payload.audit_id as string | undefined) ?? null;
        entry.decision = event.type === "policy.allowed" ? "allow" : "deny";
        entry.declaredRisk = (event.payload.declared_risk as string | null) ?? entry.declaredRisk;
        entry.effectiveRisk = (event.payload.effective_risk as string | null) ?? null;
        entry.subject = (event.payload.subject as string | null) ?? null;
        entry.approval = (event.payload.approval as ApprovalRef | null) ?? null;
        entry.path = (event.payload.path as PolicyVerdict[] | undefined) ?? [];
        entry.decidedAt = event.createdAt;
        break;
      }

      case "policy.secret_accessed": {
        const entry = byCall.get(callId);
        if (!entry) break;
        entry.secretAccess.push({
          secretClass: String(event.payload.secret_class ?? ""),
          path: String(event.payload.path ?? ""),
        });
        break;
      }

      case "tool.completed":
      case "tool.failed": {
        const entry = byCall.get(callId);
        if (!entry) break;
        entry.outcome = {
          status: event.type === "tool.completed" ? "ok" : "error",
          summary: String(event.payload.summary ?? ""),
          stepId: (event.payload.step_id as string | null) ?? null,
          executed: event.payload.executed !== false,
          artifactRefs: asStringArray(event.payload.artifact_refs),
          reason: (event.payload.reason as string | null) ?? null,
          at: event.createdAt,
        };
        break;
      }

      default:
        break;
    }
  }

  return [...byCall.values()].sort(
    (a, b) => a.requestedAt.getTime() - b.requestedAt.getTime() || a.callId.localeCompare(b.callId),
  );
}

export async function readAuditTrail(pool: Pool, sessionId: string): Promise<AuditEntry[]> {
  return deriveAuditTrail(await readEvents(pool, sessionId));
}

/**
 * Die Gegenprobe zum Versprechen "Audit-Eintrag für **jede** ausgeführte Aktion": Einträge,
 * die einen Ausgang haben, aber keine Entscheidung — also etwas, das lief, ohne dass die
 * Policy es gesehen hat. Diese Liste muss leer sein; ein Test hält das über einen ganzen
 * Lauf hinweg fest.
 *
 * Sie kann nicht das Einzige sein, worauf die Zusage ruht — ein Test prüft, was gelaufen ist,
 * nicht was laufen könnte. Deshalb liegt die eigentliche Absicherung im Typsystem: ein
 * Handler bekommt seine Aufrufdaten nur mit einer `PolicyGrant`, und die stellt allein die
 * Engine aus, nachdem sie den Eintrag geschrieben hat. Diese Funktion ist die Kontrolle
 * darüber, nicht der Ersatz dafür.
 */
export function auditGaps(entries: readonly AuditEntry[]): AuditEntry[] {
  return entries.filter((entry) => {
    if (!entry.outcome) return false;
    if (entry.decision !== null) return false;
    return !(entry.outcome.reason && PRE_POLICY_REASONS.has(entry.outcome.reason));
  });
}

/** Ist der Eintrag vollständig im Sinne von Abschnitt 10 (alle fünf Angaben)? */
export function isComplete(entry: AuditEntry): boolean {
  return (
    entry.origin.length > 0 &&
    entry.input !== undefined &&
    entry.decision !== null &&
    entry.path.length > 0 &&
    entry.outcome !== null
  );
}
