import type { JsonValue } from "../runtime/steps/types.js";
import type { ApprovalScope, RiskLevel } from "./risk.js";

/**
 * Die Typen der Governance-Schicht. Bewusst ohne einen einzigen Import aus `tools/`: die
 * Engine bekommt einen **Antrag** als reine Daten und weiß nichts von `ToolDefinition`,
 * `ToolCatalog` oder der Rückgabehülle. Sonst zeigten Tool-Schicht und Policy-Schicht
 * aufeinander, und Abschnitt 4.7 legt die Richtung fest: der Router ruft die Engine.
 */

/** Der grobe Sessionmodus aus Abschnitt 10, Ebene 3. Entspricht `kuronami.approval_mode`. */
export type ApprovalMode = "ask" | "accept_edits" | "bypass_in_sandbox";

/** Was eine Ebene sagen kann. `deny` ist schärfer als `ask`, `ask` schärfer als `allow`. */
export type PolicyDecision = "allow" | "ask" | "deny";

export const POLICY_DECISION_RANK: Record<PolicyDecision, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

/** Die schärfere der beiden Aussagen. Keine Ebene kann eine andere abschwächen. */
export function strictest(a: PolicyDecision, b: PolicyDecision): PolicyDecision {
  return POLICY_DECISION_RANK[a] >= POLICY_DECISION_RANK[b] ? a : b;
}

/** Die vier Entscheidungsebenen aus Abschnitt 10, in ihrer dortigen Reihenfolge. */
export type PolicyLayer = "hook" | "rule" | "mode" | "approval" | "risk";

/**
 * Das Wort einer einzelnen Ebene. Genau diese Einträge ergeben zusammen den **Freigabepfad**
 * aus Abschnitt 10 — nicht ein Ergebnis mit einer Begründung, sondern die Kette, die zu ihm
 * geführt hat. Ohne sie ließe sich später nicht sagen, ob ein Aufruf durchging, weil eine
 * Regel ihn erlaubte oder weil keine ihn verbot.
 */
export interface PolicyVerdict {
  layer: PolicyLayer;
  /** Regel-, Hook- oder Modusname. Muss ohne Codelektüre wiederauffindbar sein. */
  id: string;
  decision: PolicyDecision;
  reason: string;
}

/** Ein Pfad, wie ihn die Policy sieht. Kommt aus dem injizierten Resolver, nicht aus `tools/`. */
export interface ResolvedResourcePath {
  /** Absolut und symlink-frei. */
  absolute: string;
  /** `artifact` (frei beschreibbar) oder `source` (nur lesbar) — die Zonen aus S08. */
  zone: string;
  /** Relativ zur Quellzonen-Wurzel, `/` als Trenner. Daran greifen die Pfadregeln. */
  display: string;
}

/**
 * Löst einen Eingabepfad auf. Wird injiziert, damit `policy/` nicht auf `tools/fs/paths.ts`
 * zeigt. Wirft bei einem Pfad außerhalb der Zonen — die Engine wertet das als `deny`
 * (fail closed): was sie nicht einordnen kann, gibt sie nicht frei.
 */
export type PolicyPathResolver = (input: string) => Promise<ResolvedResourcePath>;

/**
 * Die Ressource, um die es bei diesem Aufruf geht — die Achsen aus Abschnitt 10 Ebene 2:
 * Pfad, Domain, Geheimnisklasse. `none` ist kein Mangel, sondern die ehrliche Aussage, dass
 * dieser Aufruf keine adressierbare Ressource betrifft (`task.set`, `user.ask`).
 */
export type PolicyResource =
  | { kind: "none" }
  | { kind: "path"; path: ResolvedResourcePath; secretClass: string | null }
  | { kind: "host"; host: string; url: string }
  | {
      /** Der Pfad ließ sich nicht auflösen. Fail closed: die Engine verweigert. */
      kind: "unresolvable";
      input: string;
      error: string;
    };

