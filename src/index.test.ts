import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We need to mock fetch before the module's top-level code runs,
// but fetchAPI is just a function — we import it directly.
// The module's main() calls server.connect which reads stdin,
// so we must prevent that side-effect during tests.

// Mock the MCP SDK modules so that importing index.ts doesn't
// try to start a real stdio server.
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => {
  return {
    McpServer: vi.fn().mockImplementation(() => ({
      registerTool: vi.fn(),
      connect: vi.fn(),
    })),
  };
});

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => {
  return {
    StdioServerTransport: vi.fn().mockImplementation(() => ({})),
  };
});

// Now safe to import
const { fetchAPI } = await import("./index.js");

describe("fetchAPI", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns parsed JSON on a successful 200 response", async () => {
    const mockPayload = { campaign: { id: "abc", title: "Test Campaign" } };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockPayload),
    } as unknown as Response);

    const result = await fetchAPI("/campaigns/abc");

    expect(result).toEqual(mockPayload);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3000/campaigns/abc",
      undefined,
    );
  });

  it("returns an error object on a 404 response (does not throw)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Not Found"),
    } as unknown as Response);

    const result = await fetchAPI("/campaigns/nonexistent");

    expect(result).toHaveProperty("error");
    expect(String(result.error)).toContain("404");
    expect(String(result.error)).toContain("Not Found");
  });

  it("returns an error object on a 500 response (does not throw)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    } as unknown as Response);

    const result = await fetchAPI("/search?q=test");

    expect(result).toHaveProperty("error");
    expect(String(result.error)).toContain("500");
  });

  it("returns a friendly error when API is unreachable (ECONNREFUSED)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(
      new TypeError("fetch failed: ECONNREFUSED"),
    );

    const result = await fetchAPI("/agents/123");

    expect(result).toHaveProperty("error");
    expect(String(result.error)).toContain("Clawsfund API is not reachable");
    expect(String(result.error)).toContain("Make sure the backend is running");
  });

  it("returns a generic network error for non-connection failures", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(
      new TypeError("aborted"),
    );

    const result = await fetchAPI("/agents/123");

    expect(result).toHaveProperty("error");
    expect(String(result.error)).toContain("Network error");
    expect(String(result.error)).toContain("aborted");
  });

  it("passes RequestInit options through to fetch", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    } as unknown as Response);

    const options: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 5 }),
    };

    await fetchAPI("/campaigns/abc/back", options);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3000/campaigns/abc/back",
      options,
    );
  });
});
