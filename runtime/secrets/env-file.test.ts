import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  KNOWN_SECRET_KEYS,
  envFilePathFromEnv,
  isSecretKey,
  readEnvFile,
  readSecretStatus,
  upsertSecrets,
  writeEnvFile,
} from "./env-file.js";

describe("readSecretStatus", () => {
  it("meldet gesetzte Schlüssel mit den letzten vier Zeichen, nie im Ganzen", () => {
    const status = readSecretStatus("ANTHROPIC_API_KEY=sk-ant-workspace-abcd1234\n");
    expect(status.ANTHROPIC_API_KEY).toEqual({ set: true, preview: "…1234" });
    expect(JSON.stringify(status)).not.toContain("sk-ant-workspace");
  });

  it("meldet einen fehlenden oder leeren Schlüssel als nicht gesetzt", () => {
    const status = readSecretStatus("DEEPGRAM_API_KEY=\n");
    expect(status.DEEPGRAM_API_KEY).toEqual({ set: false, preview: null });
    expect(status.ELEVENLABS_API_KEY).toEqual({ set: false, preview: null });
  });

  it("ignoriert Kommentare und Zeilen ohne '='", () => {
    const status = readSecretStatus(
      "# ANTHROPIC_API_KEY=sk-im-kommentar\nkeine-zeile-mit-gleich\n",
    );
    expect(status.ANTHROPIC_API_KEY).toEqual({ set: false, preview: null });
  });

  it("nennt nur die angefragten Schlüssel", () => {
    const status = readSecretStatus("ANTHROPIC_API_KEY=abcd1234", ["ANTHROPIC_API_KEY"]);
    expect(Object.keys(status)).toEqual(["ANTHROPIC_API_KEY"]);
  });
});

describe("upsertSecrets", () => {
  it("ersetzt den Wert einer bestehenden Zeile, alles andere bleibt Zeichen für Zeichen gleich", () => {
    const before = "# Kommentar\nANTHROPIC_API_KEY=alt-1234\nVOICE_MODE=live\n";
    const after = upsertSecrets(before, { ANTHROPIC_API_KEY: "neu-5678" });
    expect(after).toBe("# Kommentar\nANTHROPIC_API_KEY=neu-5678\nVOICE_MODE=live\n");
  });

  it("hängt einen bisher fehlenden Schlüssel ans Ende an", () => {
    const after = upsertSecrets("VOICE_MODE=live\n", { DEEPGRAM_API_KEY: "dg-neu" });
    expect(after).toBe("VOICE_MODE=live\nDEEPGRAM_API_KEY=dg-neu\n");
  });

  it("baut aus leerem Inhalt eine neue Datei", () => {
    expect(upsertSecrets("", { ANTHROPIC_API_KEY: "x" })).toBe("ANTHROPIC_API_KEY=x\n");
  });

  it("weist einen nicht erlaubten Schlüssel ab, ohne irgendetwas zu schreiben", () => {
    expect(() => upsertSecrets("VOICE_MODE=live\n", { PATH: "/böse" })).toThrow(/PATH/);
  });

  it("weist einen Wert mit Zeilenumbruch ab", () => {
    expect(() => upsertSecrets("", { ANTHROPIC_API_KEY: "a\nb" })).toThrow(/Zeilenumbruch/);
  });
});

describe("isSecretKey", () => {
  it("kennt genau die Liste aus KNOWN_SECRET_KEYS", () => {
    for (const key of KNOWN_SECRET_KEYS) expect(isSecretKey(key)).toBe(true);
    expect(isSecretKey("PATH")).toBe(false);
  });
});

describe("envFilePathFromEnv", () => {
  it("löst relativ zum Arbeitsverzeichnis auf, ohne KURONAMI_ENV_FILE", () => {
    expect(envFilePathFromEnv(undefined)).toBe(path.resolve(".env"));
  });

  it("nimmt einen expliziten Pfad", () => {
    expect(envFilePathFromEnv("/tmp/irgendwo/.env")).toBe(path.resolve("/tmp/irgendwo/.env"));
  });
});

describe("readEnvFile/writeEnvFile", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kuronami-env-file-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("liest eine fehlende Datei als leeren Inhalt statt zu werfen", async () => {
    expect(await readEnvFile(path.join(dir, "fehlt.env"))).toBe("");
  });

  it("schreibt und liest denselben Inhalt zurück", async () => {
    const file = path.join(dir, ".env");
    await writeEnvFile(file, "ANTHROPIC_API_KEY=abcd1234\n");
    expect(await readEnvFile(file)).toBe("ANTHROPIC_API_KEY=abcd1234\n");
    expect(await readFile(file, "utf8")).toBe("ANTHROPIC_API_KEY=abcd1234\n");
  });
});
