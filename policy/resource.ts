import type { PolicyPathResolver, PolicyRequest, PolicyResource } from "./types.js";

/**
 * Woran die Policy einen Aufruf festmacht: an der Ressource, die er anfasst.
 *
 * Abschnitt 10 nennt als Achsen der zweiten Ebene Tool, **Pfad**, **Domain** und
 * Geheimnisklasse. Tool und Geheimnisklasse folgen aus Name bzw. Pfad; die beiden anderen
 * stehen in der Eingabe, und die Engine muss sie dort finden, ohne die Tools zu kennen.
 */

/** Das Feld, in dem ein Tool seinen Pfad übergibt. Genau eines, siehe `assertPolicyFieldNames`. */
export const POLICY_PATH_FIELD = "path";
/** Das Feld, in dem ein Tool seine Adresse übergibt. */
export const POLICY_URL_FIELD = "url";

/** Ein Tool benennt sein Pfad- oder Adressfeld anders als vereinbart. */
export class PolicyFieldNameError extends Error {}

// Feldnamen, die "hier steht ein Pfad" oder "hier steht eine Adresse" bedeuten, ohne die
// vereinbarten Namen zu sein. Sie sind die Falle, gegen die geprüft wird.
const PATH_LIKE = /^(.*_)?(path|dir|directory|file|filename|filepath)$/i;
const URL_LIKE = /^(.*_)?(url|uri|href|endpoint|address)$/i;

/**
 * Prüft die Feldnamen eines Tool-Schemas an der Registriergrenze.
 *
 * Der Grund ist eine stille Umgehung, die sonst unvermeidlich wäre: die Engine sucht Pfad
 * und Adresse unter festen Namen. Ein Tool mit `target_path` statt `path` bekäme keine
 * einzige Pfadregel zu sehen — keine Zonenprüfung, keine Geheimnisklasse — und niemand
 * merkte es, weil der Aufruf ja durchliefe. Der Fehler wäre eine Lücke, die wie eine
 * Erlaubnis aussieht.
 *
 * Deshalb ist die Konvention nicht empfohlen, sondern erzwungen: ein Tool mit einem
 * pfadartigen Feld muss es `path` nennen, ein Tool mit einer Adresse `url`. Wer mehrere
 * braucht, ändert bewusst diese Datei mit — dann fällt die Erweiterung der Ressourcenlogik
 * am selben Ort an. `artifact_uri` ist ausgenommen: ein `artifact://`-Handle adressiert den
 * Artefaktspeicher, keinen Pfad im Dateisystem und keinen Host.
 */
export function assertPolicyFieldNames(toolName: string, fieldNames: readonly string[]): void {
  for (const field of fieldNames) {
    if (field === POLICY_PATH_FIELD || field === POLICY_URL_FIELD) continue;
    if (field === "artifact_uri" || field === "uri_scheme") continue;

    if (PATH_LIKE.test(field)) {
      throw new PolicyFieldNameError(
        `Tool "${toolName}": Feld "${field}" sieht nach einem Pfad aus, heißt aber nicht "${POLICY_PATH_FIELD}". Die Policy-Engine findet Pfade unter diesem Namen; ein anders benanntes Feld liefe an Zonen-, Pfad- und Geheimnisregeln vorbei.`,
      );
    }
    if (URL_LIKE.test(field)) {
      throw new PolicyFieldNameError(
        `Tool "${toolName}": Feld "${field}" sieht nach einer Adresse aus, heißt aber nicht "${POLICY_URL_FIELD}". Die Policy-Engine findet Domains unter diesem Namen; ein anders benanntes Feld liefe an den Domain-Regeln vorbei.`,
      );
    }
  }
}

/**
 * Bestimmt die Ressource eines Antrags.
 *
 * Ein Pfad wird über den injizierten Resolver aufgelöst — derselbe Weg, den die `fs.*`-Tools
 * gehen, nur über die Schichtgrenze gereicht. Scheitert er, entsteht `unresolvable`, und die
 * Engine verweigert: ein Pfad, den die Governance nicht einordnen kann, ist keiner, den sie
 * freigeben darf. (Der Aufruf scheiterte gleich darauf ohnehin am Tool selbst — aber dann
 * stünde im Protokoll eine Freigabe für etwas, das die Policy nie gesehen hat.)
 */
