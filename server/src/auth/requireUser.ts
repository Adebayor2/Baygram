import { GraphQLError } from "graphql";
import type { AppContext } from "../graphql/context.js";
import type { AuthUser } from "./getUser.js";

export function requireUser(ctx: AppContext): AuthUser {
  if (!ctx.user) {
    throw new GraphQLError("You must be logged in.", {
      extensions: { code: "UNAUTHENTICATED", http: { status: 401 } },
    });
  }
  return ctx.user;
}
