import fs from "node:fs";
import pg from "pg";

const envText = fs.readFileSync(".env.local", "utf8");
const line = envText.split(/\r?\n/).find((item) => /^DATABASE_URL\s*=/.test(item));
if (!process.env.DATABASE_URL && line) process.env.DATABASE_URL = line.slice(line.indexOf("=") + 1).trim().replace(/^['"]|['"]$/g, "");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is unavailable.");

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query(fs.readFileSync("lib/db/migrations/0010_employee_onboarding_before_payroll.sql", "utf8"));
  await client.query("COMMIT");
  process.stdout.write("Employee onboarding migration applied.\n");
} catch (error) {
  await client.query("ROLLBACK");
  process.stderr.write(`Migration failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  await client.end();
}
