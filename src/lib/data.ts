export interface Building {
  location: string;
  owner: string;
  date: string | null;
  effectiveAreaPing: number;
  entryCount: number;
  price: string | null;
}

export interface Stock {
  name: string;
  cleanName: string;
  ticker: string | null;
  shares: number;
  owner: string;
  priceAtDisclosure: number | null;
  latestPrice: number | null;
}

export interface Deposit {
  currency: string;
  amount: number;
}

export interface BondAsset {
  name: string;
  owner: string;
  declaredValue: number;
  currency?: string;
}

export interface FundCertificateAsset {
  name: string;
  owner: string;
  declaredValue: number;
  currency?: string;
}

export interface InsuranceAsset {
  company: string;
  name: string;
  holder: string;
  contractType: string;
}

export interface PersonData {
  name: string;
  date: string;
  type?: "legislator" | "mayor" | null;
  area?: string | null;
  party: string | null;
  deposits: Deposit[];
  depositsTotal: number;
  insurance?: InsuranceAsset[];
  bonds?: BondAsset[];
  fundCertificates?: FundCertificateAsset[];
  stocks: Stock[];
  buildings: Building[];
}

// Keep Legislator as alias for backwards compatibility
export type Legislator = PersonData;

export interface PersonInfo {
  type: "legislator" | "mayor";
  party: string;
  area: string;
}

// Load per-person consolidated JSON files at build time.
const plainModules = import.meta.glob<PersonData>("../../data/*/consolidated.json", {
  eager: true,
  import: "default",
});
const modules = { ...plainModules };

// Load people mapping
const peopleMappingModules = import.meta.glob<Record<string, PersonInfo>>(
  "../../data/people-mapping.json",
  { eager: true, import: "default" },
);
const peopleMap: Record<string, PersonInfo> = Object.values(peopleMappingModules)[0] || {};

let _cache: PersonData[] | null = null;

function getStockDataCompletenessScore(person: PersonData): number {
  const stocks = person.stocks || [];
  const latestCount = stocks.reduce((sum, s) => sum + (s.latestPrice != null ? 1 : 0), 0);
  const disclosureCount = stocks.reduce((sum, s) => sum + (s.priceAtDisclosure != null ? 1 : 0), 0);
  // Prefer records with more priced stocks; use stock count as a weak tie-breaker.
  return latestCount * 10 + disclosureCount * 3 + stocks.length;
}

export function getAllPeople(): PersonData[] {
  if (_cache) return _cache;
  const bestByName = new Map<string, PersonData>();
  for (const person of Object.values(modules)) {
    if (!person || !(person.name in peopleMap)) continue;
    const existing = bestByName.get(person.name);
    if (!existing) {
      bestByName.set(person.name, person);
      continue;
    }
    if (person.date > existing.date) {
      bestByName.set(person.name, person);
      continue;
    }
    if (person.date === existing.date) {
      const personScore = getStockDataCompletenessScore(person);
      const existingScore = getStockDataCompletenessScore(existing);
      if (personScore > existingScore) bestByName.set(person.name, person);
    }
  }
  _cache = Array.from(bestByName.values()).map((person) => ({
    ...person,
    type: peopleMap[person.name]?.type || person.type || null,
    area: peopleMap[person.name]?.area || person.area || null,
    party: peopleMap[person.name]?.party || person.party || null,
  }));
  return _cache;
}

// Keep getAllLegislators as alias
export function getAllLegislators(): PersonData[] {
  return getAllPeople();
}

export function getPeopleMap(): Record<string, PersonInfo> {
  return peopleMap;
}

// Keep getPartyMap for backwards compatibility
export function getPartyMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [name, info] of Object.entries(peopleMap)) {
    map[name] = info.party;
  }
  return map;
}

export function getPersonInfo(name: string): PersonInfo | null {
  return peopleMap[name] || null;
}

export function getPartyColor(party: string | null): string {
  switch (party) {
    case "民主進步黨":
      return "var(--color-dpp)";
    case "中國國民黨":
      return "var(--color-kmt)";
    case "台灣民眾黨":
      return "var(--color-tpp)";
    default:
      return "var(--color-independent)";
  }
}

export function getPartyAreaTextColor(party: string | null): string {
  switch (party) {
    case "民主進步黨":
      return "#103d1d";
    case "中國國民黨":
      return "#dbe3ff";
    case "台灣民眾黨":
      return "#083d3a";
    default:
      return "#1f2436";
  }
}

export function getPartyNameTextColor(party: string | null): string {
  switch (party) {
    case "民主進步黨":
      return "var(--color-dpp)";
    case "中國國民黨":
      return "#7aa2f7";
    case "台灣民眾黨":
      return "var(--color-tpp)";
    default:
      return "var(--color-independent)";
  }
}

export function getPartyShortName(party: string | null): string {
  switch (party) {
    case "民主進步黨":
      return "民";
    case "中國國民黨":
      return "國";
    case "台灣民眾黨":
      return "眾";
    case "無黨籍":
      return "無";
    default:
      return "無";
  }
}

export function getPartyBgColor(party: string | null): string {
  switch (party) {
    case "民主進步黨":
      return "var(--color-dpp)";
    case "中國國民黨":
      return "var(--color-kmt)";
    case "台灣民眾黨":
      return "var(--color-tpp)";
    default:
      return "var(--color-independent)";
  }
}

