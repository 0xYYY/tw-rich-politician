# tw-rich-olitician-2025

A transparency project that makes Taiwan legislators' financial disclosures accessible and understandable to the public.

The official disclosures are published on the [Control Yuan's platform](https://priso.cy.gov.tw/) as hard-to-navigate PDFs. This project converts them into structured data and presents interesting statistics through an interactive website.

## Data

Financial disclosure data of the 11th Legislative Yuan, sourced from the Control Yuan (監察院廉政專刊).

### Collection

```bash
npm run fetch-pdfs    # Download PDFs from priso.cy.gov.tw
npm run extract-pdfs  # Convert PDFs to structured JSON
```

- Covers 民國113年 (2024) and 民國114年 (2025) filings
- When a legislator has filings in both years, only the newer (114) data is kept

### Structure

```
data/
  {NNN}-{name}/
    ordinary/       # 一般申報 (regular declarations)
    change/         # 變動申報 (change declarations)
    correction/     # 更補正申報 (corrected declarations)
  party-mapping.json  # Legislator name -> party mapping
```

Each subdirectory contains:
- `.pdf` — original declaration file
- `.extracted.json` — structured data extracted from the PDF

### Extracted categories

| Category | Description |
|----------|-------------|
| Land | 土地 |
| Buildings | 建物 |
| Vehicles | 汽車 |
| Deposits | 存款 |
| Stocks | 有價證券 (股票) |
| Investments | 其他投資 |
| Funds | 信託基金 |
| Insurance | 保險 |
| Valuables | 珠寶、古董等 |
| Credits | 債權 |
| Debts | 債務 |
