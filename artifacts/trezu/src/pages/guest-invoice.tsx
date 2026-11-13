import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowRight, Check, Copy, FileText, ShieldCheck } from "lucide-react";

type Asset = { assetId: string; symbol: string; blockchain: string };
type LineItem = { description: string; amount: string };

function toUnits(value: string): bigint {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) return 0n;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function fromUnits(value: bigint): string {
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${value / 1_000_000n}.${fraction}` : (value / 1_000_000n).toString();
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "The invoice could not be created.");
  return result as T;
}

export default function GuestInvoicePage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(true);
  const [assetError, setAssetError] = useState("");
  const [senderName, setSenderName] = useState("");
  const [senderEmail, setSenderEmail] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [description, setDescription] = useState("");
  const [lines, setLines] = useState<LineItem[]>([{ description: "", amount: "" }]);
  const [currency, setCurrency] = useState("USD");
  const [assetId, setAssetId] = useState("");
  const [recipientAddress, setRecipientAddress] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [paymentTerms, setPaymentTerms] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ invoiceNumber: string; recipientEmail: string; emailSent: boolean; paymentLink: string; message?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const totalUnits = useMemo(() => lines.reduce((sum, line) => sum + toUnits(line.amount), 0n), [lines]);
  const compatibleAssets = assets.filter((asset) => asset.symbol.toUpperCase() === currency || currency === "USD" && ["USDC", "USDT"].includes(asset.symbol.toUpperCase()));

  useEffect(() => {
    let active = true;
    request<{ assets: Asset[] }>("/api/public/invoice-assets")
      .then((data) => { if (!active) return; setAssets(data.assets); setAssetId(data.assets.find((asset) => asset.symbol.toUpperCase() === "USDC")?.assetId || data.assets[0]?.assetId || ""); })
      .catch((reason) => { if (active) setAssetError(reason instanceof Error ? reason.message : "Testnet assets could not be loaded."); })
      .finally(() => { if (active) setAssetsLoading(false); });
    return () => { active = false; };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError("");
    if (lines.some((line) => !line.description.trim() || toUnits(line.amount) <= 0n)) { setError("Add a description and a positive amount for every line item."); setBusy(false); return; }
    if (!compatibleAssets.some((asset) => asset.assetId === assetId)) { setError("Choose a supported testnet settlement asset."); setBusy(false); return; }
    try {
      const result = await request<{ invoiceNumber: string; recipientEmail: string; emailSent: boolean; paymentLink: string; message?: string }>("/api/public/invoices", {
        method: "POST",
        body: JSON.stringify({ senderName, senderEmail, recipientEmail, description, lineItems: lines, amount: fromUnits(totalUnits), currency, paymentAssetId: assetId, paymentRecipient: recipientAddress, dueDate: dueDate || null, paymentTerms, notes }),
      });
      setCreated(result);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The invoice could not be sent."); }
    finally { setBusy(false); }
  };

  const copyLink = async () => {
    if (!created) return;
    try { await navigator.clipboard.writeText(`${window.location.origin}${created.paymentLink}`); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }
    catch { setError("The payment link could not be copied. You can open it and copy the address from your browser."); }
  };

  return <main className="guest-invoice-page">
    <header className="guest-invoice-header"><a href="/" className="guest-invoice-brand"><span className="brand-mark"><span /><span /><span /></span><b>Veyra</b></a><a href="/sign-in" className="guest-signin-link">Already have a workspace? Sign in</a></header>
    <div className="guest-invoice-wrap">
      <div className="guest-invoice-intro"><span className="page-eyebrow">CREATE AN INVOICE · TESTNET</span><h1>Send an invoice<br /><em>without opening an account.</em></h1><p>Enter the recipient’s Veyra email and the wallet where you want the payment delivered. We’ll place the invoice in their dashboard and email them a notice.</p></div>
      {created ? <section className="guest-invoice-success" role="status"><span className="guest-success-icon"><Check size={24} /></span><span className="page-eyebrow">INVOICE CREATED</span><h2>{created.invoiceNumber}</h2><p>{created.emailSent ? `Sent to ${created.recipientEmail}. It is now in their Received invoices dashboard.` : created.message || `Added to ${created.recipientEmail}’s Received invoices dashboard. The email notification did not go through.`}</p><div className="guest-result-actions"><a className="button button-outline" href={created.paymentLink} target="_blank" rel="noreferrer">Open payment page <ArrowRight size={14} /></a><button type="button" className="button button-green" onClick={() => void copyLink()}><Copy size={14} />{copied ? "Copied" : "Copy payment link"}</button></div><button className="text-button" type="button" onClick={() => { setCreated(null); setDescription(""); setLines([{ description: "", amount: "" }]); setRecipientEmail(""); setDueDate(""); setPaymentTerms(""); setNotes(""); }}>Create another invoice</button></section> : <form className="guest-invoice-form" onSubmit={(event) => void submit(event)}>
        <section className="guest-form-section"><div className="guest-section-heading"><span>01</span><div><h2>Who is sending and receiving?</h2><p>The recipient must already have an active Veyra account.</p></div></div><div className="guest-form-grid"><label>Your name or business<input required maxLength={160} value={senderName} onChange={(event) => setSenderName(event.target.value)} autoComplete="name" placeholder="Your name or business name" /></label><label>Your email<input required type="email" maxLength={254} value={senderEmail} onChange={(event) => setSenderEmail(event.target.value)} autoComplete="email" placeholder="you@example.com" /></label><label className="guest-grid-full">Recipient’s registered Veyra email<input required type="email" maxLength={254} value={recipientEmail} onChange={(event) => setRecipientEmail(event.target.value)} placeholder="client@example.com" /><small>We check the address before creating the invoice. Unregistered recipients cannot receive it.</small></label></div></section>
        <section className="guest-form-section"><div className="guest-section-heading"><span>02</span><div><h2>What is the invoice for?</h2><p>Add the work and amounts. The total is calculated for you.</p></div></div><label>Invoice summary<textarea required maxLength={2000} rows={2} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="A short summary of the work or service" /></label><div className="guest-line-items"><div className="guest-line-heading"><b>Line items</b><button type="button" className="text-button" disabled={lines.length >= 30} onClick={() => setLines((current) => [...current, { description: "", amount: "" }])}>+ Add item</button></div>{lines.map((line, index) => <div className="guest-line-row" key={index}><label>Item<input required maxLength={240} value={line.description} onChange={(event) => setLines((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, description: event.target.value } : item))} placeholder="Consulting services" /></label><label>Amount<input required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,6})?" value={line.amount} onChange={(event) => setLines((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, amount: event.target.value } : item))} placeholder="0.00" /></label>{lines.length > 1 && <button type="button" className="guest-remove-line" onClick={() => setLines((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remove item ${index + 1}`}>×</button>}</div>)}<div className="guest-invoice-total"><label>Currency<select value={currency} onChange={(event) => { const next = event.target.value; setCurrency(next); const available = assets.filter((asset) => asset.symbol.toUpperCase() === next || next === "USD" && ["USDC", "USDT"].includes(asset.symbol.toUpperCase())); if (!available.some((asset) => asset.assetId === assetId)) setAssetId(available[0]?.assetId || ""); }}><option value="USD">USD</option><option value="USDC">USDC</option><option value="USDT">USDT</option></select></label><strong>Total <span>{currency} {fromUnits(totalUnits)}</span></strong></div></div></section>
        <section className="guest-form-section"><div className="guest-section-heading"><span>03</span><div><h2>Where should payment arrive?</h2><p>The invoice gets a fixed settlement asset and destination address.</p></div></div>{assetError && <p className="form-error">{assetError}</p>}<div className="guest-form-grid"><label>Settlement asset<select required value={assetId} disabled={assetsLoading || !compatibleAssets.length} onChange={(event) => setAssetId(event.target.value)}><option value="">{assetsLoading ? "Loading testnet assets…" : "Choose asset"}</option>{compatibleAssets.map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.symbol} · {asset.blockchain} testnet</option>)}</select></label><label>Receiving wallet address<input required value={recipientAddress} onChange={(event) => setRecipientAddress(event.target.value)} maxLength={200} autoComplete="off" placeholder={assets.find((asset) => asset.assetId === assetId)?.blockchain.toLowerCase() === "near" ? "NEAR testnet account" : "0x…"} /></label><label>Due date <span className="guest-optional">OPTIONAL</span><input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label><label>Payment terms <span className="guest-optional">OPTIONAL</span><input maxLength={1000} value={paymentTerms} onChange={(event) => setPaymentTerms(event.target.value)} placeholder="Due within 14 days" /></label><label className="guest-grid-full">Notes <span className="guest-optional">OPTIONAL</span><textarea rows={2} maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Additional details for the recipient" /></label></div></section>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="guest-invoice-submit"><button type="submit" className="button button-green" disabled={busy || assetsLoading || !!assetError || totalUnits <= 0n}>{busy ? "Creating and sending…" : "Create and send invoice"} <ArrowRight size={16} /></button><p><ShieldCheck size={15} /> Testnet only. Veyra sends a dashboard notification; the recipient reviews and pays the invoice themselves.</p></div>
      </form>}
      <div className="guest-invoice-footnote"><FileText size={16} /><span>No account is needed to create the invoice. The recipient must register with Veyra before you can send it. Funds go directly to the receiving wallet after the payment provider confirms settlement.</span></div>
    </div>
  </main>;
}
