import { z } from "zod";

const reservedUsernames = new Set([
  "admin",
  "support",
  "api",
  "explore",
  "settings",
  "login",
  "logout",
  "me",
  "help",
  "root",
  "www",
  "messages",
  "notifications",
  "stories",
  "reels",
]);

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9_]{3,20}$/,
    "Username must be 3-20 characters: lowercase letters, numbers and underscores only."
  )
  .refine((username) => !reservedUsernames.has(username), {
    message: "That username is reserved.",
  });

export const createProfileInputSchema = z
  .object({
    username: usernameSchema,
    fullName: z.string().trim().max(50, "Full name must be at most 50 characters.").nullable().optional(),
  })
  .strict();

export const updateProfileInputSchema = z
  .object({
    username: usernameSchema.optional(),
    fullName: z
      .string()
      .trim()
      .max(50, "Full name must be at most 50 characters.")
      .nullable()
      .optional(),
    bio: z.string().trim().max(150, "Bio must be at most 150 characters.").nullable().optional(),
    isPrivate: z.boolean().optional(),
  })
  .strict()
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: "At least one profile field must be provided.",
  });

export type CreateProfileInput = z.infer<typeof createProfileInputSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileInputSchema>;

export const createPostInputSchema = z
  .object({
    caption: z.string().trim().max(2200, "Caption must be at most 2200 characters.").nullable().optional(),
    media: z
      .array(
        z.object({
          publicId: z.string().min(1),
          type: z.enum(["IMAGE", "VIDEO"]),
        }).strict()
      )
      .min(1, "A post needs at least one media item.")
      .max(10, "A post can have at most 10 media items."),
  })
  .strict();
