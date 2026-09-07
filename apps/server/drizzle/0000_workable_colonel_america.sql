CREATE TABLE "host_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"host_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"acked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "host_enrollments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"host_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hosts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"os" text,
	"arch" text,
	"agent" text,
	"hostname" text,
	"harnesses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone,
	"command_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosts_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "host_commands" ADD CONSTRAINT "host_commands_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_enrollments" ADD CONSTRAINT "host_enrollments_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "host_commands_host_seq_key" ON "host_commands" USING btree ("host_id","seq");--> statement-breakpoint
CREATE INDEX "host_commands_replay_idx" ON "host_commands" USING btree ("host_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "host_enrollments_token_hash_key" ON "host_enrollments" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "hosts_token_hash_key" ON "hosts" USING btree ("token_hash");