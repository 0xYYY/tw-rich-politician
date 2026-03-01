#!/usr/bin/env node

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const BASE_URL = "https://priso.cy.gov.tw";
const QUERY_URL = `${BASE_URL}/api/Query/QueryData`;
const FILE_URL = `${BASE_URL}/api/Query/getFile`;
const OUTPUT_DIR = path.resolve(import.meta.dirname, "../data");
const PEOPLE_MAP_PATH = path.resolve(import.meta.dirname, "../data/people-mapping.json");
const PAGE_SIZE = 20;
const CONCURRENCY = 10;
const DELAY_MS = 200;

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/plain, */*",
  Origin: BASE_URL,
  Referer: `${BASE_URL}/layout/baselist`,
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formatTime(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m${s}s`;
}

const progress = {
  processed: 0,
  downloaded: 0,
  skipped: 0,
  failed: 0,
  totalBytes: 0,
  totalExpected: 0,
  startTime: Date.now(),
  update(status, filename, bytes = 0) {
    this.processed++;
    if (status === "ok") { this.downloaded++; this.totalBytes += bytes; }
    else if (status === "skip") this.skipped++;
    else if (status === "fail") this.failed++;

    const elapsed = (Date.now() - this.startTime) / 1000;
    const mb = (this.totalBytes / 1024 / 1024).toFixed(1);
    const tag = status === "ok" ? "OK" : status === "skip" ? "SKIP" : "FAIL";

    let eta = "";
    if (this.totalExpected > 0 && this.processed > 0) {
      const rate = elapsed / this.processed;
      const remaining = (this.totalExpected - this.processed) * rate;
      eta = `ETA: ${formatTime(remaining)}  `;
    }

    const pct = this.totalExpected > 0
      ? `${Math.round((this.processed / this.totalExpected) * 100)}%`
      : "?%";

    process.stdout.write(
      `\r[${formatTime(elapsed)}] ${pct} ${tag} ${filename.padEnd(45)} | ` +
      `DL: ${this.downloaded}  Skip: ${this.skipped}  Fail: ${this.failed}  ${eta}(${mb} MB)  `
    );
  },
  summary() {
    const elapsed = (Date.now() - this.startTime) / 1000;
    const mb = (this.totalBytes / 1024 / 1024).toFixed(1);
    console.log(`\n\nDone in ${formatTime(elapsed)} — ${this.downloaded} downloaded, ${this.skipped} skipped, ${this.failed} failed (${mb} MB total)`);
  },
};

async function queryPage(pageNo, searchValue) {
  const res = await fetch(QUERY_URL, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      Data: { Type: "title", Value: searchValue },
      Page: { PageNo: pageNo, PageSize: PAGE_SIZE, OrderByNum: 0, OrderBySort: "" },
    }),
  });
  if (!res.ok) throw new Error(`QueryData failed (page ${pageNo}): ${res.status}`);
  const json = await res.json();
  if (!json.Success) throw new Error(`QueryData error: ${json.Message}`);
  return json.Data;
}

function getSubdir(publishType) {
  if (publishType.includes("更補正")) return "correction";
  if (publishType.includes("變動")) return "change";
  if (publishType.includes("信託")) return "trust";
  return "ordinary";
}

function publishTypeKey(publishType) {
  const m = String(publishType || "").match(/^(\d{2})/);
  return m ? m[1] : String(publishType || "").trim();
}

async function downloadRecord(record) {
  const subdir = getSubdir(record.PublishType);
  const dir = path.join(OUTPUT_DIR, record.Name, subdir);
  const filename = `${record.Period}-${record.PublishType}`;
  const pdfPath = path.join(dir, `${filename}.pdf`);
  const jsonPath = path.join(dir, `${filename}.json`);
  const label = `${record.Name}/${subdir}/${filename}`;

  await mkdir(dir, { recursive: true });

  if (existsSync(pdfPath)) {
    if (!existsSync(jsonPath)) {
      await writeFile(jsonPath, JSON.stringify(record, null, 2));
    }
    progress.update("skip", label);
    return;
  }

  try {
    const res = await fetch(FILE_URL, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ From: "base", FileId: record.Id }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(pdfPath, buf);
    await writeFile(jsonPath, JSON.stringify(record, null, 2));
    progress.update("ok", label, buf.length);
  } catch (err) {
    progress.update("fail", label);
    console.error(`\n  ERROR ${label}: ${err.message}`);
  }
}

const YEAR_PREFIXES = ["民國114年", "民國113年"];

function filterAndCheck(records) {
  const matching = [];
  let seenOlder = false;
  for (const r of records) {
    if (YEAR_PREFIXES.some(p => r.PublishDate.startsWith(p))) {
      matching.push(r);
    } else {
      seenOlder = true;
    }
  }
  return { matching, seenOlder };
}

// For each person + publishType (01/02/04/09/...), keep only the latest record.
// This keeps all filing kinds while removing older duplicates.
function dedup(records) {
  const byKey = new Map();
  for (const r of records) {
    const key = `${r.Name}__${publishTypeKey(r.PublishType)}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, r);
      continue;
    }
    const a = Number(String(existing.Period || "").replace(/[^\d]/g, "")) || 0;
    const b = Number(String(r.Period || "").replace(/[^\d]/g, "")) || 0;
    if (b > a) {
      byKey.set(key, r);
    }
  }
  return [...byKey.values()];
}

async function collectAllRecords(searchValue, titleFilter, allowedNames) {
  const allRecords = [];
  for (let page = 1; ; page++) {
    if (page > 1) await sleep(DELAY_MS);
    process.stdout.write(`\rFetching ${searchValue} page ${page}...`);
    const result = await queryPage(page, searchValue);
    let pageRecords = result.Data;

    if (titleFilter) pageRecords = pageRecords.filter(r => titleFilter(r));
    if (allowedNames) pageRecords = pageRecords.filter(r => allowedNames.has(r.Name));

    const { matching, seenOlder } = filterAndCheck(pageRecords);
    allRecords.push(...matching);
    if (seenOlder || result.Data.length < PAGE_SIZE) break;
  }
  process.stdout.write("\r" + " ".repeat(60) + "\r");
  return allRecords;
}

async function downloadAll(records) {
  let active = 0;
  let idx = 0;

  return new Promise((resolve, reject) => {
    function next() {
      while (active < CONCURRENCY && idx < records.length) {
        const record = records[idx++];
        active++;
        downloadRecord(record)
          .then(() => { active--; next(); })
          .catch(reject);
      }
      if (active === 0 && idx >= records.length) resolve();
    }
    next();
  });
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const peopleMap = JSON.parse(await readFile(PEOPLE_MAP_PATH, "utf8"));
  const legislatorNames = new Set(
    Object.entries(peopleMap)
      .filter(([, info]) => info.type === "legislator")
      .map(([name]) => name),
  );
  const mayorNames = new Set(
    Object.entries(peopleMap)
      .filter(([, info]) => info.type === "mayor")
      .map(([name]) => name),
  );

  // Fetch legislators
  console.log(`Fetching 立法委員 records for ${YEAR_PREFIXES.join(" + ")}...`);
  const legislatorRecords = await collectAllRecords(
    "立法委員",
    (r) => r.Title === "立法委員",
    legislatorNames,
  );
  console.log(`  Found ${legislatorRecords.length} raw legislator records`);

  // Fetch mayors (市長 only, not 副市長)
  console.log(`Fetching 市長 records for ${YEAR_PREFIXES.join(" + ")}...`);
  const mayorRecords = await collectAllRecords(
    "市長",
    (r) => r.Title === "市長",
    mayorNames,
  );
  console.log(`  Found ${mayorRecords.length} raw mayor records (filtered out 副市長)`);

  // Combine and dedup
  const allRaw = [...legislatorRecords, ...mayorRecords];
  const records = dedup(allRaw);
  const dropped = allRaw.length - records.length;
  progress.totalExpected = records.length;
  console.log(`\nTotal: ${allRaw.length} raw → ${records.length} after dedup (dropped ${dropped} older duplicates)\n`);

  if (records.length > 0) await downloadAll(records);

  progress.summary();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
