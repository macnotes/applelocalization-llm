#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-run --allow-env

// Exports LLM-ready datasets from applelocalization-tools data files.
//
// By default exports only the latest version of each platform.
// Use --all-versions to export everything.
//
// Outputs:
//   <out>/manifest.json              - index of platforms, versions, languages, record counts
//   <out>/index.jsonl                - one record per unique string with ALL translations grouped
//   <out>/by-language/en-fr.jsonl    - flat bilingual pairs, one file per target language
//
// The group key (g) in by-language records links to the same string in index.jsonl,
// enabling multi-language lookup and non-English source lookups.
//
// Usage:
//   deno run --allow-read --allow-write --allow-net --allow-run scripts/export-llm-dataset.ts \
//     --data ../applelocalization-tools/data \
//     --out dataset [--platform ios|macos] [--languages fr,ja,de,ko,es] [--all-versions]

import { parse } from "https://deno.land/std@0.224.0/flags/mod.ts";
import { walk } from "https://deno.land/std@0.224.0/fs/walk.ts";
import { ensureDir } from "https://deno.land/std@0.224.0/fs/ensure_dir.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

interface SourceFile {
  bundlePath: string;
  framework: string;
  loctablePath: string;
  localizations: Record<string, { language: string; target: string; filename: string }[]>;
}

// by-language record: language is in the filename
interface LangRecord {
  g: string;    // group key (bundlePath:localizationKey) — links to index.jsonl
  k?: string;   // localization key — omitted when identical to s
  s: string;    // source (English)
  t: string;    // target
  p: string;    // platform
  v: string;    // version
  b: string;    // bundle path
}

// index record: one per unique string, all translations grouped
interface IndexRecord {
  g: string;                          // group key
  s: string;                          // source (English, or key if no English translation)
  p: string;                          // platform
  v: string;                          // version
  b: string;                          // bundle path
  translations: { l: string; t: string }[];  // all languages (filtered to --languages if specified)
}

const CONCURRENCY = 32;
const FLUSH_THRESHOLD = 1000;

const args = parse(Deno.args, {
  string: ["data", "out", "platform", "languages"],
  boolean: ["all-versions"],
  default: {
    data: "../applelocalization-tools/data",
    out: "dataset",
    "all-versions": false,
  },
});

const dataDir = args.data;
const outDir = args.out;
const allVersions = args["all-versions"];
const platformFilter = args.platform as string | undefined;
const languageFilter = args.languages
  ? new Set(args.languages.split(",").map((l: string) => l.trim()))
  : null;

if (platformFilter && !["ios", "macos"].includes(platformFilter)) {
  console.error(`Unknown platform: ${platformFilter}. Use 'ios' or 'macos'.`);
  Deno.exit(1);
}

const STAMP_FILE = "applelocalization-tools.sha";

// Compares the local stamp file against the latest commit SHA on GitHub.
// Writes an updated stamp after a successful build (called at end of script).
async function checkDataFreshness(dataPath: string) {
  try {
    const gitDir = dataPath.endsWith("/data") ? dataPath.slice(0, -5) : dataPath;

    // Read local stamp (SHA we last built from)
    let localSha: string | null = null;
    try { localSha = (await Deno.readTextFile(STAMP_FILE)).trim(); } catch { /* no stamp yet */ }

    // Fetch latest commit SHA from GitHub API
    const res = await fetch(
      "https://api.github.com/repos/kishikawakatsumi/applelocalization-tools/commits?per_page=1",
      { headers: { "Accept": "application/vnd.github+json" } }
    ).catch(() => null);
    if (!res?.ok) return;

    const [latest] = await res.json();
    const remoteSha: string = latest.sha;
    const remoteDate = new Date(latest.commit.committer.date).toLocaleDateString();

    if (localSha === remoteSha) return; // up to date

    if (!localSha) {
      console.warn(`\nNote: no applelocalization-tools.sha stamp found — can't verify data freshness.`);
      console.warn(`  Latest remote commit: ${remoteSha.slice(0, 7)} (${remoteDate})`);
      console.warn(`  To update your data: git -C ${gitDir} pull`);
    } else {
      console.warn(`\nWarning: your applelocalization-tools data may be out of date.`);
      console.warn(`  Last built from: ${localSha.slice(0, 7)}`);
      console.warn(`  Latest remote:   ${remoteSha.slice(0, 7)} (${remoteDate})`);
      console.warn(`  To update: git -C ${gitDir} pull`);
    }

    const buf = new Uint8Array(1);
    Deno.stdout.writeSync(new TextEncoder().encode("\nContinue with current data? [y/N] "));
    Deno.stdin.readSync(buf);
    if (buf[0] !== 121 && buf[0] !== 89) {
      console.log("Aborted.");
      Deno.exit(0);
    }
    console.log("");
  } catch {
    // Staleness check is best-effort — never block the build
  }
}

