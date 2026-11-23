ALTER TABLE "profiles"
ADD COLUMN "posts_count" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "posts" (
    "id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "caption" TEXT,
    "likes_count" INTEGER NOT NULL DEFAULT 0,
    "comments_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "post_media" (
    "id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "public_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "type" "MediaType" NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "duration_sec" DOUBLE PRECISION,
    "position" INTEGER NOT NULL,

    CONSTRAINT "post_media_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "posts_author_id_created_at_idx"
ON "posts"("author_id", "created_at" DESC);

CREATE INDEX "posts_created_at_idx"
ON "posts"("created_at" DESC);

CREATE INDEX "post_media_post_id_position_idx"
ON "post_media"("post_id", "position");

ALTER TABLE "posts"
ADD CONSTRAINT "posts_author_id_fkey"
FOREIGN KEY ("author_id") REFERENCES "profiles"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "post_media"
ADD CONSTRAINT "post_media_post_id_fkey"
FOREIGN KEY ("post_id") REFERENCES "posts"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "posts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "post_media" ENABLE ROW LEVEL SECURITY;
