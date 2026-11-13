import { and, desc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  auditLogsTable,
  db,
  vendorApplicationsTable,
  vendorOffersTable,
  vendorsTable,
  workspaceMembersTable,
} from "@workspace/db";
import {
  CreateVendorApplicationBody,
  CreateVendorApplicationResponse,
  GetVendorsQueryParams,
  GetVendorsResponse,
} from "@workspace/api-zod";
import { requirePlatformAdmin } from "../../middlewares/auth";
import { getSupportedAssets, type NearIntentAsset } from "../../lib/near-intents";

const router: IRouter = Router();
const amountPattern = /^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,18})?$/;
const offerUnits = (value: string): bigint => {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 10n ** 18n + BigInt((fraction + "0".repeat(18)).slice(0, 18));
};

function parseOfferBody(body: unknown) {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  const { assetId, exchangeRate, availableLiquidity, minimumAmount, maximumAmount, paymentMethods, status } = value;
  if (typeof assetId !== "string" || assetId.length < 3 || assetId.length > 200 ||
      typeof exchangeRate !== "string" || !amountPattern.test(exchangeRate) ||
      typeof availableLiquidity !== "string" || !amountPattern.test(availableLiquidity) ||
      typeof minimumAmount !== "string" || !amountPattern.test(minimumAmount) ||
      typeof maximumAmount !== "string" || !amountPattern.test(maximumAmount) ||
      !Array.isArray(paymentMethods) || paymentMethods.length === 0 || paymentMethods.some((method) => typeof method !== "string") ||
      (status !== undefined && status !== "active" && status !== "paused")) return null;
  const rateUnits = offerUnits(exchangeRate);
  const liquidityUnits = offerUnits(availableLiquidity);
  const minimumUnits = offerUnits(minimumAmount);
  const maximumUnits = offerUnits(maximumAmount);
  if (rateUnits <= 0n || liquidityUnits <= 0n || minimumUnits <= 0n || maximumUnits < minimumUnits || maximumUnits > liquidityUnits) return null;
  return { assetId, exchangeRate, availableLiquidity, minimumAmount, maximumAmount, paymentMethods: paymentMethods as string[], status: status as "active" | "paused" | undefined };
}

async function getOwnedApprovedVendor(userId: string) {
  const [row] = await db.select({ vendor: vendorsTable, application: vendorApplicationsTable })
    .from(vendorsTable).innerJoin(vendorApplicationsTable, eq(vendorsTable.applicationId, vendorApplicationsTable.id))
    .where(and(eq(vendorApplicationsTable.applicantUserId, userId), eq(vendorApplicationsTable.status, "approved"), eq(vendorsTable.active, true))).limit(1);
  return row;
}

async function validateOfferAssets(assetId: string) {
  const assets = await getSupportedAssets();
  return assets.find((asset) => asset.assetId === assetId) ?? null;
}

router.get("/vendor/offers", async (req, res): Promise<void> => {
  const owned = await getOwnedApprovedVendor(req.trezuUserId!);
  if (!owned) { res.status(403).json({ error: "Only an approved vendor can manage offers" }); return; }
  const offers = await db.select().from(vendorOffersTable).where(eq(vendorOffersTable.vendorId, owned.vendor.id)).orderBy(desc(vendorOffersTable.createdAt));
  res.setHeader("Cache-Control", "private, no-store");
  res.json(offers);
});

router.get("/vendor/supported-assets", async (req, res): Promise<void> => {
  const owned = await getOwnedApprovedVendor(req.trezuUserId!);
  if (!owned) { res.status(403).json({ error: "Only an approved vendor can publish offers" }); return; }
  try { res.setHeader("Cache-Control", "private, max-age=30"); res.json({ assets: await getSupportedAssets() }); }
  catch { res.status(503).json({ error: "The provider asset catalog is unavailable. Try again shortly." }); }
});

router.get("/offers", async (req, res): Promise<void> => {
  const country = typeof req.query.country === "string" ? req.query.country.toUpperCase() : null;
  const currency = typeof req.query.currency === "string" ? req.query.currency.toUpperCase() : null;
  const filters = [eq(vendorOffersTable.status, "active"), eq(vendorsTable.active, true)];
  if (country) filters.push(eq(vendorsTable.country, country));
  if (currency) filters.push(eq(vendorOffersTable.currency, currency));
  let supportedIds: Set<string>;
  try { supportedIds = new Set((await getSupportedAssets()).map((asset) => asset.assetId)); }
  catch { res.status(503).json({ error: "The provider asset catalog is unavailable. Try again shortly." }); return; }
  const offers = await db.select({ offer: vendorOffersTable, vendorName: vendorsTable.businessName, country: vendorsTable.country, vendorRating: vendorsTable.rating, completedTrades: vendorsTable.completedTrades })
    .from(vendorOffersTable).innerJoin(vendorsTable, eq(vendorOffersTable.vendorId, vendorsTable.id))
    .where(and(...filters)).orderBy(vendorOffersTable.currency, vendorOffersTable.assetSymbol, vendorOffersTable.exchangeRate);
  res.setHeader("Cache-Control", "public, max-age=15");
  res.json(offers.filter(({ offer }) => supportedIds.has(offer.assetId)).map(({ offer, ...vendor }) => ({ ...offer, ...vendor, listingOnly: true, settlementAvailable: false })));
});

