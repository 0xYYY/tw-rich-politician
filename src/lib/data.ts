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

export interface Legislator {
  name: string;
  date: string;
  party: string | null;
  deposits: Deposit[];
  depositsTotal: number;
  insurance?: InsuranceAsset[];
  bonds?: BondAsset[];
  fundCertificates?: FundCertificateAsset[];
  stocks: Stock[];
  buildings: Building[];
}

// Load all consolidated JSON files at build time
const modules = import.meta.glob<Legislator>('../../data/consolidated/[0-9]*.json', { eager: true, import: 'default' });

// Load party mapping to filter to only mapped legislators
const partyMapping = import.meta.glob<Record<string, string>>('../../data/party-mapping.json', { eager: true, import: 'default' });
const partyMap = Object.values(partyMapping)[0] || {};

let _cache: Legislator[] | null = null;

export function getAllLegislators(): Legislator[] {
  if (_cache) return _cache;
  _cache = Object.values(modules).filter(l => l && l.name in partyMap);
  return _cache;
}

export function getPartyColor(party: string | null): string {
  switch (party) {
    case '民主進步黨': return 'var(--color-dpp)';
    case '中國國民黨': return 'var(--color-kmt)';
    case '台灣民眾黨': return 'var(--color-tpp)';
    default: return 'var(--color-independent)';
  }
}

export function getTierColor(ping: number): string {
  if (ping >= 100) return 'var(--color-tier-4)';
  if (ping >= 60) return 'var(--color-tier-3)';
  if (ping >= 30) return 'var(--color-tier-2)';
  return 'var(--color-tier-1)';
}

export function formatAmount(amount: number): string {
  if (amount >= 1_0000_0000) return `${(amount / 1_0000_0000).toFixed(1)} 億`;
  if (amount >= 1_0000) return `${Math.round(amount / 1_0000)} 萬`;
  return amount.toLocaleString();
}

export function formatPing(ping: number): string {
  if (ping >= 1000) return ping.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (ping >= 100) return ping.toFixed(0);
  if (ping >= 10) return ping.toFixed(1);
  return ping.toFixed(2);
}

/** Extract city + district from location string like "臺北市信義區永春段一小段" */
export function parseCity(location: string): { city: string; detail: string } {
  // Match patterns like "臺北市信義區..." or "新北市板橋區..."
  const m = location.match(/^(.+?[市縣])(.+?[區鄉鎮市])(.+)/);
  if (m) return { city: m[1] + m[2], detail: m[3] };
  return { city: location.slice(0, 6), detail: location.slice(6) };
}

export interface RealEstateRanking {
  name: string;
  party: string | null;
  totalPing: number;
  propertyCount: number;
  buildings: Building[];
}

export function getRealEstateRankings(sortBy: 'ping' | 'count' = 'ping'): RealEstateRanking[] {
  const legislators = getAllLegislators();
  const rankings: RealEstateRanking[] = legislators.map(l => ({
    name: l.name,
    party: l.party,
    totalPing: l.buildings.reduce((sum, b) => sum + b.effectiveAreaPing, 0),
    propertyCount: l.buildings.length,
    buildings: l.buildings,
  }));

  if (sortBy === 'ping') {
    rankings.sort((a, b) => b.totalPing - a.totalPing);
  } else {
    rankings.sort((a, b) => b.propertyCount - a.propertyCount || b.totalPing - a.totalPing);
  }

  return rankings;
}

export function getPartyMap(): Record<string, string> {
  return partyMap;
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
  const legislators = getAllLegislators();
  const legislatorMap = new Map(legislators.map(l => [l.name, l]));

  const normalizeCurrency = (currency?: string): string => {
    const c = (currency || '').trim();
    if (!c) return '新臺幣';
    if (c === '新台幣') return '新臺幣';
    return c;
  };

  const entries: DepositRankingEntry[] = [];
  for (const [name, party] of Object.entries(partyMap)) {
    const l = legislatorMap.get(name);
    const byCurrency = new Map<string, number>();

    for (const d of (l?.deposits || [])) {
      const c = normalizeCurrency(d.currency);
      byCurrency.set(c, (byCurrency.get(c) || 0) + (d.amount || 0));
    }
    for (const b of (l?.bonds || [])) {
      const c = normalizeCurrency(b.currency);
      byCurrency.set(c, (byCurrency.get(c) || 0) + (b.declaredValue || 0));
    }
    for (const f of (l?.fundCertificates || [])) {
      const c = normalizeCurrency(f.currency);
      byCurrency.set(c, (byCurrency.get(c) || 0) + (f.declaredValue || 0));
    }

    const mergedDeposits: Deposit[] = Array.from(byCurrency.entries())
      .map(([currency, amount]) => ({ currency, amount }))
      .sort((a, b) => b.amount - a.amount);
    const mergedTotal = mergedDeposits.reduce((sum, d) => sum + d.amount, 0);

    entries.push({
      name,
      party: l?.party || party,
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
    if (!a.hasData && !b.hasData) return a.name.localeCompare(b.name, 'zh-TW');
    return b.depositsTotal - a.depositsTotal;
  });

  return entries;
}
