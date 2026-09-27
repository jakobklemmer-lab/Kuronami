import type { EventBusClient } from "../events/bus.js";

/**
 * Ein ausgelöster Preisalarm (`gateway/alarme.ts`) meldet sich in jedem offenen Fenster —
 * gleich welcher Bereich gerade offen ist. Als Hinweis in der Oberfläche und, wenn Jakob es
 * beim ersten Alarm erlaubt hat, als Mitteilung des Systems; die sieht er auch, wenn der Tab
 * im Hintergrund liegt.
 *
 * Ohne offenes Fenster erreicht ihn der Alarm nicht: dafür bräuchte es einen Kanal nach
 * draußen (Telegram ist vorbereitet, aber ohne Bot-Token). Das steht so in der Oberfläche.
 */
export function meldeAlarme(bus: EventBusClient, zeige: (text: string) => void): () => void {
  return bus.onMessage((nachricht) => {
    if (nachricht.type !== "alarm.ausgeloest") return;
    const daten = (nachricht.data ?? {}) as { text?: unknown; id?: unknown };
    const text = typeof daten.text === "string" ? daten.text : "Ein Preisalarm hat ausgelöst.";
    zeige(`Alarm: ${text}`);
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification("Kuronami · Alarm", {
          body: text,
          tag: typeof daten.id === "string" ? daten.id : undefined,
        });
      }
    } catch {
      // Manche Browser erlauben Mitteilungen nur über einen Service Worker — der Hinweis steht.
    }
  });
}
