import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const vendorApplicationStatusEnum = pgEnum(
  "trezu_vendor_application_status",
  ["pending", "approved", "declined"],
);

export const vendorApplicationsTable = pgTable(
  "trezu_vendor_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicantUserId: text("applicant_user_id").notNull(),
    businessName: text("business_name").notNull(),
    country: text("country").notNull(),
    currency: text("currency").notNull(),
    paymentMethods: jsonb("payment_methods").$type<string[]>().notNull(),
    status: vendorApplicationStatusEnum("status").notNull().default("pending"),
    reviewNote: text("review_note"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("trezu_vendor_application_applicant_unique").on(
      table.applicantUserId,
    ),
  ],
);

export const vendorsTable = pgTable(
  "trezu_vendors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => vendorApplicationsTable.id, { onDelete: "restrict" }),
    businessName: text("business_name").notNull(),
    country: text("country").notNull(),
    currency: text("currency").notNull(),
    paymentMethods: jsonb("payment_methods").$type<string[]>().notNull(),
    indicativeRate: numeric("indicative_rate", {
      precision: 24,
      scale: 8,
    }),
    rating: real("rating"),
    completedTrades: integer("completed_trades").notNull().default(0),
    active: boolean("active").notNull().default(true),
    approvedAt: timestamp("approved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("trezu_vendor_application_unique").on(table.applicationId),
  ],
);

export const vendorOfferStatusEnum = pgEnum("trezu_vendor_offer_status", ["active", "paused"]);

export const vendorOffersTable = pgTable("trezu_vendor_offers", {
  id: uuid("id").primaryKey().defaultRandom(),
  vendorId: uuid("vendor_id").notNull().references(() => vendorsTable.id, { onDelete: "restrict" }),
  assetId: text("asset_id").notNull(),
  assetSymbol: text("asset_symbol").notNull(),
  assetNetwork: text("asset_network").notNull(),
  currency: text("currency").notNull(),
  paymentMethods: jsonb("payment_methods").$type<string[]>().notNull(),
  exchangeRate: numeric("exchange_rate", { precision: 36, scale: 18 }).notNull(),
  availableLiquidity: numeric("available_liquidity", { precision: 36, scale: 18 }).notNull(),
  minimumAmount: numeric("minimum_amount", { precision: 36, scale: 18 }).notNull(),
  maximumAmount: numeric("maximum_amount", { precision: 36, scale: 18 }).notNull(),
  status: vendorOfferStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("trezu_vendor_offer_rate_positive", sql`${table.exchangeRate} > 0`),
  check("trezu_vendor_offer_liquidity_positive", sql`${table.availableLiquidity} > 0`),
  check("trezu_vendor_offer_amounts_valid", sql`${table.minimumAmount} > 0 AND ${table.maximumAmount} >= ${table.minimumAmount} AND ${table.maximumAmount} <= ${table.availableLiquidity}`),
  index("trezu_vendor_offer_market_idx").on(table.status, table.currency, table.assetId),
  index("trezu_vendor_offer_vendor_idx").on(table.vendorId, table.status),
]);

export const insertVendorApplicationSchema = createInsertSchema(
  vendorApplicationsTable,
).omit({
  id: true,
  createdAt: true,
});
export type InsertVendorApplication =
  typeof vendorApplicationsTable.$inferInsert;
export type VendorApplication =
  typeof vendorApplicationsTable.$inferSelect;
export type Vendor = typeof vendorsTable.$inferSelect;
