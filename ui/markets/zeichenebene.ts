import type {
  CanvasRenderingTarget2D,
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  PrimitiveHoveredItem,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "../vendor/lightweight-charts-5.standalone.production.mjs";
import {
  FARBE,
  type Form,
  type Teil,
  type Umrechnung,
  formenFuer,
  triff,
  ziehe,
} from "./formen.js";
import { anzeigeZeit, echteZeit } from "./intervalle.js";
import {
  type Punkt,
  type Werkzeug,
  type Zeichnung,
  dauerText,
  einrasten,
  logischeStelle,
  messe,
  neueId,
  neuePosition,
  zeitAnStelle,
} from "./zeichnungen.js";

/**
 * Die Zeichenebene des Charts: ein Maler (`Ebene`, eine Zeichen-Schnittstelle von Lightweight
 * Charts) und ein Stift (`Zeichenstift`), der Maus und Finger in Zeichnungen übersetzt.
 *
 * Was hier steht, berührt Leinwand und Zeiger und ist deshalb ungeprüft — die Rechnung dahinter
 * (Treffer, Ziehen, Formen, Zeit ↔ Kerzenstelle) steht in `formen.ts` und `zeichnungen.ts` und
 * ist es.
 */

export interface AchsenMarke {
  preis: number;
  text: string;
  farbe: string;
}

interface Kerzenachse {
  /** Die Anzeigezeiten der geladenen Kerzen, aufsteigend. */
  zeiten: number[];
  schritt: number;
}

const SCHRIFT = '11px "Figtree", system-ui, sans-serif';

class Maler implements IPrimitivePaneRenderer {
  constructor(
    private readonly formen: readonly Form[],
    private readonly u: Umrechnung,
  ) {}

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.font = SCHRIFT;
      ctx.textBaseline = "middle";
      for (const f of this.formen) this.male(ctx, f, mediaSize.width, mediaSize.height);
      ctx.restore();
    });
  }

  private male(ctx: CanvasRenderingContext2D, f: Form, breite: number, hoehe: number): void {
    const u = this.u;
    ctx.setLineDash([]);
    switch (f.typ) {
      case "hlinie": {
        const y = u.y(f.preis);
        if (y === null) return;
        const x1 = f.vonZeit !== undefined ? (u.x(f.vonZeit) ?? 0) : 0;
        const x2 = f.bisZeit !== undefined ? (u.x(f.bisZeit) ?? breite) : breite;
        ctx.strokeStyle = f.farbe;
        ctx.lineWidth = f.breite ?? 1;
        ctx.setLineDash(f.strich ?? []);
        ctx.beginPath();
        ctx.moveTo(x1, Math.round(y) + 0.5);
        ctx.lineTo(x2, Math.round(y) + 0.5);
        ctx.stroke();
        if (f.text) {
          ctx.setLineDash([]);
          ctx.fillStyle = f.farbe;
          ctx.textAlign = "left";
          ctx.fillText(f.text, Math.max(x1, 0) + 6, y - 8);
        }
        return;
      }
      case "strecke": {
        const x1 = u.x(f.a.zeit);
        const y1 = u.y(f.a.preis);
        const x2 = u.x(f.b.zeit);
        const y2 = u.y(f.b.preis);
        if (x1 === null || y1 === null || x2 === null || y2 === null) return;
        ctx.strokeStyle = f.farbe;
        ctx.lineWidth = f.breite ?? 1;
        ctx.setLineDash(f.strich ?? []);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        return;
      }
      case "kasten": {
        const x1 = u.x(f.a.zeit);
        const y1 = u.y(f.a.preis);
        const x2 = u.x(f.b.zeit);
        const y2 = u.y(f.b.preis);
        if (x1 === null || y1 === null || x2 === null || y2 === null) return;
        const x = Math.min(x1, x2);
        const y = Math.min(y1, y2);
        ctx.fillStyle = f.fuellung;
        ctx.fillRect(x, y, Math.abs(x2 - x1), Math.abs(y2 - y1));
        if (f.rand) {
          ctx.strokeStyle = f.rand;
          ctx.lineWidth = 1;
          ctx.strokeRect(
            Math.round(x) + 0.5,
            Math.round(y) + 0.5,
            Math.round(Math.abs(x2 - x1)),
            Math.round(Math.abs(y2 - y1)),
          );
        }
        return;
      }
      case "vlinie": {
        const x = u.x(f.zeit);
        if (x === null) return;
        ctx.strokeStyle = f.farbe;
        ctx.lineWidth = 1;
        ctx.setLineDash(f.strich ?? []);
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, hoehe);
        ctx.stroke();
        if (f.text) {
          // Unten statt oben: oben liegt die Legende.
          ctx.setLineDash([]);
          const w = ctx.measureText(f.text).width;
          const y = hoehe - 16 - (f.zeile ?? 0) * 22;
          // Nahe am rechten Rand links von der Linie, sonst liefe der Satz aus dem Bild.
          const links = x + w + 16 > breite ? x - w - 13 : x + 3;
          ctx.fillStyle = "rgba(11, 16, 25, 0.82)";
          ctx.fillRect(links, y - 9, w + 10, 18);
          ctx.fillStyle = f.farbe;
          ctx.textAlign = "left";
          ctx.fillText(f.text, links + 5, y);
        }
        return;
      }
      case "text": {
        const x = u.x(f.punkt.zeit);
        const y0 = u.y(f.punkt.preis);
        if (x === null || y0 === null) return;
        const y = y0 + (f.versatzY ?? 0);
        const ausrichtung = f.ausrichtung ?? "links";
        const w = ctx.measureText(f.text).width;
        const links =
          ausrichtung === "links" ? x + 4 : ausrichtung === "rechts" ? x - 4 - w : x - w / 2;
        if (f.grund) {
          ctx.fillStyle = f.grund;
          ctx.fillRect(links - 5, y - 9, w + 10, 18);
        }
        ctx.fillStyle = f.farbe;
        ctx.textAlign = "left";
        ctx.fillText(f.text, links, y);
        return;
      }
      case "griff": {
        const x = u.x(f.punkt.zeit);
        const y = u.y(f.punkt.preis);
        if (x === null || y === null) return;
        ctx.fillStyle = "#0b1019";
        ctx.strokeStyle = f.farbe;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        return;
      }
    }
  }
}

