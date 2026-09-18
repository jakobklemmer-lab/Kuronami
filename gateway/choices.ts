/**
 * Eine getippte oder gesprochene Antwort einer offenen Rückfrage-Option zuordnen.
 *
 * Wortgleicher Port von `voice/pipeline/choices.py` (S31) — absichtlich derselbe Algorithmus,
 * damit „wichtiges" per Stimme und per Tastatur dasselbe bedeutet. Ohne diesen Schritt stand
 * die Web-Unterhaltung an jeder Rückfrage still: eine Nachricht löst keine Entscheidung auf,
 * und wer die Antwort tippte statt zu klicken — auch wortgleich mit einer Option — prallte ab
 * (`gateway/core.ts`, `status: "busy"`). Für eine reine Sprachbedienung ist Klicken keine
 * Option, also muss der Wortlaut reichen.
 *
 * Die Zuordnung ist bewusst **streng und ohne Modell**. Ein Sprachmodell, das aus „eigentlich
 * lieber nicht" eine Freigabe macht, wäre genau die Art Fehler, die Abschnitt 10 verhindern
 * soll: eine Zustimmung, die niemand gegeben hat. Kein Treffer heißt kein Treffer — dann bleibt
 * es bei der Nachfrage mit denselben Optionen.
 *
 * Fünf Wege, in dieser Reihenfolge:
 *  1. Eine Verneinung, die genau **eine** Option trägt — sie steht vorn, siehe `matchChoice`.
 *  2. Die Kennung der Option wörtlich (`genehmigen`).
 *  3. Die Beschriftung wörtlich.
 *  4. Ein Zustimmungswort, das genau **eine** Option trägt.
 *  5. Eine Ordnungszahl („die erste", „Option zwei").
 */

export interface Choice {
  id: string;
  label: string;
}

/** Wörter, die eine Zustimmung sind — und nur solche, die nichts anderes sein können. */
const YES_WORDS = new Set([
  "ja",
  "jawohl",
  "klar",
  "genau",
  "okay",
  "ok",
  "mach",
  "machs",
  "los",
  "freigeben",
  "genehmigen",
  "erlauben",
  "zustimmen",
]);
const NO_WORDS = new Set([
  "nein",
  "nicht",
  "stopp",
  "stop",
  "abbrechen",
  "lass",
  "ablehnen",
  "nee",
  "kein",
]);

const ORDINALS: Record<string, number> = {
  erste: 1,
  ersten: 1,
  eins: 1,
  "1": 1,
  zweite: 2,
  zweiten: 2,
  zwei: 2,
  "2": 2,
  dritte: 3,
  dritten: 3,
  drei: 3,
  "3": 3,
  vierte: 4,
  vierten: 4,
  vier: 4,
  "4": 4,
};

/** Kleingeschrieben, ohne Diakritika, ohne Satzzeichen — „Ja, genehmigen!" trifft `genehmigen`. */
export function normalize(text: string): string {
  const folded = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "");
  return folded.replace(/[^a-z0-9äöüß ]+/g, " ");
}

function words(text: string): string[] {
  return normalize(text).split(" ").filter((word) => word.length > 0);
}

function unique(candidates: Choice[]): string | null {
  return candidates.length === 1 ? candidates[0].id : null;
}

function carries(option: Choice, vocabulary: Set<string>): boolean {
  return words(`${option.id} ${option.label}`).some((word) => vocabulary.has(word));
}

/** Die `choiceId` zur Antwort, oder `null`. Nie ein geratener Treffer. */
export function matchChoice(spoken: string, options: readonly Choice[]): string | null {
  if (options.length === 0) return null;
  const said = words(spoken);
  if (said.length === 0) return null;
  const joined = said.join(" ");

  // 1. Erst die Verneinung: ein „nein, nicht genehmigen" stolperte sonst über die Beschriftung
  //    „Genehmigen" und würde als Zustimmung gelesen — der teuerste denkbare Fehlgriff.
  const saidNo = said.some((word) => NO_WORDS.has(word));
  if (saidNo) {
    const found = unique(options.filter((option) => carries(option, NO_WORDS)));
    if (found !== null) return found;
  }

  // 2. Kennung wörtlich.
  const byId = unique(options.filter((option) => said.includes(normalize(option.id).trim())));
  if (byId !== null) return byId;

  // 3. Beschriftung wörtlich, als zusammenhängende Wortfolge.
  const byLabel = unique(
    options.filter((option) => {
      const label = words(option.label).join(" ");
      return label.length > 0 && joined.includes(label);
    }),
  );
  if (byLabel !== null) return byLabel;

  // 4. Zustimmung — nur, wenn genau eine Option so zu lesen ist.
  if (!saidNo && said.some((word) => YES_WORDS.has(word))) {
    const found = unique(options.filter((option) => carries(option, YES_WORDS)));
    if (found !== null) return found;
  }

  // 5. Ordnungszahl.
  for (const word of said) {
    const index = ORDINALS[word];
    if (index !== undefined && index >= 1 && index <= options.length) {
      return options[index - 1].id;
    }
  }

  return null;
}
