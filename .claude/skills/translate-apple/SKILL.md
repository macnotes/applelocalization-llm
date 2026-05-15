---
name: translate-apple
description: Translate UI strings using Apple's actual translations — checks local dataset, local MCP server, or live site in that order. Handles .xcstrings and .strings files.
---

Translate UI strings into one or more languages using Apple's official translations from applelocalization.com. The goal is to match what Apple ships in its own apps — not just grammatically correct translations, but the exact wording iPhone and Mac users already see every day.

## Arguments

`$ARGUMENTS` may contain:
- Strings to translate (inline), or a path to a `.xcstrings` or `.strings` file
- Target languages (e.g. "French, German, Japanese")
- A platform hint (ios or macos; default to ios)

If any of these are missing, ask before proceeding.

## Step 1 — Check for dirty files before touching anything

If a file path was provided, check whether it has uncommitted changes before doing any work:

```sh
git status --short <file>
```

If the file is dirty (modified, untracked, or staged), stop and tell the user. Suggest they commit or stash first. Do not proceed until they confirm it's safe to overwrite.

## Step 2 — Determine which data source to use

Check in this order, stopping at the first one that works:

**A. Local dataset** (`dataset/by-language/`)
Run: `ls dataset/by-language/ 2>/dev/null | head -1`
If files exist, use the local dataset. It's fastest.

**B. Local MCP / API server**
Run: `curl -s --max-time 2 http://localhost:8080/api/ios/26/search?q=Cancel&size=1 2>/dev/null`
If you get a JSON response, use the search API at `http://localhost:8080`.

**C. Live site**
Fall back to `https://applelocalization.com`.

Tell the user which source you're using before translating.

## Step 3 — Read source strings

**Inline strings:** use as-is.

**`.xcstrings` file (modern, Xcode 15+):** A single JSON file containing all languages. Read it and extract all keys under `strings` where the source language entry exists but one or more target languages are missing or have `state != "translated"`. Only translate what's needed — don't overwrite existing translated entries.

**`.strings` file (legacy):** Plain text `"key" = "value";` format, one file per language in `.lproj` folders. Read the English source file. For each target language, check if a `<lang>.lproj/` file already exists alongside it — if so, read it to avoid re-translating strings that are already done.

## Step 4 — Classify each string

Sort strings into two buckets before looking anything up:

**Look up in Apple data** — strings likely to have a canonical Apple translation:
- Short UI labels: Cancel, Save, Done, Delete, Settings, Back, Search, Sign In, Sign Out, Next, Continue, OK, Edit, Share, Close, Select All
- Navigation bar titles, tab bar labels, alert button labels
- System permission prompts
- Anything that reads like a standard iOS/macOS control label

**Translate yourself** — strings where Apple almost certainly has no match:
- Free-form body text, marketing copy, onboarding descriptions
- App-specific feature names
- Anything longer than ~6 words that doesn't read like a UI label
- Sentences with `%@`, `%d`, or other format specifiers embedded in longer prose

## Step 5 — Look up the "look up" strings

### Determine lookup strategy first

**Source language is English, translating to 1 language:** grep the single by-language file — fastest.

**Source language is English, translating to 2+ languages:** grep `index.jsonl` once per string and extract all needed languages from the `translations` array in that one record. Do not grep per-language files individually — that's N times slower for no gain.

**Source language is not English:** the workflow is different — see below.

### Local dataset — English source, single language

```sh
grep -m1 '"s":"Cancel"' dataset/by-language/en-fr.jsonl
```

### Local dataset — English source, multiple languages

One grep per string, all languages in one shot:

```sh
grep -m1 '"s":"Cancel"' dataset/index.jsonl
```

Read the `translations` array and extract the languages the user asked for. Ignore the rest.

### Local dataset — non-English source

If the user's app source language is not English (e.g. their strings are in French and they need Spanish and German):

1. Find the string in the appropriate by-language file, matching on `t` (the translation), not `s`:
```sh
grep -m1 '"t":"Annuler"' dataset/by-language/en-fr.jsonl
```

2. Extract the `g` (group key) from that record.

3. Use the group key to pull all translations from `index.jsonl`:
```sh
grep -m1 '"g":"<group-key>"' dataset/index.jsonl
```

4. Extract the target languages from the `translations` array. English is just an intermediate — don't show it to the user unless they asked for it.

If multiple hits exist for the same string (same text in different bundles), prefer UIKit, Foundation, or AppKit — those are the most universal.

### API (local or live)

Use `match=exact` for short UI labels, `match=fuzzy` for partial matches. Pass all target languages in one request:

```sh
curl -s "https://applelocalization.com/api/ios/26/search/advanced?c=key&o=equal&q=Cancel&l=French&l=German&l=Japanese&size=10"
```

Swap the base URL for a local server. Same bundle preference applies. The API is English-source only — for non-English source strings, use the local dataset approach above.

## Step 6 — Translate the "translate yourself" strings

Translate these yourself. Be idiomatic — concise and friendly, the register Apple uses. Avoid literal translations that sound unnatural.

For formal/informal register distinctions: use "vous" in French, "Sie" in German, です/ます in Japanese (avoid overly formal keigo). Don't translate brand names or technical identifiers.

## Step 7 — Write results back or present as table

**If a file was provided:**

For `.xcstrings`: write translations back into the same file. For each translated key and language, set:
```json
"<lang>": { "stringUnit": { "state": "translated", "value": "<translation>" } }
```
Preserve all existing content — only add or update entries for the languages requested.

For `.strings`: write or update `<lang>.lproj/Localizable.strings` alongside the source file, one `"key" = "value";` line per string.

After writing, show a summary of what changed (N strings translated across M languages, X from Apple data, Y generated).

**If strings were provided inline:**

Format as a table: source string, language, translation, source (Apple/Generated).

| String | Language | Translation | Source |
|---|---|---|---|
| Cancel | French | Annuler | Apple (UIKit) |
| Cancel | German | Abbrechen | Apple (UIKit) |
| Welcome to MyApp | French | Bienvenue dans MyApp | Generated |

In either case, list any generated strings at the end and recommend the user review them for accuracy.
