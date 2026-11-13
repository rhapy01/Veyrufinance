import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  db,
  employeesTable,
  invoicesTable,
  nearIntentQuotesTable,
  payableBillsTable,
  payrollCyclesTable,
  payrollItemsTable,
  treasuryAllocationEventsTable,
  savingsGoalContributionsTable,
  savingsGoalsTable,
  vendorApplicationsTable,
  usersTable,
  workspacesTable,
} from "@workspace/db";
import { GetRecordsResponse } from "@workspace/api-zod";
import {
  requireWorkspaceMember,
  requireWorkspaceRole,
} from "../../middlewares/auth";

const router: IRouter = Router();

type RecordTransactionLink = { label: string; hash: string; url: string };
type PaymentTransactionSource = {
  providerStatusPayload: unknown;
  originAssetNetwork: string | null;
  originAssetSymbol: string | null;
  destinationAssetNetwork: string | null;
  destinationAssetSymbol: string | null;
};

function recordTransactionLinks(payment: PaymentTransactionSource): RecordTransactionLink[] {
  const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const status = object(payment.providerStatusPayload);
  const swap = object(status.swapDetails);
  const read = (key: "originChainTxHashes" | "destinationChainTxHashes") => {
    const values = swap[key];
    if (!Array.isArray(values)) return [];
    return values.flatMap((value) => {
      const row = object(value);
      const hash = typeof value === "string" ? value : typeof row.hash === "string" ? row.hash : "";
      const url = typeof row.explorerUrl === "string" ? row.explorerUrl : "";
      return hash && url.startsWith("https://") && hash.length <= 200 ? [{ hash, url }] : [];
    });
  };
  const matchesNetwork = (url: string, network: string | null) => {
    if (!network) return false;
    let host = "";
    try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
    const normalized = network.toLowerCase().replace(/[^a-z0-9]/g, "");
    const hostRules: Record<string, string[]> = {
      near: ["nearblocks.io", "explorer.near.org"],
      base: ["basescan.org"],
      ethereum: ["etherscan.io"],
      arbitrum: ["arbiscan.io"],
      optimism: ["optimistic.etherscan.io"],
      polygon: ["polygonscan.com"],
      bsc: ["bscscan.com"],
      avalanche: ["snowtrace.io"],
      solana: ["explorer.solana.com"],
    };
    const rules = hostRules[normalized];
    return rules ? rules.some((rule) => host === rule || host.endsWith(`.${rule}`)) : host.includes(normalized);
  };
  const label = (action: "Sent from" | "Received on", network: string | null, symbol: string | null) =>
    `${action} ${network?.toLowerCase() === "near" ? "NEAR" : network ? network[0]!.toUpperCase() + network.slice(1) : "network"}${symbol ? ` · ${symbol}` : ""}`;
  const origin = read("originChainTxHashes").filter((item) => matchesNetwork(item.url, payment.originAssetNetwork));
  const destinationCandidates = read("destinationChainTxHashes");
  const matchingDestination = destinationCandidates.filter((item) => matchesNetwork(item.url, payment.destinationAssetNetwork));
  // Provider status payloads can include an intermediate NEAR transaction in the destination list.
  // Prefer hashes that belong to the invoice's destination network; otherwise use the final provider hash.
  const destination = matchingDestination.length ? matchingDestination : destinationCandidates.slice(-1);
  const links: RecordTransactionLink[] = [
    ...origin.map((item) => ({ label: label("Sent from", payment.originAssetNetwork, payment.originAssetSymbol), ...item })),
    ...destination.map((item) => ({ label: label("Received on", payment.destinationAssetNetwork, payment.destinationAssetSymbol), ...item })),
  ];
  return links.filter((item, index) => links.findIndex((candidate) => candidate.hash === item.hash && candidate.url === item.url) === index);
}

