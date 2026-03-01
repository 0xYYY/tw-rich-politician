#!/usr/bin/env node

import { writeFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
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
    if (status === "ok") {
      this.downloaded++;
      this.totalBytes += bytes;
    } else if (status === "skip") this.skipped++;
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

    const pct =
      this.totalExpected > 0 ? `${Math.round((this.processed / this.totalExpected) * 100)}%` : "?%";

    process.stdout.write(
      `\r[${formatTime(elapsed)}] ${pct} ${tag} ${filename.padEnd(45)} | ` +
        `DL: ${this.downloaded}  Skip: ${this.skipped}  Fail: ${this.failed}  ${eta}(${mb} MB)  `,
    );
  },
  summary() {
    const elapsed = (Date.now() - this.startTime) / 1000;
    const mb = (this.totalBytes / 1024 / 1024).toFixed(1);
    console.log(
      `\n\nDone in ${formatTime(elapsed)} — ${this.downloaded} downloaded, ${this.skipped} skipped, ${this.failed} failed (${mb} MB total)`,
    );
  },
};

async function queryPage(pageNo, searchValue, searchType = "title") {
  const res = await fetch(QUERY_URL, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      Data: { Type: searchType, Value: searchValue },
      Page: { PageNo: pageNo, PageSize: PAGE_SIZE, OrderByNum: 0, OrderBySort: "" },
    }),
  });
  if (!res.ok) throw new Error(`QueryData failed (page ${pageNo}): ${res.status}`);
  const json = await res.json();
  if (!json.Success) throw new Error(`QueryData error: ${json.Message}`);
  return json.Data;
}

function publishTypeKey(publishType) {
  const m = String(publishType || "").match(/^(\d{2})/);
  return m ? m[1] : "00";
}

function rocYearFromPublishDate(publishDate) {
  const m = String(publishDate || "").match(/民國\s*(\d+)年/);
  return m ? Number(m[1]) : null;
}

function rocDateCompact(publishDate) {
  const m = String(publishDate || "").match(/民國\s*(\d+)年\s*(\d+)月\s*(\d+)日/);
  if (!m) return "";
  const y = m[1].padStart(3, "0");
  const mm = m[2].padStart(2, "0");
  const dd = m[3].padStart(2, "0");
  return `${y}${mm}${dd}`;
}

function filingDirName(record) {
  const disclosureCode = publishTypeKey(record.PublishType);
  if (disclosureCode !== "11") return disclosureCode;

  // Keep multiple 11 filings in the same year as separate records.
  const dateKey = rocDateCompact(record.PublishDate) || "unknown-date";
  const idKey = String(record.Id || "").replace(/[^\dA-Za-z_-]/g, "") || "unknown-id";
  return `${disclosureCode}-${dateKey}-${idKey}`;
}

