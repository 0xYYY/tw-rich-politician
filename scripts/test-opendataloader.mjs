#!/usr/bin/env node

import { convert } from "@opendataloader/pdf";
import { readdir } from "node:fs/promises";
import path from "node:path";

const PDF_PATH = path.resolve(import.meta.dirname, "../data/丁學忠/262-01一般申報.pdf");
const OUT_DIR = path.resolve(import.meta.dirname, "../data/丁學忠/opendataloader-out");

console.log(`Extracting: ${PDF_PATH}`);
const startTime = Date.now();

const output = await convert(PDF_PATH, {
  format: "json",
  outputDir: OUT_DIR,
});

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`Done in ${elapsed}s`);
console.log(`Return value: "${output}"`);

const files = await readdir(OUT_DIR).catch(() => []);
console.log(`Output files:`, files);
