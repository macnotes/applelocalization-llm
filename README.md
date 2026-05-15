# Using Apple Localization Data with LLMs

I'm a lone developer... no team of translators to help me localize. Localization isn't something I'd even considered before LLM AI came around. AI combined with Apple's switch from Strings files to String Catalogs (.xcstrings) in Xcode 15 makes it possible. Xcstring files are JSON-based, support pluralization and device variations in a single file, and Xcode manages them directly in a dedicated editor. 

There's really no excuse to not localize anymore. AI makes quick work of it. There's a catch, though. Language is idiomatic and LLMs make translation mistakes. If you're a non-English speaker, you're probably used to it, but it's still kind of annoying. I'm an English speaker so I'm lucky in that most everything I need to read is already in English, but I even find it distracting when I read something in UK English and they spell "colour" wrong. But non-English speakers have it way worse. 

Us English-speakers have opened hundreds of apps in our lifetimes, and almost every single one of them has a "Settings" menu item. But imagine one day you open one and it says, "Adjustments". Not very professional, but people who use translated software have to put up with that kind of thing all the time. You'll get cases like this if you just let AI do its own thing. And unless we're fluent in all the languages we want to localize, we'll never know about a mistake unless someone corrects us. 

> Ask a general-purpose LLM to translate "Settings" into French and it'll say **"Paramètres"** — which is correct French. But every iPhone user in France sees **"Réglages"** in the Settings app. Ask it for "Close" and you might get "Clore" or "Fermeture". Apple uses **"Fermer"**, every time, everywhere.

This project gives an LLM access to Apple's standard translations so it can use what Apple ships, not what sounds reasonable.

---

## Localization Data

