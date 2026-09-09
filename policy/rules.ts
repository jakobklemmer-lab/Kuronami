import { type RiskLevel, maxRisk } from "./risk.js";
import type { PolicyRequest, PolicyResource, PolicyRule, PolicyVerdict } from "./types.js";

/**
 * Ebene 2 aus Abschnitt 10: statische Regeln, Allow/Deny/Ask nach Tool, Pfad, Domain,
 * Geheimnisklasse.
 *
 * **Es gewinnt nicht die erste passende Regel, sondern die schärfste.** Das ist die
 * wichtigste Entscheidung dieser Datei und sie geht gegen die übliche Bauweise. Bei
 * "erste Regel gewinnt" hängt die Sicherheit an der Reihenfolge einer Liste: ein breites
 * `allow` weiter oben schaltet jede spätere Verschärfung ab, und man sieht es der Liste nicht
 * an — man muss sie von oben lesen und mitdenken, welche Regel vorher schon zugeschlagen hat.
 * Beim Auswerten aller Regeln und Nehmen der schärfsten Aussage ist die Reihenfolge
 * bedeutungslos, und eine hinzugefügte Regel kann nie weniger streng machen, als es vorher
 * war. Der Preis ist, dass eine Ausnahme ("dieses eine Verzeichnis doch") sich nicht als
 * `allow` schreiben lässt — sie gehört in die Bedingung der schärferen Regel.
 *
 * Aus demselben Grund kann eine Regel die Risikostufe nur **anheben** (`raiseTo`). Eine
 * Regel, die senken darf, ist eine Regel, mit der sich jede Stufe wegkonfigurieren lässt;
 * dann stünde die Tabelle aus Abschnitt 10 unter dem Vorbehalt der Regeldatei.
 */

/**
 * Glob → RegExp. `*` bleibt innerhalb eines Segments, `**` überschreitet Segmentgrenzen,
 * `**​/` deckt auch die Wurzel (`**​/.git/**` trifft `.git/config`). Bewusst ohne Bibliothek
 * und bewusst klein: Zeichenklassen und Alternativen fehlen sichtbar.
 */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        // `**/` deckt auch den leeren Präfix, sonst verlangte `**​/x` mindestens ein Segment.
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function matchesGlob(glob: string, value: string): boolean {
  return globToRegExp(glob).test(value);
}

/** Host oder Elterndomain, auf Punktgrenze — dieselbe Lesart wie die Egress-Allowlist (S09). */
function matchesHost(pattern: string, host: string): boolean {
  const needle = pattern.toLowerCase().replace(/^\.+/, "");
  return host === needle || host.endsWith(`.${needle}`);
}

