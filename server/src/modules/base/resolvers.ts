import type { AppContext } from "../../graphql/context.js";
import { redisKeys } from "../../lib/redisKeys.js";

export const baseResolvers = {
  Query: {
    hello: () => "Hello from the social app API!",
    visits: (_parent: unknown, _args: unknown, { redis }: AppContext) =>
      redis.incr(redisKeys.statsVisits),
  },
};
