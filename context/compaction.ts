import type { Pool } from "pg";
import { writeArtifact } from "../runtime/artifacts/store.js";
import { type EventRecord, appendEvent } from "../runtime/events/log.js";
import { type ModelClient, type ModelMessage, isToolUseBlock } from "../runtime/model/types.js";
import { estimateTokens } from "../tools/offload.js";
import type { ToolCatalog } from "../tools/types.js";

/**
 * Kontextstufen 2 und 3 (Abschnitt 7, Auftrag S18a). Stufe 0 und 1 liegen seit S07/S08/S09 in
 * `tools/offload.ts` und im Router: sie greifen an der Quelle, bevor ein Ergebnis überhaupt
 * ins Protokoll geht. Stufe 2 und 3 greifen **hier**, am anderen Ende — an der Historie, die
 * `deriveLoopState` aus dem längst geschriebenen Protokoll faltet, kurz bevor sie an das
 * Modell geht.
 *
 * ## Die Historie bleibt unverändert. Nur die Anfrage wird kleiner.
 *
 * Das Ereignisprotokoll ist Append-only (Grundprinzip 2) und die maßgebliche Wahrheit für
 * Replay (Abschnitt 4.4). Eine Kompaktierung, die alte Ereignisse umschriebe, bräche genau
 * diese Zusage — der zehnte Zug einer Session sähe nach einem Neustart eine andere Historie
 * als vor dem Neustart. Deshalb rührt dieses Modul das Protokoll nicht an: es liest die volle
 * Historie (aus `deriveLoopState`), baut daraus eine **kleinere Fassung für den nächsten
 * Modellaufruf** und hält fest, was es getan hat — als weitere Ereignisse, nicht als Korrektur
 * bestehender. `state.messages` bleibt, was es war; nur `compaction.messages` geht an den
 * Anbieter.
 *
 * ## Wiederanwenden statt wiederholen
 *
 * Weil die Historie bei jedem Schritt neu aus dem Protokoll gefaltet wird (kein Zustand im
 * Prozess, S12), sähe eine Kompaktierung ohne Gedächtnis bei jedem weiteren Schritt dieselbe
 * "zu große" Rohhistorie wieder — und schriebe dieselbe Referenz, denselben Rohverlauf,
 * denselben Modellaufruf erneut. Das wäre nicht falsch, aber teuer und unehrlich gegenüber der
 * Kennzahl "Kompaktierungshäufigkeit" (Abschnitt 12), die dann bei jedem Schritt anstiege statt
 * nur beim tatsächlichen Ereignis.
 *
 * Die Lösung ist dieselbe wie beim Idempotenzschlüssel der Ausführungshülle (S05): das
 * Protokoll trägt schon, was zuvor geschah, und diese Funktion liest `context.compacted`-
 * Ereignisse **zurück**, bevor sie neue Arbeit erwägt.
 *
 *   * **Stufe 2** merkt sich pro `call_id`, unter welchem Handle das Ergebnis liegt. Ein
 *     Aufruf, der schon einmal umgeschrieben wurde, wird beim nächsten Schritt nur noch
 *     nachgeschlagen (`applyStage2`), nicht neu ausgelagert.
 *   * **Stufe 3** merkt sich die höchste bisher erreichte Sequenznummer (`through_seq`). Weil
 *     eine Session innerhalb eines Zugs nur an ihrem Ende wächst (Historie ist append-only),
 *     ist "alles bis Sequenznummer N zusammengefasst" eine einzige Zahl und kein Mengenabgleich
 *     — die jeweils **höchste** ist automatisch die aktuellste, eine ältere Zusammenfassung
 *     ist in ihr enthalten (siehe `renderSpan`, das eine alte Zusammenfassung einfach als
 *     weitere Zeile in die nächste aufnimmt).
 *
 * ## Warum die Grenze zwischen Stufe 2 und 3 an Nachrichten läuft, nicht an Bytes allein
 *
 * Stufe 2 ändert nie die Zahl der Nachrichten oder Blöcke — sie ersetzt nur den Inhalt eines
 * `tool_result`-Blocks durch eine kurze Referenz. Ein `tool_use` ohne passenden `tool_result`
 * lehnt der Anbieter ab (`assertSendable`), und Stufe 2 kann das nicht verletzen, weil sie
 * keinen Block entfernt. Stufe 3 dagegen **entfernt** ganze Nachrichten (viele Runden werden zu
 * einer), und das darf nur an einer Grenze passieren, an der kein `tool_use` ohne sein
 * Ergebnis zurückbliebe. `largestBalancedPrefix` sucht genau diese Grenze, statt sie zu raten.
 */

