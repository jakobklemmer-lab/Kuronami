/**
 * Mock-Datenquellen fuer die neue Startseite und die Bereichs-Detailseiten (S-Zwischenschub,
 * Punkt 3): "Alle vier Panels laufen zunaechst gegen Mock-Daten, jedes aber hinter einem klar
 * typisierten Interface, das spaeter gegen die echte Quelle getauscht wird."
 *
 * Jede Domaene bekommt ein `*Provider`-Interface mit genau einer Methode `load()`, die ein
 * `Promise` liefert — dieselbe Form wie ein spaeterer HTTP-Aufruf ueber `ui/api/client.ts`
 * (`ApiClient.get`). Ein Austausch bedeutet: `createMockXProvider()` durch `createXProvider(api)`
 * ersetzen, ohne dass ein Aufrufer (View) sich aendert. Keine Daten stehen fest im Markup — jede
 * View liest ausschliesslich ueber diese Provider.
 *
 * Die Werte selbst sind erfunden (erkennbar an runden, "Demo"-typischen Zahlen) und **nicht**
 * als echte Marktdaten/E-Mails/Termine misszuverstehen — anders als der Rest von Kuronami, der
 * nach AGENTS.md keine erfundenen Werte zeigt, ist das hier ausdrueckliche Auftragslage (Punkt 3:
 * "laufen zunaechst gegen Mock-Daten").
 */

export interface MarketQuote {
  symbol: string;
  label: string;
  price: number;
  changePct: number;
  /** Kursverlauf fuer die Mini-Linie in der Karte — normalisiert wird erst beim Zeichnen. */
  spark: number[];
}

export interface MarketsData {
  quotes: MarketQuote[];
  asOf: string;
}

export interface MarketsProvider {
  load(): Promise<MarketsData>;
}

export function createMockMarketsProvider(): MarketsProvider {
  return {
    async load() {
      return {
        asOf: new Date().toISOString(),
        quotes: [
          {
            symbol: "BTC",
            label: "Bitcoin",
            price: 109432.18,
            changePct: 2.34,
            spark: [38, 34, 41, 36, 45, 42, 52, 58],
          },
          {
            symbol: "ETH",
            label: "Ethereum",
            price: 4212.67,
            changePct: 1.87,
            spark: [30, 36, 32, 40, 38, 46, 44, 51],
          },
          {
            symbol: "SPX",
            label: "S&P 500",
            price: 5648.32,
            changePct: 0.52,
            spark: [42, 40, 44, 43, 47, 45, 49, 50],
          },
          {
            symbol: "AAPL",
            label: "Apple",
            price: 229.41,
            changePct: -0.32,
            spark: [52, 55, 50, 48, 51, 45, 43, 41],
          },
          {
            symbol: "TSLA",
            label: "Tesla",
            price: 248.17,
            changePct: 1.43,
            spark: [36, 39, 35, 42, 40, 47, 46, 53],
          },
        ],
      };
    },
  };
}

export interface WeatherDay {
  name: string;
  high: number;
  low: number;
  clear: boolean;
}

export interface WeatherData {
  place: string;
  temperature: number;
  description: string;
  night: boolean;
  forecast: WeatherDay[];
}

export interface WeatherProvider {
  load(): Promise<WeatherData>;
}

export function createMockWeatherProvider(): WeatherProvider {
  return {
    async load() {
      return {
        place: "Vienna",
        temperature: 16,
        description: "Clear",
        night: true,
        forecast: [
          { name: "Today", high: 28, low: 14, clear: true },
          { name: "Wed", high: 29, low: 15, clear: true },
          { name: "Thu", high: 27, low: 13, clear: true },
        ],
      };
    },
  };
}

export interface SystemGauge {
  id: "cpu" | "ram" | "disk" | "network";
  label: string;
  /** Fuellstand des Rings, 0–100. */
  percent: number;
  /** Was in der Mitte steht — meist `${percent}%`, beim Netz ein Durchsatz. */
  readout: string;
  readoutSub?: string;
}

export interface SystemGaugesData {
  gauges: SystemGauge[];
}

export interface SystemGaugesProvider {
  load(): Promise<SystemGaugesData>;
}

export function createMockSystemGaugesProvider(): SystemGaugesProvider {
  return {
    async load() {
      return {
        gauges: [
          { id: "cpu", label: "CPU", percent: 12, readout: "12%" },
          { id: "ram", label: "RAM", percent: 47, readout: "47%" },
          { id: "disk", label: "Disk", percent: 32, readout: "32%" },
          {
            id: "network",
            label: "Network",
            percent: 21,
            readout: "2.1 Mb",
            readoutSub: "2 MB/s",
          },
        ],
      };
    },
  };
}

export interface QuickNote {
  text: string;
  author: string;
}

export interface QuickNoteProvider {
  load(): Promise<QuickNote>;
}

export function createMockQuickNoteProvider(): QuickNoteProvider {
  return {
    async load() {
      return {
        text: "„The best time to plant a tree was 20 years ago.\nThe second best time is now.“",
        author: "Chinese Proverb",
      };
    },
  };
}

export interface MailMessage {
  id: string;
  from: string;
  subject: string;
  preview: string;
  receivedAt: string;
  unread: boolean;
}

export interface MailData {
  messages: MailMessage[];
  unreadCount: number;
}