async function downloadRecord(record) {
  const disclosureCode = publishTypeKey(record.PublishType);
  const filingKey = filingDirName(record);
  const dir = path.join(OUTPUT_DIR, record.Name, filingKey);
  const pdfPath = path.join(dir, "original.pdf");
  const jsonPath = path.join(dir, "metadata.json");
  const label = `${record.Name}/${filingKey}/${record.Period}-${record.PublishType}`;

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

function normalizeComparableName(name) {
  return String(name || "")
    .replace(/^\d+\s*[-－]\s*/, "")
    .replace(/[\s\u3000]/g, "")
    .replace(/台/g, "臺")
    .replace(/啓/g, "啟");
}

async function listPeopleWithLocalData() {
  const covered = new Set();
  let entries = [];
  try {
    entries = await readdir(OUTPUT_DIR, { withFileTypes: true });
  } catch {
    return covered;
  }

  for (const person of entries) {
    if (!person.isDirectory()) continue;
    if (person.name.startsWith(".") || person.name.startsWith("_")) continue;

    const personDir = path.join(OUTPUT_DIR, person.name);
    let filings = [];
    try {
      filings = await readdir(personDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const filing of filings) {
      if (!filing.isDirectory()) continue;
      if (!/^\d{2}(?:-.+)?$/.test(filing.name)) continue;
      const pdfPath = path.join(personDir, filing.name, "original.pdf");
      try {
        const s = await stat(pdfPath);
        if (s.isFile()) {
          covered.add(normalizeComparableName(person.name));
          break;
        }
      } catch {
        // ignore
      }
    }
  }
  return covered;
}

function filterAndCheck(records) {
  const matching = [];
  let seenOlder = false;
  for (const r of records) {
    if (YEAR_PREFIXES.some((p) => r.PublishDate.startsWith(p))) {
      matching.push(r);
    } else {
      seenOlder = true;
    }
  }
  return { matching, seenOlder };
}

function periodNum(period) {
  return Number(String(period || "").replace(/[^\d]/g, "")) || 0;
}

function isNewerRecord(a, b) {
  // Return true when b is newer than a.
  const pa = periodNum(a?.Period);
  const pb = periodNum(b?.Period);
  if (pb !== pa) return pb > pa;

  const ya = rocYearFromPublishDate(a?.PublishDate) || 0;
  const yb = rocYearFromPublishDate(b?.PublishDate) || 0;
  if (yb !== ya) return yb > ya;

  const da = rocDateCompact(a?.PublishDate);
  const db = rocDateCompact(b?.PublishDate);
  if (db !== da) return db > da;

  return Number(b?.Id || 0) > Number(a?.Id || 0);
}

// Keep the latest record for most filing types.
// Special rule for "11新增信託申報":
// - keep only the latest available ROC year per person
// - keep all distinct records in that year as separate filings
function dedup(records) {
  const byKey = new Map();
  const trust11ByPerson = new Map();

  for (const r of records) {
    const code = publishTypeKey(r.PublishType);
    if (code === "11") {
      const person = r.Name;
      const year = rocYearFromPublishDate(r.PublishDate) || 0;
      const state = trust11ByPerson.get(person);

      if (!state || year > state.year) {
        trust11ByPerson.set(person, { year, records: [r] });
        continue;
      }
      if (year === state.year) {
        state.records.push(r);
      }
      continue;
    }

    const key = `${r.Name}__${code}`;
    const existing = byKey.get(key);
    if (!existing || isNewerRecord(existing, r)) byKey.set(key, r);
  }

  const trust11Records = [];
  for (const { records: sameYearRecords } of trust11ByPerson.values()) {
    const unique = new Map();
    for (const r of sameYearRecords) {
      const uniqueKey =
        Number(r.Id || 0) > 0
          ? `id:${r.Id}`
          : `${r.Name}|${r.PublishType}|${r.PublishDate}|${r.Period || ""}`;
      if (!unique.has(uniqueKey)) unique.set(uniqueKey, r);
    }
    trust11Records.push(...unique.values());
  }

  return [...byKey.values(), ...trust11Records];
}

async function collectAllRecords(searchValue, titleFilter, allowedNamesNorm, searchType = "title") {
  const allRecords = [];
  for (let page = 1; ; page++) {
    if (page > 1) await sleep(DELAY_MS);
    process.stdout.write(`\rFetching [${searchType || "all"}] ${searchValue} page ${page}...`);
    const result = await queryPage(page, searchValue, searchType);
    let pageRecords = result.Data;

    if (titleFilter) pageRecords = pageRecords.filter((r) => titleFilter(r));
    if (allowedNamesNorm)
      pageRecords = pageRecords.filter((r) =>
        allowedNamesNorm.has(normalizeComparableName(r.Name)),
      );

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
          .then(() => {
            active--;
            next();
          })
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
  const mappedNames = Object.keys(peopleMap);
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
  const legislatorNamesNorm = new Set([...legislatorNames].map(normalizeComparableName));
  const mayorNamesNorm = new Set([...mayorNames].map(normalizeComparableName));

  // Fetch legislators
  console.log(`Fetching 立法委員 records for ${YEAR_PREFIXES.join(" + ")}...`);
  const legislatorRecords = await collectAllRecords(
    "立法委員",
    (r) => r.Title === "立法委員",
    legislatorNamesNorm,
  );
  console.log(`  Found ${legislatorRecords.length} raw legislator records`);

  // Fetch mayors (市長 only, not 副市長)
  console.log(`Fetching 市長 records for ${YEAR_PREFIXES.join(" + ")}...`);
  const mayorRecords = await collectAllRecords("市長", (r) => r.Title === "市長", mayorNamesNorm);
  console.log(`  Found ${mayorRecords.length} raw mayor records (filtered out 副市長)`);

  const initialRaw = [...legislatorRecords, ...mayorRecords];
  const namesSeenByTitle = new Set(initialRaw.map((r) => normalizeComparableName(r.Name)));
  const locallyCoveredBeforeFallback = await listPeopleWithLocalData();
  const missingNames = mappedNames.filter(
    (name) => !locallyCoveredBeforeFallback.has(normalizeComparableName(name)),
  );
  const fallbackTargets = missingNames.filter(
    (name) => !namesSeenByTitle.has(normalizeComparableName(name)),
  );

  const fallbackRecords = [];
  if (fallbackTargets.length > 0) {
    console.log(
      `\nMissing in local data (people-mapping): ${missingNames.length}. ` +
        `Trying direct name search for ${fallbackTargets.length} people...`,
    );

    for (const name of fallbackTargets) {
      const info = peopleMap[name];
      const titleFilter =
        info?.type === "legislator"
          ? (r) => /立法委員|院長|副院長/.test(String(r.Title || ""))
          : info?.type === "mayor"
            ? (r) => /市長|縣長/.test(String(r.Title || ""))
            : null;

      const direct = await collectAllRecords(
        name,
        titleFilter,
        new Set([normalizeComparableName(name)]),
        "",
      );
      if (direct.length > 0) fallbackRecords.push(...direct);
      console.log(`  ${name}: ${direct.length > 0 ? `found ${direct.length}` : "not found"}`);
    }
  } else {
    console.log("\nNo missing people requiring direct-name fallback search.");
  }

  // Combine and dedup
  const allRaw = [...initialRaw, ...fallbackRecords];
  const records = dedup(allRaw);
  const dropped = allRaw.length - records.length;
  progress.totalExpected = records.length;
  console.log(
    `\nTotal: ${allRaw.length} raw (title + direct fallback) → ` +
      `${records.length} after dedup (dropped ${dropped})\n`,
  );

  if (records.length > 0) await downloadAll(records);

  progress.summary();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
