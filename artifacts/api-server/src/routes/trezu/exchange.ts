import { and, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  auditLogsTable,
  db,
  vendorApplicationsTable,
  vendorsTable,
  workspaceMembersTable,
} from "@workspace/db";
import {
  CreateVendorApplicationBody,
  CreateVendorApplicationResponse,
  GetVendorsQueryParams,
  GetVendorsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/vendors", async (req, res): Promise<void> => {
  const parsed = GetVendorsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const filters = [eq(vendorsTable.active, true)];
  if (parsed.data.country) {
    filters.push(eq(vendorsTable.country, parsed.data.country.toUpperCase()));
  }
  if (parsed.data.currency) {
    filters.push(eq(vendorsTable.currency, parsed.data.currency.toUpperCase()));
  }

  const vendors = await db
    .select()
    .from(vendorsTable)
    .where(and(...filters));

  res.json(
    GetVendorsResponse.parse(
      vendors.map((vendor) => ({
        id: vendor.id,
        businessName: vendor.businessName,
        country: vendor.country,
        currency: vendor.currency,
        paymentMethods: vendor.paymentMethods,
        indicativeRate: vendor.indicativeRate,
        rating: vendor.rating,
        completedTrades: vendor.completedTrades,
      })),
    ),
  );
});

router.post(
  "/vendor-applications",
  async (req, res): Promise<void> => {
    const parsed = CreateVendorApplicationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const userId = req.trezuUserId!;
    const [existing] = await db
      .select({ id: vendorApplicationsTable.id })
      .from(vendorApplicationsTable)
      .where(eq(vendorApplicationsTable.applicantUserId, userId))
      .limit(1);
    if (existing) {
      res.status(409).json({
        error: "A vendor application already exists for this account",
      });
      return;
    }

    try {
      const id = crypto.randomUUID();
      const application = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(vendorApplicationsTable)
          .values({
            id,
            applicantUserId: userId,
            businessName: parsed.data.businessName.trim(),
            country: parsed.data.country.toUpperCase(),
            currency: parsed.data.currency.toUpperCase(),
            paymentMethods: parsed.data.paymentMethods,
            status: "pending",
          })
          .returning();

        const [membership] = await tx
          .select({ workspaceId: workspaceMembersTable.workspaceId })
          .from(workspaceMembersTable)
          .where(eq(workspaceMembersTable.userId, userId))
          .limit(1);
        await tx.insert(auditLogsTable).values({
          workspaceId: membership?.workspaceId ?? null,
          actorUserId: userId,
          action: "vendor.application_submitted",
          entityType: "vendor_application",
          entityId: id,
          metadata: { country: parsed.data.country.toUpperCase() },
        });
        return created;
      });

      res
        .status(201)
        .json(CreateVendorApplicationResponse.parse(application));
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "23505"
      ) {
        res.status(409).json({
          error: "A vendor application already exists for this account",
        });
        return;
      }
      throw error;
    }
  },
);

export default router;
