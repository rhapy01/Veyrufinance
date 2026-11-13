import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { Router, type IRouter, type Response } from "express";
import { auditLogsTable, db, invoicesTable, nearIntentQuotesTable, usersTable, workspacesTable } from "@workspace/db";
import { createSavedQuote, refreshSavedQuoteStatus } from "../../lib/near-intent-workflows";
import { getSupportedAssets, NearIntentsError, submitDeposit } from "../../lib/near-intents";
import { createReceiptPdf, type ReceiptLine } from "../../lib/receipt-pdf";
import { invoiceCurrencyMatchesAsset } from "../../lib/invoice-currency";
import { isPositiveMoney } from "../../lib/money";
import { emailDeliveryConfigured, sendInvoiceEmail } from "../../lib/auth-email";

const router: IRouter = Router();
const validAddress = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 200;
const guestInvoiceRate = new Map<string, { count: number; resetAt: number }>();
function amountFromProvider(value: unknown, decimals: number | null): string | null {
  if (typeof value !== "string") return null;
  if (/^\d+(?:\.\d+)?$/.test(value) && value.includes(".")) return value;
  if (!/^\d+$/.test(value) || decimals === null) return null;
  const units = BigInt(value); const scale = 10n ** BigInt(decimals);
  const fraction = (units % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${units / scale}${fraction ? `.${fraction}` : ""}`;
}

async function findInvoice(token: string) {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
  const [invoice] = await db.select().from(invoicesTable).where(eq(invoicesTable.publicToken, token)).limit(1);
  return invoice && ["sent", "viewed", "partially_paid", "paid", "overdue"].includes(invoice.status) ? invoice : null;
}

function units6(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0").slice(0, 6));
}
function format6(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}
async function settledInvoiceAmount(invoiceId: string): Promise<bigint> {
  const payments = await db.select({ quotePayload: nearIntentQuotesTable.quotePayload }).from(nearIntentQuotesTable).where(and(
    eq(nearIntentQuotesTable.invoiceId, invoiceId), eq(nearIntentQuotesTable.providerStatus, "SUCCESS"), eq(nearIntentQuotesTable.reconciliationStatus, "matched_invoice"),
  ));
  return payments.reduce((sum, row) => {
    const payload = row.quotePayload as Record<string, unknown> | null;
    const quote = payload?.quote && typeof payload.quote === "object" ? payload.quote as Record<string, unknown> : {};
    const value = typeof quote.amountOutFormatted === "string" ? quote.amountOutFormatted : "0";
    return /^\d+(?:\.\d+)?$/.test(value) ? sum + units6(value) : sum;
  }, 0n);
}

function invoiceStatus(invoice: NonNullable<Awaited<ReturnType<typeof findInvoice>>>) {
  if (["sent", "viewed", "partially_paid"].includes(invoice.status) && invoice.dueDate && invoice.dueDate < new Date().toISOString().slice(0, 10)) return "overdue";
  return invoice.status;
}

function sendError(error: unknown, res: Response) {
  if (error instanceof NearIntentsError) { res.status(error.statusCode).json({ error: error.message }); return; }
  res.status(503).json({ error: "Payment service is temporarily unavailable. Try again shortly." });
}

router.get("/public/invoice-assets", async (_req, res): Promise<void> => {
  try {
    const assets = await getSupportedAssets();
    res.setHeader("Cache-Control", "public, max-age=30");
    res.json({ assets: assets.filter((asset) => ["USDC", "USDT"].includes(asset.symbol.toUpperCase())) });
  } catch (error) { sendError(error, res); }
});

router.post("/public/invoices", async (req, res): Promise<void> => {
  const nowMs = Date.now();
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const rate = guestInvoiceRate.get(ip);
  if (rate && rate.resetAt > nowMs && rate.count >= 3) { res.status(429).json({ error: "Too many invoice requests from this connection. Try again in a few minutes." }); return; }
  guestInvoiceRate.set(ip, rate && rate.resetAt > nowMs ? { count: rate.count + 1, resetAt: rate.resetAt } : { count: 1, resetAt: nowMs + 15 * 60_000 });
  if (guestInvoiceRate.size > 2_000) for (const [key, value] of guestInvoiceRate) if (value.resetAt <= nowMs) guestInvoiceRate.delete(key);

  const body = req.body ?? {};
  const senderName = typeof body.senderName === "string" ? body.senderName.trim() : "";
  const senderEmail = typeof body.senderEmail === "string" ? body.senderEmail.trim().toLowerCase() : "";
  const recipientEmail = typeof body.recipientEmail === "string" ? body.recipientEmail.trim().toLowerCase() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const currency = typeof body.currency === "string" ? body.currency.trim().toUpperCase() : "";
  const amount = typeof body.amount === "string" ? body.amount.trim() : "";
  const paymentAssetId = typeof body.paymentAssetId === "string" ? body.paymentAssetId.trim() : "";
  const paymentRecipient = typeof body.paymentRecipient === "string" ? body.paymentRecipient.trim() : "";
  const lineItems = Array.isArray(body.lineItems) ? body.lineItems as Array<{ description?: unknown; amount?: unknown }> : [];
  if (senderName.length < 1 || senderName.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail) || senderEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail) || recipientEmail.length > 254 || !description || description.length > 2_000 ||
      !/^[A-Z]{3}$/.test(currency) || !isPositiveMoney(amount) || !paymentAssetId || !validAddress(paymentRecipient) ||
      lineItems.length < 1 || lineItems.length > 30 || lineItems.some((line) => typeof line.description !== "string" || !line.description.trim() || line.description.length > 240 || typeof line.amount !== "string" || !isPositiveMoney(line.amount))) {
    res.status(400).json({ error: "Complete the sender, registered recipient, invoice items, amount, settlement asset, and receiving wallet details." }); return;
  }
  const totalUnits = lineItems.reduce((sum, line) => {
    const [whole, fraction = ""] = String(line.amount).split(".");
    return sum + BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
  }, 0n);
  const [amountWhole, amountFraction = ""] = amount.split(".");
  const amountUnits = BigInt(amountWhole) * 1_000_000n + BigInt((amountFraction + "000000").slice(0, 6));
  if (totalUnits !== amountUnits) { res.status(400).json({ error: "The invoice total must equal the sum of its line items." }); return; }
  if (body.dueDate != null && body.dueDate !== "" && (typeof body.dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.dueDate) || Number.isNaN(Date.parse(`${body.dueDate}T00:00:00Z`)))) {
    res.status(400).json({ error: "Enter a valid invoice due date." }); return;
  }
  if (!emailDeliveryConfigured()) { res.status(503).json({ error: "Invoice email is not configured. Check the Google SMTP settings." }); return; }
  const [recipient] = await db.select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
    .from(usersTable).where(and(sql`lower(${usersTable.email}) = ${recipientEmail}`, eq(usersTable.active, true))).limit(1);
  if (!recipient) { res.status(404).json({ error: "The recipient must already have an active Trezu account. Ask them to register first." }); return; }

  let asset;
  try { asset = (await getSupportedAssets()).find((candidate) => candidate.assetId === paymentAssetId); }
  catch (error) { sendError(error, res); return; }
  if (!asset || !invoiceCurrencyMatchesAsset(currency, asset.symbol)) { res.status(400).json({ error: "Choose a supported USDC or USDT testnet settlement asset that matches the invoice currency." }); return; }
  const blockchain = asset.blockchain.toLowerCase();
  const validRecipient = blockchain === "near"
    ? /^[a-z0-9._-]{2,64}\.testnet$/.test(paymentRecipient) || /^[0-9a-f]{64}$/i.test(paymentRecipient)
    : /^0x[0-9a-f]{40}$/i.test(paymentRecipient);
  if (!validRecipient) { res.status(400).json({ error: `Enter a valid ${blockchain === "near" ? "NEAR testnet" : `${asset.blockchain} testnet`} receiving address.` }); return; }

  const invoiceId = randomUUID();
  const guestId = randomUUID();
  const workspaceId = randomUUID();
  const invoiceNumber = `TRZ-${new Date().getUTCFullYear()}-${invoiceId.replaceAll("-", "").slice(0, 8).toUpperCase()}`;
  const publicToken = randomBytes(32).toString("base64url");
  const webUrl = (process.env.WEB_APP_URL || "http://localhost:5173").replace(/\/$/, "");
  const dueDate = typeof body.dueDate === "string" && body.dueDate ? body.dueDate : null;
  await db.transaction(async (tx) => {
    await tx.insert(workspacesTable).values({ id: workspaceId, name: senderName, type: "freelancer", ownerUserId: `guest:${guestId}` });
    await tx.insert(invoicesTable).values({
      id: invoiceId, workspaceId, invoiceNumber, clientName: recipient.name, clientEmail: recipient.email, senderEmail,
      description, lineItems: lineItems.map((line) => ({ description: String(line.description).trim(), amount: String(line.amount) })),
      amount, currency, dueDate, notes: typeof body.notes === "string" ? body.notes.trim().slice(0, 2_000) || null : null,
      paymentTerms: typeof body.paymentTerms === "string" ? body.paymentTerms.trim().slice(0, 1_000) || null : null,
      status: "draft", publicToken, paymentAssetId, paymentRecipient, createdBy: `guest:${guestId}`,
    });
  });
  const invoiceUrl = `${webUrl}/app/invoices?tab=received`;
  try {
    await sendInvoiceEmail({ email: recipient.email, recipientName: recipient.name, businessName: senderName, invoiceNumber, description,
      lineItems: lineItems.map((line) => ({ description: String(line.description).trim(), amount: String(line.amount) })), amount, currency, dueDate, invoiceUrl });
  } catch {
    const sentAt = new Date();
    await db.update(invoicesTable).set({ status: "sent", sentAt }).where(eq(invoicesTable.id, invoiceId));
    await db.insert(auditLogsTable).values({ workspaceId, actorUserId: `guest:${guestId}`, action: "invoice.sent", entityType: "invoice", entityId: invoiceId, metadata: { invoiceNumber, recipientEmail: recipient.email, senderEmail, delivery: "dashboard", emailDelivery: "failed", creatorType: "guest" } });
    res.status(201).json({ invoiceNumber, status: "sent", emailSent: false, recipientEmail: recipient.email, paymentLink: `/pay/${publicToken}`, message: "The invoice is in the recipient’s Trezu dashboard, but the notification email could not be sent." }); return;
  }
  const sentAt = new Date();
  await db.update(invoicesTable).set({ status: "sent", sentAt }).where(eq(invoicesTable.id, invoiceId));
  await db.insert(auditLogsTable).values({ workspaceId, actorUserId: `guest:${guestId}`, action: "invoice.sent", entityType: "invoice", entityId: invoiceId, metadata: { invoiceNumber, recipientEmail: recipient.email, senderEmail, delivery: "smtp", creatorType: "guest" } });
  res.status(201).json({ invoiceNumber, status: "sent", emailSent: true, recipientEmail: recipient.email, paymentLink: `/pay/${publicToken}` });
});

router.get("/public/invoices/:token", async (req, res): Promise<void> => {
  const invoice = await findInvoice(req.params.token);
  if (!invoice) { res.status(404).json({ error: "Payment link not found." }); return; }
  if (invoice.status === "sent") {
    await db.transaction(async (tx) => {
      const [viewed] = await tx.update(invoicesTable).set({ status: "viewed" }).where(and(eq(invoicesTable.id, invoice.id), eq(invoicesTable.status, "sent"))).returning({ id: invoicesTable.id });
      if (viewed) await tx.insert(auditLogsTable).values({ workspaceId: invoice.workspaceId, actorUserId: "public:invoice-payer", action: "invoice.viewed", entityType: "invoice", entityId: invoice.id, metadata: { invoiceNumber: invoice.invoiceNumber } });
    });
  }
  res.setHeader("Cache-Control", "no-store");
  const amountPaid = await settledInvoiceAmount(invoice.id);
  const paymentRows = await db.select({ id: nearIntentQuotesTable.id, providerStatus: nearIntentQuotesTable.providerStatus, quotePayload: nearIntentQuotesTable.quotePayload })
    .from(nearIntentQuotesTable).where(eq(nearIntentQuotesTable.invoiceId, invoice.id)).orderBy(desc(nearIntentQuotesTable.createdAt));
  const pendingPayment = paymentRows.find((payment) => {
    const payload = payment.quotePayload && typeof payment.quotePayload === "object" ? payment.quotePayload as Record<string, unknown> : {};
    const submission = payload.walletSubmission && typeof payload.walletSubmission === "object" ? payload.walletSubmission as Record<string, unknown> : {};
    return typeof submission.txHash === "string" && !["SUCCESS", "FAILED", "REFUNDED"].includes(payment.providerStatus);
  });
  const total = units6(invoice.amount);
  res.json({ invoiceNumber: invoice.invoiceNumber, clientName: invoice.clientName, description: invoice.description,
    lineItems: invoice.lineItems?.length ? invoice.lineItems : [{ description: invoice.description, amount: invoice.amount }],
    dueDate: invoice.dueDate, notes: invoice.notes, paymentTerms: invoice.paymentTerms,
    amount: invoice.amount, amountPaid: format6(amountPaid), amountDue: format6(total > amountPaid ? total - amountPaid : 0n), currency: invoice.currency, status: invoiceStatus(invoice) === "sent" ? "viewed" : invoiceStatus(invoice),
    destinationAssetId: invoice.paymentAssetId, destinationAssetSymbol: invoice.currency, paymentRecipient: invoice.paymentRecipient,
    pendingPayment: pendingPayment ? { paymentId: pendingPayment.id, status: pendingPayment.providerStatus } : null });
});

router.get("/public/invoices/:token/pdf", async (req, res): Promise<void> => {
  const invoice = await findInvoice(req.params.token);
  if (!invoice) { res.status(404).json({ error: "Invoice not found." }); return; }
  const lineItems = invoice.lineItems?.length ? invoice.lineItems : [{ description: invoice.description, amount: invoice.amount }];
  const lines: ReceiptLine[] = [
    { label: "Bill to", value: `${invoice.clientName}${invoice.clientEmail ? ` · ${invoice.clientEmail}` : ""}` },
    ...lineItems.map((item, index) => ({ label: `Item ${index + 1}`, value: `${item.description} · ${invoice.currency} ${item.amount}` })),
    { label: "Total due", value: `${invoice.currency} ${invoice.amount}` },
    ...(invoice.dueDate ? [{ label: "Due date", value: invoice.dueDate }] : []),
    ...(invoice.paymentTerms ? [{ label: "Payment terms", value: invoice.paymentTerms }] : []),
    ...(invoice.notes ? [{ label: "Notes", value: invoice.notes }] : []),
  ];
  const pdf = createReceiptPdf({ title: `Invoice ${invoice.invoiceNumber}`, subtitle: `${invoiceStatus(invoice).toUpperCase()} · ${invoice.createdAt.toISOString().slice(0, 10)}`, lines, footer: "Payment status is confirmed only after verified provider settlement." });
  const safeName = invoice.invoiceNumber.replace(/[^A-Za-z0-9_-]/g, "_");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="trezu-invoice-${safeName}.pdf"`);
  res.setHeader("Content-Length", String(pdf.length));
  res.send(pdf);
});

