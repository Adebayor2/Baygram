import { performance } from "node:perf_hooks";
import {
  assertEqual,
  ensureProfiles,
  expectError,
  expectOk,
  gql,
  redis,
  resetData,
  step,
} from "./helpers.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(
  response: Awaited<ReturnType<typeof gql>>,
  objectName: string,
  fieldName: string
): unknown {
  const object = response.data?.[objectName];
  if (!isRecord(object)) {
    throw new Error(`${objectName} was not returned.`);
  }
  return object[fieldName];
}

export async function run(): Promise<void> {
  await resetData();
  await ensureProfiles();

  if (
    !(await step("profile cache has a 60-second TTL", async () => {
      const key = "cache:profile:alice";
      const uncachedStart = performance.now();
      const uncached = await gql("alice", '{ profile(username: "alice") { username bio } }');
      const uncachedMs = performance.now() - uncachedStart;
      expectOk(uncached);
      assertEqual(field(uncached, "profile", "username"), "alice", "profile.username");

      const ttl = await redis.ttl(key);
      if (ttl < 1 || ttl > 60) {
        throw new Error(`Expected profile cache TTL between 1 and 60, received ${ttl}.`);
      }

      const cachedStart = performance.now();
      const cached = await gql("alice", '{ profile(username: "alice") { username bio } }');
      const cachedMs = performance.now() - cachedStart;
      expectOk(cached);
      console.log(
        `profile query timing: uncached ${uncachedMs.toFixed(1)}ms, cached ${cachedMs.toFixed(1)}ms`
      );
    }))
  ) {
    return;
  }

  if (
    !(await step("profile updates invalidate cached data", async () => {
      const update = await gql(
        "alice",
        "mutation UpdateProfile($input: UpdateProfileInput!) { updateProfile(input: $input) { bio } }",
        { input: { bio: "Updated bio" } }
      );
      expectOk(update);

      const profile = await gql(
        "alice",
        '{ profile(username: "alice") { bio } }'
      );
      expectOk(profile);
      assertEqual(field(profile, "profile", "bio"), "Updated bio", "profile.bio");
    }))
  ) {
    return;
  }

  if (
    !(await step("profile input validation rejects invalid values", async () => {
      const longBio = await gql(
        "alice",
        "mutation UpdateProfile($input: UpdateProfileInput!) { updateProfile(input: $input) { id } }",
        { input: { bio: "x".repeat(151) } }
      );
      expectError(longBio, "BAD_USER_INPUT");

      const reservedUsername = await gql(
        "alice",
        "mutation UpdateProfile($input: UpdateProfileInput!) { updateProfile(input: $input) { id } }",
        { input: { username: "admin" } }
      );
      expectError(reservedUsername, "BAD_USER_INPUT");

      const takenUsername = await gql(
        "alice",
        "mutation UpdateProfile($input: UpdateProfileInput!) { updateProfile(input: $input) { id } }",
        { input: { username: "bob" } }
      );
      expectError(takenUsername, "BAD_USER_INPUT");
    }))
  ) {
    return;
  }

  if (
    !(await step("renaming invalidates the old and new profile keys", async () => {
      await redis.del("cache:profile:alice", "cache:profile:alice2");
      const renamed = await gql(
        "alice",
        "mutation UpdateProfile($input: UpdateProfileInput!) { updateProfile(input: $input) { username } }",
        { input: { username: "alice2" } }
      );
      expectOk(renamed);
      assertEqual(field(renamed, "updateProfile", "username"), "alice2", "username");
      assertEqual(await redis.exists("cache:profile:alice"), 0, "old cache key");
      assertEqual(await redis.exists("cache:profile:alice2"), 0, "new cache key");

      const cachedRenamed = await gql(
        "alice",
        '{ profile(username: "alice2") { username } }'
      );
      expectOk(cachedRenamed);

      const restored = await gql(
        "alice",
        "mutation UpdateProfile($input: UpdateProfileInput!) { updateProfile(input: $input) { username } }",
        { input: { username: "alice" } }
      );
      expectOk(restored);
      assertEqual(field(restored, "updateProfile", "username"), "alice", "username");
      assertEqual(await redis.exists("cache:profile:alice2"), 0, "old cache key");
      assertEqual(await redis.exists("cache:profile:alice"), 0, "new cache key");
    }))
  ) {
    return;
  }

  await step("missing profiles return null and updates require login", async () => {
    const missing = await gql(
      "alice",
      '{ profile(username: "doesnotexist") { id } }'
    );
    expectOk(missing);
    assertEqual(missing.data?.profile, null, "missing profile");

    const anonymousUpdate = await gql(
      null,
      "mutation UpdateProfile($input: UpdateProfileInput!) { updateProfile(input: $input) { id } }",
      { input: { bio: "No token" } }
    );
    expectError(anonymousUpdate, "UNAUTHENTICATED");
  });
}
