import { describe, expect, it } from "vitest";
import { decodeHtmlEntities, htmlToMarkdown, stripVerifierParams } from "../src/util/html.js";

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

describe("decodeHtmlEntities", () => {
  it("decodes &amp; (the common case: an escaped query string separator)", () => {
    expect(decodeHtmlEntities("https://x.test/files/1?verifier=abc&amp;wrap=1")).toBe(
      "https://x.test/files/1?verifier=abc&wrap=1",
    );
  });

  it("decodes lt/gt/quot/apos", () => {
    expect(decodeHtmlEntities("&lt;a&gt; &quot;b&quot; &#39;c&#39; &apos;d&apos;")).toBe(`<a> "b" 'c' 'd'`);
  });

  it("leaves plain text untouched", () => {
    expect(decodeHtmlEntities("Assignment 2")).toBe("Assignment 2");
  });
});

describe("stripVerifierParams", () => {
  it("strips a verifier param in the middle of a query string", () => {
    expect(stripVerifierParams("https://x.test/download?verifier=abc&wrap=1")).toBe(
      "https://x.test/download?wrap=1",
    );
  });

  it("strips a verifier param at the end of a query string", () => {
    expect(stripVerifierParams("https://x.test/download?wrap=1&verifier=abc")).toBe(
      "https://x.test/download?wrap=1",
    );
  });

  it("strips a verifier param that is the only query param", () => {
    expect(stripVerifierParams("https://x.test/download?verifier=abc")).toBe("https://x.test/download");
  });

  it("strips every occurrence in a longer text blob (e.g. a markdown body)", () => {
    const body = "See [a](https://x.test/1?verifier=aaa) and [b](https://x.test/2?verifier=bbb&wrap=1).";
    const stripped = stripVerifierParams(body);
    expect(stripped).not.toContain("verifier");
    expect(stripped).toContain("[a](https://x.test/1)");
    expect(stripped).toContain("[b](https://x.test/2?wrap=1)");
  });

  it("leaves text with no verifier param untouched", () => {
    expect(stripVerifierParams("https://x.test/download?wrap=1")).toBe("https://x.test/download?wrap=1");
  });
});