This project is an add-on to two projects by [Katsumi Kishikawa](https://github.com/kishikawakatsumi). I can't even imaging how many hours he must have spent putting it all together. 

- **[applelocalization.com](https://applelocalization.com)** is a website with a searchable database of every localized string in iOS and macOS, millions of translations straight from Apple's frameworks. The MCP server in this project wraps Kishikawa-san's search API. You don't have to download any of the Kishikawa projects if you just want to have the MCP talk to the website he hosts. 

- **[applelocalization-web](https://github.com/kishikawakatsumi/applelocalization-web) is the source code for the applelocalization.com website. You can download that and run the website locally then have the MCP talk to that instead of the hosted version. The MCP can do lookups faster that way. 

- **[applelocalization-tools](https://github.com/kishikawakatsumi/applelocalization-tools)** has the raw JSON data that powers the applelocalization.com website. If you want to do bulk translations, clone that repo and then run the LLM export script in this repo. That transforms the translation database into JSONL files that are easier for an LLM to digest.

---

## What this repo adds

This repo adds two ways to plug that data into an LLM:

1. **MCP server** — the LLM queries the live site in real time, fetching only the strings it needs
2. **Local JSONL dataset** — a script that builds a flat bilingual corpus from the raw data, for offline use or fine-tuning

The easiest way to use either is the Claude Code skill below — it figures out what's available and does the right thing. If you want to understand what's running underneath it, or set things up manually, read on.


## Setup

You've got some options depending on what you need. They're covered in more detail below. 

* If you just need to look up a couple words once in a while, just use [applelocalization.com](https://applelocalization.com). 
* If you just need to look up a few words here and there but want an AI to do it, install the MCP from this project. It'll talk to the hosted website's API. 
* If you need to look up a few more words that that, but don't have a ton of hard-drive space and your happy to just run the website locally to cut down the round trip on the internet to fetch things off the hosted site, download a copy of the -web project and spin it up local. Then the MCP can talk to that. 
* Doing serious translation work? Download the -tools dataset and run the LLM export script. Then an AI can just read right out of that and skip the web server API overhead altogether. 


*Which one?*

| | MCP Server | Local Dataset |
|---|---|---|
| **Best for** | Translating in an IDE or chat | Bulk translation, RAG pipelines, fine-tuning, offline |
| **Setup** | 5 minutes | ~6 min build time (latest versions) |
| **Token cost** | Very low — only fetches what it needs | Depends on how much you load |
| **Latency** | ~30s first query, instant on cache hit | Instant |
| **Works offline** | No | Yes |
| **Always current** | Yes | No — snapshot at build time |


Instructions for the options are below. 

Check out the /translate-apple skill. It pulls it all together and you can see how it works. 

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
2. Detects whether you have a local LLM dataset generated or a local API server. If not, it talks to the hosted site. It'll use the fastest available. 
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

## Setting up the MCP Server option

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

### Example prompts for the MCP

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

## Setting up the Local JSONL Dataset

If you need speed, you should let an LLM read translation data direct from local storage. An AI could just read the raw data that powers the applelocalization.com project, but the data's setup to feed the relational db that backs up the website. It wasn't written with LLM consumption in mind. Not a problem... we can do some transformations on the data to get them into a form LLM can ingest more efficiently in terms of speed and token requirements. 

Rewriting the entire localization data set from the original project takes a long time but it's worth it if you do a lot of localization, need to build a translation pipeline, train a model, or need to work offline. But you can save a lot of time and hard drive space if you selectively build just the languages and platforms (macOS apps, iOS apps) you actually need. 

The export script produces:

- `dataset/manifest.json` — index of languages, record counts, platforms, and versions
- `dataset/index.jsonl` — one record per unique string with all translations grouped, for multi-language and non-English lookups
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

That repo gets updated when Apple ships new OS versions. The export script will warn you if your local copy is out of date and ask before proceeding. To update manually:

```sh
git -C ../applelocalization-tools pull
```

### Building it

**Most developers: pick your languages and platform**

If you're building an iOS app and only need a handful of languages, this is all you need. Build time is a few seconds, output is a few hundred MB instead of 25GB:

```sh
deno run --allow-read --allow-write --allow-net --allow-run scripts/export-llm-dataset.ts \
  --data ../applelocalization-tools/data \
  --out dataset \
  --platform ios \
  --languages fr,de,ja,ko,es
```

**iOS only, all languages (~12GB, ~6 min):**

```sh
deno run --allow-read --allow-write --allow-net --allow-run scripts/export-llm-dataset.ts \
  --data ../applelocalization-tools/data \
  --out dataset \
  --platform ios
```

**Everything — both platforms, latest versions (~25GB, ~10 min):**

```sh
deno run --allow-read --allow-write --allow-net --allow-run scripts/export-llm-dataset.ts \
  --data ../applelocalization-tools/data \
  --out dataset
```

**All historical OS versions (very large):**

```sh
deno run --allow-read --allow-write --allow-net --allow-run scripts/export-llm-dataset.ts \
  --data ../applelocalization-tools/data \
  --out dataset \
  --all-versions
```

**Heads up on size:** The full build (both platforms, latest versions) gives you ~34 million pairs across ~500 language files plus `index.jsonl` — roughly 25GB on disk. Filtering to one platform and a few languages brings that down to under 1GB. 

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

### Why's the generated local LLM dataset so big?

The source data in [applelocalization-tools](https://github.com/kishikawakatsumi/applelocalization-tools) is about 6GB. The exported dataset would be a multiple of that if you exported the whole thing. 

The source files store all languages together under each key:

```json
{"Cancel": [{"language": "fr", "target": "Annuler"}, {"language": "ja", "target": "キャンセル"}, ...]}
```

To make it useful for an LLM without consuming more tokens than we'd like, we explode that into one record per language pair. "Cancel" with 40 translations becomes 40 separate records spread across 40 different files. That expansion is structural — it's the price of making the data directly consumable without an intermediate database.

The tradeoff comes down to this: the MCP server approach queries the live website, which is fast for a few strings but slow (~30s per query) for bulk work. The local dataset flips that — instant reads, but you pay a one-time build cost and carry the storage.

## To-Do?

**Hugging Face Datasets** — the JSONL output would be a natural fit for [Hugging Face](https://huggingface.co/datasets), which is free for public datasets and natively supported by LangChain and the HF `datasets` library. Publishing there would let people load just `en-fr` without running the build script. The dataset needs sharding before publishing. 

**GitHub Releases** — individual language files gzip down significantly and could be attached as release assets, letting people download just the language they need. Probably not practical given file sizes. 

**Embeddings index** — pre-computing embeddings would enable semantic search, so you could find Apple's translation for "undo last action" even if that exact string isn't in the database. 

**by-bundle files** — an earlier version of this script also produced per-framework files (e.g. `UIKitCore.framework.jsonl`) so you could load only the strings relevant to a specific framework. Dropped because it doubled the output size with data that's already in the by-language files — you can get the same result with a `jq` filter:

```sh
jq 'select(.b | contains("UIKitCore"))' dataset/by-language/en-fr.jsonl
```
