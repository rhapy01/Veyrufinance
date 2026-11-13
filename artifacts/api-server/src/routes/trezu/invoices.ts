import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  auditLogsTable,
  db,
  invoicesTable,
  nearIntentQuotesTable,
  usersTable,
  workspacesTable,
} from "@workspace/db";
import {
  CreateInvoiceBody,
  CreateInvoiceResponse,
  GetInvoicesResponse,
} from "@workspace/api-zod";
import {
  requireWorkspaceMember,
  requireWorkspaceRole,
} from "../../middlewares/auth";
import { isPositiveMoney } from "../../lib/money";
import { getSupportedAssets } from "../../lib/near-intents";
import { invoiceCurrencyMatchesAsset } from "../../lib/invoice-currency";
import { createReceiptPdf, type ReceiptLine } from "../../lib/receipt-pdf";
import { sendInvoiceEmail, sendInvoiceReminderEmail, emailDeliveryConfigured } from "../../lib/auth-email";

const router: IRouter = Router();
const routeId = (value: string | string[] | undefined): string => typeof value === "string" ? value : "";

function invoiceStatus(invoice: typeof invoicesTable.$inferSelect) {
  if (["sent", "viewed", "partially_paid"].includes(invoice.status) && invoice.dueDate && invoice.dueDate < new Date().toISOString().slice(0, 10)) return "overdue";
  return invoice.status;
}

function amountUnits(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
}