export interface MailProvider {
  load(): Promise<MailData>;
}

export function createMockMailProvider(): MailProvider {
  return {
    async load() {
      const minutesAgo = (minutes: number) =>
        new Date(Date.now() - 1000 * 60 * minutes).toISOString();
      const messages: MailMessage[] = [
        {
          id: "m1",
          from: "Google",
          subject: "Security alert",
          preview: "Neue Anmeldung auf einem Windows-Geraet.",
          receivedAt: minutesAgo(35),
          unread: true,
        },
        {
          id: "m2",
          from: "TradingView",
          subject: "Price alert: BTCUSD",
          preview: "BTCUSD hat die Marke von 109.000 ueberschritten.",
          receivedAt: minutesAgo(100),
          unread: true,
        },
        {
          id: "m3",
          from: "Claude",
          subject: "Project update",
          preview: "Der UI-Zwischenschub ist abgeschlossen und committet.",
          receivedAt: minutesAgo(181),
          unread: true,
        },
        {
          id: "m4",
          from: "Notion",
          subject: "Weekly review",
          preview: "Deine Wochenuebersicht steht bereit.",
          receivedAt: minutesAgo(314),
          unread: true,
        },
        {
          id: "m5",
          from: "Binance",
          subject: "Deposit confirmed",
          preview: "Deine Einzahlung wurde gutgeschrieben.",
          receivedAt: minutesAgo(419),
          unread: false,
        },
      ];
      return { messages, unreadCount: messages.filter((m) => m.unread).length };
    },
  };
}

/** Das Symbol, das der Eintrag in der Zeitleiste traegt — ein Name aus `ui/icons.ts`, nicht ein
 * Emoji (Punkt 7 der vorigen Sitzung, weiterhin gueltig). */
export type AgendaIcon = "dumbbell" | "utensils" | "book" | "phone" | "moon" | "calendar";

export interface AgendaEvent {
  id: string;
  title: string;
  startsAt: string;
  location: string | null;
  icon: AgendaIcon;
}

export interface AgendaData {
  events: AgendaEvent[];
}

export interface AgendaProvider {
  load(): Promise<AgendaData>;
}

export function createMockAgendaProvider(): AgendaProvider {
  return {
    async load() {
      const now = new Date();
      const at = (hour: number, minute = 0) => {
        const d = new Date(now);
        d.setHours(hour, minute, 0, 0);
        return d.toISOString();
      };
      return {
        events: [
          { id: "e1", title: "Gym", startsAt: at(9, 0), location: null, icon: "dumbbell" },
          { id: "e2", title: "Lunch", startsAt: at(12, 30), location: null, icon: "utensils" },
          {
            id: "e3",
            title: "Study / Exam Prep",
            startsAt: at(15, 0),
            location: null,
            icon: "book",
          },
          { id: "e4", title: "Call", startsAt: at(18, 0), location: "Meet", icon: "phone" },
          { id: "e5", title: "Free Time", startsAt: at(21, 0), location: null, icon: "moon" },
        ],
      };
    },
  };
}

export interface NoteSummary {
  id: string;
  title: string;
  updatedAt: string;
  excerpt: string;
}

export interface NotesData {
  notes: NoteSummary[];
}

export interface NotesProvider {
  load(): Promise<NotesData>;
}

export function createMockNotesProvider(): NotesProvider {
  return {
    async load() {
      return {
        notes: [
          {
            id: "n1",
            title: "Ideen: Team-Pipelines",
            updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
            excerpt: "Orchestrator holt Ergebnisse Schritt fuer Schritt von Rolle zu Rolle…",
          },
          {
            id: "n2",
            title: "TradingView-Anbindung",
            updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 30).toISOString(),
            excerpt: "Ob und wie sich eine TradingView-API verbinden laesst, ist ungeklaert…",
          },
        ],
      };
    },
  };
}

export interface ResearchFinding {
  id: string;
  query: string;
  summary: string;
  savedAt: string;
}

export interface ResearchData {
  findings: ResearchFinding[];
}

export interface ResearchProvider {
  load(): Promise<ResearchData>;
}

export function createMockResearchProvider(): ResearchProvider {
  return {
    async load() {
      return {
        findings: [
          {
            id: "r1",
            query: "TradingView Webhook-API Grenzen",
            summary: "Kein offizielles Backtest-Export-Format, nur Alert-Webhooks.",
            savedAt: new Date(Date.now() - 1000 * 60 * 60 * 40).toISOString(),
          },
        ],
      };
    },
  };
}

export interface FileEntry {
  id: string;
  name: string;
  path: string;
  kind: "note" | "artifact" | "document";
  modifiedAt: string;
}

export interface FilesData {
  entries: FileEntry[];
}

export interface FilesProvider {
  load(): Promise<FilesData>;
}

export function createMockFilesProvider(): FilesProvider {
  return {
    async load() {
      return {
        entries: [
          {
            id: "f1",
            name: "Q3-Bericht.docx",
            path: "docs/Q3-Bericht.docx",
            kind: "document",
            modifiedAt: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
          },
          {
            id: "f2",
            name: "S25-Screenshot.png",
            path: "artifacts/S25-Screenshot.png",
            kind: "artifact",
            modifiedAt: new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString(),
          },
        ],
      };
    },
  };
}
