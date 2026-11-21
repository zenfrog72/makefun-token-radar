// model.ts — the radar's fitted model: a value model and a launch-odds model, each term kept only
// if it lowers the held-out miss in two different tests, each number on the dashboard traceable to
// a fit on the snapshot's own rows. No protocol name is ever special-cased.
//
// Value:  ln(cap) is fitted on the traded tokens that carry a cap, a TVL, a sane cap/TVL ratio and
//         a listing date. Terms enter in a fixed order — size curve, family, category, growth, age,
//         chain count, and a placebo control — and a term stays only if it lowers the multiplicative
//         miss both leave-one-out and walk-forward (fit on the earlier-listed, tested on the later).
// Odds:   a logistic model on the peers (protocols listed at least a year before the snapshot),
//         outcome "records a token", validated by ten-fold and walk-forward Brier scores under the
//         same keep rule. A board row's odds are read off the fitted curve conditionally: the share
//         of like peers that record a token by the oldest cohort's age, given none by its own age.

import { ageDays, familyOf, isPreToken, type Snapshot, type SnapshotProtocol } from './snapshot.ts';
import { brier, fitLinear, fitLogistic, median, missFactor, quantile, rng, roundTo, type LinearFit } from './stats.ts';

/** Growth as the model reads it: the 7-day change in per cent, winsorised, as a fraction. */
export function growthFeature(change7d: number | null): number {
  const pct = change7d === null || !Number.isFinite(change7d) ? 0 : Math.min(120, Math.max(-60, change7d));
  return pct / 100;
}

/** A traded token usable as a pricing comp: cap and TVL present, ratio sane, listing date known. */
export interface Comp {
  p: SnapshotProtocol;
  lnTvl: number;
  lnCap: number;
  ageYears: number;
  listedAt: string;
}

const RATIO_MIN = 0.002;
const RATIO_MAX = 500;

export function selectComps(snapshot: Snapshot): Comp[] {
  const comps: Comp[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0 || p.listed_at === null) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (ratio < RATIO_MIN || ratio > RATIO_MAX) continue;
    const age = ageDays(snapshot.as_of, p.listed_at);
    if (age === null) continue;
    comps.push({ p, lnTvl: Math.log(p.tvl_usd), lnCap: Math.log(p.mcap_usd), ageYears: age / 365, listedAt: p.listed_at });
  }
  comps.sort((a, b) => (a.p.slug < b.p.slug ? -1 : 1));
  return comps;
}

// ---------------------------------------------------------------------------
// The value model's term ladder
// ---------------------------------------------------------------------------

type ValueTerm = 'size' | 'family' | 'category' | 'growth' | 'age' | 'chains' | 'control';

const VALUE_TERM_LABEL: Record<ValueTerm, string> = {
  size: '+ size curve, ln TVL',
  family: '+ family effect · ridge 16',
  category: '+ category effect · ridge 64',
  growth: '+ 7-day TVL growth',
  age: '+ age, years listed',
  chains: '+ chain count, ln',
  control: '+ control: growth of another row',
};

export interface LadderRow {
  term: string;
  loo: number;
  wf: number;
  verdict: 'baseline' | 'kept' | 'tested, not kept' | 'must not help';
}

/** The design matrix for a set of active terms over the comps, with ridge penalties per column. */
function valueDesign(comps: Comp[], terms: ValueTerm[], families: string[], categories: string[]): { X: number[][]; penalty: number[]; columns: string[] } {
  const columns: string[] = ['intercept', 'lnTvl'];
  if (terms.includes('family')) for (const f of families) columns.push(`fam:${f}`);
  if (terms.includes('category')) for (const c of categories) columns.push(`cat:${c}`);
  if (terms.includes('growth')) columns.push('growth');
  if (terms.includes('age')) columns.push('age');
  if (terms.includes('chains')) columns.push('chains');
  if (terms.includes('control')) columns.push('control');
  const penOf = (col: string): number => (col.startsWith('fam:') ? 16 : col.startsWith('cat:') ? 64 : 0);
  // The placebo: each comp is handed the growth of the comp 37 places later in slug order.
  const placebo = comps.map((_, i) => growthFeature(comps[(i + 37) % comps.length]!.p.change_7d));
  const X = comps.map((c, i) =>
    columns.map((col) => {
      if (col === 'intercept') return 1;
      if (col === 'lnTvl') return c.lnTvl;
      if (col.startsWith('fam:')) return familyOf(c.p.category) === col.slice(4) ? 1 : 0;
      if (col.startsWith('cat:')) return (c.p.category ?? '') === col.slice(4) ? 1 : 0;
      if (col === 'growth') return growthFeature(c.p.change_7d);
      if (col === 'age') return c.ageYears;
      if (col === 'chains') return Math.log(Math.max(1, c.p.chains.length));
      if (col === 'control') return placebo[i]!;
      return 0;
    }),
  );
  return { X, penalty: columns.map(penOf), columns };
}

