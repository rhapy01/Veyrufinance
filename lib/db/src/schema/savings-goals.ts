import { createInsertSchema } from "drizzle-zod";
import { check, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspacesTable } from "./workspaces";
import { treasuryAllocationEventsTable } from "./treasury-allocation-events";
import { ledgerTransactionsTable } from "./ledger";

export const savingsGoalsTable = pgTable("trezu_savings_goals", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  currency: text("currency").notNull(),
  targetAmount: numeric("target_amount", { precision: 78, scale: 36 }).notNull(),
  targetDate: timestamp("target_date", { withTimezone: true }),
  status: text("status").notNull().default("active"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("trezu_savings_goals_workspace_status_idx").on(table.workspaceId, table.status),
  check("trezu_savings_goals_target_positive_check", sql`${table.targetAmount} > 0`),
  check("trezu_savings_goals_status_check", sql`${table.status} IN ('active', 'paused', 'completed')`),
]);

export const savingsGoalContributionsTable = pgTable("trezu_savings_goal_contributions", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "restrict" }),
  goalId: uuid("goal_id").notNull().references(() => savingsGoalsTable.id, { onDelete: "restrict" }),
  allocationEventId: uuid("allocation_event_id").notNull().references(() => treasuryAllocationEventsTable.id, { onDelete: "restrict" }),
  ledgerTransactionId: uuid("ledger_transaction_id").notNull().references(() => ledgerTransactionsTable.id, { onDelete: "restrict" }),
  idempotencyKey: text("idempotency_key").notNull(),
  amount: numeric("amount", { precision: 78, scale: 36 }).notNull(),
  recordedBy: text("recorded_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("trezu_savings_goal_workspace_idempotency_unique").on(table.workspaceId, table.idempotencyKey),
  index("trezu_savings_goal_contributions_goal_created_idx").on(table.goalId, table.createdAt),
  index("trezu_savings_goal_contributions_source_idx").on(table.allocationEventId),
  check("trezu_savings_goal_contribution_amount_positive_check", sql`${table.amount} > 0`),
]);

export const insertSavingsGoalSchema = createInsertSchema(savingsGoalsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertSavingsGoalContributionSchema = createInsertSchema(savingsGoalContributionsTable).omit({ id: true, createdAt: true });
export type InsertSavingsGoal = typeof savingsGoalsTable.$inferInsert;
export type SavingsGoal = typeof savingsGoalsTable.$inferSelect;
export type SavingsGoalContribution = typeof savingsGoalContributionsTable.$inferSelect;
