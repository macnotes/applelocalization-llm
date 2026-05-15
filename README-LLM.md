# Using Apple Localization Data with LLMs

I'm a lone developer. Mostly Swift apps... no team of translators to help me localize. Localization isn't something I'd even consider before LLM AI came on the scene. AI combined with Apple's switch from Strings files to String Catalogs (.xcstrings files), introduced in Xcode 15. They're JSON-based, support pluralization and device variations in a single file, and Xcode manages them directly in a dedicated editor.

There's really no excuse to localized anymore. AI makes quick work of it. There is one catch, though. Language is idiomatic and LLMs make translation mistakes there. If you're a non-English speaker, you're probably used to it, but it's still kind of annoying. I get distracted when I read something in UK English and they spell "colour" wrong but non-English speakers have it way worse. 

Speaking here to my fellow English-speakers... we've opened hundreds or thousands of apps in our lifetime, and every one of them has a "Settings" menu item. Then one day, you open one and it says, "Adjustments". Not very professional, but you'll get cases like this if you just let AI do its thing. And since few of us in the US are fluent in many languages, we'll never know about a mistake unless someone corrects us. 

> Ask a general-purpose LLM to translate "Settings" into French and it'll say **"Paramètres"** — which is correct French. But every iPhone user in France sees **"Réglages"** in the Settings app. Ask it for "Close" and you might get "Clore" or "Fermeture". Apple uses **"Fermer"**, every time, everywhere.

This project gives an LLM access to Apple's actual translations so it can use what Apple ships, not what sounds reasonable.

---

## My Starting Point

[applelocalization.com](https://applelocalization.com) is a searchable database of every localized string in iOS and macOS — millions of translations straight from Apple's localization teams. It's breath-takingly comprehensive. 

This repo adds two ways to plug that into an LLM:

1. **MCP server** — the LLM queries the live site in real time, fetching only the strings it needs
2. **Local JSONL dataset** — a script that builds a flat bilingual corpus from the raw data, for offline use or fine-tuning

Option 1 is way easier to setup... no build step needed. But a web call is slow. Fine if you just need to look up a term or two every once in a while, but it'd take forever for an LLM to translate an entire app. 

Option 2 re-writes the projects translation tables into a format that more easily and directly consumed by an LLM. 

---

## Option 1: MCP Server

This is the easy option. You hook it up once, and from then on when you ask an LLM to translate something it looks up Apple's version first.

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

The applelocalization.com website code is [available from GitHub](https://github.com/kishikawakatsumi/applelocalization-web). If you want to save the network back and forth time, you can speed things up by running it locally and point the mcp to your copy instead of the hosted one:

```sh
APPLE_LOC_API=http://localhost:8080 deno run --allow-net --allow-env mcp/main.ts
```

### Example prompts for the MCP method

**Translating a website:**
> I'm building a web app. Translate these UI strings into French, German, Japanese, and Simplified Chinese. Check the apple-localization tool first for each one — use Apple's translation if it exists, otherwise generate one.
>
> Strings: Cancel, Save, Delete, Are you sure?, Sign In, Sign Out, Settings, Search, Loading…

**Translating a Swift app:**
> Look at my Localizable.xcstrings file. Add French and Japanese translations for every string. For speed, you can translate many things yourself, idiomatically rather than literally. However, for things that are likely to have a standardized localization, like menu item labels, or where the correct translation is not obvious, check apple-localization MCP first and use Apple's translation where one exists. Tell me which strings came from Apple and which you generated.

**Looking up a specific system string:**
> Use apple-localization to look up "Back" with match mode "exact" for iOS, in French and German. I want to match what Apple uses in navigation bars.

**Matching a specific framework:**
> Use apple-localization to search for strings in the "SafariServices" bundle for Japanese. I'm building a browser extension and want to match Safari's own wording.

---

## Option 2: Local JSONL Dataset

If we need speed, we should let an LLM read translation data from our local hard drives. We could just download the applelocalization.com project from GitHub and tell the AI to look there, but that project wasn't written with LLM consumption in mind. So we have to do some semi-significant transformations on the data to get them into a form LLM can ingest more efficiently in terms of speed and token requirements. 

Rewriting the entire localization data set from the original project takes a long time but it's worth it if you do a lot of localization, need to build a translation pipeline, train a model, or need to work offline. 

The export script produces one file per language and one file per framework bundle:

- `dataset/manifest.json` — index of everything: languages, bundles, record counts
- `dataset/by-language/en-fr.jsonl`, `en-ja.jsonl`, `en-de.jsonl` … (one per target language) — every English→[language] pair across all frameworks
- `dataset/by-bundle/SafariServices.framework.jsonl`, `UIKitCore.framework.jsonl` … (one per framework) — all languages for that framework

Records use short field names to keep token costs down. The `language` field is omitted from by-language files (it's in the filename), and `bundle` is omitted from by-bundle files. The key (`k`) only appears when it's an opaque identifier rather than the English string itself.

by-language (`en-fr.jsonl`):
```json
{"s": "Cancel", "t": "Annuler", "p": "ios", "v": "26", "b": "/System/Library/Frameworks/UIKit.framework"}
```

by-bundle (`UIKitCore.framework.jsonl`):
```json
{"s": "Cancel", "t": "Annuler", "l": "fr", "p": "ios", "v": "26"}
```

With an opaque key:
```json
{"k": "show.more.options", "s": "Show more options", "t": "Mostrar más opciones", "l": "es_US", "p": "ios", "v": "26"}
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

To get all historical OS versions:

```sh
deno run --allow-read --allow-write scripts/export-llm-dataset.ts \
  --data ../applelocalization-tools/data \
  --out dataset \
  --all-versions
```

**Heads up on size:** Latest-only alone gives you ~34 million pairs, ~500 language files, ~4,500 bundle files, and about 50GB on disk. The `dataset/` folder is gitignored — don't try to commit it.

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
| **Best for** | Translating in an IDE or chat | Bulk translation, RAG pipelines, fine-tuning, offline |
| **Setup** | 5 minutes | ~6 min build time (latest versions) |
| **Token cost** | Very low — only fetches what it needs | Depends on how much you load |
| **Latency** | ~30s first query, instant on cache hit | Instant |
| **Works offline** | No | Yes |
| **Always current** | Yes | No — snapshot at build time |

---

## Better/Future options?

**Hugging Face Datasets** — the JSONL output would be a natural fit for [Hugging Face](https://huggingface.co/datasets), which is free for public datasets and supported natively by LangChain and the HF `datasets` library. Not done yet because the dataset is ~50GB and needs some thought around sharding before publishing and because it would be rude to post something there unless the original author consents.

**GitHub Releases** — individual language files gzip down to 50–150MB each, which fits GitHub's release asset limit. Would let people download just `en-fr.jsonl` without running the build script. 

**Embeddings index** — pre-computing embeddings would enable semantic search, so you could find Apple's translation for "undo last action" even if that exact string isn't in the database. 
