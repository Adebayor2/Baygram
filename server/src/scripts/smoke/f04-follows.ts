import {
  assertEqual,
  ensureProfiles,
  expectError,
  expectOk,
  gql,
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
  if (!isRecord(object)) throw new Error(`${objectName} was not returned.`);
  return object[fieldName];
}

function page(
  response: Awaited<ReturnType<typeof gql>>,
  fieldName: string
): { usernames: string[]; nextCursor: string | null } {
  const result = field(response, fieldName, "items");
  if (!Array.isArray(result)) throw new Error(`${fieldName}.items was not returned.`);
  const usernames = result.map((item) => {
    if (!isRecord(item) || typeof item.username !== "string") {
      throw new Error(`${fieldName} contains an invalid profile.`);
    }
    return item.username;
  });
  const nextCursor = field(response, fieldName, "nextCursor");
  if (nextCursor !== null && typeof nextCursor !== "string") {
    throw new Error(`${fieldName}.nextCursor is invalid.`);
  }
  return { usernames, nextCursor };
}

async function setPrivacy(username: string, isPrivate: boolean): Promise<void> {
  const response = await gql(
    username,
    "mutation UpdateProfile($input: UpdateProfileInput!) { updateProfile(input: $input) { isPrivate } }",
    { input: { isPrivate } }
  );
  expectOk(response);
  assertEqual(
    field(response, "updateProfile", "isPrivate"),
    isPrivate,
    `${username}.isPrivate`
  );
}

