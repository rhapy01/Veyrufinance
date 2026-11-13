import { and, desc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { SignJWT } from "jose";
import { auditLogsTable, db, employeesTable, nearIntentQuotesTable, payrollCyclesTable, payrollItemsTable, workspacesTable } from "@workspace/db";
import { UpdateEmployeeResponse } from "@workspace/api-zod";
import {
  requireWorkspaceMember,
  requireWorkspaceRole,
  requireLinkedEmployee,
} from "../../middlewares/auth";
import { isPositiveMoney } from "../../lib/money";
import { getJwtSecret } from "../../lib/auth-tokens";
import { getSupportedAssets, NearIntentsError, submitDeposit, toBaseUnits, type NearIntentAsset } from "../../lib/near-intents";
import { createSavedQuote, refreshSavedQuoteStatus } from "../../lib/near-intent-workflows";
import { createReceiptPdf, type ReceiptLine } from "../../lib/receipt-pdf";
import { sendEmployeeInvitationEmail, emailDeliveryConfigured } from "../../lib/auth-email";

const router: IRouter = Router();

router.post("/employees/:employeeId/invitation", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const employeeId = Array.isArray(req.params.employeeId) ? req.params.employeeId[0] || "" : req.params.employeeId;
  if (!/^[0-9a-f-]{36}$/i.test(employeeId)) { res.status(404).json({ error: "Employee not found." }); return; }
  const [employee] = await db.select().from(employeesTable)
    .where(and(eq(employeesTable.id, employeeId), eq(employeesTable.workspaceId, req.trezuWorkspaceId!), eq(employeesTable.active, true))).limit(1);
  if (!employee) { res.status(404).json({ error: "Active employee not found." }); return; }
  if (employee.userId) { res.status(409).json({ error: "This employee already has a linked Trezu account." }); return; }
  if (!emailDeliveryConfigured()) { res.status(503).json({ error: "Team invitations need the Google SMTP email settings to be configured." }); return; }
  try {
    const token = await new SignJWT({ email: employee.email, workspaceId: employee.workspaceId, purpose: "employee-invitation" })
      .setProtectedHeader({ alg: "HS256" }).setIssuer("trezu").setAudience("trezu-employee-invitation")
      .setSubject(employee.id).setIssuedAt().setExpirationTime("7d").sign(getJwtSecret());
    const [workspace] = await db.select({ name: workspacesTable.name }).from(workspacesTable).where(eq(workspacesTable.id, employee.workspaceId)).limit(1);
    const webUrl = (process.env.WEB_APP_URL || "http://localhost:5173").replace(/\/$/, "");
    const invitationPath = `/employee-invite/${token}`;
    const sent = await sendEmployeeInvitationEmail({ email: employee.email, employeeName: employee.name, workspaceName: workspace?.name || "Your company", invitationUrl: `${webUrl}${invitationPath}` });
    if (!sent) throw new Error("SMTP unavailable");
    await db.insert(auditLogsTable).values({ workspaceId: employee.workspaceId, actorUserId: req.trezuUserId!, action: "payroll.employee_invitation_issued", entityType: "employee", entityId: employee.id, metadata: { email: employee.email, delivery: "smtp" } });
    res.json({ invitationPath, email: employee.email, invitationSent: true, expiresInDays: 7 });
  } catch {
    res.status(503).json({ error: "Employee invitations are unavailable until the secure token key is configured." });
  }
});

router.get("/employee/me", requireLinkedEmployee, async (req, res): Promise<void> => {
  const [row] = await db.select({ employee: employeesTable, workspaceName: workspacesTable.name })
    .from(employeesTable).innerJoin(workspacesTable, eq(employeesTable.workspaceId, workspacesTable.id))
    .where(eq(employeesTable.id, req.trezuEmployeeId!)).limit(1);
  if (!row) { res.status(404).json({ error: "Employee profile not found." }); return; }
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ id: row.employee.id, name: row.employee.name, email: row.employee.email, country: row.employee.country, position: row.employee.position, compensationAmount: row.employee.compensationAmount, compensationCurrency: row.employee.compensationCurrency, payFrequency: row.employee.payFrequency, preferredStablecoin: row.employee.preferredStablecoin, preferredNetwork: row.employee.preferredNetwork, walletAddress: row.employee.walletAddress, payoutProfileCompleted: row.employee.payoutProfileCompleted, payrollEnabled: row.employee.payrollEnabled, workspaceName: row.workspaceName });
});

router.get("/employee/supported-assets", requireLinkedEmployee, async (_req, res): Promise<void> => {
  try { res.setHeader("Cache-Control", "private, max-age=30"); res.json({ assets: await getSupportedAssets() }); }
  catch (error) { if (error instanceof NearIntentsError) { res.status(error.statusCode).json({ error: error.message }); return; } res.status(503).json({ error: "The payout asset catalog is temporarily unavailable." }); }
});

router.patch("/employee/me/preferences", requireLinkedEmployee, async (req, res): Promise<void> => {
  const { assetId, walletAddress } = req.body ?? {};
  if (typeof assetId !== "string" || assetId.length > 200 || typeof walletAddress !== "string" || walletAddress.trim().length < 2 || walletAddress.trim().length > 200) {
    res.status(400).json({ error: "Choose a supported payout asset and provide your wallet address." }); return;
  }
  let assets: NearIntentAsset[];
  try { assets = await getSupportedAssets(); }
  catch { res.status(503).json({ error: "The current payout asset catalog is unavailable. Try again shortly." }); return; }
  const asset = assets.find((candidate) => candidate.assetId === assetId);
  if (!asset) { res.status(400).json({ error: "Choose an asset from the current supported payout catalog." }); return; }
  const address = walletAddress.trim();
  const chain = asset.blockchain.toLowerCase();
  const validAddress = chain === "near" ? /^[a-z0-9._-]{2,64}$/.test(address)
    : ["eth", "ethereum", "base", "op", "optimism", "arb", "arbitrum", "pol", "polygon", "bsc", "avax", "avalanche"].includes(chain) ? /^0x[0-9a-f]{40}$/i.test(address)
      : address.length >= 20;
  if (!validAddress) { res.status(400).json({ error: `The wallet address format does not match ${asset.blockchain}.` }); return; }
  const [updated] = await db.update(employeesTable).set({ preferredStablecoin: asset.symbol, preferredNetwork: asset.blockchain, walletAddress: address, payoutProfileCompleted: true })
    .where(and(eq(employeesTable.id, req.trezuEmployeeId!), eq(employeesTable.active, true))).returning({ id: employeesTable.id, preferredStablecoin: employeesTable.preferredStablecoin, preferredNetwork: employeesTable.preferredNetwork, walletAddress: employeesTable.walletAddress });
  if (!updated) { res.status(404).json({ error: "Employee profile not found." }); return; }
  await db.insert(auditLogsTable).values({ workspaceId: req.trezuWorkspaceId!, actorUserId: req.trezuUserId!, action: "payroll.employee_payment_preferences_updated", entityType: "employee", entityId: updated.id, metadata: { preferredStablecoin: updated.preferredStablecoin, preferredNetwork: updated.preferredNetwork } });
  res.json({ ...updated, payoutProfileCompleted: true });
});

