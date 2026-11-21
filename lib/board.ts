// board.ts — assembly: classify the snapshot, score the ranked protocols, price their farm plans,
// and lay out the two artefacts the entry hands in (board.json's rows and the dashboard's data.js),
// plus the gate's own checks run locally so a bad board never leaves this program.

import { DEFAULT_SCENARIO, farmPlan, gasFor, primaryChain, stepText } from './farm.ts';
import { fitModels, scoreBoard, selectComps, type FittedModels } from './model.ts';
import {
  familyOf,
  isRanked,
  ledgerGroup,
  type LedgerGroup,
  type Snapshot,
  type SnapshotProtocol,
} from './snapshot.ts';
import { fnv1a, roundTo } from './stats.ts';

export const MODEL_VERSION = 'radar-2';

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  token_status: 'pre-token';
  group: LedgerGroup;
  value_if_usd: number;
  token_odds: number;
  implied_value_usd: number;
  p25_usd: number;
  p75_usd: number;
  p10_usd: number;
  p90_usd: number;
  rank_range: [number, number];
  farm_verdict: string;
  farm_net_usd: number;
  farm_steps: string[];
}

export interface PeerView {
  name: string;
  symbol: string | null;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  multiple: number;
  loo_multiple: number;
}

/** One row as data.js carries it: flat fields only, everything the dashboard renders or recomputes. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  family: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  age_years: number;
  group: LedgerGroup;
  value_if: number;
  odds: number;
  implied: number;
  p25: number;
  p75: number;
  p10: number;
  p90: number;
  rank_lo: number;
  rank_hi: number;
  gas_usd: number;
  fees_fixed: number;
  fees_week: number;
  steps: { tag: string; text: string; cost: string; time: string }[];
  peers: PeerView[];
}

const LEDGER_LABEL: Record<LedgerGroup, string> = {
  ranked_watchlist: 'Ranked · watchlist',
  ranked_above_floor: 'Ranked · off-list, above the floor',
  ranked_early: 'Ranked · early, below the floor',
  token_priced: 'Token trades · priced comp',
  token_unpriced: 'Token recorded · no usable cap',
  out_bridge: 'Out · bridge',
  out_staking: 'Out · liquid staking',
  out_exchange: 'Out · exchange',
  out_versioned: 'Out · versioned or wrapped',
};

const LEDGER_ORDER: LedgerGroup[] = [
  'ranked_watchlist',
  'ranked_early',
  'ranked_above_floor',
  'token_priced',
  'token_unpriced',
  'out_bridge',
  'out_staking',
  'out_exchange',
  'out_versioned',
];

/** The nearest priced peers for the detail view: same category first, then same family, by TVL distance. */
function peersFor(p: SnapshotProtocol, snapshot: Snapshot, models: FittedModels): PeerView[] {
  const comps = selectComps(snapshot);
  const lnT = Math.log(Math.max(1, p.tvl_usd));
  const view = (c: (typeof comps)[number]): PeerView => ({
    name: c.p.name,
    symbol: c.p.symbol,
    category: c.p.category,
    tvl_usd: c.p.tvl_usd,
    mcap_usd: c.p.mcap_usd!,
    multiple: roundTo(c.p.mcap_usd! / c.p.tvl_usd, 3),
    loo_multiple: roundTo(models.value.compLooMultiple.get(c.p.slug) ?? c.p.mcap_usd! / c.p.tvl_usd, 3),
  });
  const byDist = (a: (typeof comps)[number], b: (typeof comps)[number]): number =>
    Math.abs(Math.log(a.p.tvl_usd) - lnT) - Math.abs(Math.log(b.p.tvl_usd) - lnT);
  const sameCat = comps.filter((c) => c.p.category === p.category && c.p.slug !== p.slug).sort(byDist);
  const sameFam = comps.filter((c) => c.p.category !== p.category && familyOf(c.p.category) === familyOf(p.category)).sort(byDist);
  return [...sameCat, ...sameFam].slice(0, 8).map(view);
}

export interface BuiltEntry {
  board: BoardRow[];
  radar: Record<string, unknown>;
  models: FittedModels;
}

