import { icon } from "../icons.js";
import { SETTINGS_SECTION_IDS, type SettingsSectionId } from "../router/router.js";
import { loadToken, saveToken } from "../settings.js";
import {
  BUILTIN_BACKGROUNDS,
  PALETTE_APPLIED_EVENT,
  applyBackground,
  readImageFile,
  resizeImageDataUrl,
} from "../theme/background.js";
import { APP_VERSION } from "../version.js";
import type { View, ViewContext } from "../views/types.js";
import {
  type KuronamiSettings,
  type RiskLevel,
  loadSettings,
  settingsBus,
  updateSettingsSection,
} from "./store.js";

/**
 * Die Einstellungsseite (S-Zwischenschub, Punkt 5): eigenstaendige Ansicht mit linker
 * Abschnittsnavigation, sieben Abschnitte wie im Auftrag benannt. Jede Aenderung wird sofort
 * über `updateSettingsSection` persistiert (`ui/settings/store.ts`) — kein "Speichern"-Knopf,
 * kein Zwischenzustand, der beim Verlassen verloren gehen könnte.
 *
 * **Wo die dahinterliegende Funktion noch nicht existiert, bleibt das Feld sichtbar, aber
 * deaktiviert**, mit einem kurzen Hinweis, der auf die tatsaechliche (heute serverseitige oder
 * noch ungebaute) Stelle zeigt — nie stillschweigend weggelassen.
 */

const SECTION_LABEL: Record<SettingsSectionId, string> = {
  appearance: "Erscheinungsbild",
  models: "Modelle",
  approvals: "Freigaben",
  memory: "Gedächtnis",
  integrations: "Integrationen",
  speech: "Sprache",
  system: "System",
};

const RISK_LEVELS: RiskLevel[] = ["read", "soft_write", "hard_write", "destructive"];
const RISK_LABEL: Record<RiskLevel, string> = {
  read: "Lesen",
  soft_write: "Weiches Schreiben (eigene Ablage)",
  hard_write: "Hartes Schreiben (fremdes Gebiet)",
  destructive: "Zerstörerisch",
};

function disabledHint(text: string): string {
  return `<p class="field__hint field__hint--disabled">${text}</p>`;
}

/** Die tatsaechlich gerade wirksame Akzentfarbe (aus `ui/theme/palette.ts` abgeleitet und auf
 * `:root` geschrieben) — das Farbfeld zeigt diese, solange kein manueller Wert gesetzt ist,
 * statt eines geratenen Platzhalters, der von der echten Farbe abweichen könnte. */
function currentAccent(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  return value.length > 0 ? value : "#61a0c9";
}

function renderAppearance(settings: KuronamiSettings): string {
  const bg = settings.appearance.background;
  const isBuiltin = (id: "lake" | "void") => bg.kind === "builtin" && bg.id === id;
  return `
    <section class="settings-section" aria-labelledby="section-appearance-title">
      <h2 class="settings-section__title" id="section-appearance-title">Erscheinungsbild</h2>

      <div class="field">
        <span class="field__label">Hintergrund</span>
        <div class="background-choices">
          <button type="button" class="background-choice${isBuiltin("lake") ? " background-choice--active" : ""}" data-bg="lake">
            <span class="background-choice__swatch background-choice__swatch--lake"></span>
            ${BUILTIN_BACKGROUNDS.lake.label}
          </button>
          <button type="button" class="background-choice${isBuiltin("void") ? " background-choice--active" : ""}" data-bg="void">
            <span class="background-choice__swatch background-choice__swatch--void"></span>
            ${BUILTIN_BACKGROUNDS.void.label}
          </button>
          <label class="background-choice background-choice--upload">
            ${icon("upload", { className: "background-choice__upload-icon" })}
            Eigenes Bild
            <input type="file" accept="image/*" data-role="background-upload" hidden />
          </label>
        </div>
        <p class="field__hint" data-role="background-status">${
          bg.kind === "custom" ? `Eigenes Bild aktiv: ${bg.label}` : ""
        }</p>
      </div>

      <div class="field">
        <label class="field__label" for="setting-theme">Theme</label>
        <select class="field__control" id="setting-theme" data-role="theme">
          <option value="dark" ${settings.appearance.theme === "dark" ? "selected" : ""}>Dunkel</option>
          <option value="system" ${settings.appearance.theme === "system" ? "selected" : ""}>Folgt Systemeinstellung</option>
        </select>
      </div>

      <div class="field">
        <label class="field__label" for="setting-accent">Akzentfarbe</label>
        <div class="accent-row">
          <input type="color" class="field__control field__control--color" id="setting-accent" data-role="accent"
            value="${settings.appearance.accentOverride ?? currentAccent()}" />
          <button type="button" class="field__reset" data-role="accent-reset">Vom Hintergrund ableiten</button>
        </div>
        <p class="field__hint">${settings.appearance.accentOverride ? "Von Hand gesetzt." : "Wird aus dem Hintergrundbild abgeleitet (Sättigung gedeckelt, Kontrast geprüft)."}</p>
      </div>

      <div class="field">
        <label class="field__label" for="setting-density">Dichte der Darstellung</label>
        <select class="field__control" id="setting-density" data-role="density">
          <option value="comfortable" ${settings.appearance.density === "comfortable" ? "selected" : ""}>Komfortabel</option>
          <option value="compact" ${settings.appearance.density === "compact" ? "selected" : ""}>Kompakt</option>
        </select>
      </div>
    </section>
  `;
}

