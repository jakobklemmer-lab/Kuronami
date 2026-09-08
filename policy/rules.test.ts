import { describe, expect, it } from "vitest";
import { redactText } from "../runtime/redaction/redact.js";
import { runHooks } from "./hooks.js";
import { assertPolicyFieldNames, describeResource, subjectFor } from "./resource.js";
import { RISK_LEVELS, RiskLevelError, assertRiskLevel, maxRisk, scopesFor } from "./risk.js";
import { DEFAULT_RULES, evaluateRules, ruleMatches } from "./rules.js";
import { SECRET_CLASSES, classifySecret } from "./secrets.js";
import type {
  PolicyHook,
  PolicyRequest,
  PolicyResource,
  PolicyRule,
  ResolvedResourcePath,
} from "./types.js";

/**
 * Die Ebenen 1 und 2 sowie die Risikostufen — **ohne Datenbank**. Das ist Absicht: eine
 * Regelauswertung, die sich nur mit laufendem Postgres prüfen lässt, wird seltener
 * gegengeprüft als eine, die in Millisekunden durchläuft. Dieselbe Trennung wie bei
 * `tools/fs/paths.test.ts` (S08) und `tools/web/egress.test.ts` (S09).
 */

function request(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    sessionId: "sess_test",
    callId: "call_1",
    toolName: "fs.write",
    risk: "soft_write",
    input: {},
    approvalMode: "ask",
    origin: "model",
    ...overrides,
  };
}

function pathResource(display: string, zone = "source"): PolicyResource {
  const path: ResolvedResourcePath = { absolute: `/root/${display}`, zone, display };
  return { kind: "path", path, secretClass: classifySecret(display) };
}

describe("Risikostufen · kein Tool ohne Zuordnung", () => {
  it("kennt genau die vier Stufen aus Abschnitt 10", () => {
    expect([...RISK_LEVELS]).toEqual(["read", "soft_write", "hard_write", "destructive"]);
  });

  it("weist eine fehlende oder unbekannte Stufe ab, statt eine zu raten", () => {
    for (const value of [undefined, null, "", "write", "READ", 3]) {
      expect(() => assertRiskLevel(value, 'Tool "x.y"')).toThrow(RiskLevelError);
    }
    expect(() => assertRiskLevel("hard_write", 'Tool "x.y"')).not.toThrow();
  });

  it("nimmt beim Anheben immer die schärfere Stufe", () => {
    expect(maxRisk("read", "hard_write")).toBe("hard_write");
    expect(maxRisk("destructive", "soft_write")).toBe("destructive");
    // Anheben auf eine niedrigere Stufe ändert nichts: senken kann keine Regel.
    expect(maxRisk("hard_write", "read")).toBe("hard_write");
  });

  it("lässt für zerstörende Aktionen nur die Einmalfreigabe zu", () => {
    expect(scopesFor("hard_write")).toEqual(["once", "session", "always"]);
    expect(scopesFor("destructive")).toEqual(["once"]);
  });
});

describe("Geheimnisklassen", () => {
  it("erkennt die üblichen Träger am Pfad", () => {
    expect(classifySecret(".env")).toBe("dotenv");
    expect(classifySecret("apps/api/.env.production")).toBe("dotenv");
    expect(classifySecret("certs/server.pem")).toBe("private-key");
    expect(classifySecret("home/.ssh/config")).toBe("ssh");
    expect(classifySecret(".aws/credentials")).toBe("cloud-credentials");
    expect(classifySecret("deploy/service_account.json")).toBe("cloud-credentials");
    expect(classifySecret("vault/secrets.yaml")).toBe("token-store");
  });

  it("lässt gewöhnliche Dateien in Ruhe", () => {
    for (const path of [
      "runtime/index.ts",
      "docs/ARCHITEKTUR.md",
      "src/environment.ts",
      "package.json",
    ]) {
      expect(classifySecret(path)).toBeNull();
    }
  });

  it("nimmt Vorlagen aus, aber nur die Vorlagen", () => {
    // `.env.example` liegt seit S01 in diesem Repo und trägt keinen einzigen Wert. Eine
    // Rückfrage dafür wäre offensichtlich unnötig — und offensichtlich unnötige Rückfragen
    // bringen dem Menschen bei, die nächste auch wegzuklicken.
    for (const path of [
      ".env.example",
      ".env.sample",
      "apps/api/.env.template",
      ".env.example.md",
    ]) {
      expect(classifySecret(path)).toBeNull();
    }
    for (const path of [".env", ".env.local", ".env.production.local"]) {
      expect(classifySecret(path)).toBe("dotenv");
    }
  });

  it("erkennt denselben Pfad auch beim zweiten Mal", () => {
    // Gegenprobe zu `assertSecretPatternsUsable`: ein globales Muster schleppte über `test`
    // einen `lastIndex` mit und lieferte beim zweiten Aufruf `false`. Der Fehler wäre still —
    // die erste .env fiele auf, die zweite nicht.
    expect(classifySecret(".env")).toBe("dotenv");
    expect(classifySecret(".env")).toBe("dotenv");
    expect(SECRET_CLASSES.every((entry) => entry.patterns.every((p) => !p.global))).toBe(true);
  });
});

