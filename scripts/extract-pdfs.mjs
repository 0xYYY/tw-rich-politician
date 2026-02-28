#!/usr/bin/env node

import { convert } from "@opendataloader/pdf";
import { readFile, writeFile, readdir, stat, mkdir, rm, symlink } from "fs/promises";
import path from "node:path";

const DATA_DIR = path.resolve(import.meta.dirname, "../data");
const TEMP_DIR = path.resolve(import.meta.dirname, "../.tmp-extract");

// ── Helpers ──

function cellText(cell) {
  return (cell.kids || [])
    .filter((k) => k.content)
    .map((k) => k.content)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function norm(s) {
  return s.replace(/[\s\u3000]/g, "");
}

function parseNumber(str) {
  if (!str) return 0;
  return parseInt(str.replace(/[,\s]/g, ""), 10) || 0;
}

function mojibakeScore(s) {
  if (!s) return 0;
  const latinNoise = (s.match(/[À-ÿ]/g) || []).length;
  const replacement = (s.match(/�/g) || []).length;
  return latinNoise + replacement * 3;
}

function maybeFixMojibake(s) {
  if (!s || typeof s !== "string") return s;
  if (!/[À-ÿ]/.test(s)) return s;

  const fixed = Buffer.from(s, "latin1").toString("utf8");
  if (!fixed || fixed.includes("�")) return s;

  const before = mojibakeScore(s);
  const after = mojibakeScore(fixed);
  const hasCjkAfter = /[\u4e00-\u9fff]/.test(fixed);

  if ((hasCjkAfter && after < before) || after + 2 < before) return fixed;
  return s;
}

function fixMojibakeDeep(value) {
  if (typeof value === "string") return maybeFixMojibake(value);
  if (Array.isArray(value)) return value.map((v) => fixMojibakeDeep(v));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = fixMojibakeDeep(v);
    return out;
  }
  return value;
}

function extractTotal(text) {
  const m = text.match(/新臺幣\s*([\d,]+)\s*元/);
  return m ? parseNumber(m[1]) : 0;
}

// ── Document tree traversal ──

function buildIdMap(kids) {
  const map = new Map();
  (function walk(nodes) {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes) {
      if (n.id !== undefined) map.set(n.id, n);
      if (Array.isArray(n.kids)) walk(n.kids);
      if (n.rows)
        for (const r of n.rows)
          if (r.cells) for (const c of r.cells) if (Array.isArray(c.kids)) walk(c.kids);
      if (n["list items"])
        for (const li of n["list items"]) {
          if (li.id !== undefined) map.set(li.id, li);
          if (Array.isArray(li.kids)) walk(li.kids);
        }
    }
  })(kids);
  return map;
}

function getChainedRows(table, idMap) {
  const rows = [];
  let t = table;
  const seen = new Set();
  while (t && !seen.has(t.id)) {
    seen.add(t.id);
    for (const row of t.rows || []) rows.push(row.cells.map((c) => cellText(c)));
    t = t["next table id"] !== undefined ? idMap.get(t["next table id"]) : null;
  }
  return rows;
}

function collectTables(kids) {
  const tables = [];
  (function walk(nodes) {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes) {
      if (n.type === "table") tables.push(n);
      if (Array.isArray(n.kids)) walk(n.kids);
      if (n["list items"])
        for (const li of n["list items"]) if (Array.isArray(li.kids)) walk(li.kids);
    }
  })(kids);
  return tables;
}

// ── Collect section totals from captions/paragraphs ──

function collectSectionTotals(kids) {
  const totals = {};
  (function walk(nodes) {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes) {
      if (n.content) {
        const t = norm(n.content);
        const m = t.match(/[（(]([\u4e00-\u9fff]+)[）)]/);
        if (m) totals[m[1]] = extractTotal(n.content);
        if (t.includes("1.股票")) totals._stock = extractTotal(n.content);
      }
      if (Array.isArray(n.kids)) walk(n.kids);
      if (n["list items"])
        for (const li of n["list items"]) {
          if (li.content) {
            const t = norm(li.content);
            if (t.includes("1.股票")) totals._stock = extractTotal(li.content);
          }
          if (Array.isArray(li.kids)) walk(li.kids);
        }
    }
  })(kids);
  return totals;
}

// ── Table identification by header content ──