/** Konfigurierbare Schwellenwerte (Auftrag S18a: "mit sinnvollem Startwert"). */
export interface CompactionConfig {
  /**
   * Token-Äquivalent-Fenster des Modells. Die Architektur nennt keinen Zahlenwert (Abschnitt
   * 13 listet nur die Auslagerungsschwelle); der Startwert hier ist das Kontextfenster der
   * aktuellen Modellklasse. Über `compactionConfig` pro Lauf überschreibbar — ein Test setzt
   * hier bewusst einen kleinen Wert, um die Kompaktierung ohne hunderttausend Zeichen Historie
   * auszulösen.
   */
  contextWindowTokens: number;
  /** Anteil des Fensters, der nie gefüllt wird (Abschnitt 13: 20 bis 25 %, unteres Ende). */
  reservedContextShare: number;
  /** Ab dieser Auslastung des nutzbaren Fensters greift Stufe 2 (Abschnitt 7: 80 bis 90 %, Mitte). */
  stage2UtilizationThreshold: number;
  /**
   * Ab dieser Blockgröße (Byte der vollständigen `tool_result`-Hülle) lohnt sich eine
   * Referenzumschrift. Kleiner als die Auslagerungsschwelle aus Abschnitt 13 (8k Token-
   * Äquivalent, `tools/offload.ts`): Stufe 1 hat solche Blöcke schon ausgelagert, Stufe 2 holt
   * ab, was darunter blieb, aber in der Summe trotzdem drückt.
   */
  stage2MinBlockBytes: number;
  /**
   * So viele der jüngsten Nachrichten bleiben unangetastet — von beiden Stufen (Abschnitt 7.4:
   * "letzte Nachrichten und Tool-Ergebnisse" bleiben immer sichtbar). Eine Handvoll Runden.
   */
  protectedTailMessages: number;
  /** Unter dieser Nachrichtenzahl im kompaktierbaren Bereich lohnt sich Stufe 3 noch nicht. */
  stage3MinMessages: number;
  /** Deckel für die Zusammenfassungsantwort. */
  stage3MaxTokens: number;
  /** Sicherheitsgrenze gegen eine Endlosschleife innerhalb eines einzigen Aufrufs. */
  maxRoundsPerCall: number;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  contextWindowTokens: 200_000,
  reservedContextShare: 0.2,
  stage2UtilizationThreshold: 0.85,
  stage2MinBlockBytes: 2_000,
  protectedTailMessages: 8,
  stage3MinMessages: 6,
  stage3MaxTokens: 1_024,
  maxRoundsPerCall: 6,
};

export function resolveCompactionConfig(overrides?: Partial<CompactionConfig>): CompactionConfig {
  return { ...DEFAULT_COMPACTION_CONFIG, ...overrides };
}

/**
 * Grobe Schätzung des festen Anteils der Anfrage (System-Prompt, Konventionen, Tool-Katalog).
 * Dieselbe Näherung wie in `tools/offload.ts` (vier Byte je Token) — aus demselben Grund: der
 * genaue Wert hängt am Tokenizer des Anbieters, und Abschnitt 13 spricht bewusst von
 * "Token-Äquivalent". Einmal je Zug berechnet (der Katalog ist eingefroren, S07), nicht bei
 * jedem Schritt neu.
 */