function asList<T>(value: T | T[] | undefined): T[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

/** Trifft die Regel auf diesen Antrag zu? Alle gesetzten Bedingungen müssen erfüllt sein. */
export function ruleMatches(
  rule: PolicyRule,
  request: PolicyRequest,
  resource: PolicyResource,
  effectiveRisk: RiskLevel,
): boolean {
  const when = rule.when;

  const tools = asList(when.tool);
  if (tools && !tools.some((glob) => matchesGlob(glob, request.toolName))) return false;

  const risks = asList(when.risk);
  if (risks && !risks.includes(effectiveRisk)) return false;

  if (when.path !== undefined) {
    if (resource.kind !== "path") return false;
    if (!matchesGlob(when.path, resource.path.display)) return false;
  }

  if (when.zone !== undefined) {
    if (resource.kind !== "path" || resource.path.zone !== when.zone) return false;
  }

  if (when.zoneNot !== undefined) {
    // Nur ein aufgelöster Pfad kann "nicht in Zone X" sein. Ein Aufruf ohne Pfad ist von
    // einer Zonenregel nicht betroffen, sonst träfe `zoneNot` auch `task.set`.
    if (resource.kind !== "path" || resource.path.zone === when.zoneNot) return false;
  }

  if (when.host !== undefined) {
    if (resource.kind !== "host" || !matchesHost(when.host, resource.host)) return false;
  }

  if (when.secretClass !== undefined) {
    if (resource.kind !== "path" || resource.secretClass === null) return false;
    if (when.secretClass !== "*" && resource.secretClass !== when.secretClass) return false;
  }

  return true;
}

export interface RuleEvaluation {
  verdicts: PolicyVerdict[];
  /** Die Stufe nach allen `raiseTo`. Nie unter der deklarierten. */
  effectiveRisk: RiskLevel;
}

/**
 * Wertet alle Regeln aus. Zwei Durchläufe, und das ist nötig statt hübsch: `when.risk` fragt
 * nach der **wirksamen** Stufe, und die steht erst fest, wenn alle `raiseTo` angewandt sind.
 * Liefe beides in einem Durchlauf, hinge das Ergebnis an der Reihenfolge der Regeln — genau
 * an dem, wovon diese Datei unabhängig sein soll. Ein Anheben in Durchlauf zwei gibt es
 * deshalb nicht: dort wird nur noch entschieden.
 */
export function evaluateRules(
  rules: readonly PolicyRule[],
  request: PolicyRequest,
  resource: PolicyResource,
): RuleEvaluation {
  let effectiveRisk = request.risk;
  const verdicts: PolicyVerdict[] = [];

  for (const rule of rules) {
    if (rule.effect.raiseTo === undefined) continue;
    // Anhebende Regeln fragen gegen die deklarierte Stufe. Sie gegen die schon angehobene zu
    // prüfen, hinge wieder an der Reihenfolge.
    if (!ruleMatches(rule, request, resource, request.risk)) continue;
    const raised = maxRisk(effectiveRisk, rule.effect.raiseTo);
    if (raised !== effectiveRisk) {
      verdicts.push({
        layer: "rule",
        id: rule.id,
        decision: "allow",
        reason: `hebt die Risikostufe auf "${raised}" (${rule.description})`,
      });
      effectiveRisk = raised;
    }
  }

  for (const rule of rules) {
    if (rule.effect.decision === undefined) continue;
    if (!ruleMatches(rule, request, resource, effectiveRisk)) continue;
    verdicts.push({
      layer: "rule",
      id: rule.id,
      decision: rule.effect.decision,
      reason: rule.description,
    });
  }

  return { verdicts, effectiveRisk };
}

/** Die Stufen, bei denen etwas geschrieben oder zerstört wird. */
const WRITING: RiskLevel[] = ["soft_write", "hard_write", "destructive"];

/**
 * Der ausgelieferte Regelsatz. Bewusst kurz: vier Regeln, jede mit einem Grund, der ohne
 * diesen Kommentar nicht zu erraten wäre. Was hier nicht steht, entscheiden Risikostufe und
 * Sessionmodus — ein langer Regelsatz, den niemand mehr im Kopf hat, ist keine Governance,
 * sondern eine zweite Codebasis.
 */
export const DEFAULT_RULES: PolicyRule[] = [
  {
    id: "write-outside-artifact-zone",
    description:
      "Schreiben außerhalb der Artefaktzone ist hartes Schreiben. Abschnitt 10 erlaubt weiches Schreiben 'automatisch im Arbeitsverzeichnis' — außerhalb davon endet die Automatik.",
    when: { risk: WRITING, zoneNot: "artifact" },
    effect: { raiseTo: "hard_write" },
  },
  {
    id: "secret-read",
    description:
      "Eine Datei zu lesen, deren Inhalt per Bauart ein Geheimnis ist, braucht eine eigene Freigabe. Der Redaction-Filter ersetzt bekannte Formen, aber er kennt nicht jede.",
    when: { secretClass: "*", risk: ["read"] },
    effect: { decision: "ask" },
  },
  {
    id: "secret-write",
    description:
      "Zugangsdateien werden nicht geschrieben. Ein Assistent, der .env oder einen privaten Schlüssel überschreibt, macht aus einem Fehlgriff einen Verlust, den kein Replay zurückholt. Wer das ändern will, ändert diese Regel — sichtbar und versioniert.",
    when: { secretClass: "*", risk: WRITING },
    effect: { decision: "deny" },
  },
  {
    id: "git-internals-write",
    description:
      "In .git wird nicht geschrieben. Ein Schreibzugriff dort sieht aus wie eine Datei und wirkt wie eine Historienänderung; git-Operationen laufen über ihre eigenen Tools, nicht über fs.*.",
    when: { path: "**/.git/**", risk: WRITING },
    effect: { decision: "deny" },
  },
];

/**
 * Der Zusatzregelsatz für **Hintergrundläufe** (Heartbeat, S17). Er wird `DEFAULT_RULES`
 * vorangestellt, nicht ersetzt — die vier Standardregeln gelten weiter, diese drei kommen
 * obendrauf.
 *
 * Ein Hintergrundlauf ist eine Session ohne Menschen am anderen Ende: der Heartbeat stößt sie
 * ohne Nutzereingabe an, niemand wartet auf eine Rückfrage. Für die Governance heißt das, dass
 * die Ebene 4 aus Abschnitt 10 (der Mensch entscheidet) **nicht verfügbar** ist. Eine
 * Entscheidung, die im normalen Betrieb `ask` wäre, ist hier faktisch `hang` — der Lauf bliebe
 * auf `awaiting_user` stehen, bis ihn jemand abräumt. Deshalb werden die Fälle, in denen ein
 * Hintergrundlauf sonst fragen würde, hier zu einem klaren `deny`: der Lauf liest den Grund im
 * selben Zug und wählt einen anderen Weg (Abschnitt 7), statt zu warten.
 *
 * Die erste Regel ist der eigentliche Auftrag von S17 — **die Schreibgrenze ans
 * Langzeitgedächtnis, technisch erzwungen.** Ein proaktiver Lauf, der ungefragt nach
 * `memory/` schreibt, verschmutzt das Gedächtnis schleichend selbst: jeder Lauf legt eine
 * Notiz ab, die der nächste Lauf als Kontext liest und bestätigt, und nach einem Monat steht
 * dort, was der Assistent für wahr hält, nicht was der Mensch entschieden hat. Wer will, dass
 * ein Hintergrundlauf etwas ins Gedächtnis legt, macht daraus einen **Vorschlag im Digest** —
 * die Aufnahme entscheidet ein Mensch. Deshalb `deny` und nicht `ask`: eine sessionweite
 * Freigabe (die es bei `ask` gäbe) wäre genau die Lücke, durch die die Automatik doch wieder
 * schreiben dürfte.
 */
export const BACKGROUND_RULES: PolicyRule[] = [
  {
    id: "background-longterm-memory-write",
    description:
      "Ein Hintergrundlauf schreibt nicht ins Langzeitgedächtnis (memory/). Nicht freigabepflichtig, sondern gesperrt: ein Lauf ohne Menschen am anderen Ende kann keine Freigabe einholen, und eine schleichende Selbstverschmutzung des Gedächtnisses ist genau der Schaden, den S17 ausschließt. Aufnahme ins Gedächtnis entscheidet ein Mensch, angestoßen durch einen Vorschlag im Digest.",
    when: { path: "memory/**", risk: WRITING },
    effect: { decision: "deny" },
  },
  {
    id: "background-source-write",
    description:
      "Ein Hintergrundlauf schreibt überhaupt nur in die Artefaktzone. Jeder Schreibzugriff in die Quellzone — Quelltext, AGENTS.md, .env und eben memory/ — wird abgelehnt, nicht bloß zur Freigabe gestellt. 'Lesen und vorschlagen' aus dem Auftrag heißt: das Ergebnis ist ein Artefakt und eine Nachricht, kein Eingriff.",
    when: { risk: WRITING, zoneNot: "artifact" },
    effect: { decision: "deny" },
  },
  {
    id: "background-secret-read",
    description:
      "Ein Hintergrundlauf liest keine Geheimnisträger (.env, *.pem, .ssh/). Der Standard fragt hier nach; ohne Menschen am anderen Ende ist 'fragen' aber 'hängen'. Ein Digest braucht keine Zugangsdaten.",
    when: { secretClass: "*", risk: ["read"] },
    effect: { decision: "deny" },
  },
];