function identifyTable(table) {
  if (!table.rows?.length) return null;
  const cells = table.rows[0].cells.map((c) => norm(cellText(c)));

  if (cells.some((c) => c.includes("申報人姓名"))) return "header";
  if (cells.some((c) => c.includes("土地坐落"))) return "land";
  if (cells.some((c) => c.includes("建物標示"))) return "building";
  if (cells.some((c) => c.includes("廠牌"))) return "vehicle";
  // Deposits: "存放機構" + "種類" + "幣別" (distinguish from crypto table which also has 存放機構)
  if (cells.some((c) => c.includes("存放機構")) && cells.some((c) => c.includes("幣別"))) return "deposit";
  if (cells.some((c) => c.includes("股數"))) return "stock";
  if (cells.some((c) => c.includes("投資事業") || c.includes("投資金額"))) return "investment";
  // Credits (十): 種類 | 債權人 | 債務人及地址 | ...
  if (cells[0]?.includes("種類") && cells[1]?.includes("債權人")) return "credit";
  // Debts (十一): 種類 | 債務人 | 債權人及地址 | ...
  if (cells[0]?.includes("種類") && cells[1]?.includes("債務人")) return "debt";
  // Fund/信託基金: 名稱 | 所有人 | 受託投資機構 | 單位數 | 票面價額 | 外幣幣別 | 新臺幣總額
  if (cells.some((c) => c.includes("受託投資機構"))) return "fund";
  // Insurance/保險: 保險公司 | 保險名稱 | 保單號碼 | 要保人 | ...
  if (cells.some((c) => c.includes("保險公司"))) return "insurance";
  // Valuables/珠寶等: 財產種類 | 項/件 | 所有人 | 價額
  if (cells.some((c) => c.includes("財產種類"))) return "valuable";

  return null;
}

// ── Section parsers ──

function parseHeader(rows) {
  const info = { name: "", org: "", title: "", date: "", type: "" };

  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const n = norm(row[i]);

      if (n === "申報人姓名" && i + 1 < row.length) info.name = norm(row[i + 1]);

      // Org/title come as "1.立法院", "1.立法委員" after their label cells
      if (row[i].match(/^1\.\S/) && i > 0) {
        const prev = norm(row[i - 1]);
        const val = row[i].replace(/^1\./, "").trim();
        if (prev.includes("服務機關") && !info.org) info.org = val;
        else if (prev.includes("職稱") && !info.title) info.title = val;
        else if (!info.org) info.org = val; // fallback for first "1.X" without clear label
      }

      // Date: "113 年 11 月 01 日"
      const dateM = row[i].match(/(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日/);
      if (dateM && !info.date) {
        const prev = i > 0 ? norm(row[i - 1]) : "";
        if (prev.includes("申報日") || prev.includes("申報")) {
          info.date = `${dateM[1]}年${dateM[2].padStart(2, "0")}月${dateM[3].padStart(2, "0")}日`;
        }
      }

      // Type: "定期申報", "就(到)職申報", etc.
      if (n.includes("定期申報") || n.includes("就") || n.includes("卸")) {
        if (!info.type) info.type = n;
      }
    }
  }

  // Fallback: find org/title if not yet found (handle case where labels aren't immediately before values)
  for (const row of rows) {
    for (const cell of row) {
      if (!info.org && cell.match(/^1\./) && !norm(cell).includes("委員")) {
        info.org = cell.replace(/^1\./, "").trim();
      }
    }
  }

  return info;
}

function parseFamily(rows) {
  const family = [];
  for (const row of rows) {
    for (let i = 0; i < row.length - 1; i++) {
      const n = norm(row[i]);
      if ((n === "配偶" || n === "未成年子女") && row[i + 1]) {
        const name = norm(row[i + 1]);
        if (name && name.length >= 2 && name !== "姓名") family.push({ relation: n, name });
      }
    }
  }
  return family;
}

function mergeContRows(rows) {
  // Merge continuation rows (first cell empty) into the previous row
  const merged = [];
  for (const row of rows) {
    if (merged.length > 0 && !row[0]?.trim()) {
      const prev = merged[merged.length - 1];
      for (let j = 0; j < row.length; j++) {
        if (row[j]?.trim()) prev[j] = ((prev[j] || "") + " " + row[j]).trim();
      }
    } else {
      merged.push([...row]);
    }
  }
  return merged;
}