export interface ValueModel {
  /** Terms the dual test kept, in ladder order. */
  kept: ValueTerm[];
  ladder: LadderRow[];
  compsUsed: number;
  /** Final coefficients, rounded to 6 dp: the exact numbers the dashboard recomputes with. */
  intercept: number;
  lnTvl: number;
  growth: number;
  age: number;
  chains: number;
  familyEffects: Record<string, number>;
  categoryEffects: Record<string, number>;
  /** The flat median cap/TVL multiple, and the fitted multiple read at $100M of TVL. */
  flatMultiple: number;
  multipleAt100m: number;
  /** Residual quantiles of the final fit (ln space), for the printed ranges. */
  residQ: { q10: number; q25: number; q75: number; q90: number };
  looMiss: number;
  wfMiss: number;
  flatLooMiss: number;
  flatWfMiss: number;
  /** Share of real caps inside the printed ranges, leave-one-out and walk-forward. */
  honesty: { p2575Loo: number; p2575Wf: number; p1090Loo: number; p1090Wf: number };
  /** Each comp's leave-one-out model multiple (cap/TVL), for the detail view's peer table. */
  compLooMultiple: Map<string, number>;
  /** Predict ln(cap) for any protocol-shaped input, with the rounded coefficients. */
  predictLn: (p: SnapshotProtocol, asOf: string, ageYears?: number) => number;
}

