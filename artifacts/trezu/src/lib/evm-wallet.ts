import { apiFetch } from "./api-fetch";
import { NearConnector, type ConnectorAction, type NearWalletBase, type WalletManifest } from "@hot-labs/near-connect";
import privyNearExecutorUrl from "@peerfolio/privy-near-connect/executor?url";

export type EvmWalletProvider = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
export type WalletAsset = { assetId: string; blockchain: string; symbol?: string; decimals?: number; contractAddress?: string | null };

const CHAIN_IDS: Record<string, string> = {
  // EVM test networks with live Tidepool routes only.
  eth: "0xaa36a7", ethereum: "0xaa36a7", arb: "0x66eee", arbitrum: "0x66eee",
  base: "0x14a34", bsc: "0x61", aurora: "0x4e454153",
};

const TEST_CHAIN_CONFIG: Record<string, { chainName: string; nativeCurrency: { name: string; symbol: string; decimals: number }; rpcUrls: string[]; blockExplorerUrls: string[] }> = {
  "0xaa36a7": { chainName: "Ethereum Sepolia", nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"], blockExplorerUrls: ["https://sepolia.etherscan.io"] },
  "0x66eee": { chainName: "Arbitrum Sepolia", nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc"], blockExplorerUrls: ["https://sepolia.arbiscan.io"] },
  "0x14a34": { chainName: "Base Sepolia", nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://sepolia.base.org"], blockExplorerUrls: ["https://sepolia.basescan.org"] },
  "0x61": { chainName: "BNB Smart Chain Testnet", nativeCurrency: { name: "Test BNB", symbol: "tBNB", decimals: 18 }, rpcUrls: ["https://bsc-testnet-dataseed.bnbchain.org"], blockExplorerUrls: ["https://testnet.bscscan.com"] },
  "0x4e454153": { chainName: "Aurora Testnet", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://testnet.aurora.dev"], blockExplorerUrls: ["https://explorer.testnet.aurora.dev"] },
};

async function ensureEvmTestChain(wallet: EvmWalletProvider, chainId: string): Promise<void> {
  const config = TEST_CHAIN_CONFIG[chainId];
  if (!config) throw new Error("The selected asset is not available on a configured EVM test network.");
  const current = (await wallet.request({ method: "eth_chainId" }) as string).toLowerCase();
  if (current === chainId) return;
  try { await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] }); }
  catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: number }).code : undefined;
    if (code !== 4902) throw error;
    await wallet.request({ method: "wallet_addEthereumChain", params: [{ chainId, ...config }] });
    await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  }
}

export function getEvmChainId(blockchain: string): string | null {
  return CHAIN_IDS[blockchain.toLowerCase() ] ?? null;
}

export function getEvmWallet(): EvmWalletProvider | null {
  return (window as Window & { ethereum?: EvmWalletProvider }).ethereum ?? null;
}

let nearConnector: NearConnector | null = null;
// This app uses the Privy NEAR wallet provisioned for the signed-in user.
const testnetWalletManifests: WalletManifest[] = [{
  id: "trezu-privy-near",
  name: "Trezu Privy Wallet",
  icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 48 48'><rect width='48' height='48' rx='12' fill='%231a7a5e'/><path d='M13 32 23 13h6L19 32zm10 0 8-15h6l-8 15z' fill='white'/></svg>",
  description: "Your NEAR testnet wallet managed by Privy.",
  website: window.location.origin,
  version: "1.0.0",
  executor: privyNearExecutorUrl,
  type: "sandbox",
  platform: [],
  features: {
    signMessage: true, signTransaction: false, signAndSendTransaction: true,
    signAndSendTransactions: true, signInWithoutAddKey: true,
    signInAndSignMessage: true, signInWithFunctionCallKey: true,
    signDelegateActions: false, mainnet: false, testnet: true,
  },
  permissions: { isPrivyConnect: true, storage: true, allowsOpen: [window.location.origin] },
  // near-connect preserves custom metadata at runtime; the Privy adapter uses
  // this same-origin page to request an explicit transaction approval.
  metadata: { signPageURL: `${window.location.origin}/sign`, debug: false },
} as WalletManifest & { metadata: { signPageURL: string; debug: boolean } }];
async function getNearConnector() {
  nearConnector ??= new NearConnector({
    network: "testnet",
    manifest: { wallets: testnetWalletManifests, version: "1.0.0" },
    features: {
      testnet: true,
      signMessage: true,
      signAndSendTransaction: true,
      signAndSendTransactions: true,
    },
  });
  await nearConnector.whenManifestLoaded;
  return nearConnector;
}

