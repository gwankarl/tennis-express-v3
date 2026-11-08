CREATE TYPE "public"."identity_permission" AS ENUM('administrator');--> statement-breakpoint
CREATE TABLE "identity_user_permissions" (
	"user_id" uuid NOT NULL,
	"permission" "identity_permission" NOT NULL,
	CONSTRAINT "identity_user_permissions_pk" PRIMARY KEY("user_id","permission")
);
--> statement-breakpoint
ALTER TABLE "identity_users" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "identity_user_permissions" ADD CONSTRAINT "identity_user_permissions_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."identity_users"("id") ON DELETE cascade ON UPDATE no action;