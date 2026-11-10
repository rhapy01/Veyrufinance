import { createInsertSchema } from "drizzle-zod";
import {
  check,
  index,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspacesTable } from "./workspaces";

export const ledgerTransactionTypeEnum = pgEnum(
  "trezu_ledger_transaction_type",
  ["payment_in", "payment_out", "exchange"],
);

export const ledgerTransactionStatusEnum = pgEnum(
  "trezu_ledger_transaction_status",
  ["pending", "confirmed", "failed"],
);

export const ledgerEntrySideEnum = pgEnum("trezu_ledger_entry_side", [
  "debit",
  "credit",
]);

export const ledgerTransactionsTable = pgTable(
  "trezu_ledger_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull(),
    type: ledgerTransactionTypeEnum("type").notNull(),
    status: ledgerTransactionStatusEnum("status").notNull().default("pending"),
    provider: text("provider"),
    providerReference: text("provider_reference"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("trezu_ledger_workspace_idempotency_unique").on(
      table.workspaceId,
      table.idempotencyKey,
    ),
    uniqueIndex("trezu_ledger_provider_reference_unique")
      .on(table.provider, table.providerReference)
      .where(sql`${table.providerReference} IS NOT NULL`),
    index("trezu_ledger_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
  ],
);

export const ledgerEntriesTable = pgTable(
  "trezu_ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => ledgerTransactionsTable.id, { onDelete: "restrict" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "restrict" }),
    accountCode: text("account_code").notNull(),
    side: ledgerEntrySideEnum("side").notNull(),
    amount: numeric("amount", { precision: 24, scale: 6 }).notNull(),
    currency: text("currency").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "trezu_ledger_entry_amount_positive",
      sql`${table.amount} > 0`,
    ),
    index("trezu_ledger_entries_transaction_idx").on(table.transactionId),
    index("trezu_ledger_entries_workspace_currency_idx").on(
      table.workspaceId,
      table.currency,
    ),
  ],
);

export const insertLedgerTransactionSchema = createInsertSchema(
  ledgerTransactionsTable,
).omit({
  id: true,
  createdAt: true,
  confirmedAt: true,
});
export const insertLedgerEntrySchema = createInsertSchema(
  ledgerEntriesTable,
).omit({
  id: true,
  createdAt: true,
});
export type InsertLedgerTransaction =
  typeof ledgerTransactionsTable.$inferInsert;
export type InsertLedgerEntry = typeof ledgerEntriesTable.$inferInsert;
export type LedgerTransaction =
  typeof ledgerTransactionsTable.$inferSelect;
export type LedgerEntry = typeof ledgerEntriesTable.$inferSelect;
