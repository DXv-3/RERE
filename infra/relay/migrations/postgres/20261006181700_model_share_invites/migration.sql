CREATE TABLE "relay_model_share_invites" (
	"invite_id" varchar(64) PRIMARY KEY,
	"owner_user_id" varchar(191) NOT NULL,
	"environment_id" varchar(191) NOT NULL,
	"share_id" varchar(191) NOT NULL,
	"recipient_email" varchar(320) NOT NULL,
	"share_base_url" text NOT NULL,
	"models_json" jsonb NOT NULL,
	"label" text NOT NULL,
	"sealed_token" text NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"revoked_at" varchar(64),
	"accepted_at" varchar(64)
);
--> statement-breakpoint
CREATE INDEX "idx_relay_model_share_invites_recipient" ON "relay_model_share_invites" ("recipient_email","revoked_at");--> statement-breakpoint
CREATE INDEX "idx_relay_model_share_invites_owner" ON "relay_model_share_invites" ("owner_user_id","revoked_at");--> statement-breakpoint
CREATE INDEX "idx_relay_model_share_invites_environment" ON "relay_model_share_invites" ("environment_id","revoked_at");