import { Router } from "express";
import bcrypt from "bcryptjs";
import { eq, and, gt, isNull } from "drizzle-orm";
import { SignJWT, jwtVerify, createRemoteJWKSet } from "jose";
import { createPublicKey, createHash, randomBytes, verify as verifySignature } from "node:crypto";
import { verifyMessage } from "viem";
import { PrivyClient, verifyAccessToken as verifyPrivyAccessToken } from "@privy-io/node";
import { db, usersTable, sessionsTable, employeesTable, workspacesTable, workspaceMembersTable, auditLogsTable, authActionTokensTable, linkedWalletsTable, loginSchema, registerSchema } from "@workspace/db";
import {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  refreshTokenExpiresAt,
  getJwtSecret,
} from "../lib/auth-tokens";
import type { RequestHandler } from "express";
import { canExposeLocalActionLink, createAuthActionLink, emailDeliveryConfigured, hashAuthToken, sendAuthActionEmail } from "../lib/auth-email";
import { requireAuthenticatedUser } from "../middlewares/auth";
import { getSupportedAssets } from "../lib/near-intents";

const router = Router();
const privyAppId = process.env.PRIVY_APP_ID || process.env.VITE_PRIVY_APP_ID || "";
const privyJwks = privyAppId ? createRemoteJWKSet(new URL(`https://auth.privy.io/v1/apps/${privyAppId}/jwks.json`)) : null;
const privyAppSecret = process.env.PRIVY_APP_SECRET?.trim() || "";
const privyServer = privyAppId && privyAppSecret ? new PrivyClient({ appId: privyAppId, appSecret: privyAppSecret }) : null;
const EVM_TEST_CHAIN_IDS = new Set([11155111, 421614, 84532, 97, 1313161555]);
const SIGNING_RECIPIENT = process.env.AUTH_SIGNING_DOMAIN || "trezu-finance-hub";
const REFRESH_COOKIE_NAME = "trezu_refresh";
const REFRESH_COOKIE_MAX_AGE = Number(process.env.REFRESH_EXPIRES_IN ?? 0) || 30 * 24 * 60 * 60 * 1000;

function setRefreshCookie(res: import("express").Response, token: string): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.append("Set-Cookie", `${REFRESH_COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=${Math.floor(REFRESH_COOKIE_MAX_AGE / 1000)}${secure}`);
}

function clearRefreshCookie(res: import("express").Response): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.append("Set-Cookie", `${REFRESH_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=0${secure}`);
}

