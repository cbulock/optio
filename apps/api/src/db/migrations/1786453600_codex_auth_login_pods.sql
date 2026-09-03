ALTER TABLE "codex_auth_accounts"
  ADD COLUMN "login_pod_id" text;

ALTER TABLE "codex_auth_accounts"
  ADD COLUMN "login_pod_name" text;

ALTER TABLE "codex_auth_accounts"
  ADD COLUMN "login_expires_at" timestamp with time zone;
