/**
 * Reference values from R (fisher.test / binom.test). Run before quoting any
 * p-value:  node --test stats.test.mjs
 *
 * The grader in this project produced four rounds of wrong numbers before it was
 * pinned against real output. Statistics get the same treatment: a p-value that
 * is silently wrong is worse than no p-value, because it ends the argument.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fisherExact, ciExact, ibeta, lgamma, permutationTestRate } from "./stats.mjs";

const close = (a, b, tol = 1e-4) =>
  assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (tol ${tol})`);

test("lgamma matches known factorials", () => {
  close(lgamma(1), 0, 1e-9);
  close(lgamma(5), Math.log(24), 1e-9); // 4! = 24
  close(lgamma(11), Math.log(3628800), 1e-7); // 10! = 3628800
  close(lgamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-9);
});

test("Fisher exact: Fisher's own tea-tasting table", () => {
  // R: fisher.test(matrix(c(3,1,1,3),2)) -> p = 0.4857143
  close(fisherExact(3, 1, 1, 3), 0.4857143);
});

test("Fisher exact: a clearly significant table", () => {
  // R: fisher.test(matrix(c(1,9,11,3),2, byrow=TRUE)) -> p = 0.0027594
  close(fisherExact(1, 9, 11, 3), 0.0027594, 1e-6);
});

test("Fisher exact: identical arms give p = 1", () => {
  close(fisherExact(5, 95, 5, 95), 1, 1e-9);
  close(fisherExact(0, 100, 0, 100), 1, 1e-9);
});

test("Fisher exact is symmetric in the way the test is symmetric", () => {
  close(fisherExact(2, 2433, 8, 2264), fisherExact(8, 2264, 2, 2433), 1e-12);
});

test("Fisher exact at this benchmark's actual counts", () => {
  // The R2-vs-R3 Slovak comparison the README reports as a result.
  // R: fisher.test(matrix(c(8,2264,2,2220),2,byrow=TRUE)) -> p = 0.1096
  close(fisherExact(8, 2264, 2, 2220), 0.1096, 1e-3);
  // Pooled across languages: 12/4866 vs 4/4657.
  // R: fisher.test(matrix(c(12,4854,4,4653),2,byrow=TRUE)) -> p = 0.07677
  close(fisherExact(12, 4854, 4, 4653), 0.07677, 1e-3);
});

test("ibeta endpoints and a known midpoint", () => {
  close(ibeta(2, 3, 0), 0, 1e-12);
  close(ibeta(2, 3, 1), 1, 1e-12);
  // I_0.5(2,3) = 11/16
  close(ibeta(2, 3, 0.5), 0.6875, 1e-9);
});

// The Clopper-Pearson expectations below were NOT taken from memory of R's
// output — a first pass at this file did that and was wrong in the fifth decimal
// on three of four bounds. They come from inverting the binomial CDF directly by
// bisection (the definition of the interval: hi solves P(X ≤ k) = α/2 and lo
// solves P(X ≥ k) = α/2 for X ~ Bin(n, p)), computed independently of the
// implementation under test.
test("Clopper-Pearson matches the binomial CDF inversion", () => {
  const [lo, hi] = ciExact(2, 100);
  close(lo, 0.0024313368, 1e-7);
  close(hi, 0.0703839325, 1e-7);
  const [lo2, hi2] = ciExact(5, 20);
  close(lo2, 0.0865714691, 1e-7);
  close(hi2, 0.4910458717, 1e-7);
});

test("Clopper-Pearson does not collapse at zero errors", () => {
  // The whole reason for using the exact interval: Wald would return [0, 0] and
  // a reader would take it as "this prompt cannot err".
  const [lo, hi] = ciExact(0, 2400);
  assert.equal(lo, 0);
  assert.ok(hi > 0, "upper bound must be positive at k = 0");
  close(hi, 0.0015358525, 1e-7);
});

test("Clopper-Pearson at k = n", () => {
  const [lo, hi] = ciExact(10, 10);
  close(lo, 0.6915028922, 1e-7);
  assert.equal(hi, 1);
});

test("permutation test: identical arms are not distinguishable", () => {
  const arm = Array.from({ length: 32 }, () => ({ err: 1, n: 30 }));
  const { p } = permutationTestRate(arm, arm.map((x) => ({ ...x })), 3000);
  assert.ok(p > 0.9, `identical arms should give a large p, got ${p}`);
});

test("permutation test: a large clear difference is significant", () => {
  const bad = Array.from({ length: 32 }, () => ({ err: 6, n: 30 }));
  const good = Array.from({ length: 32 }, () => ({ err: 0, n: 30 }));
  const { p } = permutationTestRate(bad, good, 3000);
  assert.ok(p < 0.01, `clear difference should be significant, got ${p}`);
});

test("permutation test is deterministic for a given seed", () => {
  const a = Array.from({ length: 20 }, (_, i) => ({ err: i % 3, n: 30 }));
  const b = Array.from({ length: 20 }, (_, i) => ({ err: i % 2, n: 30 }));
  assert.equal(permutationTestRate(a, b, 2000, 7).p, permutationTestRate(a, b, 2000, 7).p);
});

test("permutation p-value is never exactly zero", () => {
  const bad = Array.from({ length: 10 }, () => ({ err: 30, n: 30 }));
  const good = Array.from({ length: 10 }, () => ({ err: 0, n: 30 }));
  assert.ok(permutationTestRate(bad, good, 500).p > 0, "observed assignment is itself a permutation");
});
