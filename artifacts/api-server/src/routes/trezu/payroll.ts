import { desc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { auditLogsTable, db, employeesTable } from "@workspace/db";
import {
  CreateEmployeeBody,
  CreateEmployeeResponse,
  GetEmployeesResponse,
} from "@workspace/api-zod";
import {
  requireWorkspaceMember,
  requireWorkspaceRole,
} from "../../middlewares/auth";
import { isPositiveMoney } from "../../lib/money";

const router: IRouter = Router();

router.get(
  "/employees",
  requireWorkspaceMember,
  requireWorkspaceRole("owner", "admin"),
  async (req, res): Promise<void> => {
    const employees = await db
      .select()
      .from(employeesTable)
      .where(eq(employeesTable.workspaceId, req.trezuWorkspaceId!))
      .orderBy(desc(employeesTable.createdAt));
    res.json(GetEmployeesResponse.parse(employees));
  },
);

router.post(
  "/employees",
  requireWorkspaceMember,
  requireWorkspaceRole("owner", "admin"),
  async (req, res): Promise<void> => {
    const parsed = CreateEmployeeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    if (!isPositiveMoney(parsed.data.compensationAmount)) {
      res.status(400).json({ error: "Compensation must be greater than zero" });
      return;
    }

    const id = crypto.randomUUID();
    const employee = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(employeesTable)
        .values({
          id,
          workspaceId: req.trezuWorkspaceId!,
          name: parsed.data.name.trim(),
          email: parsed.data.email.trim().toLowerCase(),
          compensationAmount: parsed.data.compensationAmount,
          compensationCurrency: parsed.data.compensationCurrency.toUpperCase(),
          payFrequency: parsed.data.payFrequency,
          preferredStablecoin: parsed.data.preferredStablecoin,
          preferredNetwork: parsed.data.preferredNetwork.trim(),
          walletAddress: parsed.data.walletAddress?.trim() || null,
          createdBy: req.trezuUserId!,
        })
        .returning();

      await tx.insert(auditLogsTable).values({
        workspaceId: req.trezuWorkspaceId!,
        actorUserId: req.trezuUserId!,
        action: "payroll.employee_profile_created",
        entityType: "employee",
        entityId: id,
        metadata: { payFrequency: parsed.data.payFrequency },
      });
      return created;
    });

    res.status(201).json(CreateEmployeeResponse.parse(employee));
  },
);

export default router;
