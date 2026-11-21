import { requireUser } from "../../auth/requireUser.js";
import type { AppContext } from "../../graphql/context.js";
import { badUserInput } from "../../graphql/errors.js";
import {
  createUploadSignature,
  removeAvatar,
  setAvatar,
  type MediaKind,
} from "./service.js";

const mediaKinds = new Set<MediaKind>([
  "AVATAR",
  "POST_IMAGE",
  "POST_VIDEO",
  "STORY_IMAGE",
  "STORY_VIDEO",
  "MESSAGE_IMAGE",
]);

export const mediaResolvers = {
  Mutation: {
    createUploadSignature: (
      _parent: unknown,
      args: { kind: MediaKind },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      if (!mediaKinds.has(args.kind)) {
        throw badUserInput("Unknown media kind.");
      }
      return createUploadSignature(user.id, args.kind);
    },
    setAvatar: async (
      _parent: unknown,
      args: { publicId: string },
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      if (!args.publicId) throw badUserInput("publicId is required.");
      return setAvatar(user.id, args.publicId);
    },
    removeAvatar: async (
      _parent: unknown,
      _args: unknown,
      ctx: AppContext
    ) => {
      const user = requireUser(ctx);
      return removeAvatar(user.id);
    },
  },
};
