/**
 * Minimaltypen für den Orb (`kuronami-orb.mjs`) — nur, was `ui/praesenz/sphaere.ts` tatsächlich
 * aufruft. Die volle Beschreibung der Schnittstelle steht im Kopf des Moduls selbst; hier ist sie
 * bewusst schmal, damit eine Erweiterung dort nicht stillschweigend als geprüft gilt.
 */

export type OrbState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "working"
  | "attention"
  | "error"
  | "offline";

export interface KuronamiOrbOptions {
  name?: string;
  tagline?: string;
  caption?: boolean;
  agentList?: boolean;
  agentTags?: boolean;
  /** Kerndurchmesser als Anteil der kürzeren Container-Seite. */
  size?: number;
  offsetY?: number;
  quality?: "high" | "medium" | "low";
  drowseAfter?: number;
}

export interface OrbAgentInfo {
  id?: string;
  type?: string;
  name?: string;
  description?: string;
}

export declare class KuronamiOrb extends EventTarget {
  /** Wirft, wenn sich kein WebGL2-Kontext öffnen lässt (three r170 kennt kein WebGL1 mehr). */
  constructor(container: HTMLElement, options?: KuronamiOrbOptions);
  readonly state: OrbState;
  readonly renderer: { forceContextLoss(): void };
  setState(state: OrbState, options?: { detail?: string; force?: boolean }): void;
  pulse(strength?: number): void;
  flash(color?: string | null, strength?: number): void;
  bindInput(el: HTMLElement): () => void;
  addAgent(info?: OrbAgentInfo): string;
  updateAgent(id: string, patch?: { activity?: string; description?: string }): void;
  completeAgent(id: string, options?: { status?: "done" | "error" | "stopped"; summary?: string }): void;
  dispose(): void;
}

/** Die Farbe eines Agenten-Satelliten — dieselbe für denselben Namen. */
export declare function agentColor(type?: string): string;
