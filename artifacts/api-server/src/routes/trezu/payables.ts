import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { auditLogsTable, db, nearIntentQuotesTable, payableBillsTable, payableIntakeLinksTable, workspacesTable } from "@workspace/db";
import { requireWorkspaceMember, requireWorkspaceRole } from "../../middlewares/auth";
import { createSavedQuote, refreshSavedQuoteStatus } from "../../lib/near-intent-workflows";
import { getSupportedAssets, NearIntentsError, submitDeposit } from "../../lib/near-intents";
import { isPositiveMoney } from "../../lib/money";

const router: IRouter = Router();
const uuidPattern = /^[0-9a-f-]{36}$/i;
const validDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const routeId = (value: string | string[] | undefined): string => typeof value === "string" ? value : "";

router.post("/payables/intake-link", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const token = randomBytes(32).toString("base64url");
  const [link] = await db.insert(payableIntakeLinksTable).values({ workspaceId: req.trezuWorkspaceId!, token, createdBy: req.trezuUserId!, active: true })
    .onConflictDoUpdate({ target: payableIntakeLinksTable.workspaceId, set: { token, active: true, createdBy: req.trezuUserId!, createdAt: new Date() } }).returning();
  const [workspace] = await db.select({ name: workspacesTable.name }).from(workspacesTable).where(eq(workspacesTable.id, req.trezuWorkspaceId!)).limit(1);
  res.status(201).json({ token: link!.token, path: `/submit-invoice/${link!.token}`, businessName: workspace?.name || "Business" });
});

router.patch("/payables/:billId/review", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const billId = routeId(req.params.billId);
  if (!uuidPattern.test(billId)) { res.status(404).json({ error: "Vendor bill not found." }); return; }
  const [bill] = await db.select().from(payableBillsTable).where(and(eq(payableBillsTable.id, billId), eq(payableBillsTable.workspaceId, req.trezuWorkspaceId!))).limit(1);
  if (!bill) { res.status(404).json({ error: "Vendor bill not found." }); return; }
  if (!(["submitted", "draft", "ready", "failed"] as string[]).includes(bill.status) || bill.depositTxHash) { res.status(409).json({ error: "This invoice can no longer be changed for payment." }); return; }
  const action = req.body?.action;
  if (action === "reject") {
    if (bill.status !== "submitted") { res.status(400).json({ error: "Only an invoice submitted by a vendor can be declined." }); return; }
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : "";
    const [updated] = await db.update(payableBillsTable).set({ status: "rejected", failureReason: reason || "Declined by the business", updatedAt: new Date() }).where(eq(payableBillsTable.id, bill.id)).returning();
    await db.insert(auditLogsTable).values({ workspaceId: bill.workspaceId, actorUserId: req.trezuUserId!, action: "payable.vendor_invoice_rejected", entityType: "payable_bill", entityId: bill.id, metadata: { reason: updated!.failureReason } });
    res.json(updated); return;
  }
  if (action !== "approve") { res.status(400).json({ error: "Choose approve or reject." }); return; }
  const assetId = typeof req.body?.payoutAssetId === "string" ? req.body.payoutAssetId : bill.payoutAssetId;
  const recipient = typeof req.body?.recipientAddress === "string" ? req.body.recipientAddress.trim() : bill.recipientAddress;
  if (typeof assetId !== "string" || !assetId || typeof recipient !== "string" || !recipient || recipient.length > 200 || (!/^[A-Za-z0-9._-]{2,64}$/.test(recipient) && !/^0x[0-9a-f]{40}$/i.test(recipient))) { res.status(400).json({ error: "Set a supported payout asset and a valid vendor wallet address before approving." }); return; }
  let assets;
  try { assets = await getSupportedAssets(); } catch { res.status(503).json({ error: "The supported asset catalog is temporarily unavailable." }); return; }
  const asset = assets.find((candidate) => candidate.assetId === assetId);
  if (!asset) { res.status(400).json({ error: "Choose a currently supported payout asset." }); return; }
  if (bill.currency.toUpperCase() !== asset.symbol.toUpperCase() && !(bill.currency.toUpperCase() === "USD" && typeof asset.price === "number" && asset.price > 0 && asset.priceUpdatedAt && Date.now() - new Date(asset.priceUpdatedAt).getTime() <= 600_000)) { res.status(409).json({ error: "This invoice currency needs a current USD price for the selected payout asset, or choose a matching asset." }); return; }
  const [updated] = await db.update(payableBillsTable).set({ payoutAssetId: asset.assetId, payoutAssetSymbol: asset.symbol, payoutNetwork: asset.blockchain, recipientAddress: recipient, status: "ready", failureReason: null, updatedAt: new Date() }).where(and(eq(payableBillsTable.id, bill.id), eq(payableBillsTable.status, bill.status))).returning();
  if (!updated) { res.status(409).json({ error: "This invoice has already been reviewed." }); return; }
  await db.insert(auditLogsTable).values({ workspaceId: bill.workspaceId, actorUserId: req.trezuUserId!, action: "payable.vendor_invoice_approved", entityType: "payable_bill", entityId: bill.id, metadata: { payoutAssetId: asset.assetId } });
  res.json(updated);
});