router.get(
  "/records",
  requireWorkspaceMember,
  requireWorkspaceRole("owner", "admin"),
  async (req, res): Promise<void> => {
    const [user] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, req.trezuUserId!)).limit(1);
    if (!user) { res.status(401).json({ error: "Sign in to view your financial records." }); return; }
    const [invoices, receivedInvoices, employees, applications, payments, receivedPayments, allocations, goalContributions, payrollCycles, payrollPayments] = await Promise.all([
      db
        .select()
        .from(invoicesTable)
        .where(eq(invoicesTable.workspaceId, req.trezuWorkspaceId!))
        .orderBy(desc(invoicesTable.createdAt)),
      db.select({ invoice: invoicesTable, senderName: workspacesTable.name })
        .from(invoicesTable)
        .innerJoin(workspacesTable, eq(invoicesTable.workspaceId, workspacesTable.id))
        .where(and(
          eq(invoicesTable.clientEmail, user.email),
          inArray(invoicesTable.status, ["sent", "viewed", "partially_paid", "paid", "cancelled"]),
        ))
        .orderBy(desc(invoicesTable.sentAt), desc(invoicesTable.createdAt)),
      db
        .select()
        .from(employeesTable)
        .where(eq(employeesTable.workspaceId, req.trezuWorkspaceId!))
        .orderBy(desc(employeesTable.createdAt)),
      db
        .select()
        .from(vendorApplicationsTable)
        .where(eq(vendorApplicationsTable.applicantUserId, req.trezuUserId!))
        .orderBy(desc(vendorApplicationsTable.createdAt)),
      db
        .select()
        .from(nearIntentQuotesTable)
        .where(and(
          eq(nearIntentQuotesTable.workspaceId, req.trezuWorkspaceId!),
          isNull(nearIntentQuotesTable.payrollItemId),
          eq(nearIntentQuotesTable.providerStatus, "SUCCESS"),
        ))
        .orderBy(desc(nearIntentQuotesTable.createdAt)),
      db.select({ payment: nearIntentQuotesTable, invoiceNumber: invoicesTable.invoiceNumber, senderName: workspacesTable.name })
        .from(nearIntentQuotesTable)
        .innerJoin(invoicesTable, eq(nearIntentQuotesTable.invoiceId, invoicesTable.id))
        .innerJoin(workspacesTable, eq(invoicesTable.workspaceId, workspacesTable.id))
        .where(and(
          eq(invoicesTable.clientEmail, user.email),
          eq(nearIntentQuotesTable.providerStatus, "SUCCESS"),
          eq(nearIntentQuotesTable.reconciliationStatus, "matched_invoice"),
          isNull(nearIntentQuotesTable.payrollItemId),
        ))
        .orderBy(desc(nearIntentQuotesTable.settledAt)),
      db.select({ event: treasuryAllocationEventsTable, invoiceNumber: invoicesTable.invoiceNumber })
        .from(treasuryAllocationEventsTable)
        .innerJoin(nearIntentQuotesTable, eq(treasuryAllocationEventsTable.paymentId, nearIntentQuotesTable.id))
        .innerJoin(invoicesTable, eq(nearIntentQuotesTable.invoiceId, invoicesTable.id))
        .where(eq(treasuryAllocationEventsTable.workspaceId, req.trezuWorkspaceId!))
        .orderBy(desc(treasuryAllocationEventsTable.createdAt)),
      db.select({ contribution: savingsGoalContributionsTable, goalName: savingsGoalsTable.name, currency: savingsGoalsTable.currency, invoiceNumber: invoicesTable.invoiceNumber })
        .from(savingsGoalContributionsTable)
        .innerJoin(savingsGoalsTable, eq(savingsGoalContributionsTable.goalId, savingsGoalsTable.id))
        .innerJoin(treasuryAllocationEventsTable, eq(savingsGoalContributionsTable.allocationEventId, treasuryAllocationEventsTable.id))
        .innerJoin(nearIntentQuotesTable, eq(treasuryAllocationEventsTable.paymentId, nearIntentQuotesTable.id))
        .innerJoin(invoicesTable, eq(nearIntentQuotesTable.invoiceId, invoicesTable.id))
        .where(eq(savingsGoalContributionsTable.workspaceId, req.trezuWorkspaceId!))
        .orderBy(desc(savingsGoalContributionsTable.createdAt)),
      db.select().from(payrollCyclesTable)
        .where(eq(payrollCyclesTable.workspaceId, req.trezuWorkspaceId!))
        .orderBy(desc(payrollCyclesTable.createdAt)),
      db.select({ item: payrollItemsTable, employeeName: employeesTable.name, periodEnd: payrollCyclesTable.periodEnd, payment: nearIntentQuotesTable })
        .from(payrollItemsTable).innerJoin(employeesTable, eq(payrollItemsTable.employeeId, employeesTable.id))
        .innerJoin(payrollCyclesTable, eq(payrollItemsTable.cycleId, payrollCyclesTable.id))
        .leftJoin(nearIntentQuotesTable, eq(payrollItemsTable.paymentQuoteId, nearIntentQuotesTable.id))
        .where(eq(payrollItemsTable.workspaceId, req.trezuWorkspaceId!))
        .orderBy(desc(payrollItemsTable.createdAt)),
    ]);

    const records = [
      ...invoices.map((invoice) => ({
        id: invoice.id,
        recordType: "invoice" as const,
        title: `Invoice ${invoice.invoiceNumber} for ${invoice.clientName}`,
        status: invoice.status,
        createdAt: invoice.createdAt,
        transactionLinks: payments.filter((payment) => payment.invoiceId === invoice.id).flatMap(recordTransactionLinks),
      })),
      ...receivedInvoices.filter(({ invoice }) => !invoices.some((ownInvoice) => ownInvoice.id === invoice.id)).map(({ invoice, senderName }) => ({
        id: invoice.id,
        recordType: "invoice" as const,
        title: `Invoice ${invoice.invoiceNumber} from ${senderName}`,
        status: invoice.status,
        createdAt: invoice.createdAt,
        transactionLinks: receivedPayments.filter(({ payment }) => payment.invoiceId === invoice.id).flatMap(({ payment }) => recordTransactionLinks(payment)),
      })),
      ...employees.map((employee) => ({
        id: employee.id,
        recordType: "payroll_profile" as const,
        title: `Payroll profile for ${employee.name}`,
        status: "Compensation setup only",
        createdAt: employee.createdAt,
      })),
      ...applications.map((application) => ({
        id: application.id,
        recordType: "vendor_application" as const,
        title: `Vendor application for ${application.businessName}`,
        status: application.status,
        createdAt: application.createdAt,
      })),
      ...await (async () => {
        const payableIds = payments.map((payment) => payment.payableBillId).filter((id): id is string => Boolean(id));
        const payables = payableIds.length
          ? await db.select().from(payableBillsTable).where(and(eq(payableBillsTable.workspaceId, req.trezuWorkspaceId!), inArray(payableBillsTable.id, payableIds)))
          : [];
        const payableById = new Map(payables.map((bill) => [bill.id, bill]));
        const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]));
        return payments.map((payment) => {
          const payload = payment.quotePayload && typeof payment.quotePayload === "object" ? payment.quotePayload as Record<string, unknown> : {};
          const quote = payload.quote && typeof payload.quote === "object" ? payload.quote as Record<string, unknown> : {};
          const request = payload.quoteRequest && typeof payload.quoteRequest === "object" ? payload.quoteRequest as Record<string, unknown> : {};
          const invoice = payment.invoiceId ? invoiceById.get(payment.invoiceId) : undefined;
          const bill = payment.payableBillId ? payableById.get(payment.payableBillId) : undefined;
          const purpose = invoice ? `Invoice ${invoice.invoiceNumber} · ${invoice.clientName}`
            : bill ? `Vendor invoice ${bill.billNumber} · ${bill.vendorName}`
            : typeof request.recipient === "string" ? `Payment to ${request.recipient}`
            : "Standalone payment";
          const sourceAmount = typeof quote.amountInFormatted === "string" ? quote.amountInFormatted : typeof request.amount === "string" ? request.amount : "Amount not available";
          const targetAmount = typeof quote.amountOutFormatted === "string" ? quote.amountOutFormatted : "Quoted amount unavailable";
          const source = [sourceAmount, payment.originAssetSymbol, payment.originAssetNetwork].filter(Boolean).join(" ");
          const target = [targetAmount, payment.destinationAssetSymbol, payment.destinationAssetNetwork].filter(Boolean).join(" ");
          const deadline = [quote.deadline, quote.timeWhenInactive, request.deadline].find((value) => typeof value === "string") as string | undefined;
          const deadlineMs = deadline ? Date.parse(deadline) : Number.NaN;
          const expiredPendingQuote = payment.providerStatus === "PENDING_DEPOSIT" && Number.isFinite(deadlineMs) && deadlineMs <= Date.now();
          const checkedAfterDeadline = !!payment.statusCheckedAt && Number.isFinite(deadlineMs) && payment.statusCheckedAt.getTime() >= deadlineMs;
          return {
            id: payment.id,
            recordType: "near_intent_payment" as const,
            title: purpose,
            detail: `Sends ${source} → receives ${target}${deadline ? ` · Quote deadline: ${deadline}` : ""}${expiredPendingQuote ? checkedAfterDeadline ? " · Deadline passed; provider’s latest status is still PENDING_DEPOSIT" : " · Deadline passed; refresh provider status" : ""}`,
            quoteId: payment.id,
            depositAddress: typeof quote.depositAddress === "string" ? quote.depositAddress : undefined,
            transactionLinks: recordTransactionLinks(payment),
            status: expiredPendingQuote ? "Quote expired" : payment.providerStatus === "PENDING_DEPOSIT" ? "Waiting for deposit" : payment.providerStatus.replaceAll("_", " "),
            createdAt: payment.createdAt,
          };
        });
      })(),
      ...receivedPayments.filter(({ payment }) => !payments.some((ownPayment) => ownPayment.id === payment.id)).map(({ payment, invoiceNumber, senderName }) => {
        const payload = payment.quotePayload && typeof payment.quotePayload === "object" ? payment.quotePayload as Record<string, unknown> : {};
        const quote = payload.quote && typeof payload.quote === "object" ? payload.quote as Record<string, unknown> : {};
        const sourceAmount = typeof quote.amountInFormatted === "string" ? quote.amountInFormatted : "Amount unavailable";
        const targetAmount = typeof quote.amountOutFormatted === "string" ? quote.amountOutFormatted : "Amount unavailable";
        return {
          id: payment.id,
          recordType: "near_intent_payment" as const,
          title: `Payment to ${senderName} · Invoice ${invoiceNumber}`,
          detail: `Paid ${targetAmount} ${payment.destinationAssetSymbol ?? ""} on ${payment.destinationAssetNetwork ?? ""} using ${sourceAmount} ${payment.originAssetSymbol ?? ""} on ${payment.originAssetNetwork ?? ""}`,
          quoteId: payment.id,
          transactionLinks: recordTransactionLinks(payment),
          status: "Provider confirmed",
          createdAt: payment.settledAt ?? payment.createdAt,
        };
      }),
      ...allocations.map(({ event, invoiceNumber }) => ({
        id: event.id,
        recordType: "treasury_allocation" as const,
        title: `Income allocation for invoice ${invoiceNumber}`,
        status: "Internal ledger only",
        createdAt: event.createdAt,
      })),
      ...goalContributions.map(({ contribution, goalName, currency, invoiceNumber }) => ({
        id: contribution.id,
        recordType: "savings_goal_contribution" as const,
        title: `${currency} contribution to ${goalName} from ${invoiceNumber}`,
        status: "Internal ledger only",
        createdAt: contribution.createdAt,
      })),
      ...payrollCycles.map((cycle) => ({
        id: cycle.id,
        recordType: "payroll_cycle" as const,
        title: `${cycle.frequency} payroll · ${cycle.periodStart} to ${cycle.periodEnd}`,
        status: cycle.status,
        createdAt: cycle.createdAt,
      })),
      ...payrollPayments.map(({ item, employeeName, periodEnd, payment }) => ({
        id: item.id,
        recordType: "payroll_payment" as const,
        title: `Payroll payment for ${employeeName} · pay period ending ${periodEnd}`,
        status: item.status === "paid" ? "Provider confirmed" : item.status.replaceAll("_", " "),
        createdAt: item.updatedAt,
        transactionLinks: payment ? recordTransactionLinks(payment) : [],
      })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    res.json(GetRecordsResponse.parse(records));
  },
);

export default router;
