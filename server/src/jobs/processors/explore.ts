import { prisma } from "../../config/db.js";
import { redis } from "../../config/redis.js";

export async function refreshExplore(): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const posts = await prisma.post.findMany({
    where: {
      createdAt: { gte: cutoff },
      author: { isPrivate: false },
    },
    select: {
      id: true,
      likesCount: true,
      commentsCount: true,
      createdAt: true,
    },
  });
  const now = Date.now();
  const scored = posts
    .map((post) => {
      const hours = Math.max(
        (now - post.createdAt.getTime()) / (60 * 60 * 1000),
        0
      );
      const score =
        (post.likesCount + 3 * post.commentsCount) /
        Math.pow(hours + 2, 1.5);
      return { id: post.id, score };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, 500);

  const tmpKey = "explore:trending:tmp";
  await redis.del(tmpKey);
  if (scored.length > 0) {
    await redis.zadd(
      tmpKey,
      ...scored.flatMap((item) => [item.score, item.id])
    );
  }
  await redis.rename(tmpKey, "explore:trending");
  return scored.length;
}
