import { createInsertSchema } from "drizzle-zod";
import { index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { workspacesTable } from "./workspaces";
import { nearIntentQuotesTable } from "./near-intent-quotes";

export const treasuryStrategySettingsTable = pgTable("trezu_treasury_strategy_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "cascade" }),
  aaveBaseSepoliaUsdcPercent: integer("aave_base_sepolia_usdc_percent").notNull().default(0),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("trezu_treasury_strategy_settings_workspace_unique").on(table.workspaceId)]);

export const treasuryStrategyActivityTable = pgTable("trezu_treasury_strategy_activity", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  strategyId: text("strategy_id").notNull(),
  action: text("action").notNull(),
  assetSymbol: text("asset_symbol").notNull(),
  amount: numeric("amount", { precision: 78, scale: 36 }).notNull(),
  walletAddress: text("wallet_address").notNull(),
  transactionHash: text("transaction_hash").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("trezu_treasury_strategy_activity_workspace_created_idx").on(table.workspaceId, table.createdAt),
  uniqueIndex("trezu_treasury_strategy_activity_workspace_tx_unique").on(table.workspaceId, table.transactionHash),
]);

export type TreasuryAllocationRule = { id: string; label: string; percent: number; target: "wallet" | "defi" | "aave"; address?: string; protocolId?: string };

export const treasuryAllocationPlansTable = pgTable("trezu_treasury_allocation_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "cascade" }),
  rules: jsonb("rules").$type<TreasuryAllocationRule[]>().notNull().default([]),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("trezu_treasury_allocation_plans_workspace_unique").on(table.workspaceId)]);

export const treasuryIncomeRunsTable = pgTable("trezu_treasury_income_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "cascade" }),
  paymentId: uuid("payment_id").notNull().references(() => nearIntentQuotesTable.id, { onDelete: "restrict" }),
  createdBy: text("created_by").notNull(),
  sourceAmount: numeric("source_amount", { precision: 78, scale: 36 }).notNull(),
  currency: text("currency").notNull(),
  network: text("network").notNull(),
  ruleSnapshot: jsonb("rule_snapshot").$type<TreasuryAllocationRule[]>().notNull(),
  outputs: jsonb("outputs").$type<{ label: string; target: "wallet" | "defi" | "aave"; address?: string; amount: string; transactionHash?: string }[]>().notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("trezu_treasury_income_runs_workspace_payment_unique").on(table.workspaceId, table.paymentId),
  index("trezu_treasury_income_runs_workspace_created_idx").on(table.workspaceId, table.createdAt),
]);

export const insertTreasuryStrategyActivitySchema = createInsertSchema(treasuryStrategyActivityTable).omit({ id: true, createdAt: true });
export type InsertTreasuryStrategyActivity = typeof treasuryStrategyActivityTable.$inferInsert;
export type TreasuryStrategyActivity = typeof treasuryStrategyActivityTable.$inferSelect;
