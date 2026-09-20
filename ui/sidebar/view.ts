import { emblemMarkup } from "../emblem.js";
import { icon } from "../icons.js";
import { detachView, shouldDetachOnDragEnd } from "../router/detach.js";
import { ROUTE_IDS, type RouteId } from "../router/router.js";
import type { Toast } from "../toast.js";
import { loadSidebarCollapsed, saveSidebarCollapsed } from "./collapse.js";

/**
 * Die Seitenleiste nach der Bildvorlage: Emblem und Wortmarke oben, darunter die sieben Bereiche
 * als vollbreite Zeilen mit Akzentbalken auf dem aktiven Eintrag, ganz unten die Mic-Pille
 * („Listening …") und die Verbindungszeile („System Online").
 *
 * **„System" steht bewusst nicht in der Navigation** — in der Vorlage gibt es den Eintrag nicht.
 * Die echte Läufe-/Freigaben-Ansicht (S22–S24) bleibt trotzdem erreichbar: über den Pfeil der
 * System-Karte auf der Startseite und über die Verbindungszeile hier unten. Beides führt auf
 * `#/system`.
 *
 * Abdocken (Punkt 4b) und Einklappen (Punkt 2) bleiben unverändert erhalten; der Einklapp-
 * Schalter ist nur zurückhaltender geworden, weil die Vorlage keinen zeigt.
 */

const NAV_ITEMS: { route: RouteId; label: string }[] = [
  { route: "home", label: "Home" },
  { route: "mail", label: "Mail" },
  { route: "calendar", label: "Calendar" },
  { route: "trading", label: "Trading" },
  { route: "analysen", label: "Analysen" },
  { route: "strategien", label: "Strategien" },
  { route: "research", label: "Research" },
  { route: "files", label: "Files" },
  { route: "settings", label: "Settings" },
];

export interface SidebarHandle {
  el: HTMLElement;
  /** Der Knoten, in den `ui/mic/button.ts` den Mic-Schalter rendert. */
  micHost: HTMLElement;
  setActive(route: RouteId): void;
  setConnectionStatus(status: "connecting" | "open" | "closed", attempts: number): void;
}

export interface SidebarContext {
  navigate(route: RouteId): void;
  toast: Toast;
}

const STATUS_LABEL: Record<string, string> = {
  connecting: "System verbindet",
  open: "System Online",
  closed: "System Offline",
};

export function mountSidebar(root: HTMLElement, ctx: SidebarContext): SidebarHandle {
  root.innerHTML = `
    <div class="sidebar__head">
      <button type="button" class="sidebar__brand" data-route="home" draggable="true" aria-label="Home">
        ${emblemMarkup("sidebar__emblem")}
        <span class="sidebar__name">Kuronami</span>
      </button>
      <button type="button" class="sidebar__collapse" data-role="collapse-toggle"
        title="Ein-/Ausklappen (Strg/Cmd+B)" aria-label="Seitenleiste ein-/ausklappen">
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
      <div data-role="mic-host"></div>
      <button type="button" class="sidebar__status" data-role="connection" aria-label="System öffnen">
        <span class="sidebar__dot" data-role="connection-dot" data-status="closed"></span>
        <span class="sidebar__label" data-role="connection-label">System Offline</span>
        ${icon("chevron", { className: "sidebar__status-chevron" })}
      </button>
    </div>
  `;

  // ---------------------------------------------------------------------
  // Einklappen (Punkt 2)
  // ---------------------------------------------------------------------
  function setCollapsed(collapsed: boolean): void {
    root.dataset.collapsed = collapsed ? "true" : "false";
    saveSidebarCollapsed(collapsed);
    // Die Uhr auf der Startseite steht mittig im **Fenster**, nicht im Inhaltsbereich — sie
    // braucht die aktuelle Breite, um beim Einklappen mitzuwandern statt zu springen.
    document.documentElement.style.setProperty(
      "--sidebar-current",
      collapsed ? "var(--sidebar-width-collapsed)" : "var(--sidebar-width)",
    );
  }
  setCollapsed(loadSidebarCollapsed());

  root.querySelector('[data-role="collapse-toggle"]')?.addEventListener("click", () => {
    setCollapsed(root.dataset.collapsed !== "true");
  });

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
      event.preventDefault();
      setCollapsed(root.dataset.collapsed !== "true");
    }
  });

  // ---------------------------------------------------------------------
  // Navigation (Punkt 4a)
  // ---------------------------------------------------------------------
  root.addEventListener("click", (event) => {
    const link = (event.target as HTMLElement).closest<HTMLElement>("[data-route]");
    if (link) {
      const route = link.dataset.route;
      if (route && (ROUTE_IDS as readonly string[]).includes(route)) ctx.navigate(route as RouteId);
      return;
    }
    if ((event.target as HTMLElement).closest('[data-role="connection"]')) ctx.navigate("system");
  });

  // ---------------------------------------------------------------------
  // Abdocken (Punkt 4b)
  // ---------------------------------------------------------------------
  let draggingRoute: RouteId | null = null;

  root.addEventListener("dragstart", (event) => {
    const link = (event.target as HTMLElement).closest<HTMLElement>("[data-route]");
    if (!link) return;
    draggingRoute = link.dataset.route as RouteId;
    event.dataTransfer?.setData("text/plain", draggingRoute);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  });

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
    if (!shouldDetachOnDragEnd(event.dataTransfer?.dropEffect ?? "none")) return;
    detachView(route, {
      onBlocked: () =>
        ctx.toast.show(
          "Das Fenster wurde vom Browser blockiert — Popups für diese Seite erlauben.",
        ),
    });
  });

  const micHost = root.querySelector<HTMLElement>('[data-role="mic-host"]') as HTMLElement;

  return {
    el: root,
    micHost,
    setActive(route: RouteId): void {
      for (const link of root.querySelectorAll<HTMLElement>(".sidebar__link")) {
        const isActive = link.dataset.route === route;
        link.classList.toggle("sidebar__link--active", isActive);
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
