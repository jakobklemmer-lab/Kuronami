import type { Pool } from "pg";
import type { PolicyEngine } from "../policy/engine.js";
import { type Runner, createRunner } from "../runtime/loop/api.js";
import type { ModelClient } from "../runtime/model/types.js";
import type { SessionChannel } from "../runtime/session/types.js";
import type { MemoryStore } from "../tools/memory/store.js";
import type { SkillCatalog } from "../tools/skill/catalog.js";
import type { ToolCatalog } from "../tools/types.js";

/**
 * **Ein Nutzer, ein Gedächtnis, unabhängig vom Kanal** (Auftrag S16).
 *
 * Diese Datei ist die Stelle, an der dieser Satz wahr wird, und sie besteht im Kern aus zwei
 * Zeilen: der Faden folgt aus der **Nutzerkennung**, der Kanal der Session ist die Konstante
 * `gateway`. Damit landen Web und Telegram desselben Nutzers über den UNIQUE-Index
 * `(thread_id, channel)` aus S04 in **derselben Zeile** von `kuronami.sessions` — und damit im
 * selben Ereignisprotokoll, aus dem `deriveLoopState` (S12) die Gesprächshistorie faltet.
 *
 * Das Gedächtnis ist nichts, was hier gebaut würde. Es ist das Protokoll, das es seit S03
 * gibt; die einzige Entscheidung ist, dass beide Kanäle hineinschreiben.
 *
 * ## Warum der Kanal nicht aus der Nachricht kommt
 *
 * Der naheliegende Weg wäre `createRunner({ threadId, channel: message.channel })`. Er ist in
 * einer Zeile geschrieben und legt zwei Sessions an: eine `(thread_user_jakob, web)` und eine
 * `(thread_user_jakob, telegram)`. Beide hätten ein eigenes Protokoll, und der Agent wüsste am
 * Telegram-Kanal nichts von dem, was im Web besprochen wurde — also genau das Gegenteil des
 * Fertig-Kriteriums. Die Gegenprobe dazu steht in `gateway.test.ts`.
 *
 * S04 hat festgehalten: "derselbe Faden auf zwei Kanälen sind zwei Sessions". Das bleibt
 * richtig und wird hier nicht umgangen, sondern erfüllt: die Unterhaltung eines Nutzers ist
 * **ein** Faden auf **einem** Kanal, und dieser Kanal heißt `gateway` (Migration 0008). Der
 * Kanal der einzelnen Nachricht steht im `gateway.received`-Ereignis.
 *
 * ## Warum ein Läufer je Nutzer und eine Warteschlange
 *
 * `runTurn` verträgt keinen zweiten Zug, solange einer offen ist (`NoOpenTurnError`, S12) —
 * zu Recht: eine zweite Eingabe würde den offenen Zug samt seiner unerledigten Aufrufe
 * überschreiben. Zwei Nachrichten, die gleichzeitig ankommen (eine im Web, eine per Telegram),
 * sind aber keine Ausnahme, sondern der Normalfall eines Systems mit zwei Kanälen. Deshalb
 * werden die Zugriffe je Unterhaltung **serialisiert**: die zweite Nachricht wartet, bis die
 * erste ihren Zug beendet hat.
 *
 * Die Warteschlange liegt im Prozess und muss keinen Neustart überleben — sie hält keinen
 * Zustand, sondern nur eine Reihenfolge. Was einen Neustart überleben muss, steht im
 * Protokoll: der offene Zug, die offene Rückfrage, die Historie.
 */

/**
 * Der Kanal jeder Gateway-Session. Konstante, kein Feld — siehe oben.
 *
 * Der Wert ist seit Migration 0008 im Enum `kuronami.session_channel`.
 */
export const GATEWAY_SESSION_CHANNEL: SessionChannel = "gateway";

/** Der Faden einer Unterhaltung. Folgt allein aus dem Nutzer, nie aus dem Kanal. */
export function threadIdFor(userId: string): string {
  return `thread_user_${userId}`;
}

export interface ConversationDeps {
  pool: Pool;
  artifactRoot: string;
  catalog: ToolCatalog;
  policy: PolicyEngine;
  model: ModelClient;
  /** Einmal beim Start gelesen (S12). Fehlt sie, liest `createRunner` AGENTS.md. */
  conventions?: string;
  maxSteps?: number;
  /**
   * Das Langzeitgedächtnis (S18). Ohne dieses Feld läuft die Unterhaltung ohne Recall und ohne
   * Notizen — wie jede Session ohne konfiguriertes Gedächtnis seit S18.
   */
  memory?: MemoryStore;
  /** Der Skill-Katalog (S18c). Ohne dieses Feld läuft die Unterhaltung ohne Skills. */
  skills?: SkillCatalog;
}

