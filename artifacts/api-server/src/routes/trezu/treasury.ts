import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { allocationSettingsTable, auditLogsTable, db, invoicesTable, ledgerEntriesTable, ledgerTransactionsTable, nearIntentQuotesTable, savingsGoalContributionsTable, savingsGoalsTable, treasuryAllocationEventsTable, treasuryAllocationPlansTable, treasuryIncomeRunsTable, treasuryStrategyActivityTable, treasuryStrategySettingsTable } from "@workspace/db";
import {
  GetAllocationsResponse,
  UpdateAllocationsBody,
  UpdateAllocationsResponse,
} from "@workspace/api-zod";
import {
  requireWorkspaceMember,
  requireWorkspaceRole,
} from "../../middlewares/auth";

const router: IRouter = Router();

router.get("/treasury/allocation-plan", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const [plan] = await db.select().from(treasuryAllocationPlansTable).where(eq(treasuryAllocationPlansTable.workspaceId, req.trezuWorkspaceId!)).limit(1);
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ rules: plan?.rules ?? [], updatedAt: plan?.updatedAt ?? null });
});

router.put("/treasury/allocation-plan", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const rules = req.body?.rules;
  if (!Array.isArray(rules) || rules.length > 10) { res.status(400).json({ error: "Add up to ten destinations to your allocation plan." }); return; }
  const normalized: { id: string; label: string; percent: number; target: "wallet" | "defi"; address?: string; protocolId?: string }[] = [];
  for (const rule of rules) {
    if (!rule || typeof rule !== "object" || typeof rule.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(rule.id) || typeof rule.label !== "string" || !rule.label.trim() || rule.label.length > 60 || !Number.isInteger(rule.percent) || rule.percent < 1 || rule.percent > 100 || !["wallet", "defi", "aave"].includes(rule.target)) {
      res.status(400).json({ error: "Each destination needs a name, a whole percentage, and a wallet or DeFi destination." }); return;
    }
    const target = rule.target === "aave" ? "defi" : rule.target;
    const item = { id: rule.id, label: rule.label.trim(), percent: rule.percent, target: target as "wallet" | "defi", ...(target === "wallet" && typeof rule.address === "string" ? { address: rule.address.trim() } : {}), ...(target === "defi" && typeof rule.protocolId === "string" ? { protocolId: rule.protocolId } : rule.target === "aave" ? { protocolId: "aave-v3-base-sepolia-usdc" } : {}) };
    if (item.target === "wallet" && (!item.address || item.address.length > 200)) { res.status(400).json({ error: `Add a valid wallet address for ${item.label}.` }); return; }
    if (item.target === "defi" && item.protocolId !== "aave-v3-base-sepolia-usdc") { res.status(400).json({ error: `Choose an available DeFi protocol for ${item.label}.` }); return; }
    normalized.push(item);
  }
  if (normalized.reduce((sum, rule) => sum + rule.percent, 0) > 100) { res.status(400).json({ error: "Allocation percentages cannot exceed 100%. Any remaining amount stays in the receiving wallet." }); return; }
  const [saved] = await db.insert(treasuryAllocationPlansTable).values({ workspaceId: req.trezuWorkspaceId!, rules: normalized, updatedBy: req.trezuUserId! })
    .onConflictDoUpdate({ target: treasuryAllocationPlansTable.workspaceId, set: { rules: normalized, updatedBy: req.trezuUserId!, updatedAt: new Date() } }).returning();
  await db.insert(auditLogsTable).values({ workspaceId: req.trezuWorkspaceId!, actorUserId: req.trezuUserId!, action: "treasury.allocation_plan_updated", entityType: "treasury_allocation_plan", entityId: saved!.id, metadata: { ruleCount: normalized.length, allocatedPercent: normalized.reduce((sum, rule) => sum + rule.percent, 0), movement: "none_until_user_runs_plan" } });
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ rules: saved!.rules, updatedAt: saved!.updatedAt });
});

router.get("/treasury/confirmed-income", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const [payments, runs] = await Promise.all([
    db.select({ payment: nearIntentQuotesTable, invoiceNumber: invoicesTable.invoiceNumber, invoiceCurrency: invoicesTable.currency, recipient: invoicesTable.paymentRecipient })
      .from(nearIntentQuotesTable).innerJoin(invoicesTable, eq(nearIntentQuotesTable.invoiceId, invoicesTable.id))
      .where(and(eq(nearIntentQuotesTable.workspaceId, req.trezuWorkspaceId!), eq(invoicesTable.workspaceId, req.trezuWorkspaceId!), eq(nearIntentQuotesTable.providerStatus, "SUCCESS"), eq(nearIntentQuotesTable.reconciliationStatus, "matched_invoice")))
      .orderBy(desc(nearIntentQuotesTable.settledAt)).limit(100),
    db.select({ paymentId: treasuryIncomeRunsTable.paymentId, status: treasuryIncomeRunsTable.status }).from(treasuryIncomeRunsTable).where(eq(treasuryIncomeRunsTable.workspaceId, req.trezuWorkspaceId!)),
  ]);
  const runByPayment = new Map(runs.map((run) => [run.paymentId, run.status]));
  res.setHeader("Cache-Control", "private, no-store");
  res.json(payments.map(({ payment, invoiceNumber, invoiceCurrency, recipient }) => {
    return { paymentId: payment.id, invoiceNumber, amount: confirmedIncomeAmount(payment), currency: payment.destinationAssetSymbol || invoiceCurrency, assetId: payment.destinationAsset || "", decimals: payment.destinationAssetDecimals ?? 6, network: payment.destinationAssetNetwork || "", recipientAddress: recipient || "", settledAt: payment.settledAt, runStatus: runByPayment.get(payment.id) ?? null };
  }).filter((income) => income.runStatus === null));
});

router.get("/treasury/income-runs", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const rows = await db.select().from(treasuryIncomeRunsTable).where(eq(treasuryIncomeRunsTable.workspaceId, req.trezuWorkspaceId!)).orderBy(desc(treasuryIncomeRunsTable.createdAt)).limit(100);
  res.setHeader("Cache-Control", "private, no-store");
  res.json(rows);
});

router.post("/treasury/income-runs/start", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const paymentId = req.body?.paymentId;
  if (typeof paymentId !== "string" || !/^[0-9a-f-]{36}$/i.test(paymentId)) { res.status(400).json({ error: "Select a confirmed invoice payment to allocate." }); return; }
  const [plan] = await db.select().from(treasuryAllocationPlansTable).where(eq(treasuryAllocationPlansTable.workspaceId, req.trezuWorkspaceId!)).limit(1);
  if (!plan || !plan.rules.length) { res.status(409).json({ error: "Save at least one destination before running a Treasury allocation." }); return; }
  const [payment] = await db.select({ payment: nearIntentQuotesTable, invoiceNumber: invoicesTable.invoiceNumber, invoiceCurrency: invoicesTable.currency }).from(nearIntentQuotesTable).innerJoin(invoicesTable, eq(nearIntentQuotesTable.invoiceId, invoicesTable.id)).where(and(eq(nearIntentQuotesTable.id, paymentId), eq(nearIntentQuotesTable.workspaceId, req.trezuWorkspaceId!), eq(nearIntentQuotesTable.providerStatus, "SUCCESS"), eq(nearIntentQuotesTable.reconciliationStatus, "matched_invoice"))).limit(1);
  if (!payment) { res.status(409).json({ error: "Only provider-confirmed invoice receipts can run through Treasury." }); return; }
  const amount = confirmedIncomeAmount(payment.payment);
  try {
    const [run] = await db.insert(treasuryIncomeRunsTable).values({ workspaceId: req.trezuWorkspaceId!, paymentId, createdBy: req.trezuUserId!, sourceAmount: amount, currency: payment.payment.destinationAssetSymbol || payment.invoiceCurrency, network: payment.payment.destinationAssetNetwork || "", ruleSnapshot: plan.rules, outputs: [], status: "in_progress" }).returning();
    res.status(201).json(run);
  } catch (error) {
    const [existing] = await db.select().from(treasuryIncomeRunsTable).where(and(eq(treasuryIncomeRunsTable.workspaceId, req.trezuWorkspaceId!), eq(treasuryIncomeRunsTable.paymentId, paymentId))).limit(1);
    if (existing) { res.status(409).json({ error: "This receipt already has a Treasury run. Review its status before trying again.", run: existing }); return; }
    throw error;
  }
});

