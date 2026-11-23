import { prisma } from "../../config/db.js";
import { forbidden, notFound, badUserInput } from "../../graphql/errors.js";
import { clampFirst, decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { canViewOwnerContent } from "../../lib/visibility.js";
import { describeOwnedMedia } from "../media/service.js";
import { deleteMedia } from "../media/service.js";

type StoryMedia = { publicId: string; type: "IMAGE" | "VIDEO" };

async function activeStory(storyId: string) {
  return prisma.story.findFirst({
    where: { id: storyId, expiresAt: { gt: new Date() } },
  });
}

export async function createStory(
  viewerId: string,
  media: StoryMedia,
  caption?: string | null
) {
  const expectedKind =
    media.type === "VIDEO" ? "STORY_VIDEO" : "STORY_IMAGE";
  const owned = await describeOwnedMedia(
    viewerId,
    media,
    [expectedKind]
  );
  const createdAt = new Date();
  return prisma.story.create({
    data: {
      authorId: viewerId,
      mediaPublicId: owned.publicId,
      mediaUrl: owned.url,
      mediaType: owned.type,
      width: owned.width,
      height: owned.height,
      durationSec: owned.durationSec,
      caption: caption?.trim() ? caption.trim() : null,
      expiresAt: new Date(createdAt.getTime() + 24 * 60 * 60 * 1000),
    },
  });
}

export async function deleteStory(viewerId: string, storyId: string) {
  const story = await prisma.story.findUnique({ where: { id: storyId } });
  if (!story) throw notFound("Story not found.");
  if (story.authorId !== viewerId) throw forbidden("Only the author can delete this story.");
  await prisma.story.delete({ where: { id: storyId } });
  await deleteMedia(story.mediaPublicId, story.mediaType);
  return true;
}

export async function getStoriesTray(viewerId: string) {
  const now = new Date();
  const followings = await prisma.follow.findMany({
    where: { followerId: viewerId, status: "ACCEPTED" },
    select: { followingId: true },
  });
  const authorIds = [
    viewerId,
    ...followings.map((follow) => follow.followingId),
  ];
  const blocked = await prisma.block.findMany({
    where: {
      OR: [
        { blockerId: viewerId },
        { blockedId: viewerId },
      ],
    },
    select: { blockerId: true, blockedId: true },
  });
  const blockedIds = new Set(
    blocked.map((block) =>
      block.blockerId === viewerId ? block.blockedId : block.blockerId
    )
  );
  const eligibleIds = authorIds.filter((id) => !blockedIds.has(id));

  const stories = await prisma.story.findMany({
    where: {
      authorId: { in: eligibleIds },
      expiresAt: { gt: now },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

  const viewRows = await prisma.storyView.findMany({
    where: {
      viewerId,
      storyId: { in: stories.map((story) => story.id) },
    },
    select: { storyId: true },
  });
  const viewedIds = new Set(viewRows.map((view) => view.storyId));

  const groups = new Map<
    string,
    {
      authorId: string;
      stories: Array<(typeof stories)[number] & { viewedByViewer: boolean }>;
      hasUnseen: boolean;
      latestAt: string;
    }
  >();
  for (const story of stories) {
    const existing = groups.get(story.authorId);
    if (existing) {
      existing.stories.push({ ...story, viewedByViewer: viewedIds.has(story.id) });
      existing.hasUnseen ||= !viewedIds.has(story.id);
      continue;
    }
    groups.set(story.authorId, {
      authorId: story.authorId,
      stories: [{ ...story, viewedByViewer: viewedIds.has(story.id) }],
      hasUnseen: !viewedIds.has(story.id),
      latestAt: story.createdAt.toISOString(),
    });
  }
  return [...groups.values()].sort((left, right) => {
    if (left.hasUnseen !== right.hasUnseen) return left.hasUnseen ? -1 : 1;
    return right.latestAt.localeCompare(left.latestAt);
  });
}

export async function getUserStories(viewerId: string, username: string) {
  const profile = await prisma.profile.findUnique({
    where: { username: username.trim().toLowerCase() },
  });
  if (!profile) throw notFound("Profile not found.");
  if (!(await canViewOwnerContent(viewerId, profile.id))) {
    throw forbidden("You cannot view this profile's stories.");
  }
  const stories = await prisma.story.findMany({
    where: { authorId: profile.id, expiresAt: { gt: new Date() } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const viewed = await prisma.storyView.findMany({
    where: { viewerId, storyId: { in: stories.map((story) => story.id) } },
    select: { storyId: true },
  });
  const viewedIds = new Set(viewed.map((view) => view.storyId));
  return stories.map((story) => ({
    ...story,
    viewedByViewer: viewedIds.has(story.id),
  }));
}

export async function viewStory(viewerId: string, storyId: string) {
  const story = await activeStory(storyId);
  if (!story) throw notFound("Story not found.");
  if (!(await canViewOwnerContent(viewerId, story.authorId))) {
    throw forbidden("You cannot view this story.");
  }
  if (story.authorId === viewerId) return true;
  const result = await prisma.storyView.upsert({
    where: {
      storyId_viewerId: { storyId, viewerId },
    },
    update: {},
    create: { storyId, viewerId },
  });
  await prisma.story.update({
    where: { id: storyId },
    data: {
      viewersCount: await prisma.storyView.count({ where: { storyId } }),
    },
  });
  return Boolean(result);
}

export async function getStoryViewers(
  viewerId: string,
  storyId: string,
  firstArg: number | null,
  after: string | null
) {
  const story = await prisma.story.findUnique({ where: { id: storyId } });
  if (!story) throw notFound("Story not found.");
  if (story.authorId !== viewerId) throw forbidden("Only the story author can view story viewers.");

  const take = clampFirst(firstArg);
  let cursorId: string | null = null;
  if (after) {
    try {
      cursorId = decodeCursor(after);
    } catch {
      throw badUserInput("Invalid cursor.");
    }
  }
  const rows = await prisma.storyView.findMany({
    where: { storyId },
    orderBy: [{ viewedAt: "desc" }, { viewerId: "desc" }],
    take: take + 1,
    ...(cursorId
      ? {
          cursor: {
            storyId_viewerId: { storyId, viewerId: cursorId },
          },
          skip: 1,
        }
      : {}),
  });
  const hasNext = rows.length > take;
  const items = hasNext ? rows.slice(0, take) : rows;
  const viewerIds = items.map((row) => row.viewerId);
  const profiles = await prisma.profile.findMany({
    where: { id: { in: viewerIds } },
  });
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  return {
    items: viewerIds.map((id) => byId.get(id)).filter((profile) => profile !== undefined),
    nextCursor: hasNext
      ? encodeCursor(items[items.length - 1].viewerId)
      : null,
  };
}

export async function cleanupExpiredStories(): Promise<number> {
  const expired = await prisma.story.findMany({
    where: { expiresAt: { lte: new Date() } },
  });
  for (const story of expired) {
    await prisma.story.delete({ where: { id: story.id } });
    await deleteMedia(story.mediaPublicId, story.mediaType);
  }
  return expired.length;
}
