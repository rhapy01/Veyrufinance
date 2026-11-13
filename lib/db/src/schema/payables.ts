import { createInsertSchema } from "drizzle-zod";
import { boolean, date, index, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { workspacesTable } from "./workspaces";

export const payableBillStatusEnum = pgEnum("trezu_payable_bill_status", ["draft", "submitted", "ready", "processing", "pending_settlement", "paid", "failed", "rejected"]);
export const payableBillsTable = pgTable("trezu_payable_bills", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "cascade" }),
  billNumber: text("bill_number").notNull(),
  vendorName: text("vendor_name").notNull(),
  vendorEmail: text("vendor_email"),
  description: text("description").notNull(),
  amount: numeric("amount", { precision: 24, scale: 6 }).notNull(),
  currency: text("currency").notNull(),
  dueDate: date("due_date"),
  payoutAssetId: text("payout_asset_id"),
  payoutAssetSymbol: text("payout_asset_symbol"),
  payoutNetwork: text("payout_network"),
  recipientAddress: text("recipient_address"),
  status: payableBillStatusEnum("status").notNull().default("draft"),
  payoutAmount: numeric("payout_amount", { precision: 36, scale: 18 }),
  paymentQuoteId: uuid("payment_quote_id"),
  depositTxHash: text("deposit_tx_hash"),
  publicStatusToken: text("public_status_token"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  providerReference: text("provider_reference"),
  failureReason: text("failure_reason"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("trezu_payable_bill_workspace_number_unique").on(table.workspaceId, table.billNumber),
  index("trezu_payable_bill_workspace_status_idx").on(table.workspaceId, table.status),
]);

export const payableIntakeLinksTable = pgTable("trezu_payable_intake_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "cascade" }),
  token: text("token").notNull(),
  active: boolean("active").notNull().default(true),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("trezu_payable_intake_link_token_unique").on(table.token),
  uniqueIndex("trezu_payable_intake_link_workspace_unique").on(table.workspaceId),
  index("trezu_payable_intake_link_active_idx").on(table.workspaceId, table.active),
]);
export const insertPayableBillSchema = createInsertSchema(payableBillsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type PayableBill = typeof payableBillsTable.$inferSelect;
