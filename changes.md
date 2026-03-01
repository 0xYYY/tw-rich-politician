# Changes Log

## 2026-03-01: Full mayor + legislator refactor (data + website)

### Data pipeline
- `scripts/fetch-pdfs.mjs`
  - Added strict filtering by `people-mapping.json` so only tracked people are fetched.
  - Legislator query now enforces `Title === "立法委員"`.
  - Mayor query enforces `Title === "市長"` (excludes 副市長).
  - Dedup logic changed to keep the latest filing per `person + publish type code` (e.g. 01/02/04/09/11), while still fetching all filing kinds.
- `scripts/consolidate.mjs`
  - Added stronger trust-merge heuristics (stocks/deposits/buildings/funds) using normalized composite keys to avoid duplicate merge-in.
  - Consolidated output now includes `type` and `area` fields from `people-mapping.json`.
  - Canonicalized output selection: for duplicate directories of the same person, only the latest filing is selected for final canonical output.
  - `--skip-prices` no longer fetches remote ticker map.
- `src/lib/data.ts`
  - Added de-duplication by person name at load time and keep the latest dated record.
  - Backfills `type`, `area`, `party` from people mapping into loaded consolidated objects.

### Mapping updates
- Refreshed `data/people-mapping.json` semantics to reflect current mayor context from wiki references while preserving recent-ended members requested by user.
- Added compatibility alias for the variant name `張啟楷` / `張啓楷`.

### Website refactor
- Added shared components:
  - `src/components/PersonMeta.astro`: party icon + role icon + area compact tooltip chip beside names.
  - `src/components/InfoPopover.astro`: reusable `ℹ 了解更多` caveat popover.
- `src/layouts/Layout.astro`
  - Reworked navigation into modern sticky glass segmented tabs with icon+label and active-state highlighting.
- `src/styles/global.css`
  - Added shared UI styles for page headline rows, popovers, person meta chips, and refreshed typography/background.
- Page updates:
  - `src/pages/index.astro`: strengthened global caveats wording (spouse/children inclusion, PDF parsing limitations, official-PDF-first disclaimer).
  - `src/pages/deposits.astro`: renamed page framing to 流動資產; added page caveat popover; integrated new person metadata chip.
  - `src/pages/stocks.astro`: added caveat popover; integrated person metadata chips in list and expanded holder rows; upgraded control toggle styling.
  - `src/pages/real-estate.astro`: added caveat popover; integrated person metadata chip; upgraded sort toggle style.
  - `src/pages/download.astro`: added caveat popover; person metadata chip on names; strengthened canonical consolidated JSON selection preference.

### Verification and run status
- `npm run build`: passed.
- `npm run fetch-pdfs`: failed in sandbox due DNS/network restriction (`ENOTFOUND priso.cy.gov.tw`).
- `npm run extract-pdfs`: ran but all conversions failed due missing Java runtime (`@opendataloader/pdf` backend dependency).
- `npm run consolidate:skip-prices`: completed with latest-selection pipeline and trust merge heuristics.
- Screenshot verification: attempted, but sandbox blocks serving local ports and no preinstalled headless browser binary is available.
