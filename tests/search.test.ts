import { describe, expect, it } from "vitest";
import { normalize, rankMaterials, scoreCandidate, tokenize, type Candidate } from "../src/search.js";

describe("normalize", () => {
  it("strips accents via NFD", () => {
    expect(normalize("Fyrirlestur")).toBe("fyrirlestur");
    expect(normalize("Glósur")).toBe("glosur");
    expect(normalize("Stýrikerfi")).toBe("styrikerfi");
  });
  it("transliterates letters that don't decompose under NFD", () => {
    expect(normalize("Þýðendur")).toBe("thydendur");
    expect(normalize("Æfing")).toBe("aefing");
    expect(normalize("Vika")).toBe("vika");
  });
});

describe("tokenize", () => {
  it("splits on non-alphanumerics (call with raw, unnormalised text)", () => {
    expect(tokenize("Fyrirlestur 3 - Lexing.pdf")).toEqual(["fyrirlestur", "3", "lexing", "pdf"]);
  });
  it("separates letter/digit runs so numbers tokenize independently", () => {
    expect(tokenize("Vika3-glosur.pdf")).toEqual(["vika", "3", "glosur", "pdf"]);
    expect(tokenize("Vika13.pdf")).toEqual(["vika", "13", "pdf"]);
  });
  it("splits camelCase boundaries", () => {
    expect(tokenize("T-603-THYD-LexicalAnalysis.pdf")).toEqual([
      "t",
      "603",
      "thyd",
      "lexical",
      "analysis",
      "pdf",
    ]);
    expect(tokenize("GrobbitLangRef_v16.pdf")).toEqual(["grobbit", "lang", "ref", "v", "16", "pdf"]);
  });
  it("splits on underscores, treating Chapter_03 as two tokens", () => {
    expect(tokenize("YB_Chapter_03_LexicalAnalysis.pdf")).toEqual([
      "yb",
      "chapter",
      "03",
      "lexical",
      "analysis",
      "pdf",
    ]);
  });
});

describe("scoreCandidate", () => {
  it("scores an exact normalised match at 100", () => {
    expect(scoreCandidate("fyrirlestur 3", "Fyrirlestur 3")).toBe(100);
    expect(scoreCandidate("THYDENDUR", "þýðendur")).toBe(100);
  });

  it("scores all-tokens-present with keyword bonus", () => {
    // "fyrirlestur" is a bonus keyword and present on both sides.
    expect(scoreCandidate("fyrirlestur 3", "Fyrirlestur 3 - Lexing.pdf")).toBe(95);
  });

  it("numeric tokens compare by value: '3' and '03' are the same token", () => {
    expect(scoreCandidate("week 3", "03 - Lexical Analysis.pdf")).toBeGreaterThan(0);
    expect(scoreCandidate("chapter 3", "Chapter 03.pdf")).toBeGreaterThan(0);
  });

  it("a numeric mismatch no longer zeroes the whole candidate, but still ranks below an exact match", () => {
    const looseMatch = scoreCandidate("vika 3", "Vika 13 - upptaka");
    const exactMatch = scoreCandidate("vika 3", "Vika 3 - upptaka");
    expect(looseMatch).toBeGreaterThan(0);
    expect(exactMatch).toBeGreaterThan(looseMatch);
  });

  it("gives partial credit for a prefix match", () => {
    // "lex" is a prefix of "lexing", no exact/all-tokens match.
    expect(scoreCandidate("lex", "Lexing.pdf")).toBe(40);
  });

  it("gives smaller partial credit for a substring match", () => {
    // "ing" is a substring of "lexing" but not a prefix of it (nor vice versa).
    expect(scoreCandidate("ing", "Lexing.pdf")).toBeGreaterThan(0);
    expect(scoreCandidate("ing", "Lexing.pdf")).toBeLessThan(scoreCandidate("lex", "Lexing.pdf"));
  });

  it("gives common-prefix partial credit for near-misses like lexing~lexical", () => {
    expect(scoreCandidate("lexing", "Lexical Analysis.pdf")).toBeGreaterThan(0);
  });

  it("returns 0 for unrelated text", () => {
    expect(scoreCandidate("gervigreind", "Lexing.pdf")).toBe(0);
  });

  it("returns 0 for an empty query", () => {
    expect(scoreCandidate("", "Lexing.pdf")).toBe(0);
  });

  it("does not drop a partially-matching multi-word query to 0", () => {
    // Old bug: any one unmatched token zeroed the whole candidate.
    expect(scoreCandidate("assignment 2 solution", "Assignment 2")).toBeGreaterThan(0);
  });
});