function renderModels(settings: KuronamiSettings): string {
  return `
    <section class="settings-section" aria-labelledby="section-models-title">
      <h2 class="settings-section__title" id="section-models-title">Modelle</h2>
      <div class="field">
        <label class="field__label" for="setting-routine-model">Standardmodell für Routine</label>
        <input class="field__control" id="setting-routine-model" type="text" value="${settings.models.routineModel ?? ""}" placeholder="z. B. claude-haiku-4-5" disabled />
        ${disabledHint("Routing läuft serverseitig über runtime/model/router.ts — noch keine Steuerung von hier.")}
      </div>
      <div class="field">
        <label class="field__label" for="setting-architecture-model">Standardmodell für Architektur</label>
        <input class="field__control" id="setting-architecture-model" type="text" value="${settings.models.architectureModel ?? ""}" placeholder="z. B. claude-opus-5" disabled />
        ${disabledHint("Dieselbe Anbindung wie oben — beide Felder sind vorbereitet, aber noch nicht verdrahtet.")}
      </div>
    </section>
  `;
}

function renderApprovals(settings: KuronamiSettings): string {
  return `
    <section class="settings-section" aria-labelledby="section-approvals-title">
      <h2 class="settings-section__title" id="section-approvals-title">Freigaben</h2>
      <div class="field">
        <label class="field__label" for="setting-auto-approve">Ohne Rückfrage erlaubt bis Risikostufe</label>
        <select class="field__control" id="setting-auto-approve" disabled>
          ${RISK_LEVELS.map((level) => `<option value="${level}" ${settings.approvals.autoApproveUpTo === level ? "selected" : ""}>${RISK_LABEL[level]}</option>`).join("")}
        </select>
        ${disabledHint("Risikostufen und Freigaberegeln laufen über die Policy-Engine (policy/engine.ts) serverseitig — keine Steuerung von hier.")}
      </div>
    </section>
  `;
}

function renderMemory(): string {
  return `
    <section class="settings-section" aria-labelledby="section-memory-title">
      <h2 class="settings-section__title" id="section-memory-title">Gedächtnis</h2>
      <div class="field">
        <label class="field__label" for="setting-memory-location">Ablageort</label>
        <input class="field__control" id="setting-memory-location" type="text" value="memory/ (eigenes Git-Repo)" disabled />
        ${disabledHint("Siehe docs/GEDAECHTNIS.md — der Ort ist fest, keine Verlegung von hier.")}
      </div>
      <div class="field">
        <button class="field__button" type="button" disabled>Kompaktierung jetzt anstoßen</button>
        ${disabledHint("Kompaktierung läuft automatisch als Teil des Loops (context/compaction.ts) — kein manueller Anstoß von hier.")}
      </div>
      <div class="field">
        <button class="field__button" type="button" disabled>Index neu aufbauen</button>
        ${disabledHint("tools/memory/index-db.ts hat noch keinen erreichbaren Neuaufbau-Endpunkt.")}
      </div>
    </section>
  `;
}

