# Using Apple Localization Data with LLMs

## Why this matters

Ask a general-purpose LLM to translate "Settings" into French and it will likely say **"Paramètres"** — a perfectly correct French word. But every iPhone user in France sees **"Réglages"** in the Settings app. Ask it to translate "Close" and it might offer "Clore" or "Fermeture". Apple uses **"Fermer"**, consistently, across every framework.

These aren't wrong answers — they're just not Apple's answers. In an iOS or macOS app, or a website targeting Apple users, deviating from Apple's vocabulary creates subtle friction. Users notice, even if they can't articulate why.

This project gives an LLM access to Apple's actual translations — millions of strings from real iOS and macOS releases — so it can ground its output in what Apple ships, rather than what sounds reasonable.

---

## What's in this repo

[applelocalization.com](https://applelocalization.com) is a searchable database of every localized string shipped inside iOS and macOS — millions of real translations produced by Apple's own localization teams. When Apple translates "Cancel" into Japanese, they write「キャンセル」. When they translate "Settings" into French, they write "Réglages", not "Paramètres". These choices matter: they're what users see in every system app, and deviating from them makes third-party apps feel inconsistent.

This repo adds two ways for an LLM to consult that database as a grounding source when translating:

1. **MCP server** — a lightweight server that lets an LLM query the live applelocalization.com API in real time, retrieving exactly the strings it needs, when it needs them.
2. **Local JSONL dataset** — a script that builds a flat, bilingual parallel corpus from the raw source data, organized for offline use or fine-tuning.

---

## Option 1: MCP Server (recommended for interactive use)

### How it works

The MCP server exposes two tools to any MCP-compatible LLM client (Claude Desktop, Cursor, etc.):

- **`search_translations`** — looks up how Apple translates a specific English string, optionally filtered by language, platform, OS version, and framework
- **`list_platforms`** — lists available platforms and OS versions

When you ask an LLM to translate your app's UI, it calls `search_translations` for each string, retrieves Apple's own translations as few-shot examples, and uses those to ground its output. The result is translations that match Apple's vocabulary, tone, and conventions — not a generic machine translation.

An in-process LRU cache (500 entries) means repeated lookups for common strings like "Cancel", "Done", and "Settings" are instant after the first query.

### Setup

Requires [Deno](https://deno.com) (`brew install deno`).

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "apple-localization": {
      "command": "deno",
      "args": [
        "run",
        "--allow-net",
        "--allow-env",
        "/path/to/applelocalization-web/mcp/main.ts"
      ]
    }
  }
}
```

To point at a local instance instead of the live site:

```sh
APPLE_LOC_API=http://localhost:8080 deno run --allow-net --allow-env mcp/main.ts
```

### Example prompts

**Translating a website:**
> I'm building a SaaS web app. Translate the following UI strings into French, German, Japanese, and Simplified Chinese. Use Apple's translations for any strings that appear in iOS or macOS — check the apple-localization tool first before generating a translation.
>
> Strings: Cancel, Save, Delete, Are you sure?, Sign In, Sign Out, Settings, Search, Loading…

**Translating an iOS app in Xcode:**
> Here is my Localizable.xcstrings file. Add French and Japanese translations for every string. For each one, first check the apple-localization tool to see if Apple uses a standard translation. Use Apple's translation if one exists, and note which strings you sourced from Apple vs. generated yourself.

**Exact match for a known system string:**
> Use apple-localization to look up "Back" with match mode "exact" for iOS, in French and German. I want to use the same translation Apple uses in navigation bars.

**Framework-specific lookup:**
> Use apple-localization to search for strings in the "SafariServices" bundle for Japanese. I'm building a browser extension and want to match Safari's own UI vocabulary.

---

## Option 2: Local JSONL Dataset (for offline or bulk use)

### How it works

The export script walks the raw JSON source files from [applelocalization-tools](https://github.com/macnotes/applelocalization-tools) and produces two sets of JSONL files:

- `dataset/by-language/en-fr.jsonl` — all English→French translation pairs across all frameworks
- `dataset/by-bundle/SafariServices.framework.jsonl` — all languages for a single framework
- `dataset/manifest.json` — index of all files, languages, bundles, and record counts

Each record is a flat bilingual pair:

```json
{"key": "Cancel", "source": "Cancel", "target": "Annuler", "language": "fr", "platform": "ios", "version": "26", "bundle": "/System/Library/Frameworks/UIKit.framework"}
```

This format is directly consumable by RAG pipelines (LangChain, LlamaIndex), embedding workflows, or fine-tuning jobs — no database required.

### Building the dataset

Requires Deno and a local clone of applelocalization-tools:

```sh
git clone --depth 1 https://github.com/macnotes/applelocalization-tools ../applelocalization-tools

