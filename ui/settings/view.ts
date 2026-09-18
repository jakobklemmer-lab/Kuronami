import { ApiError } from "../api/client.js";
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
  apiKeys: "API-Keys",
  mcpServers: "MCP-Server",
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

/**
 * Die fünf Werte, um die es in S32 eigentlich ging (Anthropic, Deepgram, ElevenLabs) — bisher
 * nur von Hand in `.env` einzutragen. `VOICE_SESSION_TOKEN`/`VOICE_BRIDGE_TOKEN` bleiben hier
 * bewusst außen vor: der Name kollidiert sonst mit dem Sitzungs-Token unter "Sprache" oben, das
 * einen anderen Zweck hat (was der **Browser** beim Verbinden vorzeigt, nicht was der
 * **Sprachprozess** erwartet) — sie lassen sich über `runtime/secrets/env-file.ts` trotzdem
 * schon schreiben, nur noch nicht von dieser Seite aus.
 */
const API_KEY_FIELDS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "ANTHROPIC_API_KEY", label: "Anthropic API Key" },
  { key: "ANTHROPIC_MODEL", label: "Anthropic Modell (optional)" },
  { key: "DEEPGRAM_API_KEY", label: "Deepgram API Key" },
  { key: "ELEVENLABS_API_KEY", label: "ElevenLabs API Key" },
  { key: "ELEVENLABS_VOICE_ID", label: "ElevenLabs Voice ID" },
];

function renderApiKeys(): string {
  return `
    <section class="settings-section" aria-labelledby="section-api-keys-title">
      <h2 class="settings-section__title" id="section-api-keys-title">API-Keys</h2>
      <p class="field__hint">
        Landet in der <code>.env</code>, aus der der Gateway-Prozess läuft — gilt erst nach einem
        Neustart des jeweiligen Dienstes. Ein gespeicherter Wert geht nicht mehr im Klartext
        zurück, nur die letzten vier Zeichen zur Wiedererkennung.
      </p>
      <p class="field__hint" data-role="api-keys-status">Lädt …</p>
      ${API_KEY_FIELDS.map(
        (field) => `
          <div class="field">
            <label class="field__label" for="setting-key-${field.key}">${field.label}</label>
            <input class="field__control" id="setting-key-${field.key}" type="password" autocomplete="off"
              placeholder="Noch nicht geladen" data-role="api-key-input" data-key="${field.key}" disabled />
            <p class="field__hint" data-role="api-key-hint-${field.key}"></p>
          </div>
        `,
      ).join("")}
    </section>
  `;
}

/**
 * MCP-Server (Nachtrag 2026-09-16, `runtime/mcp/config-store.ts`). Nur stdio-Server (S27) —
 * `command`/`args`/`env` entsprechen `StdioMcpClientConfig`. Wie bei den API-Keys gilt eine
 * Änderung erst nach einem Neustart des Gateways: die Entdeckung der Fern-Tools läuft genau
 * einmal beim Katalogbau, nicht mitten im Betrieb.
 */
