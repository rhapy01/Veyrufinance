import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const databaseUrl = new URL(process.env.DATABASE_URL);
const isNeonDatabase = databaseUrl.hostname.endsWith(".neon.tech");

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon endpoints support PostgreSQL's direct TLS negotiation. Without it,
  // some current Neon endpoints accept TCP/TLS but stall on the legacy
  // PostgreSQL SSLRequest handshake used by node-postgres by default.
  ...(isNeonDatabase ? { sslnegotiation: "direct" as const } : {}),
  // Fail promptly when the configured database endpoint is unreachable instead
  // of leaving sign-in and other API requests pending for nearly a minute.
  connectionTimeoutMillis: 10_000,
});
export const db = drizzle(pool, { schema });

export * from "./schema";