describe("Statische Regeln · Glob und Achsen", () => {
  const rule: PolicyRule = {
    id: "test",
    description: "Testregel",
    when: {},
    effect: { decision: "deny" },
  };

  it("trifft Toolnamen per Glob", () => {
    const withTool = { ...rule, when: { tool: "fs.*" } };
    expect(ruleMatches(withTool, request({ toolName: "fs.write" }), { kind: "none" }, "read")).toBe(
      true,
    );
    expect(
      ruleMatches(withTool, request({ toolName: "web.fetch" }), { kind: "none" }, "read"),
    ).toBe(false);
  });

  it("trifft Pfade per Glob, `**` überschreitet Segmentgrenzen und deckt die Wurzel", () => {
    const gitRule = { ...rule, when: { path: "**/.git/**" } };
    for (const hit of [".git/config", "packages/app/.git/HEAD"]) {
      expect(ruleMatches(gitRule, request(), pathResource(hit), "soft_write")).toBe(true);
    }
    expect(ruleMatches(gitRule, request(), pathResource("src/git/config"), "soft_write")).toBe(
      false,
    );

    const flat = { ...rule, when: { path: "src/*.ts" } };
    expect(ruleMatches(flat, request(), pathResource("src/one.ts"), "soft_write")).toBe(true);
    // Ein einzelner Stern bleibt im Segment.
    expect(ruleMatches(flat, request(), pathResource("src/tief/one.ts"), "soft_write")).toBe(false);
  });

  it("trifft Hosts auf Punktgrenze, wie die Egress-Allowlist", () => {
    const hostRule = { ...rule, when: { host: "example.com" } };
    const at = (host: string): PolicyResource => ({ kind: "host", host, url: `https://${host}/` });
    expect(ruleMatches(hostRule, request(), at("example.com"), "read")).toBe(true);
    expect(ruleMatches(hostRule, request(), at("api.example.com"), "read")).toBe(true);
    expect(ruleMatches(hostRule, request(), at("notexample.com"), "read")).toBe(false);
  });

  it("lässt `zoneNot` nur auf aufgelöste Pfade greifen", () => {
    const outside = { ...rule, when: { zoneNot: "artifact" } };
    expect(ruleMatches(outside, request(), pathResource("src/x.ts", "source"), "soft_write")).toBe(
      true,
    );
    expect(ruleMatches(outside, request(), pathResource("a/x.txt", "artifact"), "soft_write")).toBe(
      false,
    );
    // Ein Aufruf ohne Pfad ist von einer Zonenregel nicht betroffen — sonst träfe sie
    // `task.set` mit.
    expect(
      ruleMatches(outside, request({ toolName: "task.set" }), { kind: "none" }, "soft_write"),
    ).toBe(false);
  });
});