router.get("/employee/payments", requireLinkedEmployee, async (req, res): Promise<void> => {
  const rows = await db.select({ item: payrollItemsTable, cycle: payrollCyclesTable })
    .from(payrollItemsTable).innerJoin(payrollCyclesTable, eq(payrollItemsTable.cycleId, payrollCyclesTable.id))
    .where(and(eq(payrollItemsTable.employeeId, req.trezuEmployeeId!), eq(payrollItemsTable.workspaceId, req.trezuWorkspaceId!)))
    .orderBy(desc(payrollCyclesTable.periodEnd));
  res.setHeader("Cache-Control", "private, no-store");
  res.json(rows.map(({ item, cycle }) => ({ id: item.id, amount: item.amount, currency: item.currency, payoutAmount: item.payoutAmount, stablecoin: item.stablecoin, network: item.network, status: item.status, failureReason: item.failureReason, providerReference: item.providerReference, periodStart: cycle.periodStart, periodEnd: cycle.periodEnd, paymentDate: cycle.paymentDate })));
});

router.get("/employee/payments/:itemId/payslip", requireLinkedEmployee, async (req, res): Promise<void> => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.itemId)) { res.status(404).json({ error: "Payslip not found." }); return; }
  const [row] = await db.select({ item: payrollItemsTable, employee: employeesTable, cycle: payrollCyclesTable, workspace: workspacesTable, quote: nearIntentQuotesTable })
    .from(payrollItemsTable)
    .innerJoin(employeesTable, eq(payrollItemsTable.employeeId, employeesTable.id))
    .innerJoin(payrollCyclesTable, eq(payrollItemsTable.cycleId, payrollCyclesTable.id))
    .innerJoin(workspacesTable, eq(payrollItemsTable.workspaceId, workspacesTable.id))
    .innerJoin(nearIntentQuotesTable, and(eq(payrollItemsTable.paymentQuoteId, nearIntentQuotesTable.id), eq(nearIntentQuotesTable.workspaceId, req.trezuWorkspaceId!)))
    .where(and(eq(payrollItemsTable.id, req.params.itemId), eq(payrollItemsTable.employeeId, req.trezuEmployeeId!), eq(payrollItemsTable.workspaceId, req.trezuWorkspaceId!), eq(payrollItemsTable.status, "paid"), eq(nearIntentQuotesTable.reconciliationStatus, "matched_payroll")))
    .limit(1);
  if (!row) { res.status(404).json({ error: "A payslip is available after provider settlement is confirmed." }); return; }
  const quote = row.quote.quotePayload?.quote && typeof row.quote.quotePayload.quote === "object" ? row.quote.quotePayload.quote as Record<string, unknown> : {};
  const lines: ReceiptLine[] = [
    { label: "Company", value: row.workspace.name },
    { label: "Employee", value: `${row.employee.name} · ${row.employee.email}` },
    { label: "Position and country", value: `${row.employee.position} · ${row.employee.country}` },
    { label: "Payroll period", value: `${row.cycle.periodStart} to ${row.cycle.periodEnd}` },
    { label: "Gross salary", value: `${row.item.currency} ${row.item.amount}` },
    { label: "Deductions", value: "None recorded in Trezu for this pay run" },
    { label: "Net payment", value: `${row.item.payoutAmount ?? String(quote.amountOutFormatted ?? row.item.amount)} ${row.item.stablecoin}` },
    { label: "Payment network", value: row.item.network },
    { label: "Settlement date (UTC)", value: (row.quote.settledAt ?? row.quote.createdAt).toISOString().replace("T", " ").replace(".000Z", " UTC") },
    { label: "Provider transaction reference", value: row.item.providerReference ?? "Provider confirmed settlement without a transaction reference" },
  ];
  const pdf = createReceiptPdf({ title: "Employee payslip", subtitle: `${row.cycle.paymentDate} · ${row.cycle.frequency.toUpperCase()} PAY RUN`, lines, footer: "Generated from provider-confirmed payroll settlement. Deductions are only shown when recorded in Trezu." });
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="trezu-payslip-${row.employee.id}-${row.cycle.periodEnd}.pdf"`);
  res.setHeader("Content-Length", String(pdf.length));
  res.send(pdf);
});

function payrollUnits(amount: string): bigint {
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
}

function payrollAmount(units: bigint): string {
  const whole = units / 1_000_000n;
  const fraction = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function payoutFor(item: typeof payrollItemsTable.$inferSelect, asset: NearIntentAsset): { amount: string; usdPrice: string | null } {
  if (item.currency.toUpperCase() === asset.symbol.toUpperCase()) return { amount: item.amount, usdPrice: asset.price == null ? null : String(asset.price) };
  if (item.currency.toUpperCase() !== "USD" || typeof asset.price !== "number" || !Number.isFinite(asset.price) || asset.price <= 0 || !asset.priceUpdatedAt) {
    throw new NearIntentsError("This salary currency cannot be converted from a current NEAR Intents price. Use USD or the selected token's own currency.", 409);
  }
  const priceDate = new Date(asset.priceUpdatedAt);
  if (Number.isNaN(priceDate.getTime()) || Date.now() - priceDate.getTime() > 10 * 60_000 || priceDate.getTime() > Date.now() + 30_000) {
    throw new NearIntentsError("The supported asset catalog does not have a current USD price for this payout asset.", 409);
  }
  const priceText = String(asset.price);
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(priceText)) throw new NearIntentsError("The provider returned an unusable USD price for this payout asset.", 502);
  const [priceWhole, priceFraction = ""] = priceText.split(".");
  const priceDecimals = priceFraction.length;
  const priceUnits = BigInt(priceWhole) * 10n ** BigInt(priceDecimals) + BigInt(priceFraction || "0");
  if (priceUnits <= 0n) throw new NearIntentsError("The provider returned an unusable USD price for this payout asset.", 502);
  const salaryUsdUnits = payrollUnits(item.amount);
  const denominator = 1_000_000n * priceUnits;
  const numerator = salaryUsdUnits * 10n ** BigInt(priceDecimals) * 10n ** BigInt(asset.decimals);
  const payoutUnits = (numerator + denominator - 1n) / denominator;
  const scale = 10n ** BigInt(asset.decimals);
  const fraction = (payoutUnits % scale).toString().padStart(asset.decimals, "0").replace(/0+$/, "");
  const amount = `${payoutUnits / scale}${fraction ? `.${fraction}` : ""}`;
  if (!toBaseUnits(amount, asset.decimals)) throw new NearIntentsError("The calculated payout exceeds the asset precision supported by NEAR Intents.", 409);
  return { amount, usdPrice: priceText };
}

router.get("/payroll/cycles", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const cycles = await db.select().from(payrollCyclesTable)
    .where(eq(payrollCyclesTable.workspaceId, req.trezuWorkspaceId!))
    .orderBy(desc(payrollCyclesTable.createdAt));
  const result = await Promise.all(cycles.map(async (cycle) => {
    const items = await db.select({ item: payrollItemsTable, employeeName: employeesTable.name, employeeEmail: employeesTable.email })
      .from(payrollItemsTable).innerJoin(employeesTable, eq(payrollItemsTable.employeeId, employeesTable.id))
      .where(eq(payrollItemsTable.cycleId, cycle.id)).orderBy(employeesTable.name);
    const totals = new Map<string, bigint>();
    for (const { item } of items) totals.set(item.currency, (totals.get(item.currency) ?? 0n) + payrollUnits(item.amount));
    const details = await Promise.all(items.map(async ({ item, employeeName, employeeEmail }) => {
      const [quote] = item.paymentQuoteId ? await db.select({ id: nearIntentQuotesTable.id, providerStatus: nearIntentQuotesTable.providerStatus, reconciliationStatus: nearIntentQuotesTable.reconciliationStatus, quotePayload: nearIntentQuotesTable.quotePayload, statusCheckedAt: nearIntentQuotesTable.statusCheckedAt, originAssetSymbol: nearIntentQuotesTable.originAssetSymbol, originAssetNetwork: nearIntentQuotesTable.originAssetNetwork }).from(nearIntentQuotesTable).where(and(eq(nearIntentQuotesTable.id, item.paymentQuoteId), eq(nearIntentQuotesTable.workspaceId, item.workspaceId))).limit(1) : [];
      return { ...item, employeeName, employeeEmail, paymentQuote: quote ? { paymentId: quote.id, providerStatus: quote.providerStatus, reconciliationStatus: quote.reconciliationStatus, quote: quote.quotePayload, statusCheckedAt: quote.statusCheckedAt, originAssetSymbol: quote.originAssetSymbol, originAssetNetwork: quote.originAssetNetwork } : null };
    }));
    return { ...cycle, items: details, totals: Object.fromEntries([...totals].map(([currency, units]) => [currency, payrollAmount(units)])) };
  }));
  res.setHeader("Cache-Control", "private, no-store");
  res.json(result);
});

router.post("/payroll/items/:itemId/quote", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.itemId)) { res.status(404).json({ error: "Payroll item not found." }); return; }
  const { originAsset, refundTo } = req.body ?? {};
  const requestKey = req.get("Idempotency-Key");
  if (typeof originAsset !== "string" || originAsset.length > 200 || typeof refundTo !== "string" || !refundTo.trim() || refundTo.length > 200 || !requestKey || !/^[A-Za-z0-9._:-]{8,128}$/.test(requestKey)) {
    res.status(400).json({ error: "Choose a supported source asset, provide the business refund address, and include an idempotency key." }); return;
  }
  let assets: NearIntentAsset[];
  try { assets = await getSupportedAssets(); }
  catch { res.status(503).json({ error: "The supported payout asset catalog is temporarily unavailable." }); return; }
  const prepared = await db.transaction(async (tx) => {
    const [item] = await tx.select().from(payrollItemsTable).where(and(eq(payrollItemsTable.id, req.params.itemId), eq(payrollItemsTable.workspaceId, req.trezuWorkspaceId!))).for("update").limit(1);
    if (!item) return { error: "not_found" as const };
    const [cycle] = await tx.select().from(payrollCyclesTable).where(and(eq(payrollCyclesTable.id, item.cycleId), eq(payrollCyclesTable.workspaceId, item.workspaceId))).for("update").limit(1);
    if (!cycle) return { error: "cycle_not_found" as const };
    if (cycle.status === "draft") return { error: "cycle_not_approved" as const };
    if (cycle.status === "completed") return { error: "cycle_completed" as const };
    if (item.status === "paid") return { error: "already_paid" as const };
    const [currentQuote] = item.paymentQuoteId ? await tx.select().from(nearIntentQuotesTable).where(and(eq(nearIntentQuotesTable.id, item.paymentQuoteId), eq(nearIntentQuotesTable.workspaceId, item.workspaceId))).for("update").limit(1) : [];
    if (item.status === "processing" && !currentQuote) return { error: "payment_preparing" as const };
    if (currentQuote && !["FAILED", "REFUNDED", "QUOTE_FAILED"].includes(currentQuote.providerStatus)) return { currentQuote, item, cycle };
    const destination = assets.find((asset) => asset.symbol.toUpperCase() === item.stablecoin.toUpperCase() && asset.blockchain.toLowerCase() === item.network.toLowerCase());
    if (!destination) return { error: "destination_unsupported" as const };
    if (!item.walletAddress?.trim()) return { error: "wallet_missing" as const };
    let payout: { amount: string; usdPrice: string | null };
    try { payout = payoutFor(item, destination); }
    catch (error) { return { error: "payout_currency_unsupported" as const, detail: error instanceof Error ? error.message : "This payout currency cannot be converted." }; }
    const origin = assets.find((asset) => asset.assetId === originAsset);
    if (!origin) return { error: "origin_unsupported" as const };
    if (origin.assetId === destination.assetId) return { error: "same_asset" as const };
    const attemptNumber = item.attemptNumber + 1;
    const [updated] = await tx.update(payrollItemsTable).set({ attemptNumber, payoutAmount: payout.amount, payoutUsdPrice: payout.usdPrice, status: "processing", failureReason: null, paymentQuoteId: null, updatedAt: new Date() }).where(eq(payrollItemsTable.id, item.id)).returning();
    await tx.update(payrollCyclesTable).set({ status: "processing" }).where(eq(payrollCyclesTable.id, cycle.id));
    return { item: updated!, cycle, destination, origin, payout, attemptNumber };
  });
  if ("error" in prepared) {
    const messages: Record<string, string> = {
      not_found: "Payroll item not found.", cycle_not_found: "Payroll cycle not found.", cycle_not_approved: "Approve this payroll cycle before preparing payment quotes.", cycle_completed: "This payroll cycle is complete.", already_paid: "This employee payment is already confirmed.", payment_preparing: "A payment quote is already being prepared for this employee.", destination_unsupported: "The employee's selected stablecoin and network are not currently supported by NEAR Intents.", wallet_missing: "Add the employee's wallet address before preparing a payout.", origin_unsupported: "The selected source asset is no longer supported.", same_asset: "Choose a different source asset. Trezu uses NEAR Intents to convert the business's source asset into the employee's payout asset.", payout_currency_unsupported: "detail" in prepared ? prepared.detail : "This payout currency cannot be converted safely.",
    };
    res.status(prepared.error === "not_found" || prepared.error === "cycle_not_found" ? 404 : 409).json({ error: messages[prepared.error] }); return;
  }
  if ("currentQuote" in prepared) {
    res.json({ paymentId: prepared.currentQuote.id, providerStatus: prepared.currentQuote.providerStatus, quote: prepared.currentQuote.quotePayload, payoutAmount: prepared.item.payoutAmount, payoutCurrency: prepared.item.stablecoin, payoutUsdPrice: prepared.item.payoutUsdPrice, alreadyPrepared: true }); return;
  }
  const quoteIdempotencyKey = `payroll:${prepared.item.id}:${prepared.attemptNumber}:${requestKey}`;
  try {
    const result = await createSavedQuote({
      workspaceId: req.trezuWorkspaceId!, createdBy: req.trezuUserId!, idempotencyKey: quoteIdempotencyKey,
      originAsset: prepared.origin.assetId, destinationAsset: prepared.destination.assetId, amount: prepared.payout.amount,
      recipient: prepared.item.walletAddress!, refundTo: refundTo.trim(), slippageTolerance: 100, swapType: "EXACT_OUTPUT", payrollItemId: prepared.item.id,
    });
    await db.transaction(async (tx) => {
      await tx.update(payrollItemsTable).set({ paymentQuoteId: result.paymentId, status: "pending_settlement", updatedAt: new Date() }).where(and(eq(payrollItemsTable.id, prepared.item.id), eq(payrollItemsTable.workspaceId, req.trezuWorkspaceId!), eq(payrollItemsTable.status, "processing")));
    });
    res.status(201).json({ ...result, payoutAmount: prepared.payout.amount, payoutCurrency: prepared.item.stablecoin, payoutUsdPrice: prepared.payout.usdPrice, destinationAsset: prepared.destination, originAsset: prepared.origin });
  } catch (error) {
    await db.transaction(async (tx) => {
      await tx.update(payrollItemsTable).set({ status: "failed", failureReason: error instanceof Error ? error.message.slice(0, 500) : "Provider quote failed", updatedAt: new Date() }).where(and(eq(payrollItemsTable.id, prepared.item.id), eq(payrollItemsTable.workspaceId, req.trezuWorkspaceId!), eq(payrollItemsTable.status, "processing")));
      await tx.insert(auditLogsTable).values({ workspaceId: req.trezuWorkspaceId!, actorUserId: req.trezuUserId!, action: "payroll.payment_quote_failed", entityType: "payroll_item", entityId: prepared.item.id, metadata: { attemptNumber: prepared.attemptNumber, reason: error instanceof Error ? error.message.slice(0, 250) : "Provider quote failed" } });
    });
    if (error instanceof NearIntentsError) { res.status(error.statusCode).json({ error: error.message }); return; }
    res.status(503).json({ error: "NEAR Intents could not prepare this payment. No payroll funds were moved." });
  }
});

router.post("/payroll/items/:itemId/status", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.itemId)) { res.status(404).json({ error: "Payroll item not found." }); return; }
  const [item] = await db.select().from(payrollItemsTable).where(and(eq(payrollItemsTable.id, req.params.itemId), eq(payrollItemsTable.workspaceId, req.trezuWorkspaceId!))).limit(1);
  if (!item) { res.status(404).json({ error: "Payroll item not found." }); return; }
  if (!item.paymentQuoteId) { res.status(409).json({ error: "Prepare a payment quote before checking settlement." }); return; }
  const [quote] = await db.select().from(nearIntentQuotesTable).where(and(eq(nearIntentQuotesTable.id, item.paymentQuoteId), eq(nearIntentQuotesTable.workspaceId, req.trezuWorkspaceId!))).limit(1);
  if (!quote) { res.status(404).json({ error: "Payroll payment quote not found." }); return; }
  try { res.json(await refreshSavedQuoteStatus(quote, req.trezuUserId!)); }
  catch (error) { if (error instanceof NearIntentsError) { res.status(error.statusCode).json({ error: error.message }); return; } res.status(503).json({ error: "Payroll settlement status is temporarily unavailable." }); }
});

router.post("/payroll/items/:itemId/deposit-submitted", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const { txHash } = req.body ?? {};
  if (!/^[0-9a-f-]{36}$/i.test(req.params.itemId) || typeof txHash !== "string" || !/^0x[0-9a-f]{64}$/i.test(txHash)) { res.status(400).json({ error: "A valid payroll item and EVM transaction hash are required." }); return; }
  const [item] = await db.select().from(payrollItemsTable).where(and(eq(payrollItemsTable.id, req.params.itemId), eq(payrollItemsTable.workspaceId, req.trezuWorkspaceId!))).limit(1);
  const [quote] = item?.paymentQuoteId ? await db.select().from(nearIntentQuotesTable).where(and(eq(nearIntentQuotesTable.id, item.paymentQuoteId), eq(nearIntentQuotesTable.workspaceId, req.trezuWorkspaceId!))).limit(1) : [];
  const depositAddress = quote?.quotePayload?.quote?.depositAddress;
  if (!quote || typeof depositAddress !== "string" || !/^0x[0-9a-f]{40}$/i.test(depositAddress)) { res.status(404).json({ error: "The payroll payment route was not found." }); return; }
  try { res.json(await submitDeposit(depositAddress, txHash)); } catch (error) { if (error instanceof NearIntentsError) { res.status(error.statusCode).json({ error: error.message }); return; } res.status(503).json({ error: "The provider notification failed. The on-chain wallet transaction remains submitted." }); }
});

router.post("/payroll/items/:itemId/near-deposit-submitted", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const { txHash } = req.body ?? {};
  if (!/^[0-9a-f-]{36}$/i.test(req.params.itemId) || typeof txHash !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(txHash)) { res.status(400).json({ error: "A valid payroll item and NEAR transaction hash are required." }); return; }
  const [item] = await db.select().from(payrollItemsTable).where(and(eq(payrollItemsTable.id, req.params.itemId), eq(payrollItemsTable.workspaceId, req.trezuWorkspaceId!))).limit(1);
  const [quote] = item?.paymentQuoteId ? await db.select().from(nearIntentQuotesTable).where(and(eq(nearIntentQuotesTable.id, item.paymentQuoteId), eq(nearIntentQuotesTable.workspaceId, req.trezuWorkspaceId!))).limit(1) : [];
  const depositAddress = quote?.quotePayload?.quote?.depositAddress;
  if (!quote || quote.originAssetNetwork?.toLowerCase() !== "near" || typeof depositAddress !== "string" || !/^[a-z0-9._-]{2,64}$/.test(depositAddress)) { res.status(409).json({ error: "This payroll item is not a NEAR deposit route." }); return; }
  try { res.json(await submitDeposit(depositAddress, txHash)); } catch (error) { if (error instanceof NearIntentsError) { res.status(error.statusCode).json({ error: error.message }); return; } res.status(503).json({ error: "The provider notification failed. NEAR Intents monitors deposits automatically." }); }
});

router.get("/payroll/items/:itemId/payslip", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.itemId)) { res.status(404).json({ error: "Payslip not found." }); return; }
  const [row] = await db.select({ item: payrollItemsTable, employee: employeesTable, cycle: payrollCyclesTable, workspace: workspacesTable, quote: nearIntentQuotesTable })
    .from(payrollItemsTable)
    .innerJoin(employeesTable, eq(payrollItemsTable.employeeId, employeesTable.id))
    .innerJoin(payrollCyclesTable, eq(payrollItemsTable.cycleId, payrollCyclesTable.id))
    .innerJoin(workspacesTable, eq(payrollItemsTable.workspaceId, workspacesTable.id))
    .innerJoin(nearIntentQuotesTable, and(eq(payrollItemsTable.paymentQuoteId, nearIntentQuotesTable.id), eq(nearIntentQuotesTable.workspaceId, req.trezuWorkspaceId!)))
    .where(and(eq(payrollItemsTable.id, req.params.itemId), eq(payrollItemsTable.workspaceId, req.trezuWorkspaceId!), eq(payrollItemsTable.status, "paid"), eq(nearIntentQuotesTable.reconciliationStatus, "matched_payroll")))
    .limit(1);
  if (!row) { res.status(404).json({ error: "A payslip is available after provider settlement is confirmed." }); return; }
  const quote = row.quote.quotePayload?.quote && typeof row.quote.quotePayload.quote === "object" ? row.quote.quotePayload.quote as Record<string, unknown> : {};
  const lines: ReceiptLine[] = [
    { label: "Company", value: row.workspace.name },
    { label: "Employee", value: `${row.employee.name} · ${row.employee.email}` },
    { label: "Position and country", value: `${row.employee.position} · ${row.employee.country}` },
    { label: "Payroll period", value: `${row.cycle.periodStart} to ${row.cycle.periodEnd}` },
    { label: "Gross salary", value: `${row.item.currency} ${row.item.amount}` },
    { label: "Deductions", value: "None recorded in Trezu for this pay run" },
    { label: "Net payment", value: `${row.item.payoutAmount ?? String(quote.amountOutFormatted ?? row.item.amount)} ${row.item.stablecoin}` },
    { label: "Payment network", value: row.item.network },
    { label: "Settlement date (UTC)", value: (row.quote.settledAt ?? row.quote.createdAt).toISOString().replace("T", " ").replace(".000Z", " UTC") },
    { label: "Provider transaction reference", value: row.item.providerReference ?? "Provider confirmed settlement without a transaction reference" },
  ];
  const pdf = createReceiptPdf({ title: "Employee payslip", subtitle: `${row.cycle.paymentDate} · ${row.cycle.frequency.toUpperCase()} PAY RUN`, lines, footer: "Generated from provider-confirmed payroll settlement. Deductions are only shown when recorded in Trezu." });
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="trezu-payslip-${row.employee.id}-${row.cycle.periodEnd}.pdf"`);
  res.setHeader("Content-Length", String(pdf.length));
  res.send(pdf);
});

