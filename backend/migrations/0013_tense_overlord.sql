CREATE TYPE "public"."seller_listing_condition" AS ENUM('new', 'like_new', 'good', 'fair');--> statement-breakpoint
CREATE TYPE "public"."seller_listing_status" AS ENUM('draft', 'submitted', 'changes_requested', 'rejected', 'approved');--> statement-breakpoint
CREATE TABLE "seller_listing_approved_revisions" (
	"listing_id" uuid PRIMARY KEY NOT NULL,
	"revision_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seller_listing_draft_configurations" (
	"listing_id" uuid NOT NULL,
	"catalog_product_id" uuid NOT NULL,
	"catalog_variant_id" uuid NOT NULL,
	CONSTRAINT "seller_listing_draft_configurations_pk" PRIMARY KEY("listing_id","catalog_variant_id")
);
--> statement-breakpoint
CREATE TABLE "seller_listing_drafts" (
	"listing_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"catalog_product_id" uuid NOT NULL,
	"title" text,
	"description" text,
	"condition" "seller_listing_condition",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_listing_drafts_revision_positive_ck" CHECK ("seller_listing_drafts"."revision" > 0),
	CONSTRAINT "seller_listing_drafts_title_ck" CHECK ((
        "seller_listing_drafts"."title" IS NULL
        OR (
          btrim("seller_listing_drafts"."title") <> ''
          AND char_length("seller_listing_drafts"."title") <= 120
        )
      )),
	CONSTRAINT "seller_listing_drafts_description_ck" CHECK ((
        "seller_listing_drafts"."description" IS NULL
        OR char_length("seller_listing_drafts"."description") <= 5000
      ))
);
--> statement-breakpoint
CREATE TABLE "seller_listing_revision_configurations" (
	"listing_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"catalog_product_id" uuid NOT NULL,
	"catalog_variant_id" uuid NOT NULL,
	CONSTRAINT "seller_listing_revision_configurations_pk" PRIMARY KEY("revision_id","catalog_variant_id")
);
--> statement-breakpoint
CREATE TABLE "seller_listing_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"catalog_product_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"condition" "seller_listing_condition" NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_listing_revisions_revision_positive_ck" CHECK ("seller_listing_revisions"."revision" > 0),
	CONSTRAINT "seller_listing_revisions_title_ck" CHECK (btrim("seller_listing_revisions"."title") <> '' AND char_length("seller_listing_revisions"."title") <= 120),
	CONSTRAINT "seller_listing_revisions_description_ck" CHECK ("seller_listing_revisions"."description" IS NULL OR char_length("seller_listing_revisions"."description") <= 5000)
);
--> statement-breakpoint
CREATE TABLE "seller_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"status" "seller_listing_status" DEFAULT 'draft' NOT NULL,
	"paused_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"administrator_removed_at" timestamp with time zone,
	"control_revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_listings_control_revision_positive_ck" CHECK ("seller_listings"."control_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "seller_listing_approved_revisions" ADD CONSTRAINT "seller_listing_approved_revisions_listing_id_seller_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."seller_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listing_approved_revisions" ADD CONSTRAINT "seller_listing_approved_revisions_revision_id_seller_listing_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."seller_listing_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listing_draft_configurations" ADD CONSTRAINT "seller_listing_draft_configurations_listing_id_seller_listing_drafts_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."seller_listing_drafts"("listing_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listing_draft_configurations" ADD CONSTRAINT "seller_listing_draft_configurations_catalog_product_id_catalog_products_id_fk" FOREIGN KEY ("catalog_product_id") REFERENCES "public"."catalog_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listing_draft_configurations" ADD CONSTRAINT "seller_listing_draft_configurations_catalog_variant_id_catalog_variants_id_fk" FOREIGN KEY ("catalog_variant_id") REFERENCES "public"."catalog_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listing_drafts" ADD CONSTRAINT "seller_listing_drafts_listing_id_seller_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."seller_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listing_drafts" ADD CONSTRAINT "seller_listing_drafts_catalog_product_id_catalog_products_id_fk" FOREIGN KEY ("catalog_product_id") REFERENCES "public"."catalog_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listing_revision_configurations" ADD CONSTRAINT "seller_listing_revision_configurations_listing_id_seller_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."seller_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listing_revision_configurations" ADD CONSTRAINT "seller_listing_revision_configurations_revision_id_seller_listing_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."seller_listing_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listing_revision_configurations" ADD CONSTRAINT "seller_listing_revision_configurations_catalog_product_id_catalog_products_id_fk" FOREIGN KEY ("catalog_product_id") REFERENCES "public"."catalog_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listing_revision_configurations" ADD CONSTRAINT "seller_listing_revision_configurations_catalog_variant_id_catalog_variants_id_fk" FOREIGN KEY ("catalog_variant_id") REFERENCES "public"."catalog_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listing_revisions" ADD CONSTRAINT "seller_listing_revisions_listing_id_seller_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."seller_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listing_revisions" ADD CONSTRAINT "seller_listing_revisions_catalog_product_id_catalog_products_id_fk" FOREIGN KEY ("catalog_product_id") REFERENCES "public"."catalog_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listings" ADD CONSTRAINT "seller_listings_seller_id_identity_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "seller_listing_approved_revisions_revision_uq" ON "seller_listing_approved_revisions" USING btree ("revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_listing_drafts_listing_product_uq" ON "seller_listing_drafts" USING btree ("listing_id","catalog_product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_listing_revisions_listing_revision_uq" ON "seller_listing_revisions" USING btree ("listing_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_listing_revisions_listing_id_product_uq" ON "seller_listing_revisions" USING btree ("listing_id","id","catalog_product_id");--> statement-breakpoint
CREATE INDEX "seller_listings_seller_created_idx" ON "seller_listings" USING btree ("seller_id","created_at","id");--> statement-breakpoint
CREATE INDEX "seller_listings_status_updated_idx" ON "seller_listings" USING btree ("status","updated_at");