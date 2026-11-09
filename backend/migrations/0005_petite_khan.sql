CREATE TABLE "identity_admin_mfa_elevation_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"challenge_digest" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "identity_admin_mfa_elevation_challenges_digest_not_blank_ck" CHECK ("identity_admin_mfa_elevation_challenges"."challenge_digest" <> ''),
	CONSTRAINT "identity_admin_mfa_elevation_challenges_expiry_ck" CHECK ("identity_admin_mfa_elevation_challenges"."expires_at" > "identity_admin_mfa_elevation_challenges"."issued_at"),
	CONSTRAINT "identity_admin_mfa_elevation_challenges_consumed_ck" CHECK ("identity_admin_mfa_elevation_challenges"."consumed_at" IS NULL OR "identity_admin_mfa_elevation_challenges"."consumed_at" >= "identity_admin_mfa_elevation_challenges"."issued_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "identity_sessions_id_user_id_uq" ON "identity_sessions" USING btree ("id","user_id");
ALTER TABLE "identity_admin_mfa_elevation_challenges" ADD CONSTRAINT "identity_admin_mfa_elevation_challenges_session_user_fk" FOREIGN KEY ("session_id","user_id") REFERENCES "public"."identity_sessions"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_admin_mfa_elevation_challenges_digest_uq" ON "identity_admin_mfa_elevation_challenges" USING btree ("challenge_digest");--> statement-breakpoint
CREATE INDEX "identity_admin_mfa_elevation_challenges_session_expiry_idx" ON "identity_admin_mfa_elevation_challenges" USING btree ("session_id","expires_at");--> statement-breakpoint
CREATE INDEX "identity_admin_mfa_elevation_challenges_user_expiry_idx" ON "identity_admin_mfa_elevation_challenges" USING btree ("user_id","expires_at");--> statement-breakpoint
