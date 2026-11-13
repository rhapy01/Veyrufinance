import { pgEnum, pgTable, text, timestamp, boolean, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const userRoleEnum = pgEnum("trezu_user_role", ["user", "admin"]);

export const usersTable = pgTable("trezu_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  privyUserId: text("privy_user_id").unique(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  role: userRoleEnum("role").notNull().default("user"),
  active: boolean("active").notNull().default(true),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const authActionTokensTable = pgTable("trezu_auth_action_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  purpose: text("purpose").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("trezu_auth_action_tokens_user_purpose_idx").on(table.userId, table.purpose)]);

export const linkedWalletsTable = pgTable("trezu_linked_wallets", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  network: text("network").notNull(),
  address: text("address").notNull(),
  provider: text("provider"),
  publicKey: text("public_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("trezu_linked_wallets_network_address_unique").on(table.network, table.address),
  uniqueIndex("trezu_linked_wallets_user_network_address_unique").on(table.userId, table.network, table.address),
]);

export const sessionsTable = pgTable("trezu_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  refreshToken: text("refresh_token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Insert schemas (no id / timestamps)
export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  passwordHash: true,
  createdAt: true,
  updatedAt: true,
});

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().min(1, "Name is required"),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export type User = typeof usersTable.$inferSelect;
export type InsertUser = typeof usersTable.$inferInsert;
export type Session = typeof sessionsTable.$inferSelect;