class Ansicht implements IPrimitivePaneView {
  constructor(private readonly ebene: Ebene) {}
  zOrder(): "top" {
    return "top";
  }
  renderer(): IPrimitivePaneRenderer {
    return new Maler(this.ebene.alleFormen(), this.ebene.umrechnung());
  }
}

class Achsenansicht implements ISeriesPrimitiveAxisView {
  constructor(
    private readonly ebene: Ebene,
    private readonly marke: AchsenMarke,
  ) {}
  coordinate(): number {
    return this.ebene.umrechnung().y(this.marke.preis) ?? -100;
  }
  text(): string {
    return this.marke.text;
  }
  textColor(): string {
    return "#0b1019";
  }
  backColor(): string {
    return this.marke.farbe;
  }
}

/** Der Maler, als Zeichen-Schnittstelle an die Kursreihe gehängt. */
export class Ebene implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private neuZeichnen: (() => void) | null = null;
  private achse: Kerzenachse = { zeiten: [], schritt: 86_400 };
  private formenFremd: Form[] = [];
  private formenEigen: Form[] = [];
  private marken: AchsenMarke[] = [];
  private markenFremd: AchsenMarke[] = [];
  private readonly ansicht = new Ansicht(this);
  /** Der Stift fragt hierüber, welcher Zeiger über welcher Zeichnung steht. */
  zeigerTest: ((x: number, y: number) => PrimitiveHoveredItem | null) | null = null;

  attached(p: SeriesAttachedParameter<Time>): void {
    this.chart = p.chart as IChartApi;
    this.series = p.series;
    this.neuZeichnen = p.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.neuZeichnen = null;
  }

  setzeAchse(zeiten: number[], schritt: number): void {
    this.achse = { zeiten, schritt };
    this.neuZeichnen?.();
  }

  /** Kuros Arbeit: Ideen und Handel, nur zum Ansehen. */
  setzeFremd(formen: Form[], marken: AchsenMarke[] = []): void {
    this.formenFremd = formen;
    this.markenFremd = marken;
    this.neuZeichnen?.();
  }

  setzeEigen(formen: Form[], marken: AchsenMarke[]): void {
    this.formenEigen = formen;
    this.marken = marken;
    this.neuZeichnen?.();
  }

  alleFormen(): Form[] {
    return [...this.formenFremd, ...this.formenEigen];
  }

  /** Zeit (echt, UTC) und Preis in Bildpunkte der Hauptfläche — und zurück. */
  umrechnung(): Umrechnung {
    const chart = this.chart;
    const series = this.series;
    const { zeiten, schritt } = this.achse;
    return {
      x: (zeit) => {
        if (!chart || zeiten.length === 0) return null;
        const stelle = logischeStelle(anzeigeZeit(zeit), zeiten, schritt);
        // `logicalToCoordinate` nimmt nur ganze Stellen — eine gebrochene ergibt 0, und eine
        // Linie, die an einem Sonntag endet, klebte am linken Rand. Also zwischen den zwei
        // Nachbarn selbst teilen; der Abstand der Kerzen ist im Bild gleichmäßig.
        const skala = chart.timeScale();
        const unten = Math.floor(stelle);
        const x0 = skala.logicalToCoordinate(unten as never);
        if (x0 === null) return null;
        if (stelle === unten) return x0;
        const x1 = skala.logicalToCoordinate((unten + 1) as never);
        return x1 === null ? x0 : x0 + (stelle - unten) * (x1 - x0);
      },
      y: (preis) => series?.priceToCoordinate(preis) ?? null,
    };
  }

  punktAus(x: number, y: number): Punkt | null {
    if (!this.chart || !this.series || this.achse.zeiten.length === 0) return null;
    const stelle = this.chart.timeScale().coordinateToLogical(x);
    const preis = this.series.coordinateToPrice(y);
    if (stelle === null || preis === null) return null;
    return { zeit: echteZeit(zeitAnStelle(stelle, this.achse.zeiten, this.achse.schritt)), preis };
  }

  /** Die gebrochene Kerzenstelle zweier Zeiten — für die Zahl der Kerzen einer Messung. */
  kerzenZwischen(a: number, b: number): number {
    const { zeiten, schritt } = this.achse;
    return (
      logischeStelle(anzeigeZeit(b), zeiten, schritt) -
      logischeStelle(anzeigeZeit(a), zeiten, schritt)
    );
  }

  updateAllViews(): void {}

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.ansicht];
  }

  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    return [...this.markenFremd, ...this.marken].map((m) => new Achsenansicht(this, m));
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    return this.zeigerTest?.(x, y) ?? null;
  }
}