function fitValueModel(snapshot: Snapshot): ValueModel {
  const comps = selectComps(snapshot);
  const y = comps.map((c) => c.lnCap);
  const families = [...new Set(comps.map((c) => familyOf(c.p.category)))].sort();
  const categories = [...new Set(comps.map((c) => c.p.category ?? ''))].sort();
  // Walk-forward: three expanding origins over the listing-date order — fit the earliest 50%, 65%
  // and 80% in turn, predict the next slice each time, and pool every out-of-sample prediction.
  const byDate = [...comps].sort((a, b) => (a.listedAt < b.listedAt ? -1 : a.p.slug < b.p.slug ? -1 : 1));
  const ORIGINS = [0.5, 0.65, 0.8];
  const wfChunks = ORIGINS.map((o, i) => {
    const from = Math.floor(byDate.length * o);
    const to = i + 1 < ORIGINS.length ? Math.floor(byDate.length * ORIGINS[i + 1]!) : byDate.length;
    return { train: byDate.slice(0, from), test: byDate.slice(from, to) };
  });

  const flat = (() => {
    const ratios = comps.map((c) => Math.exp(c.lnCap - c.lnTvl));
    const med = median(ratios);
    const looPred = comps.map((c, i) => {
      const rest = ratios.filter((_, j) => j !== i);
      return c.lnTvl + Math.log(median(rest));
    });
    const wfPred: number[] = [];
    const wfActual: number[] = [];
    for (const chunk of wfChunks) {
      const m = median(chunk.train.map((c) => Math.exp(c.lnCap - c.lnTvl)));
      for (const c of chunk.test) {
        wfPred.push(c.lnTvl + Math.log(m));
        wfActual.push(c.lnCap);
      }
    }
    return { med, looMiss: missFactor(looPred, y), wfMiss: missFactor(wfPred, wfActual) };
  })();

  const evaluate = (terms: ValueTerm[]): { loo: number; wf: number; fit: LinearFit; columns: string[] } => {
    const { X, penalty, columns } = valueDesign(comps, terms, families, categories);
    const fit = fitLinear(X, y, penalty);
    const loo = missFactor(comps.map((_, i) => fit.looPredict(i)), y);
    const wfPred: number[] = [];
    const wfActual: number[] = [];
    for (const chunk of wfChunks) {
      const trainDesign = valueDesign(chunk.train, terms, families, categories);
      const trainFit = fitLinear(trainDesign.X, chunk.train.map((c) => c.lnCap), trainDesign.penalty);
      const testDesign = valueDesign(chunk.test, terms, families, categories);
      chunk.test.forEach((c, j) => {
        wfPred.push(trainFit.predict(testDesign.X[j]!));
        wfActual.push(c.lnCap);
      });
    }
    return { loo, wf: missFactor(wfPred, wfActual), fit, columns };
  };

  const ladder: LadderRow[] = [{ term: 'flat median multiple', loo: flat.looMiss, wf: flat.wfMiss, verdict: 'baseline' }];
  let current: ValueTerm[] = [];
  let currentScore = { loo: flat.looMiss, wf: flat.wfMiss };
  const order: ValueTerm[] = ['size', 'family', 'category', 'growth', 'age', 'chains', 'control'];
  for (const term of order) {
    const trial = [...current, term];
    const ev = evaluate(trial);
    const helps = ev.loo < currentScore.loo && ev.wf < currentScore.wf;
    if (term === 'control') {
      ladder.push({ term: VALUE_TERM_LABEL[term], loo: ev.loo, wf: ev.wf, verdict: 'must not help' });
      continue;
    }
    ladder.push({ term: VALUE_TERM_LABEL[term], loo: ev.loo, wf: ev.wf, verdict: helps ? 'kept' : 'tested, not kept' });
    if (helps) {
      current = trial;
      currentScore = { loo: ev.loo, wf: ev.wf };
    }
  }

  const finalEv = evaluate(current);
  const { columns } = finalEv;
  const beta = finalEv.fit.beta.map((b) => roundTo(b, 6));
  const coef = (name: string): number => {
    const at = columns.indexOf(name);
    return at >= 0 ? beta[at]! : 0;
  };
  const familyEffects: Record<string, number> = {};
  const categoryEffects: Record<string, number> = {};
  columns.forEach((col, j) => {
    if (col.startsWith('fam:')) familyEffects[col.slice(4)] = beta[j]!;
    if (col.startsWith('cat:')) categoryEffects[col.slice(4)] = beta[j]!;
  });
  const model: Omit<ValueModel, 'predictLn'> = {
    kept: current,
    ladder,
    compsUsed: comps.length,
    intercept: coef('intercept'),
    lnTvl: coef('lnTvl'),
    growth: coef('growth'),
    age: coef('age'),
    chains: coef('chains'),
    familyEffects,
    categoryEffects,
    flatMultiple: roundTo(flat.med, 4),
    multipleAt100m: 0,
    residQ: { q10: 0, q25: 0, q75: 0, q90: 0 },
    looMiss: currentScore.loo,
    wfMiss: currentScore.wf,
    flatLooMiss: flat.looMiss,
    flatWfMiss: flat.wfMiss,
    honesty: { p2575Loo: 0, p2575Wf: 0, p1090Loo: 0, p1090Wf: 0 },
    compLooMultiple: new Map(),
  };
  const predictLn = (p: SnapshotProtocol, asOf: string, ageYears?: number): number => {
    const age = ageDays(asOf, p.listed_at);
    let z = model.intercept + model.lnTvl * Math.log(Math.max(1, p.tvl_usd));
    if (current.includes('family')) z += model.familyEffects[familyOf(p.category)] ?? 0;
    if (current.includes('category')) z += model.categoryEffects[p.category ?? ''] ?? 0;
    if (current.includes('growth')) z += model.growth * growthFeature(p.change_7d);
    if (current.includes('age')) z += model.age * (ageYears ?? (age === null ? 1 : age / 365));
    if (current.includes('chains')) z += model.chains * Math.log(Math.max(1, p.chains.length));
    return z;
  };
  model.multipleAt100m = roundTo(Math.exp(predictLn({ slug: '', name: '', category: null, chains: [], tvl_usd: 100_000_000, change_7d: 0, mcap_usd: null, listed_at: null, gecko_id: null, symbol: null }, snapshot.as_of)) / 100_000_000, 4);

  // Ranges and honesty from the final fit's leave-one-out residuals; walk-forward honesty refits
  // on the earlier-listed and reads the later-listed caps against intervals from train residuals.
  const looPred = comps.map((_, i) => finalEv.fit.looPredict(i));
  const resid = comps.map((c, i) => c.lnCap - looPred[i]!);
  model.residQ = {
    q10: roundTo(quantile(resid, 0.1), 6),
    q25: roundTo(quantile(resid, 0.25), 6),
    q75: roundTo(quantile(resid, 0.75), 6),
    q90: roundTo(quantile(resid, 0.9), 6),
  };
  const inside = (pred: number, actual: number, lo: number, hi: number): boolean => actual >= pred + lo && actual <= pred + hi;
  model.honesty.p2575Loo = comps.filter((c, i) => inside(looPred[i]!, c.lnCap, model.residQ.q25, model.residQ.q75)).length / comps.length;
  model.honesty.p1090Loo = comps.filter((c, i) => inside(looPred[i]!, c.lnCap, model.residQ.q10, model.residQ.q90)).length / comps.length;
  {
    // Walk-forward honesty, pooled over the same three origins: each origin's intervals are built
    // from its own training residuals, then read against the caps that listed after it.
    let n = 0;
    let in2575 = 0;
    let in1090 = 0;
    for (const chunk of wfChunks) {
      const trainDesign = valueDesign(chunk.train, current, families, categories);
      const trainFit = fitLinear(trainDesign.X, chunk.train.map((c) => c.lnCap), trainDesign.penalty);
      const trainResid = chunk.train.map((c, j) => c.lnCap - trainFit.fitted[j]!);
      const tq = { q10: quantile(trainResid, 0.1), q25: quantile(trainResid, 0.25), q75: quantile(trainResid, 0.75), q90: quantile(trainResid, 0.9) };
      const testDesign = valueDesign(chunk.test, current, families, categories);
      chunk.test.forEach((c, j) => {
        const pred = trainFit.predict(testDesign.X[j]!);
        n += 1;
        if (inside(pred, c.lnCap, tq.q25, tq.q75)) in2575 += 1;
        if (inside(pred, c.lnCap, tq.q10, tq.q90)) in1090 += 1;
      });
    }
    model.honesty.p2575Wf = in2575 / n;
    model.honesty.p1090Wf = in1090 / n;
  }
  comps.forEach((c, i) => model.compLooMultiple.set(c.p.slug, Math.exp(looPred[i]!) / c.p.tvl_usd));
  return { ...model, predictLn };
}

