CREATE TYPE "MemberRole" AS ENUM ('OWNER', 'MEMBER');

CREATE TABLE "conversations" (
  "id" UUID NOT NULL,
  "is_group" BOOLEAN NOT NULL DEFAULT false,
  "title" TEXT,
  "direct_key" TEXT,
  "created_by_id" UUID NOT NULL,
  "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "conversations_direct_key_key" ON "conversations"("direct_key");
CREATE INDEX "conversations_last_message_at_idx" ON "conversations"("last_message_at" DESC);

CREATE TABLE "conversation_members" (
  "conversation_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "role" "MemberRole" NOT NULL DEFAULT 'MEMBER',
  "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_read_at" TIMESTAMP(3),
  CONSTRAINT "conversation_members_pkey" PRIMARY KEY ("conversation_id","user_id")
);
CREATE INDEX "conversation_members_user_id_idx" ON "conversation_members"("user_id");

CREATE TABLE "messages" (
  "id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "sender_id" UUID NOT NULL,
  "body" TEXT,
  "media_public_id" TEXT,
  "media_url" TEXT,
  "client_id" TEXT,
  "deleted_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "messages_conversation_id_sender_id_client_id_key"
ON "messages"("conversation_id","sender_id","client_id");
CREATE INDEX "messages_conversation_id_created_at_idx"
ON "messages"("conversation_id","created_at" DESC);

ALTER TABLE "conversations" ADD CONSTRAINT "conversations_created_by_id_fkey"
FOREIGN KEY ("created_by_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_fkey"
FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey"
FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_fkey"
FOREIGN KEY ("sender_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversation_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