router.post("/payroll/cycles/prepare", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const { frequency, periodStart, periodEnd, paymentDate, idempotencyKey } = req.body ?? {};
  if (!["weekly", "biweekly", "monthly"].includes(frequency) || typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 160 || !isCalendarDate(periodStart) || !isCalendarDate(periodEnd) || !isCalendarDate(paymentDate) || periodEnd < periodStart) {
    res.status(400).json({ error: "Provide a supported frequency, valid period dates, payment date, and an idempotency key." }); return;
  }
  const existing = await db.select().from(payrollCyclesTable).where(and(eq(payrollCyclesTable.workspaceId, req.trezuWorkspaceId!), eq(payrollCyclesTable.idempotencyKey, idempotencyKey))).limit(1);
  if (existing[0]) {
    if (existing[0].frequency !== frequency || existing[0].periodStart !== periodStart || existing[0].periodEnd !== periodEnd || existing[0].paymentDate !== paymentDate) { res.status(409).json({ error: "This idempotency key belongs to a different payroll request." }); return; }
    const items = await db.select().from(payrollItemsTable).where(eq(payrollItemsTable.cycleId, existing[0].id));
    const totals = new Map<string, bigint>();
    for (const item of items) totals.set(item.currency, (totals.get(item.currency) ?? 0n) + payrollUnits(item.amount));
    res.json({ cycle: existing[0], items, totals: Object.fromEntries([...totals].map(([currency, units]) => [currency, payrollAmount(units)])), executionStatus: "not_started", alreadyPrepared: true }); return;
  }
  const duplicatePeriod = await db.select({ id: payrollCyclesTable.id }).from(payrollCyclesTable).where(and(
    eq(payrollCyclesTable.workspaceId, req.trezuWorkspaceId!),
    eq(payrollCyclesTable.frequency, frequency),
    eq(payrollCyclesTable.periodStart, periodStart),
    eq(payrollCyclesTable.periodEnd, periodEnd),
    eq(payrollCyclesTable.paymentDate, paymentDate),
  )).limit(1);
  if (duplicatePeriod.length) { res.status(409).json({ error: "A pay run already exists for this frequency and period. Open that run to refresh, review, or discard it." }); return; }
  const employees = await db.select().from(employeesTable).where(and(eq(employeesTable.workspaceId, req.trezuWorkspaceId!), eq(employeesTable.active, true), eq(employeesTable.payrollEnabled, true), eq(employeesTable.payoutProfileCompleted, true), eq(employeesTable.payFrequency, frequency as "weekly" | "biweekly" | "monthly"))).orderBy(employeesTable.name);
  if (!employees.length) { res.status(409).json({ error: "There are no employees with this pay frequency." }); return; }
  const missingWallets = employees.filter((employee) => !employee.walletAddress?.trim());
  if (missingWallets.length) { res.status(409).json({ error: "Add wallet addresses before preparing this cycle.", employees: missingWallets.map(({ id, name, email }) => ({ id, name, email })) }); return; }
  const cycleId = crypto.randomUUID();
  const cycle = await db.transaction(async (tx) => {
    const [created] = await tx.insert(payrollCyclesTable).values({ id: cycleId, workspaceId: req.trezuWorkspaceId!, idempotencyKey, frequency, periodStart, periodEnd, paymentDate, createdBy: req.trezuUserId! }).onConflictDoNothing().returning();
    if (!created) return null;
    await tx.insert(payrollItemsTable).values(employees.map((employee) => ({ workspaceId: req.trezuWorkspaceId!, cycleId, employeeId: employee.id, idempotencyKey: `${idempotencyKey}:${employee.id}`, amount: employee.compensationAmount, currency: employee.compensationCurrency, stablecoin: employee.preferredStablecoin, network: employee.preferredNetwork, walletAddress: employee.walletAddress, status: "queued" as const })));
    await tx.insert(auditLogsTable).values({ workspaceId: req.trezuWorkspaceId!, actorUserId: req.trezuUserId!, action: "payroll.cycle_prepared", entityType: "payroll_cycle", entityId: cycleId, metadata: { frequency, periodStart, periodEnd, paymentDate, employeeCount: employees.length } });
    return created;
  });
  if (!cycle) { res.status(409).json({ error: "This payroll cycle key was already used." }); return; }
  const items = await db.select().from(payrollItemsTable).where(eq(payrollItemsTable.cycleId, cycleId));
  const totals = new Map<string, bigint>();
  for (const item of items) totals.set(item.currency, (totals.get(item.currency) ?? 0n) + payrollUnits(item.amount));
  res.status(201).json({ cycle, items, totals: Object.fromEntries([...totals].map(([currency, units]) => [currency, payrollAmount(units)])), executionStatus: "not_started" });
});

