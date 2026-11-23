import { requireUser } from "../../auth/requireUser.js";
import type { AppContext } from "../../graphql/context.js";
import { getCallHistory, getIceServers } from "./service.js";

export const callResolvers = {
  Query: {
    callHistory: (
      _parent: unknown,
      args: { first?: number | null; after?: string | null },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return getCallHistory(user.id, args.first ?? null, args.after ?? null);
    },
    iceServers: (
      _parent: unknown,
      _args: unknown,
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return getIceServers(user.id);
    },
  },
  CallLog: {
    caller: (log: { caller: unknown }) => log.caller,
    callee: (log: { callee: unknown }) => log.callee,
    startedAt: (log: { startedAt: Date }) => log.startedAt.toISOString(),
  },
};
