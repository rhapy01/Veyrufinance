import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, CheckCircle2, FileText } from "lucide-react";

type Asset = { assetId: string; symbol: string; blockchain: string };
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "This request could not be completed.");
  return body as T;
}

export default function VendorInvoiceIntakePage({ token }: { token: string }) {
  const [business, setBusiness] = useState("");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [receipt, setReceipt] = useState<{ billNumber: string; receiptToken: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    request<{ businessName: string }>(`/api/public/payable-intake/${token}`).then((result) => { if (live) setBusiness(result.businessName); })
      .then(() => request<{ assets: Asset[] }>(`/api/public/payable-intake/${token}/assets`).then((result) => { if (live) setAssets(result.assets); }).catch(() => {}))
      .catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : "This submission link is unavailable."); });
    return () => { live = false; };
  }, [token]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(""); setBusy(true);
    const data = new FormData(event.currentTarget);
    const body = Object.fromEntries(data.entries());
    try {
      const result = await request<{ billNumber: string; receiptToken: string }>(`/api/public/payable-intake/${token}`, { method: "POST", body: JSON.stringify(body) });
      setReceipt(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Invoice could not be submitted."); }
    finally { setBusy(false); }
  };
  const statusUrl = receipt ? `/invoice-submission/${receipt.receiptToken}` : "";
  return <main className="public-invoice-shell"><section className="public-invoice-card">
    <div className="public-invoice-brand"><span className="public-invoice-mark"><FileText size={20} /></span><span>VEYRA · VENDOR INVOICE</span></div>
    {receipt ? <div className="public-invoice-content"><CheckCircle2 size={34} /><span className="page-eyebrow">SUBMITTED FOR REVIEW</span><h1>Invoice received</h1><p><b>{receipt.billNumber}</b> was sent to {business || "the business"}. No payment has been initiated.</p><a className="button button-outline" href={statusUrl} target="_blank" rel="noreferrer">View submission status <ArrowRight size={15} /></a><p className="form-footnote">Save this page link to check the review status later.</p></div> : <div className="public-invoice-content"><span className="page-eyebrow">VENDOR SUBMISSION</span><h1>Send an invoice to {business || "the business"}</h1><p>Submit your invoice details for the business to review. You do not need a Veyra account.</p>
      {error && <p className="form-error">{error}</p>}
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <div className="form-pair"><label>Invoice number<input name="billNumber" required maxLength={100} /></label><label>Your name or business<input name="vendorName" required maxLength={160} /></label></div>
        <label>Contact email<input name="vendorEmail" type="email" required maxLength={200} /></label>
        <label>What is this invoice for?<textarea name="description" required maxLength={1000} rows={3} /></label>
        <div className="form-pair"><label>Amount<input name="amount" required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,6})?" /></label><label>Currency<input name="currency" required defaultValue="USD" maxLength={12} /></label></div>
        <label>Due date <span className="optional-label">OPTIONAL</span><input name="dueDate" type="date" /></label>
        <label>Preferred payout asset <span className="optional-label">OPTIONAL</span><select name="payoutAssetId" defaultValue=""><option value="">Let the business choose</option>{assets.map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.symbol} · {asset.blockchain.toUpperCase()}</option>)}</select></label>
        <label>Wallet address <span className="optional-label">OPTIONAL</span><input name="recipientAddress" maxLength={200} autoComplete="off" placeholder="If you have a preferred payout wallet" /></label>
        <button className="button button-green" disabled={busy || !business}>{busy ? "Submitting…" : "Submit invoice for review"} <ArrowRight size={15} /></button>
        <p className="form-footnote">The business will verify your invoice and payout details before any payment is prepared.</p>
      </form>
    </div>}
  </section></main>;
}

export function VendorInvoiceStatusPage({ token }: { token: string }) {
  const [bill, setBill] = useState<{ billNumber: string; vendorName: string; status: string; updatedAt: string } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { let live = true; request<typeof bill>(`/api/public/payable-submissions/${token}`).then((value) => { if (live && value) setBill(value); }).catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : "Submission status is unavailable."); }); return () => { live = false; }; }, [token]);
  const label = bill?.status === "submitted" ? "Waiting for business review" : bill?.status === "ready" ? "Approved for payment preparation" : bill?.status === "paid" ? "Payment confirmed" : bill?.status === "rejected" ? "Declined by the business" : bill?.status?.replaceAll("_", " ") || "Checking status";
  return <main className="public-invoice-shell"><section className="public-invoice-card"><div className="public-invoice-brand"><span className="public-invoice-mark"><FileText size={20} /></span><span>VEYRA · SUBMISSION STATUS</span></div><div className="public-invoice-content"><span className="page-eyebrow">VENDOR INVOICE</span><h1>{error ? "Status unavailable" : bill ? bill.billNumber : "Loading status…"}</h1>{error ? <p>{error}</p> : bill ? <><p>{label}</p><p>Submitted by {bill.vendorName}. Last updated {new Date(bill.updatedAt).toLocaleString()}.</p><p className="form-footnote">Invoice submission is not a payment instruction. Payment only begins after the business approves the invoice.</p></> : <p>Retrieving your submission status.</p>}</div></section></main>;
}
