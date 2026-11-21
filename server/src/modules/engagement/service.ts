import { Prisma } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { badUserInput, forbidden, notFound } from "../../graphql/errors.js";
import { canViewOwnerContent } from "../../lib/visibility.js";
import { clampFirst, decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { NotificationType } from "@prisma/client";
import { extractMentions } from "../../lib/hashtags.js";
import { notifyUser, removeNotifications } from "../notifications/service.js";

async function requireViewablePost(viewerId: string, postId: string) {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    include: { media: { orderBy: { position: "asc" } } },
  });
  if (!post) throw notFound("Post not found.");
  if (!(await canViewOwnerContent(viewerId, post.authorId))) {
    throw notFound("Post not found.");
  }
  return post;
}

export async function likePost(viewerId: string, postId: string) {
  const post = await requireViewablePost(viewerId, postId);
  let created = false;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.like.create({ data: { userId: viewerId, postId } });
      await tx.post.update({
        where: { id: postId },
        data: { likesCount: { increment: 1 } },
      });
    });
    created = true;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      // Repeating a like is intentionally idempotent.
    } else {
      throw error;
    }
  }
  if (created) {
    await notifyUser({
      type: NotificationType.LIKE,
      recipientId: post.authorId,
      actorId: viewerId,
      postId,
    });
  }
  return requireViewablePost(viewerId, postId);
}

export async function unlikePost(viewerId: string, postId: string) {
  const post = await requireViewablePost(viewerId, postId);
  await prisma.$transaction(async (tx) => {
    const deleted = await tx.like.deleteMany({
      where: { userId: viewerId, postId },
    });
    if (deleted.count > 0) {
      await tx.post.update({
        where: { id: postId },
        data: { likesCount: { decrement: 1 } },
      });
    }
  });
  await removeNotifications(
    post.authorId,
    viewerId,
    NotificationType.LIKE,
    postId
  );
  return requireViewablePost(viewerId, postId);
}

export async function savePost(viewerId: string, postId: string) {
  await requireViewablePost(viewerId, postId);
  try {
    await prisma.savedPost.create({ data: { userId: viewerId, postId } });
  } catch (error) {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002")
    ) {
      throw error;
    }
  }
  return requireViewablePost(viewerId, postId);
}

export async function unsavePost(viewerId: string, postId: string) {
  await requireViewablePost(viewerId, postId);
  await prisma.savedPost.deleteMany({ where: { userId: viewerId, postId } });
  return requireViewablePost(viewerId, postId);
}

export async function addComment(
  viewerId: string,
  postId: string,
  body: string,
  parentId?: string | null
) {
  const post = await requireViewablePost(viewerId, postId);
  const trimmed = body.trim();
  if (trimmed.length < 1 || trimmed.length > 500) {
    throw badUserInput("Comment body must be between 1 and 500 characters.");
  }
  let parentAuthorId: string | null = null;
  if (parentId) {
    const parent = await prisma.comment.findUnique({
      where: { id: parentId },
      select: { id: true, postId: true, parentId: true, authorId: true },
    });
    if (!parent || parent.postId !== postId || parent.parentId !== null) {
      throw badUserInput("Replies must reference a top-level comment on this post.");
    }
    parentAuthorId = parent.authorId;
  }

  const comment = await prisma.$transaction(async (tx) => {
    if (parentId) {
      const parent = await tx.comment.findUnique({
        where: { id: parentId },
        select: { id: true, postId: true, parentId: true },
      });
      if (!parent || parent.postId !== postId || parent.parentId !== null) {
        throw badUserInput("Replies must reference a top-level comment on this post.");
      }
    }
    const comment = await tx.comment.create({
      data: {
        postId,
        authorId: viewerId,
        parentId: parentId ?? null,
        body: trimmed,
      },
    });
    await tx.post.update({
      where: { id: postId },
      data: { commentsCount: { increment: 1 } },
    });
    if (parentId) {
      await tx.comment.update({
        where: { id: parentId },
        data: { repliesCount: { increment: 1 } },
      });
    }
    return comment;
  });

  const notified = new Set<string>();
  if (post.authorId !== viewerId) {
    await notifyUser({
      type: NotificationType.COMMENT,
      recipientId: post.authorId,
      actorId: viewerId,
      postId,
      commentId: comment.id,
    });
    notified.add(post.authorId);
  }
  if (parentId && parentAuthorId) {
    await notifyUser({
      type: NotificationType.REPLY,
      recipientId: parentAuthorId,
      actorId: viewerId,
      postId,
      commentId: comment.id,
    });
    notified.add(parentAuthorId);
  }

  for (const username of extractMentions(trimmed)) {
    const mentioned = await prisma.profile.findUnique({
      where: { username },
      select: { id: true },
    });
    if (!mentioned || mentioned.id === viewerId || notified.has(mentioned.id)) continue;
    await notifyUser({
      type: NotificationType.MENTION,
      recipientId: mentioned.id,
      actorId: viewerId,
      postId,
      commentId: comment.id,
    });
  }
  return comment;
}

