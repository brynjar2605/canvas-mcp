import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../src/util/html.js";

describe("htmlToMarkdown", () => {
  it("returns '' for null / undefined / empty / whitespace-only input", () => {
    expect(htmlToMarkdown(null)).toBe("");
    expect(htmlToMarkdown(undefined)).toBe("");
    expect(htmlToMarkdown("")).toBe("");
    expect(htmlToMarkdown("   \n  ")).toBe("");
  });

  it("strips <script> and <style> content entirely", () => {
    const md = htmlToMarkdown("<p>Hello</p><script>alert('x')</script><style>.a{color:red}</style>");
    expect(md).toContain("Hello");
    expect(md).not.toContain("alert");
    expect(md).not.toContain("color:red");
  });

  it("keeps links, headings, and lists", () => {
    const md = htmlToMarkdown(
      '<h2>Section</h2><p>See <a href="https://x.test/a">here</a></p><ul><li>one</li><li>two</li></ul>',
    );
    expect(md).toContain("## Section");
    expect(md).toContain("[here](https://x.test/a)");
    expect(md).toMatch(/-\s+one/);
    expect(md).toMatch(/-\s+two/);
  });

  it("renders tables reasonably as GFM-style markdown", () => {
    const md = htmlToMarkdown("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>");
    expect(md).toContain("| A | B |");
    expect(md).toContain("| --- | --- |");
    expect(md).toContain("| 1 | 2 |");
  });

  it("strips tracking-pixel images but keeps real images", () => {
    const md = htmlToMarkdown(
      '<img src="https://x.test/pixel.gif" width="1" height="1"><img src="https://x.test/real.png" width="300">',
    );
    expect(md).not.toContain("pixel.gif");
    expect(md).toContain("real.png");
  });
});