router.post("/treasury/income-runs/:runId/finish", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const runId = req.params.runId;
  if (typeof runId !== "string" || !/^[0-9a-f-]{36}$/i.test(runId)) { res.status(400).json({ error: "The Treasury run reference is invalid." }); return; }
  const { status, outputs } = req.body ?? {};
  if (!["completed", "partial", "cancelled"].includes(status) || !Array.isArray(outputs) || outputs.length > 10 || outputs.some((item: any) => !item || typeof item.label !== "string" || typeof item.amount !== "string" || !["wallet", "defi", "aave"].includes(item.target) || (item.transactionHash !== undefined && typeof item.transactionHash !== "string"))) { res.status(400).json({ error: "The Treasury run result is invalid." }); return; }
  const [saved] = await db.update(treasuryIncomeRunsTable).set({ outputs: outputs as { label: string; target: "wallet" | "defi" | "aave"; address?: string; amount: string; transactionHash?: string }[], status: status as string }).where(and(eq(treasuryIncomeRunsTable.id, runId), eq(treasuryIncomeRunsTable.workspaceId, req.trezuWorkspaceId!), eq(treasuryIncomeRunsTable.status, "in_progress"))).returning();
  if (!saved) { res.status(409).json({ error: "This Treasury run is no longer open." }); return; }
  res.json(saved);
});

const AAVE_BASE_SEPOLIA_POOL = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27";
const AAVE_BASE_SEPOLIA_USDC = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f";
const AAVE_BASE_SEPOLIA_AUSDC = "0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC";

async function baseSepoliaRpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch("https://sepolia.base.org", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "trezu-aave-testnet", method, params }), signal: AbortSignal.timeout(10_000) });
  const body = await response.json() as { result?: unknown; error?: { message?: string } };
  if (!response.ok || body.error || body.result === undefined) throw new Error(body.error?.message || "Base Sepolia RPC is temporarily unavailable.");
  return body.result;
}

router.get("/treasury/defi/protocols", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (_req, res): Promise<void> => {
  let apyPercent: number | null = null;
  try {
    const calldata = `0x35ea6a75${AAVE_BASE_SEPOLIA_USDC.slice(2).toLowerCase().padStart(64, "0")}`;
    const data = await baseSepoliaRpc("eth_call", [{ to: AAVE_BASE_SEPOLIA_POOL, data: calldata }, "latest"]);
    if (typeof data === "string" && /^0x[0-9a-f]+$/i.test(data)) {
      const words = data.slice(2).match(/.{64}/g) || [];
      if (words.length >= 3) {
        // Aave reports the supply rate as an annualized ray value. Compound it
        // once per second to show a live APY rather than a testnet estimate.
        const annualRate = Number(BigInt(`0x${words[2]}`)) / 1e27;
        const secondsPerYear = 31_536_000;
        const calculated = (Math.pow(1 + annualRate / secondsPerYear, secondsPerYear) - 1) * 100;
        if (Number.isFinite(calculated) && calculated >= 0 && calculated < 1_000_000) apyPercent = calculated;
      }
    }
  } catch { /* Keep protocol visible and label its live rate unavailable when RPC is down. */ }
  res.setHeader("Cache-Control", "private, max-age=30");
  res.json({ protocols: [{ id: "aave-v3-base-sepolia-usdc", name: "Aave V3", action: "Supply", network: "Base Sepolia", assetSymbol: "USDC", assetAddress: AAVE_BASE_SEPOLIA_USDC, apyPercent, apyUpdatedAt: new Date().toISOString(), enabled: true }] });
});

function encodeBalanceOf(address: string) { return `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}`; }
function tokenUnitsFromRpc(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) throw new Error("Base Sepolia returned an invalid token balance.");
  const units = BigInt(value);
  const whole = units / 1_000_000n;
  const fraction = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

function confirmedIncomeAmount(payment: { quotePayload: unknown; providerStatusPayload: unknown }): string {
  const statusPayload = payment.providerStatusPayload && typeof payment.providerStatusPayload === "object" ? payment.providerStatusPayload as Record<string, unknown> : {};
  const swap = statusPayload.swapDetails && typeof statusPayload.swapDetails === "object" ? statusPayload.swapDetails as Record<string, unknown> : {};
  if (typeof swap.amountOutFormatted === "string") return swap.amountOutFormatted;
  const payload = payment.quotePayload && typeof payment.quotePayload === "object" ? payment.quotePayload as Record<string, unknown> : {};
  const quote = payload.quote && typeof payload.quote === "object" ? payload.quote as Record<string, unknown> : {};
  return typeof quote.amountOutFormatted === "string" ? quote.amountOutFormatted : "0";
}

const suggestions = {
  taxPercent: 20,
  savingsPercent: 20,
  spendingPercent: 60,
  automationEnabled: false,
  automationStatus: "preferences_only" as const,
  updatedAt: null,
};

function amountToUnits(value: unknown, decimals: number): bigint | null {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,23})(?:\.\d{1,36})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) return null;
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
}

