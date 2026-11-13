const USD_STABLECOINS = new Set(["USDC", "USDT"]);

export function invoiceCurrencyMatchesAsset(currency: string, assetSymbol: string): boolean {
  const invoiceCurrency = currency.toUpperCase();
  const symbol = assetSymbol.toUpperCase();
  return invoiceCurrency === symbol || (invoiceCurrency === "USD" && USD_STABLECOINS.has(symbol));
}
