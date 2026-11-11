CREATE TABLE "seller_listing_review_outcomes" (
	"revision_id" uuid PRIMARY KEY NOT NULL,
	"listing_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"reviewer_user_id" uuid NOT NULL,
	"feedback" text,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_listing_review_outcomes_decision_ck" CHECK ("seller_listing_review_outcomes"."decision" IN ('changes_requested', 'rejected', 'approved')),
	CONSTRAINT "seller_listing_review_outcomes_feedback_required_ck" CHECK ("seller_listing_review_outcomes"."decision" = 'approved'
        OR ("seller_listing_review_outcomes"."feedback" IS NOT NULL AND btrim("seller_listing_review_outcomes"."feedback") <> ''))
);
--> statement-breakpoint
CREATE TABLE "seller_listing_revision_offers" (
	"listing_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"catalog_variant_id" uuid NOT NULL,
	"seller_listing_variant_id" uuid NOT NULL,
	CONSTRAINT "seller_listing_revision_offers_pk" PRIMARY KEY("revision_id","catalog_variant_id")
);
--> statement-breakpoint
ALTER TABLE "seller_listing_revisions" ADD COLUMN "submitted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "seller_listing_revisions" ADD COLUMN "catalog_snapshot" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "seller_listing_revision_configurations_listing_revision_variant_uq" ON "seller_listing_revision_configurations" USING btree ("listing_id","revision_id","catalog_variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_listing_variants_listing_id_variant_catalog_uq" ON "seller_listing_variants" USING btree ("listing_id","id","catalog_variant_id");--> statement-breakpoint
ALTER TABLE "seller_listing_review_outcomes" ADD CONSTRAINT "seller_listing_review_outcomes_reviewer_user_id_identity_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."identity_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listing_review_outcomes" ADD CONSTRAINT "seller_listing_review_outcomes_revision_fk" FOREIGN KEY ("listing_id","revision_id") REFERENCES "public"."seller_listing_revisions"("listing_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listing_revision_offers" ADD CONSTRAINT "seller_listing_revision_offers_configuration_fk" FOREIGN KEY ("listing_id","revision_id","catalog_variant_id") REFERENCES "public"."seller_listing_revision_configurations"("listing_id","revision_id","catalog_variant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listing_revision_offers" ADD CONSTRAINT "seller_listing_revision_offers_variant_fk" FOREIGN KEY ("listing_id","seller_listing_variant_id","catalog_variant_id") REFERENCES "public"."seller_listing_variants"("listing_id","id","catalog_variant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "seller_listing_review_outcomes_listing_reviewed_idx" ON "seller_listing_review_outcomes" USING btree ("listing_id","reviewed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_listing_revision_offers_revision_offer_uq" ON "seller_listing_revision_offers" USING btree ("revision_id","seller_listing_variant_id");--> statement-breakpoint
ALTER TABLE "seller_listing_revisions" ADD CONSTRAINT "seller_listing_revisions_submitted_by_user_id_identity_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."identity_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listing_revisions" ADD CONSTRAINT "seller_listing_revisions_catalog_snapshot_object_ck" CHECK ("seller_listing_revisions"."catalog_snapshot" IS NULL OR jsonb_typeof("seller_listing_revisions"."catalog_snapshot") = 'object');
