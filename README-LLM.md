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

The easiest way to use either is the Claude Code skill below — it figures out what's available and does the right thing. If you want to understand what's running underneath it, or set things up manually, read on.

---

## The `/translate-apple` Skill

This is a [Claude Code](https://claude.ai/code) skill — a slash command that orchestrates everything. You drop it into your project, and from then on `/translate-apple` handles the lookup strategy, the classify-vs-generate split, and writing results back to your `.xcstrings` or `.strings` file.

### Install

Copy the skill into your project:

```sh
cp -r /path/to/applelocalization-llm/.claude/skills/translate-apple .claude/skills/
```

Or for global access (any project):

```sh
cp -r /path/to/applelocalization-llm/.claude/skills/translate-apple ~/.claude/skills/
```

### What it does

When you invoke it, the skill:

1. Checks for uncommitted changes on your file before touching anything
2. Detects whether you have a local dataset, a local API server, or only the live site — and uses the fastest available
3. Classifies each string: standard UI labels get looked up in Apple's data; free-form text, marketing copy, and app-specific strings get translated by the LLM
4. For multi-language jobs, uses `index.jsonl` to fetch all translations in one lookup per string instead of hitting each language file separately
5. Handles non-English source apps — if your strings are in French and you need Spanish and German, it finds the English bridge internally and returns what you asked for
6. Writes translations back into your `.xcstrings` or `.strings` file, or prints a table for inline strings

### Example invocations

**Translate a String Catalog to multiple languages:**
```
/translate-apple Localizable.xcstrings French German Japanese Korean
```

**Translate inline strings:**
```
/translate-apple "Cancel, Save, Done, Are you sure?" into French and Spanish
```

**Non-English source app:**
```
/translate-apple MonApp.xcstrings — source is French, add Spanish and Italian
```

**Target a specific platform:**
```
/translate-apple Localizable.xcstrings French — macos
```

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
        "/path/to/applelocalization-llm/mcp/main.ts"
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

The export script produces:

- `dataset/manifest.json` — index of languages, record counts, platforms, and versions
- `dataset/index.jsonl` — one record per unique string with **all translations grouped**, for multi-language and non-English lookups
- `dataset/by-language/en-fr.jsonl`, `en-ja.jsonl`, `en-de.jsonl` … (one per target language) — flat bilingual pairs

Records use short field names to keep token costs down. The language is in the filename, not each record. The key (`k`) only appears when it's an opaque identifier rather than the English string itself.

```json
{"g": "/System/Library/Frameworks/UIKit.framework:Cancel", "s": "Cancel", "t": "Annuler", "p": "ios", "v": "26", "b": "/System/Library/Frameworks/UIKit.framework"}
```

With an opaque key:
```json
{"g": ".../Settings:show.more.options", "k": "show.more.options", "s": "Show more options", "t": "Mostrar más opciones", "p": "ios", "v": "26", "b": "..."}
```

The `g` field is a group key shared across all translations of the same string. The by-language files use it to link back to `index.jsonl`, where every translation for that string is grouped in one record:

```json
{"g": "/System/Library/Frameworks/UIKit.framework:Cancel", "s": "Cancel", "p": "ios", "v": "26", "b": "...", "translations": [{"l": "fr", "t": "Annuler"}, {"l": "ja", "t": "キャンセル"}, {"l": "de", "t": "Abbrechen"}, ...]}
```

This is useful when translating to multiple languages at once — one index lookup returns all 40+ translations rather than reading 40 separate files. It also supports non-English starting points: find the string in the language file for your source language, grab the `g` key, then pull all other translations from `index.jsonl`.

Works directly with LangChain, LlamaIndex, or any tool that reads JSONL.

### Prerequisites

You'll need [Deno](https://deno.com):

```sh
brew install deno
```

And the raw localization data — clone it alongside this repo:

```sh
git clone --depth 1 https://github.com/kishikawakatsumi/applelocalization-tools ../applelocalization-tools
```

### Building it

**Most developers: pick your languages and platform**

If you're building an iOS app and only need a handful of languages, this is all you need. Build time is a few seconds, output is a few hundred MB instead of 25GB:

```sh
deno run --allow-read --allow-write scripts/export-llm-dataset.ts \
  --data ../applelocalization-tools/data \
  --out dataset \
  --platform ios \
  --languages fr,de,ja,ko,es
```

**iOS only, all languages (~12GB, ~6 min):**

```sh
deno run --allow-read --allow-write scripts/export-llm-dataset.ts \
  --data ../applelocalization-tools/data \
  --out dataset \
  --platform ios
```

**Everything — both platforms, latest versions (~25GB, ~10 min):**

```sh
deno run --allow-read --allow-write scripts/export-llm-dataset.ts \
  --data ../applelocalization-tools/data \
  --out dataset
```

**All historical OS versions (very large):**

```sh
deno run --allow-read --allow-write scripts/export-llm-dataset.ts \
  --data ../applelocalization-tools/data \
  --out dataset \
  --all-versions
```

**Heads up on size:** The full build (both platforms, latest versions) gives you ~34 million pairs across ~500 language files plus `index.jsonl` — roughly 25GB on disk. Filtering to one platform and a few languages brings that down to under 1GB. The `dataset/` folder is gitignored — don't try to commit it.

### Language codes

Use these codes with `--languages`. Apple uses its own locale identifiers — not always what you'd expect.

| Code | Language | | Code | Language |
|---|---|---|---|---|
| `ar` | Arabic | | `ko` | Korean |
| `bn` | Bengali | | `lt` | Lithuanian |
| `bg` | Bulgarian | | `ml` | Malayalam |
| `ca` | Catalan | | `ms` | Malay |
| `zh_CN` | Chinese (Simplified) | | `mr` | Marathi |
| `zh_HK` | Chinese (Hong Kong) | | `nl` | Dutch |
| `zh_TW` | Chinese (Traditional) | | `no` | Norwegian |
| `yue_CN` | Cantonese | | `or` | Odia |
| `hr` | Croatian | | `pa` | Punjabi |
| `cs` | Czech | | `pl` | Polish |
| `da` | Danish | | `pt_BR` | Portuguese (Brazil) |
| `nl` | Dutch | | `pt_PT` | Portuguese (Portugal) |
| `en_AU` | English (Australia) | | `ro` | Romanian |
| `en_GB` | English (UK) | | `ru` | Russian |
| `en_IN` | English (India) | | `sk` | Slovak |
| `fi` | Finnish | | `sl` | Slovenian |
| `fr` | French | | `es` | Spanish |
| `fr_CA` | French (Canada) | | `es_419` | Spanish (Latin America) |
| `de` | German | | `es_US` | Spanish (US) |
| `el` | Greek | | `sv` | Swedish |
| `gu` | Gujarati | | `ta` | Tamil |
| `he` | Hebrew | | `te` | Telugu |
| `hi` | Hindi | | `th` | Thai |
| `hu` | Hungarian | | `tr` | Turkish |
| `id` | Indonesian | | `uk` | Ukrainian |
| `it` | Italian | | `ur` | Urdu |
| `ja` | Japanese | | `vi` | Vietnamese |
| `kn` | Kannada | | | |
| `kk` | Kazakh | | | |

### Example prompts

**Bulk translation:**
> Read all strings from my Localizable.xcstrings. For each one, search dataset/by-language/en-de.jsonl for an exact source match (`s` field). Use Apple's translation if found, flag it for review if not.

**Translating to multiple languages at once:**
> Read dataset/index.jsonl. For each string in my Localizable.xcstrings that has an exact match on `s`, pull all translations from that record's `translations` array. Use those for French, German, Japanese, and Korean. Generate translations only for strings with no match.

**Non-English source lookup:**
> I have a French app and need Spanish translations. Search dataset/by-language/en-fr.jsonl for my French strings (match on `t`). For each hit, use the `g` key to look up the full record in index.jsonl and extract the Spanish (`es`) translation.

**RAG pipeline:**
> Load dataset/by-language/en-fr.jsonl into a vector store. When I ask you to translate a UI string to French, retrieve the 5 closest Apple translations as context and use those to guide your output.

**Fine-tuning:**
> Use dataset/by-language/en-ja.jsonl as training pairs for a model focused on Apple UI vocabulary in Japanese.

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

## Why is the local dataset so big?

The source data in [applelocalization-tools](https://github.com/kishikawakatsumi/applelocalization-tools) is about 6GB. The exported dataset is roughly 4x that. Here's why.

The source files store all languages together under each key:

```json
{"Cancel": [{"language": "fr", "target": "Annuler"}, {"language": "ja", "target": "キャンセル"}, ...]}
```

To make it useful for an LLM, we explode that into one record per language pair. "Cancel" with 40 translations becomes 40 separate records spread across 40 different files. That expansion is structural — it's the price of making the data directly consumable without an intermediate database.

The tradeoff comes down to this: the MCP server approach queries the live website, which is fast for a few strings but slow (~30s per query) for bulk work. The local dataset flips that — instant reads, but you pay a one-time build cost and carry the storage.

## What's not here yet

**Hugging Face Datasets** — the JSONL output would be a natural fit for [Hugging Face](https://huggingface.co/datasets), which is free for public datasets and natively supported by LangChain and the HF `datasets` library. Publishing there would let people load just `en-fr` without running the build script. Not done yet — the dataset needs sharding before publishing, and it would be worth coordinating with the original project author first.

**GitHub Releases** — individual language files gzip down significantly and could be attached as release assets, letting people download just the language they need. Not done yet.

**Embeddings index** — pre-computing embeddings would enable semantic search, so you could find Apple's translation for "undo last action" even if that exact string isn't in the database. Not done yet.

**by-bundle files** — an earlier version of this script also produced per-framework files (e.g. `UIKitCore.framework.jsonl`) so you could load only the strings relevant to a specific framework. Dropped because it doubled the output size with data that's already in the by-language files — you can get the same result with a `jq` filter:

```sh
jq 'select(.b | contains("UIKitCore"))' dataset/by-language/en-fr.jsonl
```
