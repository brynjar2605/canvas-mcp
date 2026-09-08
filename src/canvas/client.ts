import { createWriteStream } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Config } from "../config.js";
import { getConfig } from "../config.js";
import { ensureInside } from "../util/fs.js";

/**
 * Strips the `verifier` query param (a bearer-equivalent credential for
 * Canvas's pre-signed file URLs) from a URL before it can end up in an error
 * message that gets logged, stored in a sync report, or shown to the user.
 * Falls back to a regex strip if the string isn't a parseable URL.
 */
export function redactUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.searchParams.delete("verifier");
    return u.toString();
  } catch {
    return rawUrl.replace(/([?&])verifier=[^&]*&?/gi, "$1").replace(/[?&]$/, "");
  }
}

export type FetchImpl = typeof fetch;
export type SleepFn = (ms: number) => Promise<void>;

export type ParamValue = string | number | boolean | undefined;
export type Params = Record<string, ParamValue | ParamValue[]>;

const RATE_LIMIT_THRESHOLD = 50;
const RATE_LIMIT_SLEEP_MS = 1000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

/** Thrown when Canvas responds 401 — the token is missing/invalid/expired. */
export class CanvasAuthError extends Error {
  constructor(message = "Canvas rejected the request as unauthorized. Check that CANVAS_TOKEN is set and valid.") {
    super(message);
    this.name = "CanvasAuthError";
  }
}

/** Thrown for non-auth, non-retryable HTTP errors from Canvas. */
export class CanvasApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CanvasApiError";
    this.status = status;
  }
}

function debugLog(...args: unknown[]): void {
  if (process.env.CANVAS_DEBUG === "1") {
    // stdout is the MCP transport — debug output must go to stderr only.
    console.error("[canvas-mcp]", ...args);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parses an RFC 5988 Link header into a map of rel -> url. */
export function parseLinkHeader(header: string | null): Record<string, string> {
  const links: Record<string, string> = {};
  if (!header) return links;
  for (const part of header.split(",")) {
    const match = part.trim().match(/^<([^>]+)>\s*;\s*rel="([^"]+)"$/);
    if (match) {
      links[match[2]] = match[1];
    }
  }
  return links;
}

function buildUrl(baseUrl: string, path: string, params?: Params): URL {
  const url = new URL(path, baseUrl);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) {
          if (v === undefined) continue;
          url.searchParams.append(`${key}[]`, String(v));
        }
      } else {
        url.searchParams.append(key, String(value));
      }
    }
  }
  return url;
}

interface CacheEntry {
  data: unknown;
  expiresAt: number;
}

export interface CanvasClientOptions {
  fetchImpl?: FetchImpl;
  sleep?: SleepFn;
}

export class CanvasClient {
  private readonly config: Config;
  private readonly fetchImpl: FetchImpl;
  private readonly sleep: SleepFn;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(config: Config, options: CanvasClientOptions = {}) {
    this.config = config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Performs a single authenticated request with retry + rate-limit handling, returns parsed JSON + headers. */
  private async requestJson<T>(url: URL): Promise<{ data: T; headers: Headers }> {
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        debugLog(`retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS}) after ${delay}ms`, url.pathname);
        await this.sleep(delay);
      }

      debugLog("GET", url.pathname + url.search);
      const response = await this.fetchImpl(url.toString(), {
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          Accept: "application/json",
        },
      });

      await this.maybeThrottle(response.headers);

      if (response.status === 401) {
        throw new CanvasAuthError();
      }

      if (response.status === 429 || response.status >= 500) {
        lastError = new CanvasApiError(response.status, `Canvas returned ${response.status}`);
        continue;
      }