router.post("/payroll/cycles/:cycleId/refresh", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const cycleId = Array.isArray(req.params.cycleId) ? req.params.cycleId[0] || "" : req.params.cycleId;
  if (!/^[0-9a-f-]{36}$/i.test(cycleId)) { res.status(404).json({ error: "Payroll cycle not found." }); return; }
  const refreshed = await db.transaction(async (tx) => {
    const [cycle] = await tx.select().from(payrollCyclesTable).where(and(eq(payrollCyclesTable.id, cycleId), eq(payrollCyclesTable.workspaceId, req.trezuWorkspaceId!))).for("update").limit(1);
    if (!cycle) return { error: "not_found" as const };
    if (cycle.status !== "draft") return { error: "not_draft" as const };
    const existingItems = await tx.select().from(payrollItemsTable).where(and(eq(payrollItemsTable.cycleId, cycle.id), eq(payrollItemsTable.workspaceId, req.trezuWorkspaceId!)));
    if (existingItems.some((item) => item.paymentQuoteId || item.status !== "queued")) return { error: "payments_started" as const };
    const currentEmployees = await tx.select().from(employeesTable).where(and(
      eq(employeesTable.workspaceId, cycle.workspaceId), eq(employeesTable.active, true), eq(employeesTable.payrollEnabled, true),
      eq(employeesTable.payoutProfileCompleted, true), eq(employeesTable.payFrequency, cycle.frequency),
    )).orderBy(employeesTable.name);
    if (!currentEmployees.length || currentEmployees.some((person) => !person.walletAddress?.trim())) return { error: "team_not_ready" as const };
    await tx.delete(payrollItemsTable).where(and(eq(payrollItemsTable.cycleId, cycle.id), eq(payrollItemsTable.workspaceId, req.trezuWorkspaceId!)));
    await tx.insert(payrollItemsTable).values(currentEmployees.map((person) => ({
      workspaceId: cycle.workspaceId, cycleId: cycle.id, employeeId: person.id,
      idempotencyKey: `${cycle.idempotencyKey}:${person.id}`, amount: person.compensationAmount, currency: person.compensationCurrency,
      stablecoin: person.preferredStablecoin, network: person.preferredNetwork, walletAddress: person.walletAddress, status: "queued" as const,
    })));
    await tx.insert(auditLogsTable).values({ workspaceId: cycle.workspaceId, actorUserId: req.trezuUserId!, action: "payroll.draft_refreshed", entityType: "payroll_cycle", entityId: cycle.id, metadata: { employeeCount: currentEmployees.length, fundsMoved: false } });
    return { employeeCount: currentEmployees.length };
  });
  if ("error" in refreshed) {
    const error = refreshed.error === "not_found" ? "Payroll cycle not found." : refreshed.error === "not_draft" ? "Only an unapproved draft can be refreshed." : refreshed.error === "payments_started" ? "This draft already has payment activity and cannot be refreshed." : "No eligible team members with complete payout profiles match this run.";
    res.status(refreshed.error === "not_found" ? 404 : 409).json({ error }); return;
  }
  res.json({ message: `Draft refreshed from current team pay settings for ${refreshed.employeeCount} staff member${refreshed.employeeCount === 1 ? "" : "s"}. No funds moved.` });
});