router.post("/vendor/offers", async (req, res): Promise<void> => {
  const parsed = parseOfferBody(req.body);
  if (!parsed) { res.status(400).json({ error: "Provide a positive rate, liquidity, valid transaction limits, supported payment methods, and an asset reference." }); return; }
  const owned = await getOwnedApprovedVendor(req.trezuUserId!);
  if (!owned) { res.status(403).json({ error: "Only an approved vendor can publish offers" }); return; }
  if (parsed.paymentMethods.some((method) => !owned.vendor.paymentMethods.includes(method))) { res.status(400).json({ error: "Offer payment methods must be included in the approved application" }); return; }
  let asset: NearIntentAsset | null;
  try { asset = await validateOfferAssets(parsed.assetId); }
  catch { res.status(503).json({ error: "The provider asset catalog is unavailable. Try again shortly." }); return; }
  if (!asset) { res.status(400).json({ error: "This asset is not in the current NEAR Intents supported asset catalog" }); return; }
  const [offer] = await db.transaction(async (tx) => {
    const created = await tx.insert(vendorOffersTable).values({ vendorId: owned.vendor.id, assetId: asset.assetId, assetSymbol: asset.symbol, assetNetwork: asset.blockchain, currency: owned.vendor.currency, paymentMethods: parsed.paymentMethods, exchangeRate: parsed.exchangeRate, availableLiquidity: parsed.availableLiquidity, minimumAmount: parsed.minimumAmount, maximumAmount: parsed.maximumAmount, status: parsed.status ?? "active" }).returning();
    await tx.insert(auditLogsTable).values({ workspaceId: null, actorUserId: req.trezuUserId!, action: "vendor.offer_created", entityType: "vendor_offer", entityId: created[0]!.id, metadata: { vendorId: owned.vendor.id, assetId: asset.assetId, currency: owned.vendor.currency } });
    return created;
  });
  res.status(201).json(offer);
});

router.put("/vendor/offers/:offerId", async (req, res): Promise<void> => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.offerId)) { res.status(400).json({ error: "Invalid offer ID" }); return; }
  const parsed = parseOfferBody(req.body);
  if (!parsed || !parsed.status) { res.status(400).json({ error: "Provide valid offer values and an active or paused status." }); return; }
  const owned = await getOwnedApprovedVendor(req.trezuUserId!);
  if (!owned) { res.status(403).json({ error: "Only an approved vendor can manage offers" }); return; }
  const [current] = await db.select().from(vendorOffersTable).where(and(eq(vendorOffersTable.id, req.params.offerId), eq(vendorOffersTable.vendorId, owned.vendor.id))).limit(1);
  if (!current) { res.status(404).json({ error: "Offer not found" }); return; }
  if (parsed.paymentMethods.some((method) => !owned.vendor.paymentMethods.includes(method))) { res.status(400).json({ error: "Offer payment methods must be included in the approved application" }); return; }
  let asset: NearIntentAsset | null;
  try { asset = await validateOfferAssets(parsed.assetId); }
  catch { res.status(503).json({ error: "The provider asset catalog is unavailable. Try again shortly." }); return; }
  if (!asset) { res.status(400).json({ error: "This asset is not in the current NEAR Intents supported asset catalog" }); return; }
  const [updated] = await db.transaction(async (tx) => {
    const result = await tx.update(vendorOffersTable).set({ assetId: asset.assetId, assetSymbol: asset.symbol, assetNetwork: asset.blockchain, paymentMethods: parsed.paymentMethods, exchangeRate: parsed.exchangeRate, availableLiquidity: parsed.availableLiquidity, minimumAmount: parsed.minimumAmount, maximumAmount: parsed.maximumAmount, status: parsed.status!, updatedAt: new Date() }).where(eq(vendorOffersTable.id, current.id)).returning();
    await tx.insert(auditLogsTable).values({ workspaceId: null, actorUserId: req.trezuUserId!, action: "vendor.offer_updated", entityType: "vendor_offer", entityId: current.id, metadata: { status: parsed.status!, assetId: asset.assetId, currency: current.currency } });
    return result;
  });
  res.json(updated);
});

router.get("/vendor-applications/mine", async (req, res): Promise<void> => {
  const [application] = await db.select().from(vendorApplicationsTable)
    .where(eq(vendorApplicationsTable.applicantUserId, req.trezuUserId!)).limit(1);
  res.setHeader("Cache-Control", "private, no-store");
  res.json(application ?? null);
});

router.get("/admin/vendor-applications", requirePlatformAdmin, async (_req, res): Promise<void> => {
  const applications = await db.select().from(vendorApplicationsTable)
    .orderBy(desc(vendorApplicationsTable.createdAt));
  res.setHeader("Cache-Control", "private, no-store");
  res.json(applications);
});