async function writeStamp() {
  try {
    const res = await fetch(
      "https://api.github.com/repos/kishikawakatsumi/applelocalization-tools/commits?per_page=1",
      { headers: { "Accept": "application/vnd.github+json" } }
    ).catch(() => null);
    if (!res?.ok) return;
    const [latest] = await res.json();
    await Deno.writeTextFile(STAMP_FILE, latest.sha + "\n");
  } catch { /* best-effort */ }
}

async function resolveDataDirs(root: string): Promise<string[]> {
  const dirs: string[] = [];

  for await (const platformEntry of Deno.readDir(root)) {
    if (!platformEntry.isDirectory) continue;
    if (platformFilter && platformEntry.name !== platformFilter) continue;

    const platformPath = join(root, platformEntry.name);
    const versionEntries: { name: string; path: string }[] = [];

    for await (const versionEntry of Deno.readDir(platformPath)) {
      if (versionEntry.isDirectory) {
        versionEntries.push({ name: versionEntry.name, path: join(platformPath, versionEntry.name) });
      }
    }

    if (!versionEntries.length) continue;

    if (allVersions) {
      dirs.push(...versionEntries.map((e) => e.path));
    } else {
      const latest = versionEntries.sort((a, b) => {
        const av = a.name.split(".").map(Number);
        const bv = b.name.split(".").map(Number);
        for (let i = 0; i < Math.max(av.length, bv.length); i++) {
          const diff = (bv[i] ?? 0) - (av[i] ?? 0);
          if (diff !== 0) return diff;
        }
        return 0;
      })[0];
      dirs.push(latest.path);
      console.log(`Using ${platformEntry.name}/${latest.name} (latest)`);
    }
  }

  return dirs;
}

await ensureDir(join(outDir, "by-language"));
const indexPath = join(outDir, "index.jsonl");
await Deno.writeTextFile(indexPath, ""); // truncate on rerun

const encoder = new TextEncoder();
const buffers: Map<string, string[]> = new Map();
const handles: Map<string, Deno.FsFile> = new Map();
const indexBuf: string[] = [];

async function getHandle(path: string): Promise<Deno.FsFile> {
  if (!handles.has(path)) {
    handles.set(path, await Deno.open(path, { write: true, create: true, append: true }));
  }
  return handles.get(path)!;
}

function bufferLine(path: string, record: LangRecord) {
  if (!buffers.has(path)) buffers.set(path, []);
  buffers.get(path)!.push(JSON.stringify(record));
}

async function flushBuffer(path: string) {
  const lines = buffers.get(path);
  if (!lines?.length) return;
  const handle = await getHandle(path);
  await handle.write(encoder.encode(lines.join("\n") + "\n"));
  buffers.set(path, []);
}

async function maybeFlush(path: string) {
  if ((buffers.get(path)?.length ?? 0) >= FLUSH_THRESHOLD) await flushBuffer(path);
}

const platforms = new Set<string>();
const versions = new Set<string>();
const languages = new Set<string>();
const langCounts: Record<string, number> = {};
let totalRecords = 0;
let totalGroups = 0;