function refreshTokenFromRequest(req: import("express").Request): string | undefined {
  const cookie = req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${REFRESH_COOKIE_NAME}=`));
  const cookieToken = cookie?.slice(REFRESH_COOKIE_NAME.length + 1);
  const bodyToken = typeof req.body?.refreshToken === "string" ? req.body.refreshToken : undefined;
  return cookieToken || bodyToken;
}

function base58Decode(input: string): Buffer {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const character of input) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error("Invalid base58 value");
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) { bytes.unshift(Number(value & 255n)); value >>= 8n; }
  for (const character of input) { if (character !== "1") break; bytes.unshift(0); }
  return Buffer.from(bytes);
}

function borshString(value: string): Buffer {
  const encoded = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(encoded.length);
  return Buffer.concat([length, encoded]);
}

function verifyNearLinkSignature(input: { message: string; nonce: string; recipient: string; publicKey: string; signature: string }): boolean {
  try {
    const keyBytes = base58Decode(input.publicKey.replace(/^ed25519:/, ""));
    const signatureBytes = base58Decode(input.signature.replace(/^ed25519:/, ""));
    const nonceBytes = Buffer.from(input.nonce, "base64url");
    if (keyBytes.length !== 32 || signatureBytes.length !== 64 || nonceBytes.length !== 32) return false;
    const tag = Buffer.alloc(4);
    tag.writeUInt32LE(2 ** 31 + 413);
    const payload = Buffer.concat([tag, borshString(input.message), nonceBytes, borshString(input.recipient), Buffer.from([0])]);
    const digest = createHash("sha256").update(payload).digest();
    const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), keyBytes]), format: "der", type: "spki" });
    return verifySignature(null, digest, publicKey, signatureBytes);
  } catch { return false; }
}

async function consumeWalletLinkChallenge(userId: string, network: string, nonce: string): Promise<boolean> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [action] = await tx.select().from(authActionTokensTable).where(and(
      eq(authActionTokensTable.userId, userId),
      eq(authActionTokensTable.purpose, `wallet_link:${network}`),
      eq(authActionTokensTable.tokenHash, hashAuthToken(nonce)),
      gt(authActionTokensTable.expiresAt, now),
      isNull(authActionTokensTable.consumedAt),
    )).for("update").limit(1);
    if (!action) return false;
    await tx.update(authActionTokensTable).set({ consumedAt: now }).where(eq(authActionTokensTable.id, action.id));
    return true;
  });
}

async function employeeInvitationPayload(token: string) {
  const { payload } = await jwtVerify(token, getJwtSecret(), { issuer: "trezu", audience: "trezu-employee-invitation" });
  if (payload.purpose !== "employee-invitation" || typeof payload.sub !== "string" || typeof payload.email !== "string" || typeof payload.workspaceId !== "string") throw new Error("Invalid employee invitation");
  return { employeeId: payload.sub, email: payload.email, workspaceId: payload.workspaceId };
}

router.get("/auth/employee-invitation/:token", (async (req, res) => {
  try {
    const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
    const invite = await employeeInvitationPayload(token);
    const [row] = await db.select({ employee: employeesTable, workspaceName: workspacesTable.name })
      .from(employeesTable).innerJoin(workspacesTable, eq(employeesTable.workspaceId, workspacesTable.id))
      .where(and(eq(employeesTable.id, invite.employeeId), eq(employeesTable.workspaceId, invite.workspaceId), eq(employeesTable.email, invite.email), eq(employeesTable.active, true)))
      .limit(1);
    if (!row) { res.status(410).json({ error: "This employee invitation has expired or has already been used." }); return; }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Cache-Control", "no-store");
    res.json({ email: row.employee.email, employeeName: row.employee.name, position: row.employee.position, workspaceName: row.workspaceName, alreadyLinked: Boolean(row.employee.userId), payoutProfileCompleted: row.employee.payoutProfileCompleted });
  } catch {
    res.status(410).json({ error: "This employee invitation is invalid or has expired. Ask the business to send a new one." });
  }
}) as RequestHandler);

router.post("/auth/employee-invitation/accept", (async (req, res) => {
  const token = req.body?.invitationToken;
  if (typeof token !== "string" || token.length > 4096) { res.status(400).json({ error: "A valid employee invitation is required." }); return; }
  let invite: Awaited<ReturnType<typeof employeeInvitationPayload>>;
  try { invite = await employeeInvitationPayload(token); }
  catch { res.status(410).json({ error: "This employee invitation is invalid or has expired. Ask the business to send a new one." }); return; }
  if (req.body?.completeProfile !== true) { res.status(400).json({ error: "Sign in with Privy from this invitation, then complete your payout profile to join the team." }); return; }

  // Privy is Trezu's account provider. An employee can first register/sign in
  // through Privy, then reopen this invitation to link their team profile.
  if (typeof req.body?.completeProfile === "boolean" && req.body.completeProfile) {
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) { res.status(401).json({ error: "Sign in with Privy before completing your team profile." }); return; }
    let claims: Awaited<ReturnType<typeof verifyAccessToken>>;
    try { claims = await verifyAccessToken(authorization.slice(7)); }
    catch { res.status(401).json({ error: "Your Trezu session expired. Sign in again." }); return; }
    const [user] = await db.select({ id: usersTable.id, email: usersTable.email }).from(usersTable).where(and(eq(usersTable.id, claims.sub), eq(usersTable.active, true))).limit(1);
    if (!user || user.email.toLowerCase() !== invite.email.toLowerCase()) { res.status(403).json({ error: `Sign in with ${invite.email} to accept this team invitation.` }); return; }
    const [employee] = await db.select().from(employeesTable).where(and(eq(employeesTable.id, invite.employeeId), eq(employeesTable.workspaceId, invite.workspaceId), eq(employeesTable.email, invite.email), eq(employeesTable.active, true))).limit(1);
    if (!employee) { res.status(410).json({ error: "This team invitation is no longer active." }); return; }
    if (employee.userId && employee.userId !== user.id) { res.status(409).json({ error: "This invitation is already linked to another account." }); return; }
    let assets: Awaited<ReturnType<typeof getSupportedAssets>>;
    try { assets = await getSupportedAssets(); } catch { res.status(503).json({ error: "Supported payout assets are temporarily unavailable." }); return; }
    const assetId = typeof req.body?.assetId === "string" ? req.body.assetId : "";
    const asset = assets.find((candidate) => candidate.assetId === assetId);
    if (!asset) { res.status(400).json({ error: "Choose a currently supported payout asset and network." }); return; }
    const address = typeof req.body?.walletAddress === "string" ? req.body.walletAddress.trim() : "";
    const network = asset.blockchain.toLowerCase();
    const validAddress = network === "near" ? /^[a-z0-9._-]{2,64}$/.test(address)
      : ["eth", "ethereum", "base", "op", "optimism", "arb", "arbitrum", "pol", "polygon", "bsc", "avax", "avalanche"].includes(network) ? /^0x[0-9a-f]{40}$/i.test(address)
        : address.length >= 20 && address.length <= 200;
    if (!validAddress) { res.status(400).json({ error: `Enter a valid wallet address for ${asset.blockchain}.` }); return; }
    try { await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(employeesTable).where(and(eq(employeesTable.id, employee.id), isNull(employeesTable.userId))).for("update").limit(1);
      if (!locked && employee.userId !== user.id) throw new Error("INVITATION_ALREADY_CLAIMED");
      const [linked] = await tx.update(employeesTable).set({ userId: user.id, preferredStablecoin: asset.symbol, preferredNetwork: asset.blockchain, walletAddress: address, payoutProfileCompleted: true })
        .where(eq(employeesTable.id, employee.id)).returning({ id: employeesTable.id, workspaceId: employeesTable.workspaceId });
      await tx.insert(workspaceMembersTable).values({ workspaceId: linked!.workspaceId, userId: user.id, role: "employee" }).onConflictDoNothing();
      await tx.insert(auditLogsTable).values({ workspaceId: linked!.workspaceId, actorUserId: user.id, action: "team.member_payout_profile_completed", entityType: "employee", entityId: linked!.id, metadata: { payoutAsset: asset.assetId, network: asset.blockchain } });
    }); } catch (error) {
      if (error instanceof Error && error.message === "INVITATION_ALREADY_CLAIMED") { res.status(409).json({ error: "This invitation has already been linked to another Trezu account." }); return; }
      throw error;
    }
    res.json({ employeeId: employee.id, workspaceId: employee.workspaceId, payoutProfileCompleted: true }); return;
  }

  let authenticatedUser: { id: string; email: string; name: string; role: string } | null = null;
  const authorization = req.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    try {
      const claims = await verifyAccessToken(authorization.slice(7));
      const [user] = await db.select({ id: usersTable.id, email: usersTable.email, name: usersTable.name, role: usersTable.role })
        .from(usersTable).where(and(eq(usersTable.id, claims.sub), eq(usersTable.active, true))).limit(1);
      if (!user) { res.status(401).json({ error: "Sign in again before accepting this invitation." }); return; }
      authenticatedUser = user;
    } catch { res.status(401).json({ error: "Sign in again before accepting this invitation." }); return; }
  }
  if (authenticatedUser && authenticatedUser.email.toLowerCase() !== invite.email.toLowerCase()) {
    res.status(403).json({ error: `Sign in with ${invite.email} to accept this employee invitation.` }); return;
  }
  if (!authenticatedUser && (typeof req.body?.password !== "string" || req.body.password.length < 8 || req.body.password.length > 128)) {
    res.status(400).json({ error: "Set a password of at least 8 characters, or sign in to your existing Trezu account." }); return;
  }

  const result = await db.transaction(async (tx) => {
    const [employee] = await tx.select().from(employeesTable)
      .where(and(eq(employeesTable.id, invite.employeeId), eq(employeesTable.workspaceId, invite.workspaceId), eq(employeesTable.email, invite.email), eq(employeesTable.active, true)))
      .for("update").limit(1);
    if (!employee) return { error: "not_found" as const };
    if (employee.userId) return { error: employee.userId === authenticatedUser?.id ? "already_used" as const : "already_linked" as const };

    let user = authenticatedUser;
    let created = false;
    if (!user) {
      const [existing] = await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, invite.email.toLowerCase())).limit(1);
      if (existing) return { error: "account_exists" as const };
      const passwordHash = await bcrypt.hash(req.body.password, 12);
      const [newUser] = await tx.insert(usersTable).values({ email: invite.email.toLowerCase(), passwordHash, name: employee.name, emailVerifiedAt: new Date() }).returning({ id: usersTable.id, email: usersTable.email, name: usersTable.name, role: usersTable.role });
      if (!newUser) return { error: "account_create_failed" as const };
      user = newUser;
      created = true;
    }
    const [existingLink] = await tx.select({ id: employeesTable.id }).from(employeesTable)
      .where(and(eq(employeesTable.userId, user.id), eq(employeesTable.workspaceId, employee.workspaceId))).limit(1);
    if (existingLink) return { error: "account_linked" as const };

    const [linked] = await tx.update(employeesTable).set({ userId: user.id })
      .where(and(eq(employeesTable.id, employee.id), isNull(employeesTable.userId)))
      .returning({ id: employeesTable.id, workspaceId: employeesTable.workspaceId });
    if (!linked) return { error: "already_linked" as const };
    await tx.insert(auditLogsTable).values({ workspaceId: employee.workspaceId, actorUserId: user.id, action: "payroll.employee_account_linked", entityType: "employee", entityId: employee.id, metadata: { email: invite.email } });
    await tx.insert(workspaceMembersTable).values({ workspaceId: employee.workspaceId, userId: user.id, role: "employee" }).onConflictDoNothing();
    return { user, employeeId: employee.id, created };
  });

  if ("error" in result && result.error !== undefined) {
    const message: Record<Exclude<typeof result.error, undefined>, string> = {
      not_found: "The employee record is no longer active. Ask the business to check your invitation.",
      already_used: "This invitation has already been accepted.",
      already_linked: "This employee record is already linked to an account.",
      account_exists: "This email already has a Trezu account. Sign in with that account, then reopen the invitation.",
      account_create_failed: "The employee account could not be created. Try again.",
      account_linked: "This account is already linked to an employee profile.",
    };
    const errorCode = result.error as keyof typeof message;
    res.status(errorCode === "not_found" ? 404 : ["account_exists", "account_linked"].includes(errorCode) ? 409 : 410).json({ error: message[errorCode] }); return;
  }

  let session: { accessToken: string; refreshToken: string } | null = null;
  if (result.created) {
    const accessToken = await signAccessToken({ sub: result.user.id, email: result.user.email, name: result.user.name, role: result.user.role });
    const refreshToken = generateRefreshToken();
    await db.insert(sessionsTable).values({ userId: result.user.id, refreshToken, expiresAt: refreshTokenExpiresAt() });
    session = { accessToken, refreshToken };
    setRefreshCookie(res, refreshToken);
  }
  res.json({ user: result.user, employeeId: result.employeeId, ...(session ? { accessToken: session.accessToken } : {}) });
}) as RequestHandler);

// ─── POST /api/auth/register ───────────────────────────────────────────────
router.post("/auth/privy/session", (async (req, res) => {
  const privyAccessToken = typeof req.body?.privyAccessToken === "string" ? req.body.privyAccessToken : "";
  if (!privyAppId || !privyJwks) { res.status(503).json({ error: "Privy authentication is not configured on the server." }); return; }
  if (!privyAccessToken || privyAccessToken.length > 16_384) { res.status(401).json({ error: "Sign in with Privy to continue." }); return; }
  if (!privyServer) { res.status(503).json({ error: "Privy server authentication is not configured. Set PRIVY_APP_SECRET." }); return; }

  let privyUser: Awaited<ReturnType<ReturnType<typeof privyServer.users>["_get"]>>;
  try {
    const verifiedToken = await verifyPrivyAccessToken({ access_token: privyAccessToken, app_id: privyAppId, verification_key: privyJwks });
    privyUser = await privyServer.users()._get(verifiedToken.user_id);
  }
  catch { res.status(401).json({ error: "Your Privy session could not be verified. Sign in again." }); return; }

  const emailAccount = privyUser.linked_accounts.find((account) => account.type === "email");
  const email = emailAccount?.address?.trim().toLowerCase();
  if (!email || !emailAccount?.verified_at) { res.status(403).json({ error: "Verify an email address in Privy before opening your Trezu account." }); return; }
  const requestedName = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 120) : "";
  const derivedName = requestedName || email.split("@")[0] || "Trezu member";

  let localUser: { id: string; email: string; name: string; role: "user" | "admin" } | null = null;
  try {
    localUser = await db.transaction(async (tx) => {
      const [byPrivyId] = await tx.select().from(usersTable).where(eq(usersTable.privyUserId, privyUser.id)).limit(1);
      if (byPrivyId) {
        if (!byPrivyId.active) throw new Error("ACCOUNT_INACTIVE");
        if (byPrivyId.email.toLowerCase() !== email) throw new Error("PRIVY_EMAIL_CHANGED");
        return byPrivyId;
      }

      const [byEmail] = await tx.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
      if (byEmail) {
        if (!byEmail.active) throw new Error("ACCOUNT_INACTIVE");
        if (byEmail.privyUserId && byEmail.privyUserId !== privyUser.id) throw new Error("EMAIL_ALREADY_LINKED");
        const [linked] = await tx.update(usersTable).set({ privyUserId: privyUser.id, emailVerifiedAt: byEmail.emailVerifiedAt || new Date(), updatedAt: new Date() }).where(eq(usersTable.id, byEmail.id)).returning();
        if (!linked) throw new Error("ACCOUNT_LINK_FAILED");
        return linked;
      }

      const passwordHash = await bcrypt.hash(randomBytes(48).toString("base64url"), 12);
      const [created] = await tx.insert(usersTable).values({ privyUserId: privyUser.id, email, passwordHash, name: derivedName, emailVerifiedAt: new Date() }).returning();
      if (!created) throw new Error("ACCOUNT_CREATE_FAILED");
      return created;
    });

  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    const messages: Record<string, string> = {
      ACCOUNT_INACTIVE: "This Trezu account is inactive. Contact support.",
      PRIVY_EMAIL_CHANGED: "Your Privy email changed. Sign in with the email already linked to this Trezu account.",
      EMAIL_ALREADY_LINKED: "This email is already linked to another Privy account.",
      ACCOUNT_LINK_FAILED: "Could not link Privy to your existing Trezu account. Try again.",
      ACCOUNT_CREATE_FAILED: "Could not create your Trezu account. Try again.",
    };
    res.status(reason === "EMAIL_ALREADY_LINKED" ? 409 : 400).json({ error: messages[reason] || "Could not open your Trezu account with Privy." });
    return;
  }

  if (!localUser) { res.status(500).json({ error: "Could not load your Trezu account after Privy sign-in." }); return; }
  await db.transaction(async (tx) => {
    const [pendingEmployee] = await tx.select().from(employeesTable).where(and(eq(employeesTable.email, email), eq(employeesTable.active, true), isNull(employeesTable.userId))).for("update").limit(1);
    if (!pendingEmployee) return;
    const [existingEmployeeLink] = await tx.select({ id: employeesTable.id }).from(employeesTable)
      .where(and(eq(employeesTable.userId, localUser!.id), eq(employeesTable.workspaceId, pendingEmployee.workspaceId))).limit(1);
    if (existingEmployeeLink) return;
    const [linked] = await tx.update(employeesTable).set({ userId: localUser!.id })
      .where(and(eq(employeesTable.id, pendingEmployee.id), isNull(employeesTable.userId))).returning({ id: employeesTable.id, workspaceId: employeesTable.workspaceId });
    if (linked) {
      await tx.insert(workspaceMembersTable).values({ workspaceId: linked.workspaceId, userId: localUser!.id, role: "employee" }).onConflictDoNothing();
      await tx.insert(auditLogsTable).values({ workspaceId: linked.workspaceId, actorUserId: localUser!.id, action: "team.member_account_linked", entityType: "employee", entityId: linked.id, metadata: { email } });
    }
  });
  let nearWalletProvisioningError = "";
  try {
    const [savedNearWallet] = await db.select({ address: linkedWalletsTable.address }).from(linkedWalletsTable)
      .where(and(eq(linkedWalletsTable.userId, localUser.id), eq(linkedWalletsTable.network, "near:testnet"), eq(linkedWalletsTable.provider, "privy"))).limit(1);
    if (!savedNearWallet) {
      if (!privyServer) throw new Error("PRIVY_APP_SECRET_MISSING");
      const externalId = `trezu_near_${createHash("sha256").update(privyUser.id).digest("hex").slice(0, 40)}`;
      const wallet = await privyServer.wallets().create({
        chain_type: "near",
        owner: { user_id: privyUser.id },
        display_name: "Trezu NEAR Testnet",
        external_id: externalId,
        idempotency_key: externalId,
      });
      if (!wallet.address) throw new Error("Privy returned no NEAR address.");
      await db.insert(linkedWalletsTable).values({ userId: localUser.id, network: "near:testnet", address: wallet.address, provider: "privy" }).onConflictDoNothing();
    }
  } catch (error) {
    nearWalletProvisioningError = error instanceof Error && error.message === "PRIVY_APP_SECRET_MISSING"
      ? "NEAR wallet creation needs the server Privy App Secret (PRIVY_APP_SECRET)."
      : "NEAR wallet creation failed through Privy. Check the server Privy App Secret and wallet API access.";
  }

  const accessToken = await signAccessToken({ sub: localUser.id, email: localUser.email, name: localUser.name, role: localUser.role });
  const refreshToken = generateRefreshToken();
  await db.insert(sessionsTable).values({ userId: localUser.id, refreshToken, expiresAt: refreshTokenExpiresAt() });
  setRefreshCookie(res, refreshToken);
  res.json({ accessToken, user: { id: localUser.id, email: localUser.email, name: localUser.name, role: localUser.role }, walletProvisioning: { near: nearWalletProvisioningError ? "pending" : "ready", ...(nearWalletProvisioningError ? { message: nearWalletProvisioningError } : {}) } });
}) as RequestHandler);

router.post("/auth/register", (async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten().fieldErrors });
    return;
  }

  const { email, password, name } = parsed.data;
  if (process.env.NODE_ENV === "production" && !emailDeliveryConfigured()) {
    res.status(503).json({ error: "Email delivery is not configured. Please try again later." });
    return;
  }

  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, email.toLowerCase()))
    .limit(1);

  if (existing) {
    res.status(409).json({ error: "Email already registered" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const [user] = await db
    .insert(usersTable)
    .values({
      email: email.toLowerCase(),
      passwordHash,
      name,
    })
    .returning({
      id: usersTable.id,
      email: usersTable.email,
      name: usersTable.name,
      role: usersTable.role,
    });

  if (!user) {
    res.status(500).json({ error: "Account creation failed." });
    return;
  }
  const verificationUrl = await createAuthActionLink(user.id, "verify_email", 30);
  try {
    const delivered = await sendAuthActionEmail(user.email, user.name, "verify_email", verificationUrl);
    res.status(201).json({ message: "Check your email for a verification link.", ...(canExposeLocalActionLink() && !delivered ? { verificationUrl } : {}) });
  } catch {
    res.status(503).json({ error: "Your account was created, but the verification email could not be sent. Request a new link and try again." });
  }
}) as RequestHandler);

router.post("/auth/verify-email", (async (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  if (token.length < 20 || token.length > 200) { res.status(400).json({ error: "This verification link is invalid or expired." }); return; }
  const now = new Date();
  const verified = await db.transaction(async (tx) => {
    const [action] = await tx.select().from(authActionTokensTable).where(and(
      eq(authActionTokensTable.tokenHash, hashAuthToken(token)),
      eq(authActionTokensTable.purpose, "verify_email"),
      gt(authActionTokensTable.expiresAt, now),
      isNull(authActionTokensTable.consumedAt),
    )).for("update").limit(1);
    if (!action) return false;
    await tx.update(authActionTokensTable).set({ consumedAt: now }).where(eq(authActionTokensTable.id, action.id));
    await tx.update(usersTable).set({ emailVerifiedAt: now, updatedAt: now }).where(eq(usersTable.id, action.userId));
    return true;
  });
  if (!verified) { res.status(400).json({ error: "This verification link is invalid or expired. Request a new one." }); return; }
  res.json({ message: "Email verified. You can now sign in." });
}) as RequestHandler);

router.post("/auth/verify-email/resend", (async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!email || email.length > 254) { res.status(200).json({ message: "If the account needs verification, a link will be sent." }); return; }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  let verificationUrl = "";
  if (user && !user.emailVerifiedAt) {
    verificationUrl = await createAuthActionLink(user.id, "verify_email", 30);
    if (emailDeliveryConfigured()) try { await sendAuthActionEmail(user.email, user.name, "verify_email", verificationUrl); } catch { /* Keep the response indistinguishable for known and unknown emails. */ }
  }
  res.json({ message: "If the account needs verification, a link will be sent.", ...(canExposeLocalActionLink() && verificationUrl && !emailDeliveryConfigured() ? { verificationUrl } : {}) });
}) as RequestHandler);

router.post("/auth/forgot-password", (async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const generic = { message: "If an account exists for that email, password reset instructions will be sent." };
  if (!email || email.length > 254) { res.json(generic); return; }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (!user || !emailDeliveryConfigured()) {
    res.json({ ...generic, ...(canExposeLocalActionLink() && user ? { resetUrl: await createAuthActionLink(user.id, "reset_password", 30) } : {}) });
    return;
  }
  const url = await createAuthActionLink(user.id, "reset_password", 30);
  try { await sendAuthActionEmail(user.email, user.name, "reset_password", url); } catch { /* Do not reveal delivery or account state. */ }
  res.json(generic);
}) as RequestHandler);

router.post("/auth/reset-password", (async (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (token.length < 20 || token.length > 200 || password.length < 8 || password.length > 128) {
    res.status(400).json({ error: "Use a valid reset link and a password between 8 and 128 characters." }); return;
  }
  const now = new Date();
  const passwordHash = await bcrypt.hash(password, 12);
  const reset = await db.transaction(async (tx) => {
    const [action] = await tx.select().from(authActionTokensTable).where(and(
      eq(authActionTokensTable.tokenHash, hashAuthToken(token)),
      eq(authActionTokensTable.purpose, "reset_password"),
      gt(authActionTokensTable.expiresAt, now),
      isNull(authActionTokensTable.consumedAt),
    )).for("update").limit(1);
    if (!action) return false;
    await tx.update(authActionTokensTable).set({ consumedAt: now }).where(eq(authActionTokensTable.id, action.id));
    await tx.update(usersTable).set({ passwordHash, emailVerifiedAt: now, updatedAt: now }).where(eq(usersTable.id, action.userId));
    await tx.delete(sessionsTable).where(eq(sessionsTable.userId, action.userId));
    return true;
  });
  if (!reset) { res.status(400).json({ error: "This reset link is invalid or expired. Request another one." }); return; }
  res.json({ message: "Password updated. Sign in with your new password." });
}) as RequestHandler);

router.get("/auth/wallets", requireAuthenticatedUser, (async (req, res) => {
  const wallets = await db.select({ id: linkedWalletsTable.id, network: linkedWalletsTable.network, address: linkedWalletsTable.address, provider: linkedWalletsTable.provider, createdAt: linkedWalletsTable.createdAt })
    .from(linkedWalletsTable).where(eq(linkedWalletsTable.userId, req.trezuUserId!));
  res.json({ wallets, nearWalletProvisioningConfigured: Boolean(privyServer) });
}) as RequestHandler);

router.get("/auth/wallets/balances", requireAuthenticatedUser, (async (req, res) => {
  const wallets = await db.select({ address: linkedWalletsTable.address }).from(linkedWalletsTable).where(and(
    eq(linkedWalletsTable.userId, req.trezuUserId!), eq(linkedWalletsTable.network, "near:testnet"),
  ));
  const tokens = await getSupportedAssets().then((assets) => assets.filter((asset) => asset.blockchain.toLowerCase() === "near" && asset.contractAddress)).catch(() => []);
  const query = async (params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const response = await fetch("https://rpc.testnet.near.org", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "trezu-wallet-balances", method: "query", params }), signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error("NEAR testnet RPC request failed.");
    const payload = await response.json() as { result?: Record<string, unknown>; error?: { message?: string } };
    if (payload.error || !payload.result || payload.result.error) throw new Error(payload.error?.message || String(payload.result?.error || "NEAR testnet balance is unavailable."));
    return payload.result;
  };
  const balances = await Promise.all(wallets.map(async ({ address }) => {
    const [native, tokenBalances] = await Promise.all([
      query({ request_type: "view_account", account_id: address, finality: "final" }).then((result) => typeof result.amount === "string" ? result.amount : null).catch(() => null),
      Promise.all(tokens.map(async (asset) => {
        try {
          const result = await query({ request_type: "call_function", account_id: asset.contractAddress, method_name: "ft_balance_of", args_base64: Buffer.from(JSON.stringify({ account_id: address })).toString("base64"), finality: "final" });
          if (!Array.isArray(result.result)) return { assetId: asset.assetId, symbol: asset.symbol, decimals: asset.decimals, balance: null };
          const raw = JSON.parse(Buffer.from(result.result as number[]).toString("utf8"));
          return { assetId: asset.assetId, symbol: asset.symbol, decimals: asset.decimals, balance: typeof raw === "string" && /^\d+$/.test(raw) ? raw : null };
        } catch { return { assetId: asset.assetId, symbol: asset.symbol, decimals: asset.decimals, balance: null }; }
      })),
    ]);
    return [address.toLowerCase(), { nativeNear: native, tokens: tokenBalances }] as const;
  }));
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ balances: Object.fromEntries(balances) });
}) as RequestHandler);

router.post("/auth/wallet-link/challenge", requireAuthenticatedUser, (async (req, res) => {
  const network = typeof req.body?.network === "string" ? req.body.network : "";
  const isNear = network === "near:testnet";
  const evmChainId = network.startsWith("evm:") ? Number(network.slice(4)) : NaN;
  if (!isNear && (!Number.isSafeInteger(evmChainId) || !EVM_TEST_CHAIN_IDS.has(evmChainId))) {
    res.status(400).json({ error: "Choose a NEAR testnet wallet or supported EVM test network." }); return;
  }
  const nonce = randomBytes(32).toString("base64url");
  const [user] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, req.trezuUserId!)).limit(1);
  if (!user) { res.status(401).json({ error: "Sign in to your Trezu account again." }); return; }
  const message = `Link this ${isNear ? "NEAR testnet" : `EVM testnet (chain ${evmChainId})`} wallet to the Trezu account ${user.email}. This signature does not authorize a transaction. One-time challenge: ${nonce}`;
  await db.insert(authActionTokensTable).values({ userId: req.trezuUserId!, purpose: `wallet_link:${network}`, tokenHash: hashAuthToken(nonce), expiresAt: new Date(Date.now() + 5 * 60_000) });
    res.setHeader("Cache-Control", "no-store");
  res.json({ network, nonce, message, recipient: SIGNING_RECIPIENT, chainId: isNear ? undefined : evmChainId });
}) as RequestHandler);

router.post("/auth/wallet-link/near", requireAuthenticatedUser, (async (req, res) => {
  const { accountId, publicKey, signature, nonce, message, recipient } = req.body ?? {};
  if (typeof accountId !== "string" || !/^[a-z0-9._-]{2,64}$/.test(accountId) || !accountId.endsWith(".testnet")) {
    res.status(400).json({ error: "The selected wallet did not return a NEAR testnet account ID. Switch Meteor to Testnet and retry." }); return;
  }
  if (typeof publicKey !== "string" || !publicKey.startsWith("ed25519:")) {
    res.status(400).json({ error: "The selected wallet did not return an Ed25519 NEAR public key. Reconnect the wallet and retry." }); return;
  }
  if (typeof signature !== "string" || !signature || typeof nonce !== "string" || typeof message !== "string" || recipient !== SIGNING_RECIPIENT) {
    res.status(400).json({ error: "The signed wallet challenge is incomplete or expired. Reconnect the NEAR testnet wallet and retry." }); return;
  }
  const [challenge] = await db.select().from(authActionTokensTable).where(and(
    eq(authActionTokensTable.userId, req.trezuUserId!), eq(authActionTokensTable.purpose, "wallet_link:near:testnet"),
    eq(authActionTokensTable.tokenHash, hashAuthToken(nonce)), gt(authActionTokensTable.expiresAt, new Date()), isNull(authActionTokensTable.consumedAt),
  )).limit(1);
  if (!challenge || !verifyNearLinkSignature({ message, nonce, recipient, publicKey, signature })) { res.status(401).json({ error: "Wallet signature is invalid or the challenge expired. Try again." }); return; }
  if (message !== `Link this NEAR testnet wallet to the Trezu account ${String((await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, req.trezuUserId!)).limit(1))[0]?.email || "")}. This signature does not authorize a transaction. One-time challenge: ${nonce}`) {
    res.status(401).json({ error: "The wallet signature does not match this account." }); return;
  }
  try {
    const rpc = await fetch("https://rpc.testnet.near.org", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "trezu-wallet-link", method: "query", params: { request_type: "view_access_key_list", finality: "final", account_id: accountId } }), signal: AbortSignal.timeout(8_000) });
    const rpcData = await rpc.json() as { result?: { keys?: { public_key?: string; access_key?: { permission?: unknown } }[] } };
    const activeFullAccessKey = rpcData.result?.keys?.some((key) => key.public_key === publicKey && key.access_key?.permission === "FullAccess");
    if (!activeFullAccessKey) { res.status(400).json({ error: "That key is not an active full-access key for this NEAR testnet account." }); return; }
  } catch { res.status(503).json({ error: "NEAR testnet could not verify the account key. Try again shortly." }); return; }
  if (!await consumeWalletLinkChallenge(req.trezuUserId!, "near:testnet", nonce)) { res.status(409).json({ error: "This wallet challenge has already been used. Try again." }); return; }
  try {
    const [wallet] = await db.insert(linkedWalletsTable).values({ userId: req.trezuUserId!, network: "near:testnet", address: accountId, publicKey }).returning({ id: linkedWalletsTable.id, network: linkedWalletsTable.network, address: linkedWalletsTable.address, createdAt: linkedWalletsTable.createdAt });
    res.status(201).json({ wallet });
  } catch { res.status(409).json({ error: "That wallet is already linked to a Trezu account." }); }
}) as RequestHandler);

router.post("/auth/wallet-link/evm", requireAuthenticatedUser, (async (req, res) => {
  const { address, signature, nonce, message, chainId } = req.body ?? {};
  const network = `evm:${Number(chainId)}`;
  if (typeof address !== "string" || !/^0x[0-9a-f]{40}$/i.test(address) || typeof signature !== "string" || !/^0x[0-9a-f]{130}$/i.test(signature) ||
      typeof nonce !== "string" || typeof message !== "string" || !EVM_TEST_CHAIN_IDS.has(Number(chainId))) {
    res.status(400).json({ error: "Provide a valid signed wallet challenge from a supported EVM test network." }); return;
  }
  const [user] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, req.trezuUserId!)).limit(1);
  const expectedMessage = `Link this EVM testnet (chain ${Number(chainId)}) wallet to the Trezu account ${user?.email || ""}. This signature does not authorize a transaction. One-time challenge: ${nonce}`;
  const [challenge] = await db.select().from(authActionTokensTable).where(and(
    eq(authActionTokensTable.userId, req.trezuUserId!), eq(authActionTokensTable.purpose, `wallet_link:${network}`),
    eq(authActionTokensTable.tokenHash, hashAuthToken(nonce)), gt(authActionTokensTable.expiresAt, new Date()), isNull(authActionTokensTable.consumedAt),
  )).limit(1);
  let valid = false;
  try { valid = Boolean(user && challenge && message === expectedMessage && await verifyMessage({ address: address as `0x${string}`, message, signature: signature as `0x${string}` })); } catch { valid = false; }
  if (!valid) { res.status(401).json({ error: "Wallet signature is invalid or the challenge expired. Try again." }); return; }
  if (!await consumeWalletLinkChallenge(req.trezuUserId!, network, nonce)) { res.status(409).json({ error: "This wallet challenge has already been used. Try again." }); return; }
  try {
    const [wallet] = await db.insert(linkedWalletsTable).values({ userId: req.trezuUserId!, network, address: address.toLowerCase() }).returning({ id: linkedWalletsTable.id, network: linkedWalletsTable.network, address: linkedWalletsTable.address, createdAt: linkedWalletsTable.createdAt });
    res.status(201).json({ wallet });
  } catch { res.status(409).json({ error: "That wallet is already linked to a Trezu account." }); }
}) as RequestHandler);

router.delete("/auth/wallets/:id", requireAuthenticatedUser, (async (req, res) => {
  const walletId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [wallet] = await db.delete(linkedWalletsTable).where(and(eq(linkedWalletsTable.id, walletId), eq(linkedWalletsTable.userId, req.trezuUserId!))).returning({ id: linkedWalletsTable.id });
  if (!wallet) { res.status(404).json({ error: "Linked wallet not found." }); return; }
  res.json({ ok: true });
}) as RequestHandler);

// ─── POST /api/auth/login ──────────────────────────────────────────────────
router.post("/auth/login", (async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten().fieldErrors });
    return;
  }

  const { email, password } = parsed.data;

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email.toLowerCase()))
    .limit(1);

  if (!user || !user.active) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const passwordMatch = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatch) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  if (!user.emailVerifiedAt) {
    res.status(403).json({ error: "Verify your email before signing in.", code: "EMAIL_NOT_VERIFIED" });
    return;
  }

  const accessToken = await signAccessToken({
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  });

  const refreshToken = generateRefreshToken();
  await db.insert(sessionsTable).values({
    userId: user.id,
    refreshToken,
    expiresAt: refreshTokenExpiresAt(),
  });
  setRefreshCookie(res, refreshToken);

  res.json({
    accessToken,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    },
  });
}) as RequestHandler);

// ─── POST /api/auth/refresh ────────────────────────────────────────────────
router.post("/auth/refresh", (async (req, res) => {
  const refreshToken = refreshTokenFromRequest(req);
  if (!refreshToken) {
    res.status(401).json({ error: "Sign in again to refresh your session." });
    return;
  }

  const now = new Date();

  const [session] = await db
    .select()
    .from(sessionsTable)
    .where(
      and(
        eq(sessionsTable.refreshToken, refreshToken),
        gt(sessionsTable.expiresAt, now),
      ),
    )
    .limit(1);

  if (!session) {
    res.status(401).json({ error: "Invalid or expired refresh token" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, session.userId))
    .limit(1);

  if (!user || !user.active) {
    res.status(401).json({ error: "User not found or inactive" });
    return;
  }

  // Rotate: delete old session, issue new pair
  await db.delete(sessionsTable).where(eq(sessionsTable.id, session.id));

  const newRefreshToken = generateRefreshToken();
  await db.insert(sessionsTable).values({
    userId: user.id,
    refreshToken: newRefreshToken,
    expiresAt: refreshTokenExpiresAt(),
  });
  setRefreshCookie(res, newRefreshToken);

  const accessToken = await signAccessToken({
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  });

  res.json({ accessToken });
}) as RequestHandler);

// ─── POST /api/auth/logout ─────────────────────────────────────────────────
router.post("/auth/logout", (async (req, res) => {
  const refreshToken = refreshTokenFromRequest(req);
  if (refreshToken) {
    await db
      .delete(sessionsTable)
      .where(eq(sessionsTable.refreshToken, refreshToken));
  }
  clearRefreshCookie(res);
  res.json({ ok: true });
}) as RequestHandler);

// ─── GET /api/auth/me ──────────────────────────────────────────────────────
router.get("/auth/me", (async (req, res) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authorization header required" });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = await verifyAccessToken(token);
    const [user] = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
        role: usersTable.role,
        active: usersTable.active,
        createdAt: usersTable.createdAt,
      })
      .from(usersTable)
      .where(eq(usersTable.id, payload.sub!))
      .limit(1);

    if (!user || !user.active) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    res.json({ user });
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}) as RequestHandler);

export default router;
