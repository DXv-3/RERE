CREATE TABLE "relay_account_emails" (
	"user_id" varchar(191) PRIMARY KEY,
	"email" varchar(320) NOT NULL,
	"first_name" varchar(60),
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_relay_account_emails_email" ON "relay_account_emails" ("email");