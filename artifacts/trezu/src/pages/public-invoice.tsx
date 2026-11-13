import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowRight, Copy, RefreshCw, ShieldCheck, Wallet } from "lucide-react";
import { connectNearWallet, getEvmChainId, sendNearDeposit, sendQuotedDeposit } from "@/lib/evm-wallet";
import { usePrivyWallet } from "@/lib/wallet-integrations";

type Asset = { assetId: string; decimals: number; blockchain: string; symbol: string; contractAddress?: string | null };
type Invoice = { invoiceNumber: string; clientName: string; description: string; lineItems: { description: string; amount: string }[]; dueDate: string | null; notes: string | null; paymentTerms: string | null; amount: string; amountPaid: string; amountDue: string; currency: string; status: string; destinationAssetId: string; destinationAssetSymbol: string; destinationAssetNetwork?: string; paymentRecipient: string; pendingPayment?: { paymentId: string; status: string } | null };
type Quote = Record<string, unknown>;
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "This request could not be completed.");
  return result as T;
}
const str = (value: unknown) => typeof value === "string" ? value : "";

export default function PublicInvoicePage({ token }: { token: string }) {
  const privyWallet = usePrivyWallet();
  const [nearAccountDraft, setNearAccountDraft] = useState("");
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [origin, setOrigin] = useState("");
  const [amountToPay, setAmountToPay] = useState("");
  const [refundTo, setRefundTo] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [paymentId, setPaymentId] = useState("");
  const [receiptPaymentId, setReceiptPaymentId] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [depositSubmitted, setDepositSubmitted] = useState(false);
  const details = useMemo(() => quote?.quote && typeof quote.quote === "object" ? quote.quote as Record<string, unknown> : {}, [quote]);
  const asset = assets.find((item) => item.assetId === origin);
  const depositAddress = str(details.depositAddress);
  const isNearOrigin = asset?.blockchain.toLowerCase() === "near";
  const canSendInApp = Boolean(asset && ((getEvmChainId(asset.blockchain) && /^0x[0-9a-f]{40}$/i.test(depositAddress)) || (isNearOrigin && /^[a-z0-9._-]{2,64}$/.test(depositAddress))) && /^\d+$/.test(str(details.amountIn)));

  useEffect(() => {
    let active = true;
    api<Invoice>(`/api/public/invoices/${token}`).then(async (inv) => {
      if (!active) return;
      setInvoice(inv);
      setAmountToPay(inv.amountDue || inv.amount);
      if (inv.pendingPayment) {
        setPaymentId(inv.pendingPayment.paymentId);
        setDepositSubmitted(true);
        setStatus(inv.pendingPayment.status);
        return;
      }
      if (inv.status === "paid") {
        const receipts = await api<{ paymentId: string }[]>(`/api/public/invoices/${token}/receipts`);
        if (active && receipts[0]) setReceiptPaymentId(receipts[0].paymentId);
        return;
      }
      const catalog = await api<{ assets: Asset[]; destination?: { blockchain: string } }>(`/api/public/invoices/${token}/assets`);
      if (!active) return;
      setAssets(catalog.assets);
      if (catalog.destination?.blockchain) setInvoice((value) => value ? { ...value, destinationAssetNetwork: catalog.destination!.blockchain } : value);
      const sources = catalog.assets.filter((item) => item.assetId !== inv.destinationAssetId);
      setOrigin(sources.find((item) => item.blockchain.toLowerCase() === "near" && item.symbol.toUpperCase() === "WNEAR")?.assetId || sources.find((item) => item.blockchain.toLowerCase() === "near")?.assetId || sources[0]?.assetId || "");
    }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Payment link could not be loaded."); });
    return () => { active = false; };
  }, [token]);

  async function submit(event: FormEvent) {
    event.preventDefault(); if (!invoice) return;
    setBusy(true); setError(""); setQuote(null); setStatus(""); setDepositSubmitted(false);
    try {
      const selectedAsset = assets.find((item) => item.assetId === origin);
      if (!selectedAsset) throw new Error("Choose an asset to pay with.");
      let payerAddress = "";
      if (selectedAsset.blockchain.toLowerCase() === "near") payerAddress = await connectNearWallet();
      else if (privyWallet.privyEnabled) {
        if (!privyWallet.privyAuthenticated) throw new Error("Sign in to your Veyra account to pay with your embedded wallet.");
        if (!privyWallet.privyAddress) throw new Error("Your embedded wallet is still being prepared. Try again in a moment.");
        payerAddress = privyWallet.privyAddress;
      } else {
        const ethereum = (window as Window & { ethereum?: { request?: (args: { method: string }) => Promise<unknown> } }).ethereum;
        if (!ethereum?.request) throw new Error("No compatible wallet is available for this asset.");
        const accounts = await ethereum.request({ method: "eth_requestAccounts" }) as string[];
        payerAddress = accounts?.[0] || "";
      }
      if (!payerAddress) throw new Error("Your wallet did not return an address.");
      setRefundTo(payerAddress);
      const result = await api<{ paymentId: string; quote: Quote }>(`/api/public/invoices/${token}/quotes`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ originAsset: origin, refundTo: payerAddress, amount: amountToPay, slippageTolerance: 100 }) });
      setQuote(result.quote); setPaymentId(result.paymentId);
      const payload = result.quote.quote && typeof result.quote.quote === "object" ? result.quote.quote as Record<string, unknown> : {};
      const to = str(payload.depositAddress);
      const amountIn = str(payload.amountIn);
      if (!to || !/^\d+$/.test(amountIn)) throw new Error("The payment provider returned incomplete deposit instructions.");
      const hash = selectedAsset.blockchain.toLowerCase() === "near"
        ? await sendNearDeposit(selectedAsset, to, amountIn, str(payload.depositMemo) || undefined)
        : privyWallet.privyEnabled
          ? await privyWallet.sendPrivyDeposit(selectedAsset, to, amountIn)
          : await sendQuotedDeposit(selectedAsset, to, amountIn);
      if (hash) {
        setDepositSubmitted(true);
        const route = selectedAsset.blockchain.toLowerCase() === "near" ? "near-deposit-submitted" : "deposit-submitted";
        try { await api(`/api/public/invoices/${token}/payments/${result.paymentId}/${route}`, { method: "POST", body: JSON.stringify({ txHash: hash }) }); }
        catch { setError(`Payment sent (${hash}). Veyra is monitoring provider settlement.`); }
      }
      const paymentStatus = await api<{ status: string; reconciliationStatus?: string }>(`/api/public/invoices/${token}/payments/${result.paymentId}/status`);
      const reconciled = paymentStatus.reconciliationStatus === "matched_invoice";
      setStatus(paymentStatus.status === "SUCCESS" && !reconciled ? "SUCCESS · PAYMENT NEEDS REVIEW" : paymentStatus.status);
      if (paymentStatus.status === "SUCCESS" && reconciled) {
        const refreshed = await api<Invoice>(`/api/public/invoices/${token}`);
        setInvoice(refreshed);
        setAmountToPay(refreshed.amountDue);
        setReceiptPaymentId(result.paymentId);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "A payment quote could not be created."); }
    finally { setBusy(false); }
  }

  async function checkStatus() {
    if (!paymentId) return;
    setBusy(true); setError("");
    try {
      const result = await api<{ status: string; reconciliationStatus?: string }>(`/api/public/invoices/${token}/payments/${paymentId}/status`);
      const reconciled = result.reconciliationStatus === "matched_invoice";
      setStatus(result.status === "SUCCESS" && !reconciled ? "SUCCESS · PAYMENT NEEDS REVIEW" : result.status);
      if (result.status === "SUCCESS" && reconciled) {
        const refreshed = await api<Invoice>(`/api/public/invoices/${token}`);
        setInvoice(refreshed);
        setAmountToPay(refreshed.amountDue);
        setReceiptPaymentId(paymentId);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Payment status could not be checked."); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (!paymentId || ["SUCCESS", "REFUNDED", "FAILED"].some((finalStatus) => status.startsWith(finalStatus))) return;
    let active = true;
    const poll = async () => {
      try {
        const result = await api<{ status: string; reconciliationStatus?: string }>(`/api/public/invoices/${token}/payments/${paymentId}/status`);
        if (!active) return;
        const reconciled = result.reconciliationStatus === "matched_invoice";
        setStatus(result.status === "SUCCESS" && !reconciled ? "SUCCESS · PAYMENT NEEDS REVIEW" : result.status);
        if (result.status === "SUCCESS" && reconciled) {
          const refreshed = await api<Invoice>(`/api/public/invoices/${token}`);
          if (!active) return;
          setInvoice(refreshed);
          setAmountToPay(refreshed.amountDue);
          setReceiptPaymentId(paymentId);
        }
      } catch {
        // Background polling is best effort; the user can still check manually.
      }
    };
    const timer = window.setInterval(() => void poll(), 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [paymentId, status, token]);

  async function sendFromWallet() {
    if (!asset || !paymentId || !depositAddress || !str(details.amountIn)) return;
    setBusy(true); setError("");
    try {
      const hash = isNearOrigin
        ? await sendNearDeposit(asset, depositAddress, str(details.amountIn), str(details.depositMemo) || undefined)
        : privyWallet.privyAuthenticated && privyWallet.privyAddress.toLowerCase() === refundTo.toLowerCase()
          ? await privyWallet.sendPrivyDeposit(asset, depositAddress, str(details.amountIn))
          : await sendQuotedDeposit(asset, depositAddress, str(details.amountIn));
      if (hash) {
        setDepositSubmitted(true);
        const route = isNearOrigin ? "near-deposit-submitted" : "deposit-submitted";
        try { await api(`/api/public/invoices/${token}/payments/${paymentId}/${route}`, { method: "POST", body: JSON.stringify({ txHash: hash }) }); }
        catch { setError(`Wallet transaction sent (${hash}). Provider notification is optional; settlement is monitored automatically.`); }
      }
      await checkStatus();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The wallet transaction was not sent."); }
    finally { setBusy(false); }
  }

  async function copy() { await navigator.clipboard.writeText(depositAddress); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }

  async function downloadReceipt() {
    if (!receiptPaymentId) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/public/invoices/${token}/payments/${receiptPaymentId}/receipt`);
      if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(typeof result.error === "string" ? result.error : "Receipt could not be downloaded."); }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `veyra-receipt-${invoice?.invoiceNumber || "payment"}.pdf`; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Receipt could not be downloaded."); }
    finally { setBusy(false); }
  }

  async function downloadInvoice() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/public/invoices/${token}/pdf`);
      if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(typeof result.error === "string" ? result.error : "Invoice PDF could not be downloaded."); }
      const blob = await response.blob(); const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `veyra-invoice-${invoice?.invoiceNumber || "invoice"}.pdf`; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Invoice PDF could not be downloaded."); }
    finally { setBusy(false); }
  }

  return <main className="public-invoice-page">
    <header className="public-invoice-header">
      <a href="/" className="brand"><span className="brand-mark"><span /><span /><span /></span><span>Veyra</span></a>
      <span className="public-secure"><ShieldCheck size={16} /> Secure invoice payment</span>
    </header>
    {error && !invoice ? <section className="public-invoice-state"><ShieldCheck size={24} /><h1>Payment link unavailable</h1><p>{error}</p></section> : !invoice ? <section className="public-invoice-state"><span className="page-eyebrow">VEYRA INVOICE</span><h1>Loading invoice…</h1><p>Retrieving the invoice and payment details.</p></section> : <section className="public-invoice-layout">
      <article className="public-invoice-card public-invoice-summary-card">
        <div className="public-invoice-kicker"><span className="page-eyebrow">INVOICE</span><span className={`status-pill ${invoice.status === "paid" ? "status-success" : "status-pending"}`}><span />{invoice.status === "paid" ? "Paid" : invoice.status}</span></div>
        <h1>{invoice.description}</h1>
        <div className="public-invoice-reference"><span>{invoice.invoiceNumber}</span><span>Bill to {invoice.clientName}</span></div>
        <div className="public-amount"><div><small>{invoice.status === "paid" ? "AMOUNT PAID" : "AMOUNT REMAINING"}</small><strong>{invoice.currency} {invoice.status === "paid" ? invoice.amount : invoice.amountDue || invoice.amount}</strong>{Number(invoice.amountPaid) > 0 && invoice.status !== "paid" && <small>{invoice.currency} {invoice.amountPaid} paid of {invoice.amount}</small>}</div><span>Recipient receives<br /><b>{invoice.destinationAssetSymbol}</b></span></div>
        <div className="public-invoice-details">
          <h2>Invoice details</h2>
          <div className="public-invoice-line public-recipient-line"><span>Pay to · {invoice.destinationAssetNetwork || "destination network"}</span><strong>{invoice.paymentRecipient}</strong></div>
          {invoice.lineItems.map((item, index) => <div className="public-invoice-line" key={`${item.description}-${index}`}><span>{item.description}</span><strong>{invoice.currency} {item.amount}</strong></div>)}
          {(invoice.dueDate || invoice.paymentTerms || invoice.notes) && <div className="public-invoice-meta">{invoice.dueDate && <p><b>Due date</b><span>{invoice.dueDate}</span></p>}{invoice.paymentTerms && <p><b>Payment terms</b><span>{invoice.paymentTerms}</span></p>}{invoice.notes && <p><b>Note</b><span>{invoice.notes}</span></p>}</div>}
        </div>
        <button type="button" className="button button-outline public-download-invoice" onClick={() => void downloadInvoice()} disabled={busy}>Download invoice PDF <ArrowRight size={15} /></button>
      </article>
      <aside className="public-invoice-card public-invoice-pay-card">
        {invoice.status === "paid" ? <div className="public-paid-panel"><span className="public-paid-icon"><ShieldCheck size={23} /></span><span className="page-eyebrow">PAYMENT CONFIRMED</span><h2>This invoice is paid.</h2><p>Veyra recorded the payment after the provider confirmed settlement.</p>{receiptPaymentId && <button type="button" className="button button-green" onClick={() => void downloadReceipt()} disabled={busy}>{busy ? "Preparing receipt…" : "Download payment receipt"} <ArrowRight size={15} /></button>}</div> : invoice.pendingPayment ? <div className="public-paid-panel"><span className="public-paid-icon"><RefreshCw size={22} /></span><span className="page-eyebrow">PAYMENT SUBMITTED</span><h2>Checking settlement</h2><p>Your wallet transfer was submitted. Wait for the provider to confirm it before trying another payment.</p><div className="integration-status"><span>{status || invoice.pendingPayment.status}</span><small>Provider settlement status</small></div><button type="button" className="button button-outline" onClick={() => void checkStatus()} disabled={busy}><RefreshCw size={15} /> {busy ? "Checking…" : "Check payment status"}</button></div> : <>
          <div className="public-pay-heading"><span className="page-eyebrow">PAY SECURELY</span><h2>{quote ? depositSubmitted ? "Payment submitted" : "Finish your payment" : "Pay this invoice"}</h2><p>{quote ? depositSubmitted ? "Your wallet submitted the transfer. Veyra is checking provider settlement." : "The route is ready. Approve the transfer in your wallet to pay." : "Choose your asset and amount. Your wallet will ask you to approve the transfer."}</p></div>
          {!quote ? <form className="form-stack public-payment-form" onSubmit={submit}>
            <label>Amount to pay<input required type="number" inputMode="decimal" min="0.000001" step="0.000001" max={invoice.amountDue || invoice.amount} value={amountToPay} onChange={(event) => setAmountToPay(event.target.value)} /><span className="public-field-help">Up to {invoice.currency} {invoice.amountDue || invoice.amount} remaining</span></label>
            <label>Pay with<select required value={origin} onChange={(event) => setOrigin(event.target.value)}>{assets.filter((item) => item.assetId !== invoice.destinationAssetId).map((item) => <option key={item.assetId} value={item.assetId}>{item.symbol} · {item.blockchain.toUpperCase()} testnet</option>)}</select></label>
            {asset?.blockchain.toLowerCase() === "near" && <p className="public-field-help">Tidepool NEAR testnet quotes use test tokens such as wNEAR. Native NEAR is separate. <a href="https://app.usetidepool.tech/faucet" target="_blank" rel="noreferrer">Get test tokens</a></p>}
            {error && <p className="form-error" role="alert">{error} {error.includes("Get test") && <a href="https://app.usetidepool.tech/faucet" target="_blank" rel="noreferrer">Open Tidepool faucet</a>}</p>}
            <button className="button button-green public-primary-action" disabled={busy || !asset || !amountToPay}>{busy ? "Preparing payment…" : `Pay ${invoice.currency} ${amountToPay || "0"}`} <ArrowRight size={16} /></button>
            <p className="public-payment-note">The recipient address and network are already set on this invoice. Your wallet opens for approval before funds move.</p>
          </form> : <div className="form-stack public-payment-form">
            <div className="quote-summary"><div><span>YOU SEND</span><b>{str(details.amountInFormatted) || "See provider instructions"} {asset?.symbol}</b></div><ArrowRight size={17} /><div><span>INVOICE RECEIVES</span><b>{str(details.amountOutFormatted) || invoice.amount} {invoice.currency}</b></div></div>
            <div className="deposit-box"><span>NEAR INTENTS DEPOSIT ADDRESS</span><code>{depositAddress || "Provider did not return a deposit address"}</code><small>This temporary address comes from the payment quote. The provider routes your payment from here to the invoice recipient.</small>{depositAddress && <button type="button" className="button button-outline button-small" onClick={() => void copy()}><Copy size={14} /> {copied ? "Copied" : "Copy address"}</button>}</div>
            {str(details.depositMemo) && <div className="deposit-box"><span>REQUIRED MEMO</span><code>{str(details.depositMemo)}</code></div>}
            <div className="quote-meta"><span>Quote expires</span><b>{str(details.deadline) ? new Date(str(details.deadline)).toLocaleString() : "See provider details"}</b></div>
            {canSendInApp && !depositSubmitted && <button type="button" className="button button-green public-primary-action" onClick={() => void sendFromWallet()} disabled={busy}><Wallet size={16} /> {busy ? "Waiting for approval…" : "Approve payment"}</button>}
            <button type="button" className="button button-outline public-wallet-button" onClick={() => { setQuote(null); setPaymentId(""); setStatus(""); setError(""); setDepositSubmitted(false); }} disabled={busy}>Choose a different asset or refresh quote</button>
            <button type="button" className="button button-outline public-wallet-button" onClick={() => void checkStatus()} disabled={busy || !paymentId}><RefreshCw size={15} /> {busy ? "Checking…" : "Check payment status"}</button>
            {status && <div className="integration-status"><span>{status}</span><small>Provider settlement status</small></div>}
            {receiptPaymentId && <button type="button" className="button button-green" onClick={() => void downloadReceipt()} disabled={busy}>Download payment receipt <ArrowRight size={15} /></button>}
            {error && <p className="form-error" role="alert">{error} {error.includes("Get test") && <a href="https://app.usetidepool.tech/faucet" target="_blank" rel="noreferrer">Open Tidepool faucet</a>}</p>}
            <p className="public-payment-note">Review the network, token, and exact amount in your wallet. Your transfer starts only after you approve it.</p>
          </div>}
        </>}
      </aside>
    </section>}
    <footer className="public-invoice-footer"><ShieldCheck size={15} /><span>Payments are processed through NEAR Intents. Veyra records payment only after provider settlement is confirmed.</span></footer>
  </main>;
}
