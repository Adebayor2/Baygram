CREATE TYPE "FollowStatus" AS ENUM ('PENDING', 'ACCEPTED');

ALTER TABLE "profiles"
ADD COLUMN "followers_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "following_count" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "follows" (
    "follower_id" UUID NOT NULL,
    "following_id" UUID NOT NULL,
    "status" "FollowStatus" NOT NULL DEFAULT 'ACCEPTED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follows_pkey" PRIMARY KEY ("follower_id", "following_id")
);

CREATE TABLE "blocks" (
    "blocker_id" UUID NOT NULL,
    "blocked_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocks_pkey" PRIMARY KEY ("blocker_id", "blocked_id")
);

CREATE INDEX "follows_following_id_status_created_at_idx"
ON "follows"("following_id", "status", "created_at");

CREATE INDEX "follows_follower_id_status_created_at_idx"
ON "follows"("follower_id", "status", "created_at");

CREATE INDEX "blocks_blocked_id_idx"
ON "blocks"("blocked_id");

ALTER TABLE "follows"
ADD CONSTRAINT "follows_follower_id_fkey"
FOREIGN KEY ("follower_id") REFERENCES "profiles"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "follows"
ADD CONSTRAINT "follows_following_id_fkey"
FOREIGN KEY ("following_id") REFERENCES "profiles"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "blocks"
ADD CONSTRAINT "blocks_blocker_id_fkey"
FOREIGN KEY ("blocker_id") REFERENCES "profiles"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "blocks"
ADD CONSTRAINT "blocks_blocked_id_fkey"
FOREIGN KEY ("blocked_id") REFERENCES "profiles"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "follows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "blocks" ENABLE ROW LEVEL SECURITY;