router.get("/payables", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const bills = await db.select().from(payableBillsTable).where(eq(payableBillsTable.workspaceId, req.trezuWorkspaceId!)).orderBy(desc(payableBillsTable.createdAt));
  const result = await Promise.all(bills.map(async (bill) => {
    const [quote] = bill.paymentQuoteId ? await db.select().from(nearIntentQuotesTable).where(and(eq(nearIntentQuotesTable.id, bill.paymentQuoteId), eq(nearIntentQuotesTable.workspaceId, bill.workspaceId))).limit(1) : [];
    return { ...bill, paymentQuote: quote ? { paymentId: quote.id, providerStatus: quote.providerStatus, reconciliationStatus: quote.reconciliationStatus, quote: quote.quotePayload, originAssetSymbol: quote.originAssetSymbol, originAssetNetwork: quote.originAssetNetwork } : null };
  }));
  res.json(result);
});

router.post("/payables", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const body = req.body ?? {};
  const fields = [body.billNumber, body.vendorName, body.currency];
  const recipient = typeof body.recipientAddress === "string" ? body.recipientAddress.trim() : "";
  if (fields.some((value) => typeof value !== "string" || !value.trim()) || fields.some((value) => typeof value === "string" && value.length > 500) || typeof body.amount !== "string" || !isPositiveMoney(body.amount) || (body.dueDate && !validDate(body.dueDate)) || typeof body.payoutAssetId !== "string" || !body.payoutAssetId || !recipient || recipient.length > 200 || (!/^[A-Za-z0-9._-]{2,64}$/.test(recipient) && !/^0x[0-9a-f]{40}$/i.test(recipient))) {
    res.status(400).json({ error: "Enter the invoice number, payee, amount, receiving asset, and a valid recipient wallet address." }); return;
  }
  let asset: Awaited<ReturnType<typeof getSupportedAssets>>[number] | undefined;
  try { asset = (await getSupportedAssets()).find((candidate) => candidate.assetId === body.payoutAssetId); }
  catch { res.status(503).json({ error: "NEAR Intents supported assets are temporarily unavailable. Try again shortly." }); return; }
  if (!asset) { res.status(400).json({ error: "Choose a receiving asset currently supported by NEAR Intents." }); return; }
  try {
    const [bill] = await db.transaction(async (tx) => {
      const [row] = await tx.insert(payableBillsTable).values({ workspaceId: req.trezuWorkspaceId!, billNumber: body.billNumber.trim(), vendorName: body.vendorName.trim(), vendorEmail: typeof body.vendorEmail === "string" && body.vendorEmail.trim() ? body.vendorEmail.trim() : null, description: typeof body.description === "string" && body.description.trim() ? body.description.trim() : "Received invoice", amount: body.amount, currency: body.currency.trim().toUpperCase(), dueDate: body.dueDate || null, payoutAssetId: asset!.assetId, payoutAssetSymbol: asset!.symbol, payoutNetwork: asset!.blockchain, recipientAddress: recipient, status: "draft", createdBy: req.trezuUserId! }).returning();
      await tx.insert(auditLogsTable).values({ workspaceId: req.trezuWorkspaceId!, actorUserId: req.trezuUserId!, action: "payable.received_invoice_recorded", entityType: "payable_bill", entityId: row!.id, metadata: { billNumber: row!.billNumber, vendorName: row!.vendorName, amount: row!.amount, currency: row!.currency } });
      return [row!];
    });
    res.status(201).json(bill);
  } catch (error) {
    res.status(409).json({ error: error instanceof Error && error.message.includes("unique") ? "That vendor bill number already exists in this workspace." : "The vendor bill could not be saved." });
  }
});

