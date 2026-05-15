# Apple Localization MCP Server

An MCP server that lets LLMs look up how Apple translates UI strings across iOS and macOS.

## Tools

- **search_translations** — Find how Apple translates a string (e.g. "Cancel", "Settings") into any language
- **list_platforms** — List available platforms and OS versions

## Usage in Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "apple-localization": {
      "command": "deno",
      "args": ["run", "--allow-net", "--allow-env", "/path/to/applelocalization-llm/mcp/main.ts"]
    }
  }
}
```

## Running locally

```sh
deno run --allow-net --allow-env mcp/main.ts
```

To point at a local instance instead of the live site:

```sh
APPLE_LOC_API=http://localhost:8080 deno run --allow-net --allow-env mcp/main.ts
```
