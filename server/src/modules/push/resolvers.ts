import { requireUser } from "../../auth/requireUser.js";
import type { AppContext } from "../../graphql/context.js";
import { badUserInput } from "../../graphql/errors.js";
import {
  getVapidPublicKey,
  registerPushSubscription,
  unregisterPushSubscription,
} from "./service.js";

export const pushResolvers = {
  Query: {
    vapidPublicKey: () => getVapidPublicKey(),
  },
  Mutation: {
    registerPushSubscription: (
      _parent: unknown,
      args: {
        input: {
          endpoint: string;
          p256dh: string;
          auth: string;
          userAgent?: string | null;
        };
      },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      if (!args.input) throw badUserInput("Push subscription input is required.");
      return registerPushSubscription(user.id, args.input);
    },
    unregisterPushSubscription: (
      _parent: unknown,
      args: { endpoint: string },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      if (!args.endpoint) throw badUserInput("Endpoint is required.");
      return unregisterPushSubscription(user.id, args.endpoint);
    },
  },
};
