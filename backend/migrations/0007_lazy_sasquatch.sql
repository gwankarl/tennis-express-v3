CREATE TYPE "public"."seller_application_evidence_type" AS ENUM('applicant_id', 'business_registration', 'proof_of_authority');--> statement-breakpoint
CREATE TYPE "public"."seller_evidence_media_type" AS ENUM('image/jpeg', 'image/png', 'application/pdf');--> statement-breakpoint
CREATE TABLE "seller_application_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"type" "seller_application_evidence_type" NOT NULL,
	"storage_key" text NOT NULL,
	"media_type" "seller_evidence_media_type" NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_application_evidence_storage_key_not_blank_ck" CHECK (btrim("seller_application_evidence"."storage_key") <> ''),
	CONSTRAINT "seller_application_evidence_byte_size_ck" CHECK ("seller_application_evidence"."byte_size" BETWEEN 1 AND 10485760),
	CONSTRAINT "seller_application_evidence_sha256_format_ck" CHECK ("seller_application_evidence"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "seller_application_evidence" ADD CONSTRAINT "seller_application_evidence_application_id_seller_onboarding_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."seller_onboarding_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "seller_application_evidence_application_type_uq" ON "seller_application_evidence" USING btree ("application_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_application_evidence_storage_key_uq" ON "seller_application_evidence" USING btree ("storage_key");