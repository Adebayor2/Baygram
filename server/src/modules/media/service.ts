import { cloudinary } from "../../config/cloudinary.js";
import { env } from "../../config/env.js";
import { prisma } from "../../config/db.js";
import { redis } from "../../config/redis.js";
import { redisKeys } from "../../lib/redisKeys.js";
import { badUserInput, forbidden } from "../../graphql/errors.js";
import { mediaQueue } from "../../config/queues.js";

export type MediaKind =
  | "AVATAR"
  | "POST_IMAGE"
  | "POST_VIDEO"
  | "STORY_IMAGE"
  | "STORY_VIDEO"
  | "MESSAGE_IMAGE";

export type MediaType = "IMAGE" | "VIDEO";

export interface OwnedMedia {
  publicId: string;
  url: string;
  type: MediaType;
  width: number | null;
  height: number | null;
  durationSec: number | null;
}

export interface UploadSignature {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  folder: string;
  signature: string;
  resourceType: string;
  uploadUrl: string;
}

function kindFolder(kind: MediaKind): string {
  return kind.toLowerCase();
}

function resourceType(kind: MediaKind): "image" | "video" {
  return kind === "POST_VIDEO" || kind === "STORY_VIDEO" ? "video" : "image";
}

export function createUploadSignature(
  userId: string,
  kind: MediaKind
): UploadSignature {
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = `social/${userId}/${kindFolder(kind)}`;
  const signatureResourceType = resourceType(kind);
  const params = { folder, timestamp };
  const signature = cloudinary.utils.api_sign_request(
    params,
    env.cloudinaryApiSecret
  );
  return {
    cloudName: env.cloudinaryCloudName,
    apiKey: env.cloudinaryApiKey,
    timestamp,
    folder,
    signature,
    resourceType: signatureResourceType,
    uploadUrl: `https://api.cloudinary.com/v1_1/${env.cloudinaryCloudName}/${signatureResourceType}/upload`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function describeOwnedMedia(
  userId: string,
  mediaInput: { publicId: string; type: MediaType },
  allowedKinds: MediaKind[]
): Promise<OwnedMedia> {
  const allowedFolders = allowedKinds.map(kindFolder);
  const folderPrefix = allowedFolders
    .map((folder) => `social/${userId}/${folder}/`)
    .find((prefix) => mediaInput.publicId.startsWith(prefix));

  if (!folderPrefix) {
    throw forbidden("That media does not belong to this upload folder.");
  }

  const kind = allowedKinds.find((item) =>
    mediaInput.publicId.startsWith(
      `social/${userId}/${kindFolder(item)}/`
    )
  );
  if (!kind) {
    throw forbidden("That media does not belong to this upload folder.");
  }

  const expectedType: MediaType =
    resourceType(kind) === "video" ? "VIDEO" : "IMAGE";
  if (mediaInput.type !== expectedType) {
    throw badUserInput("The media type does not match this folder.");
  }

  let asset: unknown;
  try {
    asset = await cloudinary.api.resource(mediaInput.publicId, {
      resource_type: resourceType(kind),
    });
  } catch {
    throw badUserInput("The uploaded media could not be found.");
  }

  if (!isRecord(asset)) {
    throw badUserInput("The uploaded media could not be found.");
  }

  const bytes = typeof asset.bytes === "number" ? asset.bytes : 0;
  const duration =
    typeof asset.duration === "number" ? asset.duration : null;
  const width = typeof asset.width === "number" ? asset.width : null;
  const height = typeof asset.height === "number" ? asset.height : null;
  const url = typeof asset.secure_url === "string" ? asset.secure_url : null;
  if (!url) throw badUserInput("The uploaded media has no secure URL.");

  const exceedsImageLimit =
    expectedType === "IMAGE" && bytes > 10 * 1024 * 1024;
  const exceedsVideoLimit =
    expectedType === "VIDEO" &&
    (bytes > 100 * 1024 * 1024 ||
      (duration !== null &&
        duration > (kind === "STORY_VIDEO" ? 30 : 90)));

  if (exceedsImageLimit || exceedsVideoLimit) {
    await deleteMedia(mediaInput.publicId, expectedType);
    throw badUserInput("The uploaded media exceeds the size or duration limit.");
  }

  return {
    publicId: mediaInput.publicId,
    url,
    type: expectedType,
    width,
    height,
    durationSec: duration,
  };
}

export async function deleteMedia(
  publicId: string,
  type: MediaType
): Promise<void> {
  await mediaQueue.add(
    "media:destroy",
    { publicId, type },
    { attempts: 5, backoff: { type: "exponential", delay: 1000 } }
  );
}

export async function setAvatar(
  userId: string,
  publicId: string
): Promise<Awaited<ReturnType<typeof prisma.profile.update>>> {
  const ownFolderPrefix = `social/${userId}/`;
  if (publicId.startsWith(ownFolderPrefix) && !publicId.startsWith(`${ownFolderPrefix}avatar/`)) {
    throw badUserInput("Use an avatar upload for setAvatar.");
  }
  const media = await describeOwnedMedia(
    userId,
    { publicId, type: "IMAGE" },
    ["AVATAR"]
  );
  const current = await prisma.profile.findUnique({
    where: { id: userId },
  });
  if (!current) throw badUserInput("Create a profile before setting an avatar.");

  const updated = await prisma.profile.update({
    where: { id: userId },
    data: { avatarUrl: media.url, avatarPublicId: publicId },
  });
  await redis.del(
    redisKeys.profileCache(current.username),
    redisKeys.profileCache(updated.username)
  );
  if (current.avatarPublicId && current.avatarPublicId !== publicId) {
    await deleteMedia(current.avatarPublicId, "IMAGE");
  }
  return updated;
}

export async function removeAvatar(
  userId: string
): Promise<Awaited<ReturnType<typeof prisma.profile.update>>> {
  const current = await prisma.profile.findUnique({
    where: { id: userId },
  });
  if (!current) throw badUserInput("Create a profile before removing an avatar.");
  const updated = await prisma.profile.update({
    where: { id: userId },
    data: { avatarUrl: null, avatarPublicId: null },
  });
  await redis.del(
    redisKeys.profileCache(current.username),
    redisKeys.profileCache(updated.username)
  );
  if (current.avatarPublicId) {
    await deleteMedia(current.avatarPublicId, "IMAGE");
  }
  return updated;
}
