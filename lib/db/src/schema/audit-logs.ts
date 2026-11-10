import { createInsertSchema } from "drizzle-zod";
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspacesTable } from "./workspaces";

export const auditLogsTable = pgTable("trezu_audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").references(() => workspacesTable.id, {
    onDelete: "set null",
  }),
  actorUserId: text("actor_user_id").notNull(),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  metadata: jsonb("metadata").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertAuditLogSchema = createInsertSchema(auditLogsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertAuditLog = typeof auditLogsTable.$inferInsert;
export type AuditLog = typeof auditLogsTable.$inferSelect;
