// On-chain verification of USDC deposits (M4 money-in, Design 1). The chain is the source of
// truth: a customer signs + sends a USDC transfer to the admin fee wallet, and we confirm it
// here by transaction signature before crediting. We do NOT trust the browser's "it worked" —
// the dispatcher independently reads the transaction from a trusted RPC (Helius).
//
// Two callers:
//   - fast path  (/credits/verify):  verifyDeposit(signature) right after the customer pays.
//   - sweep      (/credits/refresh): incomingDeposits() lists recent deposits to the fee wallet,
//                                     each re-verified — the backstop if the fast path was lost
//                                     to a network blip. Idempotency lives in the CreditStore.

import { Connection, PublicKey, type Commitment, type Finality, type ParsedTransactionWithMeta } from "@solana/web3.js";

/** USDC SPL mint on Solana mainnet-beta (6 decimals). */
export const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** A token-balance entry as it appears in a parsed transaction's meta (pre/post token balances). */
interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

export interface DepositInfo {
  /** USDC (base units) that landed in the admin wallet in this transaction. 0 if none. */
  usdcRaw: number;
  /** The paying wallet (owner of the USDC account that decreased the most), or null if unclear. */
  from: string | null;
}

/**
 * Pure: from a transaction's token-balance deltas, work out how much USDC arrived in `adminWallet`
 * and who paid. We read balance deltas (pre vs post) rather than parsing instructions, so this is
 * robust to however the transfer was constructed (plain transfer, transferChecked, with/without an
 * idempotent create-ATA, routed through a swap, etc.). Exported for unit testing.
 */
export function extractUsdcDeposit(
  meta: { preTokenBalances?: TokenBalance[] | null; postTokenBalances?: TokenBalance[] | null } | null,
  adminWallet: string,
  usdcMint: string,
): DepositInfo {
  const pre = meta?.preTokenBalances ?? [];
  const post = meta?.postTokenBalances ?? [];
  const acc = new Map<number, { owner: string | undefined; pre: number; post: number }>();

  for (const b of post) {
    if (b.mint !== usdcMint) continue;
    acc.set(b.accountIndex, { owner: b.owner, pre: 0, post: Number(b.uiTokenAmount.amount) });
  }
  for (const b of pre) {
    if (b.mint !== usdcMint) continue;
    const e = acc.get(b.accountIndex) ?? { owner: b.owner, pre: 0, post: 0 };
    e.pre = Number(b.uiTokenAmount.amount);
    if (e.owner === undefined) e.owner = b.owner;
    acc.set(b.accountIndex, e);
  }

  let usdcRaw = 0;
  let from: string | null = null;
  let biggestDrop = 0;
  for (const e of acc.values()) {
    const delta = e.post - e.pre;
    if (e.owner === adminWallet && delta > 0) usdcRaw += delta;
    if (delta < 0 && -delta > biggestDrop) {
      biggestDrop = -delta;
      from = e.owner ?? null;
    }
  }
  return { usdcRaw, from };
}

export type VerifyResult =
  | { ok: true; usdcRaw: number; from: string | null; slot: number; blockTime: number | null }
  | { ok: false; reason: string };

export class SolanaVerifier {
  private conn: Connection;
  readonly adminWallet: string;
  readonly usdcMint: string;
  private commitment: Commitment;
  private _adminUsdcAccount: string | null = null;

  constructor(opts: { rpcUrl: string; adminWallet: string; usdcMint?: string; commitment?: string }) {
    // 'finalized' is the safe default for crediting money (a finalized tx cannot roll back).
    // Operators wanting snappier UX can set SOLANA_COMMITMENT=confirmed.
    this.commitment = (opts.commitment as Commitment) ?? "finalized";
    this.conn = new Connection(opts.rpcUrl, this.commitment);
    this.adminWallet = opts.adminWallet;
    this.usdcMint = opts.usdcMint ?? USDC_MINT_MAINNET;
  }

  /** The admin fee wallet's USDC associated-token-account — the address deposits actually land in. */
  adminUsdcAccount(): string {
    if (this._adminUsdcAccount) return this._adminUsdcAccount;
    const owner = new PublicKey(this.adminWallet);
    const mint = new PublicKey(this.usdcMint);
    const [ata] = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    this._adminUsdcAccount = ata.toBase58();
    return this._adminUsdcAccount;
  }

  /** Verify a USDC deposit to the admin fee wallet by its transaction signature. */
  async verifyDeposit(signature: string): Promise<VerifyResult> {
    // getParsedTransaction only accepts confirmed|finalized; map anything looser to confirmed.
    const c: Commitment = this.commitment === "finalized" ? "finalized" : "confirmed";
    let tx: ParsedTransactionWithMeta | null;
    try {
      tx = await this.conn.getParsedTransaction(signature, { commitment: c, maxSupportedTransactionVersion: 0 });
    } catch (e: any) {
      return { ok: false, reason: `RPC error: ${e?.message ?? e}` };
    }
    if (!tx) return { ok: false, reason: "transaction not found or not yet confirmed on-chain" };
    if (tx.meta?.err) return { ok: false, reason: "transaction failed on-chain" };
    const { usdcRaw, from } = extractUsdcDeposit(tx.meta ?? null, this.adminWallet, this.usdcMint);
    if (usdcRaw <= 0) return { ok: false, reason: "no USDC transfer to the fee wallet in this transaction" };
    return { ok: true, usdcRaw, from, slot: tx.slot, blockTime: tx.blockTime ?? null };
  }

  /** Recent incoming deposit signatures to the admin USDC account, newest first (for the sweep). */
  async incomingDeposits(limit: number): Promise<string[]> {
    const ata = new PublicKey(this.adminUsdcAccount());
    const fin: Finality = this.commitment === "finalized" ? "finalized" : "confirmed";
    const sigs = await this.conn.getSignaturesForAddress(ata, { limit }, fin);
    return sigs.filter((s) => !s.err).map((s) => s.signature);
  }
}
