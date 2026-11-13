import { createHash, createPublicKey, verify } from "node:crypto";

// Tidepool is the community-operated, testnet-only 1Click-compatible sandbox.
// Keep this build isolated from the production 1Click API.
const API_BASE = "https://www.usetidepool.tech/v0";
const REQUEST_TIMEOUT_MS = 12_000;
const TIDEPOOL_MAKER_PUB_KEY = "ed25519:U1Mu4u1nHnHmgABpCkfDGXt2FZj8k29UGqhkMAu4iWY";

export type NearIntentAsset = {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price?: number;
  priceUpdatedAt?: string;
  contractAddress?: string | null;
};

let assetCache: { expiresAt: number; assets: NearIntentAsset[] } | undefined;

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  headers.set("Content-Type", "application/json");
  const apiKey = process.env.NEAR_INTENTS_JWT;
  if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "message" in body && typeof body.message === "string"
        ? body.message
        : `NEAR Intents returned HTTP ${response.status}`;
    throw new NearIntentsError(message, response.status >= 500 ? 503 : 502);
  }
  return body;
}

export class NearIntentsError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "NearIntentsError";
  }
}

function base58Decode(input: string): Buffer {
  input = input.replace(/^ed25519:/, "");
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const character of input) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error("Invalid base58 data");
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) { bytes.unshift(Number(value & 255n)); value >>= 8n; }
  for (let i = 0; i < input.length && input[i] === "1"; i += 1) bytes.unshift(0);
  return Buffer.from(bytes);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function verifyProviderQuote(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  const request = response.quoteRequest as Record<string, unknown> | undefined;
  const quote = response.quote as Record<string, unknown> | undefined;
  if (!request || !quote || typeof response.timestamp !== "string" || typeof response.signature !== "string") return false;
  const requiredRequestKeys = ["dry", "swapType", "slippageTolerance", "originAsset", "depositType", "destinationAsset", "amount", "refundTo", "refundType", "recipient", "recipientType", "deadline"];
  const optionalRequestKeys = ["quoteWaitingTimeMs", "referral", "virtualChainRecipient", "virtualChainRefundRecipient", "customRecipientMsg"];
  const signedRequest = Object.fromEntries([
    ...requiredRequestKeys.filter((key) => request[key] !== undefined),
    ...optionalRequestKeys.filter((key) => request[key]),
  ].map((key) => [key, request[key]]));
  const signedQuoteKeys = ["amountIn", "amountInFormatted", "amountInUsd", "minAmountIn", "amountOut", "amountOutFormatted", "amountOutUsd", "minAmountOut"];
  const optionalQuoteKeys = ["depositAddress", "depositMemo", "deadline", "timeWhenInactive", "timeEstimate", "refundFee", "withdrawFee"];
  if (!request.dry) signedQuoteKeys.push(...optionalQuoteKeys);
  const requiredQuoteKeys = signedQuoteKeys.filter((key) => !optionalQuoteKeys.includes(key));
  const signedQuote = Object.fromEntries([
    ...requiredQuoteKeys.filter((key) => quote[key] !== undefined),
    ...optionalQuoteKeys.filter((key) => !request.dry && quote[key]),
  ].map((key) => [key, quote[key]]));
  const digest = createHash("sha256").update(stableJson({ ...signedRequest, ...signedQuote, timestamp: response.timestamp })).digest();
  const quoteHash = base58Encode(digest);
  try {
    const keyText = TIDEPOOL_MAKER_PUB_KEY.replace(/^ed25519:/, "");
    const publicKey = base58Decode(keyText);
    const signature = base58Decode(response.signature);
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKey]), format: "der", type: "spki" });
    return verify(null, Buffer.from(quoteHash, "utf8"), key, signature);
  } catch { return false; }
}

function base58Encode(input: Buffer): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = BigInt(`0x${input.toString("hex") || "0"}`);
  let result = "";
  while (value > 0n) { const digit = Number(value % 58n); result = alphabet[digit] + result; value /= 58n; }
  for (const byte of input) { if (byte !== 0) break; result = `1${result}`; }
  return result;
}

export async function getSupportedAssets(): Promise<NearIntentAsset[]> {
  if (assetCache && assetCache.expiresAt > Date.now()) return assetCache.assets;
  const result = await request("/tokens");
  if (!Array.isArray(result)) throw new NearIntentsError("Unexpected token catalog response", 502);
  const assets = result.filter((item): item is NearIntentAsset =>
    !!item && typeof item === "object" &&
    typeof item.assetId === "string" && typeof item.symbol === "string" &&
    typeof item.blockchain === "string" && Number.isInteger(item.decimals) &&
    item.decimals >= 0 && item.decimals <= 36,
  );
  assetCache = { assets, expiresAt: Date.now() + 60_000 };
  return assets;
}

export function toBaseUnits(amount: string, decimals: number): string | null {
  if (!/^(?:0|[1-9]\d{0,23})(?:\.\d{1,36})?$/.test(amount)) return null;
  const [whole, fraction = ""] = amount.split(".");
  if (fraction.length > decimals) return null;
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0")).toString();
}

export async function requestQuote(input: {
  originAsset: string;
  destinationAsset: string;
  amount: string;
  recipient: string;
  refundTo: string;
  slippageTolerance: number;
  swapType?: "EXACT_INPUT" | "EXACT_OUTPUT";
}): Promise<unknown> {
  const assets = await getSupportedAssets();
  const origin = assets.find((asset) => asset.assetId === input.originAsset);
  const destination = assets.find((asset) => asset.assetId === input.destinationAsset);
  if (!origin || !destination) throw new NearIntentsError("Select assets currently supported by NEAR Intents.", 400);
  const swapType = input.swapType ?? "EXACT_INPUT";
  const amountDecimals = swapType === "EXACT_OUTPUT" ? destination.decimals : origin.decimals;
  const amount = toBaseUnits(input.amount, amountDecimals);
  if (!amount || BigInt(amount) <= 0n) throw new NearIntentsError("Enter an amount that fits the selected asset precision.", 400);

  const result = await request("/quote", {
    method: "POST",
    body: JSON.stringify({
      dry: false,
      swapType,
      slippageTolerance: input.slippageTolerance,
      originAsset: origin.assetId,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: destination.assetId,
      amount,
      recipient: input.recipient,
      recipientType: "DESTINATION_CHAIN",
      refundTo: input.refundTo,
      refundType: "ORIGIN_CHAIN",
      deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
    }),
  });
  if (!verifyProviderQuote(result)) throw new NearIntentsError("NEAR Intents returned a quote with an invalid signature. No deposit details were accepted.", 502);
  return result;
}

export async function getQuoteStatus(depositAddress: string): Promise<unknown> {
  return request(`/status?depositAddress=${encodeURIComponent(depositAddress)}`);
}

export async function submitDeposit(depositAddress: string, txHash: string): Promise<unknown> {
  return request("/deposit/submit", { method: "POST", body: JSON.stringify({ depositAddress, txHash }) });
}