export async function deleteComment(viewerId: string, commentId: string) {
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    include: { post: true },
  });
  if (!comment) throw notFound("Comment not found.");
  if (comment.authorId !== viewerId && comment.post.authorId !== viewerId) {
    throw forbidden("Only the comment author or post owner can delete this comment.");
  }

  await prisma.$transaction(async (tx) => {
    if (comment.parentId === null) {
      const replies = await tx.comment.count({
        where: { parentId: commentId },
      });
      await tx.comment.delete({ where: { id: commentId } });
      await tx.post.update({
        where: { id: comment.postId },
        data: { commentsCount: { decrement: 1 + replies } },
      });
    } else {
      await tx.comment.delete({ where: { id: commentId } });
      await tx.post.update({
        where: { id: comment.postId },
        data: { commentsCount: { decrement: 1 } },
      });
      await tx.comment.update({
        where: { id: comment.parentId },
        data: { repliesCount: { decrement: 1 } },
      });
    }
  });
  return true;
}

export async function getComments(
  viewerId: string,
  postId: string,
  first: number | null,
  after: string | null
) {
  await requireViewablePost(viewerId, postId);
  return commentPage(postId, null, first, after);
}

export async function getReplies(
  viewerId: string,
  commentId: string,
  first: number | null,
  after: string | null
) {
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { id: true, postId: true, parentId: true },
  });
  if (!comment) throw notFound("Comment not found.");
  await requireViewablePost(viewerId, comment.postId);
  if (comment.parentId !== null) throw badUserInput("Replies can only be listed for a top-level comment.");
  return commentPage(comment.postId, commentId, first, after);
}

async function commentPage(
  postId: string,
  parentId: string | null,
  first: number | null,
  after: string | null
) {
  const take = clampFirst(first);
  const args: Prisma.CommentFindManyArgs = {
    where: { postId, parentId },
    take: take + 1,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  };
  if (after) {
    args.cursor = { id: decodeCursor(after) };
    args.skip = 1;
  }
  const rows = await prisma.comment.findMany(args);
  const hasNext = rows.length > take;
  const items = hasNext ? rows.slice(0, take) : rows;
  return {
    items,
    nextCursor: hasNext ? encodeCursor(items[items.length - 1].id) : null,
  };
}

export async function getLikers(
  viewerId: string,
  postId: string,
  first: number | null,
  after: string | null
) {
  await requireViewablePost(viewerId, postId);
  const take = clampFirst(first);
  const args: Prisma.ProfileFindManyArgs = {
    where: { likes: { some: { postId } } },
    take: take + 1,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  };
  if (after) {
    args.cursor = { id: decodeCursor(after) };
    args.skip = 1;
  }
  const rows = await prisma.profile.findMany(args);
  const hasNext = rows.length > take;
  const items = hasNext ? rows.slice(0, take) : rows;
  return {
    items,
    nextCursor: hasNext ? encodeCursor(items[items.length - 1].id) : null,
  };
}

export async function getSavedPosts(
  viewerId: string,
  first: number | null,
  after: string | null
) {
  const take = clampFirst(first);
  const args: Prisma.PostFindManyArgs = {
    where: { savedBy: { some: { userId: viewerId } } },
    take: take + 1,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { media: { orderBy: { position: "asc" } } },
  };
  if (after) {
    args.cursor = { id: decodeCursor(after) };
    args.skip = 1;
  }
  const rows = await prisma.post.findMany(args);
  const hasNext = rows.length > take;
  const items = hasNext ? rows.slice(0, take) : rows;
  return {
    items,
    nextCursor: hasNext ? encodeCursor(items[items.length - 1].id) : null,
  };
}