deno run --allow-read --allow-write scripts/export-llm-dataset.ts \
  --data ../applelocalization-tools/data \
  --out dataset
```

By default, only the latest iOS and macOS versions are exported (currently iOS 26 and macOS 26). To export all historical versions:

```sh
deno run --allow-read --allow-write scripts/export-llm-dataset.ts \
  --data ../applelocalization-tools/data \
  --out dataset \
  --all-versions
```

**Note on size:** The latest-only build produces ~34 million translation pairs across ~500 language files and ~4,500 bundle files. Expect the output to be 50GB+ uncompressed. The dataset directory is gitignored — build it locally and don't commit it.

### Example prompts with a local build

**RAG pipeline:**
> Load dataset/by-language/en-fr.jsonl into a vector store. When asked to translate a UI string to French, retrieve the 5 closest Apple translations as context, then produce the translation using those as examples.

**Fine-tuning:**
> Use dataset/by-language/en-ja.jsonl as training pairs to fine-tune a translation model specifically for Apple UI vocabulary in Japanese.

**Bulk translation script:**
> Read all strings from my Localizable.xcstrings file. For each one, search dataset/by-language/en-de.jsonl for an exact match on the source field. Use Apple's translation if found, otherwise flag it for manual review.

---

## Which approach should you use?

| | MCP Server | Local Dataset |
|---|---|---|
| **Best for** | Interactive translation in an IDE or chat | Bulk translation, RAG pipelines, fine-tuning |
| **Setup** | 5 minutes | ~6 minutes to build (latest versions only) |
| **Token cost** | Very low — LLM fetches only what it needs | Depends on how much data you load into context |
| **Latency** | ~30s first query, instant on cache hit | Instant (local) |
| **Infrastructure** | None — calls live applelocalization.com | Local disk only |
| **Works offline** | No | Yes |
| **Coverage** | Full database, always up to date | Snapshot at build time |

For most developers translating an app or website, **the MCP server is the right choice** — you get Apple's translations on demand, with minimal setup and near-zero token cost after the first lookup.

The local dataset is the right choice if you're building a translation pipeline, training a model, or need to work air-gapped.

---

## Alternatives not yet adopted

### Hugging Face Datasets

The JSONL output is structurally well-suited for hosting on [Hugging Face Datasets](https://huggingface.co/datasets), which is purpose-built for this scale, free for public datasets, and natively supported by LangChain, LlamaIndex, and the Hugging Face `datasets` library. Publishing there would make the data discoverable and consumable without requiring anyone to run the export script.

This hasn't been done yet because the dataset is large (~50GB uncompressed) and the right compression and sharding strategy deserves consideration before publishing publicly.

### GitHub Releases

Individual language files (e.g. `en-fr.jsonl`, `en-ja.jsonl`) compressed with gzip are typically 50–150MB each — within GitHub's 2GB release asset limit. Publishing per-language files as release assets would allow selective download without a full local build. Not yet implemented.

### Embeddings index

Pre-computing embeddings for all source strings and publishing the index (e.g. as a FAISS or Chroma snapshot) would make semantic search possible — finding Apple's translation for "undo last action" even if the exact string doesn't exist. Not yet implemented.
