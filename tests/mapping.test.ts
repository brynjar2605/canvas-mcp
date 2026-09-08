import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CourseInfo } from "../src/canvas/courses.js";
import { applyMapping, proposeMapping } from "../src/sync/mapping.js";
import type { CourseMapping } from "../src/config.js";

// Onn-5 scenario from PLAN.md "Live findings".
const SEM5_COURSES: CourseInfo[] = [
  { id: 10488, code: "T-503-POSH", slug: "posh", name: "Persónuvernd og öryggi", term: "Haustönn 2026", semester: 5 },
  { id: 10483, code: "T-409-TSAM", slug: "tsam", name: "Tölvusamskipti", term: "Haustönn 2026", semester: 5 },
  { id: 10492, code: "T-514-VEFT", slug: "veft", name: "Vefþjónustur", term: "Haustönn 2026", semester: 5 },
  { id: 10487, code: "T-488-MAPP", slug: "mapp", name: "Máltækni og forritun", term: "Haustönn 2026", semester: 5 },
  { id: 10495, code: "T-603-THYD", slug: "thyd", name: "Þýðendur", term: "Haustönn 2026", semester: 5 },
];

const EXISTING_FOLDERS = ["POSH", "compilers", "tsam", "veft"];

describe("proposeMapping", () => {
  it("matches the onn-5 fixture with no overrides", () => {
    const proposal = proposeMapping(SEM5_COURSES, 5, EXISTING_FOLDERS);

    const bySlug = new Map(proposal.entries.map((e) => [e.slug, e]));
    expect(bySlug.get("posh")).toMatchObject({ existingFolder: "POSH", action: "rename" });
    expect(bySlug.get("tsam")).toMatchObject({ existingFolder: "tsam", action: "keep" });
    expect(bySlug.get("veft")).toMatchObject({ existingFolder: "veft", action: "keep" });
    expect(bySlug.get("mapp")).toMatchObject({ existingFolder: null, action: "create" });
    expect(bySlug.get("thyd")).toMatchObject({ existingFolder: null, action: "create" });

    expect(proposal.unmatchedFolders).toEqual(["compilers"]);
    expect(proposal.semesterDir).toBe("onn 5");
  });

  it("resolves compilers -> thyd via an explicit override", () => {
    const proposal = proposeMapping(SEM5_COURSES, 5, EXISTING_FOLDERS, { compilers: "thyd" });

    const bySlug = new Map(proposal.entries.map((e) => [e.slug, e]));
    expect(bySlug.get("thyd")).toMatchObject({ existingFolder: "compilers", action: "rename" });
    expect(proposal.unmatchedFolders).toEqual([]);
  });

  it("only proposes courses for the requested semester", () => {
    const withOtherSemester: CourseInfo[] = [
      ...SEM5_COURSES,
      { id: 1, code: "T-100-OLD", slug: "old", name: "Old Course", term: "Vorönn 2025", semester: 2 },
    ];
    const proposal = proposeMapping(withOtherSemester, 5, EXISTING_FOLDERS);
    expect(proposal.entries.map((e) => e.slug)).not.toContain("old");
  });
});

