import type { Pool } from "pg";
import { writeArtifact } from "../runtime/artifacts/store.js";
import type { InboundAttachment, InboundMessage } from "./types.js";

/**
 * Anhänge einer eingehenden Nachricht werden **Artefakte** (S06) — nicht Text im Prompt.
 *
 * Das ist dieselbe Regel, nach der `mail.read` seine Anhänge ablegt (S14) und `fs.read` große
 * Dateien auslagert (S08): Bytes leben außerhalb des Modellkontexts, hinein geht ein Handle
 * plus eine Zeile Beschreibung (Grundprinzip 3). Ein Foto als Base64 in der Nachricht wäre
 * nicht nur teuer, es wäre bei der ersten größeren Datei das Ende des Zugs.
 *
 * **Der erste echte `stepId: null`-Fall.** `ArtifactSource` lässt ihn seit S06 zu und merkt
 * dort an, dass es ihn noch nicht gibt: bis S15 entstand jedes Artefakt im Seiteneffekt eines
 * Schritts. Ein Anhang entsteht davor — die Nachricht ist da, bevor irgendein Schritt geplant
 * ist. Genau der Fall, für den das Feld nullbar angelegt wurde.
 *
 * Das `tool`-Feld trägt `gateway:web` bzw. `gateway:telegram` und bewusst **keinen**
 * Tool-Namen: `gateway` ist kein Namensraum aus AGENTS.md, und ein Artefakt, dessen Herkunft
 * wie ein Tool aussieht, ließe später die Frage "welches Tool war das?" ins Leere laufen. Der
 * Doppelpunkt statt des Punkts sagt: das war kein Tool-Aufruf.
 */

/** Obergrenze je Anhang. Größeres wird abgewiesen, nicht abgeschnitten. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Obergrenze je Nachricht. Telegram schickt Alben mit vielen Bildern in einem Zug. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/** Ein Anhang ist zu groß oder es sind zu viele. */
export class AttachmentRejectedError extends Error {}

/** Ein abgelegter Anhang, so wie er ins Protokoll und in den Zugtext geht. */
export interface StoredAttachment {
  name: string;
  mimeType: string;
  sizeBytes: number;
  uri: string;
  sha256: string;
}

function assertWithinLimits(attachments: readonly InboundAttachment[]): void {
  if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new AttachmentRejectedError(
      `${attachments.length} Anhänge in einer Nachricht, erlaubt sind ${MAX_ATTACHMENTS_PER_MESSAGE}.`,
    );
  }
  for (const attachment of attachments) {
    if (attachment.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentRejectedError(
        `Anhang "${attachment.name}" ist ${attachment.bytes.byteLength} Byte groß, erlaubt sind ${MAX_ATTACHMENT_BYTES}.`,
      );
    }
  }
}

function describe(attachment: InboundAttachment, message: InboundMessage): string {
  return `Anhang "${attachment.name}" (${attachment.mimeType}) aus einer Nachricht von ${message.sender.displayName} über ${message.channel}`;
}

/**
 * Legt jeden Anhang als eigenes Artefakt ab und gibt die Handles zurück.
 *
 * Vor dem ersten Schreibvorgang werden **alle** Grenzen geprüft. Sonst läge bei einer
 * Nachricht mit einem gültigen und einem zu großen Anhang das erste Artefakt schon da,
 * während der Aufruf scheitert — ein halb angenommenes Postfach.
 */
export async function storeAttachments(
  pool: Pool,
  artifactRoot: string,
  sessionId: string,
  message: InboundMessage,
): Promise<StoredAttachment[]> {
  assertWithinLimits(message.attachments);

  const stored: StoredAttachment[] = [];
  for (const attachment of message.attachments) {
    const meta = await writeArtifact(pool, artifactRoot, {
      content: attachment.bytes,
      mimeType: attachment.mimeType,
      summary: describe(attachment, message),
      source: { tool: `gateway:${message.channel}`, sessionId, stepId: null },
    });
    stored.push({
      name: attachment.name,
      mimeType: meta.mimeType,
      sizeBytes: meta.sizeBytes,
      uri: meta.uri,
      sha256: meta.sha256,
    });
  }
  return stored;
}
