# Changes Log

## 2026-03-01: Add mayor support to data pipeline

### Data
- Created `data/people-mapping.json` with unified mapping for all 112 legislators + 22 mayors
  - Each entry has `type` (legislator/mayor), `party`, and `area`
  - Includes 6 former TPP legislators (黃珊珊, 黃國昌, 麥玉珍, 林國成, 林憶君, 張啓楷)

### Scripts
- **fetch-pdfs.mjs**: Now fetches both legislator and mayor financial disclosures from Control Yuan API. Filters mayors to exclude 副市長. Handles trust (信託) PDFs in separate subdirectory.
- **consolidate.mjs**: Uses people-mapping.json instead of party-mapping.json. Merges trust PDF data with ordinary filings using overlap-avoidance heuristics (checks by stock cleanName, deposit institution+currency+owner, building location+area+owner). Processes all directory types (not just numbered).

### Source
- **data.ts**: New `PersonData` and `PersonInfo` types. Loads both numbered and plain-name consolidated JSON. New exports: `getAllPeople()`, `getPeopleMap()`, `getPersonInfo()`, `getPartyShortName()`, `getPartyBgColor()`. Backwards-compatible aliases maintained.

## 2026-03-01: Website UI overhaul

### New: Landing page (`/`)
- New main landing page with project description, stats, navigation cards linking to 4 data pages
- Caveats section covering data source, limitations, trust merging, stock valuation disclaimers
- Footer with source attribution

### Navigation
- Replaced bottom tab bar with top nav bar (frosted glass style, compact tabs)
- Home icon links back to landing page
- `showNav` prop on Layout to hide nav on landing page

### Page updates
- Deposits page moved from `/` to `/deposits`
- All page titles now include emoji (💰 📈 🏠 📥)
- All "立委" references changed to inclusive language (covers both legislators and mayors)
- Person badges added next to names on deposits, stocks, real-estate pages (party-colored pill with type indicator)
- Download page: grouped by type (立法委員/縣市首長) then by party; removed country flag emoji; added people-mapping.json bulk download link
- Stocks page: updated to use `getAllPeople`/`getPeopleMap` instead of deprecated aliases
