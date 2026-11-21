import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import { cloudinary } from "../../config/cloudinary.js";
import { uploadToCloudinary } from "../upload.js";
import {
  assertEqual,
  ensureProfiles,
  expectError,
  expectOk,
  gql,
  poll,
  resetData,
  step,
} from "./helpers.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCloudinaryNotFound(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const nested = isRecord(error.error) ? error.error : null;
  return [error.http_code, error.statusCode, error.status, nested?.http_code]
    .some((status) => Number(status) === 404);
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

export async function run(): Promise<void> {
  await resetData();
  await ensureProfiles();

  const pngPath = join(tmpdir(), `baygram-avatar-${process.pid}.png`);
  await writeFile(
    pngPath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    )
  );

  let publicId = "";
  try {
    if (
      !(await step("upload signatures require authentication", async () => {
        const anonymous = await gql(
          null,
          "mutation { createUploadSignature(kind: AVATAR) { cloudName } }"
        );
        expectError(anonymous, "UNAUTHENTICATED");

        const signed = await gql(
          "alice",
          "mutation { createUploadSignature(kind: AVATAR) { cloudName apiKey timestamp folder signature resourceType uploadUrl } }"
        );
        expectOk(signed);
        const signature = field(signed, "createUploadSignature", "cloudName");
        assertEqual(typeof signature, "string", "Cloudinary cloud name");
      }))
    ) {
      return;
    }

    if (
      !(await step("upload a tiny PNG and set it as Alice's avatar", async () => {
        const signed = await gql(
          "alice",
          "mutation { createUploadSignature(kind: AVATAR) { cloudName apiKey timestamp folder signature resourceType uploadUrl } }"
        );
        expectOk(signed);
        const value = signed.data?.createUploadSignature;
        if (!isRecord(value)) throw new Error("Upload signature was not returned.");
        const signature = {
          cloudName: String(value.cloudName),
          apiKey: String(value.apiKey),
          timestamp: Number(value.timestamp),
          folder: String(value.folder),
          signature: String(value.signature),
          resourceType: String(value.resourceType),
          uploadUrl: String(value.uploadUrl),
        };
        const uploaded = await uploadToCloudinary(signature, pngPath);
        publicId = uploaded.publicId;

        const set = await gql(
          "alice",
          "mutation SetAvatar($publicId: String!) { setAvatar(publicId: $publicId) { username avatarUrl } }",
          { publicId }
        );
        expectOk(set);
        const avatarUrl = field(set, "setAvatar", "avatarUrl");
        if (typeof avatarUrl !== "string" || !avatarUrl.startsWith("https://res.cloudinary.com/")) {
          throw new Error("Avatar URL was not a valid Cloudinary secure URL.");
        }

        const profile = await gql(
          "bob",
          'query { profile(username: "alice") { avatarUrl } }'
        );
        expectOk(profile);
        if (!String(field(profile, "profile", "avatarUrl")).startsWith("https://res.cloudinary.com/")) {
          throw new Error("Profile did not show the invalidated avatar cache.");
        }
      }))
    ) {
      return;
    }

    if (
      !(await step("ownership and folder validation reject invalid avatars", async () => {
        const bobOwned = await gql(
          "bob",
          "mutation SetAvatar($publicId: String!) { setAvatar(publicId: $publicId) { id } }",
          { publicId }
        );
        expectError(bobOwned, "FORBIDDEN");

        const aliceMe = await gql("alice", "{ me { id } }");
        expectOk(aliceMe);
        const aliceId = field(aliceMe, "me", "id");
        if (typeof aliceId !== "string") throw new Error("Alice's id was not returned.");

        const differentFolder = await gql(
          "alice",
          "mutation SetAvatar($publicId: String!) { setAvatar(publicId: $publicId) { id } }",
          { publicId: `social/${aliceId}/post_image/test` }
        );
        expectError(differentFolder, "BAD_USER_INPUT");

        const madeUp = await gql(
          "alice",
          "mutation SetAvatar($publicId: String!) { setAvatar(publicId: $publicId) { id } }",
          { publicId: `social/${aliceId}/avatar/made-up-id` }
        );
        expectError(madeUp, "BAD_USER_INPUT");
      }))
    ) {
      return;
    }

    if (
      !(await step("removeAvatar clears the profile and deletes the asset", async () => {
        const removed = await gql(
          "alice",
          "mutation { removeAvatar { avatarUrl } }"
        );
        expectOk(removed);
        assertEqual(field(removed, "removeAvatar", "avatarUrl"), null, "avatarUrl");

        await poll(
          "old Cloudinary asset deletion",
          async () => {
            try {
              await cloudinary.api.resource(publicId, { resource_type: "image" });
              return false;
            } catch (error) {
              if (isCloudinaryNotFound(error)) return true;
              const message =
                error instanceof Error
                  ? error.message
                  : isRecord(error) && typeof error.message === "string"
                    ? error.message
                    : "unrecognized Cloudinary error";
              throw new Error(`Cloudinary resource lookup failed: ${message}`);
            }
          },
          30_000
        );
      }))
    ) {
      return;
    }
  } finally {
    await unlink(pngPath).catch(() => undefined);
  }
}