/** Der Antrag, über den die Engine entscheidet. Reine Daten, vom Router zusammengestellt. */
export interface PolicyRequest {
  sessionId: string;
  callId: string;
  toolName: string;
  /** Die im Katalog deklarierte Stufe. Regeln können sie anheben, nie senken. */
  risk: RiskLevel;
  input: Record<string, JsonValue>;
  approvalMode: ApprovalMode;
  /**
   * Wer den Aufruf ausgelöst hat — der "Auslöser" aus Abschnitt 10. `model` im Normalfall,
   * etwas anderes, wenn ein Betreiber, ein Test oder ein Heartbeat direkt aufruft. Die
   * Herkunft ändert die Entscheidung **nicht**: ein direkt abgesetzter Aufruf bekommt
   * dieselben vier Ebenen wie einer aus dem Modell. Sie steht im Audit, damit hinterher
   * unterscheidbar ist, wer gefragt hat.
   */
  origin: string;
}

/** Eine Regel der zweiten Ebene: Allow/Deny/Ask nach Tool, Pfad, Domain, Geheimnisklasse. */
export interface PolicyRule {
  /** Stabil und sprechend; steht so im Freigabepfad und im Protokoll. */
  id: string;
  description: string;
  /** Alle gesetzten Bedingungen müssen zutreffen (UND). Keine gesetzt heißt: trifft immer. */
  when: {
    /** Glob über den Toolnamen (`fs.*`, `*.write`). Eine Liste ist ein ODER. */
    tool?: string | string[];
    /**
     * Wirksame Risikostufe. Damit wird eine Regel toolunabhängig: "jedes Schreiben außerhalb
     * der Artefaktzone" gilt auch für das Tool, das es morgen gibt. Eine Toolliste müsste
     * jemand nachpflegen, und die Lücke entstünde still.
     */
    risk?: RiskLevel | RiskLevel[];
    /** Glob über den anzeigbaren Pfad (relativ zur Quellzone, `/` als Trenner). */
    path?: string;
    /** Zone des aufgelösten Pfades (`artifact`, `source`). */
    zone?: string;
    /** Zone, die **nicht** zutreffen darf — für "alles außerhalb der Artefaktzone". */
    zoneNot?: string;
    /** Host oder Elterndomain, auf Punktgrenze (`example.com` deckt `a.example.com`). */
    host?: string;
    /** Geheimnisklasse aus `secrets.ts` (`dotenv`, `private-key`, …), `*` für jede. */
    secretClass?: string;
  };
  effect: {
    /** Was die Regel sagt. Fehlt sie, hebt die Regel nur die Stufe an. */
    decision?: PolicyDecision;
    /** Hebt die wirksame Risikostufe an. Senken kann keine Regel — siehe `rules.ts`. */
    raiseTo?: RiskLevel;
  };
}

/** Was ein Hook sagen kann. `undefined` heißt: keine Meinung, die nächste Ebene übernimmt. */
export type HookVerdict = { decision: PolicyDecision; reason: string } | undefined;

/**
 * Ebene 1: eigener Code vor der Ausführung. Bekommt Antrag und Ressource und sonst nichts —
 * insbesondere keinen Pool und keinen Router, damit ein Hook nicht selbst Seiteneffekte
 * auslöst, an denen die Kette hängt. Ein Hook, der wirft, wird als `deny` gewertet
 * (fail closed): kaputter Governance-Code darf das Tor nicht öffnen.
 */
export interface PolicyHook {
  id: string;
  check(request: PolicyRequest, resource: PolicyResource): Promise<HookVerdict> | HookVerdict;
}

/** Die Freigabe, auf die sich eine Entscheidung stützt. Teil des Freigabepfads. */
export interface ApprovalRef {
  approvalId: string;
  scope: ApprovalScope;
  subject: string;
  decidedBy: string;
  decidedAt: string;
  /** Die Session, in der sie erteilt wurde — bei `always` eine andere als die laufende. */
  grantedInSession: string;
}