export async function describeResource(
  request: PolicyRequest,
  resolvePath: PolicyPathResolver,
  classifySecret: (displayPath: string) => string | null,
): Promise<PolicyResource> {
  const rawPath = request.input[POLICY_PATH_FIELD];
  if (typeof rawPath === "string" && rawPath.length > 0) {
    try {
      const path = await resolvePath(rawPath);
      return { kind: "path", path, secretClass: classifySecret(path.display) };
    } catch (error) {
      return {
        kind: "unresolvable",
        input: rawPath,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const rawUrl = request.input[POLICY_URL_FIELD];
  if (typeof rawUrl === "string" && rawUrl.length > 0) {
    try {
      const url = new URL(rawUrl);
      return {
        kind: "host",
        host: url.hostname.toLowerCase(),
        url: `${url.origin}${url.pathname}`,
      };
    } catch (error) {
      return {
        kind: "unresolvable",
        input: rawUrl,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { kind: "none" };
}

/**
 * Der Schlüssel, unter dem eine Freigabe gespeichert und wiedergefunden wird. Zwei Aufrufe
 * teilen sich eine Freigabe genau dann, wenn sie denselben Schlüssel ergeben — die Reichweite
 * einer Freigabe steht damit hier und nicht in der Auslegung eines Textes.
 *
 * Die Körnung ist bewusst verschieden:
 *
 *   * **Geheimnisse je Datei.** `fs.read|secret/dotenv/.env` deckt genau diese Datei. Eine
 *     Freigabe für die Quellzone deckt damit ausdrücklich **nicht** das Lesen von `.env` —
 *     sonst wäre die Geheimnisklasse mit dem ersten sessionweiten "ja" mit erledigt.
 *   * **Pfade je Zone.** `fs.write|zone/source` deckt jedes Schreiben in der Quellzone. Eine
 *     Freigabe je Datei sähe strenger aus, führte aber zu einer Rückfrage pro Datei; und ein
 *     Mensch, der zwanzigmal hintereinander gefragt wird, klickt beim einundzwanzigsten Mal
 *     durch. Das ist die schlechtere Sicherheit, nicht die bessere. Wer es enger will, ändert
 *     diese Funktion — dann fällt die Entscheidung an einer Stelle und sichtbar.
 *   * **Adressen je Host.** `web.fetch|host/example.com`, nicht je URL.
 *
 * Bei `once` kommt ohnehin die `call_id` dazu (siehe `approvals.ts`): eine Einmalfreigabe ist
 * an ihren Aufruf gebunden, unabhängig von der Körnung des Subjekts.
 *
 * **Warum `/` und nicht `:` trennt.** Der Schlüssel geht als Feld ins Ereignisprotokoll und
 * läuft dort durch den Redaction-Filter (S07). Dessen Fangnetz für Schlüssel-Wert-Paare
 * greift auf `wort:wert`, wenn das Wort `secret`, `credentials`, `private-key` oder ähnlich
 * heißt — und genau solche Wörter stehen hier, es sind die Namen der Geheimnisklassen. Mit
 * `:` als Trenner wurde aus `fs.read|secret:dotenv:.env` im Protokoll
 * `fs.read|secret:[redacted:…]`, während die Engine beim Nachschlagen den ungefilterten
 * Schlüssel benutzte: eine erteilte Freigabe wurde nie wiedergefunden, und der Lauf fragte
 * bei jedem Aufruf erneut. Der Fehler war stumm — niemand hätte ihn für eine Redaction
 * gehalten. `/` ist kein Zuweisungszeichen und wird vom Fangnetz nicht erkannt; dass es dabei
 * bleibt, sichert die Engine zusätzlich ab — sie lehnt einen Aufruf ab, dessen Subjekt der
 * Filter verändern würde (Regel `subject-redacted` in `engine.ts`).
 */
export function subjectFor(toolName: string, resource: PolicyResource): string {
  switch (resource.kind) {
    case "path":
      return resource.secretClass
        ? `${toolName}|secret/${resource.secretClass}/${resource.path.display}`
        : `${toolName}|zone/${resource.path.zone}`;
    case "host":
      return `${toolName}|host/${resource.host}`;
    case "unresolvable":
      return `${toolName}|unresolvable`;
    case "none":
      return `${toolName}|-`;
  }
}

/** Kurzfassung der Ressource fürs Protokoll. Geht durch den Redaction-Filter wie alles dort. */
export function describeResourceForLog(resource: PolicyResource): Record<string, unknown> {
  switch (resource.kind) {
    case "path":
      return {
        kind: "path",
        path: resource.path.display,
        zone: resource.path.zone,
        secret_class: resource.secretClass,
      };
    case "host":
      return { kind: "host", host: resource.host, url: resource.url };
    case "unresolvable":
      return { kind: "unresolvable", input: resource.input, error: resource.error };
    case "none":
      return { kind: "none" };
  }
}