// ------------------------------------------------------------------------------ Der Stift

export interface StiftOptionen {
  chart: IChartApi;
  ebene: Ebene;
  /** Der Rahmen des Charts; Zeigerereignisse werden hier abgefangen. */
  rahmen: HTMLElement;
  /**
   * Die Fläche, auf der gezeichnet wird. Was über ihr liegt — die Leiste einer gewählten
   * Zeichnung, die Wiedergabe, die Suche —, gehört nicht dem Stift: ein Klick auf „Löschen"
   * hob sonst zuerst die Auswahl auf, und die Leiste verschwand unter dem Finger.
   */
  flaeche: HTMLElement;
  stellen: () => number;
  /** Die Kerze unter einer Zeit — für den Magneten. */
  kerzeBei: (
    zeit: number,
  ) => { open: number; high: number; low: number; close: number } | undefined;
  /** Eine übliche Spanne für eine neue Positionsidee (ATR der sichtbaren Kerzen). */
  spanne: () => number;
  kerzenAbstand: () => number;
  /** Wird nach jeder Änderung an Jakobs Zeichnungen gerufen. */
  geaendert: (zeichnungen: Zeichnung[]) => void;
  gewaehlt: (zeichnung: Zeichnung | null) => void;
  werkzeugFertig: () => void;
  /** Fragt nach einem Text für eine Notiz im Chart; `null` bricht ab. */
  frageText: (x: number, y: number) => Promise<string | null>;
  /**
   * Wie sich der Chart bewegen lässt, wenn der Stift ihn wieder freigibt. Auf dem Telefon gehört
   * das senkrechte Wischen der Seite; ein pauschales `true` gäbe es nach jeder Zeichnung dem
   * Chart zurück, und die Seite ließe sich über ihm nicht mehr blättern.
   */
  bewegung?: () => Pick<ChartOptionen, "handleScroll" | "handleScale">;
}

type ChartOptionen = NonNullable<Parameters<IChartApi["applyOptions"]>[0]>;

export class Zeichenstift {
  private zeichnungen: Zeichnung[] = [];
  private werkzeug: Werkzeug = "zeiger";
  private auswahl: string | null = null;
  private entwurf: Zeichnung | null = null;
  private messung: { a: Punkt; b: Punkt } | null = null;
  private ziehen: {
    id: string;
    teil: Teil;
    von: Punkt;
    vorher: Zeichnung;
    bewegt: boolean;
  } | null = null;
  private start: { x: number; y: number; punkt: Punkt } | null = null;
  magnet = false;
  gesperrt = false;
  private readonly weg: (() => void)[] = [];

