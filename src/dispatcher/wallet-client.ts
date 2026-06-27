// Browser bundle (NOT run by the server). Bundled to dist/wallet.js via `npm run wallet:bundle`
// and served at /wallet.js. Wraps @phantom/browser-sdk so every page talks to one small surface
// (window.KoretexWallet) and all Phantom specifics live here.
//
// Auth model unchanged from the old window.phantom flow: the wallet signs a server-issued nonce
// with ed25519, and the backend verifies it with nacl (shared/wallet.ts). We just swap how the
// wallet is obtained — Google login (embedded wallet, redirect flow) or the browser extension.
import { BrowserSDK, AddressType } from "@phantom/browser-sdk";
import type { WalletAddress } from "@phantom/browser-sdk";

const CALLBACK_PATH = "/auth/callback";
const RETURN_KEY = "kx_return_to";

let sdkPromise: Promise<BrowserSDK> | null = null;
let currentAddress: string | null = null;

async function getSdk(): Promise<BrowserSDK> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = (async () => {
    const cfg = await (await fetch("/wallet/config")).json();
    return new BrowserSDK({
      appId: cfg.appId,
      providers: ["google", "injected"], // Google = embedded wallet; injected = the extension
      addressTypes: [AddressType.solana],
      authOptions: {
        // Must exactly match a redirect URL allow-listed in Phantom Portal.
        redirectUrl: location.origin + CALLBACK_PATH,
      },
    });
  })();
  return sdkPromise;
}

function solanaAddress(sdk: BrowserSDK): string | null {
  const a = sdk.getAddresses().find((x: WalletAddress) => x.addressType === AddressType.solana);
  currentAddress = a?.address ?? null;
  return currentAddress;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export interface SignedMessage {
  address: string;
  signature: string; // base64, matches what the backend's verifyWalletSignature expects
}

export const KoretexWallet = {
  AddressType,

  /**
   * Resume any existing session (7-day embedded session, or a trusted extension), and on the
   * /auth/callback page finish the Google OAuth round-trip. Resolves to the Solana address or
   * null if not connected. Safe to call on every page load.
   */
  async init(): Promise<string | null> {
    const sdk = await getSdk();
    return await new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (addr: string | null) => {
        if (settled) return;
        settled = true;
        resolve(addr);
      };
      sdk.on("connect", () => finish(solanaAddress(sdk)));
      sdk.on("connect_error", () => finish(null));
      sdk.autoConnect()
        .then(() => finish(solanaAddress(sdk)))
        .catch(() => finish(null));
    });
  },

  /**
   * Start Google login. This NAVIGATES THE WHOLE PAGE to Google and returns to /auth/callback,
   * so it does not resolve in the normal sense. `returnTo` is where the callback sends the user
   * once the session is live.
   */
  async connectGoogle(returnTo: string): Promise<void> {
    const sdk = await getSdk();
    try {
      sessionStorage.setItem(RETURN_KEY, returnTo);
    } catch {
      /* private mode: callback will fall back to "/" */
    }
    await sdk.connect({ provider: "google" });
  },

  /** Connect the Phantom browser extension (inline, no redirect). Returns the Solana address. */
  async connectExtension(): Promise<string | null> {
    const sdk = await getSdk();
    await sdk.connect({ provider: "injected" });
    return solanaAddress(sdk);
  },

  /** Where the callback page should send the user after a successful Google login. */
  consumeReturnTo(): string {
    try {
      const v = sessionStorage.getItem(RETURN_KEY);
      sessionStorage.removeItem(RETURN_KEY);
      return v || "/";
    } catch {
      return "/";
    }
  },

  /** Last known connected Solana address (after init()/connect* resolve), else null. */
  address(): string | null {
    return currentAddress;
  },

  /** Sign a server-issued message; returns the base64 signature + signer address for the backend. */
  async signMessageBase64(message: string): Promise<SignedMessage> {
    const sdk = await getSdk();
    const res = await sdk.solana.signMessage(message);
    return { address: res.publicKey, signature: toBase64(res.signature) };
  },

  /** For the credits page USDC transfer. Returns the on-chain tx signature. */
  async signAndSendTransaction(tx: unknown): Promise<{ signature: string }> {
    const sdk = await getSdk();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return sdk.solana.signAndSendTransaction(tx as any);
  },

  async disconnect(): Promise<void> {
    const sdk = await getSdk();
    await sdk.disconnect();
  },

  /** Fire `cb` when the wallet disconnects (extension lock/logout, or session end). */
  async onDisconnect(cb: () => void): Promise<void> {
    const sdk = await getSdk();
    sdk.on("disconnect", () => {
      currentAddress = null;
      cb();
    });
  },
};

declare global {
  interface Window {
    KoretexWallet: typeof KoretexWallet;
  }
}

window.KoretexWallet = KoretexWallet;
