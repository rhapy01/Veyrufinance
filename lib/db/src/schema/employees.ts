import { createInsertSchema } from "drizzle-zod";
import { numeric, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspacesTable } from "./workspaces";

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
  name: text("name").notNull(),
  email: text("email").notNull(),
  compensationAmount: numeric("compensation_amount", {
    precision: 24,
    scale: 6,
  }).notNull(),
  compensationCurrency: text("compensation_currency").notNull(),
  payFrequency: payFrequencyEnum("pay_frequency").notNull(),
  preferredStablecoin: text("preferred_stablecoin").notNull(),
  preferredNetwork: text("preferred_network").notNull(),
  walletAddress: text("wallet_address"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertEmployeeSchema = createInsertSchema(employeesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertEmployee = typeof employeesTable.$inferInsert;
export type Employee = typeof employeesTable.$inferSelect;
