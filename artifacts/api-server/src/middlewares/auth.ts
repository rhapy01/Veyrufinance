import type { RequestHandler } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db, employeesTable, workspaceMembersTable, type WorkspaceRole } from "@workspace/db";
import { verifyAccessToken } from "../lib/auth-tokens";

declare global {
  namespace Express {
    interface Request {
      trezuUserId?: string;
      trezuWorkspaceId?: string;
      trezuWorkspaceRole?: WorkspaceRole;
      trezuEmployeeId?: string;
    }
  }
}

/**
 * Verifies the Bearer JWT in the Authorization header.
 * Sets req.trezuUserId on success.
 */
export const requireAuthenticatedUser: RequestHandler = async (req, res, next) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = await verifyAccessToken(token);
    req.trezuUserId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
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
    .where(and(
      eq(workspaceMembersTable.userId, userId),
      req.header("x-trezu-workspace-id") ? eq(workspaceMembersTable.workspaceId, req.header("x-trezu-workspace-id")!) : undefined,
    ))
    .orderBy(asc(workspaceMembersTable.createdAt))
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
      res
        .status(403)
        .json({ error: "Your workspace role cannot perform this action" });
      return;
    }
    next();
  };
}

export const requireLinkedEmployee: RequestHandler = async (req, res, next) => {
  const userId = req.trezuUserId;
  if (!userId) { res.status(401).json({ error: "Authentication required" }); return; }
  const [employee] = await db.select({ id: employeesTable.id, workspaceId: employeesTable.workspaceId })
    .from(employeesTable)
    .where(and(
      eq(employeesTable.userId, userId),
      eq(employeesTable.active, true),
      req.header("x-trezu-workspace-id") ? eq(employeesTable.workspaceId, req.header("x-trezu-workspace-id")!) : undefined,
    ))
    .orderBy(asc(employeesTable.createdAt))
    .limit(1);
  if (!employee) { res.status(403).json({ error: "This account is not linked to an active employee profile" }); return; }
  req.trezuEmployeeId = employee.id;
  req.trezuWorkspaceId = employee.workspaceId;
  req.trezuWorkspaceRole = "employee";
  next();
};

export const requirePlatformAdmin: RequestHandler = async (req, res, next) => {
  const configuredIds = (process.env["TREZU_PLATFORM_ADMIN_USER_IDS"] ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const userId = req.trezuUserId;
  if (!userId) {
    res.status(403).json({ error: "Platform administrator access is required" });
    return;
  }
  let allowed = configuredIds.includes(userId);
  if (!allowed) {
    const [membership] = await db
      .select({ role: workspaceMembersTable.role })
      .from(workspaceMembersTable)
      .where(eq(workspaceMembersTable.userId, userId))
      .limit(1);
    allowed = membership?.role === "platform_admin";
  }
  if (!allowed) {
    res.status(403).json({ error: "Platform administrator access is required" });
    return;
  }
  req.trezuWorkspaceRole = "platform_admin";
  next();
};
