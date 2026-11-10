import { createInsertSchema } from "drizzle-zod";
import { numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { workspacesTable } from "./workspaces";

export const invoicesTable = pgTable(
  "trezu_invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    invoiceNumber: text("invoice_number").notNull(),
    clientName: text("client_name").notNull(),
    clientEmail: text("client_email"),
    description: text("description").notNull(),
    amount: numeric("amount", { precision: 24, scale: 6 }).notNull(),
    currency: text("currency").notNull(),
    status: text("status").notNull().default("draft"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("trezu_invoices_workspace_number_unique").on(
      table.workspaceId,
      table.invoiceNumber,
    ),
  ],
);

export const insertInvoiceSchema = createInsertSchema(invoicesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertInvoice = typeof invoicesTable.$inferInsert;
export type Invoice = typeof invoicesTable.$inferSelect;
