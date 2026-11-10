import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  auditLogsTable,
  db,
  invoicesTable,
} from "@workspace/db";
import {
  CreateInvoiceBody,
  CreateInvoiceResponse,
  GetInvoicesResponse,
} from "@workspace/api-zod";
import {
  requireWorkspaceMember,
  requireWorkspaceRole,
} from "../../middlewares/auth";
import { isPositiveMoney } from "../../lib/money";

const router: IRouter = Router();

router.get(
  "/invoices",
  requireWorkspaceMember,
  requireWorkspaceRole("owner", "admin"),
  async (req, res): Promise<void> => {
    const invoices = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.workspaceId, req.trezuWorkspaceId!))
      .orderBy(desc(invoicesTable.createdAt));
    res.json(GetInvoicesResponse.parse(invoices));
  },
);

router.post(
  "/invoices",
  requireWorkspaceMember,
  requireWorkspaceRole("owner", "admin"),
  async (req, res): Promise<void> => {
    const parsed = CreateInvoiceBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    if (!isPositiveMoney(parsed.data.amount)) {
      res.status(400).json({ error: "Invoice amount must be greater than zero" });
      return;
    }

    const id = randomUUID();
    const invoiceNumber = `TRZ-${new Date().getUTCFullYear()}-${id
      .replaceAll("-", "")
      .slice(0, 8)
      .toUpperCase()}`;
    const invoice = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(invoicesTable)
        .values({
          id,
          workspaceId: req.trezuWorkspaceId!,
          invoiceNumber,
          clientName: parsed.data.clientName.trim(),
          clientEmail: parsed.data.clientEmail?.trim() || null,
          description: parsed.data.description.trim(),
          amount: parsed.data.amount,
          currency: parsed.data.currency.toUpperCase(),
          status: "draft",
          createdBy: req.trezuUserId!,
        })
        .returning();

      await tx.insert(auditLogsTable).values({
        workspaceId: req.trezuWorkspaceId!,
        actorUserId: req.trezuUserId!,
        action: "invoice.created",
        entityType: "invoice",
        entityId: id,
        metadata: { status: "draft", currency: parsed.data.currency },
      });
      return created;
    });

    res.status(201).json(CreateInvoiceResponse.parse(invoice));
  },
);

export default router;
