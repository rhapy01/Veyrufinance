import { createInsertSchema } from "drizzle-zod";
import { date, index, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { workspacesTable } from "./workspaces";

export type InvoiceLineItem = { description: string; amount: string };

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
    senderEmail: text("sender_email"),
    description: text("description").notNull(),
    lineItems: jsonb("line_items").$type<InvoiceLineItem[]>().notNull().default([]),
    amount: numeric("amount", { precision: 24, scale: 6 }).notNull(),
    currency: text("currency").notNull(),
    dueDate: date("due_date"),
    notes: text("notes"),
    paymentTerms: text("payment_terms"),
    status: text("status").notNull().default("draft"),
    publicToken: text("public_token"),
    paymentAssetId: text("payment_asset_id"),
    paymentRecipient: text("payment_recipient"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
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
    uniqueIndex("trezu_invoices_public_token_unique").on(table.publicToken),
    index("trezu_invoices_workspace_status_idx").on(table.workspaceId, table.status),
  ],
);

export const insertInvoiceSchema = createInsertSchema(invoicesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertInvoice = typeof invoicesTable.$inferInsert;
export type Invoice = typeof invoicesTable.$inferSelect;