/** Build the whole entry's data from the snapshot: classification, fits, scores, plans, checksums. */
export function buildEntry(snapshot: Snapshot): BuiltEntry {
  const watchlist = new Set(snapshot.watchlist);
  const groups = new Map<string, LedgerGroup>();
  for (const p of snapshot.protocols) groups.set(p.slug, ledgerGroup(p, watchlist, snapshot.floor_usd));
  const ranked = snapshot.protocols.filter((p) => isRanked(groups.get(p.slug)!));
  const models = fitModels(snapshot);
  const scored = scoreBoard(snapshot, models, ranked);

  const board: BoardRow[] = scored.map((s, i) => {
    const plan = farmPlan({ p: s.p, tvlUsd: s.p.tvl_usd, impliedUsd: s.implied, change7d: s.p.change_7d }, DEFAULT_SCENARIO);
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      listed_at: s.p.listed_at,
      age_days: s.ageDays,
      token_status: 'pre-token',
      group: groups.get(s.p.slug)!,
      value_if_usd: Math.round(s.valueIf),
      token_odds: roundTo(s.odds, 4),
      implied_value_usd: s.implied,
      p25_usd: s.p25,
      p75_usd: s.p75,
      p10_usd: s.p10,
      p90_usd: s.p90,
      rank_range: [s.rankLo, s.rankHi],
      farm_verdict: plan.math.verdict,
      farm_net_usd: Math.round(plan.math.net),
      farm_steps: plan.steps.map(stepText),
    };
  });

  const checksum = fnv1a(board.map((r) => `${r.slug}:${r.implied_value_usd};`).join(''));
  const ledger = LEDGER_ORDER.map((g) => ({
    group: g,
    label: LEDGER_LABEL[g],
    count: snapshot.protocols.filter((p) => groups.get(p.slug) === g).length,
  })).filter((x) => x.count > 0);
  const verdicts = { FARM: 0, MARGINAL: 0, SKIP: 0 };
  for (const r of board) verdicts[r.farm_verdict as keyof typeof verdicts]++;

  const rows: RadarRow[] = scored.map((s, i) => {
    const plan = farmPlan({ p: s.p, tvlUsd: s.p.tvl_usd, impliedUsd: s.implied, change7d: s.p.change_7d }, DEFAULT_SCENARIO);
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      family: familyOf(s.p.category),
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      listed_at: s.p.listed_at,
      age_days: s.ageDays,
      age_years: roundTo(s.ageYears, 4),
      group: groups.get(s.p.slug)!,
      value_if: Math.round(s.valueIf),
      odds: roundTo(s.odds, 4),
      implied: s.implied,
      p25: s.p25,
      p75: s.p75,
      p10: s.p10,
      p90: s.p90,
      rank_lo: s.rankLo,
      rank_hi: s.rankHi,
      gas_usd: gasFor(primaryChain(s.p)),
      fees_fixed: plan.math.feesFixed,
      fees_week: plan.math.feesPerWeek,
      steps: plan.steps,
      peers: peersFor(s.p, snapshot, models),
    };
  });

  const v = models.value;
  const o = models.odds;
  const radar: Record<string, unknown> = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    checksum,
    totals: { implied_sum: board.reduce((s, r) => s + r.implied_value_usd, 0), rows: board.length },
    kpis: {
      wf_miss: roundTo(v.wfMiss, 2),
      flat_wf_miss: roundTo(v.flatWfMiss, 2),
      loo_miss: roundTo(v.looMiss, 2),
      flat_loo_miss: roundTo(v.flatLooMiss, 2),
      honesty_p2575_wf: Math.round(v.honesty.p2575Wf * 100),
      honesty_p1090_wf: Math.round(v.honesty.p1090Wf * 100),
      honesty_p2575_loo: Math.round(v.honesty.p2575Loo * 100),
      honesty_p1090_loo: Math.round(v.honesty.p1090Loo * 100),
      odds_brier_wf: roundTo(o.brierWf, 3),
      odds_base_brier_wf: roundTo(o.baseBrierWf, 3),
      odds_brier_tenfold: roundTo(o.brierTenfold, 3),
      value_terms_kept: v.kept.length,
      value_terms_tested: 6,
      odds_terms_kept: o.kept.length,
      odds_terms_tested: 5,
      farm_count: verdicts.FARM,
      marginal_count: verdicts.MARGINAL,
      skip_count: verdicts.SKIP,
      watchlist_ranked: board.filter((r) => r.group === 'ranked_watchlist').length,
      watchlist_size: snapshot.watchlist.length,
      protocols: snapshot.protocols.length,
    },
    ledger,
    value: {
      kept: v.kept,
      intercept: v.intercept,
      ln_tvl: v.lnTvl,
      growth: v.growth,
      age: v.age,
      chains: v.chains,
      family_effects: v.familyEffects,
      category_effects: v.categoryEffects,
      flat_multiple: v.flatMultiple,
      multiple_at_100m: v.multipleAt100m,
      comps_used: v.compsUsed,
      resid_q: v.residQ,
      ladder: v.ladder,
    },
    odds: {
      kept: o.kept,
      beta: o.beta,
      base_rate: roundTo(o.baseRate, 6),
      peers: o.peers,
      family_rate: o.familyRate,
      a_max_years: roundTo(o.aMaxYears, 4),
      median_age_years: roundTo(models.medianAgeYears, 4),
      ladder: o.ladder.map((r) => ({ ...r, tenfold: roundTo(r.tenfold, 4), wf: roundTo(r.wf, 4), tenfoldCalled: Math.round(r.tenfoldCalled * 100), wfCalled: Math.round(r.wfCalled * 100) })),
    },
    scenario: DEFAULT_SCENARIO,
    rows,
  };
  return { board, radar, models };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, steps, values. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  const ordered = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i]!.implied_value_usd > ordered[i - 1]!.implied_value_usd) return `row ${ordered[i]!.slug} outranks ${ordered[i - 1]!.slug} on implied value`;
  }
  if (board.length >= 2 && ordered[0]!.implied_value_usd === ordered[ordered.length - 1]!.implied_value_usd) return 'all rows share one implied value';
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: Record<string, unknown>): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
