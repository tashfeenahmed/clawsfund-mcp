#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v3";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const API_BASE = process.env.CLAWSFUND_API_URL ?? "https://clawsfund.com/api";

/**
 * Fetch helper that calls the Clawsfund API and returns parsed JSON.
 * Never throws — returns { error: string } on failure so the LLM
 * always gets a usable text response.
 */
async function fetchAPI(
  path: string,
  options?: RequestInit,
): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(`${API_BASE}${path}`, options);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { error: `API returned ${res.status}: ${body}` };
    }
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isConnectionRefused =
      message.includes("ECONNREFUSED") ||
      message.includes("fetch failed") ||
      message.includes("ENOTFOUND");
    if (isConnectionRefused) {
      return {
        error: `Clawsfund API is not reachable at ${API_BASE}. Make sure the backend is running.`,
      };
    }
    return { error: `Network error: ${message}` };
  }
}

/** Helper to build a text result for MCP tool responses. */
function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "clawsfund-mcp",
  version: "0.1.0",
});

// ---------------------------------------------------------------------------
// Input schemas — declared separately to help TypeScript resolve generics.
// ---------------------------------------------------------------------------

const SearchInput = {
  query: z.string(),
  category: z.optional(z.string()),
  type: z.optional(z.enum(["donation", "equity"])),
  limit: z.optional(z.number()),
} as const;

const CampaignIdInput = {
  campaignId: z.string(),
} as const;

const AgentIdInput = {
  agentId: z.string(),
} as const;

const ListInput = {
  category: z.optional(z.string()),
  type: z.optional(z.enum(["donation", "equity"])),
  status: z.optional(z.string()),
  page: z.optional(z.number()),
} as const;

const FundInput = {
  campaignId: z.string(),
  amount: z.number(),
  backerPublicKey: z.string(),
} as const;

// ---------------------------------------------------------------------------
// Tool: search_campaigns
// ---------------------------------------------------------------------------

server.registerTool(
  "search_campaigns",
  {
    description: "Search for AI agent crowdfunding campaigns on Clawsfund",
    inputSchema: SearchInput,
  },
  async (args) => {
    const { query, category, type, limit } = args;
    const effectiveLimit = limit ?? 10;
    const params = new URLSearchParams({ q: query, limit: String(effectiveLimit) });
    if (category) params.set("category", category);
    if (type) params.set("type", type);

    const data = await fetchAPI(`/search?${params.toString()}`);

    if (data.error) {
      return textResult(String(data.error));
    }

    const hits = (data.hits ?? []) as Array<Record<string, unknown>>;

    if (hits.length === 0) {
      return textResult(`No campaigns found for "${query}".`);
    }

    const lines = hits.map((h, i) => {
      return [
        `${i + 1}. ${h.title ?? "Untitled"}`,
        `   Type: ${h.type ?? "n/a"} | Category: ${h.category ?? "n/a"}`,
        `   Goal: ${h.goalAmount ?? "?"} | Funded: ${h.fundedAmount ?? 0}`,
        `   Status: ${h.status ?? "unknown"} | ID: ${h.id ?? h._id ?? "?"}`,
      ].join("\n");
    });

    const text = [
      `Found ${data.totalHits ?? hits.length} campaigns for "${query}":`,
      "",
      ...lines,
    ].join("\n");

    return textResult(text);
  },
);

// ---------------------------------------------------------------------------
// Tool: get_campaign
// ---------------------------------------------------------------------------

server.registerTool(
  "get_campaign",
  {
    description: "Get full details of a specific Clawsfund campaign",
    inputSchema: CampaignIdInput,
  },
  async (args) => {
    const { campaignId } = args;
    const data = await fetchAPI(`/campaigns/${campaignId}`);

    if (data.error) {
      return textResult(String(data.error));
    }

    const c = (data.campaign ?? data) as Record<string, unknown>;

    const milestones = Array.isArray(c.milestones)
      ? (c.milestones as Array<Record<string, unknown>>)
          .map(
            (m) =>
              `  - #${m.number} ${m.name}: ${m.deliverable} (${m.fundsPercentage}% — ${m.status})`,
          )
          .join("\n")
      : "  None";

    const agent =
      typeof c.agent === "object" && c.agent !== null
        ? (c.agent as Record<string, unknown>)
        : null;

    const agentInfo = agent
      ? `Agent: ${agent.handle ?? agent.id ?? "unknown"}`
      : `Agent ID: ${c.agent ?? "unknown"}`;

    const lines = [
      `Campaign: ${c.title ?? "Untitled"}`,
      `ID: ${c.id ?? "?"}`,
      `Type: ${c.type ?? "n/a"} | Category: ${c.category ?? "n/a"}`,
      `Status: ${c.status ?? "unknown"}`,
      `Goal: ${c.goalAmount ?? "?"} ${c.currency ?? "SOL"} | Funded: ${c.fundedAmount ?? 0} | Backers: ${c.backerCount ?? 0}`,
      `Duration: ${c.durationDays ?? "?"} days`,
      agentInfo,
      "",
      "Milestones:",
      milestones,
    ];

    if (c.equityTerms) {
      const eq = c.equityTerms as Record<string, unknown>;
      lines.push(
        "",
        "Equity Terms:",
        `  Pre-money valuation: ${eq.premoneyValuation ?? "?"}`,
        `  Equity offered: ${eq.equityPercentage ?? "?"}%`,
        `  Min investment: ${eq.minimumInvestment ?? "?"}`,
      );
    }

    return textResult(lines.join("\n"));
  },
);

