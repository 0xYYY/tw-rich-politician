# Project: tw-rich-olitician-2025

A transparency project that makes Taiwan legislators' (第11屆立法委員) financial disclosures accessible and understandable to the public. Data is sourced from the Control Yuan (監察院廉政專刊) and presented through an interactive Astro website.

## Language

All user-facing UI text must be in Traditional Chinese as used in Taiwan (zh-TW).

## Design

- Mobile-first design (390px width as default)

## Tech Stack

- Astro (static site framework)
- Cloudflare (deployment via wrangler)

## Data

- Financial disclosure data lives in `data/` directories per legislator
- Categories: 土地, 建物, 汽車, 存款, 有價證券, 其他投資, 信託基金, 保險, 珠寶古董, 債權, 債務
- Party mapping in `data/party-mapping.json`
