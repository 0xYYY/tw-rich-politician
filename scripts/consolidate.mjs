#!/usr/bin/env node

import { readFile, writeFile, readdir } from "fs/promises";
import path from "node:path";

const DATA_DIR = path.resolve(import.meta.dirname, "../data");
const TICKER_CACHE = path.resolve(import.meta.dirname, "../data/stock-ticker-map.json");
const TICKER_OVERRIDES_PATH = path.resolve(
  import.meta.dirname,
  "../data/stock-ticker-overrides.json",
);

// ── Date helpers ──

/** Convert ROC date "113年11月01日" → "2024-11-01" */
function rocToISO(rocDate) {
  const m = rocDate.match(/(\d+)年(\d+)月(\d+)日/);
  if (!m) return null;
  const year = parseInt(m[1], 10) + 1911;
  const month = m[2].padStart(2, "0");
  const day = m[3].padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ── Share parsing ──

/** Parse share string → number (0-1)
 *  "全部" → 1
 *  "15 分之 1" → 1/15
 *  "950000 分 之 12388" → 12388/950000
 */
function parseShare(shareStr) {
  if (!shareStr) return 1;
  const s = shareStr.trim();
  if (s === "全部") return 1;
  // "N 分之 M" or "N 分 之 M"
  const m = s.match(/(\d+)\s*分\s*之\s*(\d+)/);
  if (m) return parseInt(m[2], 10) / parseInt(m[1], 10);
  return 1;
}

// ── Building processing ──

const M2_PER_PING = 3.305785; // 1坪 = 3.305785 m²

function cleanBuildingLocation(location) {
  const text = String(location || "").replace(/\u3000/g, " ");
  // Remove disclosure-note parentheses from location text.
  return text
    .replace(/[（(]\s*未?\s*交付信\s*託原因[^）)]*[）)]/g, "")
    .replace(/[（(][^）)]*自用房屋[^）)]*[）)]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function processBuildings(buildings) {
  if (!buildings || buildings.length === 0) return [];

  // First pass: compute effective area for each entry
  const entries = buildings.map((b) => {
    const share = parseShare(b.share);
    const effectiveAreaM2 = b.area * share;
    const effectiveAreaPing = effectiveAreaM2 / M2_PER_PING;

    return {
      location: cleanBuildingLocation(b.location),
      areaM2: b.area,
      share,
      effectiveAreaPing: Math.round(effectiveAreaPing * 100) / 100,
      owner: b.owner,
      date: b.date || null,
      price: b.price || null,
    };
  });

  // Second pass: merge entries with same location + owner + date
  const mergeMap = new Map();
  for (const e of entries) {
    const key = `${e.location}|${e.owner}|${e.date || ""}`;
    if (!mergeMap.has(key)) {
      mergeMap.set(key, {
        location: e.location,
        owner: e.owner,
        date: e.date ? rocToISO(e.date) : null,
        effectiveAreaPing: 0,
        entryCount: 0,
        price: e.price,
      });
    }
    const merged = mergeMap.get(key);
    merged.effectiveAreaPing += e.effectiveAreaPing;
    merged.entryCount++;
  }

  return [...mergeMap.values()].map((m) => ({
    location: m.location,
    owner: m.owner,
    date: m.date,
    effectiveAreaPing: Math.round(m.effectiveAreaPing * 100) / 100,
    entryCount: m.entryCount,
    price: m.price,
  }));
}

// ── Deposit/cash processing ──

function processDeposits(deposits) {
  if (!deposits?.items) return [];
  const byCurrency = {};
  for (const d of deposits.items) {
    const currency = d.currency || "新臺幣";
    byCurrency[currency] = (byCurrency[currency] || 0) + d.amount;
  }
  return Object.entries(byCurrency).map(([currency, amount]) => ({
    currency,
    amount,
  }));
}

function processInsurance(insurance, ownerName) {
  if (!insurance?.items) return [];
  return insurance.items.map((i) => ({
    company: i.company || "",
    name: i.name || "",
    holder: i.holder || ownerName,
    contractType: i.contractType || "",
  }));
}

