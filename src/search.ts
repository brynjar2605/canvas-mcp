// Pure ranking logic behind the `search_materials` tool. No I/O here so it's
// trivially unit-testable — see tests/search.test.ts.

export type CandidateKind = "file" | "module_item" | "page";

/** Minimal shape the ranker needs. `search_materials.ts` extends this with
 * richer per-kind payloads and passes the extended objects straight through —
 * TypeScript's structural typing lets `rankMaterials` stay generic over `T`. */
export interface Candidate {
  kind: CandidateKind;
  /** The text matched against the query (file name / module item title / page title). */
  title: string;
  /** ISO date string, used only as a tie-breaker (newer first). */
  updatedAt?: string | null;
}

export interface Scored<T extends Candidate = Candidate> {
  candidate: T;
  score: number;
}

const KIND_ORDER: Record<CandidateKind, number> = {
  file: 0,
  module_item: 1,
  page: 2,
};

/** Keyword tokens (already normalised) that, when present on both sides, get a small relevance bonus. */
const BONUS_KEYWORDS = new Set([
  "week",
  "vika",
  "lecture",
  "fyrirlestur",
  "lab",
  "glosur",
  "slides",
]);

/**
 * Normalises text for matching: lowercase, strip diacritics (NFD + remove
 * combining marks), then map the Icelandic letters that don't decompose under
 * NFD (þ, ð, æ, ö) to their ASCII transliteration. This lets a query typed
 * without Icelandic keyboard support ("thydendur", "glosur") match titles
 * that use the real letters ("Þýðendur", "Glósur"), and vice versa.
 */
export function normalize(s: string): string {
  const lower = s.toLowerCase();
  const stripped = lower.normalize("NFD").replace(/\p{M}/gu, "");
  return stripped
    .replace(/þ/g, "th")
    .replace(/ð/g, "d")
    .replace(/æ/g, "ae")
    .replace(/ö/g, "o");
}

/** Splits normalised text into alphanumeric tokens, separating letter/digit runs
 * (`"vika3"` -> `["vika", "3"]`) so numbers can be compared exactly. */
export function tokenize(normalized: string): string[] {
  const spaced = normalized
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2");
  return spaced.split(/[^a-z0-9]+/u).filter(Boolean);
}

const isNumeric = (t: string): boolean => /^\d+$/.test(t);

/**
 * Scores a single title against a query. Returns 0 for "no match" (callers
 * filter these out). See PLAN.md's `search_materials` section for the rules
 * this implements:
 *  - exact normalised match: 100
 *  - all query tokens present in the title: 60
 *  - a query token is a prefix of a title token (or vice versa): 40
 *  - a query token is a substring of a title token: 10 per token
 *  - +15 bonus when a "week/lecture/lab/slides"-ish keyword appears on both sides
 *  - numeric tokens must match EXACTLY — "vika 3" must not match "vika 13".
 *    Any numeric query token with no exact match anywhere in the title's
 *    numeric tokens disqualifies the candidate (score 0), even if the rest
 *    of the query matches textually.
 */
export function scoreCandidate(query: string, title: string): number {
  const nq = normalize(query);
  const nt = normalize(title);
  if (nq.trim().length === 0) return 0;
  if (nq === nt) return 100;

  const qTokens = tokenize(nq);
  const tTokens = tokenize(nt);
  if (qTokens.length === 0) return 0;

  const tNumbers = new Set(tTokens.filter(isNumeric));
  const qNumbers = qTokens.filter(isNumeric);
  const numberMismatch = qNumbers.some((n) => !tNumbers.has(n));
  if (numberMismatch) return 0;

  const allTokensPresent = qTokens.every((qt) =>
    isNumeric(qt) ? tNumbers.has(qt) : tTokens.includes(qt),
  );

  let score: number;
  if (allTokensPresent) {
    score = 60;
  } else {
    let prefixHit = false;
    let partialSum = 0;
    for (const qt of qTokens) {
      if (isNumeric(qt)) continue; // exactness already verified above
      for (const tt of tTokens) {
        if (tt === qt) break; // exact single-token match, no extra credit here
        if (tt.startsWith(qt) || qt.startsWith(tt)) {
          prefixHit = true;
          break;
        }
        if (tt.includes(qt)) {
          partialSum += 10;
          break;
        }
      }
    }
    score = prefixHit ? 40 : partialSum;
  }

  if (score === 0) return 0;

  const bonus = qTokens.some((qt) => BONUS_KEYWORDS.has(qt) && tTokens.includes(qt)) ? 15 : 0;
  return score + bonus;
}

/**
 * Ranks candidates against a query. Zero-score candidates are dropped.
 * Ties break: higher score first, then files before module items before
 * pages, then newer `updatedAt` first.
 */
export function rankMaterials<T extends Candidate>(query: string, candidates: T[]): Scored<T>[] {
  const scored: Scored<T>[] = candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(query, candidate.title) }))
    .filter((s) => s.score > 0);

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const kindDiff = KIND_ORDER[a.candidate.kind] - KIND_ORDER[b.candidate.kind];
    if (kindDiff !== 0) return kindDiff;
    const at = a.candidate.updatedAt ? Date.parse(a.candidate.updatedAt) : 0;
    const bt = b.candidate.updatedAt ? Date.parse(b.candidate.updatedAt) : 0;
    return bt - at;
  });

  return scored;
}
