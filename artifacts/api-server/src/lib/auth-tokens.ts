/**
 * JWT + refresh-token utilities.
 *
 * Access tokens  — short-lived (15 min), signed HS256 JWT, sent in Authorization header.
 * Refresh tokens — long-lived (30 days), random opaque string stored in trezu_sessions.
 *
 * Required env vars:
 *   JWT_SECRET        — at least 32 random characters
 *   JWT_EXPIRES_IN    — optional, e.g. "15m" (default: 15m)
 *   REFRESH_EXPIRES_IN — optional, milliseconds (default: 30 days)
 */

import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { randomBytes } from "crypto";

export const getJwtSecret = (): Uint8Array => {
  const s = process.env["JWT_SECRET"];
  if (!s || s.length < 32) {
    throw new Error(
      "JWT_SECRET env var must be set and at least 32 characters long.",
    );
  }
  return new TextEncoder().encode(s);
};

const ACCESS_TOKEN_TTL = process.env["JWT_EXPIRES_IN"] ?? "15m";
const REFRESH_TOKEN_TTL_MS =
  Number(process.env["REFRESH_EXPIRES_IN"] ?? 0) || 30 * 24 * 60 * 60 * 1000; // 30 days

export interface AccessTokenPayload extends JWTPayload {
  sub: string;       // userId
  email: string;
  name: string;
  role: string;
}

/** Sign a new access token for the given user. */
export async function signAccessToken(
  payload: Omit<AccessTokenPayload, "iat" | "exp">,
): Promise<string> {
  return new SignJWT({ email: payload.email, name: payload.name, role: payload.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_TTL)
    .sign(getJwtSecret());
}

/** Verify an access token. Throws on invalid/expired. */
export async function verifyAccessToken(
  token: string,
): Promise<AccessTokenPayload> {
  const { payload } = await jwtVerify(token, getJwtSecret());
  return payload as AccessTokenPayload;
}

/** Generate a secure random refresh token string. */
export function generateRefreshToken(): string {
  return randomBytes(48).toString("hex");
}

/** Compute the expiry Date for a new refresh token. */
export function refreshTokenExpiresAt(): Date {
  return new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
}