router.get("/public/invoices/:token/assets", async (req, res): Promise<void> => {
  const invoice = await findInvoice(req.params.token);
  if (!invoice || !invoice.paymentAssetId) { res.status(404).json({ error: "Payment link not found." }); return; }
  try {
    const assets = await getSupportedAssets();
    const destination = assets.find((asset) => asset.assetId === invoice.paymentAssetId);
    if (!destination || !invoiceCurrencyMatchesAsset(invoice.currency, destination.symbol)) { res.status(409).json({ error: "The invoice settlement asset is no longer available." }); return; }
    res.setHeader("Cache-Control", "public, max-age=30");
    res.json({ assets, destination: { assetId: destination.assetId, symbol: destination.symbol, blockchain: destination.blockchain, decimals: destination.decimals } });
  } catch (error) { sendError(error, res); }
});

router.post("/public/invoices/:token/quotes", async (req, res): Promise<void> => {
  const invoice = await findInvoice(req.params.token);
  if (!invoice || !invoice.paymentAssetId || !invoice.paymentRecipient) { res.status(404).json({ error: "Payment link not found." }); return; }
  if (invoice.status === "paid") { res.status(409).json({ error: "This invoice has already been paid." }); return; }
  const priorPayments = await db.select({ providerStatus: nearIntentQuotesTable.providerStatus, quotePayload: nearIntentQuotesTable.quotePayload })
    .from(nearIntentQuotesTable).where(eq(nearIntentQuotesTable.invoiceId, invoice.id));
  const paymentAlreadySubmitted = priorPayments.some((payment) => {
    const payload = payment.quotePayload && typeof payment.quotePayload === "object" ? payment.quotePayload as Record<string, unknown> : {};
    const submission = payload.walletSubmission && typeof payload.walletSubmission === "object" ? payload.walletSubmission as Record<string, unknown> : null;
    return !!submission && !["SUCCESS", "FAILED", "REFUNDED"].includes(payment.providerStatus);
  });
  if (paymentAlreadySubmitted) { res.status(409).json({ error: "A wallet transfer for this invoice is already submitted and awaiting provider confirmation. Check payment status before trying again." }); return; }
  const { originAsset, refundTo, amount, slippageTolerance = 100 } = req.body ?? {};
  if (typeof originAsset === "string" && originAsset === invoice.paymentAssetId) { res.status(409).json({ error: "Choose a different source asset. This payment flow needs NEAR Intents to convert into the invoice settlement asset." }); return; }
  const idempotencyKey = req.get("Idempotency-Key");
  if (typeof originAsset !== "string" || originAsset.length > 200 || !validAddress(refundTo) || typeof amount !== "string" || !/^\d+(?:\.\d{1,6})?$/.test(amount) || !Number.isInteger(slippageTolerance) || slippageTolerance < 1 || slippageTolerance > 5000 || !idempotencyKey || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    res.status(400).json({ error: "Choose a source asset, enter an amount up to the remaining invoice balance, and retry." }); return;
  }
  try {
    const total = units6(invoice.amount);
    const paid = await settledInvoiceAmount(invoice.id);
    const remaining = total > paid ? total - paid : 0n;
    if (units6(amount) <= 0n || units6(amount) > remaining || remaining <= 0n) { res.status(409).json({ error: "Enter an amount above zero and no more than the remaining invoice balance." }); return; }
    const result = await createSavedQuote({ workspaceId: invoice.workspaceId, createdBy: "public-invoice-payer", idempotencyKey: `public-invoice:${invoice.id}:${idempotencyKey}`,
      originAsset, destinationAsset: invoice.paymentAssetId, amount, recipient: invoice.paymentRecipient, refundTo: refundTo.trim(),
      slippageTolerance, swapType: "EXACT_OUTPUT", invoiceId: invoice.id });
    res.status(201).json(result);
  } catch (error) { sendError(error, res); }
});