function isBondLikeName(name) {
  const n = (name || "").replace(/\s/g, "");
  return /債|公司債|金融債|公債|可轉債|轉換債|債券/.test(n);
}

function isFundCertLikeName(name) {
  const n = (name || "").replace(/\s/g, "");
  return /基金|受益憑證|ETF|ETN|共同基金|貨幣市場/.test(n);
}

function splitStockLikeAssets(rawStocks, rawFunds, ownerName) {
  const stockItems = rawStocks?.items || [];
  const fundItems = rawFunds?.items || [];
  const regularStocks = [];
  const bonds = [];
  const fundCertificates = [];

  for (const s of stockItems) {
    const cleanName = cleanStockName(s.name);
    if (isBondLikeName(cleanName)) {
      bonds.push({
        name: s.name || "",
        owner: ownerName,
        shares: s.shares || 0,
        declaredValue: s.totalValue || 0,
        source: "stock",
      });
      continue;
    }
    if (isFundCertLikeName(cleanName)) {
      fundCertificates.push({
        name: s.name || "",
        owner: ownerName,
        shares: s.shares || 0,
        declaredValue: s.totalValue || 0,
        source: "stock",
      });
      continue;
    }
    regularStocks.push(s);
  }

  for (const f of fundItems) {
    const name = f.name || "";
    if (isBondLikeName(name)) {
      bonds.push({
        name,
        owner: ownerName,
        institution: f.institution || "",
        units: f.units || 0,
        unitValue: f.unitValue || 0,
        currency: f.foreignCurrency || "",
        declaredValue: f.totalValue || 0,
        source: "fund",
      });
      continue;
    }
    fundCertificates.push({
      name,
      owner: ownerName,
      institution: f.institution || "",
      units: f.units || 0,
      unitValue: f.unitValue || 0,
      currency: f.foreignCurrency || "",
      declaredValue: f.totalValue || 0,
      source: "fund",
    });
  }

  return { regularStocks, bonds, fundCertificates };
}

// ── Stock name cleaning ──

async function loadTickerOverrides() {
  try {
    return JSON.parse(await readFile(TICKER_OVERRIDES_PATH, "utf8"));
  } catch (err) {
    console.warn(
      `Could not read ticker overrides (${path.relative(DATA_DIR, TICKER_OVERRIDES_PATH)}): ${err.message}`,
    );
    return {};
  }
}