// ---------------------------------------------------------------------------
// Tool: get_agent
// ---------------------------------------------------------------------------

server.registerTool(
  "get_agent",
  {
    description: "Get an AI agent's profile and their campaigns on Clawsfund",
    inputSchema: AgentIdInput,
  },
  async (args) => {
    const { agentId } = args;
    const [agentData, campaignsData] = await Promise.all([
      fetchAPI(`/agents/${agentId}`),
      fetchAPI(`/agents/${agentId}/campaigns`),
    ]);

    if (agentData.error) {
      return textResult(String(agentData.error));
    }

    const a = (agentData.agent ?? agentData) as Record<string, unknown>;
    const profile = (a.profile ?? {}) as Record<string, unknown>;

    const lines = [
      `Agent: ${a.handle ?? "unknown"}`,
      `ID: ${a.id ?? "?"}`,
      `Status: ${a.verificationStatus ?? "unknown"}`,
    ];

    if (profile.name) lines.push(`Name: ${profile.name}`);
    if (profile.bio) lines.push(`Bio: ${profile.bio}`);
    if (Array.isArray(profile.capabilities) && profile.capabilities.length > 0) {
      lines.push(`Capabilities: ${(profile.capabilities as string[]).join(", ")}`);
    }

    // Campaigns
    const campaigns = campaignsData.error
      ? null
      : ((campaignsData.campaigns ?? []) as Array<Record<string, unknown>>);

    if (campaigns && campaigns.length > 0) {
      lines.push("", "Campaigns:");
      for (const c of campaigns) {
        lines.push(
          `  - ${c.title ?? "Untitled"} (${c.status ?? "?"}) — Goal: ${c.goalAmount ?? "?"}, Funded: ${c.fundedAmount ?? 0} | ID: ${c.id ?? "?"}`,
        );
      }
    } else {
      lines.push("", "No campaigns found for this agent.");
    }

    return textResult(lines.join("\n"));
  },
);

// ---------------------------------------------------------------------------
// Tool: list_campaigns
// ---------------------------------------------------------------------------

server.registerTool(
  "list_campaigns",
  {
    description: "Browse Clawsfund campaigns with optional filters",
    inputSchema: ListInput,
  },
  async (args) => {
    const { category, type, status, page } = args;
    const effectiveStatus = status ?? "active";
    const effectivePage = page ?? 1;
    const limit = 20;
    const offset = (effectivePage - 1) * limit;
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    if (effectiveStatus) params.set("status", effectiveStatus);
    if (category) params.set("category", category);
    if (type) params.set("type", type);

    const data = await fetchAPI(`/campaigns?${params.toString()}`);

    if (data.error) {
      return textResult(String(data.error));
    }

    const campaigns = (data.campaigns ?? []) as Array<Record<string, unknown>>;
    const pagination = (data.pagination ?? {}) as Record<string, unknown>;

    if (campaigns.length === 0) {
      return textResult("No campaigns found with the given filters.");
    }

    const lines = campaigns.map((c, i) => {
      return [
        `${i + 1 + offset}. ${c.title ?? "Untitled"}`,
        `   Type: ${c.type ?? "n/a"} | Category: ${c.category ?? "n/a"}`,
        `   Goal: ${c.goalAmount ?? "?"} | Funded: ${c.fundedAmount ?? 0} | Backers: ${c.backerCount ?? 0}`,
        `   Status: ${c.status ?? "unknown"} | ID: ${c.id ?? "?"}`,
      ].join("\n");
    });

    const text = [
      `Campaigns (page ${effectivePage}, total ${pagination.total ?? "?"}):`,
      "",
      ...lines,
      "",
      pagination.hasMore ? "More results available — increase page number." : "No more results.",
    ].join("\n");

    return textResult(text);
  },
);

// ---------------------------------------------------------------------------
// Tool: fund_campaign
// ---------------------------------------------------------------------------

server.registerTool(
  "fund_campaign",
  {
    description:
      "Build an unsigned Solana transaction to fund a Clawsfund campaign",
    inputSchema: FundInput,
  },
  async (args) => {
    const { campaignId, amount, backerPublicKey } = args;

    if (amount <= 0) {
      return textResult("Amount must be positive.");
    }

    const data = await fetchAPI(`/campaigns/${campaignId}/back`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount, backerPublicKey }),
    });

    if (data.error) {
      return textResult(String(data.error));
    }

    const tx = data.transaction ?? data.serializedTransaction ?? null;

    if (!tx) {
      return textResult(
        `Fund request accepted but no transaction was returned. Response: ${JSON.stringify(data)}`,
      );
    }

    const lines = [
      "Unsigned transaction created successfully.",
      "",
      `Campaign: ${campaignId}`,
      `Amount: ${amount} SOL`,
      `Backer: ${backerPublicKey}`,
      "",
      "Serialized transaction (base64):",
      String(tx),
      "",
      "Sign this transaction with your wallet and submit it to the Solana network.",
    ];

    return textResult(lines.join("\n"));
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Clawsfund MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error starting MCP server:", err);
  process.exit(1);
});

export { fetchAPI };
