import { randomUUID } from "node:crypto";
import { and, asc, count, eq } from "drizzle-orm";
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
import { userPreferencesTable } from "@workspace/db/schema";
import {
  CreateWorkspaceBody,
  CreateWorkspaceResponse,
  GetDashboardResponse,
  GetProfileResponse,
} from "@workspace/api-zod";
import { requireWorkspaceMember } from "../../middlewares/auth";

const router: IRouter = Router();

async function getProfile(userId: string, selectedWorkspaceId?: string) {
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
    .where(and(
      eq(workspaceMembersTable.userId, userId),
      selectedWorkspaceId ? eq(workspaceMembersTable.workspaceId, selectedWorkspaceId) : undefined,
    ))
    .orderBy(asc(workspaceMembersTable.createdAt))
    .limit(1);

  const platformAdminIds = (process.env.TREZU_PLATFORM_ADMIN_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return {
    userId,
    workspaceId: membership?.workspaceId ?? null,
    workspaceName: membership?.workspaceName ?? null,
    workspaceType: membership?.workspaceType ?? null,
    role: platformAdminIds.includes(userId) ? "platform_admin" : membership?.role ?? null,
  };
}

router.get("/profile", async (req, res): Promise<void> => {
  res.json(GetProfileResponse.parse(await getProfile(req.trezuUserId!, req.header("x-trezu-workspace-id"))));
});

router.get("/workspaces", async (req, res): Promise<void> => {
  const workspaces = await db
    .select({ id: workspacesTable.id, name: workspacesTable.name, type: workspacesTable.type, role: workspaceMembersTable.role })
    .from(workspaceMembersTable)
    .innerJoin(workspacesTable, eq(workspacesTable.id, workspaceMembersTable.workspaceId))
    .where(eq(workspaceMembersTable.userId, req.trezuUserId!))
    .orderBy(asc(workspaceMembersTable.createdAt));
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ workspaces });
});

router.get("/personal-profile/preferences", async (req, res): Promise<void> => {
  const [preferences] = await db.select({ defaultReceiveAddresses: userPreferencesTable.defaultReceiveAddresses })
    .from(userPreferencesTable).where(eq(userPreferencesTable.userId, req.trezuUserId!)).limit(1);
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ defaultReceiveAddresses: preferences?.defaultReceiveAddresses ?? {} });
});

router.put("/personal-profile/preferences", async (req, res): Promise<void> => {
  const body = req.body as { defaultReceiveAddresses?: unknown };
  const addresses = body?.defaultReceiveAddresses;
  if (!addresses || typeof addresses !== "object" || Array.isArray(addresses)) {
    res.status(400).json({ error: "Choose wallet addresses for your personal profile." });
    return;
  }
  const value = addresses as Record<string, unknown>;
  const near = typeof value.near === "string" ? value.near.trim() : "";
  const evm = typeof value.evm === "string" ? value.evm.trim() : "";
  if (near.length > 128 || (near && !/^(?:[a-z0-9_-]+\.testnet|[a-f0-9]{64})$/i.test(near))) {
    res.status(400).json({ error: "Choose a valid NEAR testnet account address." });
    return;
  }
  if (evm.length > 42 || (evm && !/^0x[a-f0-9]{40}$/i.test(evm))) {
    res.status(400).json({ error: "Choose a valid EVM wallet address." });
    return;
  }
  const preferences = { ...(near ? { near } : {}), ...(evm ? { evm } : {}) };
  await db.insert(userPreferencesTable).values({ userId: req.trezuUserId!, defaultReceiveAddresses: preferences })
    .onConflictDoUpdate({ target: userPreferencesTable.userId, set: { defaultReceiveAddresses: preferences, updatedAt: new Date() } });
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ defaultReceiveAddresses: preferences });
});

router.post("/workspaces", async (req, res): Promise<void> => {
  const parsed = CreateWorkspaceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const userId = req.trezuUserId!;
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
      .json(CreateWorkspaceResponse.parse(await getProfile(userId, workspaceId)));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23505"
    ) {
      res.status(409).json({ error: "A workspace with these details already exists. Choose another name and try again." });
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
        .where(and(eq(employeesTable.workspaceId, workspaceId), eq(employeesTable.active, true))),
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