// ---------------------------------------------------------------------------
// The launch-odds model
// ---------------------------------------------------------------------------

type OddsTerm = 'age' | 'size' | 'growth' | 'chains' | 'family';

const ODDS_TERM_LABEL: Record<OddsTerm, string> = {
  age: '+ age, years listed',
  size: '+ size curve, ln TVL',
  growth: '+ 7-day TVL growth',
  chains: '+ chain count, ln',
  family: '+ family effect · ridge 16',
};

export interface OddsLadderRow {
  term: string;
  tenfold: number;
  tenfoldCalled: number;
  wf: number;
  wfCalled: number;
  verdict: 'baseline' | 'kept' | 'tested, not kept';
}

export interface OddsModel {
  kept: OddsTerm[];
  ladder: OddsLadderRow[];
  peers: number;
  baseRate: number;
  /** Final logistic coefficients in feature order [age, lnTvl, growth, lnChains, familyRate], rounded. */
  beta: number[];
  /** The shrunk per-family token rate the family feature reads (only used when the term is kept). */
  familyRate: Record<string, number>;
  brierTenfold: number;
  brierWf: number;
  baseBrierTenfold: number;
  baseBrierWf: number;
  /** The oldest peer cohort's age in years: the horizon the conditional odds read to. */
  aMaxYears: number;
  /** P(records a token by age t) for a protocol with these features, from the fitted curve. */
  probByAge: (p: SnapshotProtocol, asOf: string, ageYears: number) => number;
  /** The conditional odds a pre-token protocol of the given age ever records a token. */
  oddsFor: (p: SnapshotProtocol, asOf: string, ageYears: number) => number;
}

interface Peer {
  p: SnapshotProtocol;
  y: number;
  ageYears: number;
  listedAt: string;
}

function selectPeers(snapshot: Snapshot): Peer[] {
  const peers: Peer[] = [];
  for (const p of snapshot.protocols) {
    const age = ageDays(snapshot.as_of, p.listed_at);
    if (age === null || age < 365) continue;
    peers.push({ p, y: isPreToken(p) ? 0 : 1, ageYears: age / 365, listedAt: p.listed_at! });
  }
  peers.sort((a, b) => (a.p.slug < b.p.slug ? -1 : 1));
  return peers;
}

