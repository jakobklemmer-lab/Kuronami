/**
 * Die Prompt-Zeile, umgehängt (Auftrag S16).
 *
 * Bis S15 war eine Eingabe ein Argument an `runtime/index.ts`: `pnpm run:task "…"`. Das lief
 * an allem vorbei, was einen Kanal ausmacht — keine Authentifizierung, keine normalisierte
 * Nachrichtenform, ein eigener Faden und damit ein eigenes Gedächtnis. `pnpm say "…"` schickt
 * dieselbe Zeile an den Web-Kanal des Gateways, und sie landet in derselben Session wie eine
 * Telegram-Nachricht.
 *
 * Das hier ist bewusst ein **Klient und kein zweiter Eingang**: er kann nichts, was nicht auch
 * über HTTP ginge, und er hält keinen Zustand. Der direkte Weg `pnpm run:task` bleibt daneben
 * bestehen und heißt jetzt, was er ist — ein Lauf ohne Kanal, zum Prüfen.
 */

const url = (process.env.GATEWAY_URL ?? "http://localhost:8788").replace(/\/+$/, "");
const token = process.env.GATEWAY_WEB_TOKEN?.trim() ?? "";

interface Delivery {
  at: string;
  message:
    | { kind: "reply"; text: string }
    | {
        kind: "approval";
        askId: string;
        question: string;
        options: { id: string; label: string }[];
      };
}

function usage(): never {
  console.error(
    [
      "Aufruf:",
      '  pnpm say "Deine Nachricht"          — Nachricht über den Web-Kanal schicken',
      "  pnpm say --answer <ask_id> <option> — eine offene Rückfrage beantworten",
      "  pnpm say --pending                  — offene Rückfragen anzeigen",
      "",
      "Umgebung: GATEWAY_URL (Vorgabe http://localhost:8788), GATEWAY_WEB_TOKEN.",
    ].join("\n"),
  );
  process.exit(2);
}

async function call(path: string, method: "GET" | "POST", body?: unknown): Promise<unknown> {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Antwort war kein JSON (HTTP ${response.status}): ${text.slice(0, 300)}`);
  }
  if (!response.ok) {
    const error = parsed as { error?: string };
    throw new Error(`HTTP ${response.status}: ${error.error ?? text.slice(0, 300)}`);
  }
  return parsed;
}

function show(result: { status?: string; reason?: string; deliveries?: Delivery[] }): void {
  console.log(`--- ${result.status ?? "?"}: ${result.reason ?? ""}`);
  for (const delivery of result.deliveries ?? []) {
    if (delivery.message.kind === "reply") {
      console.log(`\n${delivery.message.text}`);
      continue;
    }
    console.log(`\nFreigabe nötig: ${delivery.message.question}`);
    for (const option of delivery.message.options) {
      console.log(`  ${option.id} — ${option.label}`);
    }
    console.log(`\nAntworten mit: pnpm say --answer ${delivery.message.askId} <option>`);
  }
}

async function main(): Promise<void> {
  if (token.length === 0) {
    console.error("GATEWAY_WEB_TOKEN ist nicht gesetzt — der Web-Kanal nimmt nichts an.");
    process.exit(2);
  }

  const args = process.argv.slice(2);
  if (args.length === 0) usage();

  if (args[0] === "--pending") {
    const result = (await call("/channels/web/pending", "GET")) as {
      sessionId: string;
      pending: { askId: string; question: string; options: { id: string; label: string }[] }[];
    };
    console.log(`Session ${result.sessionId}`);
    if (result.pending.length === 0) {
      console.log("Nichts offen.");
      return;
    }
    for (const ask of result.pending) {
      console.log(`\n${ask.askId}: ${ask.question}`);
      for (const option of ask.options) console.log(`  ${option.id} — ${option.label}`);
    }
    return;
  }

  if (args[0] === "--answer") {
    if (args.length < 3) usage();
    show(
      (await call("/channels/web/answers", "POST", {
        askId: args[1],
        choiceId: args[2],
      })) as Parameters<typeof show>[0],
    );
    return;
  }

  show(
    (await call("/channels/web/messages", "POST", {
      content: args.join(" "),
      displayName: process.env.USERNAME ?? process.env.USER ?? "cli",
    })) as Parameters<typeof show>[0],
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