const absDataDir = await Deno.realPath(dataDir);
await checkDataFreshness(absDataDir);
const dataDirs = await resolveDataDirs(absDataDir);

// Truncate any existing JSONL output files so reruns are clean
for await (const entry of walk(outDir, { exts: [".jsonl"], includeDirs: false })) {
  await Deno.truncate(entry.path);
}

const filePaths: string[] = [];
for (const dir of dataDirs) {
  for await (const entry of walk(dir, { exts: [".json"], includeDirs: false })) {
    filePaths.push(entry.path);
  }
}
console.log(`Processing ${filePaths.length.toLocaleString()} source files...`);

function getPlatformVersion(filePath: string): { platform: string; version: string } {
  const rel = filePath.replace(absDataDir + "/", "");
  const parts = rel.split("/");
  return { platform: parts[0], version: parts[1] };
}

async function processFile(filePath: string) {
  const { platform, version } = getPlatformVersion(filePath);

  let file: SourceFile;
  try {
    file = JSON.parse(await Deno.readTextFile(filePath));
  } catch {
    console.error(`Skipping malformed file: ${filePath}`);
    return;
  }

  platforms.add(platform);
  versions.add(`${platform}@${version}`);

  const flushPaths = new Set<string>();

  for (const [key, translations] of Object.entries(file.localizations)) {
    const enEntry = translations.find((t) => t.language === "en");
    const source = enEntry ? enEntry.target : key;
    const groupKey = `${file.bundlePath}:${key}`;

    const nonEnTranslations = translations.filter((t) => t.language !== "en" &&
      (!languageFilter || languageFilter.has(t.language)));
    if (!nonEnTranslations.length) continue;

    // Write one index record per key with all translations grouped
    const indexRecord: IndexRecord = {
      g: groupKey,
      s: source,
      p: platform,
      v: version,
      b: file.bundlePath,
      translations: nonEnTranslations.map(({ language, target }) => ({ l: language, t: target })),
    };
    indexBuf.push(JSON.stringify(indexRecord));
    totalGroups++;

    for (const { language, target } of nonEnTranslations) {
      const keyField = key !== source ? { k: key } : {};
      const record: LangRecord = { g: groupKey, ...keyField, s: source, t: target, p: platform, v: version, b: file.bundlePath };
      const langFile = join(outDir, "by-language", `en-${language}.jsonl`);

      bufferLine(langFile, record);
      flushPaths.add(langFile);

      languages.add(language);
      langCounts[`en-${language}`] = (langCounts[`en-${language}`] ?? 0) + 1;
      totalRecords++;
    }
  }

  // Flush index buffer periodically to avoid memory buildup
  if (indexBuf.length >= FLUSH_THRESHOLD) {
    const indexHandle = await getHandle(indexPath);
    await indexHandle.write(encoder.encode(indexBuf.join("\n") + "\n"));
    indexBuf.length = 0;
  }

  await Promise.all([...flushPaths].map(maybeFlush));
}

let idx = 0;
async function worker() {
  while (idx < filePaths.length) {
    await processFile(filePaths[idx++]);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await Promise.all([...buffers.keys()].map(flushBuffer));

// Flush any remaining index records
if (indexBuf.length) {
  const indexHandle = await getHandle(indexPath);
  await indexHandle.write(encoder.encode(indexBuf.join("\n") + "\n"));
  indexBuf.length = 0;
}

for (const handle of handles.values()) handle.close();

const manifest = {
  generated: new Date().toISOString(),
  total_records: totalRecords,
  total_groups: totalGroups,
  platforms: [...platforms].sort(),
  versions: [...versions].sort(),
  languages: Object.entries(langCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([lang, count]) => ({ lang, count })),
};

await Deno.writeTextFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

await writeStamp();

console.log(`Done. ${totalRecords.toLocaleString()} records written to ${outDir}/`);
console.log(`  ${languages.size} language files in by-language/`);
console.log(`  index.jsonl with ${totalGroups.toLocaleString()} groups`);
