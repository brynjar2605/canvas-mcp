import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guards the public repo against accidentally committing secrets or personal data.
// Scans every file git tracks (plus untracked, non-ignored files, i.e. anything that
// would land in the next `git add -A`). No network; deterministic.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Built from parts so this file never contains the literal strings it hunts for.
const HOME_PATH = "/Users/" + "brynjar" + "mar";
const EMAIL_PREFIX = "brynjar" + "ms@";

const TOKEN_RE = /\b\d{4,5}~[A-Za-z0-9]{40,}\b/;
const TOKEN_LINE_RE = /^CANVAS_TOKEN=(.*)$/gm;
const ALLOWED_TOKEN_VALUES = new Set(["", "paste-your-token-here"]);
const PLACEHOLDER_RE = /^\$\{[^}]*\}$/;

const SKIP_BASENAMES = new Set(["package-lock.json"]);
const WALK_EXCLUDES = new Set(["node_modules", "dist", ".git"]);
const MUST_NOT_BE_TRACKED = [".env", "config/courses.json", ".claude/settings.local.json"];

export function findViolations(content: string): string[] {
  const problems: string[] = [];
  if (TOKEN_RE.test(content)) problems.push("Canvas-style access token");
  for (const m of content.matchAll(TOKEN_LINE_RE)) {
    let value = (m[1] ?? "").trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    if (!ALLOWED_TOKEN_VALUES.has(value) && !PLACEHOLDER_RE.test(value)) {
      problems.push("CANVAS_TOKEN= line with a non-placeholder value");
    }
  }
  if (content.includes(HOME_PATH)) problems.push("absolute path under the user's home directory");
  if (content.includes(EMAIL_PREFIX)) problems.push("the user's email address");
  return problems;
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: REPO_ROOT, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function gitList(args: string[]): string[] {
  const out = execFileSync("git", ["ls-files", "-z", ...args], { cwd: REPO_ROOT, stdio: "pipe" }).toString("utf8");
  return out.split("\0").filter(Boolean);
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (WALK_EXCLUDES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile()) acc.push(relative(REPO_ROOT, full).split(sep).join("/"));
  }
  return acc;
}

const HAS_GIT = gitAvailable();

function candidateFiles(): string[] {
  const files = HAS_GIT ? gitList(["--cached", "--others", "--exclude-standard"]) : walk(REPO_ROOT);
  return [...new Set(files)].sort();
}

describe("findViolations (scanner self-test)", () => {
  it("flags each forbidden pattern", () => {
    const fakeToken = "1234" + "~" + "A".repeat(48);
    expect(findViolations(`token: ${fakeToken}`)).toContain("Canvas-style access token");
    expect(findViolations("CANVAS_" + "TOKEN=abc123")).toContain("CANVAS_TOKEN= line with a non-placeholder value");
    expect(findViolations(`cd ${HOME_PATH}/Documents`)).toContain("absolute path under the user's home directory");
    expect(findViolations(`mail ${EMAIL_PREFIX}example.com`)).toContain("the user's email address");
  });

  it("accepts the documented placeholders", () => {
    const key = "CANVAS_" + "TOKEN=";
    expect(findViolations(`${key}paste-your-token-here`)).toEqual([]);
    expect(findViolations(`${key}`)).toEqual([]);
    expect(findViolations(`${key}\${CANVAS_TOKEN}`)).toEqual([]);
    expect(findViolations(`${key}"paste-your-token-here"`)).toEqual([]);
    expect(findViolations('process.env.CANVAS_TOKEN = "test-token";')).toEqual([]);
  });
});

describe("repository contains no secrets or personal data", () => {
  it("no tracked (or about-to-be-tracked) text file matches a forbidden pattern", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const rel of candidateFiles()) {
      if (SKIP_BASENAMES.has(rel.split("/").pop() ?? "")) continue;
      const full = join(REPO_ROOT, rel);
      if (!existsSync(full) || !statSync(full).isFile()) continue; // deleted in the working tree
      const buf = readFileSync(full);
      if (isBinary(buf)) continue;
      scanned++;
      for (const problem of findViolations(buf.toString("utf8"))) offenders.push(`${rel}: ${problem}`);
    }
    expect(scanned).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it.skipIf(!HAS_GIT)("local config and secrets files are not tracked by git", () => {
    const tracked = new Set(gitList(["--cached"]));
    for (const path of MUST_NOT_BE_TRACKED) expect(tracked.has(path), `${path} must not be tracked`).toBe(false);
  });
});
