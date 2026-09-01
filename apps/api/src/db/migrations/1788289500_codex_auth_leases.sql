ALTER TABLE "codex_auth_accounts"
  ADD COLUMN "lease_owner" text,
  ADD COLUMN "lease_expires_at" timestamp with time zone;
