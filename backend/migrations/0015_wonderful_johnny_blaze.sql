CREATE TYPE "public"."seller_listing_image_lifecycle" AS ENUM('ready', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."seller_listing_image_media_type" AS ENUM('image/jpeg', 'image/png', 'image/webp');--> statement-breakpoint
CREATE TABLE "seller_listing_draft_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"image_id" uuid NOT NULL,
	"variant_id" uuid,
	"sort_order" integer NOT NULL,
	"is_cover" boolean DEFAULT false NOT NULL,
	CONSTRAINT "seller_listing_draft_images_order_ck" CHECK ("seller_listing_draft_images"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "seller_listing_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"storage_key" uuid NOT NULL,
	"media_type" "seller_listing_image_media_type" NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"sha256" text NOT NULL,
	"lifecycle" "seller_listing_image_lifecycle" DEFAULT 'ready' NOT NULL,
	"unreferenced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_listing_images_size_ck" CHECK ("seller_listing_images"."byte_size" BETWEEN 1 AND 8388608),
	CONSTRAINT "seller_listing_images_dimensions_ck" CHECK ("seller_listing_images"."width" >= 320
        AND "seller_listing_images"."height" >= 320
        AND "seller_listing_images"."width" <= 8000
        AND "seller_listing_images"."height" <= 8000
        AND "seller_listing_images"."width"::bigint * "seller_listing_images"."height"::bigint <= 40000000),
	CONSTRAINT "seller_listing_images_sha256_ck" CHECK ("seller_listing_images"."sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "seller_listing_images_cleanup_state_ck" CHECK ("seller_listing_images"."lifecycle" = 'ready'
        OR "seller_listing_images"."unreferenced_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "seller_listing_revision_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"image_id" uuid NOT NULL,
	"variant_id" uuid,
	"sort_order" integer NOT NULL,
	"is_cover" boolean DEFAULT false NOT NULL,
	CONSTRAINT "seller_listing_revision_images_order_ck" CHECK ("seller_listing_revision_images"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "seller_listing_images_listing_id_id_uq" ON "seller_listing_images" USING btree ("listing_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_listing_revisions_listing_id_uq" ON "seller_listing_revisions" USING btree ("listing_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_listing_variants_listing_id_uq" ON "seller_listing_variants" USING btree ("listing_id","id");--> statement-breakpoint
ALTER TABLE "seller_listing_draft_images" ADD CONSTRAINT "seller_listing_draft_images_listing_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."seller_listing_drafts"("listing_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listing_draft_images" ADD CONSTRAINT "seller_listing_draft_images_image_fk" FOREIGN KEY ("listing_id","image_id") REFERENCES "public"."seller_listing_images"("listing_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listing_draft_images" ADD CONSTRAINT "seller_listing_draft_images_variant_fk" FOREIGN KEY ("listing_id","variant_id") REFERENCES "public"."seller_listing_variants"("listing_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listing_images" ADD CONSTRAINT "seller_listing_images_listing_id_seller_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."seller_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listing_revision_images" ADD CONSTRAINT "seller_listing_revision_images_revision_fk" FOREIGN KEY ("listing_id","revision_id") REFERENCES "public"."seller_listing_revisions"("listing_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listing_revision_images" ADD CONSTRAINT "seller_listing_revision_images_image_fk" FOREIGN KEY ("listing_id","image_id") REFERENCES "public"."seller_listing_images"("listing_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listing_revision_images" ADD CONSTRAINT "seller_listing_revision_images_variant_fk" FOREIGN KEY ("listing_id","variant_id") REFERENCES "public"."seller_listing_variants"("listing_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "seller_listing_draft_images_common_image_uq" ON "seller_listing_draft_images" USING btree ("listing_id","image_id") WHERE "seller_listing_draft_images"."variant_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "seller_listing_draft_images_variant_image_uq" ON "seller_listing_draft_images" USING btree ("listing_id","image_id","variant_id") WHERE "seller_listing_draft_images"."variant_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "seller_listing_draft_images_common_order_uq" ON "seller_listing_draft_images" USING btree ("listing_id","sort_order") WHERE "seller_listing_draft_images"."variant_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "seller_listing_draft_images_variant_order_uq" ON "seller_listing_draft_images" USING btree ("listing_id","variant_id","sort_order") WHERE "seller_listing_draft_images"."variant_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "seller_listing_draft_images_common_cover_uq" ON "seller_listing_draft_images" USING btree ("listing_id") WHERE "seller_listing_draft_images"."variant_id" IS NULL AND "seller_listing_draft_images"."is_cover" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "seller_listing_draft_images_variant_cover_uq" ON "seller_listing_draft_images" USING btree ("listing_id","variant_id") WHERE "seller_listing_draft_images"."variant_id" IS NOT NULL AND "seller_listing_draft_images"."is_cover" = true;--> statement-breakpoint
CREATE INDEX "seller_listing_draft_images_image_idx" ON "seller_listing_draft_images" USING btree ("image_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_listing_images_storage_key_uq" ON "seller_listing_images" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "seller_listing_images_cleanup_idx" ON "seller_listing_images" USING btree ("lifecycle","unreferenced_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_listing_revision_images_common_image_uq" ON "seller_listing_revision_images" USING btree ("revision_id","image_id") WHERE "seller_listing_revision_images"."variant_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "seller_listing_revision_images_variant_image_uq" ON "seller_listing_revision_images" USING btree ("revision_id","image_id","variant_id") WHERE "seller_listing_revision_images"."variant_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "seller_listing_revision_images_common_order_uq" ON "seller_listing_revision_images" USING btree ("revision_id","sort_order") WHERE "seller_listing_revision_images"."variant_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "seller_listing_revision_images_variant_order_uq" ON "seller_listing_revision_images" USING btree ("revision_id","variant_id","sort_order") WHERE "seller_listing_revision_images"."variant_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "seller_listing_revision_images_common_cover_uq" ON "seller_listing_revision_images" USING btree ("revision_id") WHERE "seller_listing_revision_images"."variant_id" IS NULL AND "seller_listing_revision_images"."is_cover" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "seller_listing_revision_images_variant_cover_uq" ON "seller_listing_revision_images" USING btree ("revision_id","variant_id") WHERE "seller_listing_revision_images"."variant_id" IS NOT NULL AND "seller_listing_revision_images"."is_cover" = true;--> statement-breakpoint
CREATE INDEX "seller_listing_revision_images_image_idx" ON "seller_listing_revision_images" USING btree ("image_id");--> statement-breakpoint