  constructor(private readonly o: StiftOptionen) {
    const r = o.rahmen;
    const runter = (e: PointerEvent) => this.runter(e);
    const bewegt = (e: PointerEvent) => this.bewegt(e);
    const hoch = (e: PointerEvent) => this.hoch(e);
    // In der Fangphase am Rahmen: vor dem Chart, damit ein Zeichenzug ihn nicht verschiebt.
    r.addEventListener("pointerdown", runter, true);
    r.addEventListener("pointermove", bewegt, true);
    window.addEventListener("pointerup", hoch, true);
    this.weg.push(
      () => r.removeEventListener("pointerdown", runter, true),
      () => r.removeEventListener("pointermove", bewegt, true),
      () => window.removeEventListener("pointerup", hoch, true),
    );
    o.ebene.zeigerTest = (x, y) => {
      if (this.werkzeug !== "zeiger")
        return { externalId: "stift", zOrder: "top", cursorStyle: "crosshair" };
      const t = this.treffer(x, y);
      if (!t) return null;
      const cursor =
        t.teil === "ganz" ? "move" : t.teil === "stop" || t.teil === "ziel" ? "ns-resize" : "grab";
      return { externalId: t.id, zOrder: "top", cursorStyle: cursor };
    };
  }

  zerstoere(): void {
    for (const f of this.weg) f();
    this.o.ebene.zeigerTest = null;
  }

  setzeZeichnungen(zeichnungen: Zeichnung[]): void {
    this.zeichnungen = zeichnungen;
    if (this.auswahl && !zeichnungen.some((z) => z.id === this.auswahl)) this.auswahl = null;
    this.male();
  }

  alle(): Zeichnung[] {
    return this.zeichnungen;
  }

  setzeWerkzeug(w: Werkzeug): void {
    this.werkzeug = w;
    this.entwurf = null;
    this.start = null;
    if (w !== "messen") this.messung = null;
    if (w !== "zeiger") this.waehle(null);
    this.male();
  }

  get aktuellesWerkzeug(): Werkzeug {
    return this.werkzeug;
  }

  waehle(id: string | null): void {
    this.auswahl = id;
    this.o.gewaehlt(this.zeichnungen.find((z) => z.id === id) ?? null);
    this.male();
  }

  get gewaehlteZeichnung(): Zeichnung | null {
    return this.zeichnungen.find((z) => z.id === this.auswahl) ?? null;
  }

  ersetze(z: Zeichnung): void {
    this.zeichnungen = this.zeichnungen.map((x) => (x.id === z.id ? z : x));
    this.o.geaendert(this.zeichnungen);
    this.o.gewaehlt(z.id === this.auswahl ? z : this.gewaehlteZeichnung);
    this.male();
  }

  loesche(id: string): void {
    this.zeichnungen = this.zeichnungen.filter((z) => z.id !== id);
    if (this.auswahl === id) this.waehle(null);
    this.o.geaendert(this.zeichnungen);
    this.male();
  }

  loescheAlle(): void {
    this.zeichnungen = [];
    this.waehle(null);
    this.o.geaendert(this.zeichnungen);
  }

  /** Esc: erst den Entwurf, dann die Messung, dann die Auswahl, zuletzt das Werkzeug. */
  abbrechen(): boolean {
    if (this.entwurf || this.start) {
      this.entwurf = null;
      this.start = null;
    } else if (this.messung) {
      this.messung = null;
    } else if (this.auswahl) {
      this.waehle(null);
      return true;
    } else if (this.werkzeug !== "zeiger") {
      this.setzeWerkzeug("zeiger");
      this.o.werkzeugFertig();
      return true;
    } else {
      return false;
    }
    this.male();
    return true;
  }

