import { and, eq } from "drizzle-orm";
import {
  allocationSettingsTable,
  auditLogsTable,
  db,
  invoicesTable,
  ledgerEntriesTable,
  ledgerTransactionsTable,
  nearIntentQuotesTable,
  treasuryAllocationEventsTable,
} from "@workspace/db";

function amountToUnits(value: unknown, decimals: number): bigint | null {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,41})(?:\.\d{1,36})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) return null;
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
}

function unitsToAmount(value: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${value / scale}${fraction ? `.${fraction}` : ""}`;
}

export async function applyAutomaticIncomeAllocation(paymentId: string) {
  try {
    return await db.transaction(async (tx) => {
      const [payment] = await tx.select().from(nearIntentQuotesTable).where(eq(nearIntentQuotesTable.id, paymentId)).for("update").limit(1);
      if (!payment || payment.providerStatus !== "SUCCESS" || payment.reconciliationStatus !== "matched_invoice" || !payment.invoiceId || payment.destinationAssetDecimals === null || !payment.destinationAssetSymbol) {
        return { status: "ineligible" as const };
      }
      const [settings] = await tx.select().from(allocationSettingsTable).where(eq(allocationSettingsTable.workspaceId, payment.workspaceId)).for("update").limit(1);
      if (!settings?.internalIncomeAutomationEnabled) return { status: "disabled" as const };
      const [existing] = await tx.select({ id: treasuryAllocationEventsTable.id }).from(treasuryAllocationEventsTable).where(and(
        eq(treasuryAllocationEventsTable.workspaceId, payment.workspaceId),
        eq(treasuryAllocationEventsTable.paymentId, payment.id),
      )).limit(1);
      if (existing) return { status: "already_recorded" as const, allocationId: existing.id, movementStatus: "internal_ledger_only" as const };
      if (settings.taxPercent + settings.savingsPercent + settings.spendingPercent !== 100) return { status: "retryable_failure" as const };
      const [invoice] = await tx.select({ status: invoicesTable.status }).from(invoicesTable).where(and(
        eq(invoicesTable.id, payment.invoiceId), eq(invoicesTable.workspaceId, payment.workspaceId),
      )).for("update").limit(1);
      if (!invoice || invoice.status !== "paid") return { status: "ineligible" as const };
      const quote = payment.quotePayload?.quote && typeof payment.quotePayload.quote === "object" ? payment.quotePayload.quote as Record<string, unknown> : {};
      const total = amountToUnits(quote.amountOutFormatted, payment.destinationAssetDecimals);
      if (total === null || total <= 0n) return { status: "retryable_failure" as const };
      const tax = total * BigInt(settings.taxPercent) / 100n;
      const savings = total * BigInt(settings.savingsPercent) / 100n;
      const spending = total - tax - savings;
      const sourceAmount = unitsToAmount(total, payment.destinationAssetDecimals);
      const taxAmount = unitsToAmount(tax, payment.destinationAssetDecimals);
      const savingsAmount = unitsToAmount(savings, payment.destinationAssetDecimals);
      const spendingAmount = unitsToAmount(spending, payment.destinationAssetDecimals);
      const now = new Date();
      const [ledger] = await tx.insert(ledgerTransactionsTable).values({
        workspaceId: payment.workspaceId,
        idempotencyKey: `treasury-allocation:${payment.id}`,
        type: "treasury_allocation",
        status: "confirmed",
        provider: "trezu_internal",
        providerReference: payment.id,
        createdBy: "trezu-system",
        confirmedAt: now,
      }).onConflictDoNothing().returning();
      if (!ledger) {
        const [prior] = await tx.select({ id: treasuryAllocationEventsTable.id }).from(treasuryAllocationEventsTable).where(and(
          eq(treasuryAllocationEventsTable.workspaceId, payment.workspaceId), eq(treasuryAllocationEventsTable.paymentId, payment.id),
        )).limit(1);
        return prior ? { status: "already_recorded" as const, allocationId: prior.id, movementStatus: "internal_ledger_only" as const } : { status: "retryable_failure" as const };
      }
      const entries: (typeof ledgerEntriesTable.$inferInsert)[] = [{ transactionId: ledger.id, workspaceId: payment.workspaceId, accountCode: "accounts_receivable", side: "debit", amount: sourceAmount, currency: payment.destinationAssetSymbol }];
      if (tax > 0n) entries.push({ transactionId: ledger.id, workspaceId: payment.workspaceId, accountCode: "tax_reserve", side: "credit", amount: taxAmount, currency: payment.destinationAssetSymbol });
      if (savings > 0n) entries.push({ transactionId: ledger.id, workspaceId: payment.workspaceId, accountCode: "savings_reserve", side: "credit", amount: savingsAmount, currency: payment.destinationAssetSymbol });
      if (spending > 0n) entries.push({ transactionId: ledger.id, workspaceId: payment.workspaceId, accountCode: "spending_available", side: "credit", amount: spendingAmount, currency: payment.destinationAssetSymbol });
      await tx.insert(ledgerEntriesTable).values(entries);
      const [event] = await tx.insert(treasuryAllocationEventsTable).values({
        workspaceId: payment.workspaceId,
        paymentId: payment.id,
        ledgerTransactionId: ledger.id,
        sourceType: "invoice_payment_automatic",
        currency: payment.destinationAssetSymbol,
        sourceAmount,
        taxPercent: settings.taxPercent,
        taxAmount,
        savingsPercent: settings.savingsPercent,
        savingsAmount,
        spendingPercent: settings.spendingPercent,
        spendingAmount,
        recordedBy: "trezu-system",
      }).returning();
      await tx.insert(auditLogsTable).values({
        workspaceId: payment.workspaceId,
        actorUserId: "trezu-system",
        action: "treasury.internal_income_automation_applied",
        entityType: "treasury_allocation",
        entityId: event!.id,
        metadata: { paymentId: payment.id, sourceAmount, currency: payment.destinationAssetSymbol, taxAmount, savingsAmount, spendingAmount, movement: "internal_ledger_only" },
      });
      return { status: "recorded" as const, allocationId: event!.id, movementStatus: "internal_ledger_only" as const };
    });
  } catch {
    return { status: "retryable_failure" as const };
  }
}
