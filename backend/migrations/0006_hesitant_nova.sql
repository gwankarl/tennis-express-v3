CREATE TYPE "public"."seller_application_category" AS ENUM('individual', 'commercial');--> statement-breakpoint
CREATE TYPE "public"."seller_application_status" AS ENUM('draft', 'submitted', 'changes_requested', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "seller_onboarding_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"category" "seller_application_category" NOT NULL,
	"status" "seller_application_status" DEFAULT 'draft' NOT NULL,
	"applicant_legal_name" text,
	"area_served" text,
	"contact_phone" text,
	"seller_display_name" text,
	"registered_business_name" text,
	"business_role" text,
	"storefront_name" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"first_submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_onboarding_applications_revision_positive_ck" CHECK ("seller_onboarding_applications"."revision" > 0),
	CONSTRAINT "seller_onboarding_applications_fields_not_blank_ck" CHECK ((
        ("seller_onboarding_applications"."applicant_legal_name" IS NULL OR btrim("seller_onboarding_applications"."applicant_legal_name") <> '')
        AND ("seller_onboarding_applications"."area_served" IS NULL OR btrim("seller_onboarding_applications"."area_served") <> '')
        AND ("seller_onboarding_applications"."contact_phone" IS NULL OR btrim("seller_onboarding_applications"."contact_phone") <> '')
        AND ("seller_onboarding_applications"."seller_display_name" IS NULL OR btrim("seller_onboarding_applications"."seller_display_name") <> '')
        AND ("seller_onboarding_applications"."registered_business_name" IS NULL OR btrim("seller_onboarding_applications"."registered_business_name") <> '')
        AND ("seller_onboarding_applications"."business_role" IS NULL OR btrim("seller_onboarding_applications"."business_role") <> '')
        AND ("seller_onboarding_applications"."storefront_name" IS NULL OR btrim("seller_onboarding_applications"."storefront_name") <> '')
      )),
	CONSTRAINT "seller_onboarding_applications_category_fields_ck" CHECK ((
        ("seller_onboarding_applications"."category" = 'individual'
          AND "seller_onboarding_applications"."registered_business_name" IS NULL
          AND "seller_onboarding_applications"."business_role" IS NULL
          AND "seller_onboarding_applications"."storefront_name" IS NULL)
        OR
        ("seller_onboarding_applications"."category" = 'commercial'
          AND "seller_onboarding_applications"."seller_display_name" IS NULL)
      )),
	CONSTRAINT "seller_onboarding_applications_submission_timestamp_ck" CHECK ((
        ("seller_onboarding_applications"."status" = 'draft' AND "seller_onboarding_applications"."first_submitted_at" IS NULL)
        OR
        ("seller_onboarding_applications"."status" <> 'draft' AND "seller_onboarding_applications"."first_submitted_at" IS NOT NULL)
      ))
);
--> statement-breakpoint
ALTER TABLE "seller_onboarding_applications" ADD CONSTRAINT "seller_onboarding_applications_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "seller_onboarding_applications_user_created_idx" ON "seller_onboarding_applications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "seller_onboarding_applications_status_updated_idx" ON "seller_onboarding_applications" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_onboarding_applications_one_open_per_user_uq" ON "seller_onboarding_applications" USING btree ("user_id") WHERE "seller_onboarding_applications"."status" IN ('draft', 'submitted', 'changes_requested');