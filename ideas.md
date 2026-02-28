# Ideas for Future Improvements

## Engagement & Virality
- **Social sharing cards**: Generate OG images per person showing key stats (total deposits, stock value, properties) for easy sharing on social media
- **"比一比" comparison mode**: Let users pick 2-3 politicians side by side and compare across all categories
- **Quiz mode**: "猜猜誰的存款最多？" — gamified quiz that reveals answers with animations
- **Wealth timeline**: If historical filings become available, show how each person's wealth changes over time
- **"我的選區" filter**: Let users pick their city/district and only see politicians relevant to them

## Data Quality
- **Manual correction system**: Allow community submissions for OCR errors in extracted data, with review workflow
- **Trust PDF parsing**: Improve extraction accuracy for trust filings (currently ~40% error rate)
- **Cross-referencing**: Compare declared stock holdings against actual company shareholder disclosures (公開資訊觀測站)
- **Currency conversion**: Real-time conversion of foreign currency deposits to TWD for accurate totals

## Features
- **Individual profile pages**: Dedicated page per politician with all their asset details, party info, constituency
- **Land/vehicle data**: Add land (土地) and vehicle (汽車) categories that exist in source data but aren't shown yet
- **Debt data**: Show declared debts (債務) alongside assets for a more complete picture
- **Party aggregates**: Summary statistics per party (average wealth, total real estate, etc.)
- **Search across all pages**: Global search bar that finds people across deposits, stocks, real estate
- **Data export**: CSV/Excel download option in addition to JSON

## Technical
- **Incremental builds**: Only re-extract/consolidate changed PDFs instead of full pipeline
- **API layer**: Add a simple JSON API endpoint for programmatic access to the data
- **PWA support**: Add service worker for offline access and app-like experience
- **Accessibility**: Full keyboard navigation, screen reader labels, high contrast mode
- **i18n**: English language option for international researchers

## Visual & UX
- **Dark mode**: Respect system preference with manual toggle
- **Map visualization**: Show real estate locations on a Taiwan map
- **Treemap view**: Visualize wealth composition as a treemap (deposits vs stocks vs real estate)
- **Party color legend**: Persistent legend explaining party color coding
- **Loading skeletons**: Better perceived performance with skeleton screens during data load