function renderMcp(): string {
  return `
    <section class="settings-section" aria-labelledby="section-mcp-title">
      <h2 class="settings-section__title" id="section-mcp-title">MCP-Server</h2>
      <p class="field__hint">
        Nur Server über stdio (ein Kindprozess, JSON-RPC über sein stdin/stdout) — kein
        HTTP/SSE-Transport. Jeder Server bekommt eine feste Risikostufe für <em>alle</em> seine
        Werkzeuge, unabhängig davon, was er selbst behauptet. Eine Änderung gilt erst nach einem
        Neustart des Gateways.
      </p>

      <ul class="mcp-server-list" data-role="mcp-server-list">
        <li class="field__hint">Lädt …</li>
      </ul>

      <form class="settings-section__form" data-role="mcp-server-form">
        <h3 class="settings-section__subtitle">Server hinzufügen</h3>
        <div class="field">
          <label class="field__label" for="mcp-new-id">Kennung</label>
          <input class="field__control" id="mcp-new-id" type="text" placeholder="z. B. filesystem" data-role="mcp-id" />
          <p class="field__hint">Nur Kleinbuchstaben, Ziffern, <code>_</code>, muss mit einem Buchstaben beginnen — wird Teil des Werkzeugnamens (<code>mcp.&lt;kennung&gt;__…</code>).</p>
        </div>
        <div class="field">
          <label class="field__label" for="mcp-new-command">Kommando</label>
          <input class="field__control" id="mcp-new-command" type="text" placeholder="z. B. npx" data-role="mcp-command" />
        </div>
        <div class="field">
          <label class="field__label" for="mcp-new-args">Argumente</label>
          <input class="field__control" id="mcp-new-args" type="text" placeholder="z. B. -y @modelcontextprotocol/server-filesystem /pfad" data-role="mcp-args" />
          <p class="field__hint">Leerzeichengetrennt.</p>
        </div>
        <div class="field">
          <label class="field__label" for="mcp-new-env">Umgebungsvariablen</label>
          <textarea class="field__control" id="mcp-new-env" rows="3" placeholder="EIN_SCHLUESSEL=wert&#10;EIN_ANDERER=wert" data-role="mcp-env"></textarea>
          <p class="field__hint">Eine <code>NAME=WERT</code>-Zeile je Variable. Geht nie zurück zum Browser — beim Bearbeiten eines bestehenden Servers leer lassen, um sie unverändert zu lassen.</p>
        </div>
        <div class="field">
          <label class="field__label" for="mcp-new-risk">Risikostufe (für jedes Werkzeug dieses Servers)</label>
          <select class="field__control" id="mcp-new-risk" data-role="mcp-risk">
            ${RISK_LEVELS.map((level) => `<option value="${level}">${RISK_LABEL[level]}</option>`).join("")}
          </select>
        </div>
        <div class="field field--row">
          <label class="field__label" for="mcp-new-repeatable">Wiederholbar</label>
          <input class="field__control" id="mcp-new-repeatable" type="checkbox" checked data-role="mcp-repeatable" />
        </div>
        <button class="field__button" type="submit" data-role="mcp-save">Speichern</button>
        <p class="field__hint" data-role="mcp-form-status"></p>
      </form>
    </section>
  `;
}

