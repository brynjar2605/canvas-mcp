// Pure ranking logic behind the `search_materials` tool. No I/O here so it's
// trivially unit-testable — see tests/search.test.ts.

export type CandidateKind = "file" | "module_item" | "page";

/** Minimal shape the ranker needs. `search_materials.ts` extends this with
 * richer per-kind payloads and passes the extended objects straight through —
 * TypeScript's structural typing lets `rankMaterials` stay generic over `T`.
 * `title` should include any extra context worth matching on (a file's
 * folder path, a module item's module name / preceding subheader, …) — it is
 * only ever used for scoring, never for display. */
export interface Candidate {
  kind: CandidateKind;
  /** The text matched against the query. */
  title: string;
  /** ISO date string, used only as a tie-breaker (newer first). */
  updatedAt?: string | null;
}

export interface Scored<T extends Candidate = Candidate> {
  candidate: T;
  score: number;
}

/** Tie-break ordering when candidates score equally: files, then module items, then pages.
 * Exported so callers that merge/re-sort ranked results (e.g. search_materials.ts, which
 * collapses a file/page and the module item(s) pointing at it into one line) can apply the
 * same ordering after their own merge step. */
export const KIND_ORDER: Record<CandidateKind, number> = {
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

/**
 * Tokenises RAW (mixed-case, unnormalised) text into normalised tokens,
 * splitting on camelCase boundaries, `_`/`-`, letter/digit boundaries, and
 * any other non-alphanumeric run. This is what lets:
 *  - "LexicalAnalysis" tokenise as ["lexical", "analysis"]
 *  - "Chapter_03" tokenise as ["chapter", "03"]
 *  - "Vika3-glosur.pdf" tokenise as ["vika", "3", "glosur", "pdf"]
 *
 * Pass the ORIGINAL-case string — this normalises internally, so pre-
 * lowercasing the input (e.g. via `normalize()`) would destroy the
 * camelCase boundaries it needs to see.
 */
export function tokenize(raw: string): string[] {
  const spaced = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase boundary: ...Analysis -> ... Analysis
    .replace(/[_-]+/g, " ") // underscores/hyphens are always separators
    .replace(/([A-Za-z])(\d)/g, "$1 $2") // letter->digit boundary: vika3 -> vika 3
    .replace(/(\d)([A-Za-z])/g, "$1 $2"); // digit->letter boundary: 3glosur -> 3 glosur
  const normalized = normalize(spaced);
  return normalized.split(/[^a-z0-9]+/u).filter(Boolean);
}

const isNumeric = (t: string): boolean => /^\d+$/.test(t);
/** Numeric tokens compare by value, not by string, so "3" and "03" are the same token. */
const numericValue = (t: string): number => Number(t);

const EXACT_TOKEN_SCORE = 30;
const NUMERIC_EXACT_SCORE = 30;
const PREFIX_TOKEN_SCORE = 20;
const COMMON_PREFIX_SCORE = 12;
const SUBSTRING_TOKEN_SCORE = 8;
const ALL_TOKENS_BONUS = 20;
const KEYWORD_BONUS = 15;
/** Minimum shared-prefix length to count as a "lexing"~"lexical"-style partial match. */
const COMMON_PREFIX_MIN_LEN = 4;

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * Best score a single query token can get against any of the title's tokens.
 * Returns 0 if it matches nothing at all — callers treat that as "this
 * token contributed nothing" rather than disqualifying the whole candidate.
 */
function bestTokenScore(qt: string, tTokens: string[]): number {
  if (isNumeric(qt)) {
    const qn = numericValue(qt);
    return tTokens.some((tt) => isNumeric(tt) && numericValue(tt) === qn) ? NUMERIC_EXACT_SCORE : 0;
  }

  let best = 0;
  for (const tt of tTokens) {
    if (isNumeric(tt)) continue; // a text query token never matches a numeric title token
    if (tt === qt) return EXACT_TOKEN_SCORE; // can't beat an exact match
    if (tt.startsWith(qt) || qt.startsWith(tt)) {
      best = Math.max(best, PREFIX_TOKEN_SCORE);
      continue;
    }
    if (commonPrefixLength(qt, tt) >= COMMON_PREFIX_MIN_LEN) {
      best = Math.max(best, COMMON_PREFIX_SCORE);
      continue;
    }
    if (tt.includes(qt) || qt.includes(tt)) {
      best = Math.max(best, SUBSTRING_TOKEN_SCORE);
    }
  }
  return best;
}

/**
 * Scores a single title against a query. Returns 0 only when NO query token
 * matched anything in the title — every other case is ranked, never dropped,
 * so a partially-matching query still surfaces its best candidates instead
 * of answering "no results". Rules:
 *  - exact normalised match (whole string): 100
 *  - otherwise, each query token independently earns the best of:
 *      exact token match: 30 (numeric tokens compare by value: "3" == "03")
 *      prefix relation ("lex" / "lexing"): 20
 *      shared prefix >= 4 chars ("lexing" ~ "lexical"): 12
 *      substring either way: 8
 *      no match anywhere: 0 (contributes nothing, does not zero the total)
 *  - +20 when every query token matched something (not just some)
 *  - +15 when a "week/lecture/lab/slides"-ish keyword appears on both sides
 *  - a numeric query token ("3") only credits candidates with a numeric
 *    token of the same value ("03", not "13") — this is what keeps
 *    "vika 3" ranked above "vika 13" without hiding "vika 13" entirely.
 */
export function scoreCandidate(query: string, title: string): number {
  if (query.trim().length === 0) return 0;

  const nq = normalize(query);
  const nt = normalize(title);
  if (nq === nt) return 100;

  const qTokens = tokenize(query);
  const tTokens = tokenize(title);
  if (qTokens.length === 0) return 0;

  let rawScore = 0;
  let allMatched = true;
  for (const qt of qTokens) {
    const s = bestTokenScore(qt, tTokens);
    if (s === 0) allMatched = false;
    rawScore += s;
  }

  if (rawScore === 0) return 0;

  let score = rawScore;
  if (allMatched) score += ALL_TOKENS_BONUS;
  if (qTokens.some((qt) => BONUS_KEYWORDS.has(qt) && tTokens.includes(qt))) {
    score += KEYWORD_BONUS;
  }
  return score;
}

/**
 * Ranks candidates against a query. Zero-score candidates (no token matched
 * anything) are dropped; everything else is kept and ranked, including
 * partial matches. Ties break: higher score first, then files before module
 * items before pages, then newer `updatedAt` first.
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
