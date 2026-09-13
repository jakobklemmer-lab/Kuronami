import { emblemMarkup } from "../emblem.js";
import { icon } from "../icons.js";
import { detachView, shouldDetachOnDragEnd } from "../router/detach.js";
import { ROUTE_IDS, type RouteId } from "../router/router.js";
import type { Toast } from "../toast.js";
import { loadSidebarCollapsed, saveSidebarCollapsed } from "./collapse.js";

/**
 * Die Seitenleiste (S-Zwischenschub, Punkte 1, 2, 4). Drei Dinge in einem Modul, weil sie
 * dieselbe Markup-Struktur teilen: das Emblem, das Ein-/Ausklappen und das native
 * HTML5-Drag-and-Drop fuers Abdocken.
 *
 * **Abdocken:** `dragend` auf einem Sidebar-Eintrag prueft `dataTransfer.dropEffect` — "none"
 * heisst, der Drop ist auf keiner registrierten Dropzone innerhalb der App gelandet (die
 * Seitenleiste selbst registriert sich per `dragover`/`drop` als gueltiges Ziel, damit ein Drop
 * zurueck auf sich selbst nicht als Abdocken zaehlt). Die eigentliche Entscheidung
 * (`shouldDetachOnDragEnd`) und das Oeffnen (`detachView`) stehen in `ui/router/detach.ts` —
 * dieses Modul kennt nur die DOM-Geste, nicht `window.open` selbst.
 */

const NAV_ITEMS: { route: RouteId; label: string }[] = [
  { route: "home", label: "Home" },
  { route: "mail", label: "Mail" },
  { route: "calendar", label: "Calendar" },
  { route: "trading", label: "Trading" },
  { route: "research", label: "Research" },
  { route: "files", label: "Files" },
  { route: "system", label: "System" },
];

export interface SidebarHandle {
  el: HTMLElement;
  setActive(route: RouteId): void;
  setConnectionStatus(status: "connecting" | "open" | "closed", attempts: number): void;
}

export interface SidebarContext {
  navigate(route: RouteId): void;
  toast: Toast;
}

const STATUS_LABEL: Record<string, string> = {
  connecting: "verbindet",
  open: "verbunden",
  closed: "getrennt",
};

export function mountSidebar(root: HTMLElement, ctx: SidebarContext): SidebarHandle {
  root.innerHTML = `
    <div class="sidebar__head">
      <button type="button" class="sidebar__brand" data-route="home" draggable="true" aria-label="Home">
        ${emblemMarkup("sidebar__emblem")}
        <span class="sidebar__name">Kuronami</span>
      </button>
      <button type="button" class="sidebar__collapse" data-role="collapse-toggle" title="Ein-/Ausklappen (Strg/Cmd+B)" aria-label="Seitenleiste ein-/ausklappen">
        ${icon("collapse")}
      </button>
    </div>

    <nav class="sidebar__nav" aria-label="Bereiche">
      ${NAV_ITEMS.map(
        (item) => `
          <button type="button" class="sidebar__link" data-route="${item.route}" draggable="true">
            <span class="sidebar__icon">${icon(item.route)}</span>
            <span class="sidebar__label">${item.label}</span>
          </button>
        `,
      ).join("")}
    </nav>

    <div class="sidebar__foot">
      <button type="button" class="sidebar__link" data-route="settings" draggable="true">
        <span class="sidebar__icon">${icon("settings")}</span>
        <span class="sidebar__label">Settings</span>
      </button>
      <div class="sidebar__status">
        <span class="sidebar__dot" data-role="connection-dot" data-status="closed"></span>
        <span class="sidebar__label" data-role="connection-label">getrennt</span>
      </div>
    </div>
  `;

  // ---------------------------------------------------------------------
  // Einklappen (Punkt 2): persistiert, Tastenkuerzel, kein Sprung im Inhaltsbereich (der
  // Uebergang ist reines CSS auf `--sidebar-width`, siehe `ui/styles/shell.css`).
  // ---------------------------------------------------------------------
  function setCollapsed(collapsed: boolean): void {
    root.dataset.collapsed = collapsed ? "true" : "false";
    saveSidebarCollapsed(collapsed);
  }
  setCollapsed(loadSidebarCollapsed());

  root.querySelector('[data-role="collapse-toggle"]')?.addEventListener("click", () => {
    setCollapsed(root.dataset.collapsed !== "true");
  });

  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === "b") {
      event.preventDefault();
      setCollapsed(root.dataset.collapsed !== "true");
    }
  });

  // ---------------------------------------------------------------------
  // Navigation per Klick (Punkt 4a) — ein echter Drag unterbricht den folgenden `click` von
  // selbst (Browser-Verhalten), es braucht keine eigene Unterscheidung hier.
  // ---------------------------------------------------------------------
  root.addEventListener("click", (event) => {
    const link = (event.target as HTMLElement).closest<HTMLElement>("[data-route]");
    if (!link) return;
    const route = link.dataset.route;
    if (route && (ROUTE_IDS as readonly string[]).includes(route)) {
      ctx.navigate(route as RouteId);
    }
  });

  // ---------------------------------------------------------------------
  // Abdocken per natives Drag-and-Drop (Punkt 4b).
  // ---------------------------------------------------------------------
  let draggingRoute: RouteId | null = null;

  root.addEventListener("dragstart", (event) => {
    const link = (event.target as HTMLElement).closest<HTMLElement>("[data-route]");
    if (!link) return;
    draggingRoute = link.dataset.route as RouteId;
    event.dataTransfer?.setData("text/plain", draggingRoute);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  });

  // Die Seitenleiste registriert sich selbst als gueltige Dropzone — ein Drop zurueck auf sich
  // selbst (die Geste abgebrochen, der Eintrag faellt auf seinen Platz zurueck) ist kein
  // Abdocken.
  root.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  });
  root.addEventListener("drop", (event) => {
    event.preventDefault();
  });

  root.addEventListener("dragend", (event) => {
    const route = draggingRoute;
    draggingRoute = null;
    if (!route) return;
    const dropEffect = event.dataTransfer?.dropEffect ?? "none";
    if (!shouldDetachOnDragEnd(dropEffect)) return;
    detachView(route, {
      onBlocked: () =>
        ctx.toast.show(
          "Das Fenster wurde vom Browser blockiert — Popups für diese Seite erlauben.",
        ),
    });
  });

  return {
    el: root,
    setActive(route: RouteId): void {
      for (const link of root.querySelectorAll<HTMLElement>("[data-route]")) {
        const isActive = link.dataset.route === route;
        link.classList.toggle(
          "sidebar__link--active",
          isActive && link.classList.contains("sidebar__link"),
        );
        if (isActive) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      }
    },
    setConnectionStatus(status, attempts): void {
      const dot = root.querySelector<HTMLElement>('[data-role="connection-dot"]');
      const label = root.querySelector<HTMLElement>('[data-role="connection-label"]');
      if (dot) dot.dataset.status = status;
      if (label) {
        label.textContent =
          status === "connecting" && attempts > 0
            ? `${STATUS_LABEL.connecting} (${attempts})`
            : (STATUS_LABEL[status] ?? status);
      }
    },
  };
}
