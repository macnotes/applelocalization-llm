#!/usr/bin/env -S deno run --allow-net

// MCP server for Apple Localization data.
// Exposes two tools to LLMs:
//   - search_translations: find how Apple translates a string
//   - list_languages: list available languages for a platform/version

const API_BASE = Deno.env.get("APPLE_LOC_API") ?? "https://applelocalization.com";
const CACHE_MAX = 500;

// Simple LRU cache: Map preserves insertion order, delete+re-insert moves to end
const cache = new Map<string, SearchResponse>();

function cacheGet(key: string): SearchResponse | undefined {
  const val = cache.get(key);
  if (val !== undefined) {
    cache.delete(key);
    cache.set(key, val);
  }
  return val;
}

function cacheSet(key: string, val: SearchResponse) {
  if (cache.size >= CACHE_MAX) {
    cache.delete(cache.keys().next().value!);
  }
  cache.set(key, val);
}

const PLATFORMS = ["ios", "macos"] as const;
const VERSIONS: Record<string, string[]> = {
  ios: ["26", "18", "17", "16", "15"],
  macos: ["26", "15", "14", "13", "12"],
};

type Platform = typeof PLATFORMS[number];

interface SearchResult {
  id: number;
  group_id: string;
  source: string;
  target: string;
  language: string;
  file_name: string;
  bundle_name: string;
}

interface SearchResponse {
  data: SearchResult[];
  total: number;
  last_page: number;
}

async function searchTranslations(params: {
  query: string;
  match?: "fuzzy" | "exact" | "startsWith";
  languages?: string[];
  platform?: Platform;
  version?: string;
  bundle?: string;
  size?: number;
}): Promise<SearchResponse> {
  const platform = params.platform ?? "ios";
  const version = params.version ?? VERSIONS[platform][0];
  const size = Math.min(params.size ?? 20, 50);
  const match = params.match ?? "fuzzy";

  let url: URL;
  if (match === "exact" || match === "startsWith") {
    url = new URL(`${API_BASE}/api/${platform}/${version}/search/advanced`);
    url.searchParams.set("c", "key");
    url.searchParams.set("o", match === "exact" ? "equal" : "startsWith");
    url.searchParams.set("q", params.query);
  } else {
    url = new URL(`${API_BASE}/api/${platform}/${version}/search`);
    url.searchParams.set("q", params.query);
    if (params.bundle) url.searchParams.set("b", params.bundle);
  }

  url.searchParams.set("size", String(size));
  for (const lang of params.languages ?? []) {
    url.searchParams.append("l", lang);
  }

  const cacheKey = url.toString();
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  const result = await res.json();
  cacheSet(cacheKey, result);
  return result;
}

// ── MCP protocol ─────────────────────────────────────────────────────────────

const tools = [
  {
    name: "search_translations",
    description:
      "Search for how Apple translates a string across languages. " +
      "Returns matching source strings and their translations. " +
      "Use this to find accurate Apple-style translations for UI strings in iOS or macOS apps and websites.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The English string to search for (e.g. 'Cancel', 'Settings', 'Done')",
        },
        languages: {
          type: "array",
          items: { type: "string" },
          description:
            "Language names to filter results (e.g. ['French', 'Japanese', 'German']). " +
            "Omit to return all languages.",
        },
        platform: {
          type: "string",
          enum: ["ios", "macos"],
          description: "Platform to search. Defaults to 'ios'.",
        },
        version: {
          type: "string",
          description:
            "OS version to search (e.g. '26', '18'). Defaults to latest.",
        },
        bundle: {
          type: "string",
          description:
            "Filter by framework/bundle name (e.g. 'UIKitCore', 'Foundation'). Optional.",
        },
        match: {
          type: "string",
          enum: ["fuzzy", "exact", "startsWith"],
          description:
            "Match mode for the query. 'fuzzy' (default) searches broadly. " +
            "'exact' matches the precise English string. " +
            "'startsWith' matches strings beginning with the query.",
        },
        size: {
          type: "number",
          description: "Max results to return (1-50). Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "list_platforms",
    description: "List available platforms and their OS versions.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

async function handleToolCall(name: string, args: Record<string, unknown>) {
  if (name === "search_translations") {
    const results = await searchTranslations({
      query: args.query as string,
      match: args.match as "fuzzy" | "exact" | "startsWith" | undefined,
      languages: args.languages as string[] | undefined,
      platform: args.platform as Platform | undefined,
      version: args.version as string | undefined,
      bundle: args.bundle as string | undefined,
      size: args.size as number | undefined,
    });

    if (!results.data.length) {
      return { content: [{ type: "text", text: "No translations found." }] };
    }

    // Group by source string then by group_id for readability
    const grouped: Record<string, Record<string, SearchResult[]>> = {};
    for (const row of results.data) {
      if (!grouped[row.source]) grouped[row.source] = {};
      if (!grouped[row.source][row.group_id]) grouped[row.source][row.group_id] = [];
      grouped[row.source][row.group_id].push(row);
    }

    const lines: string[] = [`Found ${results.total} result(s) (showing ${results.data.length}):\n`];
    for (const [source, groups] of Object.entries(grouped)) {
      lines.push(`Source: "${source}"`);
      for (const rows of Object.values(groups)) {
        if (rows[0].bundle_name) lines.push(`  Bundle: ${rows[0].bundle_name}`);
        for (const row of rows) {
          lines.push(`  ${row.language}: "${row.target}"`);
        }
      }
      lines.push("");
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (name === "list_platforms") {
    const lines = ["Available platforms and versions:\n"];
    for (const [platform, versions] of Object.entries(VERSIONS)) {
      lines.push(`${platform}: ${versions.join(", ")} (latest: ${versions[0]})`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ── stdio transport ───────────────────────────────────────────────────────────

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function send(obj: unknown) {
  const msg = JSON.stringify(obj) + "\n";
  Deno.stdout.write(encoder.encode(msg));
}

async function* readLines(): AsyncGenerator<string> {
  const buf = new Uint8Array(4096);
  let remainder = "";
  while (true) {
    const n = await Deno.stdin.read(buf);
    if (n === null) {
      if (remainder.trim()) yield remainder;
      return;
    }
    remainder += decoder.decode(buf.subarray(0, n));
    const lines = remainder.split("\n");
    remainder = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) yield line;
    }
  }
}

// Main loop
for await (const line of readLines()) {

  let request: { id: unknown; method: string; params?: Record<string, unknown> };
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }

  const { id, method, params = {} } = request;

  try {
    if (method === "initialize") {
      send({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "apple-localization", version: "1.0.0" },
        },
      });
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools } });
    } else if (method === "tools/call") {
      const result = await handleToolCall(
        params.name as string,
        (params.arguments ?? {}) as Record<string, unknown>,
      );
      send({ jsonrpc: "2.0", id, result });
    } else {
      send({ jsonrpc: "2.0", id, result: {} });
    }
  } catch (err) {
    send({
      jsonrpc: "2.0", id,
      error: { code: -32000, message: (err as Error).message },
    });
  }
}

