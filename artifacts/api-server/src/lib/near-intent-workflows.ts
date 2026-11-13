import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import {
  auditLogsTable,
  db,
  invoicesTable,
  ledgerEntriesTable,
  ledgerTransactionsTable,
  nearIntentQuotesTable,
  type NearIntentQuote,
  payrollCyclesTable,
  payrollItemsTable,
  payableBillsTable,
  usersTable,
  workspacesTable,
} from "@workspace/db";
import { getQuoteStatus, getSupportedAssets, NearIntentsError, requestQuote, verifyProviderQuote } from "./near-intents";
import { applyAutomaticIncomeAllocation } from "./automatic-income-allocation";
import { invoiceCurrencyMatchesAsset } from "./invoice-currency";
import { logger } from "./logger";
import { emailDeliveryConfigured, sendInvoicePaymentEmail } from "./auth-email";

let monitoring = false;

/** Refresh open provider routes in the background so settlement does not depend on a payer staying on checkout. */
export async function reconcileOpenNearIntentQuotes(): Promise<void> {
  if (monitoring) return;
  monitoring = true;
  try {
    const now = Date.now();
    const openQuotes = await db.select().from(nearIntentQuotesTable).where(and(
      isNotNull(nearIntentQuotesTable.providerReference),
      inArray(nearIntentQuotesTable.providerStatus, ["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "INCOMPLETE_DEPOSIT", "PROCESSING"]),
    )).orderBy(asc(nearIntentQuotesTable.createdAt)).limit(100);
    let refreshed = 0;
    for (const payment of openQuotes) {
      const age = now - payment.createdAt.getTime();
      if (age > 7 * 24 * 60 * 60_000) continue;
      const interval = payment.providerStatus === "PENDING_DEPOSIT"
        ? age < 10 * 60_000 ? 20_000 : age < 60 * 60_000 ? 60_000 : 5 * 60_000
        : age < 2 * 60_000 ? 10_000 : 30_000;
      if (payment.statusCheckedAt && now - payment.statusCheckedAt.getTime() < interval) continue;
      try {
        await refreshSavedQuoteStatus(payment, payment.createdBy);
        refreshed += 1;
      } catch (error) {
        logger.warn({ paymentId: payment.id, error: error instanceof Error ? error.message : "unknown provider status error" }, "NEAR Intents status refresh failed");
      }
    }
    await deliverPendingInvoicePaymentEmails();
    if (refreshed > 0) logger.info({ refreshed }, "Refreshed open NEAR Intents payments");
  } catch (error) {
    logger.error({ err: error }, "NEAR Intents payment monitor failed");
  } finally {
    monitoring = false;
  }
}

async function deliverPendingInvoicePaymentEmails(): Promise<void> {
  if (!emailDeliveryConfigured()) return;
  const pending = await db.select({
    paymentId: nearIntentQuotesTable.id,
    amount: nearIntentQuotesTable.quotePayload,
    invoiceId: invoicesTable.id,
    invoiceNumber: invoicesTable.invoiceNumber,
    invoiceAmount: invoicesTable.amount,
    currency: invoicesTable.currency,
    invoiceStatus: invoicesTable.status,
    paymentLinkToken: invoicesTable.publicToken,
    senderEmail: invoicesTable.senderEmail,
    creatorId: invoicesTable.createdBy,
    creatorEmail: usersTable.email,
    creatorName: usersTable.name,
    workspaceName: workspacesTable.name,
    workspaceId: invoicesTable.workspaceId,
  }).from(nearIntentQuotesTable)
    .innerJoin(invoicesTable, eq(nearIntentQuotesTable.invoiceId, invoicesTable.id))
    .leftJoin(usersTable, sql`${usersTable.id}::text = ${invoicesTable.createdBy}`)
    .innerJoin(workspacesTable, eq(workspacesTable.id, invoicesTable.workspaceId))
    .where(and(eq(nearIntentQuotesTable.providerStatus, "SUCCESS"), eq(nearIntentQuotesTable.reconciliationStatus, "matched_invoice")))
    .orderBy(asc(nearIntentQuotesTable.settledAt)).limit(50);
  for (const row of pending) {
    const notificationEmail = row.creatorEmail || row.senderEmail;
    if (!notificationEmail) continue;
    const [alreadySent] = await db.select({ id: auditLogsTable.id }).from(auditLogsTable).where(and(
      eq(auditLogsTable.action, "invoice.payment_notification_sent"), eq(auditLogsTable.entityId, row.paymentId),
    )).limit(1);
    if (alreadySent) continue;
    const payload = row.amount && typeof row.amount === "object" ? row.amount as Record<string, unknown> : {};
    const quote = payload.quote && typeof payload.quote === "object" ? payload.quote as Record<string, unknown> : {};
    const amount = typeof quote.amountOutFormatted === "string" ? quote.amountOutFormatted : null;
    if (!amount) continue;
    const invoicePayments = await db.select({ quotePayload: nearIntentQuotesTable.quotePayload }).from(nearIntentQuotesTable).where(and(
      eq(nearIntentQuotesTable.invoiceId, row.invoiceId), eq(nearIntentQuotesTable.providerStatus, "SUCCESS"), eq(nearIntentQuotesTable.reconciliationStatus, "matched_invoice"),
    ));
    const paid = invoicePayments.reduce((sum, item) => {
      const saved = item.quotePayload as Record<string, unknown> | null;
      const savedQuote = saved?.quote && typeof saved.quote === "object" ? saved.quote as Record<string, unknown> : {};
      const value = typeof savedQuote.amountOutFormatted === "string" ? savedQuote.amountOutFormatted : "0";
      return sum + (/^\d+(?:\.\d+)?$/.test(value) ? paymentAmountUnits6(value) : 0n);
    }, 0n);
    const total = paymentAmountUnits6(row.invoiceAmount);
    const remaining = total > paid ? total - paid : 0n;
    try {
      const sent = await sendInvoicePaymentEmail({
        email: notificationEmail,
        recipientName: row.creatorName || row.workspaceName,
        businessName: row.workspaceName,
        invoiceNumber: row.invoiceNumber,
        amount,
        currency: row.currency,
        remainingAmount: formatUnits6(remaining),
        invoiceUrl: row.creatorEmail
          ? `${(process.env.WEB_APP_URL || "http://localhost:5173").replace(/\/$/, "")}/app/invoices/${row.invoiceId}`
          : `${(process.env.WEB_APP_URL || "http://localhost:5173").replace(/\/$/, "")}/pay/${row.paymentLinkToken}`,
      });
      if (!sent) continue;
      await db.insert(auditLogsTable).values({
        workspaceId: row.workspaceId,
        actorUserId: row.creatorId,
        action: "invoice.payment_notification_sent",
        entityType: "invoice_payment",
        entityId: row.paymentId,
        metadata: { invoiceNumber: row.invoiceNumber, amount, currency: row.currency, remainingAmount: formatUnits6(remaining) },
      });
    } catch (error) {
      logger.warn({ paymentId: row.paymentId, error: error instanceof Error ? error.message : "email delivery failed" }, "Invoice payment notification could not be sent");
    }
  }
}

function paymentAmountUnits6(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction)) return 0n;
  return BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
}

