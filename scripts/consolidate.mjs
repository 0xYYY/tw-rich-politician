#!/usr/bin/env node

import { readFile, writeFile, readdir, mkdir } from "fs/promises";
import path from "node:path";

const DATA_DIR = path.resolve(import.meta.dirname, "../data");
const OUT_DIR = path.resolve(import.meta.dirname, "../data/consolidated");
const TICKER_CACHE = path.resolve(import.meta.dirname, "../data/stock-ticker-map.json");

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

function processBuildings(buildings) {
  if (!buildings || buildings.length === 0) return [];

  // First pass: compute effective area for each entry
  const entries = buildings.map((b) => {
    const share = parseShare(b.share);
    const effectiveAreaM2 = b.area * share;
    const effectiveAreaPing = effectiveAreaM2 / M2_PER_PING;

    return {
      location: b.location,
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

// Alias map for names that don't match the official TWSE/TPEx short names
// Direct ticker overrides for names that can't be resolved via TWSE/TPEx lists
// (renamed, delisted, special share classes, abbreviation mismatches)
const TICKER_OVERRIDES = {
  台新金: { ticker: "2887", market: "twse" },
  新光金: { ticker: "2888", market: "twse" }, // now 台新新光金
  臺化: { ticker: "1326", market: "twse" },
  國巨: { ticker: "2327", market: "twse" }, // listed as 國巨*
  開發金: { ticker: "2883", market: "twse" },
  台企銀: { ticker: "2834", market: "twse" },
  中華電信: { ticker: "2412", market: "twse" },
  中鼎工程: { ticker: "9933", market: "twse" },
  中信: { ticker: "2891", market: "twse" },
  台光: { ticker: "2383", market: "twse" },
  泰宗: { ticker: "4174", market: "tpex" },
  泰宗生技: { ticker: "4174", market: "tpex" },
  "立凱－KY": { ticker: "5765", market: "tpex" },
  宏遠電訊: { ticker: "6457", market: "tpex" },
  亞太電信股份有限公司: { ticker: "3682", market: "twse" },
  亞太電: { ticker: "3682", market: "twse" },
  "第一金融控股股份有限公 司": { ticker: "2892", market: "twse" },
  "中租-KY 甲特": { ticker: "5871", market: "twse" },
  富邦金丙特: { ticker: "2881", market: "twse" },
  文曄甲特: { ticker: "3036", market: "twse" },
  台新金已: { ticker: "2887", market: "twse" },
  中華開發金控: { ticker: "2883", market: "twse" },
  台新金控: { ticker: "2887", market: "twse" },
  新光金控: { ticker: "2888", market: "twse" },
  泰豐輪胎: { ticker: "2102", market: "twse" },
  合勤: { ticker: "2391", market: "twse" },
  康聯訊科技股份有限公司: { ticker: "6830", market: "tpex" },
  英格爾: { ticker: "8287", market: "tpex" },
  // Foreign stocks
  nvda: { ticker: "NVDA", market: "foreign" },
  NVDA: { ticker: "NVDA", market: "foreign" },
  Intel: { ticker: "INTC", market: "foreign" },
  "SEA LTD-ADR": { ticker: "SE", market: "foreign" },
  "SY HOLDINGS": { ticker: "SY", market: "foreign" },
  "91APP*-KY": { ticker: "6741", market: "tpex" },
};

/** Remove trust annotations like 「交付臺灣銀行信託」 from stock names */
function cleanStockName(name) {
  return name
    .replace(/[「\(（]交付[^」\)）]*[」\)）]/g, "")
    .replace(/^\d+★/, "") // remove "1★" prefix
    .trim();
}

/** Resolve ticker info for a cleaned stock name */
function resolveTickerInfo(cleanName, tickerMap) {
  // Check direct overrides first
  if (TICKER_OVERRIDES[cleanName]) return TICKER_OVERRIDES[cleanName];
  // Then check TWSE/TPEx map
  if (tickerMap[cleanName]) return tickerMap[cleanName];
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

async function fetchPriceForName(name, dateISO, tickerMap, priceCache, label) {
  const cacheKey = `${name}:${dateISO}`;
  if (priceCache[cacheKey] !== undefined) {
    return priceCache[cacheKey];
  }

  const tickerInfo = resolveTickerInfo(name, tickerMap);
  if (!tickerInfo) {
    priceCache[cacheKey] = null;
    return null;
  }

  try {
    await sleep(3000);
    const price = label === "latest"
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

async function processStocks(stocks, dateISO, tickerMap, priceCache, ownerName) {
  if (!stocks?.items || stocks.items.length === 0) return [];

  const results = [];
  const names = [...new Set(stocks.items.map((s) => cleanStockName(s.name)))];
  const disclosurePriceMap = {};
  const latestPriceMap = {};
  const today = todayISO();

  await runWithConcurrency(names, PRICE_FETCH_CONCURRENCY, async (name) => {
    const tickerInfo = resolveTickerInfo(name, tickerMap);
    if (!tickerInfo) {
      console.warn(`  ⚠ No ticker found for: ${name}`);
      disclosurePriceMap[name] = null;
      latestPriceMap[name] = null;
      priceCache[`${name}:${dateISO}`] = null;
      priceCache[`${name}:${today}`] = null;
      return;
    }

    if (dateISO === today) {
      const price = await fetchPriceForName(name, today, tickerMap, priceCache, "latest");
      disclosurePriceMap[name] = price;
      latestPriceMap[name] = price;
      return;
    }

    const [disclosurePrice, latestPrice] = await Promise.all([
      fetchPriceForName(name, dateISO, tickerMap, priceCache, "disclosure"),
      fetchPriceForName(name, today, tickerMap, priceCache, "latest"),
    ]);
    disclosurePriceMap[name] = disclosurePrice;
    latestPriceMap[name] = latestPrice;
  });

  for (const s of stocks.items) {
    const name = cleanStockName(s.name);
    const tickerInfo = resolveTickerInfo(name, tickerMap);
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

  await mkdir(OUT_DIR, { recursive: true });

  const tickerMap = await fetchTickerMap();
  const priceCache = await loadPriceCache();

  const partyMap = JSON.parse(await readFile(path.join(DATA_DIR, "party-mapping.json"), "utf8"));

  const dirs = (await readdir(DATA_DIR)).filter((d) => d.match(/^\d/)).sort();

  let processed = 0;
  let skipped = 0;
  const unmatchedStocks = {}; // cleanName → { count, legislators[], originalNames[] }

  for (const dir of dirs) {
    // Try ordinary first, fall back to correction
    let srcDir = path.join(DATA_DIR, dir, "ordinary");
    let files;
    try {
      files = (await readdir(srcDir)).filter((f) => f.endsWith(".extracted.json"));
    } catch {
      // No ordinary dir — try correction
      srcDir = path.join(DATA_DIR, dir, "correction");
      try {
        files = (await readdir(srcDir)).filter((f) => f.endsWith(".extracted.json"));
      } catch {
        skipped++;
        continue;
      }
    }
    if (files.length === 0) {
      skipped++;
      continue;
    }

    const raw = JSON.parse(await readFile(path.join(srcDir, files[0]), "utf8"));
    const dateISO = rocToISO(raw.date);

    // Use directory name (e.g. "070-陳秀寳" → "陳秀寳") as canonical name,
    // since PDF extraction may drop rare characters
    const canonicalName = dir.replace(/^\d+-/, "");

    console.log(`Processing: ${canonicalName} (${dateISO})`);

    const consolidated = {
      name: canonicalName,
      date: dateISO,
      party: partyMap[canonicalName] || null,
      deposits: processDeposits(raw.deposits),
      depositsTotal: raw.deposits?.total || 0,
      insurance: processInsurance(raw.insurance, canonicalName),
      stocks: [],
      bonds: [],
      fundCertificates: [],
      buildings: processBuildings(raw.buildings),
    };

    const { regularStocks, bonds, fundCertificates } = splitStockLikeAssets(
      raw.stocks,
      raw.funds,
      canonicalName
    );

    consolidated.bonds = bonds;
    consolidated.fundCertificates = fundCertificates;
    consolidated.stocks = skipStockPrices
      ? regularStocks.map((s) => ({
            name: s.name,
            cleanName: cleanStockName(s.name),
            ticker: resolveTickerInfo(cleanStockName(s.name), tickerMap)?.ticker || null,
            shares: s.shares,
            owner: canonicalName,
            priceAtDisclosure: null,
            latestPrice: null,
          }))
      : await processStocks({ items: regularStocks }, dateISO, tickerMap, priceCache, canonicalName);

    // Track unmatched stocks
    for (const s of consolidated.stocks) {
      if (s.ticker === null) {
        const key = s.cleanName;
        if (!unmatchedStocks[key]) {
          unmatchedStocks[key] = { count: 0, legislators: [], originalNames: new Set() };
        }
        unmatchedStocks[key].count++;
        unmatchedStocks[key].originalNames.add(s.name);
        if (!unmatchedStocks[key].legislators.includes(raw.name)) {
          unmatchedStocks[key].legislators.push(raw.name);
        }
      }
    }

    const outFile = path.join(OUT_DIR, `${dir}.json`);
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
      legislators: info.legislators,
    }));
  await writeFile(
    path.join(OUT_DIR, "_unmatched-stocks.json"),
    JSON.stringify(unmatchedReport, null, 2),
  );

  console.log(`\nDone: ${processed} processed, ${skipped} skipped (no ordinary filing)`);
  console.log(
    `Unmatched stocks: ${unmatchedReport.length} unique names (${unmatchedReport.reduce((s, r) => s + r.count, 0)} total entries)`,
  );
  console.log(`Report saved to: data/consolidated/_unmatched-stocks.json`);
}

main().catch(console.error);