function base58Encode(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = BigInt(`0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`);
  let encoded = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    encoded = alphabet[remainder] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded;
}

function signerPublicKey(account: { accountId: string; publicKey?: string }): string {
  if (account.publicKey) return account.publicKey;
  if (!/^[0-9a-f]{64}$/i.test(account.accountId)) throw new Error(`Privy did not provide a public key for NEAR account ${account.accountId}.`);
  const publicKey = base58Encode(Uint8Array.from(account.accountId.match(/.{2}/g)!, (byte) => Number.parseInt(byte, 16)));
  return `ed25519:${publicKey}`;
}

export function setPreferredNearTestnetAccount(accountId: string): void {
  if (!/^[0-9a-f]{64}$/i.test(accountId)) throw new Error("The selected Privy NEAR testnet wallet address is invalid.");
  localStorage.setItem("trezu_privy_near_signer_account", accountId.toLowerCase());
}

export async function resolveNearOwnerTestnetAccount(): Promise<string | null> {
  const response = await apiFetch("/api/auth/wallets", { credentials: "include" });
  if (response.status === 401) return null;
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Your linked NEAR wallets could not be loaded.");
  const candidates = (body.wallets || []).filter((wallet: { network: string; address: string }) => wallet.network === "near:testnet" && /^[0-9a-f]{64}$/i.test(wallet.address));
  const active = await Promise.all(candidates.map(async (wallet: { address: string; provider?: string | null }) => {
    try {
      const rpc = await fetch("https://rpc.testnet.near.org", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: `trezu-owner-wallet-${wallet.address}`, method: "query", params: { request_type: "view_access_key_list", finality: "final", account_id: wallet.address } }), signal: AbortSignal.timeout(10_000) });
      const result = await rpc.json() as { result?: { keys?: unknown[] }; error?: unknown };
      if (!rpc.ok || result.error || !result.result?.keys?.length) return null;
      return { ...wallet, keyCount: result.result.keys.length };
    } catch { return null; }
  }));
  const usable = active.filter((wallet): wallet is Exclude<typeof wallet, null> => wallet !== null).sort((a, b) => Number(b.provider === "privy") - Number(a.provider === "privy"));
  const wallet = usable[0];
  if (!wallet) throw new Error("No active NEAR testnet signing wallet is linked to this Trezu account. The newly generated address must first be funded and initialized on testnet.");
  setPreferredNearTestnetAccount(wallet.address);
  return wallet.address;
}

async function assertNearTestnetSigner(account: { accountId: string; publicKey?: string }): Promise<void> {
  const publicKey = signerPublicKey(account);
  let response: Response;
  try {
    response = await fetch("https://rpc.testnet.near.org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "trezu-wallet-check", method: "query", params: { request_type: "view_access_key", finality: "final", account_id: account.accountId, public_key: publicKey } }),
    });
  } catch {
    throw new Error("Could not verify your Privy NEAR wallet on testnet. Check your connection and retry.");
  }
  if (!response.ok) throw new Error("Could not verify your Privy NEAR wallet on testnet. Retry in a moment.");
  const result = await response.json() as { result?: { error?: string }; error?: { message?: string } };
  if (result.result?.error || result.error) {
    throw new Error(`Your selected NEAR testnet wallet (${account.accountId}) has no active on-chain signing key. No payment was sent. Check that this exact wallet address is the one funded on testnet.`);
  }
}

