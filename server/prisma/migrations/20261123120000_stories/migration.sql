CREATE TABLE "stories" (
  "id" UUID NOT NULL,
  "author_id" UUID NOT NULL,
  "media_public_id" TEXT NOT NULL,
  "media_url" TEXT NOT NULL,
  "media_type" "MediaType" NOT NULL,
  "width" INTEGER,
  "height" INTEGER,
  "duration_sec" DOUBLE PRECISION,
  "caption" TEXT,
  "viewers_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "stories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "story_views" (
  "story_id" UUID NOT NULL,
  "viewer_id" UUID NOT NULL,
  "viewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "story_views_pkey" PRIMARY KEY ("story_id","viewer_id")
);

CREATE INDEX "stories_author_id_expires_at_idx" ON "stories"("author_id", "expires_at");
CREATE INDEX "stories_expires_at_idx" ON "stories"("expires_at");
CREATE INDEX "story_views_story_id_viewed_at_idx" ON "story_views"("story_id", "viewed_at");

ALTER TABLE "stories" ADD CONSTRAINT "stories_author_id_fkey"
FOREIGN KEY ("author_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "story_views" ADD CONSTRAINT "story_views_story_id_fkey"
FOREIGN KEY ("story_id") REFERENCES "stories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "story_views" ADD CONSTRAINT "story_views_viewer_id_fkey"
FOREIGN KEY ("viewer_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "stories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "story_views" ENABLE ROW LEVEL SECURITY;