function renderSpeech(settings: KuronamiSettings): string {
  const endpoint = settings.speech.endpoint ?? "";
  const token = settings.speech.sessionToken ?? "";
  return `
    <section class="settings-section" aria-labelledby="section-speech-title">
      <h2 class="settings-section__title" id="section-speech-title">Sprache</h2>
      <div class="field">
        <label class="field__label" for="setting-voice-endpoint">Sprachprozess</label>
        <input class="field__control" id="setting-voice-endpoint" type="text" value="${endpoint}" placeholder="Automatisch" data-role="voice-endpoint" />
        <p class="field__hint">Der Pipecat-Prozess aus <code>voice/</code> (S30). Leer = automatisch: hinter dem Reverse-Proxy <code>wss://voice.&lt;diese Domain&gt;</code>, sonst <code>ws://&lt;dieser Host&gt;:8790</code>.</p>
      </div>
      <div class="field">
        <label class="field__label" for="setting-voice-token">Sitzungs-Token (VOICE_SESSION_TOKEN)</label>
        <input class="field__control" id="setting-voice-token" type="password" autocomplete="off" value="${token}" placeholder="Automatisch" data-role="voice-token" />
        <p class="field__hint">Leer = der Gateway liefert ihn aus seiner <code>.env</code>; nichts einzutragen ist der Normalfall. Ein Wert hier überstimmt ihn — nicht derselbe wie der Verbindungs-Token unter System: der gehört dem Gateway, dieser dem Sprachprozess.</p>
        <span class="field__status" data-role="voice-status"></span>
      </div>
      <div class="field field--row">
        <label class="field__label" for="setting-barge-in">Barge-in (unterbrechen während der Wiedergabe)</label>
        <input class="field__control" id="setting-barge-in" type="checkbox" checked disabled />
        ${disabledHint("Seit S31 immer an: die Pipeline unterbricht, sobald das VAD den Nutzer hört. Ein Schalter dafür wäre eine Wahl, die es im Sprachprozess nicht gibt.")}
      </div>
      <div class="field">
        <label class="field__label" for="setting-input-device">Eingabegerät</label>
        <select class="field__control" id="setting-input-device" disabled><option>Standardmikrofon</option></select>
        ${disabledHint("Die Gerätewahl liegt beim Browser — Kuronami nimmt, was dort als Standard eingestellt ist.")}
      </div>
      <div class="field">
        <label class="field__label" for="setting-output-device">Ausgabegerät</label>
        <select class="field__control" id="setting-output-device" disabled><option>Standardlautsprecher</option></select>
      </div>
      <div class="field">
        <label class="field__label" for="setting-wake-word">Wake Word</label>
        <input class="field__control" id="setting-wake-word" type="text" value="Kuronami" disabled />
        ${disabledHint("Kein Wake-Word gebaut: die Sitzung beginnt mit dem Mic-Knopf (oder Strg/Cmd+M), nicht mit einem Wort.")}
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
        <span class="field__label">Neustart</span>
        <button class="field__button" type="button" data-role="restart" data-service="gateway">Gateway</button>
        <button class="field__button" type="button" data-role="restart" data-service="ui">Oberfläche</button>
        <button class="field__button" type="button" data-role="restart" data-service="voice">Sprachschicht</button>
        <p class="field__hint">Ein geänderter API-Schlüssel gilt erst danach. Welcher Dienst: <code>ANTHROPIC_API_KEY</code> und die n8n-Werte liest der Gateway, <code>DEEPGRAM_API_KEY</code>/<code>ELEVENLABS_API_KEY</code> die Sprachschicht. Die Sprachschicht wird dabei neu <em>angelegt</em>, nicht nur neu gestartet — sonst behielte der Container seine alte Umgebung.</p>
        <span class="field__status" data-role="restart-status"></span>
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
  apiKeys: renderApiKeys,
  mcpServers: renderMcp,
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

    // Neustart der Dienste (Nachtrag 2026-09-16). Der Gateway startet sich selbst mit: seine
    // Antwort kommt noch, danach bricht die Verbindung ab — ein Fehler beim Nachfassen wäre
    // deshalb eine Falschmeldung, und die Statuszeile sagt stattdessen, was zu erwarten ist.
    const restartStatus = container.querySelector<HTMLElement>('[data-role="restart-status"]');
    const restartLabel: Record<string, string> = {
      gateway: "Gateway",
      ui: "Oberfläche",
      voice: "Sprachschicht",
    };
    for (const button of container.querySelectorAll<HTMLButtonElement>('[data-role="restart"]')) {
      button.addEventListener("click", () => {
        const service = button.dataset.service ?? "";
        const label = restartLabel[service] ?? service;
        if (restartStatus) restartStatus.textContent = `${label} wird neu gestartet …`;
        void ctx.api
          .post<{ service: string; started: boolean }>("/settings/restart", { service })
          .then(() => {
            if (!restartStatus) return;
            restartStatus.textContent =
              service === "gateway"
                ? "Gateway startet neu — die Karten sind für ein paar Sekunden ohne Verbindung."
                : `${label} neu gestartet.`;
          })
          .catch((error) => {
            if (restartStatus) restartStatus.textContent = describeApiKeyError(error);
          });
      });
    }

    // Sprachschicht (S30): Adresse und Sitzungsgeheimnis des Pipecat-Prozesses. Beide gelten
    // beim nächsten Druck auf den Mic-Knopf — der Controller liest sie bei jedem Start neu,
    // damit ein geänderter Wert nicht erst nach einem Neuladen greift.
    const voiceStatus = container.querySelector<HTMLElement>('[data-role="voice-status"]');
    function confirmSaved(): void {
      if (!voiceStatus) return;
      voiceStatus.textContent = "Gespeichert — gilt ab der nächsten Sprachsitzung.";
      globalThis.setTimeout(() => {
        voiceStatus.textContent = "";
      }, 2500);
    }

    const endpointInput = container.querySelector<HTMLInputElement>('[data-role="voice-endpoint"]');
    endpointInput?.addEventListener("change", () => {
      const value = endpointInput.value.trim();
      settingsBus.emit(
        updateSettingsSection("speech", { endpoint: value.length > 0 ? value : null }),
      );
      confirmSaved();
    });

    const voiceTokenInput = container.querySelector<HTMLInputElement>('[data-role="voice-token"]');
    voiceTokenInput?.addEventListener("change", () => {
      const value = voiceTokenInput.value.trim();
      settingsBus.emit(
        updateSettingsSection("speech", { sessionToken: value.length > 0 ? value : null }),
      );
      confirmSaved();
    });

    // API-Keys (S32-Nachtrag): läuft nur an, wenn die Sektion gerade gerendert ist — sonst
    // findet die Abfrage unten schlicht nichts und die Funktionen tun nichts, dasselbe Muster
    // wie bei den Sprache-Feldern oben.
    const apiKeyStatusHint = container.querySelector<HTMLElement>('[data-role="api-keys-status"]');
    const apiKeyInputs = container.querySelectorAll<HTMLInputElement>(
      '[data-role="api-key-input"]',
    );

    function describeApiKeyError(error: unknown): string {
      if (error instanceof ApiError) {
        if (error.status === "no_token")
          return "Kein Token hinterlegt — siehe Einstellungen › System.";
        if (error.status === 401) return "Token abgelehnt — in den Einstellungen › System prüfen.";
        if (error.status === 404)
          return "Schlüsselverwaltung ist auf diesem Gateway nicht eingerichtet.";
        return error.message;
      }
      return error instanceof Error ? error.message : String(error);
    }

    function apiKeyHintFor(key: string): HTMLElement | null {
      return container.querySelector<HTMLElement>(`[data-role="api-key-hint-${key}"]`);
    }

    async function loadApiKeyStatus(): Promise<void> {
      if (!apiKeyStatusHint || apiKeyInputs.length === 0) return;
      try {
        const data = await ctx.api.get<{
          keys: Record<string, { set: boolean; preview: string | null }>;
        }>("/settings/api-keys");
        apiKeyStatusHint.textContent = "";
        for (const input of apiKeyInputs) {
          input.disabled = false;
          const status = data.keys[input.dataset.key ?? ""];
          const hint = apiKeyHintFor(input.dataset.key ?? "");
          if (hint)
            hint.textContent = status?.set
              ? `Gesetzt (endet auf ${status.preview}).`
              : "Noch nicht gesetzt.";
        }
      } catch (error) {
        apiKeyStatusHint.textContent = describeApiKeyError(error);
      }
    }

    async function saveApiKey(input: HTMLInputElement): Promise<void> {
      const key = input.dataset.key ?? "";
      const value = input.value.trim();
      // Ein leeres Feld heißt "nichts eingetragen", nicht "löschen" — GET liefert nie den
      // Klartext zurück, ein leeres Feld kann also nicht "der bisherige Wert" bedeuten.
      if (value.length === 0) return;
      const hint = apiKeyHintFor(key);
      try {
        const data = await ctx.api.post<{
          keys: Record<string, { set: boolean; preview: string | null }>;
        }>("/settings/api-keys", { keys: { [key]: value } });
        input.value = "";
        const status = data.keys[key];
        if (hint) {
          hint.textContent = status?.set
            ? `Gespeichert (endet auf ${status.preview}) — gilt nach einem Neustart des Dienstes.`
            : "Gespeichert.";
        }
      } catch (error) {
        if (hint) hint.textContent = describeApiKeyError(error);
      }
    }

    for (const input of apiKeyInputs) {
      input.addEventListener("change", () => void saveApiKey(input));
    }
    void loadApiKeyStatus();

    // MCP-Server (Nachtrag 2026-09-16): läuft nur an, wenn die Liste gerade im DOM steht —
    // dasselbe "sonst tut die Abfrage unten schlicht nichts"-Muster wie bei den API-Keys oben.
    interface McpServerView {
      serverId: string;
      command: string;
      args: string[];
      envKeys: string[];
      risk: RiskLevel;
      repeatable: boolean;
      enabled: boolean;
    }
    const mcpListEl = container.querySelector<HTMLElement>('[data-role="mcp-server-list"]');
    const mcpForm = container.querySelector<HTMLFormElement>('[data-role="mcp-server-form"]');
    const mcpFormStatus = container.querySelector<HTMLElement>('[data-role="mcp-form-status"]');
    let mcpServersCache: McpServerView[] = [];

    function describeMcpError(error: unknown): string {
      if (error instanceof ApiError) {
        if (error.status === "no_token")
          return "Kein Token hinterlegt — siehe Einstellungen › System.";
        if (error.status === 401) return "Token abgelehnt — in den Einstellungen › System prüfen.";
        return error.message;
      }
      return error instanceof Error ? error.message : String(error);
    }

    function renderMcpList(): void {
      if (!mcpListEl) return;
      if (mcpServersCache.length === 0) {
        mcpListEl.innerHTML = '<li class="field__hint">Noch kein Server eingetragen.</li>';
        return;
      }
      mcpListEl.innerHTML = mcpServersCache
        .map(
          (s) => `
            <li class="mcp-server-list__row" data-server-id="${s.serverId}">
              <div class="mcp-server-list__main">
                <span class="mcp-server-list__id">${s.serverId}</span>
                <span class="mcp-server-list__cmd">${[s.command, ...s.args].join(" ")}</span>
                <span class="mcp-server-list__meta">${RISK_LABEL[s.risk]}${s.envKeys.length > 0 ? ` · Umgebung: ${s.envKeys.join(", ")}` : ""}</span>
              </div>
              <label class="mcp-server-list__toggle">
                <input type="checkbox" data-role="mcp-toggle-enabled" ${s.enabled ? "checked" : ""} />
                aktiv
              </label>
              <button type="button" class="field__button field__button--danger" data-role="mcp-delete">Entfernen</button>
            </li>
          `,
        )
        .join("");

      for (const row of mcpListEl.querySelectorAll<HTMLElement>("[data-server-id]")) {
        const serverId = row.dataset.serverId ?? "";
        row
          .querySelector('[data-role="mcp-toggle-enabled"]')
          ?.addEventListener("change", (event) => {
            const enabled = (event.target as HTMLInputElement).checked;
            const server = mcpServersCache.find((s) => s.serverId === serverId);
            if (!server) return;
            void ctx.api
              .post("/settings/mcp-servers", {
                serverId,
                command: server.command,
                risk: server.risk,
                enabled,
              })
              .then(() => loadMcpServers())
              .catch((error) => {
                if (mcpFormStatus) mcpFormStatus.textContent = describeMcpError(error);
              });
          });
        row.querySelector('[data-role="mcp-delete"]')?.addEventListener("click", () => {
          void ctx.api
            .delete(`/settings/mcp-servers/${encodeURIComponent(serverId)}`)
            .then(() => loadMcpServers())
            .catch((error) => {
              if (mcpFormStatus) mcpFormStatus.textContent = describeMcpError(error);
            });
        });
      }
    }

    async function loadMcpServers(): Promise<void> {
      if (!mcpListEl) return;
      try {
        const data = await ctx.api.get<{ servers: McpServerView[] }>("/settings/mcp-servers");
        mcpServersCache = data.servers;
        renderMcpList();
      } catch (error) {
        mcpListEl.innerHTML = `<li class="field__hint">${describeMcpError(error)}</li>`;
      }
    }

    /** `NAME=WERT` je Zeile, wie eine `.env` — leere Zeilen und Zeilen ohne `=` werden
     * übersprungen statt den Aufruf mit einer rätselhaften Fehlermeldung abzuweisen. */
    function parseEnvTextarea(value: string): Record<string, string> {
      const result: Record<string, string> = {};
      for (const line of value.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "" || !trimmed.includes("=")) continue;
        const index = trimmed.indexOf("=");
        const key = trimmed.slice(0, index).trim();
        const val = trimmed.slice(index + 1).trim();
        if (key.length > 0) result[key] = val;
      }
      return result;
    }

    mcpForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      const idInput = mcpForm.querySelector<HTMLInputElement>('[data-role="mcp-id"]');
      const commandInput = mcpForm.querySelector<HTMLInputElement>('[data-role="mcp-command"]');
      const argsInput = mcpForm.querySelector<HTMLInputElement>('[data-role="mcp-args"]');
      const envInput = mcpForm.querySelector<HTMLTextAreaElement>('[data-role="mcp-env"]');
      const riskSelect = mcpForm.querySelector<HTMLSelectElement>('[data-role="mcp-risk"]');
      const repeatableInput = mcpForm.querySelector<HTMLInputElement>(
        '[data-role="mcp-repeatable"]',
      );

      const serverId = idInput?.value.trim() ?? "";
      const command = commandInput?.value.trim() ?? "";
      if (serverId === "" || command === "") {
        if (mcpFormStatus) mcpFormStatus.textContent = "Kennung und Kommando sind erforderlich.";
        return;
      }
      const args = (argsInput?.value ?? "").split(/\s+/).filter((a) => a.length > 0);
      const envText = envInput?.value ?? "";
      const env = envText.trim().length > 0 ? parseEnvTextarea(envText) : undefined;

      if (mcpFormStatus) mcpFormStatus.textContent = "Speichert …";
      void ctx.api
        .post("/settings/mcp-servers", {
          serverId,
          command,
          args,
          env,
          risk: riskSelect?.value ?? "read",
          repeatable: repeatableInput?.checked ?? true,
        })
        .then(() => {
          if (mcpFormStatus) {
            mcpFormStatus.textContent = "Gespeichert — gilt nach einem Neustart des Gateways.";
          }
          if (idInput) idInput.value = "";
          if (commandInput) commandInput.value = "";
          if (argsInput) argsInput.value = "";
          if (envInput) envInput.value = "";
          return loadMcpServers();
        })
        .catch((error) => {
          if (mcpFormStatus) mcpFormStatus.textContent = describeMcpError(error);
        });
    });

    void loadMcpServers();

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