  /** Neu malen — nach jeder Änderung und wenn sich die Kerzenachse verschoben hat. */
  male(): void {
    const stellen = this.o.stellen();
    const formen: Form[] = [];
    for (const z of this.zeichnungen) formen.push(...formenFuer(z, z.id === this.auswahl, stellen));
    if (this.entwurf) formen.push(...formenFuer(this.entwurf, true, stellen));
    if (this.messung) formen.push(...this.messFormen(this.messung, stellen));
    const marken: AchsenMarke[] = [];
    for (const z of this.zeichnungen) {
      if (z.art === "horizontal")
        marken.push({ preis: z.preis, text: this.zahl(z.preis, stellen), farbe: FARBE.linie });
      if (z.art === "position" && z.id === this.auswahl) {
        marken.push(
          { preis: z.a.preis, text: this.zahl(z.a.preis, stellen), farbe: "#cfd6de" },
          { preis: z.stop, text: this.zahl(z.stop, stellen), farbe: "#e0787f" },
          { preis: z.ziel, text: this.zahl(z.ziel, stellen), farbe: "#5fc98c" },
        );
      }
    }
    this.o.ebene.setzeEigen(formen, marken);
  }

  private zahl(w: number, stellen: number): string {
    return w.toLocaleString("de-DE", {
      minimumFractionDigits: stellen,
      maximumFractionDigits: stellen,
    });
  }

  private messFormen(m: { a: Punkt; b: Punkt }, stellen: number): Form[] {
    const ergebnis = messe(m.a, m.b, this.o.ebene.kerzenZwischen(m.a.zeit, m.b.zeit));
    const hoch = ergebnis.differenz >= 0;
    const vorzeichen = hoch ? "+" : "−";
    const oben = { zeit: m.b.zeit, preis: Math.max(m.a.preis, m.b.preis) };
    return [
      {
        typ: "kasten",
        a: m.a,
        b: m.b,
        fuellung: hoch ? "rgba(127,178,229,0.14)" : "rgba(224,120,127,0.14)",
        rand: hoch ? "rgba(127,178,229,0.6)" : "rgba(224,120,127,0.6)",
      },
      {
        typ: "text",
        punkt: oben,
        text: `${vorzeichen}${this.zahl(Math.abs(ergebnis.differenz), stellen)} (${vorzeichen}${Math.abs(ergebnis.prozent).toLocaleString("de-DE", { maximumFractionDigits: 2 })} %)`,
        farbe: FARBE.text,
        grund: "rgba(20, 28, 36, 0.88)",
        ausrichtung: "mitte",
        versatzY: -26,
      },
      {
        typ: "text",
        punkt: oben,
        text: `${Math.abs(ergebnis.kerzen)} Kerzen · ${dauerText(ergebnis.sekunden)}`,
        farbe: FARBE.leise,
        grund: "rgba(20, 28, 36, 0.88)",
        ausrichtung: "mitte",
        versatzY: -9,
      },
    ];
  }

  private lokal(e: PointerEvent): { x: number; y: number } | null {
    const kasten = this.o.rahmen.getBoundingClientRect();
    const x = e.clientX - kasten.left;
    const y = e.clientY - kasten.top;
    // Nur in der Kursfläche: nicht auf der Preisachse, nicht in den Fenstern darunter.
    const flaeche = this.o.chart.panes()[0]?.getHeight() ?? kasten.height;
    const breite = this.o.chart.timeScale().width();
    if (x < 0 || y < 0 || x > breite || y > flaeche) return null;
    return { x, y };
  }

  private punkt(x: number, y: number): Punkt | null {
    const p = this.o.ebene.punktAus(x, y);
    if (!p || !this.magnet) return p;
    const u = this.o.ebene.umrechnung();
    const y1 = u.y(p.preis);
    const y2 = u.y(p.preis + 1);
    const jePixel = y1 !== null && y2 !== null && y1 !== y2 ? 1 / Math.abs(y1 - y2) : 0;
    return { zeit: p.zeit, preis: einrasten(p.preis, this.o.kerzeBei(p.zeit), jePixel * 12) };
  }

  private treffer(x: number, y: number): { id: string; teil: Teil } | null {
    const u = this.o.ebene.umrechnung();
    // Die gewählte zuerst, dann von oben nach unten — die zuletzt gezeichnete liegt oben.
    const reihe = [...this.zeichnungen]
      .reverse()
      .sort((a, b) => (a.id === this.auswahl ? -1 : b.id === this.auswahl ? 1 : 0));
    for (const z of reihe) {
      const teil = triff(z, x, y, u);
      if (teil) return { id: z.id, teil };
    }
    return null;
  }

  private sperreChart(an: boolean): void {
    this.o.chart.applyOptions(
      an
        ? { handleScroll: false, handleScale: false }
        : (this.o.bewegung?.() ?? { handleScroll: true, handleScale: true }),
    );
  }

