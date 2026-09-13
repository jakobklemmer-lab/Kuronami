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
          { symbol: "BTC", label: "Bitcoin", price: 71230, changePct: 1.8 },
          { symbol: "ETH", label: "Ethereum", price: 3810, changePct: -0.6 },
          { symbol: "DAX", label: "DAX 40", price: 19870, changePct: 0.3 },
          { symbol: "SPX", label: "S&P 500", price: 5940, changePct: 0.1 },
        ],
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
      const messages: MailMessage[] = [
        {
          id: "m1",
          from: "Lena Vogt",
          subject: "Entwurf fuer Q3-Bericht",
          preview: "Ich habe die erste Fassung angehaengt, magst du kurz drueberschauen…",
          receivedAt: new Date(Date.now() - 1000 * 60 * 22).toISOString(),
          unread: true,
        },
        {
          id: "m2",
          from: "GitHub",
          subject: "[kuronami] Neuer Kommentar in Issue #142",
          preview: "jkl kommentierte: 'Koennten wir das auf S28 verschieben?'",
          receivedAt: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(),
          unread: true,
        },
        {
          id: "m3",
          from: "Stadtwerke",
          subject: "Ihre Jahresabrechnung ist da",
          preview: "Sehr geehrter Kunde, anbei finden Sie…",
          receivedAt: new Date(Date.now() - 1000 * 60 * 60 * 20).toISOString(),
          unread: false,
        },
      ];
      return { messages, unreadCount: messages.filter((m) => m.unread).length };
    },
  };
}

export interface AgendaEvent {
  id: string;
  title: string;
  startsAt: string;
  location: string | null;
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
          { id: "e1", title: "Stand-up", startsAt: at(9, 30), location: null },
          { id: "e2", title: "1:1 mit Team Trading", startsAt: at(11, 0), location: "Meet" },
          { id: "e3", title: "Ruhepause", startsAt: at(15, 0), location: null },
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
