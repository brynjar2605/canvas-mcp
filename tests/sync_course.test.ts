import { describe, expect, it } from "vitest";
import { formatSyncReport } from "../src/tools/sync_course.js";
import type { SyncReport } from "../src/sync/engine.js";

function baseReport(overrides: Partial<SyncReport> = {}): SyncReport {
  return {
    slug: "thyd",
    added: [],
    updated: [],
    skipped: 0,
    failed: [],
    removedOnCanvas: [],
    warnings: [],
    dryRun: false,
    ...overrides,
  };
}

describe("formatSyncReport", () => {
  it("prints an info line when files were discovered via modules/pages (hidden Files tab)", () => {
    const report = baseReport({
      added: ["files/a.pdf", "files/b.pdf"],
      source: "discovered",
      discoveredSkipped: 3,
    });
    const text = formatSyncReport(report);
    expect(text).toMatch(/Files tab is hidden for this course/);
    expect(text).toMatch(/synced 2 file\(s\) discovered via modules\/pages/);
    expect(text).toMatch(/3 discovered link\(s\) skipped as inaccessible/);
  });

  it("says nothing extra when the Files tab listed normally", () => {
    const report = baseReport({ added: ["files/a.pdf"], source: "listing" });
    const text = formatSyncReport(report);
    expect(text).not.toMatch(/Files tab is hidden/);
  });

  it("prints the absolute canvas dir once at the top when set", () => {
    const report = baseReport({ dir: "/Users/test/Documents/School/onn 5/thyd/canvas" });
    const text = formatSyncReport(report);
    expect(text.split("\n")[0]).toBe("→ /Users/test/Documents/School/onn 5/thyd/canvas");
  });

  it("omits the dir line when dir is not set", () => {
    const report = baseReport();
    const text = formatSyncReport(report);
    expect(text).not.toMatch(/^→/m);
  });

  it("caps +/~ lines at 40 with a '… and N more' line, but leaves failures and warnings uncapped", () => {
    const added = Array.from({ length: 50 }, (_, i) => `files/f${i}.pdf`);
    const failed = Array.from({ length: 5 }, (_, i) => ({ path: `files/bad${i}.pdf`, error: "boom" }));
    const warnings = Array.from({ length: 3 }, (_, i) => `⚠ kept your edited copy: files/w${i}.pdf`);
    const report = baseReport({ added, failed, warnings });
    const text = formatSyncReport(report);

    const plusLines = text.split("\n").filter((l) => l.startsWith("  + "));
    expect(plusLines.length).toBe(40);
    expect(text).toMatch(/… and 10 more/);

    for (const f of failed) expect(text).toContain(f.path);
    for (const w of warnings) expect(text).toContain(w);
  });
});