export async function connectNearWallet(): Promise<string> {
  const preferredAccount = await resolveNearOwnerTestnetAccount();
  const connector = await getNearConnector();
  let staleWallet: NearWalletBase | undefined;
  try {
    const { wallet, accounts } = await connector.getConnectedWallet();
    staleWallet = wallet;
    if (wallet.manifest.id === "trezu-privy-near" && accounts[0]?.accountId) {
      await assertNearTestnetSigner(accounts[0]);
      if (preferredAccount && preferredAccount.toLowerCase() !== accounts[0].accountId.toLowerCase()) {
        throw new Error(`Privy selected ${accounts[0].accountId}, but the funded owner wallet is ${preferredAccount}. Reconnect the owner wallet and retry.`);
      }
      setPreferredNearTestnetAccount(accounts[0].accountId);
      return accounts[0].accountId;
    }
  } catch {
    // An unusable saved account must be disconnected before opening the
    // signer for the active owner account.
  }
  if (staleWallet) { try { await connector.disconnect(staleWallet); } catch { /* Continue to the explicit reconnect path. */ } }
  let wallet: NearWalletBase;
  try {
    wallet = await connector.connect({ walletId: "trezu-privy-near" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Network request failed";
    throw new Error(`Could not open your Privy NEAR testnet wallet. Check your connection and try again. (${detail})`);
  }
  const [signerAccount] = await wallet.getAccounts({ network: "testnet" });
  if (!signerAccount?.accountId) throw new Error("The selected NEAR testnet wallet did not return an account.");
  await assertNearTestnetSigner(signerAccount);
  if (preferredAccount && preferredAccount.toLowerCase() !== signerAccount.accountId.toLowerCase()) {
    throw new Error(`Privy selected ${signerAccount.accountId}, but the funded owner wallet is ${preferredAccount}. Reconnect the owner wallet and retry.`);
  }
  setPreferredNearTestnetAccount(signerAccount.accountId);
  return signerAccount.accountId;
}

export async function linkNearWalletToTrezu(): Promise<{ address: string; network: string }> {
  const accountId = await connectNearWallet();
  const connector = await getNearConnector();
  const wallet = await connector.wallet();
  const challengeResponse = await apiFetch("/api/auth/wallet-link/challenge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ network: "near:testnet" }) });
  const challenge = await challengeResponse.json();
  if (!challengeResponse.ok) throw new Error(challenge.error || "Could not prepare wallet linking.");
  const signed = await wallet.signMessage({ message: challenge.message, recipient: challenge.recipient, nonce: decodeBase64Url(challenge.nonce) });
  if (!signed?.signature || !signed.publicKey) throw new Error("The wallet did not return a signature.");
  const response = await apiFetch("/api/auth/wallet-link/near", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId, publicKey: signed.publicKey, signature: signed.signature, nonce: challenge.nonce, message: challenge.message, recipient: challenge.recipient }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Could not link this NEAR wallet.");
  return { address: accountId, network: "near:testnet" };
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

export async function linkEvmWalletToTrezu(walletOverride?: EvmWalletProvider): Promise<{ address: string; network: string }> {
  const wallet = walletOverride ?? getEvmWallet();
  if (!wallet) throw new Error("Install or open an EVM wallet to link it to Trezu.");
  const accounts = await wallet.request({ method: "eth_requestAccounts" }) as string[];
  const address = accounts?.[0];
  if (!address) throw new Error("Connect an EVM wallet account to continue.");
  let chainIdHex = (await wallet.request({ method: "eth_chainId" }) as string).toLowerCase();
  if (!TEST_CHAIN_CONFIG[chainIdHex]) {
    await ensureEvmTestChain(wallet, "0xaa36a7");
    chainIdHex = "0xaa36a7";
  }
  const chainId = Number.parseInt(chainIdHex, 16);
  const network = `evm:${chainId}`;
  const challengeResponse = await apiFetch("/api/auth/wallet-link/challenge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ network }) });
  const challenge = await challengeResponse.json();
  if (!challengeResponse.ok) throw new Error(challenge.error || "Could not prepare wallet linking.");
  const signature = await wallet.request({ method: "personal_sign", params: [challenge.message, address] }) as string;
  const response = await apiFetch("/api/auth/wallet-link/evm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address, signature, nonce: challenge.nonce, message: challenge.message, chainId }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Could not link this EVM wallet.");
  return { address, network };
}

export async function sendQuotedDeposit(asset: WalletAsset, depositAddress: string, amountIn: string, walletOverride?: EvmWalletProvider): Promise<string> {
  const wallet = walletOverride ?? getEvmWallet();
  const chainId = getEvmChainId(asset.blockchain);
  if (!wallet) throw new Error("Install or open an EVM wallet to send directly from Trezu.");
  if (!chainId) throw new Error(`In-app wallet sending is not available for ${asset.blockchain.toUpperCase()} yet.`);
  if (!/^0x[0-9a-f]{40}$/i.test(depositAddress) || !/^\d+$/.test(amountIn) || BigInt(amountIn) <= 0n) throw new Error("The signed quote is missing valid EVM deposit details.");
  const accounts = await wallet.request({ method: "eth_requestAccounts" }) as string[];
  const from = accounts?.[0];
  if (!from) throw new Error("Connect a wallet account to continue.");
  await ensureEvmTestChain(wallet, chainId);
  const value = `0x${BigInt(amountIn).toString(16)}`;
  if (asset.contractAddress) {
    if (!/^0x[0-9a-f]{40}$/i.test(asset.contractAddress)) throw new Error("The provider returned an unsupported token contract address.");
    const recipient = depositAddress.slice(2).toLowerCase().padStart(64, "0");
    const amount = BigInt(amountIn).toString(16).padStart(64, "0");
    return await wallet.request({ method: "eth_sendTransaction", params: [{ from, to: asset.contractAddress, value: "0x0", data: `0xa9059cbb${recipient}${amount}` }] }) as string;
  }
  return await wallet.request({ method: "eth_sendTransaction", params: [{ from, to: depositAddress, value }] }) as string;
}

/** Submit a contract call from Privy on Base Sepolia after an explicit wallet approval. */
export async function sendBaseSepoliaContractCall(wallet: EvmWalletProvider, contract: string, data: string): Promise<string> {
  if (!/^0x[0-9a-f]{40}$/i.test(contract) || !/^0x[0-9a-f]+$/i.test(data)) throw new Error("The DeFi transaction details are invalid.");
  const chainId = "0x14a34";
  const accounts = await wallet.request({ method: "eth_requestAccounts" }) as string[];
  const from = accounts?.[0];
  if (!from) throw new Error("Sign in to Privy to approve this Base Sepolia transaction.");
  await ensureEvmTestChain(wallet, chainId);
  return await wallet.request({ method: "eth_sendTransaction", params: [{ from, to: contract, value: "0x0", data }] }) as string;
}

export async function waitForEvmTransaction(wallet: EvmWalletProvider, hash: string, timeoutMs = 120_000): Promise<void> {
  if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error("The wallet did not return a valid transaction reference.");
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const receipt = await wallet.request({ method: "eth_getTransactionReceipt", params: [hash] }) as { status?: string } | null;
    if (receipt) {
      if (receipt.status?.toLowerCase() !== "0x1") throw new Error("The transaction was included but reverted. Your token balance was not supplied or withdrawn.");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  throw new Error("The transaction is still pending. Check Base Sepolia before trying again.");
}

export async function sendNearDeposit(asset: WalletAsset, depositAddress: string, amountIn: string, memo?: string): Promise<string | void> {
  if (asset.blockchain.toLowerCase() !== "near") throw new Error("Select a NEAR source asset to use the NEAR wallet.");
  if (!/^[a-z0-9._-]{2,64}$/.test(depositAddress) || !/^\d+$/.test(amountIn) || BigInt(amountIn) <= 0n) throw new Error("The signed quote is missing valid NEAR deposit details.");
  const connector = await getNearConnector();
  const accountId = await connectNearWallet();
  const wallet = await connector.wallet();
  await assertNearAccountExists(accountId);
  const assetContract = asset.contractAddress || asset.assetId.replace(/^nep141:/, "").replace(/\.omft\.near$/, "");
  if (asset.assetId === "near:native" || asset.assetId === "native:near") {
    await assertNearNativeBalance(accountId, BigInt(amountIn));
    let result: unknown;
    try {
      result = await wallet.signAndSendTransaction({
        network: "testnet",
        signerId: accountId,
        receiverId: depositAddress,
        actions: [{ type: "Transfer", params: { deposit: amountIn } }],
      });
    } catch (error) { throw normalizeNearBalanceError(error); }
    return transactionHash(result);
  }
  if (!/^[a-z0-9._-]{2,64}$/.test(assetContract)) throw new Error("The provider returned an unsupported NEAR token contract.");
  if (!assetContract.endsWith(".testnet")) throw new Error("This token is not deployed on NEAR testnet. Choose a testnet asset before sending.");
  const balanceResponse = await fetch("https://rpc.testnet.near.org", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "trezu-token-balance", method: "query", params: { request_type: "call_function", finality: "final", account_id: assetContract, method_name: "ft_balance_of", args_base64: btoa(JSON.stringify({ account_id: accountId })) } }),
  });
  if (!balanceResponse.ok) throw new Error(`Could not check your ${asset.symbol || "NEAR token"} balance on testnet. Retry in a moment.`);
  const balanceResult = await balanceResponse.json() as { result?: { result?: number[] }; error?: unknown };
  if (balanceResult.error || !Array.isArray(balanceResult.result?.result)) throw new Error(`Could not check your ${asset.symbol || "NEAR token"} balance on testnet. Retry in a moment.`);
  let balance = 0n;
  try {
    const value = JSON.parse(new TextDecoder().decode(Uint8Array.from(balanceResult.result.result)));
    if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("Invalid token balance");
    balance = BigInt(value);
  } catch {
    throw new Error(`Could not read your ${asset.symbol || "NEAR token"} balance on testnet. Retry in a moment.`);
  }
  const required = BigInt(amountIn);
  if (balance < required) {
    const decimals = asset.decimals ?? 24;
    const formatUnits = (units: bigint) => {
      const scale = 10n ** BigInt(decimals);
      const fraction = (units % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
      return `${units / scale}${fraction ? `.${fraction}` : ""}`;
    };
    const symbol = asset.symbol || "NEAR token";
    throw new Error(`Your wallet has ${formatUnits(balance)} ${symbol}, but this quote needs ${formatUnits(required)} ${symbol}. Native NEAR and wNEAR are separate tokens. Get test ${symbol} from the Tidepool faucet.`);
  }
  const actions = [
    ...nearStorageRegistration(assetContract, accountId).actions,
    ...nearStorageRegistration(assetContract, depositAddress).actions,
    ...nearTokenTransfer(assetContract, depositAddress, amountIn, memo).actions,
  ];
  const outcome = await wallet.signAndSendTransaction({ network: "testnet", signerId: accountId, receiverId: assetContract, actions });
  return transactionHash(outcome);
}

export type NearBatchDeposit = { depositAddress: string; amountIn: string; memo?: string };
export type NearBatchCallbacks = {
  onRequesting?: (index: number, total: number) => void;
  onSubmitted?: (index: number, transactionHash?: string) => void | Promise<void>;
};

/** Submit NEAR Intents deposits, combining fungible-token transfers when gas allows. */
export async function sendNearDepositsBatch(asset: WalletAsset, deposits: NearBatchDeposit[], callbacks: NearBatchCallbacks = {}): Promise<(string | undefined)[]> {
  if (asset.blockchain.toLowerCase() !== "near") throw new Error("Select a NEAR source asset to batch payroll deposits.");
  if (!deposits.length) throw new Error("Select at least one payroll payment.");
  for (const deposit of deposits) {
    if (!/^[a-z0-9._-]{2,64}$/.test(deposit.depositAddress) || !/^\d+$/.test(deposit.amountIn) || BigInt(deposit.amountIn) <= 0n) throw new Error("A payroll quote has invalid NEAR deposit details. Refresh the quote before sending.");
  }
  const connector = await getNearConnector();
  const accountId = await connectNearWallet();
  const wallet = await connector.wallet();
  await assertNearAccountExists(accountId);
  const assetContract = asset.contractAddress || asset.assetId.replace(/^nep141:/, "").replace(/\.omft\.near$/, "");
  const isNative = asset.assetId === "near:native" || asset.assetId === "native:near";
  if (isNative) {
    await assertNearNativeBalance(accountId, deposits.reduce((sum, item) => sum + BigInt(item.amountIn), 0n));
    const hashes: (string | undefined)[] = [];
    for (const [index, { depositAddress, amountIn }] of deposits.entries()) {
      callbacks.onRequesting?.(index, deposits.length);
      let outcome: unknown;
      try { outcome = await wallet.signAndSendTransaction({ network: "testnet", signerId: accountId, receiverId: depositAddress, actions: [{ type: "Transfer", params: { deposit: amountIn } }] }); }
      catch (error) { throw normalizeNearBalanceError(error); }
      const hash = transactionHash(outcome);
      hashes.push(hash);
      await callbacks.onSubmitted?.(index, hash);
    }
    return hashes;
  }

  if (!/^[a-z0-9._-]{2,64}$/.test(assetContract)) throw new Error("The provider returned an unsupported NEAR token contract.");
  if (!assetContract.endsWith(".testnet")) throw new Error("This token is not deployed on NEAR testnet. Choose a testnet asset before sending.");
  const requiredTokenBalance = deposits.reduce((sum, item) => sum + BigInt(item.amountIn), 0n);
  const availableTokenBalance = await readNearFtBalance(assetContract, accountId, asset.symbol || "token");
  if (availableTokenBalance < requiredTokenBalance) {
    throw new Error(`Insufficient ${asset.symbol || "token"} balance. Your selected wallet has ${formatNearUnits(availableTokenBalance, asset.decimals ?? 24)} ${asset.symbol || "token"}; this payment requires ${formatNearUnits(requiredTokenBalance, asset.decimals ?? 24)}.`);
  }
  // Registration + two token actions per recipient uses about 90 Tgas each.
  // NEAR transactions cap gas at 300 Tgas, so send any size run in signed
  // groups of four and report every transfer against its originating quote.
  const hashes: (string | undefined)[] = [];
  const groupSize = 4; // one sender registration plus two 30 Tgas actions per recipient
  for (let offset = 0; offset < deposits.length; offset += groupSize) {
    const group = deposits.slice(offset, offset + groupSize);
    callbacks.onRequesting?.(offset, deposits.length);
    const actions: ConnectorAction[] = [
      ...nearStorageRegistration(assetContract, accountId).actions,
      ...group.flatMap(({ depositAddress, amountIn, memo }) => [
        ...nearStorageRegistration(assetContract, depositAddress).actions,
        ...nearTokenTransfer(assetContract, depositAddress, amountIn, memo).actions,
      ]),
    ];
    let outcome: unknown;
    try { outcome = await wallet.signAndSendTransaction({ network: "testnet", signerId: accountId, receiverId: assetContract, actions }); }
    catch (error) { throw normalizeNearBalanceError(error); }
    const hash = transactionHash(outcome);
    for (let localIndex = 0; localIndex < group.length; localIndex += 1) {
      const index = offset + localIndex;
      hashes.push(hash);
      await callbacks.onSubmitted?.(index, hash);
    }
  }
  return hashes;
}

async function nearRpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const response = await fetch("https://rpc.testnet.near.org", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "trezu-wallet-preflight", method, params }),
  });
  if (!response.ok) throw new Error("Could not check this wallet's NEAR testnet balance. Retry in a moment.");
  const body = await response.json() as { result?: T; error?: { message?: string } };
  if (body.error || body.result === undefined) throw new Error(body.error?.message || "Could not check this wallet's NEAR testnet balance. Retry in a moment.");
  return body.result;
}

