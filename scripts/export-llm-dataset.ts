#!/usr/bin/env -S deno run --allow-read --allow-write

// Exports LLM-ready datasets from applelocalization-tools data files.
//
// By default exports only the latest version of each platform.
// Use --all-versions to export everything.
//
// Outputs:
//   <out>/manifest.json              - index of all platforms, versions, languages, bundles
//   <out>/by-language/en-fr.jsonl    - flat bilingual pairs {key, source, target, language, platform, version, bundle}
//   <out>/by-bundle/<framework>.jsonl - all languages for a single framework
//
// Usage:
//   deno run --allow-read --allow-write scripts/export-llm-dataset.ts \
//     --data ../applelocalization-tools/data \
//     --out dataset [--all-versions]

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

// by-language record: language is in the filename, bundle is in the filename for by-bundle
interface LangRecord {
  k?: string;  // key — omitted when identical to s
  s: string;   // source (English)
  t: string;   // target
  p: string;   // platform
  v: string;   // version
  b: string;   // bundle path
}

interface BundleRecord {
  k?: string;  // key — omitted when identical to s
  s: string;   // source (English)
  t: string;   // target
  l: string;   // language
  p: string;   // platform
  v: string;   // version
}

const CONCURRENCY = 32;
const FLUSH_THRESHOLD = 1000;

const args = parse(Deno.args, {
  string: ["data", "out"],
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

async function resolveDataDirs(root: string): Promise<string[]> {
  const dirs: string[] = [];

  for await (const platformEntry of Deno.readDir(root)) {
    if (!platformEntry.isDirectory) continue;
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
await ensureDir(join(outDir, "by-bundle"));

const encoder = new TextEncoder();
const buffers: Map<string, string[]> = new Map();
const handles: Map<string, Deno.FsFile> = new Map();

async function getHandle(path: string): Promise<Deno.FsFile> {
  if (!handles.has(path)) {
    handles.set(path, await Deno.open(path, { write: true, create: true, append: true }));
  }
  return handles.get(path)!;
}

function bufferLine(path: string, record: LangRecord | BundleRecord) {
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
const bundles = new Set<string>();
const langCounts: Record<string, number> = {};
const bundleCounts: Record<string, number> = {};
let totalRecords = 0;

const absDataDir = await Deno.realPath(dataDir);
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

  const frameworkSlug = file.framework.replace(/[^a-zA-Z0-9._-]/g, "_");
  const bundleFile = join(outDir, "by-bundle", `${frameworkSlug}.jsonl`);

  platforms.add(platform);
  versions.add(`${platform}@${version}`);
  bundles.add(file.framework);

  const flushPaths = new Set<string>([bundleFile]);

  for (const [key, translations] of Object.entries(file.localizations)) {
    const enEntry = translations.find((t) => t.language === "en");
    const source = enEntry ? enEntry.target : key;

    for (const { language, target } of translations) {
      if (language === "en") continue;

      const keyField = key !== source ? { k: key } : {};
      const langRecord: LangRecord = { ...keyField, s: source, t: target, p: platform, v: version, b: file.bundlePath };
      const bundleRecord: BundleRecord = { ...keyField, s: source, t: target, l: language, p: platform, v: version };
      const langFile = join(outDir, "by-language", `en-${language}.jsonl`);

      bufferLine(langFile, langRecord);
      bufferLine(bundleFile, bundleRecord);
      flushPaths.add(langFile);

      languages.add(language);
      langCounts[`en-${language}`] = (langCounts[`en-${language}`] ?? 0) + 1;
      bundleCounts[frameworkSlug] = (bundleCounts[frameworkSlug] ?? 0) + 1;
      totalRecords++;
    }
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
for (const handle of handles.values()) handle.close();

const manifest = {
  generated: new Date().toISOString(),
  total_records: totalRecords,
  platforms: [...platforms].sort(),
  versions: [...versions].sort(),
  languages: Object.entries(langCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([lang, count]) => ({ lang, count })),
  bundles: Object.entries(bundleCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([bundle, count]) => ({ bundle, count })),
};

await Deno.writeTextFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

console.log(`Done. ${totalRecords.toLocaleString()} pair records written to ${outDir}/`);
console.log(`  ${languages.size} language files in by-language/`);
console.log(`  ${bundles.size} bundle files in by-bundle/`);
