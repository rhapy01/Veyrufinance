import { createInsertSchema } from "drizzle-zod";
import { index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspacesTable } from "./workspaces";
import { nearIntentQuotesTable } from "./near-intent-quotes";
import { ledgerTransactionsTable } from "./ledger";

export const treasuryAllocationEventsTable = pgTable("trezu_treasury_allocation_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "restrict" }),
  paymentId: uuid("payment_id").notNull().references(() => nearIntentQuotesTable.id, { onDelete: "restrict" }),
  ledgerTransactionId: uuid("ledger_transaction_id").notNull().references(() => ledgerTransactionsTable.id, { onDelete: "restrict" }),
  sourceType: text("source_type").notNull(),
  currency: text("currency").notNull(),
  sourceAmount: numeric("source_amount", { precision: 78, scale: 36 }).notNull(),
  taxPercent: integer("tax_percent").notNull(),
  taxAmount: numeric("tax_amount", { precision: 78, scale: 36 }).notNull(),
  savingsPercent: integer("savings_percent").notNull(),
  savingsAmount: numeric("savings_amount", { precision: 78, scale: 36 }).notNull(),
  spendingPercent: integer("spending_percent").notNull(),
  spendingAmount: numeric("spending_amount", { precision: 78, scale: 36 }).notNull(),
  recordedBy: text("recorded_by").notNull(),
  transferNetwork: text("transfer_network"),
  transferTxHashes: jsonb("transfer_tx_hashes").$type<string[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("trezu_treasury_allocation_workspace_payment_unique").on(table.workspaceId, table.paymentId),
  index("trezu_treasury_allocation_workspace_created_idx").on(table.workspaceId, table.createdAt),
  check("trezu_treasury_allocation_percent_total_check", sql`${table.taxPercent} + ${table.savingsPercent} + ${table.spendingPercent} = 100`),
  check("trezu_treasury_allocation_percent_range_check", sql`${table.taxPercent} BETWEEN 0 AND 100 AND ${table.savingsPercent} BETWEEN 0 AND 100 AND ${table.spendingPercent} BETWEEN 0 AND 100`),
  check("trezu_treasury_allocation_amount_balance_check", sql`${table.taxAmount} + ${table.savingsAmount} + ${table.spendingAmount} = ${table.sourceAmount}`),
  check("trezu_treasury_allocation_amounts_nonnegative_check", sql`${table.sourceAmount} > 0 AND ${table.taxAmount} >= 0 AND ${table.savingsAmount} >= 0 AND ${table.spendingAmount} >= 0`),
]);

export const insertTreasuryAllocationEventSchema = createInsertSchema(treasuryAllocationEventsTable).omit({ id: true, createdAt: true });
export type InsertTreasuryAllocationEvent = typeof treasuryAllocationEventsTable.$inferInsert;
export type TreasuryAllocationEvent = typeof treasuryAllocationEventsTable.$inferSelect;