router.delete("/payroll/cycles/:cycleId", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const cycleId = Array.isArray(req.params.cycleId) ? req.params.cycleId[0] || "" : req.params.cycleId;
  if (!/^[0-9a-f-]{36}$/i.test(cycleId)) { res.status(404).json({ error: "Payroll cycle not found." }); return; }
  const removed = await db.transaction(async (tx) => {
    const [cycle] = await tx.select().from(payrollCyclesTable).where(and(eq(payrollCyclesTable.id, cycleId), eq(payrollCyclesTable.workspaceId, req.trezuWorkspaceId!))).for("update").limit(1);
    if (!cycle) return { error: "not_found" as const };
    if (cycle.status !== "draft") return { error: "not_draft" as const };
    const items = await tx.select().from(payrollItemsTable).where(and(eq(payrollItemsTable.cycleId, cycle.id), eq(payrollItemsTable.workspaceId, req.trezuWorkspaceId!)));
    if (items.some((item) => item.paymentQuoteId || item.status !== "queued")) return { error: "payments_started" as const };
    await tx.insert(auditLogsTable).values({ workspaceId: cycle.workspaceId, actorUserId: req.trezuUserId!, action: "payroll.draft_discarded", entityType: "payroll_cycle", entityId: cycle.id, metadata: { employeeCount: items.length, fundsMoved: false } });
    await tx.delete(payrollItemsTable).where(and(eq(payrollItemsTable.cycleId, cycle.id), eq(payrollItemsTable.workspaceId, req.trezuWorkspaceId!)));
    await tx.delete(payrollCyclesTable).where(and(eq(payrollCyclesTable.id, cycle.id), eq(payrollCyclesTable.workspaceId, req.trezuWorkspaceId!)));
    return { success: true as const };
  });
  if ("error" in removed) {
    const error = removed.error === "not_found" ? "Payroll cycle not found." : removed.error === "not_draft" ? "Only an unapproved draft can be discarded." : "This cycle has payment activity and cannot be discarded.";
    res.status(removed.error === "not_found" ? 404 : 409).json({ error }); return;
  }
  res.json({ discarded: true, cycleId });
});

