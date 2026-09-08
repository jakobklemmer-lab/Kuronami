import type { PolicyHook, PolicyRequest, PolicyResource, PolicyVerdict } from "./types.js";

/**
 * Ebene 1 aus Abschnitt 10: eigener Code vor der Ausführung.
 *
 * Zwei Zusagen, die den Unterschied zwischen einem Hook und einem Vorschlag ausmachen:
 *
 *   * **Ein Hook, der wirft, gilt als `deny`.** Governance-Code, der abstürzt, darf das Tor
 *     nicht öffnen. Die Gegenannahme — "kaputter Hook heißt keine Meinung" — bedeutet, dass
 *     ein Tippfehler in einer Prüfung genau die Prüfung abschaltet, für die jemand sie
 *     geschrieben hat, und zwar lautlos. Der Fehlertext bleibt vollständig im Urteil stehen
 *     (AGENTS.md: Fehler nie verstecken).
 *   * **Ein Hook kann nur verschärfen.** Sein `allow` ist eine Abstention mit Namen — es
 *     steht im Freigabepfad, damit man später sieht, dass der Hook lief und nichts einzuwenden
 *     hatte, aber es hebt keine Risikostufe und keine andere Ebene auf. Ein Hook, der eine
 *     Freigabepflicht wegnehmen kann, verlegt die Sicherheit des Systems in eine Datei, die
 *     genau dann geschrieben wird, wenn jemand eine Rückfrage loswerden will.
 *
 * Nach dem ersten `deny` wird abgebrochen. Danach kann keine Ebene das Ergebnis noch ändern,
 * und die übrigen Hooks laufen zu lassen hieße, Code auszuführen, dessen Aussage niemand mehr
 * liest — bei Hooks, die auch Zeit kosten oder selbst etwas anfassen, ist das kein Detail.
 */
export async function runHooks(
  hooks: readonly PolicyHook[],
  request: PolicyRequest,
  resource: PolicyResource,
): Promise<PolicyVerdict[]> {
  const verdicts: PolicyVerdict[] = [];

  for (const hook of hooks) {
    let verdict: PolicyVerdict;
    try {
      const answer = await hook.check(request, resource);
      if (answer === undefined) continue;
      verdict = {
        layer: "hook",
        id: hook.id,
        decision: answer.decision,
        reason: answer.reason,
      };
    } catch (error) {
      verdict = {
        layer: "hook",
        id: hook.id,
        decision: "deny",
        reason: `Hook ist fehlgeschlagen und wird als Ablehnung gewertet: ${
          error instanceof Error ? (error.stack ?? error.message) : String(error)
        }`,
      };
    }

    verdicts.push(verdict);
    if (verdict.decision === "deny") break;
  }

  return verdicts;
}