export function estimateFixedOverheadTokens(
  systemPrompt: string,
  conventions: string,
  catalog: ToolCatalog,
): number {
  const toolsText = JSON.stringify(
    catalog.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: tool.inputSchema,
    })),
  );
  return estimateTokens(systemPrompt) + estimateTokens(conventions) + estimateTokens(toolsText);
}

export interface CompactionDeps {
  pool: Pool;
  artifactRoot: string;
  sessionId: string;
  /**
   * Das Modell für die Zusammenfassung in Stufe 3. Bewusst ein eigenes Feld und nicht
   * automatisch das Orchestrator-Modell: der Auftrag verlangt "ein günstiges Modell", und
   * Abschnitt 11 ordnet Zusammenfassen einer schwächeren Klasse zu als Planen. Ohne eigene
   * Angabe fällt der Aufrufer (`runtime/loop/loop.ts`) auf das Orchestrator-Modell zurück —
   * lauffähig, aber nicht kostenoptimiert; das Umschalten auf ein echtes zweites Modell ist der
   * Hebel, den S21 (Modell-Routing) zieht, ohne dass diese Datei sich ändern muss.
   */
  model: ModelClient;
  signal?: AbortSignal;
}

export interface CompactionInput {
  turnId: string;
  /** Die vollständige Historie, unverändert aus `deriveLoopState`. */
  messages: readonly ModelMessage[];
  /** Parallel dazu: `LoopState.messageSeqs`. */
  messageSeqs: readonly number[];
  /** Das ganze Protokoll der Session — für bereits verzeichnete Kompaktierungen. */
  events: readonly EventRecord[];
  fixedOverheadTokens: number;
  config: CompactionConfig;
}

export interface CompactionResult {
  messages: ModelMessage[];
  utilizationBefore: number;
  utilizationAfter: number;
  compacted: boolean;
}

interface Stage2Entry {
  uri: string;
  bytesBefore: number;
}

/** Liest alle bisherigen Stufe-2-Ereignisse dieser Session zu einer Nachschlagetabelle. */
function collectStage2Map(events: readonly EventRecord[]): Map<string, Stage2Entry> {
  const map = new Map<string, Stage2Entry>();
  for (const event of events) {
    if (event.type !== "context.compacted" || event.payload.stage !== 2) continue;
    const rewritten = event.payload.rewritten;
    if (!Array.isArray(rewritten)) continue;
    for (const entry of rewritten) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.call_id === "string" && typeof record.artifact_uri === "string") {
        map.set(record.call_id, {
          uri: record.artifact_uri,
          bytesBefore: typeof record.bytes_before === "number" ? record.bytes_before : 0,
        });
      }
    }
  }
  return map;
}

/**
 * Ein Schnittpunkt, an dem die Historie bis `throughSeq` durch zwei synthetische Nachrichten
 * ersetzt wird — das Ergebnis entweder einer Stufe-3-Zusammenfassung oder eines frischen
 * Abschnitts (Stufe 4, S18b, `context/section.ts`). Beide beantworten dieselbe Frage ("was wird
 * aus der Historie vor diesem Punkt") nur mit unterschiedlichem Auslöser und unterschiedlich
 * ausführlichem Text; für `applyCut` ist der Unterschied ohne Belang.
 */
interface CutRecord {
  throughSeq: number;
  summaryText: string;
  rawArtifactUri: string;
}

/**
 * Die Historie wächst innerhalb eines Zugs nur am Ende an (Grundprinzip 2). "Bis zu welcher
 * Sequenznummer schon ersetzt ist" ist damit eine einzige Zahl: die **höchste** bisherige Marke
 * über beide Ereignistypen hinweg deckt jede ältere automatisch mit ab (siehe Moduldoku).
 *
 * Ein frischer Abschnitt (`context.section_started`, S18b) schneidet immer bei der zum
 * Auslösezeitpunkt jüngsten Nachricht — sein `through_seq` ist deshalb nie kleiner als der einer
 * zuvor gelesenen Stufe-3-Marke. Die **höchste** Marke zu nehmen, gleich aus welchem der beiden
 * Ereignistypen, ist damit immer die vollständigste bekannte Kürzung; kein Sonderfall nötig für
 * "welcher Typ ist neuer".
 */
