#!/usr/bin/env node
// Quick test: parse pre-converted opendataloader JSONs using the parsing logic

import { readFile } from "fs/promises";

// ── Copy core parsing functions from extract-pdfs.mjs ──

function cellText(cell) {
  return (cell.kids || [])
    .filter((k) => k.content)
    .map((k) => k.content)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function norm(s) { return s.replace(/[\s\u3000]/g, ""); }

function parseNumber(str) {
  if (!str) return 0;
  return parseInt(str.replace(/[,\s]/g, ""), 10) || 0;
}

function extractTotal(text) {
  const m = text.match(/新臺幣\s*([\d,]+)\s*元/);
  return m ? parseNumber(m[1]) : 0;
}

function buildIdMap(kids) {
  const map = new Map();
  (function walk(nodes) {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes) {
      if (n.id !== undefined) map.set(n.id, n);
      if (Array.isArray(n.kids)) walk(n.kids);
      if (n.rows) for (const r of n.rows) if (r.cells) for (const c of r.cells) if (Array.isArray(c.kids)) walk(c.kids);
      if (n["list items"]) for (const li of n["list items"]) { if (li.id !== undefined) map.set(li.id, li); if (Array.isArray(li.kids)) walk(li.kids); }
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
      if (n["list items"]) for (const li of n["list items"]) if (Array.isArray(li.kids)) walk(li.kids);
    }
  })(kids);
  return tables;
}

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
      if (n["list items"]) for (const li of n["list items"]) { if (li.content) { const t = norm(li.content); if (t.includes("1.股票")) totals._stock = extractTotal(li.content); } if (Array.isArray(li.kids)) walk(li.kids); }
    }
  })(kids);
  return totals;
}

function identifyTable(table) {
  if (!table.rows?.length) return null;
  const cells = table.rows[0].cells.map((c) => norm(cellText(c)));
  if (cells.some((c) => c.includes("申報人姓名"))) return "header";
  if (cells.some((c) => c.includes("土地坐落"))) return "land";
  if (cells.some((c) => c.includes("建物標示"))) return "building";
  if (cells.some((c) => c.includes("廠牌"))) return "vehicle";
  if (cells.some((c) => c.includes("存放機構"))) return "deposit";
  if (cells.some((c) => c.includes("股數"))) return "stock";
  if (cells.some((c) => c.includes("投資事業") || c.includes("營業地"))) return "investment";
  if (cells.some((c) => c.includes("種類")) && cells.some((c) => c.includes("餘額") || c.includes("金額"))) return "debt";
  return null;
}

// ── Test ──

async function testFile(jsonPath) {
  const doc = JSON.parse(await readFile(jsonPath, "utf-8"));
  const kids = doc.kids || [];
  const idMap = buildIdMap(kids);
  const allTables = collectTables(kids);
  const rootTables = allTables.filter((t) => t["previous table id"] === undefined);

  console.log(`\n=== ${jsonPath} ===`);
  console.log(`Total tables: ${allTables.length}, Root tables: ${rootTables.length}`);

  for (const table of rootTables) {
    const type = identifyTable(table);
    const rows = getChainedRows(table, idMap);
    console.log(`\nTable [${type || "unknown"}] (${rows.length} rows, level ${table.level || "?"})`);
    for (let i = 0; i < Math.min(rows.length, 4); i++) {
      console.log(`  Row ${i}: [${rows[i].map(c => c.substring(0, 20)).join(" | ")}]`);
    }
    if (rows.length > 4) console.log(`  ... (${rows.length - 4} more rows)`);
  }

  const totals = collectSectionTotals(kids);
  console.log(`\nSection totals:`, totals);
}

await testFile("/Users/haotongye/Repos/tw-rich-olitician-2025/data/丁學忠/opendataloader-out/262-01一般申報.json");
await testFile("/Users/haotongye/Repos/tw-rich-olitician-2025/data/李彥秀/opendataloader-out/266-09變動申報.json");
