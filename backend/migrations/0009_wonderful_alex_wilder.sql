CREATE TYPE "public"."seller_application_review_decision" AS ENUM('approve', 'request_changes', 'reject');--> statement-breakpoint
CREATE TYPE "public"."seller_operating_access_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TABLE "seller_application_review_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"reviewed_revision" integer NOT NULL,
	"reviewer_user_id" uuid NOT NULL,
	"decision" "seller_application_review_decision" NOT NULL,
	"feedback" text,
	"requested_evidence" "seller_application_evidence_type"[] DEFAULT ARRAY[]::seller_application_evidence_type[] NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_application_review_decisions_revision_positive_ck" CHECK ("seller_application_review_decisions"."reviewed_revision" > 0),
	CONSTRAINT "seller_application_review_decisions_feedback_required_ck" CHECK ((
        "seller_application_review_decisions"."decision" = 'approve'
        OR ("seller_application_review_decisions"."feedback" IS NOT NULL AND btrim("seller_application_review_decisions"."feedback") <> '')
      )),
	CONSTRAINT "seller_application_review_decisions_requested_evidence_ck" CHECK ("seller_application_review_decisions"."decision" = 'request_changes'
        OR cardinality("seller_application_review_decisions"."requested_evidence") = 0)
);
--> statement-breakpoint
CREATE TABLE "seller_onboarding_operating_access" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"status" "seller_operating_access_status" DEFAULT 'active' NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_onboarding_operating_access_application_id_unique" UNIQUE("application_id")
);
--> statement-breakpoint
ALTER TABLE "seller_application_review_decisions" ADD CONSTRAINT "seller_application_review_decisions_application_id_seller_onboarding_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."seller_onboarding_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_application_review_decisions" ADD CONSTRAINT "seller_application_review_decisions_reviewer_user_id_identity_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."identity_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_onboarding_operating_access" ADD CONSTRAINT "seller_onboarding_operating_access_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_onboarding_operating_access" ADD CONSTRAINT "seller_onboarding_operating_access_application_id_seller_onboarding_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."seller_onboarding_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "seller_application_review_decisions_revision_uq" ON "seller_application_review_decisions" USING btree ("application_id","reviewed_revision");--> statement-breakpoint
CREATE INDEX "seller_application_review_decisions_reviewer_time_idx" ON "seller_application_review_decisions" USING btree ("reviewer_user_id","decided_at");--> statement-breakpoint
CREATE INDEX "seller_onboarding_operating_access_status_idx" ON "seller_onboarding_operating_access" USING btree ("status","updated_at");