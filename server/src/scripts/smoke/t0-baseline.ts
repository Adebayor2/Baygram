import {
  assertEqual,
  ensureProfiles,
  expectError,
  expectOk,
  gql,
  login,
  step,
} from "./helpers.js";

export async function run(): Promise<void> {
  if (
    !(await step("hello returns the baseline greeting", async () => {
      const response = await gql(null, "{ hello }");
      expectOk(response);
      assertEqual(
        response.data?.hello,
        "Hello from the social app API!",
        "hello"
      );
    }))
  ) {
    return;
  }

  if (
    !(await step("me rejects anonymous requests", async () => {
      const response = await gql(null, "{ me { id } }");
      expectError(response, "UNAUTHENTICATED");
    }))
  ) {
    return;
  }

  if (
    !(await step("Alice can sign in and query me", async () => {
      await login("alice");
      await ensureProfiles();
      const response = await gql("alice", "{ me { id username } }");
      expectOk(response);
      if (!response.data?.me) throw new Error("me did not return Alice's profile.");
      const profile = response.data.me;
      if (typeof profile !== "object" || profile === null || !("username" in profile)) {
        throw new Error("me returned an invalid profile.");
      }
      assertEqual(profile.username, "alice", "me.username");
    }))
  ) {
    return;
  }

  await step("ensureProfiles creates all profiles idempotently", async () => {
    await ensureProfiles();
    await ensureProfiles();
    for (const name of ["alice", "bob", "carol"]) {
      const response = await gql(name, "{ me { username } }");
      expectOk(response);
      if (!response.data?.me) throw new Error(`${name}'s profile was not created.`);
    }
  });
}