router.post("/payroll/cycles/:cycleId/approve", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.cycleId)) { res.status(400).json({ error: "Invalid payroll cycle ID" }); return; }
  const cycle = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(payrollCyclesTable).where(and(eq(payrollCyclesTable.id, req.params.cycleId), eq(payrollCyclesTable.workspaceId, req.trezuWorkspaceId!))).for("update").limit(1);
    if (!current) return { error: "not_found" as const };
    if (current.status === "approved") return { cycle: current, alreadyApproved: true };
    if (current.status !== "draft") return { error: "not_draft" as const };
    const [updated] = await tx.update(payrollCyclesTable).set({ status: "approved", approvedBy: req.trezuUserId!, approvedAt: new Date() }).where(eq(payrollCyclesTable.id, current.id)).returning();
    await tx.insert(auditLogsTable).values({ workspaceId: req.trezuWorkspaceId!, actorUserId: req.trezuUserId!, action: "payroll.cycle_approved", entityType: "payroll_cycle", entityId: current.id, metadata: { employeePaymentsQueued: true, fundsMoved: false } });
    return { cycle: updated, alreadyApproved: false };
  });
  if ("error" in cycle) { res.status(cycle.error === "not_found" ? 404 : 409).json({ error: cycle.error === "not_found" ? "Payroll cycle not found" : "Only a draft payroll cycle can be approved" }); return; }
  res.json({ ...cycle, paymentStatus: "queued", executionStatus: "awaiting_business_deposit", message: "Payroll approved. Prepare signed payout quotes for each employee, then send each quoted deposit from the business wallet. Approval itself moved no funds." });
});

