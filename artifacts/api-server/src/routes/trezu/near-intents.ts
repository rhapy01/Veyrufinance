import { and, desc, eq } from "drizzle-orm";
import { Router, type IRouter, type Response } from "express";
import { db, nearIntentQuotesTable } from "@workspace/db";
import { requireWorkspaceMember, requireWorkspaceRole } from "../../middlewares/auth";
import { getSupportedAssets, NearIntentsError, submitDeposit } from "../../lib/near-intents";
import { createSavedQuote, refreshSavedQuoteStatus } from "../../lib/near-intent-workflows";

const router: IRouter = Router();
const assetId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;
const address = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 200;

function sendIntegrationError(error: unknown, res: Response) {
  if (error instanceof NearIntentsError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  res.status(503).json({ error: "NEAR Intents is temporarily unavailable. Try again shortly." });
}

router.get("/integrations/near-intents/assets", requireWorkspaceMember, async (_req, res) => {
  try {
    const assets = await getSupportedAssets();
    res.setHeader("Cache-Control", "private, max-age=30");
    res.json({ assets, feeSchedule: process.env.NEAR_INTENTS_JWT ? "authenticated" : "unauthenticated" });
  } catch (error) {
    sendIntegrationError(error, res);
  }
});

router.post("/integrations/near-intents/quotes", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res) => {
  const { originAsset, destinationAsset, amount, recipient, refundTo, slippageTolerance = 100, swapType = "EXACT_INPUT" } = req.body ?? {};
  const idempotencyKey = req.get("Idempotency-Key");
  if (!assetId(originAsset) || !assetId(destinationAsset) || !address(recipient) || !address(refundTo) ||
      typeof amount !== "string" || !Number.isInteger(slippageTolerance) || slippageTolerance < 1 || slippageTolerance > 5000 ||
      !["EXACT_INPUT", "EXACT_OUTPUT"].includes(swapType) ||
      !idempotencyKey || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    res.status(400).json({ error: "Provide supported assets, a decimal amount, destination and refund addresses, slippage from 1 to 5000 basis points, and a valid Idempotency-Key header." });
    return;
  }

  try {
    res.status(201).json(await createSavedQuote({
      workspaceId: req.trezuWorkspaceId!,
      createdBy: req.trezuUserId!,
      idempotencyKey,
      originAsset,
      destinationAsset,
      amount,
      recipient: recipient.trim(),
      refundTo: refundTo.trim(),
      slippageTolerance,
      swapType: swapType as "EXACT_INPUT" | "EXACT_OUTPUT",
    }));
  } catch (error) {
    sendIntegrationError(error, res);
  }
});

router.get("/integrations/near-intents/payments", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res) => {
  const rows = await db.select().from(nearIntentQuotesTable)
    .where(eq(nearIntentQuotesTable.workspaceId, req.trezuWorkspaceId!))
    .orderBy(desc(nearIntentQuotesTable.createdAt)).limit(50);
  res.json(rows.map((row) => ({
    paymentId: row.id,
    originAsset: row.originAsset,
    destinationAsset: row.destinationAsset,
    destinationAssetSymbol: row.destinationAssetSymbol,
    providerStatus: row.providerStatus,
    providerReference: row.providerReference,
    quotePayload: row.quotePayload,
    createdAt: row.createdAt,
    statusCheckedAt: row.statusCheckedAt,
  })));
});

router.get("/integrations/near-intents/status", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res) => {
  const paymentId = req.query.paymentId;
  if (typeof paymentId !== "string" || !/^[0-9a-f-]{36}$/i.test(paymentId)) {
    res.status(400).json({ error: "A Trezu payment reference is required." });
    return;
  }
  const [payment] = await db.select().from(nearIntentQuotesTable).where(and(
    eq(nearIntentQuotesTable.id, paymentId),
    eq(nearIntentQuotesTable.workspaceId, req.trezuWorkspaceId!),
  )).limit(1);
  if (!payment) { res.status(404).json({ error: "Payment record not found." }); return; }
  if (!payment.providerReference) { res.status(409).json({ error: "This quote has no provider deposit address." }); return; }
  try {
    res.json(await refreshSavedQuoteStatus(payment, req.trezuUserId!));
  } catch (error) {
    sendIntegrationError(error, res);
  }
});

router.post("/integrations/near-intents/deposit-submitted", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res) => {
  const { paymentId, txHash } = req.body ?? {};
  if (typeof paymentId !== "string" || !/^[0-9a-f-]{36}$/i.test(paymentId) || typeof txHash !== "string" || !/^0x[0-9a-f]{64}$/i.test(txHash)) {
    res.status(400).json({ error: "A saved payment reference and valid EVM transaction hash are required." }); return;
  }
  const [payment] = await db.select().from(nearIntentQuotesTable).where(and(eq(nearIntentQuotesTable.id, paymentId), eq(nearIntentQuotesTable.workspaceId, req.trezuWorkspaceId!))).limit(1);
  if (!payment) { res.status(404).json({ error: "Payment record not found." }); return; }
  const payload = payment.quotePayload as { quote?: { depositAddress?: unknown } } | null;
  const depositAddress = payload?.quote?.depositAddress;
  if (typeof depositAddress !== "string" || !/^0x[0-9a-f]{40}$/i.test(depositAddress)) { res.status(409).json({ error: "This payment does not have a supported EVM deposit address." }); return; }
  try { res.json(await submitDeposit(depositAddress, txHash)); } catch (error) { sendIntegrationError(error, res); }
});

router.post("/integrations/near-intents/near-deposit-submitted", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res) => {
  const { paymentId, txHash } = req.body ?? {};
  if (typeof paymentId !== "string" || !/^[0-9a-f-]{36}$/i.test(paymentId) || typeof txHash !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(txHash)) {
    res.status(400).json({ error: "A saved payment reference and valid NEAR transaction hash are required." }); return;
  }
  const [payment] = await db.select().from(nearIntentQuotesTable).where(and(eq(nearIntentQuotesTable.id, paymentId), eq(nearIntentQuotesTable.workspaceId, req.trezuWorkspaceId!))).limit(1);
  const payload = payment?.quotePayload as { quote?: { depositAddress?: unknown } } | null;
  const depositAddress = payload?.quote?.depositAddress;
  if (!payment || payment.originAssetNetwork?.toLowerCase() !== "near" || typeof depositAddress !== "string" || !/^[a-z0-9._-]{2,64}$/.test(depositAddress)) { res.status(409).json({ error: "This payment is not a NEAR deposit route." }); return; }
  try { res.json(await submitDeposit(depositAddress, txHash)); } catch (error) { sendIntegrationError(error, res); }
});

export default router;
