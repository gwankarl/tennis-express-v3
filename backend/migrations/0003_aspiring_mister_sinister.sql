ALTER TYPE "public"."identity_admin_audit_event_type" ADD VALUE 'administrator_revocation_emergency' BEFORE 'mfa_enrollment_authorized';--> statement-breakpoint
ALTER TYPE "public"."identity_admin_audit_event_type" ADD VALUE 'administrator_revocation_reviewed' BEFORE 'mfa_enrollment_authorized';--> statement-breakpoint
ALTER TYPE "public"."identity_admin_audit_outcome" ADD VALUE 'no_op';--> statement-breakpoint
CREATE TABLE "identity_admin_operations" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"target_user_id" uuid NOT NULL,
	"case_reference" text NOT NULL,
	"reason" text NOT NULL,
	"intent_digest" text NOT NULL,
	"outcome" text NOT NULL,
	"actor_operator_id" text NOT NULL,
	"approver_operator_id" text,
	"related_operation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_admin_operations_action_ck" CHECK ("identity_admin_operations"."action" IN ('grant', 'revoke', 'emergency_revoke', 'review_emergency_revoke')),
	CONSTRAINT "identity_admin_operations_outcome_ck" CHECK ("identity_admin_operations"."outcome" IN ('completed', 'rejected', 'no_op', 'reviewed')),
	CONSTRAINT "identity_admin_operations_reason_not_blank_ck" CHECK ("identity_admin_operations"."reason" <> '' AND "identity_admin_operations"."case_reference" <> '' AND "identity_admin_operations"."intent_digest" <> ''),
	CONSTRAINT "identity_admin_operations_approvers_distinct_ck" CHECK ("identity_admin_operations"."approver_operator_id" IS NULL OR "identity_admin_operations"."actor_operator_id" <> "identity_admin_operations"."approver_operator_id")
);
--> statement-breakpoint
ALTER TABLE "identity_admin_audit_events" ADD COLUMN "operation_id" uuid;--> statement-breakpoint
ALTER TABLE "identity_admin_audit_events" ADD COLUMN "case_reference" text;--> statement-breakpoint
CREATE INDEX "identity_admin_operations_target_time_idx" ON "identity_admin_operations" USING btree ("target_user_id","created_at");--> statement-breakpoint
CREATE INDEX "identity_admin_operations_case_idx" ON "identity_admin_operations" USING btree ("case_reference");--> statement-breakpoint
CREATE INDEX "identity_admin_audit_events_operation_idx" ON "identity_admin_audit_events" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "identity_admin_audit_events_case_idx" ON "identity_admin_audit_events" USING btree ("case_reference");