describe("required live-review search scenarios", () => {
  it('"lexing slides" ranks the LexicalAnalysis.pdf in the Slides folder first', () => {
    const results = rankMaterials("lexing slides", [
      { kind: "file", title: "T-603-THYD-LexicalAnalysis.pdf Slides" },
      { kind: "module_item", title: "Chapter 3: Lexical Analysis" },
      { kind: "file", title: "GrobbitLangRef_v16.pdf" },
    ]);
    expect(results[0]!.candidate.title).toBe("T-603-THYD-LexicalAnalysis.pdf Slides");
  });

  it('"chapter 3" hits both YB_Chapter_03_LexicalAnalysis.pdf and the "Chapter 3" module item, ranking "Chapter 13" below them', () => {
    const results = rankMaterials("chapter 3", [
      { kind: "file", title: "YB_Chapter_03_LexicalAnalysis.pdf" },
      { kind: "module_item", title: "Chapter 3: Lexical Analysis" },
      { kind: "file", title: "Chapter 13.pdf" },
    ]);
    const titles = results.map((r) => r.candidate.title);
    expect(titles).toContain("YB_Chapter_03_LexicalAnalysis.pdf");
    expect(titles).toContain("Chapter 3: Lexical Analysis");
    const chapter13Score = results.find((r) => r.candidate.title === "Chapter 13.pdf")?.score ?? 0;
    const chapter03Score = results.find((r) => r.candidate.title === "YB_Chapter_03_LexicalAnalysis.pdf")!.score;
    const chapterItemScore = results.find((r) => r.candidate.title === "Chapter 3: Lexical Analysis")!.score;
    expect(chapter13Score).toBeLessThan(chapter03Score);
    expect(chapter13Score).toBeLessThan(chapterItemScore);
  });

  it('"week 3" matches "03 - Lexical Analysis.pdf"', () => {
    const results = rankMaterials("week 3", [{ kind: "file", title: "03 - Lexical Analysis.pdf" }]);
    expect(results).toHaveLength(1);
  });

  it('"assignment 2 solution" matches "Assignment 2"', () => {
    const results = rankMaterials("assignment 2 solution", [{ kind: "file", title: "Assignment 2" }]);
    expect(results).toHaveLength(1);
  });

  it('"vika 3" does not rank "vika 13" above "vika 3"', () => {
    const results = rankMaterials("vika 3", [
      { kind: "file", title: "Vika 13 - upptaka" },
      { kind: "file", title: "Vika 3 - upptaka" },
    ]);
    expect(results[0]!.candidate.title).toBe("Vika 3 - upptaka");
  });

  it('"grobbit" finds "GrobbitLangRef_v16.pdf"', () => {
    const results = rankMaterials("grobbit", [{ kind: "file", title: "GrobbitLangRef_v16.pdf" }]);
    expect(results).toHaveLength(1);
  });
});

describe("rankMaterials", () => {
  function candidate(kind: Candidate["kind"], title: string, updatedAt: string | null = null): Candidate {
    return { kind, title, updatedAt };
  }

  it("drops candidates with no token match at all, but keeps and ranks partial matches", () => {
    const results = rankMaterials("fyrirlestur 3", [
      candidate("file", "Fyrirlestur 3 - Lexing.pdf"),
      candidate("file", "Fyrirlestur 13 - Parsing.pdf"),
      candidate("page", "Syllabus"),
    ]);
    // "Syllabus" matches nothing and is dropped; "Fyrirlestur 13" matches the
    // text token but not the number, so it's kept (not disqualified) but
    // ranked below the exact match.
    expect(results.map((r) => r.candidate.title)).toEqual([
      "Fyrirlestur 3 - Lexing.pdf",
      "Fyrirlestur 13 - Parsing.pdf",
    ]);
  });

  it("tie-breaks equal scores: files before module items before pages", () => {
    const results = rankMaterials("glosur", [
      candidate("page", "Glósur"),
      candidate("module_item", "Glósur"),
      candidate("file", "Glósur"),
    ]);
    expect(results.map((r) => r.candidate.kind)).toEqual(["file", "module_item", "page"]);
  });

  it("tie-breaks equal scores and kind by newer updatedAt first", () => {
    const results = rankMaterials("glosur", [
      candidate("file", "Glósur", "2026-01-01T00:00:00Z"),
      candidate("file", "Glósur", "2026-03-01T00:00:00Z"),
    ]);
    expect(results.map((r) => r.candidate.updatedAt)).toEqual([
      "2026-03-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    ]);
  });

  it("carries extra fields through generically", () => {
    interface FileCandidate extends Candidate {
      fileId: number;
    }
    const results = rankMaterials<FileCandidate>("lexing", [
      { kind: "file", title: "Lexing.pdf", fileId: 42 },
    ]);
    expect(results[0]!.candidate.fileId).toBe(42);
  });
});
