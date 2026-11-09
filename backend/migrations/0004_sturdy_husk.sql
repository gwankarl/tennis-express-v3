ALTER TABLE "identity_admin_enrollment_authorizations" DROP CONSTRAINT "identity_admin_enrollment_authorizations_operators_distinct_ck";--> statement-breakpoint
ALTER TABLE "identity_admin_operations" DROP CONSTRAINT "identity_admin_operations_action_ck";--> statement-breakpoint
ALTER TABLE "identity_mfa_factors" DROP CONSTRAINT "identity_mfa_factors_state_ck";--> statement-breakpoint
ALTER TABLE "identity_admin_enrollment_authorizations" ALTER COLUMN "issued_by_operator_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "identity_admin_enrollment_authorizations" ALTER COLUMN "approved_by_operator_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "identity_admin_enrollment_authorizations" ADD COLUMN "recovery_id" uuid;--> statement-breakpoint
ALTER TABLE "identity_mfa_factors" ADD COLUMN "pending_session_id" uuid;--> statement-breakpoint
ALTER TABLE "identity_admin_enrollment_authorizations" ADD CONSTRAINT "identity_admin_enrollment_authorizations_recovery_id_identity_mfa_recoveries_id_fk" FOREIGN KEY ("recovery_id") REFERENCES "public"."identity_mfa_recoveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_mfa_factors" ADD CONSTRAINT "identity_mfa_factors_pending_session_id_identity_sessions_id_fk" FOREIGN KEY ("pending_session_id") REFERENCES "public"."identity_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_admin_enrollment_authorizations_recovery_uq" ON "identity_admin_enrollment_authorizations" USING btree ("recovery_id");--> statement-breakpoint
ALTER TABLE "identity_admin_enrollment_authorizations" ADD CONSTRAINT "identity_admin_enrollment_authorizations_issuer_shape_ck" CHECK ((
        ("identity_admin_enrollment_authorizations"."recovery_id" IS NULL
          AND "identity_admin_enrollment_authorizations"."issued_by_operator_id" IS NOT NULL
          AND "identity_admin_enrollment_authorizations"."approved_by_operator_id" IS NOT NULL
          AND "identity_admin_enrollment_authorizations"."issued_by_operator_id" <> "identity_admin_enrollment_authorizations"."approved_by_operator_id")
        OR
        ("identity_admin_enrollment_authorizations"."recovery_id" IS NOT NULL
          AND "identity_admin_enrollment_authorizations"."issued_by_operator_id" IS NULL
          AND "identity_admin_enrollment_authorizations"."approved_by_operator_id" IS NULL)
      ));--> statement-breakpoint
ALTER TABLE "identity_admin_operations" ADD CONSTRAINT "identity_admin_operations_action_ck" CHECK ("identity_admin_operations"."action" IN ('grant', 'revoke', 'emergency_revoke', 'review_emergency_revoke', 'operator_mfa_recovery'));--> statement-breakpoint
ALTER TABLE "identity_mfa_factors" ADD CONSTRAINT "identity_mfa_factors_state_ck" CHECK ((
        ("identity_mfa_factors"."status" = 'pending'
          AND "identity_mfa_factors"."pending_expires_at" IS NOT NULL
          AND "identity_mfa_factors"."pending_session_id" IS NOT NULL
          AND "identity_mfa_factors"."confirmed_at" IS NULL
          AND "identity_mfa_factors"."revoked_at" IS NULL)
        OR
        ("identity_mfa_factors"."status" = 'active'
          AND "identity_mfa_factors"."pending_expires_at" IS NULL
          AND "identity_mfa_factors"."pending_session_id" IS NULL
          AND "identity_mfa_factors"."confirmed_at" IS NOT NULL
          AND "identity_mfa_factors"."revoked_at" IS NULL)
        OR
        ("identity_mfa_factors"."status" = 'revoked'
          AND "identity_mfa_factors"."pending_session_id" IS NULL
          AND "identity_mfa_factors"."revoked_at" IS NOT NULL)
      ));