/** The shrunk family token rate over a training set: (tokens + 16 x base) / (n + 16). */
function familyRates(train: Peer[], base: number): Map<string, number> {
  const counts = new Map<string, { n: number; t: number }>();
  for (const peer of train) {
    const f = familyOf(peer.p.category);
    const c = counts.get(f) ?? { n: 0, t: 0 };
    c.n += 1;
    c.t += peer.y;
    counts.set(f, c);
  }
  const out = new Map<string, number>();
  for (const [f, c] of counts) out.set(f, (c.t + 16 * base) / (c.n + 16));
  return out;
}

const logit = (p: number): number => Math.log(Math.min(0.999, Math.max(0.001, p)) / (1 - Math.min(0.999, Math.max(0.001, p))));

/** The odds feature vector for one protocol at a stated age: [age, lnTvl, growth, lnChains, family]. */
function oddsFeatures(p: SnapshotProtocol, ageYears: number, famRate: Map<string, number>, base: number): number[] {
  const fam = famRate.get(familyOf(p.category)) ?? base;
  return [ageYears, Math.log(Math.max(1, p.tvl_usd)), growthFeature(p.change_7d), Math.log(Math.max(1, p.chains.length)), logit(fam)];
}

function fitOddsModel(snapshot: Snapshot): OddsModel {
  const peers = selectPeers(snapshot);
  // The base rate and family rates are rounded before any prediction reads them: the dashboard
  // ships these exact numbers and recomputes the odds from them, so Node and browser must agree
  // digit for digit.
  const base = roundTo(peers.reduce((s, x) => s + x.y, 0) / peers.length, 6);
  const allFam = new Map([...familyRates(peers, base)].map(([f, r]) => [f, roundTo(r, 6)]));
  const feat = (peer: Peer, fam: Map<string, number>): number[] => oddsFeatures(peer.p, peer.ageYears, fam, base);
  const COL: Record<OddsTerm, number> = { age: 0, size: 1, growth: 2, chains: 3, family: 4 };
  const design = (rows: Peer[], terms: OddsTerm[], fam: Map<string, number>): number[][] =>
    rows.map((peer) => {
      const f = feat(peer, fam);
      return [1, ...([0, 1, 2, 3, 4] as const).map((j) => (terms.some((t) => COL[t] === j) ? f[j]! : 0))];
    });

  // Ten-fold: deterministic folds over the slug-sorted peers; walk-forward: fit the earlier-listed
  // 60%, score the later 40%. The family feature is always derived from the training part only.
  const folds: Peer[][] = Array.from({ length: 10 }, () => []);
  peers.forEach((peer, i) => folds[i % 10]!.push(peer));
  // Walk-forward with three expanding origins over the listing-date order, as in the value model.
  const byDate = [...peers].sort((a, b) => (a.listedAt < b.listedAt ? -1 : a.p.slug < b.p.slug ? -1 : 1));
  const ORIGINS = [0.5, 0.65, 0.8];
  const wfChunks = ORIGINS.map((o, i) => {
    const from = Math.floor(byDate.length * o);
    const to = i + 1 < ORIGINS.length ? Math.floor(byDate.length * ORIGINS[i + 1]!) : byDate.length;
    return { train: byDate.slice(0, from), test: byDate.slice(from, to) };
  });

  const evaluate = (terms: OddsTerm[]): { tenfold: number; tenfoldCalled: number; wf: number; wfCalled: number } => {
    const ps = new Map<string, number>();
    for (let f = 0; f < 10; f++) {
      const train = peers.filter((_, i) => i % 10 !== f);
      const fam = familyRates(train, train.reduce((s, x) => s + x.y, 0) / train.length);
      const fit = fitLogistic(design(train, terms, fam), train.map((x) => x.y));
      for (const peer of folds[f]!) ps.set(peer.p.slug, fit.predictP(design([peer], terms, fam)[0]!));
    }
    const tenPs = peers.map((x) => ps.get(x.p.slug)!);
    const tenYs = peers.map((x) => x.y);
    const wfPs: number[] = [];
    const wfYs: number[] = [];
    for (const chunk of wfChunks) {
      const fam = familyRates(chunk.train, chunk.train.reduce((s, x) => s + x.y, 0) / chunk.train.length);
      const fit = fitLogistic(design(chunk.train, terms, fam), chunk.train.map((x) => x.y));
      for (const peer of chunk.test) {
        wfPs.push(fit.predictP(design([peer], terms, fam)[0]!));
        wfYs.push(peer.y);
      }
    }
    const called = (preds: number[], ys: number[]): number => preds.filter((p, i) => (p >= 0.5) === (ys[i] === 1)).length / ys.length;
    return {
      tenfold: brier(tenPs, tenYs),
      tenfoldCalled: called(tenPs, tenYs),
      wf: brier(wfPs, wfYs),
      wfCalled: called(wfPs, wfYs),
    };
  };

  const baseEval = evaluate([]);
  const ladder: OddsLadderRow[] = [
    { term: 'base rate of peers', tenfold: baseEval.tenfold, tenfoldCalled: baseEval.tenfoldCalled, wf: baseEval.wf, wfCalled: baseEval.wfCalled, verdict: 'baseline' },
  ];
  let current: OddsTerm[] = [];
  let currentScore = { tenfold: baseEval.tenfold, wf: baseEval.wf };
  for (const term of ['age', 'size', 'growth', 'chains', 'family'] as OddsTerm[]) {
    const ev = evaluate([...current, term]);
    const helps = ev.tenfold < currentScore.tenfold && ev.wf < currentScore.wf;
    ladder.push({ term: ODDS_TERM_LABEL[term], tenfold: ev.tenfold, tenfoldCalled: ev.tenfoldCalled, wf: ev.wf, wfCalled: ev.wfCalled, verdict: helps ? 'kept' : 'tested, not kept' });
    if (helps) {
      current = [...current, term];
      currentScore = { tenfold: ev.tenfold, wf: ev.wf };
    }
  }

  const finalFit = fitLogistic(design(peers, current, allFam), peers.map((x) => x.y));
  const beta = finalFit.beta.map((b) => roundTo(b, 6));
  const famRecord: Record<string, number> = {};
  for (const [f, r] of allFam) famRecord[f] = roundTo(r, 6);
  const aMaxYears = roundTo(Math.max(...peers.map((x) => x.ageYears)), 4);
  const probByAge = (p: SnapshotProtocol, _asOf: string, ageYears: number): number => {
    const f = oddsFeatures(p, ageYears, allFam, base);
    const x = [1, ...([0, 1, 2, 3, 4] as const).map((j) => (current.some((t) => COL[t] === j) ? f[j]! : 0))];
    const z = x.reduce((s, v, j) => s + v * beta[j]!, 0);
    return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
  };
  const oddsFor = (p: SnapshotProtocol, asOf: string, ageYears: number): number => {
    const byNow = probByAge(p, asOf, ageYears);
    const byMax = probByAge(p, asOf, aMaxYears);
    const raw = (byMax - byNow) / Math.max(1e-9, 1 - byNow);
    return Math.min(0.98, Math.max(0.02, raw));
  };
  return {
    kept: current,
    ladder,
    peers: peers.length,
    baseRate: base,
    beta,
    familyRate: famRecord,
    brierTenfold: currentScore.tenfold,
    brierWf: currentScore.wf,
    baseBrierTenfold: baseEval.tenfold,
    baseBrierWf: baseEval.wf,
    aMaxYears,
    probByAge,
    oddsFor,
  };
}

