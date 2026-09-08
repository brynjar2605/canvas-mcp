import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { CanvasApiError, CanvasAuthError, CanvasClient, type FetchImpl } from "../src/canvas/client.js";

const baseConfig: Config = {
  baseUrl: "https://example.instructure.com",
  token: "test-token-do-not-leak",
  schoolRoot: "/tmp/does-not-matter",
  currentSemester: 5,
};

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("CanvasClient", () => {
  let sleep: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sleep = vi.fn().mockResolvedValue(undefined);
  });

  it("(a)/(b) getAll follows Link:rel=next pagination and forces per_page=100", async () => {
    const fetchImpl = vi
      .fn<FetchImpl>()
      .mockResolvedValueOnce(
        jsonResponse([{ id: 1 }], {
          headers: { Link: '<https://example.instructure.com/api/v1/courses?page=2>; rel="next"' },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse([{ id: 2 }], {
          headers: { Link: '<https://example.instructure.com/api/v1/courses?page=3>; rel="next"' },
        })
      )
      .mockResolvedValueOnce(jsonResponse([{ id: 3 }]));

    const client = new CanvasClient(baseConfig, { fetchImpl, sleep });
    const result = await client.getAll<{ id: number }>("/api/v1/courses", { per_page: 10 });

    expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const firstUrl = new URL((fetchImpl.mock.calls[0]?.[0] as string) ?? "");
    expect(firstUrl.searchParams.get("per_page")).toBe("100");
  });

  it("never follows a Link: rel=next to a different origin than baseUrl (token exfiltration guard)", async () => {
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValueOnce(
      jsonResponse([{ id: 1 }], {
        headers: { Link: '<https://evil.example.com/steal?x=1>; rel="next"' },
      })
    );
    const client = new CanvasClient(baseConfig, { fetchImpl, sleep });

    const result = await client.getAll<{ id: number }>("/api/v1/courses");

    expect(result).toEqual([{ id: 1 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    for (const call of fetchImpl.mock.calls) {
      const url = new URL(call[0] as string);
      expect(url.origin).not.toBe("https://evil.example.com");
    }
  });

  it("(c) array params serialise as include[]=a&include[]=b", async () => {
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new CanvasClient(baseConfig, { fetchImpl, sleep });

    await client.get("/api/v1/courses/1", { include: ["a", "b"] });

    const calledUrl = new URL((fetchImpl.mock.calls[0]?.[0] as string) ?? "");
    expect(calledUrl.searchParams.getAll("include[]")).toEqual(["a", "b"]);
  });

  it("(d) X-Rate-Limit-Remaining < 50 triggers the injected sleep", async () => {
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValueOnce(
      jsonResponse({ ok: true }, { headers: { "X-Rate-Limit-Remaining": "10" } })
    );
    const client = new CanvasClient(baseConfig, { fetchImpl, sleep });

    await client.get("/api/v1/courses");

    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("does NOT sleep when X-Rate-Limit-Remaining is comfortably high", async () => {
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValueOnce(
      jsonResponse({ ok: true }, { headers: { "X-Rate-Limit-Remaining": "700" } })
    );
    const client = new CanvasClient(baseConfig, { fetchImpl, sleep });

    await client.get("/api/v1/courses");

    expect(sleep).not.toHaveBeenCalled();
  });

  it("(e) 429 then 200 -> retried and succeeds", async () => {
    const fetchImpl = vi
      .fn<FetchImpl>()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new CanvasClient(baseConfig, { fetchImpl, sleep });

    const result = await client.get<{ ok: boolean }>("/api/v1/courses");

    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalled();
  });

  it("retries on 403 'Rate Limit Exceeded' body but not on other 403s", async () => {
    const fetchImpl = vi
      .fn<FetchImpl>()
      .mockResolvedValueOnce(new Response("Rate Limit Exceeded", { status: 403 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new CanvasClient(baseConfig, { fetchImpl, sleep });

    const result = await client.get<{ ok: boolean }>("/api/v1/courses");
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const fetchImpl2 = vi.fn<FetchImpl>().mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    const client2 = new CanvasClient(baseConfig, { fetchImpl: fetchImpl2, sleep });
    await expect(client2.get("/api/v1/courses")).rejects.toBeInstanceOf(CanvasApiError);
    expect(fetchImpl2).toHaveBeenCalledTimes(1);
  });

  it("(f) 401 throws CanvasAuthError without leaking the token", async () => {
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const client = new CanvasClient(baseConfig, { fetchImpl, sleep });

    await expect(client.get("/api/v1/courses")).rejects.toBeInstanceOf(CanvasAuthError);
    try {
      await client.get("/api/v1/courses");
    } catch (err) {
      expect(String((err as Error).message)).not.toContain(baseConfig.token);
    }
  });

  it("(g) caching: second call with ttl does not hit fetch again", async () => {
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValue(jsonResponse({ ok: true }));
    const client = new CanvasClient(baseConfig, { fetchImpl, sleep });

    const first = await client.get<{ ok: boolean }>("/api/v1/courses", undefined, 60_000);
    const second = await client.get<{ ok: boolean }>("/api/v1/courses", undefined, 60_000);

    expect(first).toEqual(second);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("getAll caches the concatenated result", async () => {
    const fetchImpl = vi.fn<FetchImpl>().mockResolvedValue(jsonResponse([{ id: 1 }]));
    const client = new CanvasClient(baseConfig, { fetchImpl, sleep });

    const first = await client.getAll<{ id: number }>("/api/v1/courses", undefined, 60_000);
    const second = await client.getAll<{ id: number }>("/api/v1/courses", undefined, 60_000);

    expect(first).toEqual(second);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  describe("downloadToFile", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "canvas-mcp-test-"));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("(h) streams the response to disk with no leftover .part file", async () => {
      const content = "hello canvas";
      const fetchImpl = vi.fn<FetchImpl>().mockResolvedValueOnce(new Response(content, { status: 200 }));
      const client = new CanvasClient(baseConfig, { fetchImpl, sleep });

      const destPath = join(tmpDir, "nested", "file.txt");
      const bytesWritten = await client.downloadToFile("https://files.example.com/signed/123", destPath);

      expect(bytesWritten).toBe(Buffer.byteLength(content));

      const written = await readFile(destPath, "utf-8");
      expect(written).toBe(content);

      await expect(stat(`${destPath}.part`)).rejects.toThrow();

      // downloadToFile must not send the bearer token to pre-signed file URLs.
      const [, requestInit] = fetchImpl.mock.calls[0] as [string, RequestInit | undefined];
      const headers = requestInit?.headers as Record<string, string> | undefined;
      expect(headers?.Authorization).toBeUndefined();
    });

    it("strips the verifier= query param from a failed-download error message", async () => {
      const fetchImpl = vi.fn<FetchImpl>().mockResolvedValueOnce(new Response("gone", { status: 500 }));
      const client = new CanvasClient(baseConfig, { fetchImpl, sleep });

      const destPath = join(tmpDir, "file.txt");
      try {
        await client.downloadToFile(
          "https://files.example.com/signed/123?verifier=super-secret-uuid&wrap=1",
          destPath
        );
        expect.fail("expected downloadToFile to throw");
      } catch (err) {
        const msg = String((err as Error).message);
        expect(msg).not.toContain("super-secret-uuid");
        expect(msg).not.toContain("verifier=");
      }
    });

    it("rejects both destPath and its .part sidecar against root before writing anything", async () => {
      const fetchImpl = vi.fn<FetchImpl>().mockResolvedValueOnce(new Response("data", { status: 200 }));
      const client = new CanvasClient(baseConfig, { fetchImpl, sleep });

      // destPath === root: ensureInside must reject this (no write allowed at root itself).
      await expect(client.downloadToFile("https://files.example.com/x", tmpDir, tmpDir)).rejects.toThrow();
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
});
