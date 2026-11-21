import { badUserInput } from "../graphql/errors.js";

export function encodeCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw badUserInput("Invalid cursor.");
  }

  const id = Buffer.from(cursor, "base64url").toString("utf8");
  if (!id || encodeCursor(id) !== cursor) {
    throw badUserInput("Invalid cursor.");
  }
  return id;
}

export function clampFirst(first: number | null | undefined): number {
  return Math.min(Math.max(first ?? 20, 1), 50);
}
