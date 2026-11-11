CREATE TABLE "catalog_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"brand_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"fixed_attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"variant_option_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_products_name_not_blank_ck" CHECK (btrim("catalog_products"."name") <> ''),
	CONSTRAINT "catalog_products_fixed_attributes_object_ck" CHECK (jsonb_typeof("catalog_products"."fixed_attributes") = 'object'),
	CONSTRAINT "catalog_products_variant_option_keys_nonblank_ck" CHECK (array_position("catalog_products"."variant_option_keys", '') IS NULL)
);
--> statement-breakpoint
CREATE TABLE "catalog_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"option_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"option_signature" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_variants_option_values_object_ck" CHECK (jsonb_typeof("catalog_variants"."option_values") = 'object'),
	CONSTRAINT "catalog_variants_option_signature_not_blank_ck" CHECK (btrim("catalog_variants"."option_signature") <> ''),
	CONSTRAINT "catalog_variants_default_shape_ck" CHECK ("catalog_variants"."is_default" = false OR (
        "catalog_variants"."option_values" = '{}'::jsonb
        AND "catalog_variants"."option_signature" = '{}'
      ))
);
--> statement-breakpoint
ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_category_id_catalog_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."catalog_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_brand_id_catalog_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."catalog_brands"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_variants" ADD CONSTRAINT "catalog_variants_product_id_catalog_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."catalog_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_products_category_idx" ON "catalog_products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "catalog_products_brand_idx" ON "catalog_products" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "catalog_variants_product_idx" ON "catalog_variants" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_variants_product_option_signature_uq" ON "catalog_variants" USING btree ("product_id","option_signature");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_variants_one_default_per_product_uq" ON "catalog_variants" USING btree ("product_id") WHERE "catalog_variants"."is_default" = true;