router.get("/public/invoices/:token/payments/:paymentId/status", async (req, res): Promise<void> => {
  const invoice = await findInvoice(req.params.token);
  if (!invoice || !/^[0-9a-f-]{36}$/i.test(req.params.paymentId)) { res.status(404).json({ error: "Payment record not found." }); return; }
  const [payment] = await db.select().from(nearIntentQuotesTable).where(and(eq(nearIntentQuotesTable.id, req.params.paymentId), eq(nearIntentQuotesTable.invoiceId, invoice.id))).limit(1);
  if (!payment) { res.status(404).json({ error: "Payment record not found." }); return; }
  try {
    const result = await refreshSavedQuoteStatus(payment, "public-invoice-payer");
    res.json({ paymentId: result.paymentId, status: result.status, reconciliationStatus: result.reconciliationStatus, updatedAt: result.updatedAt });
  }
  catch (error) { sendError(error, res); }
});

router.post("/public/invoices/:token/payments/:paymentId/deposit-submitted", async (req, res): Promise<void> => {
  const invoice = await findInvoice(req.params.token);
  const { txHash } = req.body ?? {};
  if (!invoice || !/^[0-9a-f-]{36}$/i.test(req.params.paymentId) || typeof txHash !== "string" || !/^0x[0-9a-f]{64}$/i.test(txHash)) { res.status(400).json({ error: "A valid invoice payment and EVM transaction hash are required." }); return; }
  const [payment] = await db.select().from(nearIntentQuotesTable).where(and(eq(nearIntentQuotesTable.id, req.params.paymentId), eq(nearIntentQuotesTable.invoiceId, invoice.id))).limit(1);
  const savedQuote = payment?.quotePayload?.quote;
  const depositAddress = savedQuote && typeof savedQuote === "object" ? (savedQuote as Record<string, unknown>).depositAddress : undefined;
  if (!payment || typeof depositAddress !== "string" || !/^0x[0-9a-f]{40}$/i.test(depositAddress)) { res.status(404).json({ error: "The invoice payment route was not found." }); return; }
  try {
    await recordInvoiceWalletSubmission(payment!, txHash);
    res.json(await submitDeposit(depositAddress, txHash));
  } catch (error) { sendError(error, res); }
});

