# tw-rich-olitician-2025

A transparency project that turns Taiwan political financial disclosure PDFs into structured, searchable data and an interactive website.

Official disclosures are published by the Control Yuan and should always be treated as the source of truth:
- https://priso.cy.gov.tw/layout/baselist

## What This Site Includes

| Route | Page |
|---|---|
| `/` | Overview and entry points |
| `/deposits` | Deposit ranking (includes deposits, bonds, and fund certificates) |
| `/stocks` | Stock holdings and estimated return |
| `/real-estate` | Real-estate records and effective area |
| `/download` | Download original PDFs and parsed JSON files |

Search supports:
- Name
- Area (選區/縣市)
- `台` / `臺` are treated as equivalent in search

## Tech Stack

- Astro 5
- React (islands for interactive components)
- Tailwind CSS
- Cloudflare Pages deployment (Wrangler)
- Data pipeline scripts in Node.js

## Quick Start

### 1) Install

```bash
npm ci
```

### 2) Start local dev server

```bash
npm run dev
```

### 3) Build

```bash
npm run build
```

### 4) Preview built site

```bash
npm run preview
```

### 5) Deploy manually

```bash
npm run deploy
```

## NPM Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start local Astro dev server |
| `npm run build` | Build site (runs `sync-public-data` first) |
| `npm run preview` | Preview production build |
| `npm run deploy` | Build + deploy to Cloudflare Pages |
| `npm run fetch-pdfs` | Fetch source PDF + metadata from Control Yuan |
| `npm run extract-pdfs` | Parse downloaded PDFs into structured JSON |
| `npm run consolidate` | Consolidate person-level data and refresh stock prices |
| `npm run consolidate:skip-prices` | Consolidate without refreshing stock prices |
| `npm run update-latest-prices` | Refresh latest stock prices only |
| `npm run sync-public-data` | Copy `data/` to `public/data/` for downloadable links |

## Data Pipeline

### Prerequisites

- Node dependencies installed (`npm ci`)
- Java runtime available for PDF extraction (`npm run extract-pdfs`)
- Network access to `https://priso.cy.gov.tw` for fetch

### Full pipeline (fetch -> extract -> consolidate -> build)

```bash
npm run fetch-pdfs
npm run extract-pdfs
npm run consolidate
npm run build
```

### If PDFs are already downloaded (extract + consolidate only)

```bash
npm run extract-pdfs
npm run consolidate
```

### Refresh latest stock prices only (no extract/consolidate)

```bash
npm run update-latest-prices
```

This updates:
- `data/*/consolidated.json` (`latestPrice` fields)
- `data/stock-price-cache.json`

### Outputs by stage

1) `fetch-pdfs`
- `data/{name}/{code}/original.pdf`
- `data/{name}/{code}/metadata.json`

2) `extract-pdfs`
- `data/{name}/{code}/extracted.json`

3) `consolidate`
- `data/{name}/consolidated.json`
- `data/_unmatched-stocks.json`

4) `build` / `dev` (via pre-script)
- Syncs `data/` into `public/data/`

## Data Rules and Assumptions

- Coverage: 民國113年 (2024) and 民國114年 (2025) filings
- Duplicate filings for same person and type: newer period is kept
- Consolidation priority:
  - `01` (一般申報) is primary when available
  - `04` trust data is merged
  - `09` (變動申報) is excluded from consolidation
- Displayed calculations include applicant, spouse, and underaged children
- Stock return calculation assumes holdings continue from disclosure date to latest price date

## Data Directory Structure

```text
data/
  {name}/
    {code}/
      original.pdf
      metadata.json
      extracted.json
    consolidated.json
  _unmatched-stocks.json
  _unmatched-stock-ticker-review.json
  people-mapping.json
  stock-ticker-map.json
  stock-ticker-overrides.json
  stock-price-cache.json
```

`{code}` is the 2-digit disclosure type from `PublishType` (for example `01`, `04`, `09`).

Ticker resolution priority during consolidate:
1. `data/stock-ticker-overrides.json` (manual alias/override)
2. `data/stock-ticker-map.json` (cached TWSE/TPEx symbol map)

## Deployment and Automation

### Downloadable `/data` assets on deployed site

`npm run sync-public-data` runs automatically before both:
- `npm run dev`
- `npm run build`

So `/data/...` links in the download page are available after deploy.

### Daily stock price refresh (08:00 UTC+8)

Workflow:
- `.github/workflows/daily-stock-price-refresh.yml`
- Cron: `0 0 * * *` (UTC) = UTC+8 08:00

Job behavior:
1. `npm ci`
2. Validate `data/*/consolidated.json` exists
3. `npm run update-latest-prices`
4. `npm run build`
5. Deploy to Cloudflare Pages

Required repository secrets:
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

## Troubleshooting

### `extract-pdfs` says Java runtime is missing

Check:

```bash
java -version
```

If Java is installed via Homebrew but not on PATH (Apple Silicon common case):

```bash
export PATH="/opt/homebrew/opt/openjdk@21/bin:$PATH"
```

Then re-run:

```bash
npm run extract-pdfs
```

### `extract-pdfs` reports many `ENOENT ... .tmp-extract/...json`

Usually the PDF conversion step failed (often Java/path issue).  
Fix Java first, then run extraction again.

### Daily price workflow fails with “No consolidated JSON found”

This workflow only refreshes latest prices.  
You must have existing `data/*/consolidated.json` files in the repository.