describe("Statische Regeln · die schärfste Aussage gewinnt", () => {
  const allowAll: PolicyRule = {
    id: "allow-all",
    description: "erlaubt alles",
    when: {},
    effect: { decision: "allow" },
  };
  const denyEnv: PolicyRule = {
    id: "deny-env",
    description: "verbietet .env",
    when: { path: "**/.env" },
    effect: { decision: "deny" },
  };

  it("lässt sich von einem breiten allow nicht abschalten — in beiden Reihenfolgen", () => {
    const resource = pathResource(".env");
    for (const rules of [
      [allowAll, denyEnv],
      [denyEnv, allowAll],
    ]) {
      const { verdicts } = evaluateRules(rules, request({ toolName: "fs.read" }), resource);
      expect(verdicts.map((entry) => entry.decision)).toContain("deny");
    }
  });

  it("hebt die Stufe an, aber senkt sie nie", () => {
    const lower: PolicyRule = {
      id: "lower",
      description: "versucht zu senken",
      when: {},
      effect: { raiseTo: "read" },
    };
    const { effectiveRisk } = evaluateRules(
      [lower, ...DEFAULT_RULES],
      request({ toolName: "fs.write", risk: "soft_write" }),
      pathResource("src/neu.ts", "source"),
    );
    expect(effectiveRisk).toBe("hard_write");
  });
});

describe("Der ausgelieferte Regelsatz", () => {
  it("macht aus einem Schreibzugriff außerhalb der Artefaktzone hartes Schreiben", () => {
    const outside = evaluateRules(
      DEFAULT_RULES,
      request({ toolName: "fs.write" }),
      pathResource("src/neu.ts", "source"),
    );
    expect(outside.effectiveRisk).toBe("hard_write");
    expect(outside.verdicts.map((entry) => entry.id)).toContain("write-outside-artifact-zone");

    const inside = evaluateRules(
      DEFAULT_RULES,
      request({ toolName: "fs.write" }),
      pathResource("artifacts/x.txt", "artifact"),
    );
    expect(inside.effectiveRisk).toBe("soft_write");
  });

  it("lässt Lesen außerhalb der Artefaktzone unangetastet", () => {
    // Die Anhebung gilt dem Schreiben. Wäre sie toolweit, wäre jedes `fs.read` im Projekt
    // ein hartes Schreiben, und die Rückfrage käme bei jeder gelesenen Datei.
    const { effectiveRisk } = evaluateRules(
      DEFAULT_RULES,
      request({ toolName: "fs.read", risk: "read" }),
      pathResource("runtime/index.ts", "source"),
    );
    expect(effectiveRisk).toBe("read");
  });

  it("fragt beim Lesen eines Geheimnisträgers und verbietet das Schreiben", () => {
    const read = evaluateRules(
      DEFAULT_RULES,
      request({ toolName: "fs.read", risk: "read" }),
      pathResource(".env"),
    );
    expect(read.verdicts.filter((entry) => entry.id === "secret-read")[0]?.decision).toBe("ask");

    const write = evaluateRules(
      DEFAULT_RULES,
      request({ toolName: "fs.write" }),
      pathResource(".env"),
    );
    expect(write.verdicts.filter((entry) => entry.id === "secret-write")[0]?.decision).toBe("deny");
  });

  it("verbietet Schreibzugriffe in .git", () => {
    const { verdicts } = evaluateRules(
      DEFAULT_RULES,
      request({ toolName: "fs.write" }),
      pathResource(".git/config"),
    );
    expect(verdicts.filter((entry) => entry.id === "git-internals-write")[0]?.decision).toBe(
      "deny",
    );
  });
});

describe("Hooks · Ebene 1", () => {
  const hook = (id: string, answer: () => unknown): PolicyHook => ({
    id,
    check: answer as PolicyHook["check"],
  });

  it("gibt die Meinung eines Hooks als Urteil zurück und überspringt Enthaltungen", async () => {
    const verdicts = await runHooks(
      [
        hook("still", () => undefined),
        hook("laut", () => ({ decision: "ask", reason: "will gefragt werden" })),
      ],
      request(),
      { kind: "none" },
    );
    expect(verdicts).toEqual([
      { layer: "hook", id: "laut", decision: "ask", reason: "will gefragt werden" },
    ]);
  });

  it("wertet einen geworfenen Hook als Ablehnung und behält den Wortlaut", async () => {
    // Fail closed. Die Gegenannahme — "kaputter Hook heißt keine Meinung" — schaltet still
    // genau die Prüfung ab, für die jemand ihn geschrieben hat.
    const verdicts = await runHooks(
      [
        hook("kaputt", () => {
          throw new Error("Tippfehler im Hook");
        }),
      ],
      request(),
      { kind: "none" },
    );
    expect(verdicts[0].decision).toBe("deny");
    expect(verdicts[0].reason).toMatch(/Tippfehler im Hook/);
  });

  it("bricht nach der ersten Ablehnung ab", async () => {
    let ran = 0;
    const verdicts = await runHooks(
      [
        hook("nein", () => ({ decision: "deny", reason: "nein" })),
        hook("danach", () => {
          ran += 1;
          return undefined;
        }),
      ],
      request(),
      { kind: "none" },
    );
    expect(verdicts).toHaveLength(1);
    expect(ran).toBe(0);
  });
});