router.post("/public/invoices/:token/payments/:paymentId/near-deposit-submitted", async (req, res): Promise<void> => {
  const invoice = await findInvoice(req.params.token);
  const { txHash } = req.body ?? {};
  if (!invoice || !/^[0-9a-f-]{36}$/i.test(req.params.paymentId) || typeof txHash !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(txHash)) { res.status(400).json({ error: "A valid invoice payment and NEAR transaction hash are required." }); return; }
  const [payment] = await db.select().from(nearIntentQuotesTable).where(and(eq(nearIntentQuotesTable.id, req.params.paymentId), eq(nearIntentQuotesTable.invoiceId, invoice.id))).limit(1);
  const savedQuote = payment?.quotePayload?.quote;
  const depositAddress = savedQuote && typeof savedQuote === "object" ? (savedQuote as Record<string, unknown>).depositAddress : undefined;
  if (!payment || payment.originAssetNetwork?.toLowerCase() !== "near" || typeof depositAddress !== "string" || !/^[a-z0-9._-]{2,64}$/.test(depositAddress)) { res.status(409).json({ error: "This payment is not a NEAR deposit route." }); return; }
  try {
    await recordInvoiceWalletSubmission(payment!, txHash);
    res.json(await submitDeposit(depositAddress, txHash));
  } catch (error) { sendError(error, res); }
});

