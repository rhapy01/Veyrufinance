import { createInsertSchema } from "drizzle-zod";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { workspacesTable } from "./workspaces";
import { invoicesTable } from "./invoices";
import { payrollItemsTable } from "./payroll-cycles";
import { payableBillsTable } from "./payables";

export const nearIntentQuotesTable = pgTable(
  "trezu_near_intent_quotes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "restrict" }),
    invoiceId: uuid("invoice_id").references(() => invoicesTable.id, { onDelete: "restrict" }),
    payrollItemId: uuid("payroll_item_id").references(() => payrollItemsTable.id, { onDelete: "restrict" }),
    payableBillId: uuid("payable_bill_id").references(() => payableBillsTable.id, { onDelete: "restrict" }),
    createdBy: text("created_by").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    providerReference: text("provider_reference"),
    originAsset: text("origin_asset"),
    destinationAsset: text("destination_asset"),
    originAssetSymbol: text("origin_asset_symbol"),
    originAssetNetwork: text("origin_asset_network"),
    originAssetDecimals: integer("origin_asset_decimals"),
    destinationAssetSymbol: text("destination_asset_symbol"),
    destinationAssetNetwork: text("destination_asset_network"),
    destinationAssetDecimals: integer("destination_asset_decimals"),
    quotePayload: jsonb("quote_payload").$type<Record<string, unknown>>(),
    providerStatusPayload: jsonb("provider_status_payload").$type<Record<string, unknown>>(),
    providerStatus: text("provider_status").notNull().default("REQUESTING"),
    reconciliationStatus: text("reconciliation_status"),
    lastError: text("last_error"),
    statusCheckedAt: timestamp("status_checked_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("trezu_near_intent_workspace_idempotency_unique").on(table.workspaceId, table.idempotencyKey),
    uniqueIndex("trezu_near_intent_provider_reference_unique").on(table.providerReference),
    index("trezu_near_intent_workspace_created_idx").on(table.workspaceId, table.createdAt),
    index("trezu_near_intent_payroll_item_idx").on(table.payrollItemId, table.createdAt),
  ],
);

export const insertNearIntentQuoteSchema = createInsertSchema(nearIntentQuotesTable).omit({ id: true, createdAt: true, statusCheckedAt: true, settledAt: true });
export type InsertNearIntentQuote = typeof nearIntentQuotesTable.$inferInsert;
export type NearIntentQuote = typeof nearIntentQuotesTable.$inferSelect;
