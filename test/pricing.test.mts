// Pricing turns token counts into integer credit costs, per model, with a default fallback.
import { Pricing } from "../src/shared/pricing.ts";

let failures = 0;
const check = (cond: boolean, name: string) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}`); failures++; }
};

const p = new Pricing({ default: 4000, models: { "gemma:2b": 1000 } });

check(p.rate("gemma:2b") === 1000, "per-model rate is used when listed");
check(p.rate("unknown-model") === 4000, "default rate for unlisted models");
check(p.rate(undefined) === 4000, "default rate when model is undefined");

// 4000 credits / 1M tokens → 500k tokens = 2000 credits.
check(p.cost("mystery", 500_000) === 2000, "cost scales with tokens at the default rate");
// 1000 credits / 1M → 500k tokens = 500 credits.
check(p.cost("gemma:2b", 500_000) === 500, "cost uses the model's own rate");
// Small request still rounds UP to a whole credit, never 0.
check(p.cost("gemma:2b", 1) === 1, "a tiny request is billed 1 credit, never 0 (ceil)");
check(p.cost("gemma:2b", 0) === 0, "zero tokens costs 0");
check(p.cost("gemma:2b", -5) === 0, "negative/garbage token counts cost 0");

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\npricing: all checks passed");
