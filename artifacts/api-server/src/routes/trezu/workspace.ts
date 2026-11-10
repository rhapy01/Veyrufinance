import { randomUUID } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  auditLogsTable,
  db,
  employeesTable,
  invoicesTable,
  vendorApplicationsTable,
  workspaceMembersTable,
  workspacesTable,
} from "@workspace/db";
import {
  CreateWorkspaceBody,
  CreateWorkspaceResponse,
  GetDashboardResponse,
  GetProfileResponse,
} from "@workspace/api-zod";
import { requireWorkspaceMember } from "../../middlewares/auth";

const router: IRouter = Router();

async function getProfile(userId: string) {
  const [membership] = await db
    .select({
      workspaceId: workspacesTable.id,
      workspaceName: workspacesTable.name,
      workspaceType: workspacesTable.type,
      role: workspaceMembersTable.role,
    })
    .from(workspaceMembersTable)
    .innerJoin(
      workspacesTable,
      eq(workspacesTable.id, workspaceMembersTable.workspaceId),
    )
    .where(eq(workspaceMembersTable.userId, userId))
    .limit(1);

  return {
    userId,
    workspaceId: membership?.workspaceId ?? null,
    workspaceName: membership?.workspaceName ?? null,
    workspaceType: membership?.workspaceType ?? null,
    role: membership?.role ?? null,
  };
}

router.get("/profile", async (req, res): Promise<void> => {
  res.json(GetProfileResponse.parse(await getProfile(req.trezuUserId!)));
});

router.post("/workspaces", async (req, res): Promise<void> => {
  const parsed = CreateWorkspaceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const userId = req.trezuUserId!;
  const [existingMembership] = await db
    .select({ id: workspaceMembersTable.id })
    .from(workspaceMembersTable)
    .where(eq(workspaceMembersTable.userId, userId))
    .limit(1);

  if (existingMembership) {
    res.status(409).json({ error: "You already belong to a workspace" });
    return;
  }

  try {
    const workspaceId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(workspacesTable).values({
        id: workspaceId,
        name: parsed.data.name.trim(),
        type: parsed.data.type,
        ownerUserId: userId,
      });
      await tx.insert(workspaceMembersTable).values({
        workspaceId,
        userId,
        role: "owner",
      });
      await tx.insert(auditLogsTable).values({
        workspaceId,
        actorUserId: userId,
        action: "workspace.created",
        entityType: "workspace",
        entityId: workspaceId,
      });
    });

    res
      .status(201)
      .json(CreateWorkspaceResponse.parse(await getProfile(userId)));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23505"
    ) {
      res.status(409).json({ error: "You already belong to a workspace" });
      return;
    }
    throw error;
  }
});

router.get("/dashboard", requireWorkspaceMember, async (req, res): Promise<void> => {
  const workspaceId = req.trezuWorkspaceId!;
  const userId = req.trezuUserId!;
  const [invoiceResult, employeeResult, pendingResult, workspace] =
    await Promise.all([
      db
        .select({ value: count() })
        .from(invoicesTable)
        .where(eq(invoicesTable.workspaceId, workspaceId)),
      db
        .select({ value: count() })
        .from(employeesTable)
        .where(eq(employeesTable.workspaceId, workspaceId)),
      db
        .select({ value: count() })
        .from(vendorApplicationsTable)
        .where(
          and(
            eq(vendorApplicationsTable.applicantUserId, userId),
            eq(vendorApplicationsTable.status, "pending"),
          ),
        ),
      db
        .select({
          name: workspacesTable.name,
          type: workspacesTable.type,
        })
        .from(workspacesTable)
        .where(eq(workspacesTable.id, workspaceId))
        .limit(1),
    ]);

  res.json(
    GetDashboardResponse.parse({
      workspaceName: workspace[0]?.name ?? "",
      workspaceType: workspace[0]?.type ?? "freelancer",
      role: req.trezuWorkspaceRole,
      invoiceCount: invoiceResult[0]?.value ?? 0,
      employeeCount: employeeResult[0]?.value ?? 0,
      pendingVendorApplications: pendingResult[0]?.value ?? 0,
      walletStatus: "not_connected",
      confirmedBalance: null,
    }),
  );
});

export default router;