router.get(
  "/employees",
  requireWorkspaceMember,
  requireWorkspaceRole("owner", "admin"),
  async (req, res): Promise<void> => {
    const employees = await db
      .select()
      .from(employeesTable)
      .where(and(eq(employeesTable.workspaceId, req.trezuWorkspaceId!), eq(employeesTable.active, true)))
      .orderBy(desc(employeesTable.createdAt));
    res.json(employees);
  },
);

router.post("/employees/invitations", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!name || name.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { res.status(400).json({ error: "Enter the team member’s name and email address." }); return; }
  const [existing] = await db.select().from(employeesTable).where(and(eq(employeesTable.workspaceId, req.trezuWorkspaceId!), eq(employeesTable.email, email), eq(employeesTable.active, true))).limit(1);
  if (existing) { res.status(409).json({ error: "This email is already on the team. Open the existing profile to check its invitation or payroll status." }); return; }
  if (!emailDeliveryConfigured()) { res.status(503).json({ error: "Team invitations need the Google SMTP email settings to be configured." }); return; }
  const [employee] = await db.insert(employeesTable).values({
    workspaceId: req.trezuWorkspaceId!, name, email, country: "", position: "",
    compensationAmount: "0", compensationCurrency: "USD", payFrequency: "monthly",
    preferredStablecoin: "USDC", preferredNetwork: "near", walletAddress: null,
    payrollEnabled: false, payoutProfileCompleted: false, createdBy: req.trezuUserId!,
  }).returning();
  const [workspace] = await db.select({ name: workspacesTable.name }).from(workspacesTable).where(eq(workspacesTable.id, req.trezuWorkspaceId!)).limit(1);
  try {
    const token = await new SignJWT({ email, workspaceId: employee!.workspaceId, purpose: "employee-invitation" }).setProtectedHeader({ alg: "HS256" }).setIssuer("trezu").setAudience("trezu-employee-invitation").setSubject(employee!.id).setIssuedAt().setExpirationTime("7d").sign(getJwtSecret());
    const webUrl = (process.env.WEB_APP_URL || "http://localhost:5173").replace(/\/$/, "");
    const invitationUrl = `${webUrl}/employee-invite/${token}`;
    const sent = await sendEmployeeInvitationEmail({ email, employeeName: name, workspaceName: workspace?.name || "Your company", invitationUrl });
    if (!sent) throw new Error("SMTP unavailable");
    await db.insert(auditLogsTable).values({ workspaceId: req.trezuWorkspaceId!, actorUserId: req.trezuUserId!, action: "team.member_invited", entityType: "employee", entityId: employee!.id, metadata: { email, payrollEnabled: false, delivery: "smtp" } });
    res.status(201).json({ ...employee, invitationSent: true });
  } catch {
    await db.update(employeesTable).set({ active: false }).where(eq(employeesTable.id, employee!.id));
    res.status(503).json({ error: "The invitation could not be emailed. Check Google SMTP settings and try again." });
  }
});