export async function run(): Promise<void> {
  await resetData();
  await ensureProfiles();

  if (
    !(await step("test accounts have the intended privacy settings", async () => {
      await setPrivacy("alice", false);
      await setPrivacy("bob", false);
      await setPrivacy("carol", true);
    }))
  ) {
    return;
  }

  if (
    !(await step("public follows are accepted and idempotent", async () => {
      const cachedBefore = await gql(
        "alice",
        '{ profile(username: "bob") { username followersCount } }'
      );
      expectOk(cachedBefore);
      assertEqual(field(cachedBefore, "profile", "followersCount"), 0, "bob followers");

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const followed = await gql(
          "alice",
          'mutation { follow(username: "bob") { username viewerFollowStatus } }'
        );
        expectOk(followed);
        assertEqual(
          field(followed, "follow", "viewerFollowStatus"),
          "FOLLOWING",
          "follow status"
        );
      }

      const bob = await gql(
        "bob",
        "{ me { followersCount followingCount } }"
      );
      const alice = await gql(
        "alice",
        "{ me { followersCount followingCount } }"
      );
      expectOk(bob);
      expectOk(alice);
      assertEqual(field(bob, "me", "followersCount"), 1, "Bob followers");
      assertEqual(field(alice, "me", "followingCount"), 1, "Alice following");

      const followsViewer = await gql(
        "bob",
        '{ profile(username: "alice") { followsViewer } }'
      );
      expectOk(followsViewer);
      assertEqual(
        field(followsViewer, "profile", "followsViewer"),
        true,
        "followsViewer"
      );

      const selfStatus = await gql(
        "alice",
        "{ me { viewerFollowStatus } }"
      );
      expectOk(selfStatus);
      assertEqual(
        field(selfStatus, "me", "viewerFollowStatus"),
        "SELF",
        "self follow status"
      );

      const cachedAfter = await gql(
        "alice",
        '{ profile(username: "bob") { followersCount } }'
      );
      expectOk(cachedAfter);
      assertEqual(field(cachedAfter, "profile", "followersCount"), 1, "cached Bob followers");
    }))
  ) {
    return;
  }

  if (
    !(await step("private follows create visible pending requests", async () => {
      const requested = await gql(
        "alice",
        'mutation { follow(username: "carol") { username viewerFollowStatus followersCount } }'
      );
      expectOk(requested);
      assertEqual(
        field(requested, "follow", "viewerFollowStatus"),
        "REQUESTED",
        "private follow status"
      );
      assertEqual(field(requested, "follow", "followersCount"), 0, "Carol followers");

      const requests = await gql(
        "carol",
        "query { followRequests { items { username } nextCursor } }"
      );
      expectOk(requests);
      assertEqual(page(requests, "followRequests").usernames[0], "alice", "requester");
    }))
  ) {
    return;
  }

  if (
    !(await step("owners accept requests and private lists respect visibility", async () => {
      const accepted = await gql(
        "carol",
        'mutation { acceptFollowRequest(username: "alice") { username } }'
      );
      expectOk(accepted);

      const counts = await gql("carol", "{ me { followersCount } }");
      expectOk(counts);
      assertEqual(field(counts, "me", "followersCount"), 1, "Carol followers");

      const visible = await gql(
        "alice",
        'query { followers(username: "carol") { items { username } nextCursor } }'
      );
      expectOk(visible);
      assertEqual(page(visible, "followers").usernames[0], "alice", "Carol follower");

      const hidden = await gql(
        "bob",
        'query { followers(username: "carol") { items { username } } }'
      );
      expectError(hidden, "FORBIDDEN");
    }))
  ) {
    return;
  }

  if (
    !(await step("unfollow removes accepted counts and self-follow is rejected", async () => {
      const unfollowed = await gql(
        "alice",
        'mutation { unfollow(username: "bob") { username } }'
      );
      expectOk(unfollowed);

      const bob = await gql("bob", "{ me { followersCount } }");
      const alice = await gql("alice", "{ me { followingCount } }");
      expectOk(bob);
      expectOk(alice);
      assertEqual(field(bob, "me", "followersCount"), 0, "Bob followers");
      assertEqual(field(alice, "me", "followingCount"), 1, "Alice following");

      const selfFollow = await gql(
        "alice",
        'mutation { follow(username: "alice") { id } }'
      );
      expectError(selfFollow, "BAD_USER_INPUT");
    }))
  ) {
    return;
  }

  if (
    !(await step("blocking deletes follows and hides the blocker from the blocked user", async () => {
      const aliceFollowsBob = await gql(
        "alice",
        'mutation { follow(username: "bob") { id } }'
      );
      const bobFollowsAlice = await gql(
        "bob",
        'mutation { follow(username: "alice") { id } }'
      );
      expectOk(aliceFollowsBob);
      expectOk(bobFollowsAlice);

      const blocked = await gql(
        "bob",
        'mutation { block(username: "alice") { username followingCount } }'
      );
      expectOk(blocked);

      const hiddenProfile = await gql(
        "alice",
        '{ profile(username: "bob") { id } }'
      );
      expectOk(hiddenProfile);
      assertEqual(hiddenProfile.data?.profile, null, "blocked profile");

      const cannotFollow = await gql(
        "alice",
        'mutation { follow(username: "bob") { id } }'
      );
      expectError(cannotFollow, "NOT_FOUND");

      const aliceCounts = await gql(
        "alice",
        "{ me { followersCount followingCount } }"
      );
      const bobCounts = await gql(
        "bob",
        "{ me { followersCount followingCount } }"
      );
      expectOk(aliceCounts);
      expectOk(bobCounts);
      assertEqual(field(aliceCounts, "me", "followersCount"), 0, "Alice followers");
      assertEqual(field(aliceCounts, "me", "followingCount"), 1, "Alice following");
      assertEqual(field(bobCounts, "me", "followersCount"), 0, "Bob followers");
      assertEqual(field(bobCounts, "me", "followingCount"), 0, "Bob following");

      const forbiddenList = await gql(
        "alice",
        'query { followers(username: "bob") { items { username } } }'
      );
      expectError(forbiddenList, "FORBIDDEN");

      const unblocked = await gql(
        "bob",
        'mutation { unblock(username: "alice") { username } }'
      );
      expectOk(unblocked);
      const visibleAgain = await gql(
        "alice",
        '{ profile(username: "bob") { username viewerFollowStatus } }'
      );
      expectOk(visibleAgain);
      assertEqual(field(visibleAgain, "profile", "username"), "bob", "visible profile");
      assertEqual(
        field(visibleAgain, "profile", "viewerFollowStatus"),
        "NONE",
        "follow not restored"
      );
    }))
  ) {
    return;
  }

  if (
    !(await step("viewer blocks remain visible and private requests auto-accept", async () => {
      const blockedByViewer = await gql(
        "alice",
        'mutation { block(username: "bob") { username } }'
      );
      expectOk(blockedByViewer);
      const visibleBlock = await gql(
        "alice",
        '{ profile(username: "bob") { viewerIsBlocking } }'
      );
      expectOk(visibleBlock);
      assertEqual(
        field(visibleBlock, "profile", "viewerIsBlocking"),
        true,
        "viewerIsBlocking"
      );
      const unblocked = await gql(
        "alice",
        'mutation { unblock(username: "bob") { username } }'
      );
      expectOk(unblocked);

      const request = await gql(
        "bob",
        'mutation { follow(username: "carol") { viewerFollowStatus } }'
      );
      expectOk(request);
      assertEqual(field(request, "follow", "viewerFollowStatus"), "REQUESTED", "Bob request");

      await setPrivacy("carol", false);
      const counts = await gql("carol", "{ me { followersCount } }");
      const bob = await gql("bob", "{ me { followingCount } }");
      expectOk(counts);
      expectOk(bob);
      assertEqual(field(counts, "me", "followersCount"), 2, "Carol followers after accept");
      assertEqual(field(bob, "me", "followingCount"), 1, "Bob following after accept");
    }))
  ) {
    return;
  }

  await step("followers paginate without duplicates", async () => {
    const first = await gql(
      "alice",
      'query { followers(username: "carol", first: 1) { items { username } nextCursor } }'
    );
    expectOk(first);
    const firstPage = page(first, "followers");
    if (!firstPage.nextCursor) throw new Error("Expected a next cursor.");

    const second = await gql(
      "alice",
      "query Followers($after: String) { followers(username: \"carol\", first: 1, after: $after) { items { username } nextCursor } }",
      { after: firstPage.nextCursor }
    );
    expectOk(second);
    const secondPage = page(second, "followers");
    assertEqual(secondPage.usernames.length, 1, "second-page size");
    if (firstPage.usernames[0] === secondPage.usernames[0]) {
      throw new Error("Pagination returned a duplicate follower.");
    }
    assertEqual(secondPage.nextCursor, null, "last-page cursor");
  });
}
