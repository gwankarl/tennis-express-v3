CREATE TYPE "public"."catalog_attribute_rule_set_key" AS ENUM('tennis_racquets', 'tennis_balls', 'racquet_strings', 'grips_overgrips', 'tennis_shoes', 'tennis_bags', 'racquet_accessories');--> statement-breakpoint
CREATE TABLE "catalog_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"attribute_rule_set_key" "catalog_attribute_rule_set_key" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_categories_slug_format_ck" CHECK ("catalog_categories"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "catalog_categories_name_not_blank_ck" CHECK (btrim("catalog_categories"."name") <> '')
);
--> statement-breakpoint
CREATE TABLE "catalog_brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_brands_slug_format_ck" CHECK ("catalog_brands"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "catalog_brands_name_not_blank_ck" CHECK (btrim("catalog_brands"."name") <> '')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_categories_slug_uq" ON "catalog_categories" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_brands_slug_uq" ON "catalog_brands" USING btree ("slug");