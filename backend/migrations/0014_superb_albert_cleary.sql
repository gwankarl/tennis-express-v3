CREATE TABLE "seller_listing_price_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_listing_variant_id" uuid NOT NULL,
	"previous_price_xaf" integer,
	"new_price_xaf" integer,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_listing_price_history_previous_price_ck" CHECK ("seller_listing_price_history"."previous_price_xaf" IS NULL OR "seller_listing_price_history"."previous_price_xaf" > 0),
	CONSTRAINT "seller_listing_price_history_new_price_ck" CHECK ("seller_listing_price_history"."new_price_xaf" IS NULL OR "seller_listing_price_history"."new_price_xaf" > 0),
	CONSTRAINT "seller_listing_price_history_changed_ck" CHECK ("seller_listing_price_history"."previous_price_xaf" IS DISTINCT FROM "seller_listing_price_history"."new_price_xaf")
);
--> statement-breakpoint
CREATE TABLE "seller_listing_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"catalog_variant_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"price_xaf" integer,
	"stock_quantity" integer DEFAULT 0 NOT NULL,
	"reserved_quantity" integer DEFAULT 0 NOT NULL,
	"is_offered_for_sale" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_listing_variants_sku_format_ck" CHECK ("seller_listing_variants"."sku" = upper(btrim("seller_listing_variants"."sku"))
        AND "seller_listing_variants"."sku" ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'),
	CONSTRAINT "seller_listing_variants_price_positive_ck" CHECK ("seller_listing_variants"."price_xaf" IS NULL OR "seller_listing_variants"."price_xaf" > 0),
	CONSTRAINT "seller_listing_variants_stock_nonnegative_ck" CHECK ("seller_listing_variants"."stock_quantity" >= 0),
	CONSTRAINT "seller_listing_variants_reserved_range_ck" CHECK ("seller_listing_variants"."reserved_quantity" >= 0
        AND "seller_listing_variants"."reserved_quantity" <= "seller_listing_variants"."stock_quantity"),
	CONSTRAINT "seller_listing_variants_offer_price_ck" CHECK ("seller_listing_variants"."is_offered_for_sale" = false
        OR "seller_listing_variants"."price_xaf" IS NOT NULL),
	CONSTRAINT "seller_listing_variants_version_positive_ck" CHECK ("seller_listing_variants"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "seller_listings_id_seller_id_uq" ON "seller_listings" USING btree ("id","seller_id");
ALTER TABLE "seller_listing_price_history" ADD CONSTRAINT "seller_listing_price_history_seller_listing_variant_id_seller_listing_variants_id_fk" FOREIGN KEY ("seller_listing_variant_id") REFERENCES "public"."seller_listing_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listing_variants" ADD CONSTRAINT "seller_listing_variants_catalog_variant_id_catalog_variants_id_fk" FOREIGN KEY ("catalog_variant_id") REFERENCES "public"."catalog_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listing_variants" ADD CONSTRAINT "seller_listing_variants_listing_seller_fk" FOREIGN KEY ("listing_id","seller_id") REFERENCES "public"."seller_listings"("id","seller_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "seller_listing_price_history_variant_changed_idx" ON "seller_listing_price_history" USING btree ("seller_listing_variant_id","changed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_listing_variants_listing_catalog_variant_uq" ON "seller_listing_variants" USING btree ("listing_id","catalog_variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_listing_variants_seller_sku_uq" ON "seller_listing_variants" USING btree ("seller_id","sku");--> statement-breakpoint
CREATE INDEX "seller_listing_variants_catalog_variant_idx" ON "seller_listing_variants" USING btree ("catalog_variant_id");--> statement-breakpoint
