import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import type { Request } from "express";
import { auditLogsTable, db, payableBillsTable, payableIntakeLinksTable, workspacesTable } from "@workspace/db";
import { getSupportedAssets } from "../../lib/near-intents";

const router: IRouter = Router();
const requestsByAddress = new Map<string, { start: number; count: number }>();
const tokenPattern = /^[A-Za-z0-9_-]{40,60}$/;

function limited(req: Request): boolean {
  const now = Date.now();
  const address = req.ip || "unknown";
  const key = createHash("sha256").update(address).digest("hex");
  const current = requestsByAddress.get(key);
  if (!current || now - current.start >= 60 * 60_000) { requestsByAddress.set(key, { start: now, count: 1 }); return false; }
  current.count += 1;
  return current.count > 20;
}

async function intake(token: string) {
  if (!tokenPattern.test(token)) return null;
  const [link] = await db.select({ link: payableIntakeLinksTable, workspaceName: workspacesTable.name })
    .from(payableIntakeLinksTable).innerJoin(workspacesTable, eq(payableIntakeLinksTable.workspaceId, workspacesTable.id))
    .where(and(eq(payableIntakeLinksTable.token, token), eq(payableIntakeLinksTable.active, true))).limit(1);
  return link || null;
}

router.get("/public/payable-intake/:token", async (req, res): Promise<void> => {
  const result = await intake(req.params.token);
  if (!result) { res.status(404).json({ error: "This invoice submission link is unavailable." }); return; }
  res.setHeader("Cache-Control", "no-store");
  res.json({ businessName: result.workspaceName });
});

router.get("/public/payable-intake/:token/assets", async (req, res): Promise<void> => {
  if (!await intake(req.params.token)) { res.status(404).json({ error: "This invoice submission link is unavailable." }); return; }
  try { res.json({ assets: await getSupportedAssets() }); }
  catch { res.status(503).json({ error: "Payout assets could not be loaded. You can submit the bill details without choosing a wallet yet." }); }
});

router.post("/public/payable-intake/:token", async (req, res): Promise<void> => {
  if (limited(req)) { res.status(429).json({ error: "Too many invoice submissions. Please try again later." }); return; }
  const result = await intake(req.params.token);
  if (!result) { res.status(404).json({ error: "This invoice submission link is unavailable." }); return; }
  const body = req.body ?? {};
  const textFields = [body.billNumber, body.vendorName, body.vendorEmail, body.description, body.currency];
  if (textFields.some((value) => typeof value !== "string" || !value.trim()) || body.billNumber.length > 100 || body.vendorName.length > 160 || body.vendorEmail.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.vendorEmail) || body.description.length > 1000 || body.currency.length > 12 || typeof body.amount !== "string" || !/^[0-9]+(?:\.[0-9]{1,6})?$/.test(body.amount) || !/[1-9]/.test(body.amount) || (body.dueDate && (typeof body.dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.dueDate)))) {
    res.status(400).json({ error: "Enter your invoice number, business contact, description, positive amount, currency and a valid optional due date." }); return;
  }
  let asset: Awaited<ReturnType<typeof getSupportedAssets>>[number] | undefined;
  if (typeof body.payoutAssetId === "string" && body.payoutAssetId) {
    try { asset = (await getSupportedAssets()).find((candidate) => candidate.assetId === body.payoutAssetId); }
    catch { res.status(503).json({ error: "The payout asset catalog is unavailable. Remove the optional wallet preference and submit the invoice for the business to review." }); return; }
    if (!asset) { res.status(400).json({ error: "Choose a payout asset currently supported by NEAR Intents, or leave it blank for the business to review." }); return; }
  }
  const recipient = typeof body.recipientAddress === "string" && body.recipientAddress.trim() ? body.recipientAddress.trim() : null;
  if (recipient && (!asset || recipient.length > 200 || (!/^[A-Za-z0-9._-]{2,64}$/.test(recipient) && !/^0x[0-9a-f]{40}$/i.test(recipient)))) {
    res.status(400).json({ error: "Choose a supported payout asset before entering a wallet address, and check the address format." }); return;
  }
  const publicStatusToken = randomBytes(32).toString("base64url");
  const now = new Date();
  try {
    const [bill] = await db.transaction(async (tx) => {
      const [created] = await tx.insert(payableBillsTable).values({
        workspaceId: result.link.workspaceId, billNumber: body.billNumber.trim(), vendorName: body.vendorName.trim(), vendorEmail: body.vendorEmail.trim().toLowerCase(),
        description: body.description.trim(), amount: body.amount, currency: body.currency.trim().toUpperCase(), dueDate: body.dueDate || null,
        payoutAssetId: asset?.assetId ?? null, payoutAssetSymbol: asset?.symbol ?? null, payoutNetwork: asset?.blockchain ?? null, recipientAddress: recipient,
        status: "submitted", publicStatusToken, submittedAt: now, createdBy: `public-vendor:${createHash("sha256").update(body.vendorEmail.trim().toLowerCase()).digest("hex").slice(0, 24)}`,
      }).returning();
      await tx.insert(auditLogsTable).values({ workspaceId: result.link.workspaceId, actorUserId: "public:vendor-invoice-submission", action: "payable.vendor_invoice_submitted", entityType: "payable_bill", entityId: created!.id, metadata: { billNumber: created!.billNumber, currency: created!.currency, payoutPreferenceProvided: Boolean(asset && recipient) } });
      return [created!];
    });
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json({ billNumber: bill!.billNumber, receiptToken: publicStatusToken, status: bill!.status });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "23505") { res.status(409).json({ error: "That invoice number has already been submitted to this business." }); return; }
    res.status(503).json({ error: "The invoice could not be submitted. No payment was initiated." });
  }
});

router.get("/public/payable-submissions/:receiptToken", async (req, res): Promise<void> => {
  if (!tokenPattern.test(req.params.receiptToken)) { res.status(404).json({ error: "Submission receipt not found." }); return; }
  const [bill] = await db.select({ billNumber: payableBillsTable.billNumber, vendorName: payableBillsTable.vendorName, status: payableBillsTable.status, updatedAt: payableBillsTable.updatedAt })
    .from(payableBillsTable).where(eq(payableBillsTable.publicStatusToken, req.params.receiptToken)).limit(1);
  if (!bill) { res.status(404).json({ error: "Submission receipt not found." }); return; }
  res.setHeader("Cache-Control", "no-store");
  res.json({ billNumber: bill.billNumber, vendorName: bill.vendorName, status: bill.status, updatedAt: bill.updatedAt });
});

export default router;