describe("applyMapping", () => {
  let schoolRoot: string;
  let mappingPath: string;

  beforeEach(() => {
    schoolRoot = mkdtempSync(join(tmpdir(), "canvas-mcp-mapping-"));
    mkdirSync(join(schoolRoot, "onn 5", "POSH"), { recursive: true });
    writeFileSync(join(schoolRoot, "onn 5", "POSH", "marker.txt"), "posh-marker");
    mkdirSync(join(schoolRoot, "onn 5", "compilers"), { recursive: true });
    mkdirSync(join(schoolRoot, "onn 5", "tsam"), { recursive: true });
    mkdirSync(join(schoolRoot, "onn 5", "veft"), { recursive: true });
    mappingPath = join(schoolRoot, "courses.json");
  });

  afterEach(() => {
    rmSync(schoolRoot, { recursive: true, force: true });
  });

  it("renames case-only folders, creates missing ones, and writes courses.json", async () => {
    const proposal = proposeMapping(SEM5_COURSES, 5, EXISTING_FOLDERS, { compilers: "thyd" });
    const log = await applyMapping(proposal, { schoolRoot, mappingPath });

    const entries = readdirSync(join(schoolRoot, "onn 5"));
    expect(entries).toContain("posh");
    expect(entries).not.toContain("POSH");
    expect(entries).toContain("thyd");
    expect(entries).not.toContain("compilers");
    expect(entries).toContain("mapp");
    expect(entries).toContain("tsam");
    expect(entries).toContain("veft");

    // renamed folder keeps its contents — never deletes.
    expect(readFileSync(join(schoolRoot, "onn 5", "posh", "marker.txt"), "utf-8")).toBe("posh-marker");

    const mapping = JSON.parse(readFileSync(mappingPath, "utf-8")) as CourseMapping;
    expect(mapping["10488"]).toEqual({ code: "T-503-POSH", slug: "posh", semester: 5 });
    expect(mapping["10495"]).toEqual({ code: "T-603-THYD", slug: "thyd", semester: 5, folder: "compilers" });

    expect(log.some((l) => l.includes("renamed"))).toBe(true);
    expect(log.some((l) => l.includes("created"))).toBe(true);
  });

  it("refuses when a rename target already exists as an unrelated directory", async () => {
    // Force "compilers" -> "thyd" via override, but "thyd" already exists as
    // its own unrelated directory (not just a case variant of "compilers").
    mkdirSync(join(schoolRoot, "onn 5", "thyd"));
    writeFileSync(join(schoolRoot, "onn 5", "thyd", "unrelated.txt"), "not-the-thyd-course");

    const proposal = proposeMapping(SEM5_COURSES, 5, EXISTING_FOLDERS, { compilers: "thyd" });

    await expect(applyMapping(proposal, { schoolRoot, mappingPath })).rejects.toThrow(/already exists/);

    // Nothing should have been deleted or overwritten.
    expect(existsSync(join(schoolRoot, "onn 5", "compilers"))).toBe(true);
    expect(readFileSync(join(schoolRoot, "onn 5", "thyd", "unrelated.txt"), "utf-8")).toBe("not-the-thyd-course");
  });

  it("never deletes an unmatched folder", async () => {
    const proposal = proposeMapping(SEM5_COURSES, 5, EXISTING_FOLDERS);
    await applyMapping(proposal, { schoolRoot, mappingPath });
    expect(existsSync(join(schoolRoot, "onn 5", "compilers"))).toBe(true);
  });

  it("records folder for a real rename, not for a case-only rename or a keep/create", async () => {
    const proposal = proposeMapping(SEM5_COURSES, 5, EXISTING_FOLDERS, { compilers: "thyd" });
    await applyMapping(proposal, { schoolRoot, mappingPath });

    const mapping = JSON.parse(readFileSync(mappingPath, "utf-8")) as CourseMapping;
    expect(mapping["10495"]).toMatchObject({ slug: "thyd", folder: "compilers" }); // real rename
    expect(mapping["10488"]).not.toHaveProperty("folder"); // posh: case-only rename (POSH -> posh)
    expect(mapping["10483"]).not.toHaveProperty("folder"); // tsam: kept
    expect(mapping["10492"]).not.toHaveProperty("folder"); // veft: kept
    expect(mapping["10487"]).not.toHaveProperty("folder"); // mapp: created
  });

  it("preserves a recorded folder across a later apply where the entry is kept", async () => {
    const firstProposal = proposeMapping(SEM5_COURSES, 5, EXISTING_FOLDERS, { compilers: "thyd" });
    await applyMapping(firstProposal, { schoolRoot, mappingPath });

    // Re-propose against the post-apply folder layout — every course's
    // folder now already matches its slug, so every entry is "keep".
    const onDiskFolders = readdirSync(join(schoolRoot, "onn 5"));
    const secondProposal = proposeMapping(SEM5_COURSES, 5, onDiskFolders);
    expect(secondProposal.entries.every((e) => e.action === "keep")).toBe(true);

    await applyMapping(secondProposal, { schoolRoot, mappingPath });

    const mapping = JSON.parse(readFileSync(mappingPath, "utf-8")) as CourseMapping;
    expect(mapping["10495"]).toMatchObject({ slug: "thyd", folder: "compilers" });
  });
});
