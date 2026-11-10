import { getAuth } from "@clerk/express";
import { eq } from "drizzle-orm";
import type { RequestHandler } from "express";
import { db, workspaceMembersTable, type WorkspaceRole } from "@workspace/db";

declare global {
  namespace Express {
    interface Request {
      trezuUserId?: string;
      trezuWorkspaceId?: string;
      trezuWorkspaceRole?: WorkspaceRole;
    }
  }
}

export const requireAuthenticatedUser: RequestHandler = (req, res, next) => {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  req.trezuUserId = userId;
  next();
};

export const requireWorkspaceMember: RequestHandler = async (req, res, next) => {
  const userId = req.trezuUserId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const [membership] = await db
    .select({
      workspaceId: workspaceMembersTable.workspaceId,
      role: workspaceMembersTable.role,
    })
    .from(workspaceMembersTable)
    .where(eq(workspaceMembersTable.userId, userId))
    .limit(1);

  if (!membership) {
    res.status(403).json({ error: "Create or join a workspace to continue" });
    return;
  }

  req.trezuWorkspaceId = membership.workspaceId;
  req.trezuWorkspaceRole = membership.role;
  next();
};

export function requireWorkspaceRole(
  ...allowedRoles: WorkspaceRole[]
): RequestHandler {
  return (req, res, next) => {
    if (
      !req.trezuWorkspaceRole ||
      !allowedRoles.includes(req.trezuWorkspaceRole)
    ) {
      res.status(403).json({ error: "Your workspace role cannot perform this action" });
      return;
    }
    next();
  };
}