function parseLandOrBuilding(rows) {
  const items = [];
  const merged = mergeContRows(rows);
  // Skip header row (first row has labels like 土地坐落/建物標示)
  for (let i = 1; i < merged.length; i++) {
    const row = merged[i];
    if (row.length < 4) continue;
    if (norm(row.join("")).includes("本欄空白")) continue;
    if (norm(row[0]).includes("監察院公報")) continue;

    items.push({
      location: row[0] || "",
      area: parseFloat(row[1]?.replace(/[,\s]/g, "")) || 0,
      share: row[2] || "",
      owner: row[3] || "",
      date: row[4]?.replace(/\s/g, "") || "",
      reason: row[5] || "",
      price: row[6] || "",
    });
  }
  return items;
}

function parseVehicles(rows) {
  const items = [];
  const merged = mergeContRows(rows);
  for (let i = 1; i < merged.length; i++) {
    const row = merged[i];
    if (row.length < 4) continue;
    if (norm(row.join("")).includes("本欄空白")) continue;

    items.push({
      brand: row[0] || "",
      cc: parseNumber(row[1]),
      owner: row[2] || "",
      date: row[3]?.replace(/\s/g, "") || "",
      reason: row[4] || "",
      price: parseNumber(row[5]),
    });
  }
  return items;
}

function parseDeposits(rows) {
  const items = [];
  const merged = mergeContRows(rows);
  for (let i = 1; i < merged.length; i++) {
    const row = merged[i];
    if (row.length < 4) continue;
    if (norm(row.join("")).includes("本欄空白")) continue;

    // 一般: 存放機構, 種類, 幣別, 所有人, 外幣總額, 新臺幣總額
    items.push({
      institution: row[0] || "",
      type: row[1] || "",
      currency: row[2] || "新臺幣",
      owner: row[3] || "",
      foreignAmount: parseNumber(row[4]),
      amount: parseNumber(row[row.length - 1]),
    });
  }
  return items;
}

function parseStocks(rows) {
  const items = [];
  if (!rows.length) return items;

  // Detect format: 一般申報 has 5 cols, 變動申報 has 8 cols
  const headerCells = rows[0].map((c) => norm(c));
  const isChange = headerCells.some((c) => c.includes("證券交易商"));

  const merged = mergeContRows(rows);
  for (let i = 1; i < merged.length; i++) {
    const row = merged[i];
    if (row.length < 4) continue;
    if (norm(row.join("")).includes("本欄空白")) continue;

    if (isChange) {
      // 變動: 名稱, 證券交易商名稱, 所有人, 股數, 變動時之價額, 變動時間, 變動原因, 總額
      items.push({
        name: row[0] || "",
        broker: row[1] || "",
        owner: row[2] || "",
        shares: parseNumber(row[3]),
        pricePerShare: row[4] || "",
        changeDate: row[5]?.replace(/\s/g, "") || "",
        changeReason: row[6] || "",
        totalValue: parseNumber(row[row.length - 1]),
      });
    } else {
      // 一般: 名稱, 所有人, 股數, 票面價額, 外幣幣別, 新臺幣總額
      items.push({
        name: row[0] || "",
        owner: row[1] || "",
        shares: parseNumber(row[2]),
        faceValue: parseNumber(row[3]),
        foreignCurrency: row[4] || "",
        totalValue: parseNumber(row[row.length - 1]),
      });
    }
  }
  return items;
}

function parseDebts(rows) {
  const items = [];
  const merged = mergeContRows(rows);
  for (let i = 1; i < merged.length; i++) {
    const row = merged[i];
    if (row.length < 4) continue;
    if (norm(row.join("")).includes("本欄空白")) continue;

    items.push({
      type: row[0] || "",
      debtor: row[1] || "",
      creditor: row[2] || "",
      amount: parseNumber(row[3]),
      date: row[4]?.replace(/\s/g, "") || "",
      reason: row[5] || "",
    });
  }
  return items;
}

function parseInvestments(rows) {
  const items = [];
  const merged = mergeContRows(rows);
  for (let i = 1; i < merged.length; i++) {
    const row = merged[i];
    if (row.length < 4) continue;
    if (norm(row.join("")).includes("本欄空白")) continue;

    items.push({
      investor: row[0] || "",
      company: row[1] || "",
      address: row[2] || "",
      amount: parseNumber(row[3]),
      date: row[4]?.replace(/\s/g, "") || "",
      reason: row[5] || "",
    });
  }
  return items;
}

function parseCredits(rows) {
  const items = [];
  const merged = mergeContRows(rows);
  for (let i = 1; i < merged.length; i++) {
    const row = merged[i];
    if (row.length < 4) continue;
    if (norm(row.join("")).includes("本欄空白")) continue;

    // 種類, 債權人, 債務人及地址, 餘額, 時間, 原因
    items.push({
      type: row[0] || "",
      creditor: row[1] || "",
      debtor: row[2] || "",
      amount: parseNumber(row[3]),
      date: row[4]?.replace(/\s/g, "") || "",
      reason: row[5] || "",
    });
  }
  return items;
}

