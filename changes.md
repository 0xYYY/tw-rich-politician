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
