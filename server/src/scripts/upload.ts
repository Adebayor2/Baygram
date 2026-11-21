import { readFile } from "node:fs/promises";
import { openAsBlob } from "node:fs";
import { login } from "./smoke/helpers.js";
import type { UploadSignature } from "../modules/media/service.js";
import type { MediaKind } from "../modules/media/service.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function uploadToCloudinary(
  signature: UploadSignature,
  filePath: string
): Promise<{ publicId: string }> {
  await readFile(filePath);
  const form = new FormData();
  form.append("file", await openAsBlob(filePath));
  form.append("api_key", signature.apiKey);
  form.append("timestamp", String(signature.timestamp));
  form.append("folder", signature.folder);
  form.append("signature", signature.signature);

  const response = await fetch(signature.uploadUrl, {
    method: "POST",
    body: form,
  });
  const payload: unknown = await response.json();
  if (!response.ok || !isRecord(payload) || typeof payload.public_id !== "string") {
    throw new Error(
      `Cloudinary upload failed: ${response.status} ${JSON.stringify(payload)}`
    );
  }
  return { publicId: payload.public_id };
}

async function main(): Promise<void> {
  const [userName, kindValue, filePath] = process.argv.slice(2);
  if (!userName || !kindValue || !filePath) {
    throw new Error("Usage: npm run upload -- <userName> <kind> <filePath>");
  }
  const kind = kindValue as MediaKind;
  const token = await login(userName);
  const response = await fetch(
    process.env.SERVER_URL ?? "http://localhost:4000/graphql",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query:
          "mutation CreateUploadSignature($kind: MediaKind!) { createUploadSignature(kind: $kind) { cloudName apiKey timestamp folder signature resourceType uploadUrl } }",
        variables: { kind },
      }),
    }
  );
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !isRecord(payload.data)) {
    throw new Error("Could not create an upload signature.");
  }
  const signatureValue = payload.data.createUploadSignature;
  if (!isRecord(signatureValue)) {
    throw new Error("Could not create an upload signature.");
  }
  const signature: UploadSignature = {
    cloudName: String(signatureValue.cloudName),
    apiKey: String(signatureValue.apiKey),
    timestamp: Number(signatureValue.timestamp),
    folder: String(signatureValue.folder),
    signature: String(signatureValue.signature),
    resourceType: String(signatureValue.resourceType),
    uploadUrl: String(signatureValue.uploadUrl),
  };
  const uploaded = await uploadToCloudinary(signature, filePath);
  console.log(uploaded.publicId);
}

const entry = process.argv[1]?.replaceAll("\\", "/");
if (entry?.endsWith("/src/scripts/upload.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
