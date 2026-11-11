ALTER TABLE "catalog_categories" ADD COLUMN "image_url" text;--> statement-breakpoint
ALTER TABLE "catalog_brands" ADD COLUMN "image_url" text;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD COLUMN "is_visible" boolean DEFAULT false NOT NULL;