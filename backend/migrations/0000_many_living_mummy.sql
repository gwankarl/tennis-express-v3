CREATE TYPE "public"."identity_token_purpose" AS ENUM('email_verification', 'password_reset');--> statement-breakpoint
CREATE TABLE "identity_credentials" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_digest" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_sessions_token_digest_not_blank_ck" CHECK ("identity_sessions"."token_digest" <> ''),
	CONSTRAINT "identity_sessions_idle_before_absolute_ck" CHECK ("identity_sessions"."idle_expires_at" <= "identity_sessions"."absolute_expires_at")
);
--> statement-breakpoint
CREATE TABLE "identity_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" "identity_token_purpose" NOT NULL,
	"token_digest" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_tokens_token_digest_not_blank_ck" CHECK ("identity_tokens"."token_digest" <> '')
);
--> statement-breakpoint
CREATE TABLE "identity_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_email" text NOT NULL,
	"normalized_email" text NOT NULL,
	"status" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_users_emails_not_blank_ck" CHECK ("identity_users"."delivery_email" <> '' AND "identity_users"."normalized_email" <> ''),
	CONSTRAINT "identity_users_normalized_email_lowercase_ck" CHECK ("identity_users"."normalized_email" = lower(btrim("identity_users"."normalized_email")))
);
--> statement-breakpoint
ALTER TABLE "identity_credentials" ADD CONSTRAINT "identity_credentials_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_sessions" ADD CONSTRAINT "identity_sessions_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_tokens" ADD CONSTRAINT "identity_tokens_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_sessions_token_digest_uq" ON "identity_sessions" USING btree ("token_digest");--> statement-breakpoint
CREATE INDEX "identity_sessions_user_revoked_idx" ON "identity_sessions" USING btree ("user_id","revoked_at");--> statement-breakpoint
CREATE INDEX "identity_sessions_idle_expires_idx" ON "identity_sessions" USING btree ("idle_expires_at");--> statement-breakpoint
CREATE INDEX "identity_sessions_absolute_expires_idx" ON "identity_sessions" USING btree ("absolute_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_tokens_token_digest_uq" ON "identity_tokens" USING btree ("token_digest");--> statement-breakpoint
CREATE INDEX "identity_tokens_user_purpose_created_idx" ON "identity_tokens" USING btree ("user_id","purpose","created_at");--> statement-breakpoint
CREATE INDEX "identity_tokens_expires_idx" ON "identity_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_users_normalized_email_uq" ON "identity_users" USING btree ("normalized_email");--> statement-breakpoint
CREATE INDEX "identity_users_status_idx" ON "identity_users" USING btree ("status");