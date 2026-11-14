import { jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export type DefaultReceiveAddresses = { near?: string; evm?: string };

export const userPreferencesTable = pgTable("trezu_user_preferences", {
  userId: uuid("user_id").primaryKey().references(() => usersTable.id, { onDelete: "cascade" }),
  defaultReceiveAddresses: jsonb("default_receive_addresses").$type<DefaultReceiveAddresses>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
