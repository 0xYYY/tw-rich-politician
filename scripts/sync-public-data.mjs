#!/usr/bin/env node

import { readdir, mkdir, rm, copyFile, stat } from "node:fs/promises";
import path from "node:path";

const SRC_DIR = path.resolve(import.meta.dirname, "../data");
const DST_DIR = path.resolve(import.meta.dirname, "../public/data");

async function copyDir(src, dst) {
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    // Skip hidden/internal folders (e.g. .DS_Store, _backup-*, .tmp-extract)
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;

    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);

    if (entry.isDirectory()) {
      await copyDir(srcPath, dstPath);
      continue;
    }

    if (entry.isFile()) {
      await mkdir(path.dirname(dstPath), { recursive: true });
      await copyFile(srcPath, dstPath);
    }
  }
}

async function main() {
  const srcStat = await stat(SRC_DIR).catch(() => null);
  if (!srcStat?.isDirectory()) {
    throw new Error(`Missing data directory: ${SRC_DIR}`);
  }

  await rm(DST_DIR, { recursive: true, force: true });
  await copyDir(SRC_DIR, DST_DIR);

  console.log(`Synced data assets to: ${DST_DIR}`);
}

main().catch((err) => {
  console.error("[sync-public-data]", err.message);
  process.exit(1);
});