function latestCut(events: readonly EventRecord[]): CutRecord | null {
  let best: CutRecord | null = null;
  for (const event of events) {
    let throughSeq: unknown;
    let summaryText: unknown;
    if (event.type === "context.compacted" && event.payload.stage === 3) {
      throughSeq = event.payload.through_seq;
      summaryText = event.payload.summary;
    } else if (event.type === "context.section_started") {
      throughSeq = event.payload.through_seq;
      summaryText = event.payload.handover;
    } else {
      continue;
    }
    if (typeof throughSeq !== "number") continue;
    if (!best || throughSeq > best.throughSeq) {
      best = {
        throughSeq,
        summaryText: typeof summaryText === "string" ? summaryText : "",
        rawArtifactUri:
          typeof event.payload.raw_artifact_uri === "string" ? event.payload.raw_artifact_uri : "",
      };
    }
  }
  return best;
}

function referenceText(uri: string, bytesBefore: number): string {
  return JSON.stringify({ compacted: true, uri, bytes_before: bytesBefore });
}

/** Ersetzt den Inhalt bereits bekannter `tool_result`-Blöcke durch ihre Referenz. Reine Funktion. */
function applyStage2(
  messages: readonly ModelMessage[],
  map: ReadonlyMap<string, Stage2Entry>,
): ModelMessage[] {
  if (map.size === 0) return [...messages];
  return messages.map((message) => {
    let changed = false;
    const content = message.content.map((block) => {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") return block;
      const entry = map.get(block.tool_use_id);
      if (!entry) return block;
      changed = true;
      return { ...block, content: referenceText(entry.uri, entry.bytesBefore) };
    });
    return changed ? { ...message, content } : message;
  });
}

/** Für jeden Schnittpunkt `i`: ist `messages[0..i)` frei von offenen `tool_use`-Blöcken? */
function safeCutPoints(messages: readonly ModelMessage[]): boolean[] {
  const open = new Set<string>();
  const safe: boolean[] = [true];
  for (const message of messages) {
    for (const block of message.content) {
      if (isToolUseBlock(block)) open.add(block.id);
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        open.delete(block.tool_use_id);
      }
    }
    safe.push(open.size === 0);
  }
  return safe;
}

/**
 * Der größte Schnittpunkt `<= maxEnd`, an dem keine Anfrage-Antwort-Paarung zerrissen wird.
 *
 * Exportiert für `context/section.ts` (S18b): ein frischer Abschnitt schneidet nach demselben
 * Prinzip wie Stufe 3, nur ohne geschütztes Ende (`maxEnd` ist dort die ganze Historie) — zwei
 * Module, die denselben Schnittpunkt suchen, sollen ihn auf demselben Weg finden.
 */
export function largestBalancedPrefix(messages: readonly ModelMessage[], maxEnd: number): number {
  const safe = safeCutPoints(messages);
  const bounded = Math.min(maxEnd, messages.length);
  for (let end = bounded; end >= 0; end -= 1) {
    if (safe[end]) return end;
  }
  return 0;
}