function parseFunds(rows) {
  const items = [];
  const merged = mergeContRows(rows);
  for (let i = 1; i < merged.length; i++) {
    const row = merged[i];
    if (row.length < 4) continue;
    if (norm(row.join("")).includes("本欄空白")) continue;

    // 名稱, 所有人, 受託投資機構, 單位數, 票面價額(單位淨值), 外幣幣別, 新臺幣總額
    items.push({
      name: row[0] || "",
      owner: row[1] || "",
      institution: row[2] || "",
      units: parseFloat(row[3]?.replace(/[,\s]/g, "")) || 0,
      unitValue: parseFloat(row[4]?.replace(/[,\s]/g, "")) || 0,
      foreignCurrency: row[5] || "",
      totalValue: parseNumber(row[row.length - 1]),
    });
  }
  return items;
}

function parseInsurance(rows) {
  const items = [];
  const merged = mergeContRows(rows);
  for (let i = 1; i < merged.length; i++) {
    const row = merged[i];
    if (row.length < 4) continue;
    if (norm(row.join("")).includes("本欄空白")) continue;

    // 保險公司, 保險名稱, 保單號碼, 要保人, 保險契約類型, 契約始日/契約迄日, 備註
    items.push({
      company: row[0] || "",
      name: row[1] || "",
      policyNumber: row[2] || "",
      holder: row[3] || "",
      contractType: row[4] || "",
      period: row[5] || "",
      note: row[6] || "",
    });
  }
  return items;
}

function parseValuables(rows) {
  const items = [];
  const merged = mergeContRows(rows);
  for (let i = 1; i < merged.length; i++) {
    const row = merged[i];
    if (row.length < 3) continue;
    if (norm(row.join("")).includes("本欄空白")) continue;

    // 財產種類, 項/件, 所有人, 價額
    items.push({
      type: row[0] || "",
      quantity: row[1] || "",
      owner: row[2] || "",
      value: parseNumber(row[3]),
    });
  }
  return items;
}

// ── Main parser ──

function parseDocument(doc) {
  const kids = doc.kids || [];
  const idMap = buildIdMap(kids);
  const allTables = collectTables(kids);
  // Only process root tables (not continuations)
  const rootTables = allTables.filter((t) => t["previous table id"] === undefined);

  const identified = {};
  for (const table of rootTables) {
    const type = identifyTable(table);
    if (type && !identified[type]) {
      identified[type] = getChainedRows(table, idMap);
    }
  }

  const totals = collectSectionTotals(kids);

  const header = identified.header ? parseHeader(identified.header) : { name: "", org: "", title: "", date: "", type: "" };
  const family = identified.header ? parseFamily(identified.header) : [];

  return {
    ...header,
    family,
    land: identified.land ? parseLandOrBuilding(identified.land) : [],
    buildings: identified.building ? parseLandOrBuilding(identified.building) : [],
    vehicles: identified.vehicle ? parseVehicles(identified.vehicle) : [],
    cash: { total: totals["六"] || 0 },
    deposits: { total: totals["七"] || 0, items: identified.deposit ? parseDeposits(identified.deposit) : [] },
    stocks: { total: totals._stock || 0, items: identified.stock ? parseStocks(identified.stock) : [] },
    funds: { items: identified.fund ? parseFunds(identified.fund) : [] },
    insurance: { items: identified.insurance ? parseInsurance(identified.insurance) : [] },
    valuables: { items: identified.valuable ? parseValuables(identified.valuable) : [] },
    credits: { total: totals["十"] || 0, items: identified.credit ? parseCredits(identified.credit) : [] },
    debts: { total: totals["十一"] || 0, items: identified.debt ? parseDebts(identified.debt) : [] },
    investments: { total: totals["十二"] || 0, items: identified.investment ? parseInvestments(identified.investment) : [] },
  };
}

// ── CLI ──

