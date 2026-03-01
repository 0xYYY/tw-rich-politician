#!/usr/bin/env node

import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.resolve(import.meta.dirname, "../data");
const PRICE_CACHE_FILE = path.resolve(import.meta.dirname, "../data/stock-price-cache.json");
const LOOKBACK_DAYS = Math.max(1, Number(process.env.STOCK_PRICE_LOOKBACK_DAYS || 14) || 14);
const CONCURRENCY = Math.max(1, Number(process.env.STOCK_PRICE_FETCH_CONCURRENCY || 24) || 24);

function todayISO() {
  // Use UTC date to keep behavior deterministic in CI.
  return new Date().toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRocDateToISO(rocDate) {
  const m = String(rocDate || "")
    .replace(/\s/g, "")
    .match(/^(\d+)\/(\d+)\/(\d+)$/);
  if (!m) return null;
  const year = String(parseInt(m[1], 10) + 1911);
  const month = m[2].padStart(2, "0");
  const day = m[3].padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftISODate(dateISO, deltaDays) {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function monthKeysBetween(startISO, endISO) {
  const keys = [];
  const cursor = new Date(`${startISO}T00:00:00Z`);
  cursor.setUTCDate(1);
  const end = new Date(`${endISO}T00:00:00Z`);
  end.setUTCDate(1);

  while (cursor <= end) {
    keys.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return keys;
}

async function loadPriceCache() {
  try {
    return JSON.parse(await readFile(PRICE_CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function savePriceCache(cache) {
  await writeFile(PRICE_CACHE_FILE, JSON.stringify(cache, null, 2));
}

async function runWithConcurrency(items, limit, worker) {
  if (items.length === 0) return;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  });
  await Promise.all(workers);
}

function inferMarket(ticker) {
  if (!ticker) return null;
  return /^\d+$/.test(ticker) ? "tw" : "foreign";
}

async function fetchLatestFromYahoo(ticker, dateISO, lookbackDays) {
  const target = new Date(`${dateISO}T00:00:00Z`);
  const period1 = Math.floor((target.getTime() - lookbackDays * 86400000) / 1000);
  const period2 = Math.floor((target.getTime() + 86400000) / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${period1}&period2=${period2}&interval=1d`;

  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const json = await res.json();
    const result = json.chart?.result?.[0];
    if (!result?.timestamp || !result?.indicators?.quote?.[0]?.close) return null;

    const timestamps = result.timestamp;
    const closes = result.indicators.quote[0].close;
    const targetTs = target.getTime() / 1000;
    const cutoffTs = targetTs - lookbackDays * 86400;

    let closestPrice = null;
    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      const close = closes[i];
      if (ts < cutoffTs || ts > targetTs + 86400 || close == null) continue;
      closestPrice = Math.round(close * 100) / 100;
    }

    return closestPrice;
  } catch (err) {
    console.warn(`  ✗ Yahoo fetch failed for ${ticker}: ${err.message}`);
    return null;
  }
}

async function fetchLatestFromMarketWindow(ticker, market, dateISO, lookbackDays) {
  const cutoffISO = shiftISODate(dateISO, -lookbackDays);
  const months = monthKeysBetween(cutoffISO, dateISO);
  let best = null;

  for (const monthKey of months) {
    const [year, month] = monthKey.split("-");
    const day = "01";
    let rows = null;

    if (market === "twse") {
      const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${year}${month}${day}&stockNo=${ticker}`;
      const res = await fetch(url);
      const json = await res.json();
      if (json.stat !== "OK" || !json.data) continue;
      rows = json.data;
    } else if (market === "tpex") {
      const url = `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?response=json&date=${year}/${month}/${day}&code=${ticker}`;
      const res = await fetch(url);
      const json = await res.json();
      rows = json.tables?.[0]?.data || null;
      if (!rows?.length) continue;
    } else {
      return null;
    }

    for (const row of rows) {
      const rowISO = parseRocDateToISO(row[0]);
      if (!rowISO || rowISO < cutoffISO || rowISO > dateISO) continue;
      const close = parseFloat(String(row[6] || "").replace(/,/g, ""));
      if (!Number.isFinite(close)) continue;
      if (!best || rowISO > best.date) {
        best = { date: rowISO, price: close };
      }
    }
  }

  return best ? best.price : null;
}

async function fetchLatestPriceForTicker(ticker, market, dateISO, lookbackDays, cache) {
  const cacheKey = `LATEST:${ticker}:${dateISO}`;
  if (cache[cacheKey] !== undefined) return cache[cacheKey];

  let price = null;

  if (market === "foreign") {
    price = await fetchLatestFromYahoo(ticker, dateISO, lookbackDays);
    if (price != null) {
      const usdTwd = await fetchUsdTwdRate(dateISO, lookbackDays, cache);
      if (usdTwd == null) {
        console.warn(`  ⚠ Missing USD/TWD for ${dateISO}; cannot convert ${ticker}`);
        price = null;
      } else {
        price = Math.round(price * usdTwd * 100) / 100;
      }
    }
  } else if (market === "tw") {
    price = await fetchLatestFromMarketWindow(ticker, "twse", dateISO, lookbackDays);
    if (price == null) {
      await sleep(1500);
      price = await fetchLatestFromMarketWindow(ticker, "tpex", dateISO, lookbackDays);
    }
  }

  cache[cacheKey] = price;
  return price;
}

const fxInFlight = new Map();

async function fetchUsdTwdRate(dateISO, lookbackDays, cache) {
  const cacheKey = `USDTWD:${dateISO}`;
  if (cache[cacheKey] !== undefined) return cache[cacheKey];

  if (fxInFlight.has(cacheKey)) return fxInFlight.get(cacheKey);

  const p = (async () => {
    try {
      const rate = await fetchLatestFromYahoo("TWD=X", dateISO, lookbackDays);
      cache[cacheKey] = rate;
      return rate;
    } catch (err) {
      console.warn(`  ✗ USD/TWD fetch failed: ${err.message}`);
      cache[cacheKey] = null;
      return null;
    } finally {
      fxInFlight.delete(cacheKey);
    }
  })();

  fxInFlight.set(cacheKey, p);
  return p;
}

async function main() {
  const dateISO = todayISO();
  const cache = await loadPriceCache();

  const allEntries = await readdir(DATA_DIR, { withFileTypes: true });
  const consolidatedFiles = [];
  for (const entry of allEntries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    const fullPath = path.join(DATA_DIR, entry.name, "consolidated.json");
    try {
      const s = await stat(fullPath);
      if (s.isFile()) consolidatedFiles.push(fullPath);
    } catch {
      // ignore missing consolidated
    }
  }
  consolidatedFiles.sort((a, b) => a.localeCompare(b, "zh-TW"));

  if (consolidatedFiles.length === 0) {
    throw new Error(`No consolidated JSON found under ${DATA_DIR}/*/consolidated.json`);
  }

  const docs = [];
  for (const fullPath of consolidatedFiles) {
    const doc = JSON.parse(await readFile(fullPath, "utf8"));
    docs.push({ fullPath, doc });
  }

  const uniqueTickers = new Set();
  for (const { doc } of docs) {
    for (const s of doc.stocks || []) {
      if (!s?.ticker) continue;
      uniqueTickers.add(String(s.ticker).trim().toUpperCase());
    }
  }

  const tickers = [...uniqueTickers];
  const latestByTicker = new Map();

  console.log(`Updating latest stock prices for ${tickers.length} unique tickers on ${dateISO}...`);

  await runWithConcurrency(tickers, CONCURRENCY, async (ticker) => {
    const market = inferMarket(ticker);
    if (!market) return;
    const price = await fetchLatestPriceForTicker(ticker, market, dateISO, LOOKBACK_DAYS, cache);
    latestByTicker.set(ticker, price);
    if (price == null) {
      console.warn(`  ⚠ No latest price for ${ticker}`);
    } else {
      console.log(`  ✓ ${ticker}: ${price}`);
    }
  });

  let updatedPeople = 0;
  let updatedRows = 0;

  for (const entry of docs) {
    let changed = false;
    const stocks = entry.doc.stocks || [];
    for (const s of stocks) {
      if (!s?.ticker) continue;
      const key = String(s.ticker).trim().toUpperCase();
      if (!latestByTicker.has(key)) continue;
      const next = latestByTicker.get(key);
      if (s.latestPrice !== next) {
        s.latestPrice = next;
        changed = true;
        updatedRows++;
      }
    }

    if (changed) {
      await writeFile(entry.fullPath, JSON.stringify(entry.doc, null, 2));
      updatedPeople++;
    }
  }

  await savePriceCache(cache);

  console.log("\nDone.");
  console.log(`People files updated: ${updatedPeople}`);
  console.log(`Stock rows updated: ${updatedRows}`);
  console.log(`Cache updated: ${PRICE_CACHE_FILE}`);
}

main().catch((err) => {
  console.error("[update-latest-stock-prices]", err.message);
  process.exit(1);
});
