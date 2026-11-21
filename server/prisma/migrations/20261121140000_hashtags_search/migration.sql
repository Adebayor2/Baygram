CREATE TABLE "hashtags" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "posts_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "hashtags_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "hashtags_name_key" ON "hashtags"("name");

CREATE TABLE "post_hashtags" (
    "post_id" UUID NOT NULL,
    "hashtag_id" UUID NOT NULL,

    CONSTRAINT "post_hashtags_pkey" PRIMARY KEY ("post_id","hashtag_id")
);

CREATE TABLE "post_mentions" (
    "post_id" UUID NOT NULL,
    "mentioned_id" UUID NOT NULL,

    CONSTRAINT "post_mentions_pkey" PRIMARY KEY ("post_id","mentioned_id")
);

CREATE INDEX "post_hashtags_hashtag_id_idx" ON "post_hashtags"("hashtag_id");

ALTER TABLE "post_hashtags" ADD CONSTRAINT "post_hashtags_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "post_hashtags" ADD CONSTRAINT "post_hashtags_hashtag_id_fkey" FOREIGN KEY ("hashtag_id") REFERENCES "hashtags"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "post_mentions" ADD CONSTRAINT "post_mentions_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "post_mentions" ADD CONSTRAINT "post_mentions_mentioned_id_fkey" FOREIGN KEY ("mentioned_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "hashtags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "post_hashtags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "post_mentions" ENABLE ROW LEVEL SECURITY;
