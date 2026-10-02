#!/usr/bin/env node
/**
 * Eine Seite von Kuronami ansehen, wie Jakob sie sieht — angemeldet, in seinen Bildschirmgrößen.
 * Für Claude und den Nachtbau: bauen, ansehen, verbessern, wieder ansehen.
 *
 *   node bau/ansehen.mjs /os/                         → 1512×945 und 3440×1440
 *   node bau/ansehen.mjs "/os/#/handel" 900x700 --warte 3000
 *   UI_URL=http://localhost:3101 node bau/ansehen.mjs /os/     (Dev-Server im Worktree)
 *
 * Bilder unter /tmp/kuronami-ansehen/, Fehler der Seite auf der Konsole. Der Anmelde-Token kommt
 * aus /opt/kuronami/.env und wird nirgends ausgegeben.
 */
import { mkdirSync, readFileSync } from "node:fs";

const PLAYWRIGHT = "/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(PLAYWRIGHT);

const args = process.argv.slice(2);
const pfad = args.find((a) => a.startsWith("/")) ?? "/os/";
const groessen = args.filter((a) => /^\d+x\d+$/.test(a));
const warteIndex = args.indexOf("--warte");
const warte = warteIndex >= 0 ? Number(args[warteIndex + 1]) : 2500;
const basis = process.env.UI_URL ?? "http://localhost:3001";
const ziel = "/tmp/kuronami-ansehen";
mkdirSync(ziel, { recursive: true });

const env = readFileSync("/opt/kuronami/.env", "utf8");
const token = /^GATEWAY_WEB_TOKEN=(.*)$/m.exec(env)?.[1]?.trim() ?? "";

const browser = await chromium.launch({
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
for (const g of groessen.length > 0 ? groessen : ["1512x945", "3440x1440"]) {
  const [b, h] = g.split("x").map(Number);
  const page = await browser.newPage({ viewport: { width: b, height: h } });
  const fehler = [];
  page.on("pageerror", (e) => fehler.push(String(e)));
  page.on("console", (m) => m.type() === "error" && fehler.push(m.text()));
  await page.goto(`${basis}/os/begleiter/?vorschau`, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => localStorage.setItem("kuronami.webToken", t), token);
  await page.goto(`${basis}${pfad}`, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(warte);
  const datei = `${ziel}/${pfad.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "start"}-${g}.png`;
  await page.screenshot({ path: datei });
  console.log(
    `${datei}${fehler.length ? `\n  Fehler: ${fehler.slice(0, 5).join("\n  Fehler: ")}` : ""}`,
  );
  await page.close();
}
await browser.close();
