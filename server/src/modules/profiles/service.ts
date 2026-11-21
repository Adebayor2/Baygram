import { Prisma, type Profile } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { redis } from "../../config/redis.js";
import { cacheGetOrSet } from "../../lib/cache.js";
import { redisKeys } from "../../lib/redisKeys.js";
import { badUserInput, notFound } from "../../graphql/errors.js";
import type {
  CreateProfileInput,
  UpdateProfileInput,
} from "../../lib/validators.js";

const PROFILE_CACHE_TTL_SECONDS = 60;
type CachedProfile = Omit<
  Profile,
  "followersCount" | "followingCount" | "postsCount"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseCachedProfile(value: unknown): CachedProfile | null {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new Error("Invalid profile value in cache.");
  }

  const {
    id,
    username,
    fullName,
    bio,
    avatarUrl,
    avatarPublicId,
    isPrivate,
    createdAt,
    updatedAt,
  } = value;
  if (
    typeof id !== "string" ||
    typeof username !== "string" ||
    !isNullableString(fullName) ||
    !isNullableString(bio) ||
    !isNullableString(avatarUrl) ||
    !(avatarPublicId === undefined || isNullableString(avatarPublicId)) ||
    typeof isPrivate !== "boolean" ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string"
  ) {
    throw new Error("Invalid profile value in cache.");
  }

  const createdAtDate = new Date(createdAt);
  const updatedAtDate = new Date(updatedAt);
  if (
    Number.isNaN(createdAtDate.getTime()) ||
    Number.isNaN(updatedAtDate.getTime())
  ) {
    throw new Error("Invalid profile dates in cache.");
  }

  return {
    id,
    username,
    fullName,
    bio,
    avatarUrl,
    avatarPublicId: avatarPublicId ?? null,
    isPrivate,
    createdAt: createdAtDate,
    updatedAt: updatedAtDate,
  };
}

export async function getProfileByUsername(
  username: string
): Promise<CachedProfile | null> {
  const normalizedUsername = username.trim().toLowerCase();
  return cacheGetOrSet(
    redisKeys.profileCache(normalizedUsername),
    PROFILE_CACHE_TTL_SECONDS,
    () =>
      prisma.profile.findUnique({
        where: { username: normalizedUsername },
        select: {
          id: true,
          username: true,
          fullName: true,
          bio: true,
          avatarUrl: true,
          avatarPublicId: true,
          isPrivate: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    parseCachedProfile
  );
}

export async function createProfile(
  userId: string,
  input: CreateProfileInput
): Promise<Profile> {
  const existing = await prisma.profile.findUnique({ where: { id: userId } });
  if (existing) throw badUserInput("You already have a profile.");

  try {
    const profile = await prisma.profile.create({
      data: {
        id: userId,
        username: input.username,
        fullName: input.fullName?.trim() || null,
      },
    });
    await redis.del(redisKeys.profileCache(profile.username));
    return profile;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const profile = await prisma.profile.findUnique({ where: { id: userId } });
      if (profile) throw badUserInput("You already have a profile.");
      throw badUserInput("That username is already taken.");
    }
    throw error;
  }
}

export async function updateProfile(
  userId: string,
  input: UpdateProfileInput
): Promise<Profile> {
  const current = await prisma.profile.findUnique({ where: { id: userId } });
  if (!current) throw notFound("Profile not found.");

  const data: Prisma.ProfileUpdateInput = {};
  if (input.username !== undefined) data.username = input.username;
  if (input.fullName !== undefined) data.fullName = input.fullName;
  if (input.bio !== undefined) data.bio = input.bio;
  if (input.isPrivate !== undefined) data.isPrivate = input.isPrivate;

  let updated: Profile;
  try {
    updated = await prisma.$transaction(async (tx) => {
      await tx.profile.update({ where: { id: userId }, data });

      if (current.isPrivate && input.isPrivate === false) {
        const pending = await tx.follow.findMany({
          where: { followingId: userId, status: "PENDING" },
          select: { followerId: true },
        });
        const acceptedIds: string[] = [];
        for (const request of pending) {
          const result = await tx.follow.updateMany({
            where: {
              followerId: request.followerId,
              followingId: userId,
              status: "PENDING",
            },
            data: { status: "ACCEPTED" },
          });
          if (result.count === 1) acceptedIds.push(request.followerId);
        }

        if (acceptedIds.length > 0) {
          await tx.profile.update({
            where: { id: userId },
            data: { followersCount: { increment: acceptedIds.length } },
          });
          await tx.profile.updateMany({
            where: { id: { in: acceptedIds } },
            data: { followingCount: { increment: 1 } },
          });
        }
      }

      return tx.profile.findUniqueOrThrow({ where: { id: userId } });
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw badUserInput("That username is already taken.");
    }
    throw error;
  }

  const keys = new Set([
    redisKeys.profileCache(current.username),
    redisKeys.profileCache(updated.username),
  ]);
  await redis.del(...keys);
  return updated;
}
