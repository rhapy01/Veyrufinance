import { createInsertSchema } from "drizzle-zod";
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workspacesTable } from "./workspaces";

export const allocationSettingsTable = pgTable(
  "trezu_allocation_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    taxPercent: integer("tax_percent").notNull(),
    savingsPercent: integer("savings_percent").notNull(),
    spendingPercent: integer("spending_percent").notNull(),
    treasuryDestinations: jsonb("treasury_destinations").$type<{ tax: string; savings: string; spending: string }>().notNull().default({ tax: "", savings: "", spending: "" }),
    automationEnabled: boolean("automation_enabled").notNull().default(false),
    internalIncomeAutomationEnabled: boolean("internal_income_automation_enabled").notNull().default(false),
    internalIncomeAutomationUpdatedBy: text("internal_income_automation_updated_by"),
    internalIncomeAutomationUpdatedAt: timestamp("internal_income_automation_updated_at", { withTimezone: true }),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("trezu_allocation_settings_workspace_unique").on(
      table.workspaceId,
    ),
  ],
);

export const insertAllocationSettingsSchema = createInsertSchema(
  allocationSettingsTable,
).omit({
  id: true,
  updatedAt: true,
});
export type InsertAllocationSettings = typeof allocationSettingsTable.$inferInsert;
export type AllocationSettings = typeof allocationSettingsTable.$inferSelect;