function formatAmountUnits(value: bigint): string {
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${value / 1_000_000n}.${fraction}` : String(value / 1_000_000n);
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

router.get(
  "/invoices",
  requireWorkspaceMember,
  requireWorkspaceRole("owner", "admin"),
  async (req, res): Promise<void> => {
    const invoices = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.workspaceId, req.trezuWorkspaceId!))
      .orderBy(desc(invoicesTable.createdAt));
    res.json(GetInvoicesResponse.parse(invoices.map((invoice) => ({ ...invoice, status: invoiceStatus(invoice) }))));
  },
);

router.get("/invoices/:invoiceId/detail", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const invoiceId = routeId(req.params.invoiceId);
  if (!/^[0-9a-f-]{36}$/i.test(invoiceId)) { res.status(404).json({ error: "Invoice not found." }); return; }
  const [invoice] = await db.select().from(invoicesTable).where(and(
    eq(invoicesTable.id, invoiceId), eq(invoicesTable.workspaceId, req.trezuWorkspaceId!),
  )).limit(1);
  if (!invoice) { res.status(404).json({ error: "Invoice not found." }); return; }

  const payments = await db.select().from(nearIntentQuotesTable).where(eq(nearIntentQuotesTable.invoiceId, invoice.id)).orderBy(desc(nearIntentQuotesTable.createdAt));
  const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const string = (value: unknown): string | null => typeof value === "string" ? value : null;
  const paidUnits = payments.reduce((sum, payment) => {
    if (payment.providerStatus !== "SUCCESS" || payment.reconciliationStatus !== "matched_invoice") return sum;
    const quote = object(object(payment.quotePayload).quote);
    const amount = string(quote.amountOutFormatted);
    return sum + (amount && isPositiveMoney(amount) ? amountUnits(amount) : 0n);
  }, 0n);
  const totalUnits = amountUnits(invoice.amount);
  const formatUnits = (units: bigint) => `${units / 1_000_000n}.${(units % 1_000_000n).toString().padStart(6, "0")}`.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");

  const paymentDetails = payments.map((payment) => {
    const payload = object(payment.quotePayload);
    const quote = object(payload.quote);
    const status = object(payment.providerStatusPayload);
    const tidepool = object(status.tidepool);
    const swapDetails = object(status.swapDetails);
    const explorerLinks: { label: string; url: string }[] = [];
    if (Array.isArray(tidepool.explorer)) for (const item of tidepool.explorer) {
      const row = object(item); const url = string(row.url); const label = string(row.label);
      if (url?.startsWith("https://")) explorerLinks.push({ label: label || "NEAR transaction", url });
    }
    for (const listName of ["originChainTxHashes", "destinationChainTxHashes"] as const) {
      const values = swapDetails[listName];
      if (!Array.isArray(values)) continue;
      for (const item of values) {
        const row = object(item); const url = string(row.explorerUrl); const hash = string(row.hash);
        if (url?.startsWith("https://")) explorerLinks.push({ label: hash ? `${listName.startsWith("origin") ? "Payment sent" : "Payment received"} · ${hash.slice(0, 12)}…` : "Transaction", url });
      }
    }
    return {
      id: payment.id,
      status: payment.providerStatus,
      reconciliationStatus: payment.reconciliationStatus,
      originAssetSymbol: payment.originAssetSymbol,
      originAssetNetwork: payment.originAssetNetwork,
      destinationAssetSymbol: payment.destinationAssetSymbol,
      destinationAssetNetwork: payment.destinationAssetNetwork,
      quotedAmountIn: string(quote.amountInFormatted),
      quotedAmountOut: string(quote.amountOutFormatted),
      actualAmountIn: string(swapDetails.amountInFormatted),
      actualAmountOut: string(swapDetails.amountOutFormatted),
      refundedAmount: string(swapDetails.refundedAmountFormatted),
      createdAt: payment.createdAt,
      settledAt: payment.settledAt,
      statusCheckedAt: payment.statusCheckedAt,
      lastError: payment.lastError,
      explorerLinks,
    };
  });

  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    invoice: {
      id: invoice.id, invoiceNumber: invoice.invoiceNumber, clientName: invoice.clientName, clientEmail: invoice.clientEmail,
      description: invoice.description, lineItems: invoice.lineItems?.length ? invoice.lineItems : [{ description: invoice.description, amount: invoice.amount }],
      amount: invoice.amount, currency: invoice.currency, status: invoiceStatus(invoice), dueDate: invoice.dueDate,
      notes: invoice.notes, paymentTerms: invoice.paymentTerms, paymentAssetId: invoice.paymentAssetId,
      paymentRecipient: invoice.paymentRecipient, createdAt: invoice.createdAt, sentAt: invoice.sentAt, paidAt: invoice.paidAt,
      paymentLink: invoice.publicToken ? `/pay/${invoice.publicToken}` : null,
    },
    paidAmount: formatUnits(paidUnits),
    remainingAmount: formatUnits(totalUnits > paidUnits ? totalUnits - paidUnits : 0n),
    payments: paymentDetails,
  });
});

router.get("/received-invoices", requireWorkspaceMember, async (req, res): Promise<void> => {
  const [user] = await db.select({ email: usersTable.email }).from(usersTable)
    .where(eq(usersTable.id, req.trezuUserId!)).limit(1);
  if (!user) { res.status(401).json({ error: "Sign in to view invoices sent to you." }); return; }
  const received = await db.select({ invoice: invoicesTable, senderName: workspacesTable.name })
    .from(invoicesTable)
    .innerJoin(workspacesTable, eq(invoicesTable.workspaceId, workspacesTable.id))
    .where(and(
      eq(invoicesTable.clientEmail, user.email),
      inArray(invoicesTable.status, ["sent", "viewed", "partially_paid", "paid", "cancelled"]),
    ))
    .orderBy(desc(invoicesTable.sentAt), desc(invoicesTable.createdAt));
  const paymentRows = received.length ? await db.select({ id: nearIntentQuotesTable.id, invoiceId: nearIntentQuotesTable.invoiceId, quotePayload: nearIntentQuotesTable.quotePayload, providerStatus: nearIntentQuotesTable.providerStatus, reconciliationStatus: nearIntentQuotesTable.reconciliationStatus })
    .from(nearIntentQuotesTable)
    .where(inArray(nearIntentQuotesTable.invoiceId, received.map(({ invoice }) => invoice.id))) : [];
  const paidByInvoice = new Map<string, bigint>();
  const pendingPaymentByInvoice = new Map<string, { paymentId: string; txHash: string; submittedAt: string }>();
  for (const row of paymentRows) {
    if (!row.invoiceId) continue;
    const payload = row.quotePayload && typeof row.quotePayload === "object" ? row.quotePayload as Record<string, unknown> : {};
    const submission = payload.walletSubmission && typeof payload.walletSubmission === "object" ? payload.walletSubmission as Record<string, unknown> : {};
    if (typeof submission.txHash === "string" && !["SUCCESS", "FAILED", "REFUNDED"].includes(row.providerStatus)) {
      pendingPaymentByInvoice.set(row.invoiceId, { paymentId: row.id, txHash: submission.txHash, submittedAt: typeof submission.submittedAt === "string" ? submission.submittedAt : "" });
    }
    if (row.providerStatus !== "SUCCESS" || row.reconciliationStatus !== "matched_invoice") continue;
    const quote = payload.quote && typeof payload.quote === "object" ? payload.quote as Record<string, unknown> : {};
    const amount = typeof quote.amountOutFormatted === "string" && isPositiveMoney(quote.amountOutFormatted) ? amountUnits(quote.amountOutFormatted) : 0n;
    paidByInvoice.set(row.invoiceId, (paidByInvoice.get(row.invoiceId) ?? 0n) + amount);
  }
  res.json({ invoices: received.map(({ invoice, senderName }) => {
    const total = amountUnits(invoice.amount);
    const paid = paidByInvoice.get(invoice.id) ?? 0n;
    return { ...invoice, senderName, status: invoiceStatus(invoice), amountPaid: formatAmountUnits(paid), amountDue: formatAmountUnits(total > paid ? total - paid : 0n), pendingPayment: pendingPaymentByInvoice.get(invoice.id) ?? null };
  }) });
});

router.post(
  "/invoices",
  requireWorkspaceMember,
  requireWorkspaceRole("owner", "admin"),
  async (req, res): Promise<void> => {
    const parsed = CreateInvoiceBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    if (!isPositiveMoney(parsed.data.amount)) {
      res.status(400).json({ error: "Invoice amount must be greater than zero" });
      return;
    }
    if (!parsed.data.clientName.trim() || !parsed.data.description.trim()) {
      res.status(400).json({ error: "Enter a client name and invoice summary." }); return;
    }
    const lineItems = parsed.data.lineItems?.length ? parsed.data.lineItems : [{ description: parsed.data.description, amount: parsed.data.amount }];
    if (lineItems.length > 30 || lineItems.some((line) => !line.description.trim() || line.description.length > 240 || !isPositiveMoney(line.amount))) {
      res.status(400).json({ error: "Add between 1 and 30 invoice items with a description and positive amount." }); return;
    }
    const totalUnits = lineItems.reduce((sum, line) => sum + amountUnits(line.amount), 0n);
    if (totalUnits >= 10n ** 24n) { res.status(400).json({ error: "The invoice total exceeds the supported amount precision." }); return; }
    if (totalUnits !== amountUnits(parsed.data.amount)) {
      res.status(400).json({ error: "The invoice total must equal the sum of its line items." }); return;
    }
    if (parsed.data.dueDate != null && !isCalendarDate(parsed.data.dueDate)) {
      res.status(400).json({ error: "Enter a valid invoice due date." }); return;
    }

    const paymentAssetId = parsed.data.paymentAssetId?.trim() || "";
    const paymentRecipient = parsed.data.paymentRecipient?.trim() || "";
    if (!paymentAssetId || !paymentRecipient) {
      res.status(400).json({ error: "Choose the settlement asset and the address where you want to receive payment." }); return;
    }
    let settlementAsset: Awaited<ReturnType<typeof getSupportedAssets>>[number] | undefined;
    if (paymentAssetId) {
      try { settlementAsset = (await getSupportedAssets()).find((asset) => asset.assetId === paymentAssetId); }
      catch { res.status(503).json({ error: "Supported testnet settlement assets are temporarily unavailable." }); return; }
      if (!settlementAsset || !invoiceCurrencyMatchesAsset(parsed.data.currency, settlementAsset.symbol)) {
        res.status(400).json({ error: parsed.data.currency.toUpperCase() === "USD" ? "Choose a supported USDC or USDT testnet settlement asset." : "Choose a supported settlement asset that matches the invoice currency." }); return;
      }
      if (paymentRecipient.length > 200) { res.status(400).json({ error: "The receiving address must be 200 characters or fewer." }); return; }
    }

    const id = randomUUID();
    const invoiceNumber = `TRZ-${new Date().getUTCFullYear()}-${id
      .replaceAll("-", "")
      .slice(0, 8)
      .toUpperCase()}`;
    const publicToken = randomBytes(32).toString("base64url");
    const createdAt = new Date();
    const invoice = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(invoicesTable)
        .values({
          id,
          workspaceId: req.trezuWorkspaceId!,
          invoiceNumber,
          clientName: parsed.data.clientName.trim(),
          clientEmail: parsed.data.clientEmail?.trim() || null,
          description: parsed.data.description.trim(),
          lineItems: lineItems.map((line) => ({ description: line.description.trim(), amount: line.amount })),
          amount: parsed.data.amount,
          currency: parsed.data.currency.toUpperCase(),
          dueDate: parsed.data.dueDate || null,
          notes: parsed.data.notes?.trim() || null,
          paymentTerms: parsed.data.paymentTerms?.trim() || null,
          status: "draft",
          publicToken, paymentAssetId, paymentRecipient,
          createdBy: req.trezuUserId!,
        })
        .returning();

      await tx.insert(auditLogsTable).values({
        workspaceId: req.trezuWorkspaceId!,
        actorUserId: req.trezuUserId!,
        action: "invoice.created",
        entityType: "invoice",
        entityId: id,
        metadata: { status: "draft", currency: parsed.data.currency, lineItemCount: lineItems.length, dueDate: parsed.data.dueDate || null, paymentLinkCreated: true },
      });
      if (settlementAsset) await tx.insert(auditLogsTable).values({
        workspaceId: req.trezuWorkspaceId!, actorUserId: req.trezuUserId!, action: "invoice.payment_link_created",
        entityType: "invoice", entityId: id, metadata: { paymentAssetId, currency: settlementAsset.symbol },
      });
      return created;
    });

    res.status(201).json({ ...CreateInvoiceResponse.parse(invoice), paymentLink: `/pay/${publicToken}` });
  },
);

router.post("/invoices/:invoiceId/send", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const invoiceId = typeof req.params.invoiceId === "string" ? req.params.invoiceId : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!/^[0-9a-f-]{36}$/i.test(invoiceId) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: "Enter the recipient email address used for their Trezu account." }); return;
  }
  if (!emailDeliveryConfigured()) { res.status(503).json({ error: "Invoice email is not configured. Check the Google SMTP settings." }); return; }
  const [invoice] = await db.select().from(invoicesTable).where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.workspaceId, req.trezuWorkspaceId!))).limit(1);
  if (!invoice) { res.status(404).json({ error: "Invoice not found." }); return; }
  if (invoice.status !== "draft") { res.status(409).json({ error: "Only a draft invoice can be sent." }); return; }
  const [recipient] = await db.select({ id: usersTable.id, email: usersTable.email, name: usersTable.name, emailVerifiedAt: usersTable.emailVerifiedAt })
    .from(usersTable).where(and(eq(usersTable.email, email), eq(usersTable.active, true))).limit(1);
  if (!recipient || !recipient.emailVerifiedAt) {
    res.status(404).json({ error: "No verified Trezu account uses that email. Ask the recipient to register and verify it first." }); return;
  }
  const [workspace] = await db.select({ name: workspacesTable.name }).from(workspacesTable).where(eq(workspacesTable.id, invoice.workspaceId)).limit(1);
  const businessName = workspace?.name?.trim() || "Trezu business";
  const webUrl = (process.env.WEB_APP_URL || "http://localhost:5173").replace(/\/$/, "");
  const invoiceUrl = `${webUrl}/app/invoices?tab=received`;
  const [claimed] = await db.update(invoicesTable).set({ clientName: recipient.name, clientEmail: recipient.email, status: "sending" })
    .where(and(eq(invoicesTable.id, invoice.id), eq(invoicesTable.status, "draft"))).returning({ id: invoicesTable.id });
  if (!claimed) { res.status(409).json({ error: "This invoice is already being sent or has already been sent." }); return; }
  try {
    const sent = await sendInvoiceEmail({
      email: recipient.email, recipientName: recipient.name, businessName, invoiceNumber: invoice.invoiceNumber,
      description: invoice.description, lineItems: invoice.lineItems?.length ? invoice.lineItems : [{ description: invoice.description, amount: invoice.amount }],
      amount: invoice.amount, currency: invoice.currency, dueDate: invoice.dueDate, invoiceUrl,
    });
    if (!sent) throw new Error("SMTP is not configured.");
  } catch {
    await db.update(invoicesTable).set({ status: "draft" }).where(eq(invoicesTable.id, invoice.id));
    res.status(503).json({ error: "The invoice is saved, but the email could not be sent. Check Google SMTP and try Send again.", savedAsDraft: true }); return;
  }
  const sentAt = new Date();
  const [updated] = await db.update(invoicesTable).set({ status: "sent", sentAt }).where(and(eq(invoicesTable.id, invoice.id), eq(invoicesTable.status, "sending"))).returning();
  if (!updated) { res.status(409).json({ error: "The email was delivered, but the invoice status changed. Refresh the invoice list." }); return; }
  await db.insert(auditLogsTable).values({ workspaceId: invoice.workspaceId, actorUserId: req.trezuUserId!, action: "invoice.sent", entityType: "invoice", entityId: invoice.id, metadata: { invoiceNumber: invoice.invoiceNumber, recipientEmail: recipient.email, delivery: "smtp" } });
  res.json({ invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, status: updated.status, recipientEmail: recipient.email, sentAt, paymentLink: `/pay/${invoice.publicToken}` });
});

router.post("/invoices/:invoiceId/reminder", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const invoiceId = routeId(req.params.invoiceId);
  if (!/^[0-9a-f-]{36}$/i.test(invoiceId)) { res.status(404).json({ error: "Invoice not found." }); return; }
  const [invoice] = await db.select().from(invoicesTable).where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.workspaceId, req.trezuWorkspaceId!))).limit(1);
  if (!invoice) { res.status(404).json({ error: "Invoice not found." }); return; }
  if (!invoice.clientEmail || !invoice.publicToken || !invoice.sentAt || !["sent", "viewed", "partially_paid"].includes(invoice.status)) {
    res.status(409).json({ error: "Only a sent invoice with an outstanding balance can receive a reminder." }); return;
  }
  if (!emailDeliveryConfigured()) { res.status(503).json({ error: "Invoice email is not configured. Check the Google SMTP settings." }); return; }
  const payments = await db.select().from(nearIntentQuotesTable).where(eq(nearIntentQuotesTable.invoiceId, invoice.id));
  const paid = payments.reduce((sum, payment) => {
    if (payment.providerStatus !== "SUCCESS" || payment.reconciliationStatus !== "matched_invoice") return sum;
    const payload = payment.quotePayload && typeof payment.quotePayload === "object" ? payment.quotePayload as Record<string, unknown> : {};
    const quote = payload.quote && typeof payload.quote === "object" ? payload.quote as Record<string, unknown> : {};
    const amount = typeof quote.amountOutFormatted === "string" ? quote.amountOutFormatted : "";
    return amount && isPositiveMoney(amount) ? sum + amountUnits(amount) : sum;
  }, 0n);
  const total = amountUnits(invoice.amount);
  const remaining = total > paid ? total - paid : 0n;
  if (remaining <= 0n) { res.status(409).json({ error: "This invoice has no remaining balance." }); return; }
  const [workspace] = await db.select({ name: workspacesTable.name }).from(workspacesTable).where(eq(workspacesTable.id, invoice.workspaceId)).limit(1);
  const [recipient] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.email, invoice.clientEmail)).limit(1);
  const webUrl = (process.env.WEB_APP_URL || "http://localhost:5173").replace(/\/$/, "");
  const invoiceUrl = `${webUrl}/pay/${invoice.publicToken}`;
  try {
    const sent = await sendInvoiceReminderEmail({
      email: invoice.clientEmail, recipientName: recipient?.name || invoice.clientName,
      businessName: workspace?.name?.trim() || "Trezu business", invoiceNumber: invoice.invoiceNumber,
      description: invoice.description, amountDue: formatAmountUnits(remaining), currency: invoice.currency,
      dueDate: invoice.dueDate, invoiceUrl,
    });
    if (!sent) throw new Error("SMTP is not configured.");
  } catch {
    res.status(503).json({ error: "The reminder could not be delivered. Check Google SMTP and try again." }); return;
  }
  await db.insert(auditLogsTable).values({ workspaceId: invoice.workspaceId, actorUserId: req.trezuUserId!, action: "invoice.payment_reminder_sent", entityType: "invoice", entityId: invoice.id, metadata: { invoiceNumber: invoice.invoiceNumber, recipientEmail: invoice.clientEmail, remainingAmount: formatAmountUnits(remaining), delivery: "smtp" } });
  res.json({ invoiceId: invoice.id, recipientEmail: invoice.clientEmail, amountDue: formatAmountUnits(remaining), currency: invoice.currency, sentAt: new Date() });
});

router.post("/invoices/:invoiceId/payment-link", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const invoiceId = routeId(req.params.invoiceId);
  const { paymentAssetId, paymentRecipient } = req.body ?? {};
  if (!/^[0-9a-f-]{36}$/i.test(invoiceId)) { res.status(404).json({ error: "Invoice not found." }); return; }
  if (typeof paymentAssetId !== "string" || typeof paymentRecipient !== "string" || !paymentRecipient.trim() || paymentRecipient.length > 200) {
    res.status(400).json({ error: "Choose a settlement asset and enter its receiving wallet address." });
    return;
  }
  const [invoice] = await db.select().from(invoicesTable).where(and(
    eq(invoicesTable.id, invoiceId), eq(invoicesTable.workspaceId, req.trezuWorkspaceId!),
  )).limit(1);
  if (!invoice) { res.status(404).json({ error: "Invoice not found." }); return; }
  if (["paid", "cancelled"].includes(invoice.status)) { res.status(409).json({ error: "Paid or cancelled invoices cannot receive a payment link." }); return; }
  let asset;
  try { asset = (await getSupportedAssets()).find((candidate) => candidate.assetId === paymentAssetId); }
  catch { res.status(503).json({ error: "The supported settlement assets are temporarily unavailable." }); return; }
  if (!asset || !invoiceCurrencyMatchesAsset(invoice.currency, asset.symbol)) {
    res.status(400).json({ error: invoice.currency.toUpperCase() === "USD" ? "USD invoices can settle in a supported USDC or USDT asset." : "Choose a supported asset that matches the invoice currency." });
    return;
  }
  if (invoice.publicToken && (invoice.paymentAssetId !== paymentAssetId || invoice.paymentRecipient !== paymentRecipient.trim())) {
    res.status(409).json({ error: "This invoice already has a payment link. Create a new invoice to change its payment details." });
    return;
  }
  const token = invoice.publicToken ?? randomBytes(32).toString("base64url");
  const now = new Date();
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(invoicesTable).set({
      publicToken: token, paymentAssetId, paymentRecipient: paymentRecipient.trim(),
      status: invoice.status === "viewed" ? "viewed" : "sent", sentAt: invoice.sentAt ?? now,
    }).where(eq(invoicesTable.id, invoice.id)).returning();
    await tx.insert(auditLogsTable).values({
      workspaceId: invoice.workspaceId, actorUserId: req.trezuUserId!, action: "invoice.payment_link_created",
      entityType: "invoice", entityId: invoice.id, metadata: { paymentAssetId, currency: asset.symbol },
    });
    return row;
  });
  res.status(201).json({ invoiceId: updated!.id, status: updated!.status, currency: asset.symbol, paymentLink: `/pay/${token}` });
});

router.get("/invoices/:invoiceId/pdf", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const invoiceId = routeId(req.params.invoiceId);
  if (!/^[0-9a-f-]{36}$/i.test(invoiceId)) { res.status(404).json({ error: "Invoice not found." }); return; }
  const [invoice] = await db.select().from(invoicesTable).where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.workspaceId, req.trezuWorkspaceId!))).limit(1);
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

export default router;
