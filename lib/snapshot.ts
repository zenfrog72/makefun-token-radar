// snapshot.ts — the sealed DefiLlama snapshot: its shape, its parsing, and the one classification
// every part of the entry agrees on. Nothing here scores anything; it names what each protocol is.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Why the snapshot is not one this entry can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all: no market cap, no CoinGecko id, no symbol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

const BRIDGE_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Cross Chain Bridge']);
const STAKING_CATEGORIES = new Set(['Liquid Staking', 'Liquid Restaking']);

/** The one ledger every protocol falls into: the board's accounting of all 758. */
export type LedgerGroup =
  | 'ranked_watchlist'
  | 'ranked_above_floor'
  | 'ranked_early'
  | 'token_priced'
  | 'token_unpriced'
  | 'out_bridge'
  | 'out_staking'
  | 'out_exchange'
  | 'out_versioned';

/**
 * Classify one protocol. Order matters: a protocol that records a token is never ranked; a watchlist
 * slug is always ranked (the house's own rule already kept bridges, staking products, exchanges and
 * versioned names off it, so the watchlist check comes first among the pre-token groups).
 */
export function ledgerGroup(p: SnapshotProtocol, watchlist: Set<string>, floorUsd: number): LedgerGroup {
  if (!isPreToken(p)) return p.mcap_usd !== null && p.tvl_usd > 0 ? 'token_priced' : 'token_unpriced';
  if (watchlist.has(p.slug)) return 'ranked_watchlist';
  if (p.category !== null && BRIDGE_CATEGORIES.has(p.category)) return 'out_bridge';
  if (p.category !== null && STAKING_CATEGORIES.has(p.category)) return 'out_staking';
  if (p.category === 'CEX') return 'out_exchange';
  if (VERSIONED.test(p.name) || WRAPPED_WORD.test(p.name)) return 'out_versioned';
  return p.tvl_usd >= floorUsd ? 'ranked_above_floor' : 'ranked_early';
}

/** Whether the board ranks this protocol: the three ranked groups. */
export function isRanked(group: LedgerGroup): boolean {
  return group === 'ranked_watchlist' || group === 'ranked_above_floor' || group === 'ranked_early';
}

/**
 * Coarse families: the level at which the model first pools protocols before category effects,
 * and the grouping the odds model and the detail view's peer table speak in.
 */
export function familyOf(category: string | null): string {
  switch (category) {
    case 'Dexs':
    case 'Derivatives':
    case 'Basis Trading':
    case 'Synthetics':
      return 'Trading';
    case 'Lending':
    case 'CDP':
      return 'Credit';
    case 'Yield':
    case 'Yield Aggregator':
    case 'Risk Curators':
    case 'Onchain Capital Allocator':
    case 'Leveraged Farming':
    case 'Liquidity Manager':
    case 'Farm':
    case 'Indexes':
      return 'Yield & vaults';
    case 'Liquid Staking':
    case 'Liquid Restaking':
    case 'Staking Pool':
    case 'Restaking':
    case 'Restaked BTC':
    case 'Anchor BTC':
    case 'Decentralized BTC':
      return 'Staking';
    case 'Bridge':
    case 'Canonical Bridge':
    case 'Cross Chain Bridge':
    case 'Chain':
      return 'Chains & bridges';
    case 'RWA':
    case 'Dual-Token Stablecoin':
      return 'RWA & stable';
    case 'CEX':
      return 'Exchange';
    default:
      return 'Other';
  }
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}
