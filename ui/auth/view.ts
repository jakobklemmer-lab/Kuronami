import { holeLage, melde } from "./anmeldung.js";
import { type Szene, type SzenenZustand, starteSzene } from "./szene.js";

/**
 * Die Anmeldemaske — die erste Fläche, die jemand sieht, der die Adresse kennt. Seit S47
 * (2026-09-26) nach Jakobs Entwurf: eine Nacht am Wasser, eine gezeichnete Szene
 * (`szene.ts`), Uhr und Gruß wie in der Präsenz, eine Stimme, die sagt, was gerade geschieht,
 * und eine Leiste mit Name und Passwort.
 *
 * Geblieben ist, was die Tür ausmacht:
 *
 *   * **Ein Bewohner.** Kein „Konto anlegen", kein „Passwort vergessen" — beides wären Türen,
 *     hinter denen niemand steht. Der Weg zurück führt über den Server (`pnpm passwort-setzen`).
 *   * **Der Name steht schon da** (seit 2026-09-26). `GET /auth/lage` nennt ihn jedem, der
 *     fragt; ihn abtippen zu lassen verschenkt nichts und kostet: ein Vertipper im Namen sähe
 *     hinter derselben Fehlerzeile genauso aus wie ein falsches Passwort.
 *   * **Die Ablehnung kommt vom Gateway, Wort für Wort.** Der Entwurf hatte eigene Sätze dafür
 *     („That key doesn't fit."); hier steht, was der Gateway sagt — auch bei einer Sperre nach
 *     Fehlversuchen und wenn er gar nicht antwortet. Eine eigene Sperre im Browser gibt es nicht:
 *     sie behauptete eine Grenze, die der Server nicht gezogen hat.
 *
 * Nach der Anmeldung legt sich der Schleier über die Szene, die Oberfläche baut sich darunter
 * auf, und die Maske geht als Ganzes — die Szene hält dabei an und nimmt ihre Horcher mit.
 */

export interface AnmeldeMaskeOptionen {
  baseUrl: string;
  /** Wird mit dem frischen Sitzungsticket aufgerufen. Danach räumt sich die Maske selbst ab. */
  onAngemeldet(token: string): void;
  /** Warum die Maske kommt — z. B. nach einer abgelaufenen Sitzung. Steht, wo sonst „Always
   * here." stünde. */
  grund?: string;
  fetchImpl?: typeof fetch;
}

const T = {
  morning: "Good morning",
  afternoon: "Good afternoon",
  evening: "Good evening",
  night: "Good night",
  idle: "Always here. Waiting for you.",
  hello: "Hello, {name}.",
  secret: "I'm not looking.",
  blind: "Eyes closed.",
  verifying: "Verifying…",
  welcome: "Welcome home, {name}.",
  askName: "Tell me who you are first.",
  askKey: "I need your key.",
  rate: "Too many attempts. Breathe — {s}s.",
  orb: ["Hm?", "Still here.", "Always working.", "Patience."],
  locked: "Locked",
  verifyingShort: "Verifying",
  unlocked: "Unlocked",
  show: "Show password",
  hide: "Hide password",
  secure: "Encrypted",
  local: "Local",
  insecure: "Not encrypted (HTTP)",
} as const;

/** Anzahl der Licht-Koi (= Agenten) in der Szene und der Punkte unten rechts. */
const AGENTEN = 6;

const GESEHEN_KEY = "kuronami.anmeldung.gesehen";

const fmt = (s: string, o: Record<string, string | number>): string =>
  s.replace(/\{(\w+)\}/g, (_m, k: string) => (o[k] === undefined ? "" : String(o[k])));
