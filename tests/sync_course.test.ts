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
});