function unitsToAmount(value: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${value / scale}${fraction ? `.${fraction}` : ""}`;
}

const ACCOUNTING_DECIMALS = 36;
function accountingAmountToUnits(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,41})(?:\.\d{1,36})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 10n ** 36n + BigInt((fraction + "0".repeat(36)).slice(0, 36) || "0");
}

function accountingUnitsToAmount(value: bigint): string {
  return unitsToAmount(value, ACCOUNTING_DECIMALS);
}

function validReportDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

async function getTaxReserveBalancesBefore(workspaceId: string, cutoff: Date) {
  const rows = await db.select({ currency: ledgerEntriesTable.currency, side: ledgerEntriesTable.side, amount: sql<string>`coalesce(sum(${ledgerEntriesTable.amount}), 0)::text` })
    .from(ledgerEntriesTable).innerJoin(ledgerTransactionsTable, eq(ledgerEntriesTable.transactionId, ledgerTransactionsTable.id))
    .where(and(eq(ledgerEntriesTable.workspaceId, workspaceId), eq(ledgerTransactionsTable.workspaceId, workspaceId), eq(ledgerEntriesTable.accountCode, "tax_reserve"), eq(ledgerTransactionsTable.status, "confirmed"), lt(ledgerEntriesTable.createdAt, cutoff)))
    .groupBy(ledgerEntriesTable.currency, ledgerEntriesTable.side);
  const balances = new Map<string, bigint>();
  for (const row of rows) {
    const amount = accountingAmountToUnits(row.amount);
    if (amount === null) continue;
    balances.set(row.currency, (balances.get(row.currency) ?? 0n) + (row.side === "credit" ? amount : -amount));
  }
  return balances;
}

class AllocationConflictError extends Error {}
function allocationMovementStatus(event: { transferTxHashes?: string[] | null; transferNetwork?: string | null }) {
  return event.transferNetwork ? "wallet_transfer_submitted" as const : "internal_ledger_only" as const;
}

router.get(
  "/treasury/allocations",
  requireWorkspaceMember,
  requireWorkspaceRole("owner", "admin"),
  async (req, res): Promise<void> => {
    const [saved] = await db
      .select()
      .from(allocationSettingsTable)
      .where(eq(allocationSettingsTable.workspaceId, req.trezuWorkspaceId!))
      .limit(1);

    res.json(
      GetAllocationsResponse.parse(
        saved
          ? {
              taxPercent: saved.taxPercent,
              savingsPercent: saved.savingsPercent,
              spendingPercent: saved.spendingPercent,
              automationEnabled: saved.automationEnabled,
              automationStatus: "preferences_only",
              updatedAt: saved.updatedAt,
            }
          : suggestions,
      ),
    );
  },
);

router.get("/treasury/destinations", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const [settings] = await db.select({ destinations: allocationSettingsTable.treasuryDestinations }).from(allocationSettingsTable)
    .where(eq(allocationSettingsTable.workspaceId, req.trezuWorkspaceId!)).limit(1);
  res.setHeader("Cache-Control", "private, no-store");
  res.json(settings?.destinations ?? { tax: "", savings: "", spending: "" });
});

router.put("/treasury/destinations", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const value = req.body?.destinations as Record<string, unknown> | undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) || !["tax", "savings", "spending"].every((key) => typeof value[key] === "string" && (value[key] as string).length <= 200)) {
    res.status(400).json({ error: "Enter a wallet address of 200 characters or fewer for each treasury destination." }); return;
  }
  const destinations = { tax: (value.tax as string).trim(), savings: (value.savings as string).trim(), spending: (value.spending as string).trim() };
  const [saved] = await db.insert(allocationSettingsTable).values({ workspaceId: req.trezuWorkspaceId!, taxPercent: 20, savingsPercent: 20, spendingPercent: 60, automationEnabled: false, treasuryDestinations: destinations, updatedBy: req.trezuUserId! })
    .onConflictDoUpdate({ target: allocationSettingsTable.workspaceId, set: { treasuryDestinations: destinations, updatedBy: req.trezuUserId!, updatedAt: new Date() } })
    .returning({ destinations: allocationSettingsTable.treasuryDestinations });
  res.setHeader("Cache-Control", "private, no-store");
  res.json(saved!.destinations);
});

router.get("/treasury/strategies", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const [settings] = await db.select().from(treasuryStrategySettingsTable).where(eq(treasuryStrategySettingsTable.workspaceId, req.trezuWorkspaceId!)).limit(1);
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ aaveBaseSepoliaUsdcPercent: settings?.aaveBaseSepoliaUsdcPercent ?? 0, updatedAt: settings?.updatedAt ?? null });
});

router.put("/treasury/strategies", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const percent = req.body?.aaveBaseSepoliaUsdcPercent;
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) { res.status(400).json({ error: "Choose an Aave allocation from 0% to 100%." }); return; }
  const [settings] = await db.insert(treasuryStrategySettingsTable).values({ workspaceId: req.trezuWorkspaceId!, aaveBaseSepoliaUsdcPercent: percent, updatedBy: req.trezuUserId! })
    .onConflictDoUpdate({ target: treasuryStrategySettingsTable.workspaceId, set: { aaveBaseSepoliaUsdcPercent: percent, updatedBy: req.trezuUserId!, updatedAt: new Date() } }).returning();
  await db.insert(auditLogsTable).values({ workspaceId: req.trezuWorkspaceId!, actorUserId: req.trezuUserId!, action: "treasury.defi_strategy_allocation_updated", entityType: "treasury_strategy_settings", entityId: settings!.id, metadata: { strategy: "aave-v3-base-sepolia-usdc", percent, movement: "none_until_wallet_approval" } });
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ aaveBaseSepoliaUsdcPercent: settings!.aaveBaseSepoliaUsdcPercent, updatedAt: settings!.updatedAt });
});

router.get("/treasury/defi/aave/base-sepolia/position", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const address = req.query.address;
  if (typeof address !== "string" || !/^0x[0-9a-f]{40}$/i.test(address)) { res.status(400).json({ error: "Provide the Privy EVM wallet address to load its Base Sepolia position." }); return; }
  try {
    const [walletBalance, suppliedBalance] = await Promise.all([
      baseSepoliaRpc("eth_call", [{ to: AAVE_BASE_SEPOLIA_USDC, data: encodeBalanceOf(address) }, "latest"]),
      baseSepoliaRpc("eth_call", [{ to: AAVE_BASE_SEPOLIA_AUSDC, data: encodeBalanceOf(address) }, "latest"]),
    ]);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ network: "Base Sepolia", chainId: 84532, asset: "USDC", decimals: 6, walletBalance: tokenUnitsFromRpc(walletBalance), suppliedBalance: tokenUnitsFromRpc(suppliedBalance), walletAddress: address, poolAddress: AAVE_BASE_SEPOLIA_POOL });
  } catch (error) {
    req.log?.warn({ err: error }, "Could not read Aave Base Sepolia position");
    res.status(503).json({ error: "Could not load Base Sepolia balances right now. Refresh in a moment." });
  }
});

router.get("/treasury/strategy-activity", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const rows = await db.select().from(treasuryStrategyActivityTable).where(eq(treasuryStrategyActivityTable.workspaceId, req.trezuWorkspaceId!)).orderBy(desc(treasuryStrategyActivityTable.createdAt)).limit(100);
  res.setHeader("Cache-Control", "private, no-store");
  res.json(rows);
});

router.post("/treasury/strategy-activity", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const { strategyId, action, amount, walletAddress, transactionHash } = req.body ?? {};
  if (strategyId !== "aave-v3-base-sepolia-usdc" || !["supply", "withdraw"].includes(action) || typeof amount !== "string" || !/^(?:0|[1-9]\d{0,23})(?:\.\d{1,6})?$/.test(amount) || Number(amount) <= 0 || typeof walletAddress !== "string" || !/^0x[0-9a-f]{40}$/i.test(walletAddress) || typeof transactionHash !== "string" || !/^0x[0-9a-f]{64}$/i.test(transactionHash)) {
    res.status(400).json({ error: "Provide a valid Aave testnet action, amount, wallet, and transaction reference." }); return;
  }
  try {
    const [transaction, receipt] = await Promise.all([
      baseSepoliaRpc("eth_getTransactionByHash", [transactionHash]) as Promise<Record<string, unknown> | null>,
      baseSepoliaRpc("eth_getTransactionReceipt", [transactionHash]) as Promise<Record<string, unknown> | null>,
    ]);
    const input = transaction && typeof transaction.input === "string" ? transaction.input.toLowerCase() : "";
    const actionSelector = action === "supply" ? "0x617ba037" : "0x69328dec";
    const expectedAmount = amountToUnits(amount, 6)?.toString(16).padStart(64, "0");
    const expectedAsset = AAVE_BASE_SEPOLIA_USDC.slice(2).toLowerCase().padStart(64, "0");
    const expectedWallet = walletAddress.slice(2).toLowerCase().padStart(64, "0");
    const encodedAsset = input.slice(10, 74);
    const encodedAmount = input.slice(74, 138);
    const encodedCounterparty = input.slice(138, 202);
    if (!transaction || !receipt || String(receipt.status).toLowerCase() !== "0x1" || String(transaction.from).toLowerCase() !== walletAddress.toLowerCase() || String(transaction.to).toLowerCase() !== AAVE_BASE_SEPOLIA_POOL.toLowerCase() || !input.startsWith(actionSelector) || encodedAsset !== expectedAsset || encodedAmount !== expectedAmount || encodedCounterparty !== expectedWallet) {
      res.status(409).json({ error: "That transaction is not a confirmed Aave action from the selected wallet on Base Sepolia." }); return;
    }
    const [saved] = await db.insert(treasuryStrategyActivityTable).values({ workspaceId: req.trezuWorkspaceId!, userId: req.trezuUserId!, strategyId, action, assetSymbol: "USDC", amount, walletAddress, transactionHash, status: "confirmed" }).returning();
    await db.insert(auditLogsTable).values({ workspaceId: req.trezuWorkspaceId!, actorUserId: req.trezuUserId!, action: `treasury.aave_${action}_confirmed`, entityType: "treasury_strategy_activity", entityId: saved!.id, metadata: { amount, asset: "USDC", network: "Base Sepolia", walletAddress, transactionHash } });
    res.status(201).json(saved);
  } catch (error) {
    req.log?.warn({ err: error }, "Could not verify Aave Base Sepolia transaction");
    res.status(503).json({ error: "The transaction was sent, but Trezu could not verify or save it yet. Check the Base Sepolia explorer before retrying." });
  }
});

router.get("/treasury/automation/internal-income-allocation", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const [settings] = await db.select({ enabled: allocationSettingsTable.internalIncomeAutomationEnabled, updatedAt: allocationSettingsTable.internalIncomeAutomationUpdatedAt })
    .from(allocationSettingsTable).where(eq(allocationSettingsTable.workspaceId, req.trezuWorkspaceId!)).limit(1);
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ enabled: settings?.enabled ?? false, updatedAt: settings?.updatedAt ?? null, movementStatus: "internal_ledger_only" });
});

router.put("/treasury/automation/internal-income-allocation", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const { enabled, expectedUpdatedAt, expectedPreferencesUpdatedAt } = req.body ?? {};
  if (typeof enabled !== "boolean" || !(expectedUpdatedAt === null || (typeof expectedUpdatedAt === "string" && !Number.isNaN(Date.parse(expectedUpdatedAt)))) || typeof expectedPreferencesUpdatedAt !== "string" || Number.isNaN(Date.parse(expectedPreferencesUpdatedAt))) {
    res.status(400).json({ error: "Confirm the current automatic allocation setting before changing it." }); return;
  }
  const result = await db.transaction(async (tx) => {
    const [settings] = await tx.select().from(allocationSettingsTable).where(eq(allocationSettingsTable.workspaceId, req.trezuWorkspaceId!)).for("update").limit(1);
    if (!settings) return { error: "preferences_missing" as const };
    const actualUpdatedAt = settings.internalIncomeAutomationUpdatedAt?.toISOString() ?? null;
    if (actualUpdatedAt !== expectedUpdatedAt) return { error: "stale" as const };
    if (settings.updatedAt.toISOString() !== expectedPreferencesUpdatedAt) return { error: "stale_preferences" as const };
    if (enabled && settings.taxPercent + settings.savingsPercent + settings.spendingPercent !== 100) return { error: "invalid_preferences" as const };
    const now = new Date();
    const [updated] = await tx.update(allocationSettingsTable).set({ internalIncomeAutomationEnabled: enabled, internalIncomeAutomationUpdatedBy: req.trezuUserId!, internalIncomeAutomationUpdatedAt: now })
      .where(eq(allocationSettingsTable.id, settings.id)).returning({ enabled: allocationSettingsTable.internalIncomeAutomationEnabled, updatedAt: allocationSettingsTable.internalIncomeAutomationUpdatedAt });
    await tx.insert(auditLogsTable).values({ workspaceId: req.trezuWorkspaceId!, actorUserId: req.trezuUserId!, action: enabled ? "treasury.internal_income_automation_enabled" : "treasury.internal_income_automation_disabled", entityType: "allocation_settings", entityId: settings.id, metadata: { enabled, movement: "internal_ledger_only" } });
    return { setting: updated };
  });
  if ("error" in result) {
    const messages = { preferences_missing: "Save allocation preferences before enabling automation.", stale: "This setting changed after you reviewed it. Reload Treasury and confirm again.", stale_preferences: "Allocation preferences changed after you reviewed them. Reload Treasury and confirm again.", invalid_preferences: "The saved tax, savings, and spending percentages must total 100." };
    res.status(409).json({ error: messages[result.error] }); return;
  }
  res.json({ ...result.setting, movementStatus: "internal_ledger_only" });
});

router.put(
  "/treasury/allocations",
  requireWorkspaceMember,
  requireWorkspaceRole("owner", "admin"),
  async (req, res): Promise<void> => {
    const parsed = UpdateAllocationsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { taxPercent, savingsPercent, spendingPercent } = parsed.data;
    if (taxPercent + savingsPercent + spendingPercent !== 100) {
      res.status(400).json({
        error: "Tax, savings, and spending percentages must total 100",
      });
      return;
    }
    if (parsed.data.automationEnabled) {
      res.status(400).json({
        error:
          "Automatic fund movement is not connected. Save these as preferences with automation off.",
      });
      return;
    }

    const [saved] = await db.transaction(async (tx) => {
      const result = await tx
        .insert(allocationSettingsTable)
        .values({
          workspaceId: req.trezuWorkspaceId!,
          taxPercent,
          savingsPercent,
          spendingPercent,
          automationEnabled: false,
          updatedBy: req.trezuUserId!,
        })
        .onConflictDoUpdate({
          target: allocationSettingsTable.workspaceId,
          set: {
            taxPercent,
            savingsPercent,
            spendingPercent,
            automationEnabled: false,
            updatedBy: req.trezuUserId!,
            updatedAt: new Date(),
          },
        })
        .returning();

      await tx.insert(auditLogsTable).values({
        workspaceId: req.trezuWorkspaceId!,
        actorUserId: req.trezuUserId!,
        action: "treasury.allocation_preferences_updated",
        entityType: "allocation_settings",
        entityId: result[0]!.id,
        metadata: {
          taxPercent,
          savingsPercent,
          spendingPercent,
        },
      });
      return result;
    });

    res.json(
      UpdateAllocationsResponse.parse({
        taxPercent: saved!.taxPercent,
        savingsPercent: saved!.savingsPercent,
        spendingPercent: saved!.spendingPercent,
        automationEnabled: saved!.automationEnabled,
        automationStatus: "preferences_only",
        updatedAt: saved!.updatedAt,
      }),
    );
  },
);

router.get("/treasury/allocations/eligible-payments", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const [payments, savedEvents, settingsRows] = await Promise.all([
    db.select({ payment: nearIntentQuotesTable, invoiceNumber: invoicesTable.invoiceNumber }).from(nearIntentQuotesTable)
      .leftJoin(invoicesTable, eq(nearIntentQuotesTable.invoiceId, invoicesTable.id))
      .where(and(eq(nearIntentQuotesTable.workspaceId, req.trezuWorkspaceId!), eq(nearIntentQuotesTable.providerStatus, "SUCCESS"), eq(nearIntentQuotesTable.reconciliationStatus, "matched_invoice")))
      .orderBy(desc(nearIntentQuotesTable.settledAt)).limit(100),
    db.select({ paymentId: treasuryAllocationEventsTable.paymentId }).from(treasuryAllocationEventsTable).where(eq(treasuryAllocationEventsTable.workspaceId, req.trezuWorkspaceId!)),
    db.select().from(allocationSettingsTable).where(eq(allocationSettingsTable.workspaceId, req.trezuWorkspaceId!)).limit(1),
  ]);
  const allocated = new Set(savedEvents.map((event) => event.paymentId));
  const settings = settingsRows[0];
  res.json(payments.filter((row) => !allocated.has(row.payment.id)).map(({ payment, invoiceNumber }) => {
    const quote = payment.quotePayload?.quote && typeof payment.quotePayload.quote === "object" ? payment.quotePayload.quote as Record<string, unknown> : {};
    const amount = typeof quote.amountOutFormatted === "string" ? quote.amountOutFormatted : null;
    const units = amount && payment.destinationAssetDecimals !== null ? amountToUnits(amount, payment.destinationAssetDecimals) : null;
    const tax = settings && units !== null ? units * BigInt(settings.taxPercent) / 100n : null;
    const savings = settings && units !== null ? units * BigInt(settings.savingsPercent) / 100n : null;
    const spending = tax !== null && savings !== null && units !== null ? units - tax - savings : null;
    const quoteRequest = payment.quotePayload?.quoteRequest && typeof payment.quotePayload.quoteRequest === "object" ? payment.quotePayload.quoteRequest as Record<string, unknown> : {};
    return { paymentId: payment.id, invoiceNumber, amount: typeof quote.amountOutFormatted === "string" ? quote.amountOutFormatted : null,
      currency: payment.destinationAssetSymbol, assetId: payment.destinationAsset, network: payment.destinationAssetNetwork, decimals: payment.destinationAssetDecimals,
      recipientAddress: typeof quoteRequest.recipient === "string" ? quoteRequest.recipient : null,
      settledAt: payment.settledAt, hasSavedPreferences: !!settings,
      preview: tax !== null && savings !== null && spending !== null && payment.destinationAssetDecimals !== null ? {
        tax: unitsToAmount(tax, payment.destinationAssetDecimals), savings: unitsToAmount(savings, payment.destinationAssetDecimals), spending: unitsToAmount(spending, payment.destinationAssetDecimals),
        taxPercent: settings!.taxPercent, savingsPercent: settings!.savingsPercent, spendingPercent: settings!.spendingPercent,
      } : null };
  }).filter((payment) => payment.amount && payment.currency && payment.settledAt));
});

router.post("/treasury/allocations/apply/:paymentId", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const paymentId = req.params.paymentId;
  if (!/^[0-9a-f-]{36}$/i.test(paymentId)) { res.status(404).json({ error: "Confirmed invoice payment not found." }); return; }
  const { taxPercent: expectedTax, savingsPercent: expectedSavings, spendingPercent: expectedSpending, updatedAt: expectedUpdatedAt } = req.body ?? {};
  const transferTxHashes = req.body?.transferTxHashes;
  const transferNetwork = req.body?.transferNetwork;
  if (transferTxHashes !== undefined && (!Array.isArray(transferTxHashes) || transferTxHashes.length > 3 || transferTxHashes.some((hash: unknown) => typeof hash !== "string" || hash.length > 200) || typeof transferNetwork !== "string" || transferNetwork.length > 32)) {
    res.status(400).json({ error: "Transfer history must include valid transaction references and a network." }); return;
  }
  if (![expectedTax, expectedSavings, expectedSpending].every((value) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100) || typeof expectedUpdatedAt !== "string" || Number.isNaN(Date.parse(expectedUpdatedAt))) {
    res.status(400).json({ error: "Confirm the saved allocation preferences shown in the preview." }); return;
  }
  try {
    const result = await db.transaction(async (tx) => {
      const [payment] = await tx.select().from(nearIntentQuotesTable).where(and(
        eq(nearIntentQuotesTable.id, paymentId), eq(nearIntentQuotesTable.workspaceId, req.trezuWorkspaceId!),
      )).for("update").limit(1);
      if (!payment || payment.providerStatus !== "SUCCESS" || payment.reconciliationStatus !== "matched_invoice" || !payment.invoiceId || payment.destinationAssetDecimals === null || !payment.destinationAssetSymbol) {
        throw new AllocationConflictError("Choose an invoice payment with confirmed provider settlement and a matched reconciliation.");
      }
      const [invoice] = await tx.select({ invoiceNumber: invoicesTable.invoiceNumber }).from(invoicesTable).where(eq(invoicesTable.id, payment.invoiceId)).limit(1);
      const [existing] = await tx.select().from(treasuryAllocationEventsTable).where(and(
        eq(treasuryAllocationEventsTable.workspaceId, req.trezuWorkspaceId!), eq(treasuryAllocationEventsTable.paymentId, payment.id),
      )).limit(1);
      if (existing) return { event: { ...existing, invoiceNumber: invoice?.invoiceNumber ?? "Invoice", movementStatus: allocationMovementStatus(existing) }, alreadyRecorded: true };
      const [settings] = await tx.select().from(allocationSettingsTable).where(eq(allocationSettingsTable.workspaceId, req.trezuWorkspaceId!)).limit(1);
      if (!settings) throw new AllocationConflictError("Save allocation preferences before recording an income split.");
      if (settings.taxPercent !== expectedTax || settings.savingsPercent !== expectedSavings || settings.spendingPercent !== expectedSpending || settings.updatedAt.getTime() !== new Date(expectedUpdatedAt).getTime()) {
        throw new AllocationConflictError("Allocation preferences changed after this preview. Refresh the treasury page and review the updated split.");
      }
      const quote = payment.quotePayload?.quote && typeof payment.quotePayload.quote === "object" ? payment.quotePayload.quote as Record<string, unknown> : {};
      const total = amountToUnits(quote.amountOutFormatted, payment.destinationAssetDecimals);
      if (!total || total <= 0n) throw new AllocationConflictError("The provider's confirmed amount cannot be represented at the settlement asset precision.");
      const tax = total * BigInt(settings.taxPercent) / 100n;
      const savings = total * BigInt(settings.savingsPercent) / 100n;
      const spending = total - tax - savings;
      const sourceAmount = unitsToAmount(total, payment.destinationAssetDecimals);
      const taxAmount = unitsToAmount(tax, payment.destinationAssetDecimals);
      const savingsAmount = unitsToAmount(savings, payment.destinationAssetDecimals);
      const spendingAmount = unitsToAmount(spending, payment.destinationAssetDecimals);
      const now = new Date();
      const [ledger] = await tx.insert(ledgerTransactionsTable).values({ workspaceId: req.trezuWorkspaceId!, idempotencyKey: `treasury-allocation:${payment.id}`,
        type: "treasury_allocation", status: "confirmed", provider: "trezu_internal", providerReference: payment.id, createdBy: req.trezuUserId!, confirmedAt: now }).returning();
      const entries: (typeof ledgerEntriesTable.$inferInsert)[] = [{ transactionId: ledger!.id, workspaceId: req.trezuWorkspaceId!, accountCode: "accounts_receivable", side: "debit", amount: sourceAmount, currency: payment.destinationAssetSymbol }];
      if (tax > 0n) entries.push({ transactionId: ledger!.id, workspaceId: req.trezuWorkspaceId!, accountCode: "tax_reserve", side: "credit" as const, amount: taxAmount, currency: payment.destinationAssetSymbol });
      if (savings > 0n) entries.push({ transactionId: ledger!.id, workspaceId: req.trezuWorkspaceId!, accountCode: "savings_reserve", side: "credit" as const, amount: savingsAmount, currency: payment.destinationAssetSymbol });
      if (spending > 0n) entries.push({ transactionId: ledger!.id, workspaceId: req.trezuWorkspaceId!, accountCode: "spending_available", side: "credit" as const, amount: spendingAmount, currency: payment.destinationAssetSymbol });
      await tx.insert(ledgerEntriesTable).values(entries);
      const [event] = await tx.insert(treasuryAllocationEventsTable).values({ workspaceId: req.trezuWorkspaceId!, paymentId: payment.id, ledgerTransactionId: ledger!.id,
        sourceType: "invoice_payment", currency: payment.destinationAssetSymbol, sourceAmount,
        taxPercent: settings.taxPercent, taxAmount, savingsPercent: settings.savingsPercent, savingsAmount,
        spendingPercent: settings.spendingPercent, spendingAmount, recordedBy: req.trezuUserId!,
        transferNetwork: typeof transferNetwork === "string" ? transferNetwork : null,
        transferTxHashes: Array.isArray(transferTxHashes) ? transferTxHashes as string[] : null }).returning();
      await tx.insert(auditLogsTable).values({ workspaceId: req.trezuWorkspaceId!, actorUserId: req.trezuUserId!, action: "treasury.income_allocation_recorded", entityType: "treasury_allocation", entityId: event!.id,
        metadata: { paymentId: payment.id, sourceAmount, currency: payment.destinationAssetSymbol, taxAmount, savingsAmount, spendingAmount, movement: Array.isArray(transferTxHashes) ? "wallet_transfer_submitted" : "internal_ledger_only", transferNetwork: typeof transferNetwork === "string" ? transferNetwork : null, transferTxHashes: Array.isArray(transferTxHashes) ? transferTxHashes : [] } });
      return { event: { ...event!, invoiceNumber: invoice?.invoiceNumber ?? "Invoice", movementStatus: allocationMovementStatus(event!) }, alreadyRecorded: false };
    });
    res.status(result.alreadyRecorded ? 200 : 201).json(result);
  } catch (error) {
    if (error instanceof AllocationConflictError) res.status(409).json({ error: error.message });
    else res.status(503).json({ error: "The internal allocation could not be recorded. Try again shortly." });
  }
});

router.get("/treasury/allocations/history", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const rows = await db.select({ event: treasuryAllocationEventsTable, invoiceNumber: invoicesTable.invoiceNumber })
    .from(treasuryAllocationEventsTable).innerJoin(nearIntentQuotesTable, eq(treasuryAllocationEventsTable.paymentId, nearIntentQuotesTable.id))
    .innerJoin(invoicesTable, eq(nearIntentQuotesTable.invoiceId, invoicesTable.id))
    .where(eq(treasuryAllocationEventsTable.workspaceId, req.trezuWorkspaceId!)).orderBy(desc(treasuryAllocationEventsTable.createdAt)).limit(100);
  res.json(rows.map(({ event, invoiceNumber }) => ({ ...event, invoiceNumber, movementStatus: allocationMovementStatus(event) })));
});

router.get("/treasury/reports/tax-reserves", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const from = req.query.from;
  const to = req.query.to;
  if (!validReportDate(from) || !validReportDate(to) || from > to) { res.status(400).json({ error: "Provide a valid inclusive from and to date." }); return; }
  const rangeDays = (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000 + 1;
  if (rangeDays > 366) { res.status(400).json({ error: "Tax reserve reports can cover at most 366 days at a time." }); return; }
  const periodStart = new Date(`${from}T00:00:00.000Z`);
  const periodEndExclusive = new Date(`${to}T00:00:00.000Z`);
  periodEndExclusive.setUTCDate(periodEndExclusive.getUTCDate() + 1);
  const workspaceId = req.trezuWorkspaceId!;
  const [events, periodTaxCredits, openingBalances, closingBalances] = await Promise.all([
    db.select({ event: treasuryAllocationEventsTable, invoiceNumber: invoicesTable.invoiceNumber })
      .from(treasuryAllocationEventsTable)
      .innerJoin(ledgerTransactionsTable, and(eq(treasuryAllocationEventsTable.ledgerTransactionId, ledgerTransactionsTable.id), eq(ledgerTransactionsTable.workspaceId, workspaceId), eq(ledgerTransactionsTable.status, "confirmed")))
      .innerJoin(nearIntentQuotesTable, and(eq(treasuryAllocationEventsTable.paymentId, nearIntentQuotesTable.id), eq(nearIntentQuotesTable.workspaceId, workspaceId)))
      .leftJoin(invoicesTable, and(eq(nearIntentQuotesTable.invoiceId, invoicesTable.id), eq(invoicesTable.workspaceId, workspaceId)))
      .where(and(eq(treasuryAllocationEventsTable.workspaceId, workspaceId), gte(treasuryAllocationEventsTable.createdAt, periodStart), lt(treasuryAllocationEventsTable.createdAt, periodEndExclusive)))
      .orderBy(asc(treasuryAllocationEventsTable.createdAt)),
    db.select({ currency: ledgerEntriesTable.currency, amount: sql<string>`coalesce(sum(${ledgerEntriesTable.amount}), 0)::text` })
      .from(ledgerEntriesTable).innerJoin(ledgerTransactionsTable, eq(ledgerEntriesTable.transactionId, ledgerTransactionsTable.id))
      .where(and(eq(ledgerEntriesTable.workspaceId, workspaceId), eq(ledgerTransactionsTable.workspaceId, workspaceId), eq(ledgerEntriesTable.accountCode, "tax_reserve"), eq(ledgerEntriesTable.side, "credit"), eq(ledgerTransactionsTable.status, "confirmed"), gte(ledgerEntriesTable.createdAt, periodStart), lt(ledgerEntriesTable.createdAt, periodEndExclusive)))
      .groupBy(ledgerEntriesTable.currency),
    getTaxReserveBalancesBefore(workspaceId, periodStart),
    getTaxReserveBalancesBefore(workspaceId, periodEndExclusive),
  ]);
  const periodByCurrency = new Map(periodTaxCredits.map((row) => [row.currency, accountingAmountToUnits(row.amount) ?? 0n]));
  const currencies = new Set([...openingBalances.keys(), ...periodByCurrency.keys(), ...closingBalances.keys()]);
  const totals = [...currencies].sort().map((currency) => ({
    currency,
    openingBalance: accountingUnitsToAmount(openingBalances.get(currency) ?? 0n),
    allocatedDuringPeriod: accountingUnitsToAmount(periodByCurrency.get(currency) ?? 0n),
    closingBalance: accountingUnitsToAmount(closingBalances.get(currency) ?? 0n),
  }));
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ from, to, basis: "confirmed_internal_ledger_entries", taxAdvice: false, movementStatus: "internal_ledger_only", totals, entries: events.map(({ event, invoiceNumber }) => ({
    allocationId: event.id,
    paymentId: event.paymentId,
    invoiceNumber: invoiceNumber ?? "Unknown invoice",
    recordedAt: event.createdAt,
    currency: event.currency,
    sourceAmount: event.sourceAmount,
    taxPercent: event.taxPercent,
    taxReserveAmount: event.taxAmount,
    internalOnly: true,
  })) });
});

router.get("/treasury/savings-goals", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const [goals, contributions, totals] = await Promise.all([
    db.select().from(savingsGoalsTable).where(eq(savingsGoalsTable.workspaceId, req.trezuWorkspaceId!)).orderBy(desc(savingsGoalsTable.createdAt)),
    db.select({ contribution: savingsGoalContributionsTable, invoiceNumber: invoicesTable.invoiceNumber })
      .from(savingsGoalContributionsTable)
      .innerJoin(treasuryAllocationEventsTable, eq(savingsGoalContributionsTable.allocationEventId, treasuryAllocationEventsTable.id))
      .innerJoin(nearIntentQuotesTable, eq(treasuryAllocationEventsTable.paymentId, nearIntentQuotesTable.id))
      .innerJoin(invoicesTable, eq(nearIntentQuotesTable.invoiceId, invoicesTable.id))
      .where(eq(savingsGoalContributionsTable.workspaceId, req.trezuWorkspaceId!))
      .orderBy(desc(savingsGoalContributionsTable.createdAt)).limit(500),
    db.select({ goalId: savingsGoalContributionsTable.goalId, amount: sql<string>`coalesce(sum(${savingsGoalContributionsTable.amount}), 0)::text` })
      .from(savingsGoalContributionsTable).where(eq(savingsGoalContributionsTable.workspaceId, req.trezuWorkspaceId!)).groupBy(savingsGoalContributionsTable.goalId),
  ]);
  const byGoal = new Map<string, typeof contributions>();
  for (const row of contributions) byGoal.set(row.contribution.goalId, [...(byGoal.get(row.contribution.goalId) ?? []), row]);
  const totalByGoal = new Map(totals.map((row) => [row.goalId, accountingAmountToUnits(row.amount) ?? 0n]));
  res.setHeader("Cache-Control", "private, no-store");
  res.json(goals.map((goal) => {
    const history = byGoal.get(goal.id) ?? [];
    const contributedUnits = totalByGoal.get(goal.id) ?? 0n;
    const targetUnits = accountingAmountToUnits(goal.targetAmount) ?? 0n;
    return { ...goal, contributedAmount: accountingUnitsToAmount(contributedUnits), remainingAmount: accountingUnitsToAmount(targetUnits > contributedUnits ? targetUnits - contributedUnits : 0n),
      progressPercent: targetUnits > 0n ? Number((contributedUnits * 10_000n / targetUnits)) / 100 : 0,
      contributions: history.map(({ contribution, invoiceNumber }) => ({ id: contribution.id, amount: contribution.amount, invoiceNumber, createdAt: contribution.createdAt, movementStatus: "internal_ledger_only" })) };
  }));
});

router.get("/treasury/savings-sources", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const [allocations, contributions] = await Promise.all([
    db.select({ event: treasuryAllocationEventsTable, invoiceNumber: invoicesTable.invoiceNumber })
      .from(treasuryAllocationEventsTable)
      .innerJoin(nearIntentQuotesTable, eq(treasuryAllocationEventsTable.paymentId, nearIntentQuotesTable.id))
      .innerJoin(invoicesTable, eq(nearIntentQuotesTable.invoiceId, invoicesTable.id))
      .where(eq(treasuryAllocationEventsTable.workspaceId, req.trezuWorkspaceId!))
      .orderBy(desc(treasuryAllocationEventsTable.createdAt)).limit(200),
    db.select({ allocationEventId: savingsGoalContributionsTable.allocationEventId, amount: sql<string>`coalesce(sum(${savingsGoalContributionsTable.amount}), 0)::text` })
      .from(savingsGoalContributionsTable).where(eq(savingsGoalContributionsTable.workspaceId, req.trezuWorkspaceId!))
      .groupBy(savingsGoalContributionsTable.allocationEventId),
  ]);
  const usedBySource = new Map(contributions.map((item) => [item.allocationEventId, accountingAmountToUnits(item.amount) ?? 0n]));
  res.setHeader("Cache-Control", "private, no-store");
  res.json(allocations.map(({ event, invoiceNumber }) => {
    const total = accountingAmountToUnits(event.savingsAmount) ?? 0n;
    const available = total - (usedBySource.get(event.id) ?? 0n);
    return { allocationEventId: event.id, invoiceNumber, currency: event.currency, savingsAmount: event.savingsAmount,
      availableAmount: accountingUnitsToAmount(available > 0n ? available : 0n), createdAt: event.createdAt };
  }).filter((source) => accountingAmountToUnits(source.availableAmount)! > 0n));
});

router.post("/treasury/savings-goals", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  const { name, currency, targetAmount, targetDate } = req.body ?? {};
  const targetUnits = accountingAmountToUnits(targetAmount);
  if (typeof name !== "string" || !name.trim() || name.trim().length > 120 || typeof currency !== "string" || !/^[A-Z0-9]{2,12}$/.test(currency) || targetUnits === null || targetUnits <= 0n) {
    res.status(400).json({ error: "Provide a goal name, a valid currency code, and positive target amount with up to 36 decimal places." }); return;
  }
  let target = null as Date | null;
  if (targetDate !== undefined && targetDate !== null && targetDate !== "") {
    if (typeof targetDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate) || Number.isNaN(Date.parse(`${targetDate}T00:00:00.000Z`))) {
      res.status(400).json({ error: "Use a valid target date." }); return;
    }
    target = new Date(`${targetDate}T00:00:00.000Z`);
    if (target.toISOString().slice(0, 10) !== targetDate) { res.status(400).json({ error: "Use a valid target date." }); return; }
  }
  const [goal] = await db.transaction(async (tx) => {
    const [created] = await tx.insert(savingsGoalsTable).values({ workspaceId: req.trezuWorkspaceId!, name: name.trim(), currency, targetAmount: accountingUnitsToAmount(targetUnits), targetDate: target, createdBy: req.trezuUserId! }).returning();
    await tx.insert(auditLogsTable).values({ workspaceId: req.trezuWorkspaceId!, actorUserId: req.trezuUserId!, action: "treasury.savings_goal_created", entityType: "savings_goal", entityId: created!.id, metadata: { name: created!.name, currency, targetAmount: created!.targetAmount } });
    return [created!];
  });
  res.status(201).json({ ...goal, contributedAmount: "0", remainingAmount: goal!.targetAmount, progressPercent: 0, contributions: [] });
});

router.patch("/treasury/savings-goals/:goalId", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.goalId)) { res.status(404).json({ error: "Savings goal not found." }); return; }
  const { name, targetAmount, targetDate, status } = req.body ?? {};
  if (name !== undefined && (typeof name !== "string" || !name.trim() || name.trim().length > 120)) { res.status(400).json({ error: "Goal name must be between 1 and 120 characters." }); return; }
  if (status !== undefined && !["active", "paused"].includes(status)) { res.status(400).json({ error: "Goals can be active or paused. Completed goals update from recorded progress." }); return; }
  const targetUnits = targetAmount === undefined ? null : accountingAmountToUnits(targetAmount);
  if (targetAmount !== undefined && (targetUnits === null || targetUnits <= 0n)) { res.status(400).json({ error: "Target amount must be positive and use up to 36 decimal places." }); return; }
  let target = undefined as Date | null | undefined;
  if (targetDate !== undefined) {
    if (targetDate === null || targetDate === "") target = null;
    else if (typeof targetDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(targetDate) && !Number.isNaN(Date.parse(`${targetDate}T00:00:00.000Z`))) {
      target = new Date(`${targetDate}T00:00:00.000Z`);
      if (target.toISOString().slice(0, 10) !== targetDate) { res.status(400).json({ error: "Use a valid target date." }); return; }
    } else { res.status(400).json({ error: "Use a valid target date." }); return; }
  }
  try {
    const goal = await db.transaction(async (tx) => {
      const [saved] = await tx.select().from(savingsGoalsTable).where(and(eq(savingsGoalsTable.id, req.params.goalId), eq(savingsGoalsTable.workspaceId, req.trezuWorkspaceId!))).for("update").limit(1);
      if (!saved) return null;
      const [sumRow] = await tx.select({ amount: sql<string>`coalesce(sum(${savingsGoalContributionsTable.amount}), 0)::text` }).from(savingsGoalContributionsTable).where(eq(savingsGoalContributionsTable.goalId, saved.id));
      const progress = accountingAmountToUnits(sumRow?.amount ?? "0") ?? 0n;
      const nextTarget = targetUnits ?? accountingAmountToUnits(saved.targetAmount) ?? 0n;
      const nextStatus = progress >= nextTarget ? "completed" : status ?? (saved.status === "paused" ? "paused" : "active");
      const [updated] = await tx.update(savingsGoalsTable).set({ name: typeof name === "string" ? name.trim() : saved.name,
        targetAmount: targetUnits !== null ? accountingUnitsToAmount(targetUnits) : saved.targetAmount,
        targetDate: target !== undefined ? target : saved.targetDate, status: nextStatus, updatedAt: new Date() }).where(eq(savingsGoalsTable.id, saved.id)).returning();
      await tx.insert(auditLogsTable).values({ workspaceId: saved.workspaceId, actorUserId: req.trezuUserId!, action: "treasury.savings_goal_updated", entityType: "savings_goal", entityId: saved.id, metadata: { name: updated!.name, currency: saved.currency, targetAmount: updated!.targetAmount, status: updated!.status } });
      return updated!;
    });
    if (!goal) { res.status(404).json({ error: "Savings goal not found." }); return; }
    res.json(goal);
  } catch { res.status(503).json({ error: "Savings goal could not be updated." }); }
});

router.post("/treasury/savings-goals/:goalId/contributions", requireWorkspaceMember, requireWorkspaceRole("owner", "admin"), async (req, res): Promise<void> => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.goalId)) { res.status(404).json({ error: "Savings goal not found." }); return; }
  const { allocationEventId, amount } = req.body ?? {};
  const requestedUnits = accountingAmountToUnits(amount);
  const idempotencyKey = req.get("Idempotency-Key");
  if (typeof allocationEventId !== "string" || !/^[0-9a-f-]{36}$/i.test(allocationEventId) || requestedUnits === null || requestedUnits <= 0n || !idempotencyKey || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    res.status(400).json({ error: "Choose an available savings allocation, enter a positive amount, and provide a valid Idempotency-Key." }); return;
  }
  try {
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(savingsGoalContributionsTable).where(and(eq(savingsGoalContributionsTable.workspaceId, req.trezuWorkspaceId!), eq(savingsGoalContributionsTable.idempotencyKey, idempotencyKey))).limit(1);
      if (existing) {
        if (existing.goalId !== req.params.goalId || existing.allocationEventId !== allocationEventId || accountingAmountToUnits(existing.amount) !== requestedUnits) throw new AllocationConflictError("This Idempotency-Key was already used for a different savings contribution.");
        return { contribution: existing, alreadyRecorded: true };
      }
      const [goal] = await tx.select().from(savingsGoalsTable).where(and(eq(savingsGoalsTable.id, req.params.goalId), eq(savingsGoalsTable.workspaceId, req.trezuWorkspaceId!))).for("update").limit(1);
      if (!goal || goal.status !== "active") throw new AllocationConflictError("Choose an active savings goal.");
      const [racedIdempotent] = await tx.select().from(savingsGoalContributionsTable).where(and(eq(savingsGoalContributionsTable.workspaceId, req.trezuWorkspaceId!), eq(savingsGoalContributionsTable.idempotencyKey, idempotencyKey))).limit(1);
      if (racedIdempotent) {
        if (racedIdempotent.goalId !== req.params.goalId || racedIdempotent.allocationEventId !== allocationEventId || accountingAmountToUnits(racedIdempotent.amount) !== requestedUnits) throw new AllocationConflictError("This Idempotency-Key was already used for a different savings contribution.");
        return { contribution: racedIdempotent, alreadyRecorded: true };
      }
      const [source] = await tx.select().from(treasuryAllocationEventsTable).where(and(eq(treasuryAllocationEventsTable.id, allocationEventId), eq(treasuryAllocationEventsTable.workspaceId, req.trezuWorkspaceId!))).for("update").limit(1);
      if (!source || source.currency !== goal.currency) throw new AllocationConflictError("Choose a saved savings allocation in the same currency as the goal.");
      const [usedFromSource] = await tx.select({ amount: sql<string>`coalesce(sum(${savingsGoalContributionsTable.amount}), 0)::text` }).from(savingsGoalContributionsTable).where(eq(savingsGoalContributionsTable.allocationEventId, source.id));
      const sourceSavingsUnits = accountingAmountToUnits(source.savingsAmount) ?? 0n;
      const usedSourceUnits = accountingAmountToUnits(usedFromSource?.amount ?? "0") ?? 0n;
      if (requestedUnits > sourceSavingsUnits - usedSourceUnits) throw new AllocationConflictError("This savings allocation does not have enough unassigned value for that contribution.");
      const [goalProgress] = await tx.select({ amount: sql<string>`coalesce(sum(${savingsGoalContributionsTable.amount}), 0)::text` }).from(savingsGoalContributionsTable).where(eq(savingsGoalContributionsTable.goalId, goal.id));
      const currentUnits = accountingAmountToUnits(goalProgress?.amount ?? "0") ?? 0n;
      const targetUnits = accountingAmountToUnits(goal.targetAmount) ?? 0n;
      if (requestedUnits > targetUnits - currentUnits) throw new AllocationConflictError("This contribution is larger than the goal's remaining amount.");
      const contributionAmount = accountingUnitsToAmount(requestedUnits);
      const now = new Date();
      const [ledger] = await tx.insert(ledgerTransactionsTable).values({ workspaceId: req.trezuWorkspaceId!, idempotencyKey: `savings-goal:${idempotencyKey}`, type: "treasury_allocation", status: "confirmed", provider: "trezu_internal", createdBy: req.trezuUserId!, confirmedAt: now }).returning();
      await tx.insert(ledgerEntriesTable).values([
        { transactionId: ledger!.id, workspaceId: req.trezuWorkspaceId!, accountCode: "savings_reserve", side: "debit", amount: contributionAmount, currency: goal.currency },
        { transactionId: ledger!.id, workspaceId: req.trezuWorkspaceId!, accountCode: `savings_goal:${goal.id}`, side: "credit", amount: contributionAmount, currency: goal.currency },
      ]);
      const [contribution] = await tx.insert(savingsGoalContributionsTable).values({ workspaceId: req.trezuWorkspaceId!, goalId: goal.id, allocationEventId: source.id, ledgerTransactionId: ledger!.id, idempotencyKey, amount: contributionAmount, recordedBy: req.trezuUserId! }).returning();
      const completed = currentUnits + requestedUnits >= targetUnits;
      await tx.update(savingsGoalsTable).set({ status: completed ? "completed" : goal.status, updatedAt: now }).where(eq(savingsGoalsTable.id, goal.id));
      await tx.insert(auditLogsTable).values({ workspaceId: req.trezuWorkspaceId!, actorUserId: req.trezuUserId!, action: "treasury.savings_goal_contribution_recorded", entityType: "savings_goal", entityId: goal.id, metadata: { contributionId: contribution!.id, amount: contributionAmount, currency: goal.currency, allocationEventId: source.id, movement: "internal_ledger_only" } });
      return { contribution: contribution!, alreadyRecorded: false };
    });
    res.status(result.alreadyRecorded ? 200 : 201).json({ ...result, movementStatus: allocationMovementStatus(result.event) });
  } catch (error) {
    if (error instanceof AllocationConflictError) res.status(409).json({ error: error.message });
    else if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      const [prior] = await db.select().from(savingsGoalContributionsTable).where(and(eq(savingsGoalContributionsTable.workspaceId, req.trezuWorkspaceId!), eq(savingsGoalContributionsTable.idempotencyKey, idempotencyKey))).limit(1);
      if (prior && prior.goalId === req.params.goalId && prior.allocationEventId === allocationEventId && accountingAmountToUnits(prior.amount) === requestedUnits) {
        res.status(200).json({ contribution: prior, alreadyRecorded: true, movementStatus: "internal_ledger_only" }); return;
      }
      if (prior) { res.status(409).json({ error: "This Idempotency-Key was already used for a different savings contribution." }); return; }
      res.status(503).json({ error: "Savings goal contribution could not be recorded. Try again shortly." });
    } else res.status(503).json({ error: "Savings goal contribution could not be recorded. Try again shortly." });
  }
});

export default router;