/** Remove trust annotations like 「交付臺灣銀行信託」 from stock names */
function cleanStockName(name) {
  return (
    String(name || "")
      .replace(/\u3000/g, " ")
      .replace(/[－–—]/g, "-")
      // Some rows are "broker/stockName"
      .replace(/^.*\//, "")
      // Remove trust notes in parentheses/brackets
      .replace(/[（(]\s*未?\s*交付信託原因[^）)]*[）)]/g, "")
      .replace(/[「\(（]\s*交付[^」\)）]*[」\)）]/g, "")
      // Remove generic "(舊)" and trailing "舊"
      .replace(/[（(]\s*舊\s*[）)]/g, "")
      .replace(/舊$/g, "")
      // Remove star prefixes
      .replace(/^\d+\s*★/, "")
      .replace(/^★/, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Resolve ticker info for a cleaned stock name */
function resolveTickerInfo(cleanName, tickerMap, tickerOverrides) {
  const noSpace = cleanName.replace(/\s+/g, "");
  const candidates = cleanName === noSpace ? [cleanName] : [cleanName, noSpace];

  // Check direct overrides first
  for (const c of candidates) {
    if (tickerOverrides[c]) return tickerOverrides[c];
  }
  // Then check TWSE/TPEx map
  for (const c of candidates) {
    if (tickerMap[c]) return tickerMap[c];
  }
  return null;
}

// ── Stock ticker mapping ──

async function fetchTickerMap() {
  // Try loading from cache first
  try {
    const cached = JSON.parse(await readFile(TICKER_CACHE, "utf8"));
    if (cached._fetchedAt) {
      const age = Date.now() - new Date(cached._fetchedAt).getTime();
      if (age < 7 * 24 * 60 * 60 * 1000) {
        // 7 days
        console.log("Using cached ticker map");
        delete cached._fetchedAt;
        return cached;
      }
    }
  } catch {}

  console.log("Fetching TWSE stock list...");
  const twseRes = await fetch("https://openapi.twse.com.tw/v1/opendata/t187ap03_L");
  const twseData = await twseRes.json();

  console.log("Fetching TPEx stock list...");
  const tpexRes = await fetch("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes");
  const tpexData = await tpexRes.json();

  const map = {};

  // TWSE: 公司代號, 公司簡稱
  for (const item of twseData) {
    const ticker = (item["公司代號"] || "").trim();
    const name = (item["公司簡稱"] || "").trim();
    if (ticker && name) {
      map[name] = { ticker, market: "twse" };
    }
  }

  // TPEx: SecuritiesCompanyCode, CompanyName
  for (const item of tpexData) {
    const ticker = (item["SecuritiesCompanyCode"] || "").trim();
    const name = (item["CompanyName"] || "").trim();
    if (ticker && name) {
      map[name] = { ticker, market: "tpex" };
    }
  }

  // Save cache
  const toCache = { ...map, _fetchedAt: new Date().toISOString() };
  await writeFile(TICKER_CACHE, JSON.stringify(toCache, null, 2));
  console.log(`Cached ${Object.keys(map).length} ticker mappings`);

  return map;
}

// ── Stock price fetching ──

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function shiftISODate(dateISO, deltaDays) {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function parseRocDateToISO(rocDate) {
  const m = rocDate.replace(/\s/g, "").match(/^(\d+)\/(\d+)\/(\d+)$/);
  if (!m) return null;
  const year = String(parseInt(m[1], 10) + 1911);
  const month = m[2].padStart(2, "0");
  const day = m[3].padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function monthKeysBetween(startISO, endISO) {
  const keys = [];
  let cursor = new Date(`${startISO}T00:00:00Z`);
  cursor.setUTCDate(1);
  const end = new Date(`${endISO}T00:00:00Z`);
  end.setUTCDate(1);
  while (cursor <= end) {
    keys.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return keys;
}

/** Fetch closing price for a stock on a given date (or nearest prior trading day). */
async function fetchStockPrice(ticker, market, dateISO) {
  if (market === "foreign") {
    return _fetchFromYahoo(ticker, dateISO);
  }
  const price = await _fetchFromMarket(ticker, market, dateISO);
  if (price !== null) return price;
  // Fallback: try the other market
  const fallback = market === "twse" ? "tpex" : "twse";
  await sleep(3000);
  return _fetchFromMarket(ticker, fallback, dateISO);
}

async function fetchLatestStockPrice(ticker, market, dateISO, lookbackDays = 14) {
  if (market === "foreign") {
    return _fetchLatestFromYahoo(ticker, dateISO, lookbackDays);
  }

  const price = await _fetchLatestFromMarketWindow(ticker, market, dateISO, lookbackDays);
  if (price !== null) return price;
  const fallback = market === "twse" ? "tpex" : "twse";
  await sleep(3000);
  return _fetchLatestFromMarketWindow(ticker, fallback, dateISO, lookbackDays);
}

/** Fetch foreign stock price from Yahoo Finance */
async function _fetchFromYahoo(ticker, dateISO) {
  const date = new Date(dateISO + "T00:00:00Z");
  // period1 = 5 days before, period2 = 1 day after (to capture the date or nearest prior)
  const period1 = Math.floor((date.getTime() - 5 * 86400000) / 1000);
  const period2 = Math.floor((date.getTime() + 86400000) / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${period1}&period2=${period2}&interval=1d`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const json = await res.json();
    const result = json.chart?.result?.[0];
    if (!result?.timestamp || !result?.indicators?.quote?.[0]?.close) return null;

    const timestamps = result.timestamp;
    const closes = result.indicators.quote[0].close;
    const targetTs = date.getTime() / 1000;

    // Find exact date or closest prior
    let closestPrice = null;
    for (let i = 0; i < timestamps.length; i++) {
      if (timestamps[i] <= targetTs + 86400 && closes[i] != null) {
        closestPrice = Math.round(closes[i] * 100) / 100;
      }
    }
    return closestPrice;
  } catch (err) {
    console.warn(`  ✗ Yahoo Finance failed for ${ticker}: ${err.message}`);
    return null;
  }
}

async function _fetchLatestFromYahoo(ticker, dateISO, lookbackDays = 14) {
  const date = new Date(dateISO + "T00:00:00Z");
  const period1 = Math.floor((date.getTime() - lookbackDays * 86400000) / 1000);
  const period2 = Math.floor((date.getTime() + 86400000) / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${period1}&period2=${period2}&interval=1d`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const json = await res.json();
    const result = json.chart?.result?.[0];
    if (!result?.timestamp || !result?.indicators?.quote?.[0]?.close) return null;

    const timestamps = result.timestamp;
    const closes = result.indicators.quote[0].close;
    const targetTs = date.getTime() / 1000;
    const cutoffTs = targetTs - lookbackDays * 86400;

    let closestPrice = null;
    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      if (ts >= cutoffTs && ts <= targetTs + 86400 && closes[i] != null) {
        closestPrice = Math.round(closes[i] * 100) / 100;
      }
    }
    return closestPrice;
  } catch (err) {
    console.warn(`  ✗ Yahoo Finance latest failed for ${ticker}: ${err.message}`);
    return null;
  }
}

async function _fetchLatestFromMarketWindow(ticker, market, dateISO, lookbackDays = 14) {
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
      if (!rowISO) continue;
      if (rowISO < cutoffISO || rowISO > dateISO) continue;
      const close = parseFloat(String(row[6]).replace(/,/g, ""));
      if (!Number.isFinite(close)) continue;
      if (!best || rowISO > best.date) {
        best = { date: rowISO, price: close };
      }
    }
  }

  return best ? best.price : null;
}

async function _fetchFromMarket(ticker, market, dateISO) {
  const [year, month] = dateISO.split("-");
  const day = dateISO.split("-")[2];

  if (market === "twse") {
    const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${year}${month}${day}&stockNo=${ticker}`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.stat !== "OK" || !json.data) return null;

    // Find the exact date or the latest date before it
    // Date format in response: "113/11/01" (ROC)
    const rocYear = parseInt(year, 10) - 1911;
    const targetDateStr = `${rocYear}/${month}/${day}`;

    // Search for exact date match first, then closest prior
    let closestPrice = null;
    for (const row of json.data) {
      const rowDate = row[0].replace(/\s/g, "");
      if (rowDate === targetDateStr) {
        return parseFloat(row[6].replace(/,/g, ""));
      }
      // Track the latest row up to target date
      if (rowDate <= targetDateStr) {
        closestPrice = parseFloat(row[6].replace(/,/g, ""));
      }
    }
    return closestPrice;
  } else if (market === "tpex") {
    const url = `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?response=json&date=${year}/${month}/${day}&code=${ticker}`;
    const res = await fetch(url);
    const json = await res.json();
    const table = json.tables?.[0];
    if (!table?.data?.length) return null;

    // Date format: "113/11/01" (ROC)
    const rocYear = parseInt(year, 10) - 1911;
    const targetDateStr = `${rocYear}/${month}/${day}`;

    let closestPrice = null;
    for (const row of table.data) {
      const rowDate = row[0].replace(/\s/g, "");
      const closeStr = row[6]; // closing price
      if (rowDate === targetDateStr) {
        return parseFloat(closeStr.replace(/,/g, ""));
      }
      if (rowDate <= targetDateStr) {
        closestPrice = parseFloat(closeStr.replace(/,/g, ""));
      }
    }
    return closestPrice;
  }

  return null;
}

// ── Price cache ──

const PRICE_CACHE_FILE = path.resolve(import.meta.dirname, "../data/stock-price-cache.json");
const PRICE_FETCH_CONCURRENCY = Math.max(
  1,
  Number(process.env.PRICE_FETCH_CONCURRENCY || 32) || 32,
);
const FX_FETCH_PROMISES = new Map();

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
  if (!items.length) return;
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index++];
      await worker(current);
    }
  });
  await Promise.all(runners);
}

// ── Stock processing ──

/** Get today's date as ISO string */
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function fetchPriceForName(name, dateISO, tickerMap, tickerOverrides, priceCache, label) {
  const cacheKey = `${name}:${dateISO}`;
  if (priceCache[cacheKey] !== undefined) {
    return priceCache[cacheKey];
  }

  const tickerInfo = resolveTickerInfo(name, tickerMap, tickerOverrides);
  if (!tickerInfo) {
    priceCache[cacheKey] = null;
    return null;
  }

  try {
    await sleep(3000);
    const price =
      label === "latest"
        ? await fetchLatestStockPrice(tickerInfo.ticker, tickerInfo.market, dateISO, 14)
        : await fetchStockPrice(tickerInfo.ticker, tickerInfo.market, dateISO);
    let normalizedPrice = price;

    // Foreign stock quotes are not TWD; convert them to TWD by historical USD/TWD.
    if (price !== null && tickerInfo.market === "foreign") {
      const usdTwd = await fetchUsdTwdRate(dateISO, priceCache);
      if (usdTwd === null) {
        console.warn(
          `  ⚠ No USD/TWD rate for ${dateISO}; cannot convert ${name} (${tickerInfo.ticker})`,
        );
        normalizedPrice = null;
      } else {
        normalizedPrice = Math.round(price * usdTwd * 100) / 100;
      }
    }

    priceCache[cacheKey] = normalizedPrice;
    if (normalizedPrice) {
      console.log(`  ✓ ${name} (${tickerInfo.ticker}) ${label}: $${normalizedPrice}`);
    } else {
      console.warn(`  ⚠ No ${label} price for: ${name} (${tickerInfo.ticker})`);
    }
    return normalizedPrice;
  } catch (err) {
    console.warn(`  ✗ Failed ${label} price for: ${name} (${tickerInfo.ticker}): ${err.message}`);
    priceCache[cacheKey] = null;
    return null;
  }
}

async function fetchUsdTwdRate(dateISO, priceCache) {
  const cacheKey = `USDTWD:${dateISO}`;
  if (priceCache[cacheKey] !== undefined) {
    return priceCache[cacheKey];
  }

  if (FX_FETCH_PROMISES.has(cacheKey)) {
    return FX_FETCH_PROMISES.get(cacheKey);
  }

  const promise = (async () => {
    try {
      const rate = await _fetchFromYahoo("TWD=X", dateISO);
      priceCache[cacheKey] = rate;
      return rate;
    } catch (err) {
      console.warn(`  ✗ Failed USD/TWD fetch for ${dateISO}: ${err.message}`);
      priceCache[cacheKey] = null;
      return null;
    } finally {
      FX_FETCH_PROMISES.delete(cacheKey);
    }
  })();

  FX_FETCH_PROMISES.set(cacheKey, promise);
  return promise;
}

async function processStocks(stocks, dateISO, tickerMap, tickerOverrides, priceCache, ownerName) {
  if (!stocks?.items || stocks.items.length === 0) return [];

  const validItems = stocks.items.filter((s) => Number(s.shares || 0) > 0);
  if (validItems.length === 0) return [];

  const results = [];
  const names = [...new Set(validItems.map((s) => cleanStockName(s.name)))];
  const disclosurePriceMap = {};
  const latestPriceMap = {};
  const today = todayISO();

  await runWithConcurrency(names, PRICE_FETCH_CONCURRENCY, async (name) => {
    const tickerInfo = resolveTickerInfo(name, tickerMap, tickerOverrides);
    if (!tickerInfo) {
      console.warn(`  ⚠ No ticker found for: ${name}`);
      disclosurePriceMap[name] = null;
      latestPriceMap[name] = null;
      priceCache[`${name}:${dateISO}`] = null;
      priceCache[`${name}:${today}`] = null;
      return;
    }

    if (dateISO === today) {
      const price = await fetchPriceForName(
        name,
        today,
        tickerMap,
        tickerOverrides,
        priceCache,
        "latest",
      );
      disclosurePriceMap[name] = price;
      latestPriceMap[name] = price;
      return;
    }

    const [disclosurePrice, latestPrice] = await Promise.all([
      fetchPriceForName(name, dateISO, tickerMap, tickerOverrides, priceCache, "disclosure"),
      fetchPriceForName(name, today, tickerMap, tickerOverrides, priceCache, "latest"),
    ]);
    disclosurePriceMap[name] = disclosurePrice;
    latestPriceMap[name] = latestPrice;
  });

  for (const s of validItems) {
    const name = cleanStockName(s.name);
    const tickerInfo = resolveTickerInfo(name, tickerMap, tickerOverrides);
    results.push({
      name: s.name,
      cleanName: name,
      ticker: tickerInfo?.ticker || null,
      shares: s.shares,
      owner: ownerName,
      priceAtDisclosure: disclosurePriceMap[name] || null,
      latestPrice: latestPriceMap[name] || null,
    });
  }

  return results;
}

// ── Main ──

async function main() {
  const skipStockPrices = process.argv.includes("--skip-prices");

  const tickerOverrides = await loadTickerOverrides();
  const tickerMap = skipStockPrices ? {} : await fetchTickerMap();
  const priceCache = await loadPriceCache();

  const peopleMapping = JSON.parse(
    await readFile(path.join(DATA_DIR, "people-mapping.json"), "utf8"),
  );
  const partyMap = {};
  for (const [name, info] of Object.entries(peopleMapping)) partyMap[name] = info.party;

  const SKIP_DIRS = new Set(["consolidated", ".tmp-extract"]);
  const allDirEntries = await readdir(DATA_DIR, { withFileTypes: true });
  const dirs = allDirEntries
    .filter(
      (d) =>
        d.isDirectory() &&
        !SKIP_DIRS.has(d.name) &&
        !d.name.startsWith(".") &&
        !d.name.startsWith("_"),
    )
    .map((d) => d.name)
    .sort();

  let processed = 0;
  let skipped = 0;
  const unmatchedStocks = {}; // cleanName → { count, people[], originalNames[] }

  const normText = (s) => String(s || "").replace(/[\s\u3000]/g, "");
  const periodNum = (period) => Number(String(period || "").replace(/[^\d]/g, "")) || 0;
  const publishDateNum = (publishDate) => {
    const m = String(publishDate || "").match(/(\d+)年(\d+)月(\d+)日/);
    if (!m) return 0;
    return Number(`${m[1].padStart(3, "0")}${m[2].padStart(2, "0")}${m[3].padStart(2, "0")}`);
  };

  async function loadFiling(personDir, filingEntry) {
    const filingDir = path.join(DATA_DIR, personDir, filingEntry.dirName);
    const metadataPath = path.join(filingDir, "metadata.json");
    const extractedPath = path.join(filingDir, "extracted.json");

    try {
      const [metadataRaw, extractedRaw] = await Promise.all([
        readFile(metadataPath, "utf8"),
        readFile(extractedPath, "utf8"),
      ]);
      return {
        key: filingEntry.dirName,
        code: filingEntry.code,
        metadata: JSON.parse(metadataRaw),
        raw: JSON.parse(extractedRaw),
      };
    } catch {
      return null;
    }
  }

  function choosePrimaryFiling(filings) {
    const nonTrust = filings.filter((f) => !String(f.metadata?.PublishType || "").includes("信託"));
    // Prefer 01 (一般申報) as the primary snapshot when available.
    const ordinary = nonTrust.filter((f) => String(f.code) === "01");
    const candidates = ordinary.length > 0 ? ordinary : nonTrust.length > 0 ? nonTrust : filings;
    candidates.sort((a, b) => {
      const pa = periodNum(a.metadata?.Period);
      const pb = periodNum(b.metadata?.Period);
      if (pb !== pa) return pb - pa;
      const da = publishDateNum(a.metadata?.PublishDate);
      const db = publishDateNum(b.metadata?.PublishDate);
      if (db !== da) return db - da;
      return String(b.key || b.code).localeCompare(String(a.key || a.code), "zh-TW");
    });
    return candidates[0] || null;
  }

  function mergeStocksFromTrust(ordinaryStocks, trustStocks) {
    if (!trustStocks?.items?.length) return ordinaryStocks;
    const existingNames = new Set(
      (ordinaryStocks?.items || []).map(
        (s) => `${normText(cleanStockName(s.name))}|${normText(s.owner)}|${Number(s.shares || 0)}`,
      ),
    );
    const newItems = trustStocks.items.filter(
      (s) =>
        !existingNames.has(
          `${normText(cleanStockName(s.name))}|${normText(s.owner)}|${Number(s.shares || 0)}`,
        ),
    );
    return {
      ...ordinaryStocks,
      items: [...(ordinaryStocks?.items || []), ...newItems],
    };
  }

  function mergeDepositsFromTrust(ordinaryDeposits, trustDeposits) {
    if (!trustDeposits?.items?.length) return ordinaryDeposits;
    const existingKeys = new Set(
      (ordinaryDeposits?.items || []).map(
        (d) =>
          `${normText(d.institution)}|${normText(d.currency || "新臺幣")}|${normText(d.owner)}|${Number(d.amount || 0)}`,
      ),
    );
    const newItems = trustDeposits.items.filter(
      (d) =>
        !existingKeys.has(
          `${normText(d.institution)}|${normText(d.currency || "新臺幣")}|${normText(d.owner)}|${Number(d.amount || 0)}`,
        ),
    );
    if (newItems.length === 0) return ordinaryDeposits;
    return {
      total: (ordinaryDeposits?.total || 0) + newItems.reduce((s, d) => s + d.amount, 0),
      items: [...(ordinaryDeposits?.items || []), ...newItems],
    };
  }

  function mergeBuildingsFromTrust(ordinaryBuildings, trustBuildings) {
    if (!trustBuildings?.length) return ordinaryBuildings;
    const existingKeys = new Set(
      (ordinaryBuildings || []).map(
        (b) =>
          `${normText(b.location)}|${Number(b.area || 0)}|${normText(b.share)}|${normText(b.owner)}`,
      ),
    );
    const newItems = trustBuildings.filter(
      (b) =>
        !existingKeys.has(
          `${normText(b.location)}|${Number(b.area || 0)}|${normText(b.share)}|${normText(b.owner)}`,
        ),
    );
    return [...(ordinaryBuildings || []), ...newItems];
  }

  function mergeFundsFromTrust(ordinaryFunds, trustFunds) {
    if (!trustFunds?.items?.length) return ordinaryFunds;
    const existingKeys = new Set(
      (ordinaryFunds?.items || []).map(
        (f) =>
          `${normText(f.name)}|${normText(f.owner)}|${normText(f.institution)}|${Number(f.units || 0)}|${Number(f.totalValue || 0)}`,
      ),
    );
    const newItems = trustFunds.items.filter(
      (f) =>
        !existingKeys.has(
          `${normText(f.name)}|${normText(f.owner)}|${normText(f.institution)}|${Number(f.units || 0)}|${Number(f.totalValue || 0)}`,
        ),
    );
    return { items: [...(ordinaryFunds?.items || []), ...newItems] };
  }

  for (const dir of dirs) {
    const personDir = path.join(DATA_DIR, dir);
    const filingDirEntries = await readdir(personDir, { withFileTypes: true });
    const filingEntries = filingDirEntries
      .filter((d) => d.isDirectory())
      .map((d) => {
        const m = d.name.match(/^(\d{2})(?:-.+)?$/);
        if (!m) return null;
        return { dirName: d.name, code: m[1] };
      })
      .filter(Boolean)
      .sort((a, b) => a.dirName.localeCompare(b.dirName, "zh-TW"));

    if (filingEntries.length === 0) {
      skipped++;
      continue;
    }

    const filings = [];
    for (const filingEntry of filingEntries) {
      const filing = await loadFiling(dir, filingEntry);
      if (filing) filings.push(filing);
    }
    // Exclude 09 (變動申報) entirely from consolidation.
    const effectiveFilings = filings.filter((f) => String(f.code) !== "09");
    if (effectiveFilings.length === 0) {
      skipped++;
      continue;
    }

    const primary = choosePrimaryFiling(effectiveFilings);
    if (!primary) {
      skipped++;
      continue;
    }

    const canonicalName = dir;
    const dateISO = rocToISO(primary.raw?.date || "") || null;

    let mergedStocks = primary.raw.stocks;
    let mergedDeposits = primary.raw.deposits;
    let mergedBuildings = primary.raw.buildings;
    let mergedFunds = primary.raw.funds;
    let trustLands = [];

    const trustFilings = effectiveFilings.filter((f) =>
      String(f.metadata?.PublishType || "").includes("信託"),
    );
    if (trustFilings.length > 0) {
      console.log(
        `Processing: ${canonicalName} (${dateISO || "unknown"}) [+trust:${trustFilings.length}]`,
      );
      for (const trust of trustFilings) {
        mergedStocks = mergeStocksFromTrust(mergedStocks, trust.raw?.stocks);
        mergedDeposits = mergeDepositsFromTrust(mergedDeposits, trust.raw?.deposits);
        mergedBuildings = mergeBuildingsFromTrust(mergedBuildings, trust.raw?.buildings);
        mergedFunds = mergeFundsFromTrust(mergedFunds, trust.raw?.funds);
        trustLands = mergeBuildingsFromTrust(trustLands, trust.raw?.land);
      }
    } else {
      console.log(`Processing: ${canonicalName} (${dateISO || "unknown"})`);
    }

    const consolidated = {
      name: canonicalName,
      date: dateISO,
      type: peopleMapping[canonicalName]?.type || null,
      area: peopleMapping[canonicalName]?.area || null,
      party: partyMap[canonicalName] || null,
      deposits: processDeposits(mergedDeposits),
      depositsTotal: mergedDeposits?.total || 0,
      insurance: processInsurance(primary.raw?.insurance, canonicalName),
      stocks: [],
      bonds: [],
      fundCertificates: [],
      buildings: processBuildings([...(mergedBuildings || []), ...(trustLands || [])]),
    };

    const { regularStocks, bonds, fundCertificates } = splitStockLikeAssets(
      mergedStocks,
      mergedFunds,
      canonicalName,
    );

    consolidated.bonds = bonds;
    consolidated.fundCertificates = fundCertificates;
    consolidated.stocks = skipStockPrices
      ? regularStocks
          .filter((s) => Number(s.shares || 0) > 0)
          .map((s) => ({
            name: s.name,
            cleanName: cleanStockName(s.name),
            ticker:
              resolveTickerInfo(cleanStockName(s.name), tickerMap, tickerOverrides)?.ticker || null,
            shares: s.shares,
            owner: canonicalName,
            priceAtDisclosure: null,
            latestPrice: null,
          }))
      : await processStocks(
          { items: regularStocks },
          dateISO,
          tickerMap,
          tickerOverrides,
          priceCache,
          canonicalName,
        );

    // Track unmatched stocks
    for (const s of consolidated.stocks) {
      if (s.ticker === null) {
        const key = s.cleanName;
        if (!unmatchedStocks[key]) {
          unmatchedStocks[key] = { count: 0, people: [], originalNames: new Set() };
        }
        unmatchedStocks[key].count++;
        unmatchedStocks[key].originalNames.add(s.name);
        if (!unmatchedStocks[key].people.includes(canonicalName)) {
          unmatchedStocks[key].people.push(canonicalName);
        }
      }
    }

    const outFile = path.join(DATA_DIR, dir, "consolidated.json");
    await writeFile(outFile, JSON.stringify(consolidated, null, 2));
    processed++;
  }

  // Save price cache
  await savePriceCache(priceCache);

  // Write unmatched stocks report
  const unmatchedReport = Object.entries(unmatchedStocks)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, info]) => ({
      name,
      originalNames: [...info.originalNames],
      count: info.count,
      people: info.people,
    }));
  await writeFile(
    path.join(DATA_DIR, "_unmatched-stocks.json"),
    JSON.stringify(unmatchedReport, null, 2),
  );

  console.log(`\nDone: ${processed} processed, ${skipped} skipped (no extracted filing)`);
  console.log(
    `Unmatched stocks: ${unmatchedReport.length} unique names (${unmatchedReport.reduce((s, r) => s + r.count, 0)} total entries)`,
  );
  console.log(`Report saved to: data/_unmatched-stocks.json`);
}

main().catch(console.error);
