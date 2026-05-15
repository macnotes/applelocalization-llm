# Using Apple Localization Data with LLMs

## The problem

Ask a general-purpose LLM to translate "Settings" into French and it'll say **"Paramètres"** — which is correct French. But every iPhone user in France sees **"Réglages"** in the Settings app. Ask it for "Close" and you might get "Clore" or "Fermeture". Apple uses **"Fermer"**, every time, everywhere.

Not wrong — just not Apple's. In an iOS or macOS app that difference creates friction. Users feel it even when they can't name it.

This project gives an LLM access to Apple's actual translations so it can use what Apple ships, not what sounds reasonable.

---

## What's here

[applelocalization.com](https://applelocalization.com) is a searchable database of every localized string in iOS and macOS — millions of translations straight from Apple's localization teams. This repo adds two ways to plug that into an LLM:

1. **MCP server** — the LLM queries the live site in real time, fetching only the strings it needs
2. **Local JSONL dataset** — a script that builds a flat bilingual corpus from the raw data, for offline use or fine-tuning

---

## Option 1: MCP Server

This is the easiest option and the right one for most people. You hook it up once, and from then on when you ask an LLM to translate something it looks up Apple's version first.

Two tools are exposed:

- **`search_translations`** — find how Apple translates a string, filtered by language, platform, version, or framework
- **`list_platforms`** — see what platforms and OS versions are available

Results are cached in memory (500 entries), so common strings like "Cancel", "Done", and "Settings" are instant after the first hit.

### Setup

You'll need [Deno](https://deno.com) first:

```sh
brew install deno
```

Then add this to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

If you're running the site locally:

```sh
APPLE_LOC_API=http://localhost:8080 deno run --allow-net --allow-env mcp/main.ts
```

### Example prompts

**Translating a website:**
> I'm building a web app. Translate these UI strings into French, German, Japanese, and Simplified Chinese. Check the apple-localization tool first for each one — use Apple's translation if it exists, otherwise generate one.
>
> Strings: Cancel, Save, Delete, Are you sure?, Sign In, Sign Out, Settings, Search, Loading…

**Translating an iOS app:**
> Here's my Localizable.xcstrings file. Add French and Japanese translations for every string. Check apple-localization first and use Apple's translation where one exists. Tell me which strings came from Apple and which you generated.

**Looking up a specific system string:**
> Use apple-localization to look up "Back" with match mode "exact" for iOS, in French and German. I want to match what Apple uses in navigation bars.

**Matching a specific framework:**
> Use apple-localization to search for strings in the "SafariServices" bundle for Japanese. I'm building a browser extension and want to match Safari's own wording.

---

## Option 2: Local JSONL Dataset

Good if you're building a translation pipeline, training a model, or need to work offline. Not necessary for most developers.

The export script produces:

- `dataset/by-language/en-fr.jsonl` — every English→French pair across all frameworks
- `dataset/by-bundle/SafariServices.framework.jsonl` — all languages for one framework
- `dataset/manifest.json` — index of everything: languages, bundles, record counts

Each record looks like this:

```json
{"key": "Cancel", "source": "Cancel", "target": "Annuler", "language": "fr", "platform": "ios", "version": "26", "bundle": "/System/Library/Frameworks/UIKit.framework"}
```

Works directly with LangChain, LlamaIndex, or any tool that reads JSONL.

### Building it

Clone the raw data alongside this repo first:

```sh
git clone --depth 1 https://github.com/macnotes/applelocalization-tools ../applelocalization-tools
```

Then run the export (latest iOS and macOS only, which is usually what you want):

```sh
deno run --allow-read --allow-write scripts/export-llm-dataset.ts \
  --data ../applelocalization-tools/data \
  --out dataset
```

To get all historical versions:

```sh
deno run --allow-read --allow-write scripts/export-llm-dataset.ts \
  --data ../applelocalization-tools/data \
  --out dataset \
  --all-versions
```

**Heads up on size:** Latest-only gives you ~34 million pairs, ~500 language files, ~4,500 bundle files, and about 50GB on disk. The `dataset/` folder is gitignored — don't try to commit it.

### Example prompts

**RAG pipeline:**
> Load dataset/by-language/en-fr.jsonl into a vector store. When I ask you to translate a UI string to French, retrieve the 5 closest Apple translations as context and use those to guide your output.

**Fine-tuning:**
> Use dataset/by-language/en-ja.jsonl as training pairs for a model focused on Apple UI vocabulary in Japanese.

**Bulk translation:**
> Read all strings from my Localizable.xcstrings. For each one, search dataset/by-language/en-de.jsonl for an exact source match. Use Apple's translation if found, flag it for review if not.

---

## Which one?

| | MCP Server | Local Dataset |
|---|---|---|
| **Best for** | Translating in an IDE or chat | RAG pipelines, fine-tuning, offline |
| **Setup** | 5 minutes | ~6 min build time (latest versions) |
| **Token cost** | Very low — only fetches what it needs | Depends on how much you load |
| **Latency** | ~30s first query, instant on cache hit | Instant |
| **Works offline** | No | Yes |
| **Always current** | Yes | No — snapshot at build time |

For most people: **use the MCP server**. You'll be up and running in a few minutes and won't have to think about datasets.

Go with the local dataset if you're doing something more programmatic — a translation pipeline, model training, or anything that needs bulk access.

---

## What's not here yet

**Hugging Face Datasets** — the JSONL output would be a natural fit for [Hugging Face](https://huggingface.co/datasets), which is free for public datasets and supported natively by LangChain and the HF `datasets` library. Not done yet because the dataset is ~50GB and needs some thought around sharding before publishing.

**GitHub Releases** — individual language files gzip down to 50–150MB each, which fits GitHub's release asset limit. Would let people download just `en-fr.jsonl` without running the build script. Not done yet.

**Embeddings index** — pre-computing embeddings would enable semantic search, so you could find Apple's translation for "undo last action" even if that exact string isn't in the database. Not done yet.