function formatTime(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m${s}s`;
}

async function findAllPdfs() {
  const pdfs = [];
  const dirs = await readdir(DATA_DIR);
  for (const dir of dirs) {
    const dirPath = path.join(DATA_DIR, dir);
    const s = await stat(dirPath);
    if (!s.isDirectory()) continue;
    // Look in subdirs (ordinary/, change/)
    const subdirs = await readdir(dirPath);
    for (const sub of subdirs) {
      const subPath = path.join(dirPath, sub);
      const ss = await stat(subPath);
      if (!ss.isDirectory()) continue;
      const files = await readdir(subPath);
      for (const file of files) {
        if (file.endsWith(".pdf")) pdfs.push(path.join(subPath, file));
      }
    }
  }
  return pdfs;
}

async function main() {
  const allPdfs = await findAllPdfs();
  console.log(`Found ${allPdfs.length} PDFs to extract\n`);
  if (allPdfs.length === 0) return;

  const startTime = Date.now();
  await rm(TEMP_DIR, { recursive: true, force: true });

  // Symlink all PDFs into a flat temp dir with unique names: "001-丁學忠__262-01一般申報.pdf"
  const linkDir = path.join(TEMP_DIR, "links");
  await mkdir(linkDir, { recursive: true });

  // Map: unique json output name -> original pdf path
  const pdfMap = new Map();
  for (const pdf of allPdfs) {
    const subDir = path.basename(path.dirname(pdf)); // ordinary or change
    const personDir = path.basename(path.dirname(path.dirname(pdf))); // 001-丁學忠
    const baseName = path.basename(pdf);
    const uniqueName = `${personDir}__${subDir}__${baseName}`;
    pdfMap.set(uniqueName.replace(/\.pdf$/, ".json"), pdf);
    await symlink(pdf, path.join(linkDir, uniqueName));
  }

  const linkFiles = (await readdir(linkDir)).filter((f) => f.endsWith(".pdf")).map((f) => path.join(linkDir, f));

  console.log(`Converting ${linkFiles.length} PDFs in a single batch...`);
  let usedFallback = false;
  try {
    await convert(linkFiles, { format: "json", outputDir: TEMP_DIR, quiet: true });
  } catch (err) {
    usedFallback = true;
    console.warn(`Batch conversion failed (${err.message}). Falling back to one-by-one conversion...`);
    let converted = 0;
    let convertErrors = 0;
    for (const [jsonName, origPdf] of pdfMap) {
      const singleDir = path.join(TEMP_DIR, "single", String(converted + 1));
      try {
        await rm(singleDir, { recursive: true, force: true });
        await mkdir(singleDir, { recursive: true });
        await convert([origPdf], { format: "json", outputDir: singleDir, quiet: true });

        const jsonFiles = (await readdir(singleDir)).filter((f) => f.endsWith(".json"));
        if (jsonFiles.length === 0) throw new Error("No JSON output");

        const srcJson = path.join(singleDir, jsonFiles[0]);
        const destJson = path.join(TEMP_DIR, jsonName);
        await writeFile(destJson, await readFile(srcJson, "utf-8"));
      } catch {
        convertErrors++;
      }
      converted++;
      const elapsed = (Date.now() - startTime) / 1000;
      const pct = Math.round((converted / allPdfs.length) * 100);
      process.stdout.write(
        `\r[${formatTime(elapsed)}] ${pct}% Converting ${converted}/${allPdfs.length}  ConvertErr: ${convertErrors}  `,
      );
    }
    process.stdout.write("\n");
  }
  const convertTime = (Date.now() - startTime) / 1000;
  console.log(`Conversion done in ${formatTime(convertTime)}${usedFallback ? " (fallback mode)" : ""}\n`);

  // Parse each converted JSON and write extracted output
  let processed = 0;
  let errors = 0;
  for (const [jsonName, origPdf] of pdfMap) {
    const jsonFile = path.join(TEMP_DIR, jsonName);
    const outFile = origPdf.replace(/\.pdf$/, ".extracted.json");
    try {
      const doc = JSON.parse(await readFile(jsonFile, "utf-8"));
      const result = fixMojibakeDeep(parseDocument(doc));
      await writeFile(outFile, JSON.stringify(result, null, 2));
    } catch (err) {
      errors++;
      console.error(`\n  ERROR ${path.relative(DATA_DIR, origPdf)}: ${err.message}`);
    }
    processed++;
    const elapsed = (Date.now() - startTime) / 1000;
    const pct = Math.round((processed / allPdfs.length) * 100);
    process.stdout.write(`\r[${formatTime(elapsed)}] ${pct}% Parsing ${processed}/${allPdfs.length}  Err: ${errors}  `);
  }

  // Cleanup temp dir
  await rm(TEMP_DIR, { recursive: true, force: true });

  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`\n\nDone in ${formatTime(elapsed)} — ${allPdfs.length} extracted (${errors} errors)`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