// ---------------------------------------------------------------------------
// Scoring the board
// ---------------------------------------------------------------------------

export interface ScoredProtocol {
  p: SnapshotProtocol;
  ageDays: number | null;
  ageYears: number;
  valueIf: number;
  odds: number;
  implied: number;
  p25: number;
  p75: number;
  p10: number;
  p90: number;
  rankLo: number;
  rankHi: number;
}

export interface FittedModels {
  value: ValueModel;
  odds: OddsModel;
  /** Median no-token age (years) across the ranked set: the read for a protocol with no listing date. */
  medianAgeYears: number;
}

export function fitModels(snapshot: Snapshot): FittedModels {
  const value = fitValueModel(snapshot);
  const odds = fitOddsModel(snapshot);
  return { value, odds, medianAgeYears: 1 };
}

const BOOTSTRAP_REFITS = 200;
const BOOTSTRAP_SEED = 20261114;

/**
 * Score the ranked protocols and attach bootstrap rank ranges: 200 seeded refits of the value
 * model on resampled comps, odds held at the fitted curve, ranks recorded per refit.
 */
export function scoreBoard(snapshot: Snapshot, models: FittedModels, ranked: SnapshotProtocol[]): ScoredProtocol[] {
  const { value, odds } = models;
  const ages = ranked.map((p) => ageDays(snapshot.as_of, p.listed_at)).filter((a): a is number => a !== null);
  // Ages ship to the dashboard rounded to 4 dp; score with the shipped values so the browser's
  // recompute lands on the same integers this build writes into board.json.
  const medianAgeYears = roundTo(median(ages) / 365, 4);
  models.medianAgeYears = medianAgeYears;
  const score = (p: SnapshotProtocol): ScoredProtocol => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const ageYears = roundTo(age === null ? medianAgeYears : age / 365, 4);
    const valueIf = Math.exp(value.predictLn(p, snapshot.as_of, ageYears));
    const o = odds.oddsFor(p, snapshot.as_of, ageYears);
    const implied = Math.max(1, Math.round(valueIf * o));
    return {
      p,
      ageDays: age,
      ageYears,
      valueIf,
      odds: o,
      implied,
      p25: Math.max(1, Math.round(valueIf * Math.exp(value.residQ.q25) * o)),
      p75: Math.max(1, Math.round(valueIf * Math.exp(value.residQ.q75) * o)),
      p10: Math.max(1, Math.round(valueIf * Math.exp(value.residQ.q10) * o)),
      p90: Math.max(1, Math.round(valueIf * Math.exp(value.residQ.q90) * o)),
      rankLo: 0,
      rankHi: 0,
    };
  };
  const scored = ranked.map((p) => score(p));
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : 1));

  // Bootstrap the value fit: resample the comps, refit the kept terms, re-read every row's value.
  const comps = selectComps(snapshot);
  const families = [...new Set(comps.map((c) => familyOf(c.p.category)))].sort();
  const categories = [...new Set(comps.map((c) => c.p.category ?? ''))].sort();
  const rand = rng(BOOTSTRAP_SEED);
  const rankSamples = new Map<string, number[]>(scored.map((s) => [s.p.slug, []]));
  for (let r = 0; r < BOOTSTRAP_REFITS; r++) {
    const sample = Array.from({ length: comps.length }, () => comps[Math.floor(rand() * comps.length)]!);
    const { X, penalty } = valueDesign(sample, value.kept, families, categories);
    const fit = fitLinear(X, sample.map((c) => c.lnCap), penalty);
    const cols = valueDesign(comps, value.kept, families, categories).columns;
    const b = fit.beta;
    const coef = (name: string): number => (cols.indexOf(name) >= 0 ? b[cols.indexOf(name)]! : 0);
    const famEff = new Map<string, number>();
    const catEff = new Map<string, number>();
    cols.forEach((col, j) => {
      if (col.startsWith('fam:')) famEff.set(col.slice(4), b[j]!);
      if (col.startsWith('cat:')) catEff.set(col.slice(4), b[j]!);
    });
    const values = scored.map((s) => {
      const p = s.p;
      let z = coef('intercept') + coef('lnTvl') * Math.log(Math.max(1, p.tvl_usd));
      if (value.kept.includes('family')) z += famEff.get(familyOf(p.category)) ?? 0;
      if (value.kept.includes('category')) z += catEff.get(p.category ?? '') ?? 0;
      if (value.kept.includes('growth')) z += coef('growth') * growthFeature(p.change_7d);
      if (value.kept.includes('age')) z += coef('age') * s.ageYears;
      if (value.kept.includes('chains')) z += coef('chains') * Math.log(Math.max(1, p.chains.length));
      return Math.exp(z) * s.odds;
    });
    const order = values.map((v, i) => [v, i] as const).sort((a, b2) => b2[0] - a[0]);
    order.forEach(([, idx], pos) => rankSamples.get(scored[idx]!.p.slug)!.push(pos + 1));
  }
  for (const s of scored) {
    const samples = rankSamples.get(s.p.slug)!;
    s.rankLo = Math.max(1, Math.floor(quantile(samples, 0.05)));
    s.rankHi = Math.min(scored.length, Math.ceil(quantile(samples, 0.95)));
  }
  return scored;
}
