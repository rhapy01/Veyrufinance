import { createInsertSchema } from "drizzle-zod";
import { boolean, index, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { workspacesTable } from "./workspaces";
import { usersTable } from "./users";

export const payFrequencyEnum = pgEnum("trezu_pay_frequency", [
  "weekly",
  "biweekly",
  "monthly",
]);

export const employeesTable = pgTable("trezu_employees", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspacesTable.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  country: text("country").notNull().default(""),
  position: text("position").notNull().default(""),
  compensationAmount: numeric("compensation_amount", {
    precision: 24,
    scale: 6,
  }).notNull(),
  compensationCurrency: text("compensation_currency").notNull(),
  payFrequency: payFrequencyEnum("pay_frequency").notNull(),
  preferredStablecoin: text("preferred_stablecoin").notNull(),
  preferredNetwork: text("preferred_network").notNull(),
  walletAddress: text("wallet_address"),
  payrollEnabled: boolean("payroll_enabled").notNull().default(true),
  payoutProfileCompleted: boolean("payout_profile_completed").notNull().default(false),
  active: boolean("active").notNull().default(true),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  uniqueIndex("trezu_employees_workspace_email_unique").on(table.workspaceId, table.email),
  index("trezu_employees_user_active_idx").on(table.userId, table.active),
]);

export const insertEmployeeSchema = createInsertSchema(employeesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertEmployee = typeof employeesTable.$inferInsert;
export type Employee = typeof employeesTable.$inferSelect;
