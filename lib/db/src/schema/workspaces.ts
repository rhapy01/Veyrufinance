import { createInsertSchema } from "drizzle-zod";
import { pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const workspaceTypeEnum = pgEnum("trezu_workspace_type", [
  "freelancer",
  "business",
]);

export const workspaceRoleEnum = pgEnum("trezu_workspace_role", [
  "owner",
  "admin",
  "employee",
  "vendor",
  "platform_admin",
]);

export type WorkspaceRole = (typeof workspaceRoleEnum.enumValues)[number];
export type WorkspaceType = (typeof workspaceTypeEnum.enumValues)[number];

export const workspacesTable = pgTable("trezu_workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  type: workspaceTypeEnum("type").notNull(),
  ownerUserId: text("owner_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const workspaceMembersTable = pgTable(
  "trezu_workspace_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    role: workspaceRoleEnum("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("trezu_workspace_members_workspace_user_unique").on(
      table.workspaceId,
      table.userId,
    ),
    uniqueIndex("trezu_workspace_members_user_unique").on(table.userId),
  ],
);

export const insertWorkspaceSchema = createInsertSchema(workspacesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertWorkspace = typeof workspacesTable.$inferInsert;
export type Workspace = typeof workspacesTable.$inferSelect;
export type WorkspaceMember = typeof workspaceMembersTable.$inferSelect;