export interface Conversation {
  readonly userId: string;
  readonly runner: Runner;
  /**
   * Führt `work` aus, während kein anderer Zug dieser Unterhaltung läuft.
   *
   * Serialisiert, nicht abgewiesen: eine Nachricht, die während eines laufenden Zugs eintrifft,
   * soll später bearbeitet werden und nicht verlorengehen.
   */
  serialize<T>(work: () => Promise<T>): Promise<T>;
}

export interface Conversations {
  /** Die Unterhaltung dieses Nutzers. Legt sie an oder nimmt die bestehende wieder auf. */
  of(userId: string): Promise<Conversation>;
  /** Die schon geöffneten Unterhaltungen. Für das Herunterfahren. */
  open(): Conversation[];
  stopAll(reason: string): Promise<void>;
}

export function createConversations(deps: ConversationDeps): Conversations {
  const conversations = new Map<string, Conversation>();
  // Ein zweiter Aufruf für denselben Nutzer darf keinen zweiten Läufer bauen, während der
  // erste noch entsteht — sonst stünden zwei `runtime.started` zu einer Session im Protokoll
  // und zwei Warteschlangen nebeneinander, die sich gegenseitig nicht sähen.
  const building = new Map<string, Promise<Conversation>>();

  async function build(userId: string): Promise<Conversation> {
    const runner = await createRunner({
      pool: deps.pool,
      threadId: threadIdFor(userId),
      channel: GATEWAY_SESSION_CHANNEL,
      artifactRoot: deps.artifactRoot,
      catalog: deps.catalog,
      policy: deps.policy,
      model: deps.model,
      conventions: deps.conventions,
      maxSteps: deps.maxSteps,
      memory: deps.memory,
      skills: deps.skills,
      // Ein fertiger Zug ist hier **kein** fertiger Auftrag: die Unterhaltung geht mit der
      // nächsten Nachricht weiter. `session.completed` nach jeder Antwort wäre eine
      // Falschaussage über den Verlauf — `loop/api.ts` nennt genau diesen Fall, wenn es die
      // Vorgabe begründet. Eine Session endet hier durch Abbruch, nicht durch eine Antwort.
      completeOnDone: false,
      // Anders als `completeOnDone`: ob **dieser Zug** eine Notiz hinterlässt, ist eine andere
      // Frage als ob die Unterhaltung als Ganzes vorbei ist (S18b — bis hierher ungeklärt, siehe
      // "offene Befunde" zu S18: "wann eine Unterhaltung endet, weiß dieses System noch nicht").
      // Die Antwort: sie endet dafür nie — jeder abgeschlossene Zug bekommt seine Chance auf
      // eine Notiz, unabhängig davon, ob noch ein nächster folgt. `summarizeRun`s eigene
      // Zurückhaltung (NICHTS ist der Normalfall) verhindert, dass daraus zweihundert
      // Routinenotizen werden — das ist dieselbe Bremse, die S18 dafür gebaut hat.
      summarizeToMemory: deps.memory !== undefined,
    });

    let tail: Promise<unknown> = Promise.resolve();
    const conversation: Conversation = {
      userId,
      runner,
      serialize<T>(work: () => Promise<T>): Promise<T> {
        // An die Kette hängen, und zwar auch dann, wenn der Vorgänger scheitert: `catch`
        // macht aus dem Fehler des einen keinen Stillstand für alle folgenden. Der Fehler
        // selbst geht an seinen eigenen Aufrufer zurück, hier wird nichts geschluckt.
        const result = tail.then(work, work);
        tail = result.catch(() => undefined);
        return result;
      },
    };
    conversations.set(userId, conversation);
    return conversation;
  }

  return {
    async of(userId: string): Promise<Conversation> {
      const known = conversations.get(userId);
      if (known) return known;

      const inFlight = building.get(userId);
      if (inFlight) return inFlight;

      const started = build(userId).finally(() => building.delete(userId));
      building.set(userId, started);
      return started;
    },

    open(): Conversation[] {
      return [...conversations.values()];
    },

    async stopAll(reason: string): Promise<void> {
      // `stop()` schreibt `runtime.stopped`. Ein Läufer, der beim Herunterfahren übersehen
      // wird, hinterlässt ein `runtime.started` ohne Gegenstück — seit S04 das Kennzeichen
      // eines abgestürzten Laufs, und damit eine Falschaussage über einen sauberen Stopp.
      const stopping = [...conversations.values()].map((entry) => entry.runner.stop(reason));
      conversations.clear();
      await Promise.allSettled(stopping);
    },
  };
}
