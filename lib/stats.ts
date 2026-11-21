// stats.ts — the radar's small deterministic statistics toolkit.
//
// Everything here is pure and seeded: the same snapshot in gives the same numbers out, on every run,
// in Node and (for the pieces the dashboard mirrors) in the browser. No Math.random, no Date, no
// iteration order that depends on a hash map's mood.

/** mulberry32: a tiny seeded PRNG, good enough for bootstrap resampling and fold assignment. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The median of a non-empty list, on a copy so the caller's order survives. */
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** A quantile of a list by linear interpolation between closest ranks (the type-7 rule). */
export function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  if (s.length === 1) return s[0]!;
  const pos = q * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo]! : s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/** Solve A x = b for a small dense A by Gaussian elimination with partial pivoting. */
export function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    if (piv !== col) [M[col], M[piv]] = [M[piv]!, M[col]!];
    const d = M[col]![col]!;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]! / d;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  return M.map((row, i) => row[n]! / M[i]![i]!);
}

/** Invert a small dense matrix by Gauss-Jordan on the augmented identity. */
export function invert(A: number[][]): number[][] {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    if (piv !== col) [M[col], M[piv]] = [M[piv]!, M[col]!];
    const d = M[col]![col]!;
    for (let c = 0; c < 2 * n; c++) M[col]![c]! /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]!;
      if (f === 0) continue;
      for (let c = 0; c < 2 * n; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  return M.map((row) => row.slice(n));
}

export interface LinearFit {
  beta: number[];
  /** Fitted values on the training rows. */
  fitted: number[];
  /** Hat-matrix diagonal, for exact leave-one-out residuals of a (ridge) linear fit. */
  leverage: number[];
  predict: (x: number[]) => number;
  /** Exact leave-one-out prediction for training row i (linear/ridge fits only). */
  looPredict: (i: number) => number;
}

/**
 * Fit y ~ X beta with a per-column ridge penalty (0 = unpenalised). The penalty matrix enters the
 * normal equations, so the hat matrix — and with it exact leave-one-out residuals — stays available:
 * loo residual = e_i / (1 - h_ii), the standard identity for penalised least squares.
 */
export function fitLinear(X: number[][], y: number[], penalty: number[]): LinearFit {
  const n = X.length;
  const k = X[0]!.length;
  const XtX: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const Xty = new Array<number>(k).fill(0);
  for (let i = 0; i < n; i++) {
    const xi = X[i]!;
    for (let a = 0; a < k; a++) {
      Xty[a]! += xi[a]! * y[i]!;
      for (let b = 0; b < k; b++) XtX[a]![b]! += xi[a]! * xi[b]!;
    }
  }
  for (let a = 0; a < k; a++) XtX[a]![a]! += penalty[a]!;
  const inv = invert(XtX);
  const beta = inv.map((row) => row.reduce((s, v, j) => s + v * Xty[j]!, 0));
  const fitted = X.map((xi) => xi.reduce((s, v, j) => s + v * beta[j]!, 0));
  // H = X (X'X + P)^-1 X' ; only its diagonal is needed.
  const leverage = X.map((xi) => {
    let h = 0;
    for (let a = 0; a < k; a++) {
      let t = 0;
      for (let b = 0; b < k; b++) t += inv[a]![b]! * xi[b]!;
      h += xi[a]! * t;
    }
    return Math.min(h, 0.999999);
  });
  return {
    beta,
    fitted,
    leverage,
    predict: (x) => x.reduce((s, v, j) => s + v * beta[j]!, 0),
    looPredict: (i) => {
      const e = y[i]! - fitted[i]!;
      return y[i]! - e / (1 - leverage[i]!);
    },
  };
}

export interface LogisticFit {
  beta: number[];
  predictP: (x: number[]) => number;
}

/**
 * Logistic regression by iteratively reweighted least squares with a small L2 penalty on the
 * non-intercept terms (keeps separated families finite). Deterministic: fixed iteration count,
 * no line search, convergence by tolerance with a hard cap.
 */
export function fitLogistic(X: number[][], y: number[], l2 = 1e-3): LogisticFit {
  const n = X.length;
  const k = X[0]!.length;
  let beta = new Array<number>(k).fill(0);
  // Start the intercept at the base rate's logit so IRLS begins near the mass of the data.
  const base = Math.min(0.99, Math.max(0.01, y.reduce((s, v) => s + v, 0) / n));
  beta[0] = Math.log(base / (1 - base));
  const penalty = beta.map((_, j) => (j === 0 ? 0 : l2));
  for (let iter = 0; iter < 100; iter++) {
    const grad = new Array<number>(k).fill(0);
    const H: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    for (let i = 0; i < n; i++) {
      const xi = X[i]!;
      const z = xi.reduce((s, v, j) => s + v * beta[j]!, 0);
      const p = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
      const w = Math.max(p * (1 - p), 1e-9);
      const r = y[i]! - p;
      for (let a = 0; a < k; a++) {
        grad[a]! += xi[a]! * r;
        for (let b = 0; b < k; b++) H[a]![b]! += xi[a]! * xi[b]! * w;
      }
    }
    for (let a = 0; a < k; a++) {
      H[a]![a]! += penalty[a]!;
      grad[a]! -= penalty[a]! * beta[a]!;
    }
    const step = solve(H, grad);
    let maxStep = 0;
    beta = beta.map((b, j) => {
      const nb = b + step[j]!;
      maxStep = Math.max(maxStep, Math.abs(step[j]!));
      return nb;
    });
    if (maxStep < 1e-9) break;
  }
  return {
    beta,
    predictP: (x) => {
      const z = x.reduce((s, v, j) => s + v * beta[j]!, 0);
      return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
    },
  };
}

/** The multiplicative miss of log-space predictions: exp(mean |ln pred - ln actual|), 1 = perfect. */
export function missFactor(predLn: number[], actualLn: number[]): number {
  if (predLn.length === 0) return NaN;
  const s = predLn.reduce((acc, p, i) => acc + Math.abs(p - actualLn[i]!), 0);
  return Math.exp(s / predLn.length);
}

/** The Brier score of probabilistic predictions against 0/1 outcomes. */
export function brier(ps: number[], ys: number[]): number {
  if (ps.length === 0) return NaN;
  return ps.reduce((acc, p, i) => acc + (p - ys[i]!) ** 2, 0) / ps.length;
}

/** Round to `places` decimals, for shipping coefficients the browser must reproduce exactly. */
export function roundTo(x: number, places: number): number {
  const f = 10 ** places;
  return Math.round(x * f) / f;
}

/** FNV-1a 32-bit hash of a string, as 8 hex digits: the board checksum both sides print. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