export function getTierColor(ping: number): string {
  if (ping >= 100) return "var(--color-tier-4)";
  if (ping >= 60) return "var(--color-tier-3)";
  if (ping >= 30) return "var(--color-tier-2)";
  return "var(--color-tier-1)";
}

export function formatAmount(amount: number): string {
  if (amount >= 1_0000_0000) {
    return `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(amount / 1_0000_0000)} 億`;
  }
  if (amount >= 1_0000) return `${Math.round(amount / 1_0000).toLocaleString("en-US")} 萬`;
  return amount.toLocaleString("en-US");
}

export function formatPing(ping: number): string {
  if (ping >= 100) return ping.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (ping >= 10)
    return ping.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return ping.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function normalizePropertyLocationText(raw: string): string {
  return (
    raw
      .replace(/\r?\n/g, " ")
      .replace(/\s+/g, " ")
      // OCR line-break artifacts inside CJK text should not be kept.
      .replace(/([○\u4e00-\u9fff])\s+(?=[○\u4e00-\u9fff])/g, "$1")
      .replace(/([○\u4e00-\u9fff])\s+([（(])/g, "$1$2")
      .replace(/([：:])\s+/g, "$1")
      .replace(/未交付\s+信託原因/g, "未交付信託原因")
      .trim()
  );
}

function stripPropertyDisplayNotes(raw: string): string {
  return raw
    .replace(/[（(]\s*稅籍號碼[:：][^）)]*[）)]/g, "")
    .replace(/[（(]\s*未交付信託原因[:：][^）)]*[）)]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract city + district from location string like "臺北市信義區永春段一小段" */
export function parseCity(location: string): { city: string; detail: string } {
  const normalized = normalizePropertyLocationText(location);
  const cleaned = stripPropertyDisplayNotes(normalized);
  const m = cleaned.match(/^(.+?[市縣])(.+?[區鄉鎮市])(.+)/);
  if (m) return { city: m[1] + m[2], detail: m[3] };
  return { city: cleaned.slice(0, 6), detail: cleaned.slice(6) };
}

export interface RealEstateRanking {
  name: string;
  party: string | null;
  totalPing: number;
  propertyCount: number;
  buildings: Building[];
}

export function getRealEstateRankings(sortBy: "ping" | "count" = "ping"): RealEstateRanking[] {
  const people = getAllPeople();
  const rankings: RealEstateRanking[] = people.map((l) => ({
    name: l.name,
    party: l.party,
    totalPing: l.buildings.reduce((sum, b) => sum + b.effectiveAreaPing, 0),
    propertyCount: l.buildings.length,
    buildings: l.buildings,
  }));

  if (sortBy === "ping") {
    rankings.sort((a, b) => b.totalPing - a.totalPing);
  } else {
    rankings.sort((a, b) => b.propertyCount - a.propertyCount || b.totalPing - a.totalPing);
  }

  return rankings;
}

export interface DepositRankingEntry {
  name: string;
  party: string | null;
  depositsTotal: number;
  deposits: Deposit[];
  insuranceCount: number;
  hasData: boolean;
}

export function getDepositRankings(): DepositRankingEntry[] {
  const people = getAllPeople();
  const personMap = new Map(people.map((l) => [l.name, l]));

  const normalizeCurrency = (currency?: string): string => {
    const c = (currency || "").trim();
    if (!c) return "新臺幣";
    if (c === "新台幣") return "新臺幣";
    return c;
  };

  const entries: DepositRankingEntry[] = [];
  for (const [name, info] of Object.entries(peopleMap)) {
    const l = personMap.get(name);
    const byCurrency = new Map<string, number>();

    for (const d of l?.deposits || []) {
      const c = normalizeCurrency(d.currency);
      byCurrency.set(c, (byCurrency.get(c) || 0) + (d.amount || 0));
    }
    for (const b of l?.bonds || []) {
      const c = normalizeCurrency(b.currency);
      byCurrency.set(c, (byCurrency.get(c) || 0) + (b.declaredValue || 0));
    }
    for (const f of l?.fundCertificates || []) {
      const c = normalizeCurrency(f.currency);
      byCurrency.set(c, (byCurrency.get(c) || 0) + (f.declaredValue || 0));
    }

    const mergedDeposits: Deposit[] = Array.from(byCurrency.entries())
      .map(([currency, amount]) => ({ currency, amount }))
      .sort((a, b) => b.amount - a.amount);
    const mergedTotal = mergedDeposits.reduce((sum, d) => sum + d.amount, 0);

    entries.push({
      name,
      party: l?.party || info.party,
      depositsTotal: mergedTotal,
      deposits: mergedDeposits,
      insuranceCount: l?.insurance?.length || 0,
      hasData: !!l,
    });
  }

  // Sort: those with data by depositsTotal desc, then those without data alphabetically
  entries.sort((a, b) => {
    if (a.hasData && !b.hasData) return -1;
    if (!a.hasData && b.hasData) return 1;
    if (!a.hasData && !b.hasData) return a.name.localeCompare(b.name, "zh-TW");
    return b.depositsTotal - a.depositsTotal;
  });

  return entries;
}
