import type { ApiClient } from "../api/client.js";
import type { EventBusClient } from "../events/bus.js";
import type { MicStateStore } from "../mic/state.js";
import type { RouteId, SettingsSectionId } from "../router/router.js";

/**
 * Der Vertrag, den jede Ansicht erfuellt (S-Zwischenschub, Punkt 4): "immer genau eine aktive
 * Ansicht im Hauptfenster" heisst, der Router (`ui/main.ts`) haelt genau eine gemountete Ansicht
 * gleichzeitig. `mount` bekommt einen leeren Container und gibt eine Aufraeumfunktion zurueck,
 * die beim Wechsel zur naechsten Ansicht aufgerufen wird (Timer stoppen, Abos abbestellen).
 *
 * DOM-beruehrender Code bleibt hier — wie in `ui/main.ts` seit S21 — bewusst ungetestet; die
 * eigentliche Logik jeder Ansicht (Formatierung, Datenformen) steht in eigenen, geprueften
 * Modulen (`ui/views/format.ts`, `ui/mock/data.ts`).
 */
export interface ViewContext {
  api: ApiClient;
  bus: EventBusClient;
  mic: MicStateStore;
  navigate(route: RouteId, section?: SettingsSectionId): void;
  detach(route: RouteId, section?: SettingsSectionId): void;
  /** Nur gesetzt, wenn `view === "settings"`. */
  section?: SettingsSectionId;
}

export interface View {
  mount(container: HTMLElement, ctx: ViewContext): () => void;
}