function formatUnits6(value: bigint): string {
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${value / 1_000_000n}.${fraction}` : (value / 1_000_000n).toString();
}

export type QuoteWorkflowInput = {
  workspaceId: string;
  createdBy: string;
  idempotencyKey: string;
  originAsset: string;
  destinationAsset: string;
  amount: string;
  recipient: string;
  refundTo: string;
  slippageTolerance: number;
  swapType?: "EXACT_INPUT" | "EXACT_OUTPUT";
  invoiceId?: string;
  payrollItemId?: string;
  payableBillId?: string;
};

export async function createSavedQuote(input: QuoteWorkflowInput) {
  const [existing] = await db.select().from(nearIntentQuotesTable).where(and(
    eq(nearIntentQuotesTable.workspaceId, input.workspaceId),
    eq(nearIntentQuotesTable.idempotencyKey, input.idempotencyKey),
  )).limit(1);
  if (existing) {
    if (existing.quotePayload) return { paymentId: existing.id, quote: existing.quotePayload, providerStatus: existing.providerStatus };
    throw new NearIntentsError(existing.providerStatus === "REQUESTING" ? "This quote request is still being processed." : "This quote request already failed. Submit a new request to try again.", existing.providerStatus === "REQUESTING" ? 409 : 409);
  }

  const quoteId = randomUUID();
  const [reserved] = await db.insert(nearIntentQuotesTable).values({
    id: quoteId,
    workspaceId: input.workspaceId,
    invoiceId: input.invoiceId ?? null,
    payrollItemId: input.payrollItemId ?? null,
    payableBillId: input.payableBillId ?? null,
    createdBy: input.createdBy,
    idempotencyKey: input.idempotencyKey,
    providerStatus: "REQUESTING",
  }).onConflictDoNothing().returning();
  if (!reserved) {
    const [raced] = await db.select().from(nearIntentQuotesTable).where(and(
      eq(nearIntentQuotesTable.workspaceId, input.workspaceId),
      eq(nearIntentQuotesTable.idempotencyKey, input.idempotencyKey),
    )).limit(1);
    if (raced?.quotePayload) return { paymentId: raced.id, quote: raced.quotePayload, providerStatus: raced.providerStatus };
    throw new NearIntentsError("This quote request is already being processed. Try again shortly.", 409);
  }

  try {
    const supportedAssets = await getSupportedAssets();
    const destinationAsset = supportedAssets.find((asset) => asset.assetId === input.destinationAsset);
    const originAsset = supportedAssets.find((asset) => asset.assetId === input.originAsset);
    if (!destinationAsset || !originAsset) throw new NearIntentsError("A selected asset is no longer supported by NEAR Intents.", 400);
    const quote = await requestQuote(input);
    const response = quote as Record<string, unknown>;
    const details = response.quote && typeof response.quote === "object" ? response.quote as Record<string, unknown> : {};
    if (typeof details.depositAddress !== "string" || !details.depositAddress) {
      throw new NearIntentsError("The signed quote did not include a deposit address.", 502);
    }
    const [saved] = await db.transaction(async (tx) => {
      const result = await tx.update(nearIntentQuotesTable).set({
        providerReference: details.depositAddress as string,
        originAsset: input.originAsset,
        destinationAsset: input.destinationAsset,
        originAssetSymbol: originAsset.symbol,
        originAssetNetwork: originAsset.blockchain,
        originAssetDecimals: originAsset.decimals,
        destinationAssetSymbol: destinationAsset.symbol,
        destinationAssetNetwork: destinationAsset.blockchain,
        destinationAssetDecimals: destinationAsset.decimals,
        quotePayload: response,
        providerStatus: "PENDING_DEPOSIT",
      }).where(eq(nearIntentQuotesTable.id, quoteId)).returning();
      await tx.insert(auditLogsTable).values({
        workspaceId: input.workspaceId,
        actorUserId: input.createdBy,
        action: input.invoiceId ? "invoice.payment_quote_created" : input.payrollItemId ? "payroll.payment_quote_created" : input.payableBillId ? "payable.payment_quote_created" : "payment.quote_created",
        entityType: input.invoiceId ? "invoice_payment_quote" : input.payrollItemId ? "payroll_payment_quote" : input.payableBillId ? "payable_bill_payment_quote" : "near_intent_quote",
        entityId: quoteId,
        metadata: { provider: "near_intents", providerStatus: "PENDING_DEPOSIT", invoiceId: input.invoiceId ?? null, payrollItemId: input.payrollItemId ?? null, payableBillId: input.payableBillId ?? null },
      });
      return result;
    });
    return { paymentId: saved!.id, quote: saved!.quotePayload, providerStatus: saved!.providerStatus };
  } catch (error) {
    await db.update(nearIntentQuotesTable).set({
      providerStatus: "QUOTE_FAILED",
      lastError: error instanceof Error ? error.message.slice(0, 500) : "Provider quote failed",
    }).where(eq(nearIntentQuotesTable.id, quoteId));
    throw error;
  }
}

function transactionHashFromProvider(value: Record<string, unknown>): string | null {
  const swap = value.swapDetails && typeof value.swapDetails === "object" ? value.swapDetails as Record<string, unknown> : {};
  const hashes = [swap.destinationChainTxHashes, swap.nearTxHashes, swap.originChainTxHashes].flatMap((entry) => Array.isArray(entry) ? entry : []);
  for (const item of hashes) {
    const hash = typeof item === "string" ? item : item && typeof item === "object" ? (item as Record<string, unknown>).hash : null;
    if (typeof hash === "string" && hash.length > 0 && hash.length <= 200) return hash;
  }
  return null;
}

async function refreshPayrollQuoteStatus(payment: NearIntentQuote, actorUserId: string, providerResult: unknown, rawStatus: string) {
  const now = new Date();
  let reconciliationStatus = "pending_payroll";
  await db.transaction(async (tx) => {
    if (!payment.payrollItemId) throw new NearIntentsError("This payroll quote is no longer linked to an employee payment.", 409);
    const [item] = await tx.select().from(payrollItemsTable).where(and(eq(payrollItemsTable.id, payment.payrollItemId), eq(payrollItemsTable.workspaceId, payment.workspaceId))).for("update").limit(1);
    if (!item) throw new NearIntentsError("The payroll item for this quote could not be found.", 404);
    const [cycle] = await tx.select().from(payrollCyclesTable).where(and(eq(payrollCyclesTable.id, item.cycleId), eq(payrollCyclesTable.workspaceId, item.workspaceId))).for("update").limit(1);
    if (!cycle) throw new NearIntentsError("The payroll cycle for this quote could not be found.", 404);
    const [lockedPayment] = await tx.select().from(nearIntentQuotesTable).where(and(eq(nearIntentQuotesTable.id, payment.id), eq(nearIntentQuotesTable.payrollItemId, item.id), eq(nearIntentQuotesTable.workspaceId, item.workspaceId))).for("update").limit(1);
    if (!lockedPayment) throw new NearIntentsError("This payroll quote is no longer linked to this employee payment.", 409);

    let itemStatus: "processing" | "pending_settlement" | "paid" | "failed" = "pending_settlement";
    let failureReason: string | null = null;
    if (rawStatus === "PROCESSING" || rawStatus === "KNOWN_DEPOSIT_TX") itemStatus = "processing";
    if (rawStatus === "FAILED" || rawStatus === "REFUNDED") {
      itemStatus = "failed";
      failureReason = rawStatus === "REFUNDED" ? "The provider confirmed that the payment was refunded." : "The provider reported that this payment failed.";
    }
    if (rawStatus === "INCOMPLETE_DEPOSIT") failureReason = "The provider detected an incomplete deposit. Waiting for its final settlement or refund status.";

    if (rawStatus === "SUCCESS") {
      const payload = lockedPayment.quotePayload as Record<string, unknown> | null;
      const quote = payload?.quote && typeof payload.quote === "object" ? payload.quote as Record<string, unknown> : {};
      const request = payload?.quoteRequest && typeof payload.quoteRequest === "object" ? payload.quoteRequest as Record<string, unknown> : {};
      const received = typeof quote.amountOutFormatted === "string" ? quote.amountOutFormatted : null;
      const matches = !!received && !!item.walletAddress &&
        decimalKey(received) === decimalKey(item.payoutAmount ?? item.amount) &&
        lockedPayment.destinationAssetSymbol === item.stablecoin &&
        lockedPayment.destinationAssetNetwork?.toLowerCase() === item.network.toLowerCase() &&
        request.recipient === item.walletAddress && request.destinationAsset === lockedPayment.destinationAsset &&
        request.swapType === "EXACT_OUTPUT";
      reconciliationStatus = matches ? "matched_payroll" : "unmatched_payroll";
      itemStatus = matches ? "paid" : "failed";
      failureReason = matches ? null : "The provider confirmed settlement, but the received asset, amount, network, or employee address did not match the approved payroll item.";

      const amount = matches ? received! : (received && decimalKey(received) ? received : null);
      if (amount && lockedPayment.destinationAssetSymbol) {
        const idempotencyKey = `payroll-payout:${lockedPayment.id}`;
        const [ledger] = await tx.insert(ledgerTransactionsTable).values({
          workspaceId: lockedPayment.workspaceId,
          idempotencyKey,
          type: "payment_out",
          status: "confirmed",
          provider: "near_intents",
          providerReference: lockedPayment.providerReference,
          createdBy: lockedPayment.createdBy,
          confirmedAt: now,
        }).onConflictDoNothing().returning();
        if (ledger) await tx.insert(ledgerEntriesTable).values([
          { transactionId: ledger.id, workspaceId: lockedPayment.workspaceId, accountCode: matches ? "payroll_expense" : "payroll_suspense", side: "debit", amount, currency: lockedPayment.destinationAssetSymbol },
          { transactionId: ledger.id, workspaceId: lockedPayment.workspaceId, accountCode: "payroll_settlement_clearing", side: "credit", amount, currency: lockedPayment.destinationAssetSymbol },
        ]);
      }
      const provider = providerResult && typeof providerResult === "object" ? providerResult as Record<string, unknown> : {};
      const transactionReference = transactionHashFromProvider(provider);
      await tx.update(payrollItemsTable).set({
        status: itemStatus,
        failureReason,
        providerReference: transactionReference,
        updatedAt: now,
      }).where(eq(payrollItemsTable.id, item.id));
      await tx.insert(auditLogsTable).values({
        workspaceId: item.workspaceId,
        actorUserId: actorUserId || lockedPayment.createdBy,
        action: matches ? "payroll.employee_payment_confirmed" : "payroll.employee_payment_mismatch",
        entityType: "payroll_item",
        entityId: item.id,
        metadata: { paymentId: lockedPayment.id, providerStatus: rawStatus, amount, currency: lockedPayment.destinationAssetSymbol, transactionReference, reconciliationStatus },
      });
    } else {
      await tx.update(payrollItemsTable).set({ status: itemStatus, failureReason, updatedAt: now }).where(eq(payrollItemsTable.id, item.id));
    }

    await tx.update(nearIntentQuotesTable).set({
      providerStatus: rawStatus,
      providerStatusPayload: providerResult as Record<string, unknown>,
      reconciliationStatus,
      statusCheckedAt: now,
      settledAt: rawStatus === "SUCCESS" ? (lockedPayment.settledAt ?? now) : lockedPayment.settledAt,
    }).where(eq(nearIntentQuotesTable.id, lockedPayment.id));
    const items = await tx.select({ status: payrollItemsTable.status }).from(payrollItemsTable).where(eq(payrollItemsTable.cycleId, cycle.id));
    const paid = items.filter((row) => row.status === "paid").length;
    const failed = items.filter((row) => row.status === "failed").length;
    const terminal = paid + failed === items.length;
    const cycleStatus = terminal
      ? failed === 0 ? "completed" as const : paid > 0 ? "partially_failed" as const : "failed" as const
      : items.some((row) => row.status !== "queued") ? "processing" as const : cycle.status;
    await tx.update(payrollCyclesTable).set({ status: cycleStatus }).where(eq(payrollCyclesTable.id, cycle.id));
    if (lockedPayment.providerStatus !== rawStatus || lockedPayment.reconciliationStatus !== reconciliationStatus) await tx.insert(auditLogsTable).values({
      workspaceId: lockedPayment.workspaceId,
      actorUserId: actorUserId || lockedPayment.createdBy,
      action: rawStatus === "SUCCESS" ? "payroll.payment_provider_settled" : "payroll.payment_status_updated",
      entityType: "payroll_payment_quote",
      entityId: lockedPayment.id,
      metadata: { payrollItemId: item.id, providerStatus: rawStatus, reconciliationStatus, itemStatus, cycleStatus },
    });
  });
  return { paymentId: payment.id, status: rawStatus, reconciliationStatus, updatedAt: now.toISOString(), provider: providerResult };
}

function decimalKey(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,36})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return `${whole.replace(/^0+(?=\d)/, "")}.${fraction.replace(/0+$/, "")}`.replace(/\.$/, "");
}

function amountUnits6(value: string): bigint | null {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function signedQuoteFromStatus(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return null;
  const value = (result as Record<string, unknown>).quoteResponse;
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

export async function refreshSavedQuoteStatus(payment: NearIntentQuote, actorUserId: string) {
  if (!payment.providerReference || !payment.quotePayload) throw new NearIntentsError("This quote has no saved provider deposit reference.", 409);
  const providerResult = await getQuoteStatus(payment.providerReference);
  const provider = providerResult && typeof providerResult === "object" ? providerResult as Record<string, unknown> : {};
  const echoedQuote = signedQuoteFromStatus(providerResult);
  if (!echoedQuote || !verifyProviderQuote(echoedQuote) || echoedQuote.signature !== payment.quotePayload.signature) {
    throw new NearIntentsError("The status response did not match the signed quote saved for this payment.", 502);
  }
  const rawStatus = typeof provider.status === "string" ? provider.status : payment.providerStatus;
  if (payment.payrollItemId) return refreshPayrollQuoteStatus(payment, actorUserId, providerResult, rawStatus);
  if (payment.payableBillId) return refreshPayableBillQuoteStatus(payment, actorUserId, provider, rawStatus);
  const now = new Date();
  let reconciliationStatus: string | null = null;
  await db.transaction(async (tx) => {
    if (rawStatus === "SUCCESS") {
      const [lockedPayment] = await tx.select().from(nearIntentQuotesTable).where(eq(nearIntentQuotesTable.id, payment.id)).for("update").limit(1);
      const payload = payment.quotePayload as Record<string, unknown>;
      const quoteDetails = payload.quote && typeof payload.quote === "object" ? payload.quote as Record<string, unknown> : {};
      const amountOut = typeof quoteDetails.amountOutFormatted === "string" ? quoteDetails.amountOutFormatted : null;
      const assetId = payment.destinationAsset;
      const destinationAsset = payment.destinationAssetSymbol ? { symbol: payment.destinationAssetSymbol } : null;
      if (!amountOut || !assetId || !destinationAsset || !decimalKey(amountOut) || decimalKey(amountOut) === "0") {
        reconciliationStatus = payment.invoiceId ? "unmatched_invoice" : "unmatched_payment";
      } else {
        const [invoice] = payment.invoiceId ? await tx.select().from(invoicesTable).where(eq(invoicesTable.id, payment.invoiceId)).for("update").limit(1) : [];
        const quoteRequest = payload.quoteRequest && typeof payload.quoteRequest === "object" ? payload.quoteRequest as Record<string, unknown> : {};
        const invoiceMatches = !!invoice && invoice.paymentAssetId === assetId &&
          invoice.paymentRecipient === quoteRequest.recipient && invoiceCurrencyMatchesAsset(invoice.currency, destinationAsset.symbol);
        let invoicePaymentStatus: "partially_paid" | "paid" | null = null;
        if (invoice) {
          const totalUnits = amountUnits6(invoice.amount);
          const paymentUnits = amountUnits6(amountOut);
          if (invoiceMatches && totalUnits !== null && paymentUnits !== null && paymentUnits > 0n) {
            const previousPayments = await tx.select({ quotePayload: nearIntentQuotesTable.quotePayload }).from(nearIntentQuotesTable).where(and(
              eq(nearIntentQuotesTable.invoiceId, invoice.id), eq(nearIntentQuotesTable.providerStatus, "SUCCESS"),
              eq(nearIntentQuotesTable.reconciliationStatus, "matched_invoice"), ne(nearIntentQuotesTable.id, payment.id),
            ));
            const alreadyPaid = previousPayments.reduce((sum, row) => {
              const priorPayload = row.quotePayload as Record<string, unknown> | null;
              const priorQuote = priorPayload?.quote && typeof priorPayload.quote === "object" ? priorPayload.quote as Record<string, unknown> : {};
              const priorAmount = typeof priorQuote.amountOutFormatted === "string" ? amountUnits6(priorQuote.amountOutFormatted) : null;
              return sum + (priorAmount ?? 0n);
            }, 0n);
            if (alreadyPaid + paymentUnits <= totalUnits) {
              reconciliationStatus = "matched_invoice";
              invoicePaymentStatus = alreadyPaid + paymentUnits >= totalUnits ? "paid" : "partially_paid";
            } else reconciliationStatus = "overpayment";
          } else reconciliationStatus = "unmatched_invoice";
        } else {
          reconciliationStatus = payment.invoiceId ? "unmatched_invoice" : "recorded_payment";
        }

        const ledgerKey = `near-intents:${payment.id}`;
        const [priorLedger] = await tx.select({ id: ledgerTransactionsTable.id }).from(ledgerTransactionsTable).where(and(
          eq(ledgerTransactionsTable.workspaceId, payment.workspaceId),
          eq(ledgerTransactionsTable.idempotencyKey, ledgerKey),
        )).limit(1);
        if (!priorLedger) {
          const [ledger] = await tx.insert(ledgerTransactionsTable).values({
            workspaceId: payment.workspaceId,
            idempotencyKey: ledgerKey,
            type: "payment_in",
            status: "confirmed",
            provider: "near_intents",
            providerReference: payment.providerReference,
            createdBy: payment.createdBy,
            confirmedAt: now,
          }).returning();
          const destinationCurrency = destinationAsset.symbol;
          const creditAccount = reconciliationStatus === "matched_invoice" ? "accounts_receivable"
            : reconciliationStatus === "overpayment" ? "customer_overpayment"
            : reconciliationStatus === "recorded_payment" ? "cross_chain_settlement"
            : "payment_suspense";
          await tx.insert(ledgerEntriesTable).values([
            { transactionId: ledger!.id, workspaceId: payment.workspaceId, accountCode: `wallet:${assetId}`, side: "debit", amount: amountOut, currency: destinationCurrency },
            { transactionId: ledger!.id, workspaceId: payment.workspaceId, accountCode: creditAccount, side: "credit", amount: amountOut, currency: destinationCurrency },
          ]);
        }
        if (invoice && reconciliationStatus === "matched_invoice" && invoicePaymentStatus && invoice.status !== invoicePaymentStatus) {
          await tx.update(invoicesTable).set({ status: invoicePaymentStatus, paidAt: invoicePaymentStatus === "paid" ? now : null }).where(eq(invoicesTable.id, invoice.id));
          await tx.insert(auditLogsTable).values({
            workspaceId: payment.workspaceId,
            actorUserId: actorUserId || invoice.createdBy,
            action: "invoice.payment_confirmed",
            entityType: "invoice",
            entityId: invoice.id,
            metadata: { provider: "near_intents", paymentId: payment.id, amount: amountOut, invoiceTotal: invoice.amount, currency: invoice.currency, invoiceStatus: invoicePaymentStatus },
          });
        }
      }
    }

    await tx.update(nearIntentQuotesTable).set({
      providerStatus: rawStatus,
      providerStatusPayload: providerResult as Record<string, unknown>,
      reconciliationStatus,
      statusCheckedAt: now,
      settledAt: rawStatus === "SUCCESS" ? (payment.settledAt ?? now) : payment.settledAt,
    }).where(eq(nearIntentQuotesTable.id, payment.id));
    if (rawStatus !== payment.providerStatus && ["SUCCESS", "FAILED", "REFUNDED"].includes(rawStatus)) {
      await tx.insert(auditLogsTable).values({
        workspaceId: payment.workspaceId,
        actorUserId,
        action: rawStatus === "SUCCESS" ? "payment.provider_settled" : "payment.provider_failed",
        entityType: payment.invoiceId ? "invoice_payment_quote" : "near_intent_quote",
        entityId: payment.id,
        metadata: { provider: "near_intents", providerStatus: rawStatus, reconciliationStatus },
      });
    }
  });

  const automaticAllocation = rawStatus === "SUCCESS" && reconciliationStatus === "matched_invoice"
    ? await applyAutomaticIncomeAllocation(payment.id)
    : null;
  return { paymentId: payment.id, status: rawStatus, reconciliationStatus, updatedAt: now.toISOString(), provider: providerResult, automaticAllocation };
}

async function refreshPayableBillQuoteStatus(payment: NearIntentQuote, actorUserId: string, providerResult: Record<string, unknown>, rawStatus: string) {
  const now = new Date();
  let reconciliationStatus: string | null = null;
  await db.transaction(async (tx) => {
    const [bill] = await tx.select().from(payableBillsTable).where(and(eq(payableBillsTable.id, payment.payableBillId!), eq(payableBillsTable.workspaceId, payment.workspaceId))).for("update").limit(1);
    if (!bill) throw new NearIntentsError("The vendor bill linked to this payment was not found.", 409);
    if (rawStatus === "SUCCESS") {
      const payload = payment.quotePayload as Record<string, unknown>;
      const details = payload.quote && typeof payload.quote === "object" ? payload.quote as Record<string, unknown> : {};
      const request = payload.quoteRequest && typeof payload.quoteRequest === "object" ? payload.quoteRequest as Record<string, unknown> : {};
      const amountOut = typeof details.amountOutFormatted === "string" ? details.amountOutFormatted : "";
      const matches = payment.destinationAsset === bill.payoutAssetId && request.recipient === bill.recipientAddress && decimalKey(amountOut) === decimalKey(bill.payoutAmount || "");
      reconciliationStatus = matches ? "matched_payable" : "unmatched_payable";
      if (matches && bill.status !== "paid") {
        await tx.update(payableBillsTable).set({ status: "paid", providerReference: payment.providerReference, failureReason: null, updatedAt: now }).where(eq(payableBillsTable.id, bill.id));
        await tx.insert(auditLogsTable).values({ workspaceId: bill.workspaceId, actorUserId: actorUserId || bill.createdBy, action: "payable.bill_payment_confirmed", entityType: "payable_bill", entityId: bill.id, metadata: { paymentId: payment.id, provider: "near_intents", amount: amountOut, asset: bill.payoutAssetSymbol } });
      }
    }
    if (["FAILED", "REFUNDED", "QUOTE_FAILED"].includes(rawStatus) && bill.status !== "paid") {
      await tx.update(payableBillsTable).set({ status: "failed", depositTxHash: null, failureReason: `NEAR Intents status: ${rawStatus}`, updatedAt: now }).where(eq(payableBillsTable.id, bill.id));
    }
    await tx.update(nearIntentQuotesTable).set({ providerStatus: rawStatus, providerStatusPayload: providerResult, reconciliationStatus, statusCheckedAt: now, settledAt: rawStatus === "SUCCESS" ? payment.settledAt ?? now : payment.settledAt }).where(eq(nearIntentQuotesTable.id, payment.id));
  });
  return { paymentId: payment.id, status: rawStatus, reconciliationStatus, updatedAt: now.toISOString(), provider: providerResult, automaticAllocation: null };
}