function renderIntegrations(settings: KuronamiSettings): string {
  return `
    <section class="settings-section" aria-labelledby="section-integrations-title">
      <h2 class="settings-section__title" id="section-integrations-title">Integrationen</h2>
      <div class="field">
        <label class="field__label" for="setting-n8n">n8n-Endpunkt</label>
        <input class="field__control" id="setting-n8n" type="text" value="${settings.integrations.n8nEndpoint ?? ""}" placeholder="N8N_WEBHOOK_URL" disabled />
        ${disabledHint("Wird über die Umgebungsvariable N8N_WEBHOOK_URL (.env) gesetzt, nicht von hier.")}
      </div>
      <div class="field">
        <span class="field__label">Verbundene Dienste</span>
        <ul class="service-list">
          <li class="service-list__row"><span>Slack</span><span class="service-list__status">Events-API-Webhook (S26)</span></li>
          <li class="service-list__row"><span>Telegram</span><span class="service-list__status">Long-Polling</span></li>
          <li class="service-list__row"><span>MCP</span><span class="service-list__status">Mechanismus gebaut, kein Server verkabelt (S27)</span></li>
        </ul>
        <p class="field__hint">Nur zur Ansicht — Verwaltung läuft über die jeweilige Umgebungsvariable, nicht von hier.</p>
      </div>
    </section>
  `;
}

function renderSpeech(): string {
  return `
    <section class="settings-section" aria-labelledby="section-speech-title">
      <h2 class="settings-section__title" id="section-speech-title">Sprache</h2>
      ${disabledHint("Die Sprachschicht ist noch nicht gebaut (S30/S31 stehen in tasks.json als queued) — alle Felder hier sind vorbereitet, aber ohne Wirkung.")}
      <div class="field">
        <label class="field__label" for="setting-input-device">Eingabegerät</label>
        <select class="field__control" id="setting-input-device" disabled><option>Standardmikrofon</option></select>
      </div>
      <div class="field">
        <label class="field__label" for="setting-output-device">Ausgabegerät</label>
        <select class="field__control" id="setting-output-device" disabled><option>Standardlautsprecher</option></select>
      </div>
      <div class="field">
        <label class="field__label" for="setting-wake-word">Wake Word</label>
        <input class="field__control" id="setting-wake-word" type="text" value="Kuronami" disabled />
      </div>
      <div class="field field--row">
        <label class="field__label" for="setting-barge-in">Barge-in (unterbrechen während der Wiedergabe)</label>
        <input class="field__control" id="setting-barge-in" type="checkbox" disabled />
      </div>
    </section>
  `;
}

function renderSystem(): string {
  const token = loadToken() ?? "";
  return `
    <section class="settings-section" aria-labelledby="section-system-title">
      <h2 class="settings-section__title" id="section-system-title">System</h2>
      <div class="field">
        <span class="field__label">Version</span>
        <p class="field__static">${APP_VERSION}</p>
      </div>
      <div class="field">
        <label class="field__label" for="setting-token">Verbindungs-Token (GATEWAY_WEB_TOKEN)</label>
        <input class="field__control" id="setting-token" type="password" autocomplete="off" value="${token}" placeholder="Token einfügen" />
        <p class="field__hint">Für <code>/runs</code> und <code>/channels/web/*</code> am Gateway — in <code>localStorage</code> dieses Browserprofils, nie an Kuronami selbst gerichtet.</p>
        <span class="field__status" data-role="token-status"></span>
      </div>
      <div class="field">
        <button class="field__button" type="button" disabled>Logs öffnen</button>
        ${disabledHint("Kein Log-Betrachter in der Oberfläche — Logs stehen in der Konsole des jeweiligen Prozesses (pnpm dev / pnpm gateway / …).")}
      </div>
      <div class="field">
        <button class="field__button" type="button" disabled>Neustart</button>
        ${disabledHint("Kein Fernsteuerungs-Endpunkt für einen Neustart.")}
      </div>
      <div class="field">
        <span class="field__label">Mic-Zustand (Demo)</span>
        <button class="field__button" type="button" data-role="mic-cycle">Nächsten Zustand zeigen</button>
        <p class="field__hint">Schaltet die eine Zustandsquelle (<code>ui/mic/state.ts</code>) durch alle sechs Agentenzustände — vorerst gegen Mock, bis eine echte Spracherkennung (S30/S31) dahintersteht.</p>
      </div>
    </section>
  `;
}

const SECTION_RENDER: Record<SettingsSectionId, (settings: KuronamiSettings) => string> = {
  appearance: renderAppearance,
  models: renderModels,
  approvals: renderApprovals,
  memory: renderMemory,
  integrations: renderIntegrations,
  speech: renderSpeech,
  system: renderSystem,
};

