import { eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { allocationSettingsTable, auditLogsTable, db } from "@workspace/db";
import {
  GetAllocationsResponse,
  UpdateAllocationsBody,
  UpdateAllocationsResponse,
} from "@workspace/api-zod";
import {
  requireWorkspaceMember,
  requireWorkspaceRole,
} from "../../middlewares/auth";

const router: IRouter = Router();

const suggestions = {
  taxPercent: 20,
  savingsPercent: 20,
  spendingPercent: 60,
  automationEnabled: false,
  automationStatus: "preferences_only" as const,
  updatedAt: null,
};

router.get(
  "/treasury/allocations",
  requireWorkspaceMember,
  requireWorkspaceRole("owner", "admin"),
  async (req, res): Promise<void> => {
    const [saved] = await db
      .select()
      .from(allocationSettingsTable)
      .where(eq(allocationSettingsTable.workspaceId, req.trezuWorkspaceId!))
      .limit(1);

    res.json(
      GetAllocationsResponse.parse(
        saved
          ? {
              taxPercent: saved.taxPercent,
              savingsPercent: saved.savingsPercent,
              spendingPercent: saved.spendingPercent,
              automationEnabled: saved.automationEnabled,
              automationStatus: "preferences_only",
              updatedAt: saved.updatedAt,
            }
          : suggestions,
      ),
    );
  },
);

router.put(
  "/treasury/allocations",
  requireWorkspaceMember,
  requireWorkspaceRole("owner", "admin"),
  async (req, res): Promise<void> => {
    const parsed = UpdateAllocationsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { taxPercent, savingsPercent, spendingPercent } = parsed.data;
    if (taxPercent + savingsPercent + spendingPercent !== 100) {
      res.status(400).json({
        error: "Tax, savings, and spending percentages must total 100",
      });
      return;
    }
    if (parsed.data.automationEnabled) {
      res.status(400).json({
        error:
          "Automatic fund movement is not connected. Save these as preferences with automation off.",
      });
      return;
    }

    const [saved] = await db.transaction(async (tx) => {
      const result = await tx
        .insert(allocationSettingsTable)
        .values({
          workspaceId: req.trezuWorkspaceId!,
          taxPercent,
          savingsPercent,
          spendingPercent,
          automationEnabled: false,
          updatedBy: req.trezuUserId!,
        })
        .onConflictDoUpdate({
          target: allocationSettingsTable.workspaceId,
          set: {
            taxPercent,
            savingsPercent,
            spendingPercent,
            automationEnabled: false,
            updatedBy: req.trezuUserId!,
            updatedAt: new Date(),
          },
        })
        .returning();

      await tx.insert(auditLogsTable).values({
        workspaceId: req.trezuWorkspaceId!,
        actorUserId: req.trezuUserId!,
        action: "treasury.allocation_preferences_updated",
        entityType: "allocation_settings",
        entityId: result[0]!.id,
        metadata: {
          taxPercent,
          savingsPercent,
          spendingPercent,
        },
      });
      return result;
    });

    res.json(
      UpdateAllocationsResponse.parse({
        taxPercent: saved!.taxPercent,
        savingsPercent: saved!.savingsPercent,
        spendingPercent: saved!.spendingPercent,
        automationEnabled: saved!.automationEnabled,
        automationStatus: "preferences_only",
        updatedAt: saved!.updatedAt,
      }),
    );
  },
);

export default router;