  private fertig(z: Zeichnung): void {
    this.zeichnungen = [...this.zeichnungen, z];
    this.entwurf = null;
    this.start = null;
    this.o.geaendert(this.zeichnungen);
    this.werkzeug = "zeiger";
    this.o.werkzeugFertig();
    this.waehle(z.id);
  }

  private runter(e: PointerEvent): void {
    if (e.button !== 0 || this.gesperrt) return;
    if (!this.o.flaeche.contains(e.target as Node)) return;
    const l = this.lokal(e);
    if (!l) return;
    const p = this.punkt(l.x, l.y);
    if (!p) return;
    const w = this.werkzeug;

    if (w === "zeiger") {
      const t = this.treffer(l.x, l.y);
      if (!t) {
        if (this.auswahl) this.waehle(null);
        this.messung = null;
        this.male();
        return; // der Chart darf verschieben
      }
      e.stopPropagation();
      const z = this.zeichnungen.find((x) => x.id === t.id) as Zeichnung;
      if (this.auswahl !== t.id) this.waehle(t.id);
      this.ziehen = { id: t.id, teil: t.teil, von: p, vorher: z, bewegt: false };
      this.sperreChart(true);
      return;
    }

    e.stopPropagation();
    e.preventDefault();
    if (w === "horizontal") {
      this.fertig({ id: neueId(), art: "horizontal", preis: p.preis });
      return;
    }
    if (w === "long" || w === "short") {
      this.fertig(neuePosition(w, p, this.o.spanne(), this.o.kerzenAbstand()));
      return;
    }
    if (w === "text") {
      void this.o.frageText(l.x, l.y).then((text) => {
        if (text?.trim())
          this.fertig({ id: neueId(), art: "text", a: p, text: text.trim().slice(0, 500) });
      });
      return;
    }
    // Zweipunktwerkzeuge: ziehen, oder klicken – klicken.
    if (this.start && (this.entwurf || w === "messen")) {
      this.schliesse(p);
      return;
    }
    this.start = { x: l.x, y: l.y, punkt: p };
    this.sperreChart(true);
    if (w === "messen") this.messung = { a: p, b: p };
    else this.entwurf = this.zweipunkt(w, p, p);
    this.male();
  }

  private zweipunkt(w: Werkzeug, a: Punkt, b: Punkt): Zeichnung {
    const id = this.entwurf?.id ?? neueId();
    if (w === "rechteck") return { id, art: "rechteck", a, b };
    if (w === "fib") return { id, art: "fib", a, b };
    return { id, art: "trend", a, b };
  }

  private schliesse(b: Punkt): void {
    const start = this.start;
    if (!start) return;
    this.sperreChart(false);
    if (this.werkzeug === "messen") {
      this.messung = { a: start.punkt, b };
      this.start = null;
      this.male();
      return;
    }
    this.fertig(this.zweipunkt(this.werkzeug, start.punkt, b));
  }

  private bewegt(e: PointerEvent): void {
    const l = this.lokal(e);
    if (!l) return;
    if (this.ziehen) {
      const p = this.punkt(l.x, l.y);
      if (!p) return;
      e.stopPropagation();
      this.ziehen.bewegt = true;
      const neu = ziehe(this.ziehen.vorher, this.ziehen.teil, this.ziehen.von, p);
      this.zeichnungen = this.zeichnungen.map((z) => (z.id === neu.id ? neu : z));
      this.o.gewaehlt(neu);
      this.male();
      return;
    }
    if (this.start) {
      const p = this.punkt(l.x, l.y);
      if (!p) return;
      e.stopPropagation();
      if (this.werkzeug === "messen") this.messung = { a: this.start.punkt, b: p };
      else this.entwurf = this.zweipunkt(this.werkzeug, this.start.punkt, p);
      this.male();
    }
  }

  private hoch(e: PointerEvent): void {
    if (this.ziehen) {
      const z = this.ziehen;
      this.ziehen = null;
      this.sperreChart(false);
      if (z.bewegt) this.o.geaendert(this.zeichnungen);
      return;
    }
    if (this.start) {
      const l = this.lokal(e);
      // Weit genug gezogen: fertig. Sonst war es ein Klick, und der zweite Klick schließt.
      if (l && Math.hypot(l.x - this.start.x, l.y - this.start.y) > 6) {
        const p = this.punkt(l.x, l.y);
        if (p) this.schliesse(p);
      }
    }
  }
}