router.post("/admin/vendor-applications/:applicationId/approve", requirePlatformAdmin, async (req, res): Promise<void> => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.applicationId)) { res.status(400).json({ error: "Invalid vendor application ID" }); return; }
  const result = await db.transaction(async (tx) => {
    const [application] = await tx.select().from(vendorApplicationsTable).where(eq(vendorApplicationsTable.id, req.params.applicationId)).for("update").limit(1);
    if (!application) return { error: "not_found" as const };
    const [existingVendor] = await tx.select().from(vendorsTable).where(eq(vendorsTable.applicationId, application.id)).limit(1);
    if (application.status === "approved" && existingVendor) return { application, vendor: existingVendor, alreadyApproved: true };
    if (application.status !== "pending") return { error: "not_pending" as const };
    const [updatedApplication] = await tx.update(vendorApplicationsTable).set({ status: "approved", reviewedBy: req.trezuUserId!, reviewedAt: new Date(), reviewNote: null }).where(eq(vendorApplicationsTable.id, application.id)).returning();
    const [vendor] = await tx.insert(vendorsTable).values({ applicationId: application.id, businessName: application.businessName, country: application.country, currency: application.currency, paymentMethods: application.paymentMethods }).onConflictDoNothing({ target: vendorsTable.applicationId }).returning();
    const [createdVendor] = vendor ? [vendor] : await tx.select().from(vendorsTable).where(eq(vendorsTable.applicationId, application.id)).limit(1);
    await tx.insert(auditLogsTable).values({ workspaceId: null, actorUserId: req.trezuUserId!, action: "vendor.application_approved", entityType: "vendor_application", entityId: application.id, metadata: { vendorId: createdVendor!.id, country: application.country, reviewedAndApproved: true } });
    return { application: updatedApplication, vendor: createdVendor!, alreadyApproved: false };
  });
  if ("error" in result) { res.status(result.error === "not_found" ? 404 : 409).json({ error: result.error === "not_found" ? "Application not found" : "Only pending vendor applications can be approved" }); return; }
  res.json(result);
});

router.post("/admin/vendor-applications/:applicationId/decline", requirePlatformAdmin, async (req, res): Promise<void> => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.applicationId)) { res.status(400).json({ error: "Invalid vendor application ID" }); return; }
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!reason || reason.length > 1000) { res.status(400).json({ error: "Provide a review reason of up to 1,000 characters" }); return; }
  const result = await db.transaction(async (tx) => {
    const [application] = await tx.select().from(vendorApplicationsTable).where(eq(vendorApplicationsTable.id, req.params.applicationId)).for("update").limit(1);
    if (!application) return { error: "not_found" as const };
    if (application.status === "declined") return { application, alreadyDeclined: true };
    if (application.status !== "pending") return { error: "not_pending" as const };
    const [updated] = await tx.update(vendorApplicationsTable).set({ status: "declined", reviewedBy: req.trezuUserId!, reviewedAt: new Date(), reviewNote: reason }).where(eq(vendorApplicationsTable.id, application.id)).returning();
    await tx.insert(auditLogsTable).values({ workspaceId: null, actorUserId: req.trezuUserId!, action: "vendor.application_declined", entityType: "vendor_application", entityId: application.id, metadata: { reason, country: application.country } });
    return { application: updated, alreadyDeclined: false };
  });
  if ("error" in result) { res.status(result.error === "not_found" ? 404 : 409).json({ error: result.error === "not_found" ? "Application not found" : "Only pending vendor applications can be declined" }); return; }
  res.json(result);
});

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
      .select()
      .from(vendorApplicationsTable)
      .where(eq(vendorApplicationsTable.applicantUserId, userId))
      .limit(1);
    if (existing && existing.status !== "declined") {
      res.status(409).json({
        error: "Your vendor application is already under review or approved",
      });
      return;
    }

    if (existing?.status === "declined") {
      const updated = await db.transaction(async (tx) => {
        const [locked] = await tx.select({ status: vendorApplicationsTable.status }).from(vendorApplicationsTable)
          .where(eq(vendorApplicationsTable.id, existing.id)).for("update").limit(1);
        if (locked?.status !== "declined") return null;
        const [application] = await tx.update(vendorApplicationsTable).set({
          businessName: parsed.data.businessName.trim(),
          country: parsed.data.country.toUpperCase(),
          currency: parsed.data.currency.toUpperCase(),
          paymentMethods: parsed.data.paymentMethods,
          status: "pending",
          reviewNote: null,
          reviewedBy: null,
          reviewedAt: null,
        }).where(eq(vendorApplicationsTable.id, existing.id)).returning();
        if (!application) return null;
        await tx.insert(auditLogsTable).values({
          workspaceId: null,
          actorUserId: userId,
          action: "vendor.application_resubmitted",
          entityType: "vendor_application",
          entityId: existing.id,
          metadata: { country: parsed.data.country.toUpperCase() },
        });
        return application;
      });
      if (!updated) { res.status(409).json({ error: "This application has already changed. Refresh its status and try again." }); return; }
      res.status(200).json(CreateVendorApplicationResponse.parse(updated));
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
