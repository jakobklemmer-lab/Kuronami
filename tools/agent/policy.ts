import type { HookVerdict, PolicyHook, PolicyRequest } from "../../policy/types.js";
import type { AgentProfile } from "../../runtime/agents/types.js";

/**
 * Die Werkzeugliste eines Subagenten als **Governance-Ebene** (S20).
 *
 * Abschnitt 14: "explizite Tool-Beschränkung pro Subagent". Seit S19 ist das eine Eigenschaft
 * des Katalogs — ein Arbeiter bekommt nur die Werkzeuge seines Profils, alles andere kennt
 * sein Katalog nicht, und ein Aufruf darauf endet im Router als unbekanntes Tool. Das ist
 * schon eine technische Ablehnung und kein Prompt-Hinweis.
 *
 * Dieser Hook ist die **zweite** davon unabhängige Ablehnung, und er beantwortet eine andere
 * Frage: nicht "kennt dieser Lauf das Werkzeug", sondern "darf **dieser Agent** es aufrufen".
 * Der Unterschied zählt an genau einer Stelle, und die ist keine hypothetische:
 *
 *   * Der Katalog eines Arbeiters entsteht aus einer Schnittmenge (`runWorker`). Wer diese
 *     Funktion künftig mit einem breiteren Katalog aufruft — ein Betreiber-Werkzeug, ein Test,
 *     eine spätere Verdrahtung, die "nur schnell" den vollen Katalog durchreicht —, hat die
 *     Beschränkung damit aufgehoben, ohne dass irgendwo etwas fehlte.
 *   * Ein Hook dagegen hängt am Profil, nicht am Katalog. Er lehnt ab, egal woher der Aufruf
 *     kommt und egal, wie großzügig der Katalog ist.
 *
 * Zwei Tore, die dasselbe zusagen, aber aus verschiedenen Gründen halten — dieselbe Bauart wie
 * bei der Risikostufe (Registry **und** Engine, S11) und bei der Schreibgrenze des Heartbeats
 * (Katalog **und** `BACKGROUND_RULES`, S17).
 *
 * Er kann nur verschärfen: ein Hook, der `allow` sagt, hebt nichts auf (`policy/hooks.ts`).
 * Deshalb gibt dieser hier bei einem erlaubten Werkzeug gar nichts zurück (`undefined`) statt
 * eines Freispruchs, den niemand braucht — im Freigabepfad stünde sonst bei jedem einzelnen
 * Aufruf eine Zeile, die nichts aussagt.
 */
export function agentToolsHook(profile: AgentProfile): PolicyHook {
  const allowed = new Set(profile.tools);
  return {
    // Steht so im Freigabepfad und im `policy.denied`: "welcher Agent hat hier abgelehnt" soll
    // ohne Codelektüre lesbar sein.
    id: `agent-toolset:${profile.name}`,
    check(request: PolicyRequest): HookVerdict | undefined {
      if (allowed.has(request.toolName)) return undefined;
      return {
        decision: "deny",
        reason: `Der Agent "${profile.name}" darf "${request.toolName}" nicht aufrufen. Seine Werkzeugliste ist abschließend: ${[...allowed].join(", ")}.`,
      };
    },
  };
}