export const settingsView: View = {
  mount(container: HTMLElement, ctx: ViewContext) {
    const section = ctx.section ?? "appearance";
    const settings = loadSettings();

    container.innerHTML = `
      <div class="settings-view">
        <nav class="settings-nav" aria-label="Einstellungsabschnitte">
          ${SETTINGS_SECTION_IDS.map(
            (id) => `
              <button type="button" class="settings-nav__link${id === section ? " settings-nav__link--active" : ""}" data-section="${id}">
                ${SECTION_LABEL[id]}
              </button>
            `,
          ).join("")}
        </nav>
        <div class="settings-content glass" data-role="content">
          ${SECTION_RENDER[section](settings)}
        </div>
      </div>
    `;

    container.querySelector('[data-role="content"]')?.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;

      const bgButton = target.closest<HTMLElement>("[data-bg]");
      if (bgButton) {
        const id = bgButton.dataset.bg as "lake" | "void";
        const next = updateSettingsSection("appearance", { background: { kind: "builtin", id } });
        settingsBus.emit(next);
        ctx.navigate("settings", "appearance");
        return;
      }

      if (target.dataset.role === "accent-reset") {
        const next = updateSettingsSection("appearance", { accentOverride: null });
        settingsBus.emit(next);
        ctx.navigate("settings", "appearance");
        return;
      }

      if (target.dataset.role === "mic-cycle") {
        ctx.mic.cycle();
        return;
      }
    });

    container
      .querySelector('[data-role="background-upload"]')
      ?.addEventListener("change", (event) => {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;
        void (async () => {
          const raw = await readImageFile(file);
          const resized = await resizeImageDataUrl(raw);
          const next = updateSettingsSection("appearance", {
            background: { kind: "custom", dataUrl: resized, label: file.name },
          });
          settingsBus.emit(next);
          ctx.navigate("settings", "appearance");
        })();
      });

    container.querySelector('[data-role="theme"]')?.addEventListener("change", (event) => {
      const value = (event.target as HTMLSelectElement)
        .value as KuronamiSettings["appearance"]["theme"];
      const next = updateSettingsSection("appearance", { theme: value });
      settingsBus.emit(next);
    });

    container.querySelector('[data-role="accent"]')?.addEventListener("change", (event) => {
      const value = (event.target as HTMLInputElement).value;
      const next = updateSettingsSection("appearance", { accentOverride: value });
      settingsBus.emit(next);
    });

    container.querySelector('[data-role="density"]')?.addEventListener("change", (event) => {
      const value = (event.target as HTMLSelectElement)
        .value as KuronamiSettings["appearance"]["density"];
      const next = updateSettingsSection("appearance", { density: value });
      settingsBus.emit(next);
    });

    const tokenInput = container.querySelector<HTMLInputElement>("#setting-token");
    const tokenStatus = container.querySelector<HTMLElement>('[data-role="token-status"]');
    tokenInput?.addEventListener("change", () => {
      saveToken(tokenInput.value.trim());
      if (tokenStatus) {
        tokenStatus.textContent = "Gespeichert.";
        globalThis.setTimeout(() => {
          tokenStatus.textContent = "";
        }, 2000);
      }
    });

    for (const link of container.querySelectorAll<HTMLElement>(".settings-nav__link")) {
      link.addEventListener("click", () => {
        ctx.navigate("settings", link.dataset.section as SettingsSectionId);
      });
    }

    // Die Bildableitung laeuft asynchron (`ui/theme/background.ts`) — mountet diese Ansicht,
    // bevor sie fertig ist (z. B. gleich nach dem Laden der Seite), zeigt das Farbfeld sonst
    // kurz einen veralteten Wert. Ohne Wirkung ausserhalb des Erscheinungsbild-Abschnitts, da
    // dort kein Element mit dieser Rolle existiert.
    const onPaletteApplied = (): void => {
      const accentInput = container.querySelector<HTMLInputElement>('[data-role="accent"]');
      if (accentInput && !loadSettings().appearance.accentOverride) {
        accentInput.value = currentAccent();
      }
    };
    document.addEventListener(PALETTE_APPLIED_EVENT, onPaletteApplied);

    return () => {
      document.removeEventListener(PALETTE_APPLIED_EVENT, onPaletteApplied);
    };
  },
};

/** Wendet die Erscheinungsbild-Einstellungen auf die Hülle an — beim Start und bei jeder
 * Änderung (`settingsBus`). Von `ui/main.ts` aufgerufen, nicht von dieser Ansicht selbst: die
 * Hülle (Szene, Dichte) liegt ausserhalb jeder gerouteten Ansicht. */
export async function applyAppearance(
  settings: KuronamiSettings,
  sceneEl: HTMLElement,
): Promise<void> {
  await applyBackground(settings.appearance.background, sceneEl);
  if (settings.appearance.accentOverride) {
    document.documentElement.style.setProperty("--accent", settings.appearance.accentOverride);
  }
  document.body.dataset.density = settings.appearance.density;
  document.documentElement.dataset.theme = settings.appearance.theme === "dark" ? "dark" : "";
}