router.post(
  "/employees",
  requireWorkspaceMember,
  requireWorkspaceRole("owner", "admin"),
  async (req, res): Promise<void> => {
    const employeeId = typeof req.body?.employeeId === "string" ? req.body.employeeId : "";
    const compensationAmount = typeof req.body?.compensationAmount === "string" ? req.body.compensationAmount.trim() : "";
    const compensationCurrency = typeof req.body?.compensationCurrency === "string" ? req.body.compensationCurrency.trim().toUpperCase() : "";
    const payFrequency = req.body?.payFrequency;
    if (!/^[0-9a-f-]{36}$/i.test(employeeId) || !/^[A-Z]{3}$/.test(compensationCurrency) || typeof payFrequency !== "string" || !["weekly", "biweekly", "monthly"].includes(payFrequency)) {
      res.status(400).json({ error: "Enter the employee, pay amount, three-letter currency, and pay frequency." }); return;
    }
    if (!isPositiveMoney(compensationAmount)) {
      res.status(400).json({ error: "Compensation must be greater than zero" });
      return;
    }

    const employee = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(employeesTable).where(and(eq(employeesTable.workspaceId, req.trezuWorkspaceId!), eq(employeesTable.id, employeeId), eq(employeesTable.active, true))).for("update").limit(1);
      if (!current) return { error: "not_invited" as const };
      if (!current.userId || !current.payoutProfileCompleted || !current.walletAddress?.trim()) return { error: "profile_incomplete" as const };
      const [updated] = await tx.update(employeesTable).set({
        compensationAmount,
        compensationCurrency,
        payFrequency: payFrequency as "weekly" | "biweekly" | "monthly",
        payrollEnabled: true,
      }).where(eq(employeesTable.id, current.id)).returning();
      await tx.insert(auditLogsTable).values({
        workspaceId: req.trezuWorkspaceId!,
        actorUserId: req.trezuUserId!,
        action: "payroll.employee_enrolled",
        entityType: "employee",
        entityId: current.id,
        metadata: { email: current.email, payFrequency },
      });
      return { employee: updated! };
    });

    if ("error" in employee) {
      res.status(409).json({ error: employee.error === "not_invited" ? "Invite this person and have them complete their Trezu payout profile before adding them to payroll." : "This team member must sign in and save their payout asset and wallet before payroll can include them." });
      return;
    }

    res.status(200).json(employee.employee);
  },
);

router.patch("/employees/:employeeId", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const employeeId = Array.isArray(req.params.employeeId) ? req.params.employeeId[0] || "" : req.params.employeeId;
  if (!/^[0-9a-f-]{36}$/i.test(employeeId)) { res.status(404).json({ error: "Employee not found" }); return; }
  const compensationAmount = typeof req.body?.compensationAmount === "string" ? req.body.compensationAmount.trim() : "";
  const compensationCurrency = typeof req.body?.compensationCurrency === "string" ? req.body.compensationCurrency.trim().toUpperCase() : "";
  const payFrequency = req.body?.payFrequency;
  if (!/^[A-Z]{3}$/.test(compensationCurrency) || typeof payFrequency !== "string" || !["weekly", "biweekly", "monthly"].includes(payFrequency)) { res.status(400).json({ error: "Enter a three-letter currency and pay frequency." }); return; }
  if (!isPositiveMoney(compensationAmount)) { res.status(400).json({ error: "Compensation must be greater than zero" }); return; }
  const updated = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(employeesTable).where(and(eq(employeesTable.id, employeeId), eq(employeesTable.workspaceId, req.trezuWorkspaceId!))).for("update").limit(1);
    if (!current || !current.payrollEnabled || !current.userId || !current.payoutProfileCompleted) return null;
    const [employee] = await tx.update(employeesTable).set({
      compensationAmount, compensationCurrency, payFrequency: payFrequency as "weekly" | "biweekly" | "monthly",
    }).where(and(eq(employeesTable.id, employeeId), eq(employeesTable.workspaceId, req.trezuWorkspaceId!))).returning();
    if (!employee) return null;
    await tx.insert(auditLogsTable).values({ workspaceId: req.trezuWorkspaceId!, actorUserId: req.trezuUserId!, action: "payroll.employee_profile_updated", entityType: "employee", entityId: employee.id, metadata: { payFrequency: employee.payFrequency } });
    return employee;
  });
  if (!updated) { res.status(404).json({ error: "Employee not found" }); return; }
  res.json(UpdateEmployeeResponse.parse(updated));
});

router.delete("/employees/:employeeId", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const employeeId = Array.isArray(req.params.employeeId) ? req.params.employeeId[0] || "" : req.params.employeeId;
  if (!/^[0-9a-f-]{36}$/i.test(employeeId)) { res.status(404).json({ error: "Employee not found" }); return; }
  const removed = await db.transaction(async (tx) => {
    const [employee] = await tx.update(employeesTable).set({ active: false }).where(and(eq(employeesTable.id, employeeId), eq(employeesTable.workspaceId, req.trezuWorkspaceId!), eq(employeesTable.active, true))).returning({ id: employeesTable.id, name: employeesTable.name });
    if (!employee) return null;
    await tx.insert(auditLogsTable).values({ workspaceId: req.trezuWorkspaceId!, actorUserId: req.trezuUserId!, action: "payroll.employee_profile_removed", entityType: "employee", entityId: employee.id, metadata: { name: employee.name } });
    return employee;
  });
  if (!removed) { res.status(404).json({ error: "Employee not found" }); return; }
  res.json({ removed: true, employeeId: removed.id });
});

export default router;