async function assertNearAccountExists(accountId: string): Promise<void> {
  try {
    await nearRpc("query", { request_type: "view_account", finality: "final", account_id: accountId });
  } catch {
    throw new Error("This selected wallet does not have a NEAR testnet account yet. Fund or activate this wallet, then retry.");
  }
}

async function assertNearNativeBalance(accountId: string, transferTotal: bigint): Promise<void> {
  const account = await nearRpc<{ amount: string }>("query", { request_type: "view_account", finality: "final", account_id: accountId });
  // Leave a modest reserve for transaction fees; storage deposits for FT transfers
  // are surfaced separately by the contract if recipient registration is needed.
  const required = transferTotal + 10_000_000_000_000_000_000_000n;
  if (BigInt(account.amount) < required) {
    throw new Error(`Insufficient NEAR balance. This wallet needs enough NEAR for the transfer and network fees.`);
  }
}

async function readNearFtBalance(contract: string, accountId: string, symbol: string): Promise<bigint> {
  const result = await nearRpc<{ result?: number[] }>("query", {
    request_type: "call_function", finality: "final", account_id: contract,
    method_name: "ft_balance_of", args_base64: btoa(JSON.stringify({ account_id: accountId })),
  });
  if (!Array.isArray(result.result)) throw new Error(`Could not read your ${symbol} balance on testnet. Retry in a moment.`);
  try {
    const value = JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result)));
    if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("Invalid token balance");
    return BigInt(value);
  } catch { throw new Error(`Could not read your ${symbol} balance on testnet. Retry in a moment.`); }
}

