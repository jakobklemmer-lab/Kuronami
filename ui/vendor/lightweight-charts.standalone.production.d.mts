/**
 * Minimaltypen für das vendorte Standalone-Modul (v4.2.0) — nur, was `ui/views/trading.ts`
 * tatsächlich aufruft. Die volle Definition liefert das npm-Paket `lightweight-charts`; die
 * hier ist bewusst schmal gehalten, damit sie nicht mit dem echten Paket kollidiert, falls es
 * später doch als devDependency dazukommt.
 */

export interface CandlestickData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface CandlestickSeriesApi {
  setData(data: CandlestickData[]): void;
  update(bar: CandlestickData): void;
}

export interface TimeScaleApi {
  fitContent(): void;
}

export interface ChartApi {
  addCandlestickSeries(options?: Record<string, unknown>): CandlestickSeriesApi;
  timeScale(): TimeScaleApi;
  resize(width: number, height: number): void;
  remove(): void;
}

export function createChart(container: HTMLElement, options?: Record<string, unknown>): ChartApi;