/** Ersetzt die Historie bis `record.throughSeq` durch die eine Übergabe-Runde. */
function applyCut(
  messages: readonly ModelMessage[],
  seqs: readonly number[],
  record: CutRecord | null,
): { messages: ModelMessage[]; seqs: number[] } {
  if (!record) return { messages: [...messages], seqs: [...seqs] };
  let cut = 0;
  while (cut < seqs.length && seqs[cut] <= record.throughSeq) cut += 1;
  if (cut === 0) return { messages: [...messages], seqs: [...seqs] };

  const syntheticAssistant: ModelMessage = {
    role: "assistant",
    content: [
      {
        type: "text",
        text: `[Kontext kompaktiert] Vorherige Schritte zusammengefasst (Rohverlauf: ${record.rawArtifactUri}).`,
      },
    ],
  };
  const syntheticUser: ModelMessage = {
    role: "user",
    content: [{ type: "text", text: record.summaryText }],
  };

  return {
    messages: [syntheticAssistant, syntheticUser, ...messages.slice(cut)],
    seqs: [record.throughSeq, record.throughSeq, ...seqs.slice(cut)],
  };
}

/** Alle noch nicht kompaktierten `tool_result`-Blöcke außerhalb des geschützten Endes, die groß genug sind. */
function findEligibleStage2Blocks(
  messages: readonly ModelMessage[],
  config: CompactionConfig,
  already: ReadonlyMap<string, Stage2Entry>,
): { callId: string; content: string }[] {
  const cutoff = Math.max(0, messages.length - config.protectedTailMessages);
  const found: { callId: string; content: string }[] = [];
  for (let index = 0; index < cutoff; index += 1) {
    for (const block of messages[index].content) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      if (already.has(block.tool_use_id)) continue;
      if (typeof block.content !== "string") continue;
      if (Buffer.byteLength(block.content, "utf8") >= config.stage2MinBlockBytes) {
        found.push({ callId: block.tool_use_id, content: block.content });
      }
    }
  }
  return found;
}

/**
 * Ein Ausschnitt ohne jeden `tool_use`-Block enthält nichts als frühere Zusammenfassungen —
 * ihn erneut zusammenzufassen wäre eine Zusammenfassung der Zusammenfassung ohne neuen Inhalt.
 * Ohne diese Wächter würde eine Konfiguration mit sehr niedriger Schwelle (siehe
 * `compaction.test.ts`) Runde für Runde denselben Text erneut ans Modell schicken, obwohl seit
 * der letzten Runde kein einziger neuer Schritt dazukam.
 */
function hasRealContent(messages: readonly ModelMessage[]): boolean {
  return messages.some((message) => message.content.some((block) => isToolUseBlock(block)));
}

/** Der älteste, noch nicht zusammengefasste, in sich geschlossene Ausschnitt vor dem geschützten Ende. */
function computeStage3Span(
  messages: readonly ModelMessage[],
  seqs: readonly number[],
  config: CompactionConfig,
): { end: number; throughSeq: number } | null {
  const cutoff = Math.max(0, messages.length - config.protectedTailMessages);
  const end = largestBalancedPrefix(messages, cutoff);
  if (end < config.stage3MinMessages) return null;
  if (!hasRealContent(messages.slice(0, end))) return null;
  return { end, throughSeq: seqs[end - 1] };
}

/**
 * Text eines Ausschnitts, lesbar für Mensch und Modell — die Grundlage für das Rohverlauf-
 * Artefakt und für die Zusammenfassungsanfrage. Beides bekommt denselben Text: er stammt aus
 * `state.messages`, also aus `readEvents` gefaltet, und ist damit am Schreibtor des
 * Protokolls schon gefiltert (Abschnitt 4.7, dieselbe Begründung wie in `context/request.ts`
 * für die Nachrichten) — eine zweite Filterung hier wäre kein Zugewinn an Sicherheit, könnte
 * aber die `tool_use_id` in einem `tool_result`-Text verändern, wenn sie zufällig einem Muster
 * gliche.
 *
 * Exportiert für `context/section.ts` (S18b): dieselbe Textform für den Rohverlauf und für die
 * Übergabe-Anfrage eines frischen Abschnitts wie hier für Stufe 3.
 */