router.post("/payables/:billId/quote", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const billId = routeId(req.params.billId);
  if (!uuidPattern.test(billId)) { res.status(404).json({ error: "Vendor bill not found." }); return; }
  const { originAsset, refundTo } = req.body ?? {};
  if (typeof originAsset !== "string" || typeof refundTo !== "string" || !refundTo.trim()) { res.status(400).json({ error: "Choose the business source asset and refund wallet." }); return; }
  let assets;
  try { assets = await getSupportedAssets(); } catch { res.status(503).json({ error: "The supported asset catalog is temporarily unavailable." }); return; }
  const [bill] = await db.select().from(payableBillsTable).where(and(eq(payableBillsTable.id, billId), eq(payableBillsTable.workspaceId, req.trezuWorkspaceId!))).limit(1);
  if (!bill) { res.status(404).json({ error: "Vendor bill not found." }); return; }
  if (bill.status === "paid") { res.status(409).json({ error: "This vendor bill is already settled." }); return; }
  if (bill.status === "processing") { res.status(409).json({ error: "A payment quote for this bill is already being prepared." }); return; }
  if (bill.depositTxHash) { res.status(409).json({ error: "A wallet transfer was already submitted for this bill. Check provider settlement before retrying." }); return; }
  if (bill.paymentQuoteId) {
    const [existing] = await db.select().from(nearIntentQuotesTable).where(and(eq(nearIntentQuotesTable.id, bill.paymentQuoteId), eq(nearIntentQuotesTable.workspaceId, bill.workspaceId))).limit(1);
    if (existing?.providerStatus === "SUCCESS") { res.status(409).json({ error: "The provider reports this bill payment as settled. Check its status and review the reconciliation before preparing another payment." }); return; }
    if (existing && !["FAILED", "REFUNDED", "QUOTE_FAILED"].includes(existing.providerStatus)) {
      res.json({ paymentId: existing.id, providerStatus: existing.providerStatus, quote: existing.quotePayload, payoutAmount: bill.payoutAmount, alreadyPrepared: true }); return;
    }
  }
  const destination = assets.find((asset) => asset.assetId === bill.payoutAssetId);
  const origin = assets.find((asset) => asset.assetId === originAsset);
  const recipientAddress = bill.recipientAddress;
  if (!destination || !origin || !recipientAddress) { res.status(409).json({ error: "A selected asset or recipient wallet is missing. Review the invoice details and try again." }); return; }
  if (destination.assetId === origin.assetId) { res.status(400).json({ error: "Choose a different source asset so NEAR Intents can route the payment." }); return; }
  let payoutAmount = bill.amount;
  if (bill.currency.toUpperCase() !== destination.symbol.toUpperCase()) {
    const price = destination.price;
    if (bill.currency.toUpperCase() !== "USD" || typeof price !== "number" || !Number.isFinite(price) || price <= 0 || !destination.priceUpdatedAt || Date.now() - new Date(destination.priceUpdatedAt).getTime() > 600_000) { res.status(409).json({ error: "A current price is unavailable for this payout asset. Choose a matching asset or try later." }); return; }
    const scale = 10n ** BigInt(destination.decimals);
    const [whole, fraction = ""] = bill.amount.split(".");
    const cents = BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
    const priceUnits = BigInt(Math.round(price * 1_000_000));
    const units = (cents * scale + priceUnits - 1n) / priceUnits;
    const fractionOut = (units % scale).toString().padStart(destination.decimals, "0").replace(/0+$/, "");
    payoutAmount = `${units / scale}${fractionOut ? `.${fractionOut}` : ""}`;
  }
  await db.update(payableBillsTable).set({ payoutAmount, status: "processing", failureReason: null, updatedAt: new Date() }).where(eq(payableBillsTable.id, bill.id));
  try {
    const result = await createSavedQuote({ workspaceId: bill.workspaceId, createdBy: req.trezuUserId!, idempotencyKey: `payable:${bill.id}:${randomUUID()}`, originAsset: origin.assetId, destinationAsset: destination.assetId, amount: payoutAmount, recipient: recipientAddress, refundTo: refundTo.trim(), slippageTolerance: 100, swapType: "EXACT_OUTPUT", payableBillId: bill.id });
    await db.update(payableBillsTable).set({ paymentQuoteId: result.paymentId, status: "pending_settlement", updatedAt: new Date() }).where(eq(payableBillsTable.id, bill.id));
    res.status(201).json({ ...result, payoutAmount, payoutAsset: destination });
  } catch (error) {
    await db.update(payableBillsTable).set({ status: "failed", failureReason: error instanceof Error ? error.message.slice(0, 500) : "Quote failed", updatedAt: new Date() }).where(eq(payableBillsTable.id, bill.id));
    if (error instanceof NearIntentsError) { res.status(error.statusCode).json({ error: error.message }); return; }
    res.status(503).json({ error: "NEAR Intents could not quote this bill. No funds were moved." });
  }
});

