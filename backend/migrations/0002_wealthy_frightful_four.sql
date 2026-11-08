CREATE TYPE "public"."identity_admin_audit_actor_type" AS ENUM('user', 'operator', 'system');--> statement-breakpoint
CREATE TYPE "public"."identity_admin_audit_event_type" AS ENUM('administrator_granted', 'administrator_revoked', 'mfa_enrollment_authorized', 'mfa_enrollment_started', 'mfa_enrollment_confirmed', 'mfa_factor_revoked', 'mfa_elevation_succeeded', 'mfa_elevation_failed', 'mfa_recovery_requested', 'mfa_recovery_approved', 'mfa_recovery_completed', 'mfa_recovery_denied');--> statement-breakpoint
CREATE TYPE "public"."identity_admin_audit_outcome" AS ENUM('success', 'denied', 'pending');--> statement-breakpoint
CREATE TYPE "public"."identity_mfa_attempt_action" AS ENUM('enrollment', 'elevation', 'recovery');--> statement-breakpoint
CREATE TYPE "public"."identity_mfa_attempt_scope" AS ENUM('account', 'ip');--> statement-breakpoint
CREATE TYPE "public"."identity_mfa_factor_status" AS ENUM('pending', 'active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."identity_mfa_recovery_method" AS ENUM('recovery_code', 'operator');--> statement-breakpoint
CREATE TYPE "public"."identity_mfa_recovery_status" AS ENUM('requested', 'approved', 'completed', 'denied', 'cancelled');--> statement-breakpoint
CREATE TABLE "identity_admin_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" "identity_admin_audit_event_type" NOT NULL,
	"outcome" "identity_admin_audit_outcome" NOT NULL,
	"actor_type" "identity_admin_audit_actor_type" NOT NULL,
	"actor_user_id" uuid,
	"actor_operator_id" text,
	"approver_operator_id" text,
	"target_user_id" uuid,
	"session_id" uuid,
	"request_id" text,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_admin_audit_events_actor_shape_ck" CHECK ((
        ("identity_admin_audit_events"."actor_type" = 'user'
          AND "identity_admin_audit_events"."actor_user_id" IS NOT NULL
          AND "identity_admin_audit_events"."actor_operator_id" IS NULL)
        OR
        ("identity_admin_audit_events"."actor_type" = 'operator'
          AND "identity_admin_audit_events"."actor_user_id" IS NULL
          AND "identity_admin_audit_events"."actor_operator_id" IS NOT NULL)
        OR
        ("identity_admin_audit_events"."actor_type" = 'system'
          AND "identity_admin_audit_events"."actor_user_id" IS NULL
          AND "identity_admin_audit_events"."actor_operator_id" IS NULL)
      )),
	CONSTRAINT "identity_admin_audit_events_approvers_distinct_ck" CHECK ("identity_admin_audit_events"."approver_operator_id" IS NULL
        OR "identity_admin_audit_events"."actor_operator_id" IS NULL
        OR "identity_admin_audit_events"."approver_operator_id" <> "identity_admin_audit_events"."actor_operator_id")
);
--> statement-breakpoint
CREATE TABLE "identity_admin_enrollment_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_user_id" uuid NOT NULL,
	"authorization_digest" text NOT NULL,
	"issued_by_operator_id" text NOT NULL,
	"approved_by_operator_id" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "identity_admin_enrollment_authorizations_digest_not_blank_ck" CHECK ("identity_admin_enrollment_authorizations"."authorization_digest" <> ''),
	CONSTRAINT "identity_admin_enrollment_authorizations_operators_distinct_ck" CHECK ("identity_admin_enrollment_authorizations"."issued_by_operator_id" <> "identity_admin_enrollment_authorizations"."approved_by_operator_id"),
	CONSTRAINT "identity_admin_enrollment_authorizations_expiry_ck" CHECK ("identity_admin_enrollment_authorizations"."expires_at" > "identity_admin_enrollment_authorizations"."issued_at")
);
--> statement-breakpoint
CREATE TABLE "identity_mfa_attempt_counters" (
	"scope" "identity_mfa_attempt_scope" NOT NULL,
	"action" "identity_mfa_attempt_action" NOT NULL,
	"subject_digest" text NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"blocked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_mfa_attempt_counters_pk" PRIMARY KEY("scope","action","subject_digest"),
	CONSTRAINT "identity_mfa_attempt_counters_subject_not_blank_ck" CHECK ("identity_mfa_attempt_counters"."subject_digest" <> ''),
	CONSTRAINT "identity_mfa_attempt_counters_nonnegative_ck" CHECK ("identity_mfa_attempt_counters"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "identity_mfa_factors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"factor_type" text DEFAULT 'totp' NOT NULL,
	"status" "identity_mfa_factor_status" NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"key_version" text NOT NULL,
	"pending_expires_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_accepted_time_step" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_mfa_factors_type_ck" CHECK ("identity_mfa_factors"."factor_type" = 'totp'),
	CONSTRAINT "identity_mfa_factors_secret_not_blank_ck" CHECK ("identity_mfa_factors"."secret_ciphertext" <> '' AND "identity_mfa_factors"."key_version" <> ''),
	CONSTRAINT "identity_mfa_factors_state_ck" CHECK ((
        ("identity_mfa_factors"."status" = 'pending'
          AND "identity_mfa_factors"."pending_expires_at" IS NOT NULL
          AND "identity_mfa_factors"."confirmed_at" IS NULL
          AND "identity_mfa_factors"."revoked_at" IS NULL)
        OR
        ("identity_mfa_factors"."status" = 'active'
          AND "identity_mfa_factors"."pending_expires_at" IS NULL
          AND "identity_mfa_factors"."confirmed_at" IS NOT NULL
          AND "identity_mfa_factors"."revoked_at" IS NULL)
        OR
        ("identity_mfa_factors"."status" = 'revoked' AND "identity_mfa_factors"."revoked_at" IS NOT NULL)
      )),
	CONSTRAINT "identity_mfa_factors_last_step_nonnegative_ck" CHECK ("identity_mfa_factors"."last_accepted_time_step" IS NULL OR "identity_mfa_factors"."last_accepted_time_step" >= 0)
);
--> statement-breakpoint
CREATE TABLE "identity_mfa_recoveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"method" "identity_mfa_recovery_method" NOT NULL,
	"status" "identity_mfa_recovery_status" NOT NULL,
	"requested_by_operator_id" text,
	"approved_by_operator_id" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"admin_hold_until" timestamp with time zone,
	CONSTRAINT "identity_mfa_recoveries_operator_approvals_distinct_ck" CHECK ("identity_mfa_recoveries"."requested_by_operator_id" IS NULL
        OR "identity_mfa_recoveries"."approved_by_operator_id" IS NULL
        OR "identity_mfa_recoveries"."requested_by_operator_id" <> "identity_mfa_recoveries"."approved_by_operator_id"),
	CONSTRAINT "identity_mfa_recoveries_operator_approval_required_ck" CHECK ("identity_mfa_recoveries"."method" <> 'operator'
        OR "identity_mfa_recoveries"."status" NOT IN ('approved', 'completed')
        OR ("identity_mfa_recoveries"."requested_by_operator_id" IS NOT NULL
          AND "identity_mfa_recoveries"."approved_by_operator_id" IS NOT NULL)),
	CONSTRAINT "identity_mfa_recoveries_approval_timestamp_pair_ck" CHECK (("identity_mfa_recoveries"."approved_at" IS NULL) = ("identity_mfa_recoveries"."approved_by_operator_id" IS NULL)),
	CONSTRAINT "identity_mfa_recoveries_hold_timestamp_ck" CHECK ((
        ("identity_mfa_recoveries"."completed_at" IS NULL AND "identity_mfa_recoveries"."admin_hold_until" IS NULL)
        OR
        ("identity_mfa_recoveries"."completed_at" IS NOT NULL
          AND "identity_mfa_recoveries"."admin_hold_until" = "identity_mfa_recoveries"."completed_at" + interval '24 hours')
      )),
	CONSTRAINT "identity_mfa_recoveries_completed_state_ck" CHECK ("identity_mfa_recoveries"."status" <> 'completed' OR "identity_mfa_recoveries"."completed_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "identity_mfa_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"factor_id" uuid NOT NULL,
	"code_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "identity_mfa_recovery_codes_digest_not_blank_ck" CHECK ("identity_mfa_recovery_codes"."code_digest" <> ''),
	CONSTRAINT "identity_mfa_recovery_codes_single_terminal_state_ck" CHECK ("identity_mfa_recovery_codes"."consumed_at" IS NULL OR "identity_mfa_recovery_codes"."revoked_at" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "identity_sessions" ADD COLUMN "admin_mfa_elevated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "identity_sessions" ADD COLUMN "admin_mfa_elevated_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "identity_admin_enrollment_authorizations" ADD CONSTRAINT "identity_admin_enrollment_authorizations_target_user_id_identity_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_mfa_factors" ADD CONSTRAINT "identity_mfa_factors_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_mfa_recoveries" ADD CONSTRAINT "identity_mfa_recoveries_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_mfa_recovery_codes" ADD CONSTRAINT "identity_mfa_recovery_codes_factor_id_identity_mfa_factors_id_fk" FOREIGN KEY ("factor_id") REFERENCES "public"."identity_mfa_factors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_admin_audit_events_target_time_idx" ON "identity_admin_audit_events" USING btree ("target_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "identity_admin_audit_events_type_time_idx" ON "identity_admin_audit_events" USING btree ("event_type","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_admin_enrollment_authorizations_digest_uq" ON "identity_admin_enrollment_authorizations" USING btree ("authorization_digest");--> statement-breakpoint
CREATE INDEX "identity_admin_enrollment_authorizations_target_expiry_idx" ON "identity_admin_enrollment_authorizations" USING btree ("target_user_id","expires_at");--> statement-breakpoint
CREATE INDEX "identity_mfa_attempt_counters_blocked_idx" ON "identity_mfa_attempt_counters" USING btree ("blocked_until");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_mfa_factors_one_current_per_user_uq" ON "identity_mfa_factors" USING btree ("user_id") WHERE "identity_mfa_factors"."status" IN ('pending', 'active');--> statement-breakpoint
CREATE INDEX "identity_mfa_factors_user_status_idx" ON "identity_mfa_factors" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_mfa_recoveries_one_open_per_user_uq" ON "identity_mfa_recoveries" USING btree ("user_id") WHERE "identity_mfa_recoveries"."status" IN ('requested', 'approved');--> statement-breakpoint
CREATE INDEX "identity_mfa_recoveries_user_hold_idx" ON "identity_mfa_recoveries" USING btree ("user_id","admin_hold_until");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_mfa_recovery_codes_digest_uq" ON "identity_mfa_recovery_codes" USING btree ("code_digest");--> statement-breakpoint
CREATE INDEX "identity_mfa_recovery_codes_factor_status_idx" ON "identity_mfa_recovery_codes" USING btree ("factor_id","consumed_at","revoked_at");--> statement-breakpoint
CREATE INDEX "identity_sessions_user_admin_mfa_until_idx" ON "identity_sessions" USING btree ("user_id","admin_mfa_elevated_until");--> statement-breakpoint
ALTER TABLE "identity_sessions" ADD CONSTRAINT "identity_sessions_admin_mfa_elevation_ck" CHECK ((
        ("identity_sessions"."admin_mfa_elevated_at" IS NULL
          AND "identity_sessions"."admin_mfa_elevated_until" IS NULL)
        OR
        ("identity_sessions"."admin_mfa_elevated_at" IS NOT NULL
          AND "identity_sessions"."admin_mfa_elevated_until" IS NOT NULL
          AND "identity_sessions"."admin_mfa_elevated_until" > "identity_sessions"."admin_mfa_elevated_at"
          AND "identity_sessions"."admin_mfa_elevated_until" <= "identity_sessions"."absolute_expires_at")
      ));