import { apiFetch } from '@/lib/api-fetch';
import { connectNearWallet, getEvmChainId, sendNearDeposit, sendQuotedDeposit } from '@/lib/evm-wallet';
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowRight, Clock3, Copy, ExternalLink, RefreshCw, ShieldCheck, Wallet } from "lucide-react";

type Asset = { assetId: string; decimals: number; blockchain: string; symbol: string; price?: number; contractAddress?: string | null };
type Quote = Record<string, unknown>;
type PaymentRecord = { paymentId: string; originAsset: string | null; destinationAsset: string | null; providerStatus: string; providerReference: string | null; quotePayload: Quote | null; createdAt: string; statusCheckedAt: string | null };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, { ...init, credentials: "same-origin", headers: { "Content-Type": "application/json", ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "The request could not be completed.");
  return body as T;
}

function text(value: unknown): string | null { return typeof value === "string" ? value : null; }
function formatBaseUnits(value: unknown, decimals: number): string | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const units = BigInt(value);
  const scale = 10n ** BigInt(decimals);
  const whole = (units / scale).toString();
  const fraction = (units % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
function quoteValue(quote: Quote | null, key: string): unknown {
  const nested = quote?.quote;
  return nested && typeof nested === "object" && key in nested ? (nested as Record<string, unknown>)[key] : quote?.[key];
}

export default function PaymentsPage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [feeSchedule, setFeeSchedule] = useState<"authenticated" | "unauthenticated">("unauthenticated");
  const [loadingAssets, setLoadingAssets] = useState(true);
  const [assetError, setAssetError] = useState("");
  const [originAsset, setOriginAsset] = useState("");
  const [destinationAsset, setDestinationAsset] = useState("");
  const [refundAddress, setRefundAddress] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [paymentId, setPaymentId] = useState("");
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [paymentsError, setPaymentsError] = useState("");
  const [quoteError, setQuoteError] = useState("");
  const [status, setStatus] = useState<Quote | null>(null);
  const [statusError, setStatusError] = useState("");
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [transactionHash, setTransactionHash] = useState("");
  const [sendError, setSendError] = useState("");
  const [nearWalletConnected, setNearWalletConnected] = useState(false);
  const origin = useMemo(() => assets.find((asset) => asset.assetId === originAsset), [assets, originAsset]);
  const destination = useMemo(() => assets.find((asset) => asset.assetId === destinationAsset), [assets, destinationAsset]);
  const depositAddress = text(quoteValue(quote, "depositAddress")) ?? "";
  const amountIn = text(quoteValue(quote, "amountIn")) ?? "";
  const isNearOrigin = origin?.blockchain.toLowerCase() === "near";
  const canSendInApp = Boolean(origin && ((getEvmChainId(origin.blockchain) && /^0x[0-9a-f]{40}$/i.test(depositAddress)) || (isNearOrigin && /^[a-z0-9._-]{2,64}$/.test(depositAddress))) && originAsset && depositAddress && amountIn && /^\d+$/.test(amountIn));
  const automaticAllocation = status?.automaticAllocation && typeof status.automaticAllocation === "object" ? status.automaticAllocation as Record<string, unknown> : null;

  async function loadAssets() {
    setLoadingAssets(true); setAssetError("");
    try {
      const catalog = await api<{ assets: Asset[]; feeSchedule: "authenticated" | "unauthenticated" }>("/api/integrations/near-intents/assets");
      const rows = catalog.assets;
      setFeeSchedule(catalog.feeSchedule);
      setAssets(rows);
      const firstAssetId = rows.find((asset) => asset.blockchain.toLowerCase() === "near" && asset.symbol.toUpperCase() === "NEAR")?.assetId || rows.find((asset) => asset.blockchain.toLowerCase() === "near")?.assetId || rows.find((asset) => asset.symbol === "USDC")?.assetId || rows[0]?.assetId || "";
      setOriginAsset((value) => value || firstAssetId);
      setDestinationAsset((value) => value || rows.find((asset) => asset.symbol === "USDC" && asset.assetId !== firstAssetId)?.assetId || rows.find((asset) => asset.assetId !== firstAssetId)?.assetId || "");
    } catch (error) { setAssetError(error instanceof Error ? error.message : "NEAR Intents asset list could not be loaded."); }
    finally { setLoadingAssets(false); }
  }

  useEffect(() => { void loadAssets(); }, []);

  async function loadPayments() {
    setPaymentsError("");
    try { setPayments(await api<PaymentRecord[]>("/api/integrations/near-intents/payments")); }
    catch (error) { setPaymentsError(error instanceof Error ? error.message : "Saved payment records could not be loaded."); }
  }

  useEffect(() => { void loadPayments(); }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setQuote(null); setStatus(null); setQuoteError(""); setStatusError("");
    const form = new FormData(event.currentTarget);
    try {
      const result = await api<Quote>("/api/integrations/near-intents/quotes", {
        method: "POST",
        headers: { "Idempotency-Key": requestKey },
        body: JSON.stringify({ originAsset, destinationAsset, amount: String(form.get("amount")).trim(), recipient: String(form.get("recipient")).trim(), refundTo: String(form.get("refundTo")).trim(), slippageTolerance: Number(form.get("slippage")) }),
      });
      const providerQuote = result.quote && typeof result.quote === "object" ? result.quote as Quote : null;
      if (!providerQuote || typeof result.paymentId !== "string") throw new Error(text(result.error) || "The provider quote was returned without its saved Veyra payment record.");
      setQuote(providerQuote);
      setPaymentId(result.paymentId);
      setRequestKey(crypto.randomUUID());
      void loadPayments();
    } catch (error) { setQuoteError(error instanceof Error ? error.message : "A quote could not be created."); }
  }

  async function connectNear() {
    try { setRefundAddress(await connectNearWallet()); setNearWalletConnected(true); setQuoteError(""); }
    catch (error) { setQuoteError(error instanceof Error ? error.message : "NEAR wallet connection was cancelled."); }
  }

  async function refreshStatus() {
    if (!paymentId) return;
    setCheckingStatus(true); setStatusError("");
    try {
      const result = await api<Quote>(`/api/integrations/near-intents/status?paymentId=${encodeURIComponent(paymentId)}`);
      setStatus(result);
      void loadPayments();
    }
    catch (error) { setStatusError(error instanceof Error ? error.message : "Status could not be retrieved."); }
    finally { setCheckingStatus(false); }
  }

  async function copyDeposit() {
    if (!depositAddress) return;
    await navigator.clipboard.writeText(depositAddress);
    setCopied(true); window.setTimeout(() => setCopied(false), 1800);
  }

  async function sendFromWallet() {
    if (!origin || !depositAddress || !amountIn || !paymentId) return;
    setSending(true); setSendError(""); setTransactionHash("");
    try {
      const hash = isNearOrigin ? await sendNearDeposit(origin, depositAddress, amountIn, text(quoteValue(quote, "depositMemo")) || undefined) : await sendQuotedDeposit(origin, depositAddress, amountIn);
      if (hash) {
        setTransactionHash(hash);
        try { await api(`/api/integrations/near-intents/${isNearOrigin ? "near-deposit-submitted" : "deposit-submitted"}`, { method: "POST", body: JSON.stringify({ paymentId, txHash: hash }) }); }
        catch { setSendError(`Wallet transaction sent (${hash}). Provider notification is optional; check status shortly.`); }
      } else if (isNearOrigin) {
        setNearWalletConnected(true);
        setSendError("The NEAR wallet approved the transfer. NEAR Intents monitors the deposit; check settlement status shortly.");
      }
      await refreshStatus();
    } catch (error) { setSendError(error instanceof Error ? error.message : "The wallet transaction was not sent."); }
    finally { setSending(false); }
  }

  function resumePayment(payment: PaymentRecord) {
    if (!payment.quotePayload) return;
    setPaymentId(payment.paymentId);
    setQuote(payment.quotePayload);
    setOriginAsset(payment.originAsset || "");
    setDestinationAsset(payment.destinationAsset || "");
    setStatus(null);
    setStatusError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return <div className="payments-page">
    <div className="page-intro"><p>Pay anyone through NEAR Intents. Choose the asset you will send and the asset and network your recipient should receive. Review the payment route, then approve it from your wallet.</p><span className="intro-stamp"><Wallet size={17} /> PAYMENTS · TESTNET</span></div>
    <div className="payments-layout">
      <section className="payment-card">
        <div className="payment-card-heading"><span className="payment-card-icon"><ArrowRight size={18} /></span><div><span className="page-eyebrow">SEND WITH NEAR INTENTS</span><h2>Pay someone</h2><p>You choose what to send. Set the asset and network the recipient should receive.</p></div></div>
        {loadingAssets ? <div className="payment-load"><RefreshCw size={17} className="spin" /> Checking supported assets…</div> : assetError ? <div className="payment-load payment-load-error"><span>{assetError}</span><button type="button" className="text-button" onClick={() => void loadAssets()}>Try again <ArrowRight size={14} /></button></div> : !assets.length ? <div className="payment-load">The provider returned no supported assets.</div> : <form className="form-stack" onSubmit={submit}>
          <div className="form-pair"><label>You send<select required value={originAsset} onChange={(event) => setOriginAsset(event.target.value)}>{assets.map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.symbol} · {asset.blockchain.toUpperCase()}</option>)}</select></label><label>Recipient gets<select required value={destinationAsset} onChange={(event) => setDestinationAsset(event.target.value)}>{assets.map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.symbol} · {asset.blockchain.toUpperCase()}</option>)}</select></label></div>
          <label>Amount to send<input name="amount" type="text" inputMode="decimal" required pattern="(?:0|[1-9][0-9]{0,23})(?:\.[0-9]{1,36})?" placeholder="0.00" /></label>
          <label>Recipient wallet address<input name="recipient" required maxLength={200} placeholder="Wallet address on their chosen network" autoComplete="off" /></label>
          <label>Your refund wallet<input name="refundTo" required maxLength={200} value={refundAddress} onChange={(event) => setRefundAddress(event.target.value)} placeholder="Your address on the network you send from" autoComplete="off" /></label>
          {isNearOrigin && <button type="button" className="button button-outline" onClick={() => void connectNear()}><Wallet size={15} /> {nearWalletConnected ? "Privy NEAR wallet ready" : "Use Privy NEAR wallet"}</button>}
          <label>Maximum slippage<select name="slippage" defaultValue="100"><option value="50">0.5%</option><option value="100">1%</option><option value="300">3%</option></select></label>
          {quoteError && <div><p className="form-error">{quoteError}</p><button type="button" className="text-button" onClick={() => { setRequestKey(crypto.randomUUID()); setQuoteError(""); }}>Try again as a new quote <ArrowRight size={14} /></button></div>}
          <button className="button button-green" type="submit" disabled={!origin || !destination || originAsset === destinationAsset}>Review payment <ArrowRight size={15} /></button>
          {originAsset === destinationAsset && <p className="form-footnote">Choose what you will send and what the recipient should receive.</p>}
        </form>}
        {feeSchedule === "unauthenticated" && !loadingAssets && !assetError && <p className="form-footnote payment-fee-note">Provider fees can vary. Review the exact send amount and estimate before approving your transfer.</p>}
      </section>

      <section className="payment-card payment-result">
        {quote ? <>
          <div className="payment-card-heading"><span className="payment-card-icon"><Clock3 size={18} /></span><div><span className="page-eyebrow">PAYMENT DETAILS</span><h2>Review before you pay</h2><p>NEAR Intents supplies the route and estimated delivery amount.</p></div></div>
          <div className="quote-summary"><div><span>YOU SEND</span><b>{text(quoteValue(quote, "amountInFormatted")) || text(quoteValue(quote, "amountIn")) || "See payment instructions"} {origin?.symbol}</b></div><ArrowRight size={16} /><div><span>RECIPIENT GETS · ESTIMATE</span><b>{text(quoteValue(quote, "amountOutFormatted")) || text(quoteValue(quote, "amountOut")) || "See payment estimate"} {destination?.symbol}</b></div></div>
          {text(quoteValue(quote, "amountOutUsd")) && <div className="quote-meta"><span>Estimated value</span><b>${text(quoteValue(quote, "amountOutUsd"))} USD</b></div>}
          {destination && formatBaseUnits(quoteValue(quote, "withdrawFee"), destination.decimals) && <div className="quote-meta"><span>Withdrawal fee (included in output)</span><b>{formatBaseUnits(quoteValue(quote, "withdrawFee"), destination.decimals)} {destination.symbol}</b></div>}
          {origin && formatBaseUnits(quoteValue(quote, "refundFee"), origin.decimals) && <div className="quote-meta"><span>Refund fee if route fails</span><b>{formatBaseUnits(quoteValue(quote, "refundFee"), origin.decimals)} {origin.symbol}</b></div>}
          <div className="deposit-box"><span>PAYMENT DEPOSIT ADDRESS</span><code>{depositAddress || "Payment instructions are unavailable"}</code>{depositAddress && <button type="button" className="button button-outline button-small" onClick={() => void copyDeposit()}><Copy size={14} /> {copied ? "Copied" : "Copy address"}</button>}</div>
          {canSendInApp && <button type="button" className="button button-green" onClick={() => void sendFromWallet()} disabled={sending || !paymentId}>{sending ? "Waiting for wallet approval…" : isNearOrigin ? (nearWalletConnected ? "Send with NEAR wallet" : "Approve with NEAR wallet") : "Send from connected wallet"} <Wallet size={15} /></button>}
          {transactionHash && <div className="quote-meta"><span>Wallet transaction</span><b><code>{transactionHash}</code></b></div>}
          {sendError && <p className="form-error">{sendError}</p>}
          <div className="quote-meta"><span>Quote expires</span><b>{text(quoteValue(quote, "deadline")) ? new Date(text(quoteValue(quote, "deadline"))!).toLocaleString() : "See provider response"}</b></div>
          <div className="quote-meta"><span>Route reference</span><b>{text(quote.correlationId) || text(quote.quoteId) || "Provider quote"}</b></div>
          {paymentId && <button type="button" className="button button-outline" onClick={() => void refreshStatus()} disabled={checkingStatus}><RefreshCw size={15} className={checkingStatus ? "spin" : ""} /> {checkingStatus ? "Checking status…" : "Check settlement status"}</button>}
          {status && <div className={`integration-status ${(text(status.status) || "").toLowerCase() === "success" ? "integration-status-success" : ""}`}><span>{text(status.status) || "Status received"}</span><small>{text(status.updatedAt) ? new Date(text(status.updatedAt)!).toLocaleString() : "Latest provider response"}</small></div>}
          {automaticAllocation?.status === "recorded" || automaticAllocation?.status === "already_recorded" ? <p className="payment-honesty">The saved income split was recorded in the internal ledger. No funds moved.</p> : automaticAllocation?.status === "retryable_failure" ? <p className="payment-error">The payment is settled, but automatic internal allocation needs a retry. Check the status again later.</p> : null}
          {statusError && <p className="form-error">{statusError}</p>}
          <p className="form-footnote">Review the network, amount, and token in your wallet before approval. The transfer starts only after you approve it. Veyra records no payment as settled until NEAR Intents confirms delivery.</p>
        </> : <div className="quote-empty"><span><ShieldCheck size={22} /></span><span className="page-eyebrow">PAYMENT PREVIEW</span><h2>Your payment details will appear here.</h2><p>Review what you send, what the recipient should receive, and the payment instructions before wallet approval.</p><div className="empty-route"><span>{origin?.symbol || "YOU SEND"}</span><ArrowRight size={15} /><span>{destination?.symbol || "THEY RECEIVE"}</span></div></div>}
      </section>
    </div>
    <section className="payment-history">
      <div className="payment-history-heading"><div><span className="page-eyebrow">PAYMENT ACTIVITY</span><h2>Recent payments</h2></div><button type="button" className="text-button" onClick={() => void loadPayments()}><RefreshCw size={14} /> Refresh list</button></div>
      {paymentsError ? <div className="payment-load payment-load-error">{paymentsError}</div> : payments.length ? <div className="payment-history-list">{payments.map((payment) => {
        const nested = payment.quotePayload?.quote;
        const quoteDetails = nested && typeof nested === "object" ? nested as Record<string, unknown> : {};
        const source = assets.find((asset) => asset.assetId === payment.originAsset);
        const target = assets.find((asset) => asset.assetId === payment.destinationAsset);
        return <article className="payment-history-row" key={payment.paymentId}><div className="payment-history-assets"><b>{source?.symbol || "Source"}</b><ArrowRight size={14} /><b>{target?.symbol || "Destination"}</b><small>{quoteDetails.amountOutFormatted ? `${String(quoteDetails.amountOutFormatted)} ${target?.symbol || ""} quoted` : "Quote request"}</small></div><span className={`status-pill ${payment.providerStatus.includes("PENDING") || payment.providerStatus === "PROCESSING" || payment.providerStatus === "KNOWN_DEPOSIT_TX" ? "status-pending" : payment.providerStatus === "QUOTE_FAILED" || payment.providerStatus === "FAILED" || payment.providerStatus === "REFUNDED" ? "status-muted" : "status-draft"}`}><span />{payment.providerStatus}</span><time>{new Date(payment.createdAt).toLocaleString()}</time><button type="button" className="button button-outline button-small" onClick={() => resumePayment(payment)} disabled={!payment.quotePayload}>Open</button></article>;
      })}</div> : <p className="payment-history-empty">Payments you create through NEAR Intents will appear here.</p>}
    </section>
    <div className="honesty-note"><ShieldCheck size={18} /><span><b>Provider status is the source of truth.</b> NEAR Intents documents a quote, deposit, and status flow, including pending, processing, success, refund, and failure states. Veyra never treats a quote as settled funds.</span></div>
    <a className="payment-doc-link" href="https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/making-a-request" target="_blank" rel="noreferrer">NEAR Intents flow documentation <ExternalLink size={13} /></a>
  </div>;
}
