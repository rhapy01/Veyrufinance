ALTER TABLE "trezu_employees"
  ADD COLUMN IF NOT EXISTS "payroll_enabled" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "payout_profile_completed" boolean NOT NULL DEFAULT false;

UPDATE "trezu_employees"
SET "payout_profile_completed" = ("user_id" IS NOT NULL AND NULLIF(BTRIM("wallet_address"), '') IS NOT NULL);

UPDATE "trezu_employees"
SET "payroll_enabled" = "payout_profile_completed";
