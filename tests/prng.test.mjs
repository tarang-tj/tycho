import { test } from "node:test";
import assert from "node:assert/strict";
import { mulberry32 } from "../web/prng.js";

test("mulberry32: same seed produces the identical sequence", () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const seqA = Array.from({ length: 20 }, () => a());
  const seqB = Array.from({ length: 20 }, () => b());
  assert.deepEqual(seqA, seqB);
});

test("mulberry32: different seeds diverge", () => {
  const a = mulberry32(1);
  const b = mulberry32(2);
  const seqA = Array.from({ length: 10 }, () => a());
  const seqB = Array.from({ length: 10 }, () => b());
  assert.notDeepEqual(seqA, seqB);
});

test("mulberry32: every value is in [0, 1)", () => {
  const rng = mulberry32(7);
  for (let i = 0; i < 5000; i++) {
    const v = rng();
    assert.ok(v >= 0 && v < 1, `value ${v} out of [0,1)`);
  }
});

test("mulberry32: seed 0 does not produce a degenerate all-zero stream", () => {
  const rng = mulberry32(0);
  const values = Array.from({ length: 10 }, () => rng());
  assert.ok(values.some((v) => v !== 0), "seed 0 must still produce varied output");
});

test("mulberry32: a fractional/negative seed is coerced via >>> 0, not thrown", () => {
  assert.doesNotThrow(() => mulberry32(-5)());
  assert.doesNotThrow(() => mulberry32(1.5)());
});