export function renderSpan(messages: readonly ModelMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "text" && typeof block.text === "string") {
        lines.push(`[${message.role}] ${block.text}`);
      } else if (isToolUseBlock(block)) {
        lines.push(`[${message.role}] Aufruf ${block.name}(${JSON.stringify(block.input)})`);
      } else if (block.type === "tool_result") {
        lines.push(`[${message.role}] Ergebnis: ${String(block.content)}`);
      } else {
        lines.push(`[${message.role}] ${JSON.stringify(block)}`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * Der Prompt für Stufe 3, wörtlich nach der Spalte "Maßnahme" aus Abschnitt 7: "Ziel, Stand,
 * offene Aufgaben, Entscheidungen, Artefakt-Refs, nächster Schritt".
 */
function buildCompactionPrompt(spanText: string): string {
  return [
    "Ein Ausschnitt aus der Mitte eines laufenden Agenten-Verlaufs folgt weiter unten. Er wird",
    "aus dem Modellkontext entfernt und durch deine Zusammenfassung ersetzt — sie ist ab jetzt",
    "die einzige Erinnerung an das, was in diesem Ausschnitt geschah.",
    "",
    "Antworte in genau diesen sechs Abschnitten, knapp und ohne Wiederholung des Ausschnitts:",
    "ZIEL: <was insgesamt erreicht werden soll>",
    "STAND: <was in diesem Ausschnitt tatsächlich passiert ist>",
    "OFFENE_AUFGABEN: <was noch aussteht>",
    "ENTSCHEIDUNGEN: <getroffene Entscheidungen samt Grund>",
    "ARTEFAKT_REFS: <artifact://-Handles, die weiter gelten, komma-getrennt, sonst 'keine'>",
    "NAECHSTER_SCHRITT: <was als nächstes zu tun ist>",
    "",
    "=== Ausschnitt ===",
    spanText,
  ].join("\n");
}

function estimateUtilization(
  messages: readonly ModelMessage[],
  fixedOverheadTokens: number,
  usableWindowTokens: number,
): number {
  if (usableWindowTokens <= 0) return Number.POSITIVE_INFINITY;
  const messagesTokens = estimateTokens(JSON.stringify(messages));
  return (fixedOverheadTokens + messagesTokens) / usableWindowTokens;
}

/**
 * Wendet Kontextstufe 2 und 3 auf eine Historie an, bevor sie an das Modell geht.
 *
 * Wirft nie aus eigenem Antrieb: ein Modellaufruf für Stufe 3 kann scheitern (Netz, Anbieter),
 * und ein Lauf, der deshalb ganz abbricht, wäre schlechter als einer, der die unkompaktierte
 * Historie eben doch in voller Größe schickt. Der Fehler geht ins Protokoll (`error.raised`);
 * der Aufrufer bekommt die letzte erfolgreich kompaktierte Fassung zurück.
 */
export async function compactHistory(
  deps: CompactionDeps,
  input: CompactionInput,
): Promise<CompactionResult> {
  const { config } = input;
  const usableWindowTokens = config.contextWindowTokens * (1 - config.reservedContextShare);

  const stage2Map = collectStage2Map(input.events);
  let messages = applyStage2(input.messages, stage2Map);
  let seqs = [...input.messageSeqs];
  // Die höchste bisherige Kürzung — Stufe 3 oder ein frischer Abschnitt (Stufe 4, S18b), siehe
  // `latestCut`. Ein Abschnittswechsel greift damit auch hier, ohne dass diese Funktion je
  // selbst `context.section_started` schreibt: sie liest nur zurück, was `context/section.ts`
  // schon protokolliert hat, bevor `compactHistory` in diesem Zug zum ersten Mal lief.
  ({ messages, seqs } = applyCut(messages, seqs, latestCut(input.events)));

  const utilizationBefore = estimateUtilization(
    messages,
    input.fixedOverheadTokens,
    usableWindowTokens,
  );
  let utilization = utilizationBefore;
  let compacted = false;
  let round = 0;

  while (utilization >= config.stage2UtilizationThreshold && round < config.maxRoundsPerCall) {
    round += 1;
    let progressed = false;

    const eligible = findEligibleStage2Blocks(messages, config, stage2Map);
    if (eligible.length > 0) {
      const rewritten: Record<string, unknown>[] = [];
      for (const block of eligible) {
        const bytesBefore = Buffer.byteLength(block.content, "utf8");
        const meta = await writeArtifact(deps.pool, deps.artifactRoot, {
          content: block.content,
          mimeType: "application/json",
          summary: `Kompaktiertes Tool-Ergebnis (${block.callId})`,
          source: { tool: "context.compaction", sessionId: deps.sessionId, stepId: null },
        });
        stage2Map.set(block.callId, { uri: meta.uri, bytesBefore });
        rewritten.push({
          call_id: block.callId,
          artifact_uri: meta.uri,
          bytes_before: bytesBefore,
        });
      }
      await appendEvent(deps.pool, deps.sessionId, "context.compacted", {
        turn_id: input.turnId,
        stage: 2,
        reason: "context_window_utilization",
        utilization_before: utilization,
        rewritten,
      });
      messages = applyStage2(messages, stage2Map);
      progressed = true;
      compacted = true;
      utilization = estimateUtilization(messages, input.fixedOverheadTokens, usableWindowTokens);
      if (utilization < config.stage2UtilizationThreshold) break;
    }

    const span = computeStage3Span(messages, seqs, config);
    if (span) {
      const spanMessages = messages.slice(0, span.end);
      const spanText = renderSpan(spanMessages);

      const rawMeta = await writeArtifact(deps.pool, deps.artifactRoot, {
        content: spanText,
        mimeType: "text/plain",
        summary: `Rohverlauf vor Kompaktierung (${spanMessages.length} Nachrichten)`,
        source: { tool: "context.compaction", sessionId: deps.sessionId, stepId: null },
      });

      await appendEvent(deps.pool, deps.sessionId, "model.requested", {
        turn_id: input.turnId,
        model: deps.model.model,
        purpose: "compaction",
        messages: 1,
        tools: 0,
      });

      let response: Awaited<ReturnType<ModelClient["complete"]>>;
      try {
        response = await deps.model.complete({
          system: [
            {
              text: "Du fasst einen Ausschnitt eines Agenten-Verlaufs zusammen, damit er aus dem Modellkontext entfernt werden kann.",
            },
          ],
          tools: [],
          messages: [
            { role: "user", content: [{ type: "text", text: buildCompactionPrompt(spanText) }] },
          ],
          maxTokens: config.stage3MaxTokens,
          signal: deps.signal,
        });
      } catch (error) {
        await appendEvent(deps.pool, deps.sessionId, "error.raised", {
          turn_id: input.turnId,
          where: "context.compaction.stage3",
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }

      await appendEvent(deps.pool, deps.sessionId, "model.responded", {
        turn_id: input.turnId,
        model: response.model,
        purpose: "compaction",
        stop_reason: response.stopReason,
        text: response.text,
        usage: {
          input_tokens: response.usage.inputTokens,
          output_tokens: response.usage.outputTokens,
          cache_read_input_tokens: response.usage.cacheReadTokens,
          cache_creation_input_tokens: response.usage.cacheCreationTokens,
        },
      });

      await appendEvent(deps.pool, deps.sessionId, "context.compacted", {
        turn_id: input.turnId,
        stage: 3,
        reason: "context_window_utilization",
        utilization_before: utilization,
        through_seq: span.throughSeq,
        covered_messages: spanMessages.length,
        raw_artifact_uri: rawMeta.uri,
        summary: response.text,
        model: response.model,
      });

      ({ messages, seqs } = applyCut(messages, seqs, {
        throughSeq: span.throughSeq,
        summaryText: response.text,
        rawArtifactUri: rawMeta.uri,
      }));
      progressed = true;
      compacted = true;
      utilization = estimateUtilization(messages, input.fixedOverheadTokens, usableWindowTokens);
    }

    if (!progressed) break;
  }

  return { messages, utilizationBefore, utilizationAfter: utilization, compacted };
}
