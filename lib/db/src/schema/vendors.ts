import { createInsertSchema } from "drizzle-zod";
import {
  boolean,
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