const pretty = (roh: string): string => {
  const s = roh.trim().slice(0, 24);
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Die Maske ohne Szene: dieselben Aufrufe, nichts zu sehen. Die Tür geht auch ohne Bild auf. */
const OHNE_SZENE: Szene = {
  setState() {},
  keystroke() {},
  handshake: () => sleep(300),
  success: () => sleep(300),
  fail() {},
  destroy() {},
};

const MARKUP = `
  <div class="an-world" aria-hidden="true">
    <div class="an-world__bg" data-role="bg"></div>
    <canvas class="an-world__scene" data-role="scene"></canvas>
    <div class="an-world__shade"></div>
    <div class="an-world__grain"></div>
  </div>

  <div class="an-layout">
    <header class="an-top">
      <div class="an-brand">
        <span class="an-brand__mark">黒</span>
        <span class="an-brand__name">KURONAMI</span>
      </div>
      <div class="an-lock">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg>
        <span data-role="lock-label">${T.locked}</span>
      </div>
    </header>

    <section class="an-hero">
      <p class="an-hero__date" data-role="date">&nbsp;</p>
      <p class="an-hero__clock" data-role="clock">--:--</p>
      <h1 class="an-hero__greet" data-role="greet">Welcome.</h1>
    </section>

    <div class="an-orb-slot"><div class="an-orb-anchor" data-role="orb-anchor"></div></div>

    <section class="an-voice" aria-hidden="true">
      <p class="an-voice__brand">KURONAMI</p>
      <p class="an-voice__line" data-role="voice"></p>
    </section>

    <main class="an-dock">
      <form class="an-pill" method="post" autocomplete="on" novalidate>
        <label class="an-seg an-seg--user">
          <span class="an-sr-only">Name</span>
          <svg class="an-seg__icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.5" r="3.6"/><path d="M4.8 19.5c1.2-3.4 4-5.1 7.2-5.1s6 1.7 7.2 5.1"/></svg>
          <input name="benutzer" type="text" autocomplete="username" autocapitalize="none"
                 autocorrect="off" spellcheck="false" placeholder="Name" required />
        </label>
        <span class="an-pill__divider" aria-hidden="true"></span>
        <label class="an-seg an-seg--pass">
          <span class="an-sr-only">Password</span>
          <svg class="an-seg__icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="12" r="3.6"/><path d="M11.6 12H20m-2.5 0v3m-3-3v2.2"/></svg>
          <input name="passwort" type="password" autocomplete="current-password"
                 placeholder="Password" required />
        </label>
        <button type="button" class="an-pill__eye" data-role="reveal" aria-label="${T.show}" aria-pressed="false">
          <svg class="eye-open" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/></svg>
          <svg class="eye-closed" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10c2.2 3 5.3 4.6 9 4.6s6.8-1.6 9-4.6M6.2 13.2 4.6 15.6m5.2-.4-.8 2.8m5.2-2.8.8 2.8m4.2-4.8 1.6 2.4"/></svg>
        </button>
        <button type="submit" class="an-pill__go" data-role="submit" aria-label="Unlock">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.2 19.5 5l-4.8 14.6-3.2-6.1-7-1.3Z"/><path d="m11.5 13.5 3.6-4.2"/></svg>
        </button>
        <span class="an-pill__ring" aria-hidden="true"></span>
      </form>

      <div class="an-chips">
        <span class="an-chip" data-role="chip-channel"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 5 6.3v5.2c0 4.3 3 7.7 7 9 4-1.3 7-4.7 7-9V6.3Z"/></svg><span></span></span>
        <span class="an-chip an-chip--warn" data-role="chip-caps" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 4.5 12H9v5h6v-5h4.5Z"/></svg><span>Caps Lock is on</span></span>
        <span class="an-chip an-chip--hint"><kbd>↵</kbd><span>to unlock</span></span>
      </div>
      <p class="an-sr-only" data-role="status" role="status" aria-live="polite"></p>
    </main>

    <footer class="an-foot" aria-hidden="true">
      <div class="an-presence">
        <span class="an-presence__dot"></span>
        <span class="an-presence__text"><b>Kuronami</b><em data-role="presence">${T.locked}</em></span>
      </div>
      <div class="an-agents"><span class="an-agents__label">Agents</span><span class="an-agents__dots" data-role="agent-dots"></span></div>
    </footer>
  </div>

  <div class="an-veil" data-role="veil" aria-hidden="true"></div>
`;

export function zeigeAnmeldung(host: HTMLElement, optionen: AnmeldeMaskeOptionen): () => void {
  const wurzel = document.createElement("div");
  wurzel.className = "anmeldung";
  wurzel.dataset.state = "boot";
  wurzel.innerHTML = MARKUP;
  host.appendChild(wurzel);

  const q = <E extends Element>(selektor: string): E => {
    const gefunden = wurzel.querySelector<E>(selektor);
    if (gefunden === null) throw new Error(`Die Anmeldemaske hat kein ${selektor}.`);
    return gefunden;
  };
  const rolle = <E extends Element>(name: string): E => q<E>(`[data-role="${name}"]`);

  const form = q<HTMLFormElement>("form");
  const user = q<HTMLInputElement>('input[name="benutzer"]');
  const pass = q<HTMLInputElement>('input[name="passwort"]');
  const reveal = rolle<HTMLButtonElement>("reveal");
  const submitBtn = rolle<HTMLButtonElement>("submit");
  const voiceEl = rolle<HTMLElement>("voice");
  const statusEl = rolle<HTMLElement>("status");
  const greetEl = rolle<HTMLElement>("greet");
  const clockEl = rolle<HTMLElement>("clock");
  const dateEl = rolle<HTMLElement>("date");
  const presenceEl = rolle<HTMLElement>("presence");
  const lockLabel = rolle<HTMLElement>("lock-label");
  const chipChannel = rolle<HTMLElement>("chip-channel");
  const chipCaps = rolle<HTMLElement>("chip-caps");
  const dotsEl = rolle<HTMLElement>("agent-dots");
  const veil = rolle<HTMLElement>("veil");
  const bg = rolle<HTMLElement>("bg");

  const REDUCED = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const IDLE = optionen.grund ?? T.idle;

  let state: SzenenZustand = "boot";
  let busy = false;
  let revealed = false;
  let fails = 0;
  let cooldownUntil = 0;
  let holdVoiceUntil = 0;
  let failUntil = 0;
  let abgeraeumt = false;

  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number): void => {
    const t = setTimeout(() => {
      timers.delete(t);
      if (!abgeraeumt) fn();
    }, ms);
    timers.add(t);
  };

  // Die Szene ist Bild, nicht Weg: kann sie nicht starten, geht die Tür trotzdem auf — und
  // der Grund steht in der Konsole.
  let szene: Szene = OHNE_SZENE;
  try {
    szene = starteSzene(
      {
        wurzel,
        canvas: rolle<HTMLCanvasElement>("scene"),
        hintergrund: bg,
        anker: rolle<HTMLElement>("orb-anchor"),
      },
      { agenten: AGENTEN, beimOrb: sprichVomOrb },
    );
  } catch (error) {
    console.error("[anmeldung] Die Szene konnte nicht starten.", error);
  }

  /* ── Texte ──────────────────────────────────────────────── */

  const secure = globalThis.location.protocol === "https:";
  const lokal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(globalThis.location.hostname);
  const kanal = chipChannel.querySelector("span");
  if (kanal) kanal.textContent = secure ? T.secure : lokal ? T.local : T.insecure;
  chipChannel.classList.toggle("an-chip--ok", secure);
  chipChannel.classList.toggle("an-chip--warn", !secure && !lokal);
  for (let i = 0; i < AGENTEN; i++) dotsEl.appendChild(document.createElement("i"));

  /* ── Uhr & Begrüßung ────────────────────────────────────── */

  const timeFmt = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const dateFmt = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  function tick(): void {
    const now = new Date();
    const h = now.getHours();
    clockEl.textContent = timeFmt.format(now);
    dateEl.textContent = dateFmt.format(now);
    const word = h < 5 ? T.night : h < 12 ? T.morning : h < 18 ? T.afternoon : T.evening;
    if (state !== "success") greetEl.textContent = `${word}.`;
  }

  /* ── Stimme des Orchestrators ───────────────────────────── */

  let voiceKey = "";
  let voiceText = "";
  let voiceTimer: ReturnType<typeof setTimeout> | null = null;
  function say(key: string, text: string, tone?: "warn" | "ok"): void {
    voiceText = text;
    if (key === voiceKey) {
      if (voiceTimer === null) voiceEl.textContent = voiceText;
      return;
    }
    voiceKey = key;
    voiceEl.classList.add("is-swap");
    if (voiceTimer !== null) clearTimeout(voiceTimer);
    voiceTimer = setTimeout(
      () => {
        voiceTimer = null;
        voiceEl.textContent = voiceText;
        voiceEl.classList.toggle("is-warn", tone === "warn");
        voiceEl.classList.toggle("is-ok", tone === "ok");
        voiceEl.classList.remove("is-swap");
      },
      REDUCED ? 0 : 220,
    );
  }
  function announce(text: string): void {
    statusEl.textContent = "";
    later(() => {
      statusEl.textContent = text;
    }, 40);
  }
  function voiceFor(name: SzenenZustand): void {
    const u = user.value.trim();
    if (name === "secret") say("secret", T.secret);
    else if (name === "blind") say("blind", T.blind);
    else if (name === "user" || name === "idle") {
      if (u) say("hello", fmt(T.hello, { name: pretty(u) }));
      else say("idle", IDLE);
    }
  }
  function sprichVomOrb(): void {
    if (busy || state === "success") return;
    const line = T.orb[Math.floor(Math.random() * T.orb.length)];
    say(`orb:${line}${Math.random()}`, line);
    hold(1800);
  }

  /* ── Zustände ───────────────────────────────────────────── */

  function setState(name: SzenenZustand): void {
    state = name;
    wurzel.dataset.state = name;
    szene.setState(name);
    if (Date.now() >= holdVoiceUntil) voiceFor(name);
  }
  function refocusState(): void {
    if (busy || state === "success" || Date.now() < failUntil) return;
    const a = document.activeElement;
    if (a === pass || a === reveal) setState(revealed ? "blind" : "secret");
    else if (a === user) setState("user");
    else setState("idle");
  }
  function lightDots(on: number): void {
    Array.from(dotsEl.children).forEach((d, i) => d.classList.toggle("on", i < on));
  }
  function shake(): void {
    form.classList.remove("is-error");
    void form.offsetWidth; // Neustart der Animation erzwingen
    form.classList.add("is-error");
    later(() => form.classList.remove("is-error"), 700);
  }
  function hold(ms: number): void {
    holdVoiceUntil = Date.now() + ms;
    later(() => {
      if (!busy && state !== "success" && Date.now() >= holdVoiceUntil) voiceFor(state);
    }, ms + 30);
  }
  function softWarn(msg: string): void {
    say(`warn:${msg}`, msg, "warn");
    hold(2000);
    shake();
  }

  /* ── Eingaben ───────────────────────────────────────────── */

  const measure = document.createElement("canvas").getContext("2d");
  function caretPoint(input: HTMLInputElement): { x: number; y: number } {
    const r = input.getBoundingClientRect();
    const mitte = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    if (measure === null) return mitte;
    const cs = getComputedStyle(input);
    measure.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const pos = input.selectionEnd ?? input.value.length;
    const text = input.type === "password" ? "•".repeat(pos) : input.value.slice(0, pos);
    const ls = Number.parseFloat(cs.letterSpacing) || 0;
    const w = measure.measureText(text).width + ls * pos - input.scrollLeft;
    return { x: r.left + Math.max(0, Math.min(w, r.width - 2)), y: mitte.y };
  }
  function updateReady(): void {
    form.classList.toggle("is-ready", Boolean(user.value.trim() && pass.value));
  }

  user.addEventListener("input", (e) => {
    const p = caretPoint(user);
    const art = (e as InputEvent).inputType ?? "";
    szene.keystroke(p.x, p.y, art.startsWith("delete") ? "del" : "user");
    holdVoiceUntil = 0;
    if (!busy) voiceFor("user");
    updateReady();
  });
  pass.addEventListener("input", () => {
    const p = caretPoint(pass);
    szene.keystroke(p.x, p.y, "secret");
    if (holdVoiceUntil && !busy) {
      holdVoiceUntil = 0;
      voiceFor(state);
    }
    updateReady();
  });

  for (const el of [user, pass, reveal, submitBtn]) {
    el.addEventListener("focus", refocusState);
    el.addEventListener("blur", () => later(refocusState, 0));
  }

  const caps = (e: KeyboardEvent): void => {
    chipCaps.hidden = !e.getModifierState("CapsLock");
  };
  for (const el of [user, pass]) {
    el.addEventListener("keydown", caps);
    el.addEventListener("keyup", caps);
  }

  reveal.addEventListener("click", () => {
    revealed = !revealed;
    const s = pass.selectionStart;
    const e = pass.selectionEnd;
    pass.type = revealed ? "text" : "password";
    reveal.setAttribute("aria-pressed", String(revealed));
    reveal.setAttribute("aria-label", revealed ? T.hide : T.show);
    pass.focus({ preventScroll: true });
    if (s !== null && e !== null) pass.setSelectionRange(s, e);
    refocusState();
  });

  // Passwort-Manager / Browser-Autofill erkennen
  form.addEventListener(
    "animationstart",
    (e) => {
      if (e.animationName === "an-autofill") {
        updateReady();
        if (!busy) voiceFor(state);
      }
    },
    true,
  );

  // Tippen irgendwo auf der Seite landet im richtigen Feld.
  const tippenIrgendwo = (e: KeyboardEvent): void => {
    if (busy || e.metaKey || e.ctrlKey || e.altKey) return;
    const a = document.activeElement;
    if (a === user || a === pass || a?.tagName === "BUTTON") {
      if (e.key === "Escape" && a instanceof HTMLElement) a.blur();
      return;
    }
    if (e.key.length === 1 || e.key === "Enter") (user.value ? pass : user).focus();
  };
  document.addEventListener("keydown", tippenIrgendwo);

  /* ── Anmeldung ──────────────────────────────────────────── */

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void anmelden();
  });

  async function anmelden(): Promise<void> {
    if (busy || state === "success") return;
    if (Date.now() < cooldownUntil) {
      shake();
      return;
    }
    const u = user.value.trim();
    const p = pass.value;
    if (!u) {
      user.focus();
      softWarn(T.askName);
      return;
    }
    if (!p) {
      pass.focus();
      softWarn(T.askKey);
      return;
    }

    busy = true;
    holdVoiceUntil = 0;
    form.classList.add("is-busy");
    form.setAttribute("aria-busy", "true");
    setState("auth");
    say("verifying", T.verifying);
    announce(T.verifying);
    presenceEl.textContent = T.verifyingShort;
    lightDots(0);
    const onAck = (i: number): void => dotsEl.children[i]?.classList.add("on");

    const [ergebnis] = await Promise.all([
      melde(optionen.baseUrl, u, p, optionen.fetchImpl),
      szene.handshake(onAck),
    ]);
    if (abgeraeumt) return;
    if (ergebnis.ok) await succeed(u, p, ergebnis.token);
    else fail(ergebnis.fehler, ergebnis.wartenMs);
  }

  async function succeed(u: string, p: string, token: string): Promise<void> {
    fails = 0;
    storeCredential(u, p);
    const welcome = fmt(T.welcome, { name: pretty(u) });
    setState("success");
    say("welcome", welcome, "ok");
    announce(welcome);
    lockLabel.textContent = T.unlocked;
    presenceEl.textContent = T.unlocked;
    lightDots(AGENTEN);
    await szene.success();
    veil.classList.add("is-on");
    await sleep(REDUCED ? 60 : 560);
    pass.value = "";
    // Die Oberfläche baut sich unter dem Schleier auf; dann geht die Maske als Ganzes.
    optionen.onAngemeldet(token);
    wurzel.classList.add("ist-weg");
    await sleep(REDUCED ? 0 : 820);
    abraeumen();
  }

  function fail(fehler: string, wartenMs?: number): void {
    busy = false;
    fails++;
    form.classList.remove("is-busy");
    form.removeAttribute("aria-busy");
    lightDots(0);
    failUntil = Date.now() + 1500;
    state = "fail";
    wurzel.dataset.state = "fail";
    const r = form.getBoundingClientRect();
    szene.fail(r.left + r.width / 2, r.top + r.height / 2);
    shake();
    say(`fail:${fails}`, fehler, "warn");
    announce(fehler);
    hold(2600);
    presenceEl.textContent = T.locked;
    // Das Passwortfeld wird geleert, der Name bleibt stehen: wer sich vertippt hat, tippt das
    // Passwort neu — den Namen kennt er.
    pass.value = "";
    updateReady();
    if (wartenMs !== undefined) startCooldown(Math.ceil(wartenMs / 1000));
    pass.focus({ preventScroll: true });
    later(refocusState, 1550);
  }

  /** Die Sperre des Gateways, sichtbar abgezählt: erst seine eigene Zeile, dann die Sekunden. */
  function startCooldown(sec: number): void {
    cooldownUntil = Date.now() + sec * 1000;
    submitBtn.disabled = true;
    const step = (): void => {
      const left = Math.ceil((cooldownUntil - Date.now()) / 1000);
      if (left <= 0) {
        submitBtn.disabled = false;
        holdVoiceUntil = 0;
        if (!busy) voiceFor(state);
        return;
      }
      say("rate", fmt(T.rate, { s: left }), "warn");
      holdVoiceUntil = Date.now() + 1200;
      later(step, 1000);
    };
    later(step, 2600);
  }

  // Dem Browser anbieten, die Zugangsdaten zu speichern (Chrome/Edge). Die Maske verlässt die
  // Seite nie, und ohne einen Seitenwechsel erkennen Passwort-Manager eine Anmeldung sonst nur
  // geraten. `PasswordCredential` steht nicht in den DOM-Typen, weil es nur Chromium kennt.
  function storeCredential(u: string, p: string): void {
    const PC = (
      globalThis as {
        PasswordCredential?: new (daten: {
          id: string;
          password: string;
          name?: string;
        }) => Credential;
      }
    ).PasswordCredential;
    if (PC === undefined || navigator.credentials === undefined) return;
    navigator.credentials.store(new PC({ id: u, password: p, name: u })).catch(() => undefined);
  }

  /* ── Hintergrundvideo ───────────────────────────────────── */

  let video: HTMLVideoElement | null = null;
  const aufSichtbarkeit = (): void => {
    if (video === null) return;
    if (document.hidden) video.pause();
    else void video.play().catch(() => undefined);
  };
  function startVideo(): void {
    if (REDUCED) return;
    const c = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } })
      .connection;
    if (c?.saveData || /(^|-)2g$/.test(c?.effectiveType ?? "")) return;
    // Auf dem Telefon bleibt es beim Standbild: 4 MB Video für eine Anmeldung sind zu viel.
    if (globalThis.matchMedia?.("(max-width: 760px)").matches) return;
    const v = document.createElement("video");
    v.muted = true;
    v.defaultMuted = true;
    v.loop = true;
    v.playsInline = true;
    v.autoplay = true;
    v.setAttribute("muted", "");
    v.setAttribute("playsinline", "");
    v.setAttribute("aria-hidden", "true");
    v.preload = "auto";
    v.src = "/assets/night.mp4";
    v.addEventListener("playing", () => v.classList.add("is-on"), { once: true });
    v.addEventListener("error", () => v.remove(), { once: true });
    bg.appendChild(v);
    video = v;
    void v.play().catch(() => undefined);
    document.addEventListener("visibilitychange", aufSichtbarkeit);
  }

  /* ── Start ──────────────────────────────────────────────── */

  tick();
  const uhr = setInterval(tick, 1000);
  voiceEl.textContent = IDLE;
  voiceKey = "idle";

  // Der Name kommt vom Gateway, nicht aus dem Gedächtnis. Getippt wird nur, was geheim ist.
  // Wer schon im Feld steht, wird nicht überrumpelt: nur ein leeres Feld wird gefüllt, und der
  // Sprung ins Passwortfeld geschieht nur, solange der Fokus noch beim Namen steht.
  void holeLage(optionen.baseUrl, optionen.fetchImpl).then((lage) => {
    if (abgeraeumt || lage.benutzer === null || user.value !== "") return;
    user.value = lage.benutzer;
    updateReady();
    if (document.activeElement === user) pass.focus({ preventScroll: true });
    else if (!busy && state !== "boot") voiceFor(state);
  });

  void (async () => {
    let quick = REDUCED;
    try {
      quick = quick || sessionStorage.getItem(GESEHEN_KEY) === "1";
      sessionStorage.setItem(GESEHEN_KEY, "1");
    } catch {
      // Ohne Sitzungsspeicher (privates Fenster) kommt eben der lange Auftritt.
    }
    if (!quick) {
      Array.from(dotsEl.children).forEach((d, i) =>
        later(() => d.classList.add("on"), 500 + i * 110),
      );
    }
    await sleep(quick ? 250 : 1200);
    if (abgeraeumt) return;
    if (!quick) lightDots(0);
    if (state === "boot") setState("idle");
    const aktiv = document.activeElement;
    if (
      globalThis.matchMedia?.("(pointer: fine)").matches &&
      !(aktiv instanceof HTMLInputElement)
    ) {
      (user.value ? pass : user).focus({ preventScroll: true });
    }
    later(startVideo, quick ? 200 : 700);
  })();

  function abraeumen(): void {
    if (abgeraeumt) return;
    abgeraeumt = true;
    clearInterval(uhr);
    if (voiceTimer !== null) clearTimeout(voiceTimer);
    for (const t of timers) clearTimeout(t);
    timers.clear();
    document.removeEventListener("keydown", tippenIrgendwo);
    document.removeEventListener("visibilitychange", aufSichtbarkeit);
    video?.pause();
    szene.destroy();
    wurzel.remove();
  }

  return abraeumen;
}
