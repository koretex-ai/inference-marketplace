// The deposit parser reads USDC into the fee wallet from a transaction's token-balance deltas.
// This is the on-chain verification core — it decides how much to credit and to whom.
import { extractUsdcDeposit } from "../src/shared/solana.ts";

const ADMIN = "AdminFeeWa11et1111111111111111111111111111"; // placeholder fee wallet (synthetic test)
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OTHER = "So11111111111111111111111111111111111111112"; // some non-USDC mint
const PAYER = "PayerWa11et1111111111111111111111111111111";

let failures = 0;
const check = (cond: boolean, name: string) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}`); failures++; }
};
const bal = (accountIndex: number, mint: string, owner: string, amount: string) =>
  ({ accountIndex, mint, owner, uiTokenAmount: { amount } });

// A clean $10 USDC transfer payer → admin.
let d = extractUsdcDeposit(
  {
    preTokenBalances: [bal(1, USDC, PAYER, "10000000"), bal(2, USDC, ADMIN, "0")],
    postTokenBalances: [bal(1, USDC, PAYER, "0"), bal(2, USDC, ADMIN, "10000000")],
  },
  ADMIN, USDC,
);
check(d.usdcRaw === 10_000_000, "credits the exact USDC delta into the fee wallet");
check(d.from === PAYER, "attributes the payment to the wallet that paid");

// Admin's USDC account didn't exist before (no pre entry) — still credited from 0.
d = extractUsdcDeposit(
  {
    preTokenBalances: [bal(1, USDC, PAYER, "5000000")],
    postTokenBalances: [bal(1, USDC, PAYER, "0"), bal(2, USDC, ADMIN, "5000000")],
  },
  ADMIN, USDC,
);
check(d.usdcRaw === 5_000_000 && d.from === PAYER, "handles a freshly-created fee-wallet token account");

// Wrong mint (not USDC) → nothing credited.
d = extractUsdcDeposit(
  {
    preTokenBalances: [bal(1, OTHER, PAYER, "10000000"), bal(2, OTHER, ADMIN, "0")],
    postTokenBalances: [bal(1, OTHER, PAYER, "0"), bal(2, OTHER, ADMIN, "10000000")],
  },
  ADMIN, USDC,
);
check(d.usdcRaw === 0, "ignores transfers of other tokens (only USDC counts)");

// USDC moving between two OTHER wallets (not the admin) → nothing credited.
d = extractUsdcDeposit(
  {
    preTokenBalances: [bal(1, USDC, PAYER, "10000000"), bal(2, USDC, "SomeoneE1se111111111111111111111111111111", "0")],
    postTokenBalances: [bal(1, USDC, PAYER, "0"), bal(2, USDC, "SomeoneE1se111111111111111111111111111111", "10000000")],
  },
  ADMIN, USDC,
);
check(d.usdcRaw === 0, "ignores USDC that didn't land in the fee wallet");

// Empty / missing meta → safe zero.
check(extractUsdcDeposit(null, ADMIN, USDC).usdcRaw === 0, "null meta yields no credit, no throw");
check(extractUsdcDeposit({}, ADMIN, USDC).usdcRaw === 0, "empty meta yields no credit");

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nUSDC deposit parser: all checks passed");
