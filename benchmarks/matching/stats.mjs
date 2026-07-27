/**
 * Exact small-sample statistics for the icebreaker comparison, with no
 * dependencies and no normal approximations.
 *
 * Why exact: every attribution comparison in this project has a numerator in the
 * single digits over a denominator in the thousands. A normal-approximation
 * z-test on 2/2435 is meaningless, and a Wald interval on 0 errors returns
 * [0, 0], which reads as proof of perfection. Fisher's exact test and the
 * Clopper-Pearson interval both behave at those counts.
 *
 * Tested in stats.test.mjs against values from R (fisher.test, binom.test).
 */

// Log-gamma (Lanczos g=7, n=9): the binomial coefficients below are evaluated at
// n in the thousands, where factorials overflow a double long before the answer
// does.
const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];
export function lgamma(z) {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < LANCZOS.length; i++) x += LANCZOS[i] / (z + i + 1);
  const t = z + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
const lchoose = (n, k) => lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);

/**
 * Two-sided Fisher exact test on [[a, b], [c, d]].
 *
 * Two-sided by the "sum of tables no more likely than the observed one"
 * convention, which is what R's fisher.test does. The 1e-7 of slack matters: the
 * table that mirrors the observed one is equally likely by construction, and
 * without slack floating-point noise drops it and the p-value comes out visibly
 * too small.
 */
export function fisherExact(a, b, c, d) {
  const n = a + b + c + d;
  if (n === 0) return 1;
  const r1 = a + b;
  const c1 = a + c;
  const lp = (x) => lchoose(r1, x) + lchoose(n - r1, c1 - x) - lchoose(n, c1);
  const obs = lp(a);
  const lo = Math.max(0, c1 - (n - r1));
  const hi = Math.min(r1, c1);
  let p = 0;
  for (let x = lo; x <= hi; x++) if (lp(x) <= obs + 1e-7) p += Math.exp(lp(x));
  return Math.min(1, p);
}

/** Continued fraction for the regularised incomplete beta (Lentz's method). */
function betacf(a, b, x) {
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let num = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + num * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + num / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    h *= d * c;
    num = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + num * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + num / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return h;
}

/** Regularised incomplete beta I_x(a, b). */
export function ibeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * betacf(a, b, x)) / a : 1 - (front * betacf(b, a, 1 - x)) / b;
}

/** Invert ibeta by bisection — 200 halvings is far below printable precision. */
function invBeta(a, b, p) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (ibeta(a, b, mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Clopper-Pearson exact binomial interval. Unlike Wald it does not collapse to
 * [0, 0] at k = 0 — which is the case this benchmark keeps producing, and the
 * case where a collapsed interval would be read as "this prompt never errs".
 */
export function ciExact(k, n, alpha = 0.05) {
  if (n === 0) return [0, 1];
  const lo = k === 0 ? 0 : invBeta(k, n - k + 1, alpha / 2);
  const hi = k === n ? 1 : invBeta(k + 1, n - k, 1 - alpha / 2);
  return [lo, hi];
}

/**
 * Deterministic xorshift32 — seeded so a reported p-value is reproducible. A
 * permutation test whose answer moves between runs is not evidence.
 */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * Two-sided permutation test on two groups of CLUSTERS, comparing overall rates.
 *
 * Why this and not Fisher: openers within one LLM call are not independent — a
 * batch that inverts roles tends to invert several entries at once, so Fisher on
 * openers reports more confidence than the design earns. But collapsing each call
 * to a yes/no "did it err" throws away severity, and a call with six inversions is
 * not the same event as a call with one. This keeps the call as the unit that gets
 * shuffled while still counting the openers inside it: whole clusters are
 * reassigned between the two arms, carrying both their error count and their size.
 *
 * `a` and `b` are arrays of {err, n} — one entry per call.
 * Returns { rateA, rateB, p, iters }.
 */
export function permutationTestRate(a, b, iters = 20000, seed = 20260727) {
  const all = [...a, ...b];
  const nA = a.length;
  const sum = (xs, k) => xs.reduce((s, x) => s + x[k], 0);
  const rateOf = (xs) => (sum(xs, "n") ? sum(xs, "err") / sum(xs, "n") : 0);
  const rateA = rateOf(a);
  const rateB = rateOf(b);
  const observed = Math.abs(rateA - rateB);
  const rand = rng(seed);
  let atLeast = 0;
  const idx = all.map((_, i) => i);
  for (let it = 0; it < iters; it++) {
    // Fisher-Yates on the index array, then split at nA.
    for (let i = idx.length - 1; i > 0; i--) {
      const jj = Math.floor(rand() * (i + 1));
      [idx[i], idx[jj]] = [idx[jj], idx[i]];
    }
    const pa = idx.slice(0, nA).map((i) => all[i]);
    const pb = idx.slice(nA).map((i) => all[i]);
    if (Math.abs(rateOf(pa) - rateOf(pb)) >= observed - 1e-12) atLeast++;
  }
  // +1/+1 (Davison-Hinkley): a permutation p-value must never be exactly 0, since
  // the observed assignment is itself one of the permutations.
  return { rateA, rateB, p: (atLeast + 1) / (iters + 1), iters };
}
