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
  it("splits on non-alphanumerics", () => {
    expect(tokenize(normalize("Fyrirlestur 3 - Lexing.pdf"))).toEqual([
      "fyrirlestur",
      "3",
      "lexing",
      "pdf",
    ]);
  });
  it("separates letter/digit runs so numbers tokenize independently", () => {
    expect(tokenize(normalize("Vika3-glosur.pdf"))).toEqual(["vika", "3", "glosur", "pdf"]);
    expect(tokenize(normalize("Vika13.pdf"))).toEqual(["vika", "13", "pdf"]);
  });
});

describe("scoreCandidate", () => {
  it("scores an exact normalised match at 100", () => {
    expect(scoreCandidate("fyrirlestur 3", "Fyrirlestur 3")).toBe(100);
    expect(scoreCandidate("THYDENDUR", "þýðendur")).toBe(100);
  });

  it("scores all-tokens-present with keyword bonus", () => {
    // "fyrirlestur" is a bonus keyword and present on both sides.
    expect(scoreCandidate("fyrirlestur 3", "Fyrirlestur 3 - Lexing.pdf")).toBe(75);
  });

  it("does not let 'vika 3' match 'vika 13' — numeric tokens must match exactly", () => {
    expect(scoreCandidate("vika 3", "Vika 13 - upptaka")).toBe(0);
    expect(scoreCandidate("vika 3", "Vika 3 - upptaka")).toBeGreaterThan(0);
  });

  it("gives partial credit for a prefix match", () => {
    // "lex" is a prefix of "lexing", no exact/all-tokens match.
    expect(scoreCandidate("lex", "Lexing.pdf")).toBe(40);
  });

  it("gives smaller partial credit for a substring match", () => {
    // "ing" is a substring of "lexing" but not a prefix of it (nor vice versa).
    expect(scoreCandidate("ing", "Lexing.pdf")).toBe(10);
  });

  it("returns 0 for unrelated text", () => {
    expect(scoreCandidate("gervigreind", "Lexing.pdf")).toBe(0);
  });

  it("returns 0 for an empty query", () => {
    expect(scoreCandidate("", "Lexing.pdf")).toBe(0);
  });
});

describe("rankMaterials", () => {
  function candidate(kind: Candidate["kind"], title: string, updatedAt: string | null = null): Candidate {
    return { kind, title, updatedAt };
  }

  it("drops zero-score candidates and sorts by score descending", () => {
    const results = rankMaterials("fyrirlestur 3", [
      candidate("file", "Fyrirlestur 3 - Lexing.pdf"),
      candidate("file", "Fyrirlestur 13 - Parsing.pdf"),
      candidate("page", "Syllabus"),
    ]);
    expect(results.map((r) => r.candidate.title)).toEqual(["Fyrirlestur 3 - Lexing.pdf"]);
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