async function recordInvoiceWalletSubmission(payment: typeof nearIntentQuotesTable.$inferSelect, txHash: string): Promise<void> {
  const payload = payment.quotePayload && typeof payment.quotePayload === "object" ? payment.quotePayload as Record<string, unknown> : {};
  const previous = payload.walletSubmission && typeof payload.walletSubmission === "object" ? payload.walletSubmission as Record<string, unknown> : {};
  if (previous.txHash === txHash) return;
  if (typeof previous.txHash === "string") throw new Error("A different wallet transfer is already recorded for this invoice quote. Check payment status before retrying.");
  await db.update(nearIntentQuotesTable).set({ quotePayload: { ...payload, walletSubmission: { txHash, submittedAt: new Date().toISOString() } } })
    .where(eq(nearIntentQuotesTable.id, payment.id));
}

router.get("/public/invoices/:token/receipts", async (req, res): Promise<void> => {
  const invoice = await findInvoice(req.params.token);
  if (!invoice) { res.status(404).json({ error: "Payment link not found." }); return; }
  const payments = await db.select({ paymentId: nearIntentQuotesTable.id, settledAt: nearIntentQuotesTable.settledAt })
    .from(nearIntentQuotesTable).where(and(
      eq(nearIntentQuotesTable.invoiceId, invoice.id),
      eq(nearIntentQuotesTable.providerStatus, "SUCCESS"),
      eq(nearIntentQuotesTable.reconciliationStatus, "matched_invoice"),
    )).orderBy(desc(nearIntentQuotesTable.settledAt)).limit(10);
  res.setHeader("Cache-Control", "private, no-store");
  res.json(payments.filter((payment) => payment.settledAt).map((payment) => ({ paymentId: payment.paymentId, settledAt: payment.settledAt })));
});