      if (response.status === 403) {
        const bodyText = await response.text();
        if (bodyText.includes("Rate Limit Exceeded")) {
          lastError = new CanvasApiError(403, "Canvas rate limit exceeded");
          continue;
        }
        throw new CanvasApiError(403, `Canvas returned 403: ${bodyText.slice(0, 500)}`);
      }

      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        throw new CanvasApiError(
          response.status,
          `Canvas request failed with status ${response.status}: ${bodyText.slice(0, 500)}`
        );
      }

      const data = (await response.json()) as T;
      return { data, headers: response.headers };
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Canvas request failed after retries");
  }

  private async maybeThrottle(headers: Headers): Promise<void> {
    const remainingHeader = headers.get("X-Rate-Limit-Remaining");
    if (remainingHeader === null) return;
    const remaining = Number.parseFloat(remainingHeader);
    if (!Number.isNaN(remaining) && remaining < RATE_LIMIT_THRESHOLD) {
      debugLog(`rate limit remaining ${remaining} < ${RATE_LIMIT_THRESHOLD}, sleeping`);
      await this.sleep(RATE_LIMIT_SLEEP_MS);
    }
  }

  /**
   * Fetches a single page from the Canvas API.
   * @param path e.g. "/api/v1/courses"
   * @param params query params; array values serialise as `key[]=a&key[]=b`
   * @param ttlMs if > 0, cache the parsed result for this many ms, keyed by full URL
   */
  async get<T>(path: string, params?: Params, ttlMs = 0): Promise<T> {
    const url = buildUrl(this.config.baseUrl, path, params);
    const cacheKey = url.toString();

    if (ttlMs > 0) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        debugLog("cache hit", url.pathname);
        return cached.data as T;
      }
    }

    const { data } = await this.requestJson<T>(url);

    if (ttlMs > 0) {
      this.cache.set(cacheKey, { data, expiresAt: Date.now() + ttlMs });
    }

    return data;
  }

  /**
   * Fetches all pages from a Canvas list endpoint, following the `Link: rel="next"`
   * header until exhausted. Forces `per_page=100`. Returns the concatenated array.
   */
  async getAll<T>(path: string, params?: Params, ttlMs = 0): Promise<T[]> {
    const initialUrl = buildUrl(this.config.baseUrl, path, { ...params, per_page: 100 });
    const cacheKey = `ALL:${initialUrl.toString()}`;

    if (ttlMs > 0) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        debugLog("cache hit (getAll)", initialUrl.pathname);
        return cached.data as T[];
      }
    }

    const results: T[] = [];
    let nextUrl: URL | null = initialUrl;
    const baseOrigin = new URL(this.config.baseUrl).origin;
    const seenUrls = new Set<string>();
    const MAX_PAGES = 500;
    let pageCount = 0;

    while (nextUrl) {
      if (pageCount++ >= MAX_PAGES) {
        debugLog("getAll: page cap reached, stopping pagination", nextUrl.toString());
        break;
      }
      const urlKey = nextUrl.toString();
      if (seenUrls.has(urlKey)) {
        debugLog("getAll: repeated next URL, stopping pagination (possible loop)", urlKey);
        break;
      }
      seenUrls.add(urlKey);

      const { data, headers } = await this.requestJson<T[]>(nextUrl);
      results.push(...data);

      const links = parseLinkHeader(headers.get("Link"));
      const next = links.next ? new URL(links.next) : null;
      // Never follow a `Link: rel="next"` to a different origin than the
      // configured Canvas instance — `requestJson` unconditionally attaches
      // the bearer token, so a foreign/compromised next-URL must not be
      // fetched at all (that would leak the token to that host).
      if (next && next.origin !== baseOrigin) {
        debugLog("getAll: ignoring cross-origin Link rel=next", next.origin);
        nextUrl = null;
      } else {
        nextUrl = next;
      }
    }

    if (ttlMs > 0) {
      this.cache.set(cacheKey, { data: results, expiresAt: Date.now() + ttlMs });
    }

    return results;
  }

  /**
   * Streams a (typically pre-signed) URL to disk atomically: writes to
   * `destPath + ".part"` then renames into place. Canvas file URLs do not
   * need the bearer token and may redirect; fetch follows redirects by default.
   * Returns the number of bytes written.
   *
   * When `root` is given, both `destPath` and its `.part` sidecar are
   * validated with {@link ensureInside} before anything is written — the
   * sidecar path is a distinct string from `destPath` (it appends to the
   * filename, not the directory) and must be checked in its own right, not
   * assumed safe just because `destPath` was already validated by the caller.
   */
  async downloadToFile(url: string, destPath: string, root?: string): Promise<number> {
    const partPath = `${destPath}.part`;
    if (root) {
      ensureInside(root, destPath);
      ensureInside(root, partPath);
    }
    await mkdir(dirname(destPath), { recursive: true });

    const response = await this.fetchImpl(url, { redirect: "follow" });
    if (!response.ok) {
      throw new CanvasApiError(response.status, `Failed to download ${redactUrl(url)}: status ${response.status}`);
    }
    if (!response.body) {
      throw new Error(`No response body when downloading ${redactUrl(url)}`);
    }

    let bytesWritten = 0;
    const countingStream = async function* (source: AsyncIterable<Uint8Array>) {
      for await (const chunk of source) {
        bytesWritten += chunk.byteLength;
        yield chunk;
      }
    };

    const nodeReadable = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>);

    try {
      await pipeline(countingStream(nodeReadable), createWriteStream(partPath));
      await rename(partPath, destPath);
    } catch (err) {
      await unlink(partPath).catch(() => undefined);
      throw err;
    }

    return bytesWritten;
  }
}

export function createClient(config: Config = getConfig(), options?: CanvasClientOptions): CanvasClient {
  return new CanvasClient(config, options);
}