router.post("/payables/:billId/status", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const billId = routeId(req.params.billId);
  if (!uuidPattern.test(billId)) { res.status(404).json({ error: "Vendor bill not found." }); return; }
  const [bill] = await db.select().from(payableBillsTable).where(and(eq(payableBillsTable.id, billId), eq(payableBillsTable.workspaceId, req.trezuWorkspaceId!))).limit(1);
  const [quote] = bill?.paymentQuoteId ? await db.select().from(nearIntentQuotesTable).where(and(eq(nearIntentQuotesTable.id, bill.paymentQuoteId), eq(nearIntentQuotesTable.workspaceId, req.trezuWorkspaceId!))).limit(1) : [];
  if (!bill || !quote) { res.status(404).json({ error: "A prepared payment quote was not found for this bill." }); return; }
  try { res.json(await refreshSavedQuoteStatus(quote, req.trezuUserId!)); }
  catch (error) { if (error instanceof NearIntentsError) { res.status(error.statusCode).json({ error: error.message }); return; } res.status(503).json({ error: "Provider settlement status is temporarily unavailable." }); }
});

const submitPayableDeposit = async (req: import("express").Request, res: import("express").Response): Promise<void> => {
  const billId = routeId(req.params.billId);
  const { txHash } = req.body ?? {};
  if (!uuidPattern.test(billId) || typeof txHash !== "string" || !(/^(0x[0-9a-f]{64})$/i.test(txHash) || /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(txHash))) { res.status(400).json({ error: "A valid bill and wallet transaction hash are required." }); return; }
  const [bill] = await db.select().from(payableBillsTable).where(and(eq(payableBillsTable.id, billId), eq(payableBillsTable.workspaceId, req.trezuWorkspaceId!))).limit(1);
  const [quote] = bill?.paymentQuoteId ? await db.select().from(nearIntentQuotesTable).where(and(eq(nearIntentQuotesTable.id, bill.paymentQuoteId), eq(nearIntentQuotesTable.workspaceId, bill.workspaceId))).limit(1) : [];
  const details = quote?.quotePayload?.quote;
  const depositAddress = details && typeof details === "object" ? (details as Record<string, unknown>).depositAddress : null;
  if (!quote || typeof depositAddress !== "string") { res.status(404).json({ error: "The bill deposit route was not found." }); return; }
  const [updated] = await db.update(payableBillsTable).set({ depositTxHash: txHash, updatedAt: new Date() }).where(and(eq(payableBillsTable.id, bill!.id), eq(payableBillsTable.workspaceId, bill!.workspaceId), isNull(payableBillsTable.depositTxHash))).returning({ id: payableBillsTable.id });
  if (!updated) { res.status(409).json({ error: "The bill has already received a wallet submission. Check settlement before retrying." }); return; }
  try { res.json(await submitDeposit(depositAddress, txHash)); }
  catch (error) { if (error instanceof NearIntentsError) { res.status(error.statusCode).json({ error: error.message }); return; } res.status(503).json({ error: "The wallet transfer was submitted; provider notification will retry through status checks." }); }
};

router.post("/payables/:billId/deposit-submitted", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), submitPayableDeposit);
router.post("/payables/:billId/near-deposit-submitted", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), submitPayableDeposit);

export default router;