router.get("/public/invoices/:token/payments/:paymentId/receipt", async (req, res): Promise<void> => {
  const invoice = await findInvoice(req.params.token);
  if (!invoice || !/^[0-9a-f-]{36}$/i.test(req.params.paymentId)) { res.status(404).json({ error: "Receipt not found." }); return; }
  const [payment] = await db.select().from(nearIntentQuotesTable).where(and(
    eq(nearIntentQuotesTable.id, req.params.paymentId), eq(nearIntentQuotesTable.invoiceId, invoice.id),
  )).limit(1);
  if (!payment || payment.providerStatus !== "SUCCESS" || payment.reconciliationStatus !== "matched_invoice" || !payment.settledAt || invoice.status !== "paid") {
    res.status(409).json({ error: "A receipt is available after the payment is confirmed and reconciled to this invoice." }); return;
  }
  const quote = payment.quotePayload?.quote && typeof payment.quotePayload.quote === "object" ? payment.quotePayload.quote as Record<string, unknown> : {};
  const status = payment.providerStatusPayload ?? {};
  const swapDetails = status.swapDetails && typeof status.swapDetails === "object" ? status.swapDetails as Record<string, unknown> : {};
  const refs = [swapDetails.originChainTxHashes, swapDetails.destinationChainTxHashes, swapDetails.nearTxHashes].flatMap((item) => Array.isArray(item) ? item : []).slice(0, 4)
    .map((item) => typeof item === "string" ? item : item && typeof item === "object" ? (item as Record<string, unknown>).hash : null)
    .filter((item): item is string => typeof item === "string" && item.length < 160).map((item) => item.slice(0, 96));
  const lines: ReceiptLine[] = [
    { label: "Invoice", value: `${invoice.invoiceNumber} · ${invoice.description.slice(0, 160)}${invoice.description.length > 160 ? "..." : ""}` },
    { label: "Paid by", value: invoice.clientName },
    { label: "Payment received", value: `${amountFromProvider(swapDetails.amountOutFormatted ?? swapDetails.amountOut, payment.destinationAssetDecimals) ?? String(quote.amountOutFormatted ?? invoice.amount)} ${payment.destinationAssetSymbol ?? invoice.currency}` },
    { label: amountFromProvider(swapDetails.amountInFormatted ?? swapDetails.amountIn, payment.originAssetDecimals) ? "Amount paid" : "Quoted source amount", value: `${amountFromProvider(swapDetails.amountInFormatted ?? swapDetails.amountIn, payment.originAssetDecimals) ?? String(quote.amountInFormatted ?? "Provider quote amount")} ${payment.originAssetSymbol ?? "source asset"} on ${payment.originAssetNetwork ?? "supported network"}` },
    { label: "Settled to", value: `${payment.destinationAssetSymbol ?? invoice.currency} on ${payment.destinationAssetNetwork ?? "supported network"}` },
    { label: "Settlement date (UTC)", value: payment.settledAt.toISOString().replace("T", " ").replace(".000Z", " UTC") },
    { label: "Trezu payment reference", value: payment.id },
    { label: "Provider transaction references", value: refs.join(", ") || "Provider confirmed settlement; transaction hash was not included in the status response." },
  ];
  if (typeof quote.withdrawFee === "string" && /^\d+$/.test(quote.withdrawFee) && payment.destinationAssetDecimals !== null) {
    const amount = BigInt(quote.withdrawFee);
    const scale = 10n ** BigInt(payment.destinationAssetDecimals ?? 0);
    const whole = (amount / scale).toString();
    const fraction = (amount % scale).toString().padStart(payment.destinationAssetDecimals ?? 0, "0").replace(/0+$/, "");
    lines.push({ label: "Provider withdrawal fee", value: `${whole}${fraction ? `.${fraction}` : ""} ${payment.destinationAssetSymbol ?? invoice.currency}` });
  }
  const pdf = createReceiptPdf({ title: "Payment receipt", subtitle: `Invoice ${invoice.invoiceNumber} · Provider confirmed`, lines, footer: "This receipt records provider-confirmed settlement. It is not a bank statement or tax advice." });
  const safeName = invoice.invoiceNumber.replace(/[^A-Za-z0-9_-]/g, "_");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="trezu-receipt-${safeName}.pdf"`);
  res.setHeader("Content-Length", String(pdf.length));
  res.send(pdf);
});

export default router;