describe("Ressource und Subjektschlüssel", () => {
  const resolve = async (input: string): Promise<ResolvedResourcePath> => ({
    absolute: `/root/${input}`,
    zone: input.startsWith("artifacts/") ? "artifact" : "source",
    display: input,
  });

  it("findet Pfad und Adresse unter den vereinbarten Feldnamen", async () => {
    const asPath = await describeResource(
      request({ input: { path: "src/x.ts" } }),
      resolve,
      classifySecret,
    );
    expect(asPath).toMatchObject({ kind: "path", secretClass: null });

    const asHost = await describeResource(
      request({ toolName: "web.fetch", input: { url: "https://Example.com/a?b=1" } }),
      resolve,
      classifySecret,
    );
    expect(asHost).toMatchObject({ kind: "host", host: "example.com" });

    const nothing = await describeResource(
      request({ toolName: "task.set" }),
      resolve,
      classifySecret,
    );
    expect(nothing).toEqual({ kind: "none" });
  });

  it("meldet einen nicht auflösbaren Pfad als solchen, statt ihn zu übergehen", async () => {
    const broken = await describeResource(
      request({ input: { path: "../../etc/passwd" } }),
      async () => {
        throw new Error("liegt außerhalb der erlaubten Zonen");
      },
      classifySecret,
    );
    expect(broken).toMatchObject({ kind: "unresolvable" });
  });

  it("schneidet Geheimnisse je Datei, Pfade je Zone und Adressen je Host", () => {
    expect(subjectFor("fs.write", pathResource("src/x.ts", "source"))).toBe("fs.write|zone/source");
    expect(subjectFor("fs.read", pathResource(".env"))).toBe("fs.read|secret/dotenv/.env");
    // Zwei .env-Dateien sind zwei Freigaben: eine erteilte deckt die andere nicht.
    expect(subjectFor("fs.read", pathResource("api/.env"))).not.toBe(
      subjectFor("fs.read", pathResource(".env")),
    );
    expect(
      subjectFor("web.fetch", { kind: "host", host: "example.com", url: "https://example.com/" }),
    ).toBe("web.fetch|host/example.com");
    expect(subjectFor("task.set", { kind: "none" })).toBe("task.set|-");
  });

  it("überlebt den Redaction-Filter unverändert", () => {
    // Der Schlüssel wird geschrieben und später wieder nachgeschlagen. Verändert ihn der
    // Filter auf dem Weg ins Protokoll, wird eine erteilte Freigabe nie wiedergefunden — und
    // zwar stumm. Genau das ist beim Bauen passiert: mit `:` als Trenner las das Fangnetz für
    // Schlüssel-Wert-Paare `secret:dotenv` als Zuweisung und ersetzte den Wert.
    const subjects = [
      subjectFor("fs.read", pathResource(".env")),
      subjectFor("fs.read", pathResource("certs/server.pem")),
      subjectFor("fs.read", pathResource(".aws/credentials")),
      subjectFor("fs.write", pathResource("src/x.ts", "source")),
      subjectFor("web.fetch", { kind: "host", host: "example.com", url: "https://example.com/" }),
    ];
    for (const subject of subjects) {
      expect(redactText(subject)).toBe(subject);
    }
  });

  it("erzwingt die Feldnamen, unter denen die Policy Pfad und Adresse findet", () => {
    expect(() => assertPolicyFieldNames("fs.write", ["path", "content"])).not.toThrow();
    expect(() => assertPolicyFieldNames("web.fetch", ["url", "headers"])).not.toThrow();
    // Genau die stille Umgehung, gegen die geprüft wird.
    expect(() => assertPolicyFieldNames("x.y", ["target_path"])).toThrow(/target_path/);
    expect(() => assertPolicyFieldNames("x.y", ["endpoint"])).toThrow(/endpoint/);
    expect(() => assertPolicyFieldNames("x.y", ["filename"])).toThrow(/filename/);
  });
});