function formatNearUnits(units: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const fraction = (units % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${units / scale}${fraction ? `.${fraction}` : ""}`;
}

function normalizeNearBalanceError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/not enough balance|insufficient balance|balance.*too low|doesn't have enough balance/i.test(message)) {
    return new Error("Insufficient NEAR balance in the selected wallet to cover this payment and required network or storage fees.");
  }
  return error instanceof Error ? error : new Error("The NEAR wallet could not submit this payment.");
}

function nearStorageRegistration(tokenContract: string, accountId: string): { receiverId: string; actions: ConnectorAction[] } {
  return {
    receiverId: tokenContract,
    actions: [{
      type: "FunctionCall",
      params: {
        methodName: "storage_deposit",
        args: { account_id: accountId, registration_only: true },
        gas: "30000000000000",
        deposit: "1250000000000000000000",
      },
    }],
  };
}

function nearTokenTransfer(tokenContract: string, recipient: string, amount: string, memo?: string): { receiverId: string; actions: ConnectorAction[] } {
  return {
    receiverId: tokenContract,
    actions: [{
      type: "FunctionCall",
      params: {
        methodName: "ft_transfer",
        args: { receiver_id: recipient, amount, ...(memo ? { memo } : {}) },
        gas: "30000000000000",
        deposit: "1",
      },
    }],
  };
}

function transactionHash(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const result = value as { transaction?: { hash?: unknown }; transaction_outcome?: { id?: unknown } };
  if (typeof result.transaction?.hash === "string") return result.transaction.hash;
  if (typeof result.transaction_outcome?.id === "string") return result.transaction_outcome.id;
  return undefined;
}
