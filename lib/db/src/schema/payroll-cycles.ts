import { check, index, integer, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, date } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { employeesTable, payFrequencyEnum } from "./employees";
import { workspacesTable } from "./workspaces";

export const payrollCycleStatusEnum = pgEnum("trezu_payroll_cycle_status", ["draft", "approved", "processing", "completed", "partially_failed", "failed"]);
export const payrollItemStatusEnum = pgEnum("trezu_payroll_item_status", ["queued", "processing", "pending_settlement", "paid", "failed"]);

export const payrollCyclesTable = pgTable("trezu_payroll_cycles", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "restrict" }),
  idempotencyKey: text("idempotency_key").notNull(),
  frequency: payFrequencyEnum("frequency").notNull(),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  paymentDate: date("payment_date").notNull(),
  status: payrollCycleStatusEnum("status").notNull().default("draft"),
  createdBy: text("created_by").notNull(),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("trezu_payroll_cycle_idempotency_unique").on(table.workspaceId, table.idempotencyKey),
  index("trezu_payroll_cycle_workspace_status_idx").on(table.workspaceId, table.status),
  check("trezu_payroll_cycle_period_check", sql`${table.periodEnd} >= ${table.periodStart}`),
]);

export const payrollItemsTable = pgTable("trezu_payroll_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  cycleId: uuid("cycle_id").notNull().references(() => payrollCyclesTable.id, { onDelete: "restrict" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "restrict" }),
  employeeId: uuid("employee_id").notNull().references(() => employeesTable.id, { onDelete: "restrict" }),
  idempotencyKey: text("idempotency_key").notNull(),
  amount: numeric("amount", { precision: 24, scale: 6 }).notNull(),
  currency: text("currency").notNull(),
  payoutAmount: numeric("payout_amount", { precision: 78, scale: 36 }),
  payoutUsdPrice: numeric("payout_usd_price", { precision: 36, scale: 18 }),
  stablecoin: text("stablecoin").notNull(),
  network: text("network").notNull(),
  walletAddress: text("wallet_address"),
  paymentQuoteId: uuid("payment_quote_id"),
  attemptNumber: integer("attempt_number").notNull().default(0),
  status: payrollItemStatusEnum("status").notNull().default("queued"),
  providerReference: text("provider_reference"),
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("trezu_payroll_item_employee_cycle_unique").on(table.cycleId, table.employeeId),
  uniqueIndex("trezu_payroll_item_idempotency_unique").on(table.workspaceId, table.idempotencyKey),
  uniqueIndex("trezu_payroll_item_payment_quote_unique").on(table.paymentQuoteId).where(sql`${table.paymentQuoteId} IS NOT NULL`),
  index("trezu_payroll_item_cycle_status_idx").on(table.cycleId, table.status),
  check("trezu_payroll_item_amount_positive", sql`${table.amount} > 0`),
]);
