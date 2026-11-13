// Aave V3 Base Sepolia deployment addresses from the Aave DAO address book.
// See https://github.com/aave-dao/aave-address-book/blob/main/src/AaveV3BaseSepolia.sol
export const AAVE_BASE_SEPOLIA = {
  chainId: "0x14a34",
  chainIdDecimal: 84532,
  pool: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
  usdc: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
  aUsdc: "0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC",
  decimals: 6,
  strategyId: "aave-v3-base-sepolia-usdc",
} as const;

const word = (value: bigint) => value.toString(16).padStart(64, "0");
const addressWord = (address: string) => address.slice(2).toLowerCase().padStart(64, "0");

export function parseUsdcUnits(value: string): bigint {
  if (!/^(?:0|[1-9]\d{0,17})(?:\.\d{1,6})?$/.test(value)) throw new Error("Enter a valid USDC amount with up to six decimal places.");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

export function formatUsdcUnits(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

export function approveUsdcCall(amount: bigint): string {
  return `0x095ea7b3${addressWord(AAVE_BASE_SEPOLIA.pool)}${word(amount)}`;
}

export function aaveSupplyCall(amount: bigint, walletAddress: string): string {
  return `0x617ba037${addressWord(AAVE_BASE_SEPOLIA.usdc)}${word(amount)}${addressWord(walletAddress)}${word(0n)}`;
}

export function aaveWithdrawCall(amount: bigint, walletAddress: string): string {
  return `0x69328dec${addressWord(AAVE_BASE_SEPOLIA.usdc)}${word(amount)}${addressWord(walletAddress)}`;
}
