# PRD.md — Social App Backend (Instagram-style)

> Product Requirements Document written for an **AI coding agent** working inside VS Code.
> Build the backend **one feature at a time**. Every feature has requirements, exact steps, and a test. Do not start the next feature until the current one passes its test and the owner replies **"I'm done"**.

---

## 0. Rules for the AI agent (read first)

1. Read this whole document before writing any code.
2. Work on **exactly one feature** at a time, in the order of Section 5. Never skip ahead.
3. For every feature follow this loop:
   1. **Plan**: summarise what you will build in 10 lines or fewer.
   2. **Implement** the steps listed in the feature.
   3. Run `npm run typecheck` (must show no errors).
   4. Run the feature's smoke test: `npm run smoke -- fNN` (must pass).
   5. Run all earlier smoke tests (`npm run smoke -- all`) to catch regressions.
   6. Tick the feature in the **Progress Tracker** (Section 5).
   7. **Report** to the owner (see rule 5), then **stop and wait** for "I'm done".
4. If something fails, debug and fix it before moving on. If you are blocked by a missing account or credential, tell the owner exactly what to create and which `.env` variable to fill. Never fake a result or skip a test.
5. The owner is **learning**. After each feature, write a short report in plain beginner language: (a) what was built, (b) the key concept in simple words (for example "cache-aside"), (c) how to test it manually in Apollo Sandbox, with the exact operations, and (d) what result to expect.
6. Do not add features, libraries, or big refactors that are not in this PRD without asking. Prefer simple, readable code. Comment non-obvious parts.
7. Never commit secrets. Never log tokens or API keys. Never use the Supabase **secret** key anywhere (it is not needed).
8. Whenever you add an environment variable, add it to `server/.env.example` and to `server/src/config/env.ts` validation.
9. Existing code style: TypeScript strict, ES modules, `NodeNext` resolution, **relative imports end with `.js`**.

### Definition of Done (applies to every feature)

- [ ] `npm run typecheck` passes
- [ ] Feature smoke test passes, and all earlier smoke tests still pass
- [ ] Prisma migration created **with RLS statements appended** (see Section 3, "Migrations")
- [ ] New env vars added to `.env.example` and `env.ts`
- [ ] `resetData()` in the smoke helpers updated to clean the feature's new tables
- [ ] Progress Tracker ticked
- [ ] Plain-language report delivered to the owner

---

## 1. Product overview

An Instagram-style social app. This PRD covers the **backend only**: a scalable GraphQL API with real-time messaging, notifications, voice/video call signaling, background jobs, caching, and containerised deployment.

**In scope:** auth integration, profiles, follows/blocks, media uploads, posts, likes/comments/saves, feed/explore, hashtags/mentions/search, notifications, WebSockets, direct messages, stories, push notifications, WebRTC call signaling, background jobs, security hardening, tests, Docker, scaling lab.

**Out of scope (later, separate PRD):** Next.js PWA frontend and design, content moderation/reporting, payments, ads, recommendation ML, email sending.

### Owner's learning goals and where they are covered

| Goal | Features |
|---|---|
| How WebSockets work | F11, F12, F13, F18 |
| Redis caching and other Redis uses | F3, F8, F10, F11, F14, F19 |
| Cloudinary object storage | F5, F6, F14 |
| PWA push notifications (server side) | F17 |
| Docker containerisation | F21, F22 |
| How modern chat / social apps work, and scaling | F8, F12, F14, F21, F22 |

---

## 2. Tech stack (fixed decisions, do not change)

| Concern | Choice |
|---|---|
| Runtime / language | Node 20+, TypeScript (strict), ES modules, `NodeNext` |
| HTTP / API | Express **4**, Apollo Server **4** (`@apollo/server/express4`), `graphql` 16 |
| Database | Supabase Postgres via Prisma **6**, using the **session pooler** URL in `DATABASE_URL` |
| Auth | Supabase Auth (login happens on the client). The server only **verifies** the JWT with `supabase.auth.getClaims(token)`. Publishable key only |
| Cache / presence / queues | Redis 7 (Docker) via `ioredis` |
| Real time | Socket.IO + `@socket.io/redis-adapter` + `@socket.io/redis-emitter` |
| Background jobs | BullMQ |
| Media | Cloudinary, **signed direct uploads** from the client |
| Calls | WebRTC in the browser, signaling through Socket.IO, coturn for TURN |
| Push | `web-push` (VAPID) |
| Validation | `zod` |
| Logging | `pino`, `pino-http` |
| Security | `helmet`, Redis-based rate limiting, query depth limit |
| Tests | Smoke scripts (integration), Vitest (unit) |

Do **not** upgrade major versions of Express, Apollo Server, or Prisma during this project.

---

## 3. Architecture and conventions

### 3.1 System diagram

```
Next.js PWA (later)
   │ GraphQL (HTTP)            │ Socket.IO (WebSocket)        │ WebRTC media (peer to peer)
   ▼                           ▼                              ▼
              nginx load balancer (F22)                  STUN/TURN (coturn)
        ┌──────────┬──────────┬──────────┐
        ▼          ▼          ▼
     API 1      API 2      API 3     (stateless Node servers: Apollo + Socket.IO)
        │          │          │
        └────┬─────┴─────┬────┘
             ▼           ▼
        Supabase      Redis ◄──── Worker process(es) (BullMQ)
        Postgres     cache, presence, rate limits,
        + Auth       Socket.IO adapter, job queues

Client ──signed upload──► Cloudinary (images, videos)
```

### 3.2 Folder layout (target)

```
social-app/
├── PRD.md
├── docker-compose.yml
├── nginx/nginx.conf                 (F22)
├── docs/ARCHITECTURE.md             (F22)
└── server/
    ├── Dockerfile                   (F21)
    ├── .env  .env.example  test-users.json (gitignored: .env, test-users.json)
    ├── prisma/schema.prisma  prisma/migrations/
    ├── public/                      (dev-only test pages: push-test, call-test)
    └── src/
        ├── server.ts  worker.ts
        ├── config/    env, db, redis, supabase, cloudinary, logger, queues
        ├── auth/      getUser, requireUser, verifyToken
        ├── graphql/   schema, context, loaders, errors
        ├── modules/<feature>/   typeDefs.ts, resolvers.ts, service.ts
        ├── realtime/  io, emit, presence, chat, calls
        ├── jobs/      processors/*, schedule
        ├── lib/       cache, redisKeys, rateLimit, cursor, hashtags, validators, visibility
        └── scripts/   login, smoke/*
```

### 3.3 Conventions (apply everywhere)

- **Modules.** Each feature lives in `src/modules/<feature>/` with `typeDefs.ts` (uses `extend type Query/Mutation`), `resolvers.ts` (thin: auth, validation, call service), and `service.ts` (business logic, Prisma, Redis). The base schema defines `type Query { hello: String! visits: Int! }` and `type Mutation { _empty: Boolean }`. `graphql/schema.ts` exports `typeDefs` and `resolvers` **arrays** passed to `ApolloServer`.
- **Errors.** Use helpers in `graphql/errors.ts` that throw `GraphQLError` with `extensions.code`: `UNAUTHENTICATED` (http 401), `FORBIDDEN`, `NOT_FOUND`, `BAD_USER_INPUT`, `CONFLICT`, `RATE_LIMITED` (http 429). Never leak raw database errors.
- **Validation.** Every mutation input is validated with `zod` (trim strings, enforce limits listed in each feature).
- **Pagination.** Cursor-based only. Arguments `first: Int = 20` (clamp to max 50) and `after: String`. The cursor is the base64url of the last item's id. Return `{ items, nextCursor }`. Fetch `first + 1` rows to know if there is a next page. Prisma: `take`, `cursor: { id }`, `skip: 1`, `orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]`. Offset pagination is forbidden (except the explore ranking in F14).
- **Counters.** Counts such as `likesCount` are stored on the parent row and changed inside `prisma.$transaction`. Operations must be **idempotent** (liking twice must not count twice).
- **N+1.** Use `DataLoader` instances created per request in the GraphQL context (`ctx.loaders`) for author lookups and viewer-specific flags.
- **Visibility.** One pure function `decideVisibility({ viewerId, ownerId, ownerIsPrivate, isAcceptedFollower, blockedEitherWay })` in `lib/visibility.ts`, plus an async wrapper that loads the facts. Every read path for posts, stories, and lists must use it. Rules: owner always sees own content; blocked either way means no access; private owners are visible only to accepted followers; public owners are visible to any logged-in user.
- **Redis keys.** Defined in one place, `lib/redisKeys.ts`. Lowercase, colon-separated. **Always set a TTL** unless the key is a documented counter. Cache helper `cacheGetOrSet(key, ttlSeconds, loader)`. Invalidate on every write that changes cached data. Registry in Appendix A.
- **Security.** Every table created in `public` must have Row Level Security enabled (see Migrations). The server connects as the database owner role, so RLS does not affect it.
- **Dates.** GraphQL dates are ISO strings.
- **Code quality.** No `any`. Early returns. Small functions. Comments on anything non-obvious.

#### Migrations (procedure used by every feature)

```bash
npx prisma migrate dev --create-only --name <feature_name>
# open prisma/migrations/<timestamp>_<feature_name>/migration.sql and append, for each NEW table:
#   ALTER TABLE "<table_name>" ENABLE ROW LEVEL SECURITY;
npx prisma migrate dev
npx prisma generate
```

If `migrate dev` hangs or fails against Supabase, fall back to `npx prisma db push`, then tell the owner and run the RLS statements by hand in the Supabase SQL Editor.

---

## 4. Test tooling (build this first, call it T0)

**Why:** every feature needs a repeatable test the agent can run in the terminal, with no frontend.

### 4.1 Owner setup (ask the owner to do this once)

1. In Supabase, go to Authentication, then Users, then Add user, then Create new user. Tick **Auto Confirm User**. Create three users: `alice`, `bob`, `carol` (any emails and passwords).
2. Create `server/test-users.json` (add it to `.gitignore`):
   ```json
   {
     "alice": { "email": "alice@example.com", "password": "..." },
     "bob":   { "email": "bob@example.com",   "password": "..." },
     "carol": { "email": "carol@example.com", "password": "..." }
   }
   ```
3. The server must be running in another terminal (`npm run dev`) with Redis up (`docker compose up -d`).

### 4.2 Build `src/scripts/smoke/helpers.ts`

| Helper | Behaviour |
|---|---|
| `login(name)` | Signs in with `signInWithPassword` using `test-users.json`; caches the token per name; returns the access token |
| `gql(who, query, variables?)` | `who` is a test user name, a raw token, or `null` (anonymous). POSTs to `SERVER_URL` (default `http://localhost:4000/graphql`) and returns `{ data, errors }` |
| `expectOk(res)` | Fails if `res.errors` exists |
| `expectError(res, code)` | Fails unless the first error has `extensions.code === code` |
| `assertEqual(actual, expected, label)` | Fails with a readable message |
| `step(title, fn)` | Runs `fn`, prints a pass/fail line; any failure sets a non-zero process exit code |
| `ensureProfiles()` | Creates profiles `alice`, `bob`, `carol` (username = name) through `createProfile` if missing; idempotent |
| `resetData()` | Refuses to run when `NODE_ENV === 'production'`. Deletes feature data for the three test users in dependency order using Prisma, resets counters and `isPrivate` to defaults, and deletes Redis keys with the prefixes `cache:`, `notif:`, `chat:`, `presence:`, `rl:`. **Each later feature adds its tables here.** |
| `redis` | An `ioredis` client the tests use to assert on keys and TTLs |

### 4.3 Runner and scripts

Add to `package.json`:

```json
"smoke": "tsx --env-file=.env src/scripts/smoke/run.ts"
```

`npm run smoke -- t0` runs `smoke/t0-*.ts`. `npm run smoke -- f03` runs `smoke/f03-*.ts`. `npm run smoke -- all` runs every smoke file in order and stops at the first failure.

### 4.4 Smoke test `t0`

1. `hello` returns `"Hello from the social app API!"`.
2. `me` without a token returns `UNAUTHENTICATED`.
3. `login('alice')` returns a token; `me` with it works.
4. `ensureProfiles()` creates three profiles; running it twice causes no error.

**Done when:** `npm run smoke -- t0` passes twice in a row. Then create `server/.env.example`.

---

## 4.5 Baseline (already built, verify only, do not rebuild)

The owner already completed these. Verify, do not redo:

- Express + Apollo Server 4 + Prisma 6 + ioredis + Supabase client, TypeScript ESM, `tsx watch` dev script, `/health` route.
- Redis in `docker-compose.yml` (container `social_redis`).
- `getUserFromRequest` (JWT verification via `getClaims`), `requireUser`, `buildContext`.
- Prisma model `Profile` (id uuid = Supabase user id, username unique, fullName, bio, avatarUrl, isPrivate, createdAt, updatedAt) with RLS enabled.
- GraphQL: `hello`, `visits` (Redis `INCR stats:visits`), `me`, `createProfile(username, fullName)`.
- Script `npm run login -- <email> <password>` printing an access token.

If any item is missing or broken, tell the owner before continuing.

---

## 5. Progress Tracker (the agent ticks boxes)

- [x] T0 Test tooling
- [x] F3 Profiles + Redis cache-aside + module refactor
- [x] F4 Follows, follow requests, blocks
- [x] F5 Cloudinary media uploads + avatar
- [x] F6 Posts
- [x] F7 Likes, comments, replies, saves
- [x] F8 Home feed + Explore (v1)
- [x] F9 Hashtags, mentions, search
- [x] F10 Notifications (persistent)
- [x] F11 Socket.IO + Redis adapter + presence
- [x] F12 Direct messages and group chat
- [x] F13 Real-time notifications
- [x] F14 Background jobs (BullMQ) + Explore v2
- [x] F15 Stories
- [ ] F16 Reels (optional, ask the owner first)
- [x] F17 Web Push notifications
- [x] F18 Voice and video call signaling
- [ ] F19 Security and reliability hardening
- [ ] F20 Unit tests and CI
- [ ] F21 Docker containerisation
- [ ] F22 Scaling lab (load balancer, replicas) + architecture doc

---

# FEATURES

---

## F3 — Profiles, Redis cache-aside, module refactor

**Goal:** anyone can view a profile by username; users can edit their own. This is the **first Redis cache** (the cache-aside pattern).

### Step 0: refactor (behaviour must not change)
- Move existing `hello`, `visits`, `me`, `createProfile` into `modules/base` and `modules/profiles`.
- Create `graphql/schema.ts` (typeDefs and resolvers arrays), `graphql/errors.ts`, `lib/cache.ts`, `lib/redisKeys.ts`, `lib/cursor.ts`, `lib/validators.ts`, and `server/.env.example`.
- `npm run smoke -- t0` must still pass.

### API
```graphql
input UpdateProfileInput { username: String, fullName: String, bio: String, isPrivate: Boolean }
extend type Query    { profile(username: String!): Profile }
extend type Mutation { updateProfile(input: UpdateProfileInput!): Profile! }
```

### Rules
- `username`: `^[a-z0-9_]{3,20}$`, lowercased. Reject reserved names: `admin, support, api, explore, settings, login, logout, me, help, root, www, messages, notifications, stories, reels`.
- `fullName` max 50, `bio` max 150. `updateProfile` needs at least one field. Username must stay unique (return `BAD_USER_INPUT`, "That username is already taken.").
- `profile(username)` requires login (any logged-in user). Returns `null` if it does not exist (not an error).

### Redis (cache-aside)
- Key `cache:profile:{username}`, JSON, **TTL 60s**. Flow: read Redis, on miss read Postgres then `SET ... EX 60`.
- Cache only the base database row (never viewer-specific fields).
- Invalidate on `updateProfile` (old **and** new username) and `createProfile`.
- Log `cache hit` / `cache miss` at debug level.

### Smoke test `f03`
1. `profile("alice")` twice: after the first call the Redis key exists with TTL between 1 and 60.
2. alice updates `bio`; the next `profile("alice")` returns the new bio (proves invalidation).
3. bio of 151 characters returns `BAD_USER_INPUT`. Username `admin` returns `BAD_USER_INPUT`. Taking bob's username returns `BAD_USER_INPUT`.
4. alice renames to `alice2` then back; both old keys are gone.
5. `profile("doesnotexist")` returns `null`. `updateProfile` without a token returns `UNAUTHENTICATED`.
6. Print the timing of an uncached versus cached call (informational only).

**Done when:** all steps pass and the Definition of Done is met.

---

## F4 — Follows, follow requests, blocks

**Goal:** the social graph, including private accounts.

### Data model
```prisma
enum FollowStatus { PENDING ACCEPTED }

model Follow {
  followerId  String       @map("follower_id") @db.Uuid
  followingId String       @map("following_id") @db.Uuid
  status      FollowStatus @default(ACCEPTED)
  createdAt   DateTime     @default(now()) @map("created_at")
  follower    Profile      @relation("Following", fields: [followerId], references: [id], onDelete: Cascade)
  following   Profile      @relation("Followers", fields: [followingId], references: [id], onDelete: Cascade)
  @@id([followerId, followingId])
  @@index([followingId, status, createdAt])
  @@index([followerId, status, createdAt])
  @@map("follows")
}

model Block {
  blockerId String   @map("blocker_id") @db.Uuid
  blockedId String   @map("blocked_id") @db.Uuid
  createdAt DateTime @default(now()) @map("created_at")
  blocker   Profile  @relation("Blocking", fields: [blockerId], references: [id], onDelete: Cascade)
  blocked   Profile  @relation("BlockedBy", fields: [blockedId], references: [id], onDelete: Cascade)
  @@id([blockerId, blockedId])
  @@index([blockedId])
  @@map("blocks")
}
```
Add to `Profile`: `followersCount Int @default(0)`, `followingCount Int @default(0)` (mapped to snake_case) and the four relation fields.

### API
```graphql
enum ViewerFollowStatus { SELF NONE REQUESTED FOLLOWING }
extend type Profile {
  followersCount: Int!
  followingCount: Int!
  viewerFollowStatus: ViewerFollowStatus!
  followsViewer: Boolean!
  viewerIsBlocking: Boolean!
}
type ProfilePage { items: [Profile!]!, nextCursor: String }
extend type Query {
  followers(username: String!, first: Int = 20, after: String): ProfilePage!
  following(username: String!, first: Int = 20, after: String): ProfilePage!
  followRequests(first: Int = 20, after: String): ProfilePage!
}
extend type Mutation {
  follow(username: String!): Profile!
  unfollow(username: String!): Profile!
  acceptFollowRequest(username: String!): Profile!
  rejectFollowRequest(username: String!): Profile!
  block(username: String!): Profile!
  unblock(username: String!): Profile!
}
```

### Rules
- Cannot follow or block yourself (`BAD_USER_INPUT`).
- `follow`: target private gives `PENDING`, otherwise `ACCEPTED`. **Idempotent**: repeating changes nothing and never double-counts.
- Counters change only when a follow becomes `ACCEPTED` (and when an accepted follow is removed). Pending requests do not count. Use `$transaction`.
- `followers`/`following` lists: visible to the owner and accepted followers; otherwise `FORBIDDEN`. Public accounts are visible to any logged-in user.
- `block`: delete follows in both directions (fix counters), then create the block. `unblock` only removes the block (follows are not restored).
- If the **target blocked the viewer**, `profile(username)` returns `null` and `follow` returns `NOT_FOUND`. If the viewer blocked the target, the profile is still returned (so they can unblock) but `viewerIsBlocking` is `true`.
- `updateProfile` switching `isPrivate` from true to false must **auto-accept all pending requests** (transaction, fix counters).
- Create `lib/visibility.ts` now (pure `decideVisibility` plus async wrapper). Later features reuse it.
- Use DataLoaders for `viewerFollowStatus`, `followsViewer`, `viewerIsBlocking`.
- Clear the cached profile only if cached fields change (counts are not cached; keep counts out of `cache:profile:*` or invalidate them).

### Smoke test `f04`
Reset data first. alice and bob are public, carol is private.
1. alice follows bob: status `FOLLOWING`; bob `followersCount` 1; alice `followingCount` 1. Follow again: counts unchanged.
2. alice follows carol: status `REQUESTED`; carol `followersCount` still 0; carol's `followRequests` contains alice.
3. carol accepts: counts 1 and 1; alice sees carol's followers list; bob (non-follower) gets `FORBIDDEN` on carol's followers.
4. alice unfollows bob: counts 0. `follow("alice")` as alice returns `BAD_USER_INPUT`.
5. bob blocks alice: `profile("bob")` as alice is `null`; follows between them are gone; counts correct. alice's `follow("bob")` fails. bob unblocks: `profile("bob")` visible again, follow not restored.
6. bob requests carol (pending); carol switches to public: the request is auto-accepted and carol's `followersCount` increases.
7. Pagination: `followers` with `first: 1` returns `nextCursor`; following the cursor returns the rest with no duplicates.

---

## F5 — Cloudinary media uploads and avatar

**Goal:** users upload images and videos **directly to Cloudinary** using signed uploads. The server never carries the files; it only signs requests and later verifies what was uploaded.

### Owner setup
Create a free Cloudinary account and add to `.env`: `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`. Install the `cloudinary` package. Create `config/cloudinary.ts`.

### How the flow works
1. Client calls `createUploadSignature(kind)`.
2. Server signs `{ folder, timestamp }` with `cloudinary.utils.api_sign_request(params, apiSecret)`.
3. Client POSTs multipart form data to `uploadUrl` with fields `file`, `api_key`, `timestamp`, `folder`, `signature`.
4. Cloudinary returns `public_id`. The client sends that `publicId` to our API (for example `setAvatar`).
5. Server **verifies** the asset: it is inside the user's own folder, it exists (`cloudinary.api.resource`), and it meets the limits.

### API
```graphql
enum MediaKind { AVATAR POST_IMAGE POST_VIDEO STORY_IMAGE STORY_VIDEO MESSAGE_IMAGE }
enum MediaType { IMAGE VIDEO }
input MediaInput { publicId: String!, type: MediaType! }
type Media { publicId: String!, url: String!, type: MediaType!, width: Int, height: Int, durationSec: Float }
type UploadSignature {
  cloudName: String!  apiKey: String!  timestamp: Int!  folder: String!
  signature: String!  resourceType: String!  uploadUrl: String!
}
extend type Mutation {
  createUploadSignature(kind: MediaKind!): UploadSignature!
  setAvatar(publicId: String!): Profile!
  removeAvatar: Profile!
}
```

### Rules
- Folder: `social/{userId}/{kind in lowercase}`. Mapping from kind to `resource_type`: videos for `POST_VIDEO` and `STORY_VIDEO`, images for the rest.
- Create `modules/media/service.ts` with `describeOwnedMedia(userId, mediaInput, allowedKinds)`:
  - `publicId` must start with `social/{userId}/{allowed kind folder}/`, else `FORBIDDEN`.
  - Fetch with `cloudinary.api.resource(publicId, { resource_type })`; missing means `BAD_USER_INPUT`.
  - Limits: image at most 10 MB; video at most 100 MB and 90 seconds (stories: 30 seconds). If exceeded, **delete the asset** and return `BAD_USER_INPUT`.
  - Return `{ publicId, url (secure_url), type, width, height, durationSec }`.
  - Also create `deleteMedia(publicId, type)` (best-effort, never throws to the caller).
- Add `avatarPublicId` column to `Profile`. `setAvatar` verifies, saves `avatarUrl` and `avatarPublicId`, invalidates the profile cache, then deletes the previous avatar. `removeAvatar` clears both and deletes the asset.
- Add `src/scripts/upload.ts` (`npm run upload -- <userName> <kind> <filePath>`): requests a signature through GraphQL and uploads the file with Node's `fetch`, `FormData` and `openAsBlob` from `node:fs`. Prints the `publicId`. Export an `uploadToCloudinary(signature, filePath)` helper for smoke tests.

### Smoke test `f05`
Generate a tiny PNG from a base64 string into the OS temp folder.
1. `createUploadSignature` without a token returns `UNAUTHENTICATED`. With a token it returns all fields.
2. Upload the PNG using the signature; get a `publicId`.
3. `setAvatar(publicId)` returns a profile whose `avatarUrl` starts with `https://res.cloudinary.com/`. `profile("alice")` shows it (cache was invalidated).
4. bob calls `setAvatar` with alice's `publicId`: `FORBIDDEN`.
5. alice calls `setAvatar` with a `publicId` from a different kind folder: `BAD_USER_INPUT`. A made-up `publicId` in her folder: `BAD_USER_INPUT`.
6. `removeAvatar`: `avatarUrl` is `null`, and `cloudinary.api.resource` for the old id now fails (not found).

---

## F6 — Posts

**Goal:** create, read, edit and delete posts with 1 to 10 images/videos.

### Data model
```prisma
model Post {
  id            String   @id @default(uuid()) @db.Uuid
  authorId      String   @map("author_id") @db.Uuid
  caption       String?
  likesCount    Int      @default(0) @map("likes_count")
  commentsCount Int      @default(0) @map("comments_count")
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")
  author        Profile  @relation(fields: [authorId], references: [id], onDelete: Cascade)
  media         PostMedia[]
  @@index([authorId, createdAt(sort: Desc)])
  @@index([createdAt(sort: Desc)])
  @@map("posts")
}

model PostMedia {
  id          String    @id @default(uuid()) @db.Uuid
  postId      String    @map("post_id") @db.Uuid
  publicId    String    @map("public_id")
  url         String
  type        MediaType
  width       Int?
  height      Int?
  durationSec Float?    @map("duration_sec")
  position    Int
  post        Post      @relation(fields: [postId], references: [id], onDelete: Cascade)
  @@index([postId, position])
  @@map("post_media")
}
```
Define `enum MediaType { IMAGE VIDEO }` in Prisma. Add `postsCount Int @default(0)` to `Profile`.

### API
```graphql
type Post { id: ID!, author: Profile!, caption: String, media: [Media!]!, likesCount: Int!, commentsCount: Int!, createdAt: String! }
type PostPage { items: [Post!]!, nextCursor: String }
input CreatePostInput { caption: String, media: [MediaInput!]! }
extend type Profile { postsCount: Int! }
extend type Query {
  post(id: ID!): Post
  userPosts(username: String!, first: Int = 20, after: String): PostPage!
}
extend type Mutation {
  createPost(input: CreatePostInput!): Post!
  updatePostCaption(postId: ID!, caption: String): Post!
  deletePost(postId: ID!): Boolean!
}
```

### Rules
- All post queries require login and use `decideVisibility`. `post(id)` returns `null` when not viewable. `userPosts` returns `FORBIDDEN` for a private account the viewer cannot see.
- `createPost`: 1 to 10 media; each verified with `describeOwnedMedia` (images from `POST_IMAGE`, videos from `POST_VIDEO`); caption at most 2200. Save everything and `postsCount + 1` in one transaction.
- `updatePostCaption` and `deletePost`: author only (`FORBIDDEN` otherwise). Delete: transaction (`postsCount - 1`), then `deleteMedia` for every asset (best-effort).
- Authors are loaded with a DataLoader.

### Smoke test `f06`
1. alice uploads two images (helper) and calls `createPost`: 2 media items, alice `postsCount` 1.
2. Empty media list, 11 media items, caption of 2201 characters: each `BAD_USER_INPUT`. Using bob's `publicId`: `FORBIDDEN`.
3. `userPosts("alice")` as bob returns the post. carol is private: alice (not an accepted follower) gets `FORBIDDEN` on `userPosts("carol")`; after carol accepts alice's request she can read them.
4. bob calling `updatePostCaption` or `deletePost` on alice's post: `FORBIDDEN`. alice edits her caption: works.
5. `deletePost`: `post(id)` is `null`, `postsCount` back to 0.
6. Create 3 posts; page through with `first: 1`; order is newest first, no duplicates.

---

## F7 — Likes, comments, replies, saves

**Goal:** engagement features with correct, idempotent counters.

### Data model
```prisma
model Like {
  userId    String   @map("user_id") @db.Uuid
  postId    String   @map("post_id") @db.Uuid
  createdAt DateTime @default(now()) @map("created_at")
  @@id([userId, postId])
  @@index([postId, createdAt])
  @@map("likes")
}

model Comment {
  id           String   @id @default(uuid()) @db.Uuid
  postId       String   @map("post_id") @db.Uuid
  authorId     String   @map("author_id") @db.Uuid
  parentId     String?  @map("parent_id") @db.Uuid
  body         String
  repliesCount Int      @default(0) @map("replies_count")
  createdAt    DateTime @default(now()) @map("created_at")
  parent       Comment?  @relation("Replies", fields: [parentId], references: [id], onDelete: Cascade)
  replies      Comment[] @relation("Replies")
  @@index([postId, parentId, createdAt])
  @@index([parentId, createdAt])
  @@map("comments")
}

model SavedPost {
  userId    String   @map("user_id") @db.Uuid
  postId    String   @map("post_id") @db.Uuid
  createdAt DateTime @default(now()) @map("created_at")
  @@id([userId, postId])
  @@index([userId, createdAt])
  @@map("saved_posts")
}
```
Add proper relations to `Profile` and `Post` (with `onDelete: Cascade`).

### API
```graphql
type Comment { id: ID!, post: Post!, author: Profile!, body: String!, parentId: ID, repliesCount: Int!, createdAt: String! }
type CommentPage { items: [Comment!]!, nextCursor: String }
extend type Post {
  viewerHasLiked: Boolean!
  viewerHasSaved: Boolean!
  comments(first: Int = 20, after: String): CommentPage!
}
extend type Query {
  comments(postId: ID!, first: Int = 20, after: String): CommentPage!
  replies(commentId: ID!, first: Int = 20, after: String): CommentPage!
  likers(postId: ID!, first: Int = 20, after: String): ProfilePage!
  savedPosts(first: Int = 20, after: String): PostPage!
}
extend type Mutation {
  likePost(postId: ID!): Post!   unlikePost(postId: ID!): Post!
  addComment(postId: ID!, body: String!, parentId: ID): Comment!
  deleteComment(commentId: ID!): Boolean!
  savePost(postId: ID!): Post!   unsavePost(postId: ID!): Post!
}
```

### Rules
- Every action first checks the post is viewable (`decideVisibility`); otherwise `NOT_FOUND`. Blocked users cannot like or comment.
- Like/unlike are idempotent: only change the counter when a row is actually created or deleted (catch Prisma `P2002` on duplicate like).
- Comment body 1 to 500 characters. Replies are **one level only**: `parentId` must belong to the same post and be a top-level comment, else `BAD_USER_INPUT`.
- `addComment` updates `commentsCount` (+1) and the parent's `repliesCount` in a transaction.
- `deleteComment`: comment author or post owner only. Deleting a top-level comment also removes its replies; subtract `1 + number of replies` from `commentsCount`.
- `viewerHasLiked` and `viewerHasSaved` use DataLoaders that batch one query for many posts.
- `comments` lists top-level comments, newest first.

### Smoke test `f07`
1. alice posts. bob likes: `likesCount` 1; `viewerHasLiked` true for bob, false for alice. Like again: still 1. Unlike: 0.
2. carol comments; bob replies to carol's comment; `commentsCount` 2; reply to a reply: `BAD_USER_INPUT`; `Post.comments` returns the top-level comment with `repliesCount` 1; `replies` returns bob's reply.
3. bob deleting carol's comment: `FORBIDDEN`. alice (post owner) deleting it: `commentsCount` 0.
4. save/unsave and `savedPosts` listing.
5. A non-follower of a private account cannot like or comment on its posts. A blocked user cannot like.
6. `likers` pagination with `first: 1`.

---

## F8 — Home feed and Explore (v1)

**Goal:** the main feed. Strategy: **fan-out on read** (build the feed when the user opens it), with the first page cached in Redis.

### API
```graphql
extend type Query {
  homeFeed(first: Int = 20, after: String): PostPage!
  explore(first: Int = 20, after: String): PostPage!
}
```

### Rules
- `homeFeed`: posts whose author is the viewer **or** an accepted followed account; exclude anyone blocked either way; order `createdAt desc, id desc`.
  Prisma shape: `where: { OR: [{ authorId: me }, { author: { followers: { some: { followerId: me, status: 'ACCEPTED' } } } }] }`.
- `explore` (v1): newest posts from **public** accounts, excluding the viewer's own posts and blocked accounts. (F14 upgrades the ranking.)
- Both are cursor-paginated and hydrate `author` and `media` efficiently (no N+1).

### Redis (cache the first page)
- Key `cache:feed:{userId}:{first}`, JSON array of **post ids** for the first page only (when `after` is empty), **TTL 30s**. On a hit, load those posts with `findMany({ where: { id: { in: ids } } })`, restore the order, and drop ids that no longer exist or are no longer viewable.
- Invalidate the viewer's feed key when they create or delete a post, follow, unfollow, or block someone.
- Explanation for the owner: we cache ids (small) instead of whole posts, so counts stay fresh and memory use stays low.

### Smoke test `f08`
Reset data. alice follows bob.
1. bob posts p1 then p2; carol posts p3. alice's feed is `[p2, p1]` (no p3).
2. alice posts p0: it appears at the top of her own feed immediately (cache invalidated).
3. A second `homeFeed` call within 30 seconds: Redis key exists with TTL at most 30.
4. alice unfollows bob: the feed no longer contains bob's posts right away.
5. Pagination across three pages with `first: 1`: ordered, no duplicates.
6. `explore` for alice includes carol's p3 but not alice's own post. After carol goes private, p3 disappears from `explore`.
7. After bob blocks alice, bob's posts vanish from alice's feed and explore.

---

## F9 — Hashtags, mentions, search

**Goal:** discover people and topics.

### Data model
```prisma
model Hashtag {
  id         String        @id @default(uuid()) @db.Uuid
  name       String        @unique
  postsCount Int           @default(0) @map("posts_count")
  posts      PostHashtag[]
  @@map("hashtags")
}
model PostHashtag {
  postId    String  @map("post_id") @db.Uuid
  hashtagId String  @map("hashtag_id") @db.Uuid
  post      Post    @relation(fields: [postId], references: [id], onDelete: Cascade)
  hashtag   Hashtag @relation(fields: [hashtagId], references: [id], onDelete: Cascade)
  @@id([postId, hashtagId])
  @@index([hashtagId])
  @@map("post_hashtags")
}
model PostMention {
  postId      String @map("post_id") @db.Uuid
  mentionedId String @map("mentioned_id") @db.Uuid
  @@id([postId, mentionedId])
  @@map("post_mentions")
}
```

### API
```graphql
type Hashtag { name: String!, postsCount: Int! }
extend type Post { hashtags: [String!]!, mentions: [Profile!]! }
extend type Query {
  searchUsers(query: String!, first: Int = 20, after: String): ProfilePage!
  searchHashtags(query: String!, first: Int = 10): [Hashtag!]!
  hashtag(name: String!): Hashtag
  hashtagPosts(name: String!, first: Int = 20, after: String): PostPage!
}
```

### Rules
- `lib/hashtags.ts` exports pure functions `extractHashtags(text)` (regex `/(?:^|\s)#([\p{L}\p{N}_]{1,50})/gu`, lowercase, unique, at most 30) and `extractMentions(text)` (`/(?:^|\s)@([a-z0-9_]{3,20})/g`, unique, at most 20).
- `createPost` and `updatePostCaption` sync `PostHashtag` and `PostMention` inside the transaction, creating hashtags as needed and updating `Hashtag.postsCount` (diff old vs new). Mentions only link to existing, non-blocking profiles. `deletePost` decrements `postsCount` for its hashtags.
- `searchUsers`: query at least 2 characters (otherwise an empty page); `username startsWith` OR `fullName contains`, case-insensitive; exclude users blocked either way; order `followersCount desc, id asc`.
- `hashtagPosts`: only posts the viewer can see; newest first.
- Redis: cache the **first page** of `searchUsers` and `searchHashtags` for 30s (`cache:search:users:{q}`, `cache:search:tags:{q}`), lowercase and trimmed query as key part.

### Smoke test `f09`
1. Caption `Hello #Lagos #lagos #food @bob` creates hashtags `lagos` (once) and `food`; `Post.mentions` contains bob; `lagos.postsCount` 1.
2. Editing the caption to remove `#food` lowers `food.postsCount` to 0. Deleting the post lowers `lagos.postsCount`.
3. `searchHashtags("la")` finds `lagos`. `hashtagPosts("lagos")` returns the post; a private account's post is hidden from non-followers.
4. `searchUsers("al")` finds alice; a 1-character query returns an empty page; a blocked user is excluded.
5. Search first page creates the Redis key with TTL at most 30.
6. Inline checks of `extractHashtags` and `extractMentions` with tricky input (`a#b`, `#`, duplicates, unicode).

---

## F10 — Notifications (persistent)

**Goal:** a stored notification list with an unread badge. Real-time delivery comes in F13.

### Data model
```prisma
enum NotificationType { LIKE COMMENT REPLY FOLLOW FOLLOW_REQUEST FOLLOW_ACCEPTED MENTION MISSED_CALL }

model Notification {
  id          String           @id @default(uuid()) @db.Uuid
  recipientId String           @map("recipient_id") @db.Uuid
  actorId     String           @map("actor_id") @db.Uuid
  type        NotificationType
  postId      String?          @map("post_id") @db.Uuid
  commentId   String?          @map("comment_id") @db.Uuid
  readAt      DateTime?        @map("read_at")
  createdAt   DateTime         @default(now()) @map("created_at")
  // relations to Profile (recipient, actor), Post and Comment with onDelete: Cascade
  @@index([recipientId, createdAt(sort: Desc)])
  @@index([recipientId, readAt])
  @@map("notifications")
}
```

### API
```graphql
enum NotificationType { LIKE COMMENT REPLY FOLLOW FOLLOW_REQUEST FOLLOW_ACCEPTED MENTION MISSED_CALL }
type Notification { id: ID!, type: NotificationType!, actor: Profile!, post: Post, comment: Comment, readAt: String, createdAt: String! }
type NotificationPage { items: [Notification!]!, nextCursor: String }
extend type Query {
  notifications(first: Int = 20, after: String, unreadOnly: Boolean = false): NotificationPage!
  unreadNotificationsCount: Int!
}
extend type Mutation {
  markNotificationRead(id: ID!): Boolean!
  markAllNotificationsRead: Boolean!
}
```

### Rules
- Create **one** entry point `modules/notifications/service.ts` with `notifyUser({ type, recipientId, actorId, postId?, commentId? })`. All other code calls only this function (later features extend it).
- Never notify yourself. Skip when the recipient has blocked the actor. Dedupe `LIKE` and `FOLLOW` (same actor, recipient, type, post: skip if one exists).
- Hook into: `likePost` (LIKE to post owner); `addComment` (COMMENT to post owner, REPLY to the parent comment's author; do not notify the same person twice); `follow` (FOLLOW, or FOLLOW_REQUEST when pending); `acceptFollowRequest` (FOLLOW_ACCEPTED to the requester, remove the old FOLLOW_REQUEST); mentions in captions and comments (MENTION).
- Cleanup: `unlikePost` removes the LIKE notification; `unfollow` removes the FOLLOW notification; deleting a post or comment cascades.
- Unread badge in Redis: key `notif:unread:{userId}`, `INCR` on create, `DECR` when marking an unread one as read, `DEL` on mark-all. On a missing key recompute from the database and store with a **24h TTL** (self-healing counter).
- Users only see their own notifications.

### Smoke test `f10`
1. bob likes alice's post: alice has 1 `LIKE` notification and `unreadNotificationsCount` 1. bob likes again: still 1. bob unlikes: 0.
2. carol comments: alice gets `COMMENT`. bob replies to carol: carol gets `REPLY`, alice gets `COMMENT`, no duplicates.
3. alice liking her own post creates nothing.
4. `markNotificationRead` lowers the count; `markAllNotificationsRead` sets 0; `unreadOnly` filter works.
5. `follow` creates `FOLLOW`; a request to a private account creates `FOLLOW_REQUEST`; accepting creates `FOLLOW_ACCEPTED`.
6. Delete the Redis key manually: `unreadNotificationsCount` still returns the right number (recomputed).
7. bob cannot read or mark alice's notifications.

---

## F11 — Socket.IO server, Redis adapter, presence

**Goal:** an authenticated WebSocket layer that works across many server instances, plus online/offline presence.

### Packages
`socket.io`, `@socket.io/redis-adapter`, dev: `socket.io-client`.

### Steps
1. Add env `CLIENT_ORIGIN` (default `http://localhost:3000`, comma-separated list allowed) and `INSTANCE_ID` (default `local`). Include `instance: INSTANCE_ID` in the `/health` JSON.
2. Refactor `auth/getUser.ts` to export `verifyToken(token)` returning `{ id, email, exp } | null`. HTTP and sockets share it.
3. Create `realtime/io.ts` with `initIO(httpServer)`: Socket.IO with CORS from `CLIENT_ORIGIN`; Redis adapter using `redis.duplicate()` for the pub and sub clients. Call it in `server.ts` on the **same** `httpServer`. Export `getIO()`.
4. **Auth middleware**: read `socket.handshake.auth.token`, call `verifyToken`, set `socket.data.userId`; otherwise `next(new Error('UNAUTHENTICATED'))`.
5. On connection: `socket.join('user:' + userId)` (a personal room, so any server instance can reach this user); emit `ready` with `{ userId, instance }`; handle `ping:test` with an acknowledgement `{ pong: true, instance }`.
6. **Token expiry**: schedule `socket.disconnect(true)` at the token's `exp` time (clear on disconnect). Clients must reconnect with a fresh token.
7. **Presence** (`realtime/presence.ts`):
   - Connect: `INCR presence:conn:{userId}` and `EXPIRE 90`.
   - Every 30s per socket: `EXPIRE presence:conn:{userId} 90` (heartbeat; a crashed server's key expires by itself).
   - Disconnect: `DECR`; if the value is 0 or below, `DEL` the key and `SET presence:lastseen:{userId} <ISO time>`.
8. GraphQL:
   ```graphql
   type PresenceInfo { isOnline: Boolean!, lastSeenAt: String }
   extend type Query { presence(username: String!): PresenceInfo! }
   ```
   Visible only to the user themself and accepted followers (and, from F12, people sharing a conversation); everyone else gets `{ isOnline: false, lastSeenAt: null }`.
9. Graceful shutdown: close Socket.IO on SIGTERM/SIGINT.
10. Add the `socketClient(name)` helper to smoke helpers: connects with a user's token, exposes `once(event)`, `emitAck(event, payload)` and `close()`.

### Smoke test `f11`
1. Connecting without a token or with a bad token: `connect_error` with message `UNAUTHENTICATED`.
2. alice connects: receives `ready`. `ping:test` acknowledges with `pong: true`.
3. Redis `presence:conn:{aliceId}` is `1` with TTL at most 90. A second alice connection makes it `2`. Closing both removes the key and sets `presence:lastseen:{aliceId}`.
4. If bob follows alice: while alice is connected, `presence("alice")` as bob gives `isOnline: true`; as carol (not a follower) gives `false` and `lastSeenAt: null`.
5. Check the Redis adapter is attached (log or inspect `io.of('/').adapter.constructor.name`).

---

## F12 — Direct messages and group chat

**Goal:** real-time chat with history, unread counts, read receipts, typing indicators, and idempotent sending.

### Data model
```prisma
enum MemberRole { OWNER MEMBER }

model Conversation {
  id            String   @id @default(uuid()) @db.Uuid
  isGroup       Boolean  @default(false) @map("is_group")
  title         String?
  directKey     String?  @unique @map("direct_key")   // sorted "idA:idB" for 1:1 chats
  createdById   String   @map("created_by_id") @db.Uuid
  lastMessageAt DateTime @default(now()) @map("last_message_at")
  createdAt     DateTime @default(now()) @map("created_at")
  members       ConversationMember[]
  messages      Message[]
  @@index([lastMessageAt(sort: Desc)])
  @@map("conversations")
}

model ConversationMember {
  conversationId String       @map("conversation_id") @db.Uuid
  userId         String       @map("user_id") @db.Uuid
  role           MemberRole   @default(MEMBER)
  joinedAt       DateTime     @default(now()) @map("joined_at")
  lastReadAt     DateTime?    @map("last_read_at")
  conversation   Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  @@id([conversationId, userId])
  @@index([userId])
  @@map("conversation_members")
}

model Message {
  id             String    @id @default(uuid()) @db.Uuid
  conversationId String    @map("conversation_id") @db.Uuid
  senderId       String    @map("sender_id") @db.Uuid
  body           String?
  mediaPublicId  String?   @map("media_public_id")
  mediaUrl       String?   @map("media_url")
  clientId       String?   @map("client_id")
  deletedAt      DateTime? @map("deleted_at")
  createdAt      DateTime  @default(now()) @map("created_at")
  conversation   Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  @@unique([conversationId, senderId, clientId])
  @@index([conversationId, createdAt(sort: Desc)])
  @@map("messages")
}
```

### API
```graphql
type Message { id: ID!, conversationId: ID!, sender: Profile!, body: String, media: Media, createdAt: String!, deleted: Boolean!, clientId: String }
type Conversation { id: ID!, isGroup: Boolean!, title: String, members: [Profile!]!, lastMessage: Message, unreadCount: Int!, lastMessageAt: String! }
type ConversationPage { items: [Conversation!]!, nextCursor: String }
type MessagePage { items: [Message!]!, nextCursor: String }
input SendMessageInput { conversationId: ID!, body: String, media: MediaInput, clientId: String }
extend type Query {
  conversations(first: Int = 20, after: String): ConversationPage!
  conversation(id: ID!): Conversation
  messages(conversationId: ID!, first: Int = 30, after: String): MessagePage!
}
extend type Mutation {
  startConversation(username: String!): Conversation!
  createGroup(title: String!, usernames: [String!]!): Conversation!
  sendMessage(input: SendMessageInput!): Message!
  markConversationRead(conversationId: ID!): Boolean!
  deleteMessage(messageId: ID!): Boolean!
}
```

### Socket events
| Direction | Event | Payload |
|---|---|---|
| client to server | `message:send` | `SendMessageInput`, acknowledged with `{ ok: true, message }` or `{ ok: false, code }` |
| client to server | `conversation:read` | `{ conversationId }` |
| client to server | `typing:start`, `typing:stop` | `{ conversationId }` |
| server to client | `message:new` | message payload |
| server to client | `message:read` | `{ conversationId, userId, readAt }` |
| server to client | `message:deleted` | `{ conversationId, messageId }` |
| server to client | `typing` | `{ conversationId, userId, isTyping }` |

### Rules
- **One service** `sendMessage()` used by both the GraphQL mutation and the socket handler. After saving it updates `lastMessageAt`, then emits `message:new` to **every member's `user:{id}` room** (including the sender's other devices).
- 1:1 chats: `directKey` is the two user ids sorted and joined by `:`. `startConversation` returns the existing conversation if one exists. Cannot message yourself. Blocked either way gives `FORBIDDEN`.
- Groups: title 1 to 50 characters, 2 to 49 other members, creator is `OWNER`; blocked members are rejected.
- A message needs a body (at most 2000 characters) or media (`MESSAGE_IMAGE` kind only, verified). Only members may read or send.
- **Idempotency**: if `(conversationId, senderId, clientId)` already exists, return the existing message and do not emit again.
- `deleteMessage`: sender only; soft delete (set `deletedAt`, hide body and media); emit `message:deleted`.
- **Unread counts in Redis**: hash `chat:unread:{userId}`, field = conversationId. `HINCRBY` for every recipient on send; `HDEL` on read. If the field is missing, recompute from the database (messages after `lastReadAt` not sent by me) and store it. `markConversationRead` also sets `lastReadAt` and emits `message:read`.
- `typing:*` events are relayed only to other members and are never stored.
- Provide an `onMessageCreated` hook list in the service (F17 plugs push notifications in here). Extend `presence` visibility to conversation partners.

### Smoke test `f12`
1. alice `startConversation("bob")` returns an id; calling again returns the **same** id. `startConversation("alice")` as alice: `BAD_USER_INPUT`.
2. bob is connected by socket. alice sends via `message:send`: ack `ok`, and bob receives `message:new` within 2 seconds.
3. Sending twice with the same `clientId`: one stored row, same message id returned.
4. bob's `unreadCount` is 1 (and Redis hash shows it). bob `markConversationRead`: count 0, alice receives `message:read`.
5. alice emits `typing:start`: bob receives `typing` with `isTyping: true`.
6. `messages` pagination (`first: 1`) is newest first, no duplicates.
7. carol (not a member) reading messages: `FORBIDDEN`. If bob blocks alice, alice's send returns `FORBIDDEN`.
8. Group of alice, bob, carol: a message reaches both other members. Non-sender `deleteMessage`: `FORBIDDEN`; sender delete emits `message:deleted` and `deleted: true`.

---

## F13 — Real-time notifications

**Goal:** notifications appear instantly on connected clients.

### Steps
1. Add package `@socket.io/redis-emitter`. Create `realtime/emit.ts` exporting `emitToUser(userId, event, payload)` that uses the **Emitter** (publishes through Redis, so it works from any process: API or worker, and reaches users on any instance).
2. Extend `notifyUser` (F10): after the database insert and unread increment, call `emitToUser(recipientId, 'notification:new', payload)` and `emitToUser(recipientId, 'notification:unread', { count })`.
   - `payload`: `{ id, type, actor: { id, username, avatarUrl }, postId, commentId, createdAt }`.
3. `markNotificationRead` and `markAllNotificationsRead` emit `notification:unread` with the new count (so the badge updates on all the user's devices).
4. If the recipient is offline nothing breaks (the event simply has no listener).

### Smoke test `f13`
1. bob connects by socket. alice likes bob's post: bob receives `notification:new` (type `LIKE`) and `notification:unread` with count 1 within 2 seconds.
2. bob's count in the event equals `unreadNotificationsCount`.
3. bob `markAllNotificationsRead`: receives `notification:unread` with count 0.
4. alice liking her own post: no event.
5. A notification for a disconnected user: no error, and the notification is stored.

---

## F14 — Background jobs (BullMQ) and Explore v2

**Goal:** move slow and unreliable work out of the request path into queues processed by a **separate worker process**. This is a core scaling idea: the API stays fast, and workers scale independently.

### Packages and setup
`bullmq`. Create `config/queues.ts`:
- A dedicated Redis connection for BullMQ: `new Redis(REDIS_URL, { maxRetriesPerRequest: null })` (required by BullMQ workers).
- Queues: `notifications`, `media`, `maintenance`. (F17 adds `push`, F18 adds `calls`.)
- Default job options: `attempts: 5`, exponential backoff, `removeOnComplete` (keep the last 1000), `removeOnFail` (keep the last 5000).

Create `src/worker.ts` (second entry point): starts all workers, logs, and shuts down gracefully on SIGTERM. Add scripts `"worker": "tsx watch --env-file=.env src/worker.ts"` and `"start:worker": "node --env-file=.env dist/worker.js"`.

**From this feature on, the worker must be running (`npm run worker`) while smoke tests run.**

### Jobs
1. **`notifications:create`**: `notifyUser()` now only **enqueues** this job (use `jobId = type:actorId:recipientId:postId:commentId` to dedupe). The processor does everything `notifyUser` did before: insert, update the unread counter, `emitToUser(...)`. Update the F10 and F13 smoke tests to **poll up to 5 seconds** instead of asserting instantly.
2. **`media:destroy`**: replaces every inline best-effort Cloudinary delete (avatar replaced or removed, post deleted). 5 attempts with exponential backoff.
3. **`explore:refresh`** (repeatable, every 5 minutes): use BullMQ's current repeatable-job API (`queue.upsertJobScheduler`; check the installed version's docs). Computes trending posts and stores them in Redis.

### Explore v2
- Candidates: posts from **public** accounts created in the last 7 days. Score = `(likesCount + 3 * commentsCount) / (hoursSincePost + 2)^1.5`. Keep the top 500.
- Write to the sorted set `explore:trending` atomically: build `explore:trending:tmp`, then `RENAME` over the real key.
- `explore(first, after)`: if `explore:trending` exists, read `ZREVRANGE` by offset (the cursor is the numeric offset as a string), hydrate posts, and filter at read time (own posts, blocked, accounts that became private). Fall back to the v1 query when the sorted set is empty.
- Add `npm run job -- explore:refresh` (a small script that enqueues the job once) for testing.

### Smoke test `f14`
1. With the worker running: bob likes alice's post; alice's notification appears within 5 seconds (polling).
2. **Durability** (semi-manual, the agent may spawn and kill the worker child process in the smoke script): stop the worker, bob likes another post. Confirm the notification is **not** there yet and a waiting job exists in Redis (`bull:notifications:*` keys). Start the worker: the notification appears.
3. Deleting a post leads to the Cloudinary assets disappearing within 30 seconds (`api.resource` not found).
4. Run `explore:refresh`: `explore:trending` exists with members; `explore` returns posts in score order; cursor pagination returns no duplicates.
5. Failed jobs retry: simulate a processor error once and confirm a retry (check attempts).

---

## F15 — Stories

**Goal:** 24-hour disappearing stories with view tracking.

### Data model
```prisma
model Story {
  id            String    @id @default(uuid()) @db.Uuid
  authorId      String    @map("author_id") @db.Uuid
  mediaPublicId String    @map("media_public_id")
  mediaUrl      String    @map("media_url")
  mediaType     MediaType @map("media_type")
  width         Int?
  height        Int?
  durationSec   Float?    @map("duration_sec")
  caption       String?
  viewersCount  Int       @default(0) @map("viewers_count")
  createdAt     DateTime  @default(now()) @map("created_at")
  expiresAt     DateTime  @map("expires_at")
  views         StoryView[]
  @@index([authorId, expiresAt])
  @@index([expiresAt])
  @@map("stories")
}
model StoryView {
  storyId  String   @map("story_id") @db.Uuid
  viewerId String   @map("viewer_id") @db.Uuid
  viewedAt DateTime @default(now()) @map("viewed_at")
  story    Story    @relation(fields: [storyId], references: [id], onDelete: Cascade)
  @@id([storyId, viewerId])
  @@index([storyId, viewedAt])
  @@map("story_views")
}
```

### API
```graphql
type Story { id: ID!, author: Profile!, media: Media!, caption: String, createdAt: String!, expiresAt: String!, viewedByViewer: Boolean!, viewersCount: Int! }
type StoryGroup { author: Profile!, stories: [Story!]!, hasUnseen: Boolean!, latestAt: String! }
extend type Query {
  storiesTray: [StoryGroup!]!
  userStories(username: String!): [Story!]!
  storyViewers(storyId: ID!, first: Int = 20, after: String): ProfilePage!
}
extend type Mutation {
  createStory(media: MediaInput!, caption: String): Story!
  deleteStory(storyId: ID!): Boolean!
  viewStory(storyId: ID!): Boolean!
}
```

### Rules
- Media kinds `STORY_IMAGE` / `STORY_VIDEO` (video at most 30 seconds). `expiresAt = createdAt + 24 hours`. Every read filters `expiresAt > now()`.
- `storiesTray`: stories from accepted followings and self, excluding blocked users. Groups with unseen stories first, then by `latestAt` desc.
- `userStories` and `viewStory` use `decideVisibility` (private accounts need an accepted follow).
- `viewStory` is idempotent; the author's own views do not count; `viewersCount` only increases when a new `StoryView` row is created.
- `storyViewers`: author only.
- Job `stories:cleanup` (repeatable hourly, queue `maintenance`): delete expired stories and enqueue `media:destroy` for their assets.

### Smoke test `f15`
1. alice follows bob. bob creates a story. alice's tray shows bob with `hasUnseen: true`.
2. alice `viewStory`: `hasUnseen` false, `viewersCount` 1. Viewing again: still 1. bob viewing his own story: still 1.
3. `storyViewers` as bob lists alice; as alice: `FORBIDDEN`.
4. carol is private and bob is not her follower: `userStories("carol")` gives `FORBIDDEN`.
5. Set a story's `expiresAt` in the past via Prisma: it disappears from the tray and `userStories`; run the cleanup processor: the row is deleted and a `media:destroy` job was enqueued.
6. Blocked users do not see the story.

---

## F16 — Reels (OPTIONAL: ask the owner whether to build this)

**Goal:** a short-video feed built on existing posts.

- Add `isReel Boolean @default(false)` to `Post` and an index on `(isReel, createdAt desc)`. Set `isReel = true` in `createPost` when the post has **exactly one media item, of type VIDEO, at most 90 seconds**.
- API: `extend type Post { isReel: Boolean! }` and `extend type Query { reels(first: Int = 20, after: String): PostPage! }`.
- `reels`: newest reels from public accounts (and accessible ones), excluding blocked.
- Smoke `f16`: a single-video post is a reel and appears in `reels`; a 2-image post and a multi-media post are not; private accounts' reels are hidden; pagination works.

---

## F17 — Web Push notifications (server side)

**Goal:** notify users when the app is closed, using the Web Push standard (VAPID). This is the server half of PWA push; the browser half comes with the frontend. A small dev-only test page proves it works now.

### Setup
Package `web-push`. Generate keys: `npx web-push generate-vapid-keys`. Add to `.env`: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:you@example.com`).

### Data model
```prisma
model PushSubscription {
  id         String    @id @default(uuid()) @db.Uuid
  userId     String    @map("user_id") @db.Uuid
  endpoint   String    @unique
  p256dh     String
  auth       String
  userAgent  String?   @map("user_agent")
  createdAt  DateTime  @default(now()) @map("created_at")
  lastUsedAt DateTime? @map("last_used_at")
  @@index([userId])
  @@map("push_subscriptions")
}
```

### API
```graphql
input PushSubscriptionInput { endpoint: String!, p256dh: String!, auth: String!, userAgent: String }
extend type Query { vapidPublicKey: String! }
extend type Mutation {
  registerPushSubscription(input: PushSubscriptionInput!): Boolean!
  unregisterPushSubscription(endpoint: String!): Boolean!
}
```

### Rules
- `registerPushSubscription` **upserts by endpoint** (a different user logging in on the same browser takes ownership). Keep at most 10 subscriptions per user (delete the oldest).
- `modules/push/service.ts`: `sendToUser(userId, payload)` sends to all the user's subscriptions with `web-push`; **delete the subscription when the push service answers 404 or 410**; update `lastUsedAt`. Make the sender replaceable (`setPushSender(fn)`) so tests can inject a fake.
- Add queue `push` and processor `push:send` (3 attempts).
- **Only push when the user is offline**: skip if Redis key `presence:conn:{userId}` exists (they will get the real-time event).
- Trigger from the notification processor (title/body per type, for example `"{username} liked your post"`, `"{username} started following you"`) and from the `onMessageCreated` hook in F12 for offline recipients (`"{username}: {first 80 characters}"`, url `/messages/{conversationId}`). Payload JSON: `{ title, body, url, icon, tag }`. Plain text only.
- Dev-only test page (`NODE_ENV !== 'production'`): serve `server/public/` with `express.static`. Create `public/push-test/index.html` and `public/push-test/sw.js` (scope `/push-test/`). The page has a field to paste a token and a Subscribe button: fetch `vapidPublicKey`, ask notification permission, call `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`, then `registerPushSubscription`. `sw.js` handles `push` (show notification from `event.data.json()`) and `notificationclick` (open `url`). Works on `localhost`. Note for the owner: iOS only supports push for PWAs installed to the home screen.

### Smoke test `f17` (automated part)
1. `vapidPublicKey` returns a non-empty string. Registering a fake subscription twice leaves one row; registering the same endpoint as bob moves ownership to bob; `unregisterPushSubscription` removes it.
2. With an injected fake sender that throws `{ statusCode: 410 }`: `sendToUser` deletes that subscription. With a fake that succeeds: called once per subscription.
3. Offline rule: while the user has a presence key, no push is sent; with the key removed, the sender is called.
4. Payload text for a LIKE notification matches the expected title and body.

### Manual test (tell the owner exactly this)
Open `http://localhost:4000/push-test/`, paste a token, click Subscribe, close or minimise the tab, then have another user like the first user's post. A system notification should appear.

---

## F18 — Voice and video call signaling (WebRTC)

**Goal:** 1-to-1 audio and video calls. The server does **not** touch audio or video. It only does **signaling** (introducing the two browsers and passing their connection details), plus call state, history, and TURN credentials. Media flows peer to peer.

### Data model
```prisma
enum CallType   { AUDIO VIDEO }
enum CallStatus { MISSED REJECTED CANCELED COMPLETED FAILED }

model CallLog {
  id          String     @id @default(uuid()) @db.Uuid
  callerId    String     @map("caller_id") @db.Uuid
  calleeId    String     @map("callee_id") @db.Uuid
  type        CallType
  status      CallStatus
  startedAt   DateTime   @default(now()) @map("started_at")
  answeredAt  DateTime?  @map("answered_at")
  endedAt     DateTime?  @map("ended_at")
  durationSec Int?       @map("duration_sec")
  @@index([callerId, startedAt(sort: Desc)])
  @@index([calleeId, startedAt(sort: Desc)])
  @@map("call_logs")
}
```

### API
```graphql
enum CallType { AUDIO VIDEO }
enum CallStatus { MISSED REJECTED CANCELED COMPLETED FAILED }
type CallLog { id: ID!, caller: Profile!, callee: Profile!, type: CallType!, status: CallStatus!, startedAt: String!, durationSec: Int, direction: String! }
type CallLogPage { items: [CallLog!]!, nextCursor: String }
type IceServer { urls: [String!]!, username: String, credential: String }
extend type Query {
  callHistory(first: Int = 20, after: String): CallLogPage!
  iceServers: [IceServer!]!
}
```
`direction` is `OUTGOING` or `INCOMING` relative to the viewer.

### Socket events
| Direction | Event | Payload |
|---|---|---|
| client to server | `call:invite` | `{ toUsername, type: 'AUDIO' or 'VIDEO' }` (in non-production, optional `ringTimeoutMs` up to 30000 for tests); ack `{ ok, callId }` |
| client to server | `call:accept`, `call:reject`, `call:cancel`, `call:end` | `{ callId }` |
| client to server | `webrtc:offer`, `webrtc:answer`, `webrtc:ice` | `{ callId, data }` |
| server to client | `call:incoming` | `{ callId, from: { id, username, avatarUrl }, type }` |
| server to client | `call:accepted`, `call:rejected`, `call:canceled`, `call:missed` | `{ callId }` |
| server to client | `call:ended` | `{ callId, durationSec, reason }` |
| server to client | `call:failed` | `{ code }` (`BUSY`, `ALREADY_IN_CALL`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED`) |
| server to client | `webrtc:offer`, `webrtc:answer`, `webrtc:ice` | `{ callId, data }` (relayed to the other participant) |

### Call flow
```
caller: call:invite ──► server ──► callee: call:incoming
callee: call:accept ──► server ──► caller: call:accepted
caller creates offer ──► webrtc:offer ──► callee
callee creates answer ──► webrtc:answer ──► caller
both: webrtc:ice (many) ──► relayed
either: call:end ──► both: call:ended
```

### Rules
- **State in Redis**: hash `call:{callId}` (`callerId, calleeId, type, status RINGING|ACTIVE, startedAt, answeredAt`) with a 2h TTL. Busy markers `call:active:{userId}` set with `SET NX EX 7200` for both users at invite; removed at the end. If the callee is busy: caller gets `call:failed` with `BUSY`. If the caller is already in a call: `ALREADY_IN_CALL`.
- Cannot call yourself. Blocked either way: `FORBIDDEN`. Unknown user: `NOT_FOUND`. Rate limit: 5 invites per minute per user (use `lib/rateLimit.ts` from F19 if it exists; otherwise a simple Redis counter now and refactor in F19).
- Relay `webrtc:*` only between the two participants and only while the call is `ACTIVE`; ignore everything else.
- **Ring timeout** via a BullMQ **delayed job** on queue `calls` (`jobId = callId`, delay `RING_TIMEOUT_MS` default 30000). Processor: if still `RINGING`, mark `MISSED`, write the `CallLog`, emit `call:missed` to both, call `notifyUser({ type: 'MISSED_CALL' ... })` for the callee, clear keys. Remove the job on accept, reject, or cancel.
- **Disconnect handling**: when a participant of an `ACTIVE` call loses their last socket, enqueue a delayed check (10s). If they are still gone, end the call with reason `disconnected`.
- `call:end`: compute `durationSec`, write `CallLog` with `COMPLETED`, emit `call:ended` to both, clear keys. Reject gives `REJECTED`; cancel gives `CANCELED`.
- `iceServers`: always a STUN entry (`STUN_URL`, default `stun:stun.l.google.com:19302`). If `TURN_URL` and `TURN_SECRET` are set, add a TURN entry with **time-limited credentials**: `username = "{expiryUnixSeconds}:{userId}"`, `credential = base64(HMAC-SHA1(TURN_SECRET, username))`, valid 1 hour.
- Add a coturn service to `docker-compose.yml` using `use-auth-secret` with `TURN_SECRET`, realm `social-app`, ports `3478/udp`, `3478/tcp`, and a small relay range such as `49160-49200/udp`. Note for the owner: two browser tabs on one machine work with STUN only; TURN matters across restrictive networks, and relaying through Docker Desktop can be unreliable locally.
- Dev-only test page `public/call-test/index.html` (plain HTML and JavaScript, served by the same static route as F17): paste token, Connect, username input, Audio and Video buttons, an incoming-call prompt with Accept and Reject, `getUserMedia`, `RTCPeerConnection` using `iceServers` from GraphQL, signaling through Socket.IO (the server already serves `/socket.io/socket.io.js`), local and remote video elements.

### Smoke test `f18` (signaling, no media)
Two socket clients, alice and bob.
1. alice invites bob: bob receives `call:incoming`. bob accepts: alice receives `call:accepted`.
2. Offer, answer, and ice payloads are relayed to the other side, unchanged, in both directions. A third user (carol) emitting `webrtc:offer` for that call is ignored.
3. alice ends: both receive `call:ended`. `callHistory` shows `COMPLETED` with `durationSec >= 0` and correct `direction` for each user.
4. Reject path gives `REJECTED`. Cancel path gives `CANCELED`.
5. Busy: while alice and bob are in a call, carol invites bob and receives `call:failed` with `BUSY`.
6. Timeout: invite with `ringTimeoutMs: 3000` and no answer. Both receive `call:missed` within about 5 seconds; log is `MISSED`; bob has a `MISSED_CALL` notification.
7. Blocked user: `call:failed` with `FORBIDDEN`. Calling yourself fails.
8. `iceServers` returns STUN, and TURN with a username of the form `timestamp:userId` when configured.

### Manual test (tell the owner exactly this)
Open `http://localhost:4000/call-test/` in two tabs, paste alice's token in one and bob's in the other, call from one tab, accept in the other. Both camera and microphone streams should appear.

---

## F19 — Security and reliability hardening

**Goal:** make the API safe and stable under abuse and during restarts.

### Steps
1. **Packages:** `helmet`, `pino`, `pino-http`, `graphql-depth-limit` (dev: `pino-pretty`, `@types/graphql-depth-limit`).
2. **HTTP security:** `helmet()`; CORS allowlist from `CLIENT_ORIGIN` (no `*` in production); `express.json({ limit: '100kb' })`; `app.set('trust proxy', 1)` (needed behind nginx in F22).
3. **Rate limiting** (`lib/rateLimit.ts`): `rateLimit({ scope, id, limit, windowSec })` using Redis `INCR` and `EXPIRE` on key `rl:{scope}:{id}:{windowStart}`. Throw `RATE_LIMITED` (with `retryAfterSeconds` in `extensions`).
   | Scope | Limit |
   |---|---|
   | HTTP per IP on `/graphql` | 300 per minute (return HTTP 429) |
   | `createPost` | 10 per minute per user |
   | `addComment` | 30 per minute per user |
   | `likePost` and `follow` | 60 per minute per user |
   | `sendMessage` / socket `message:send` | 30 per 10 seconds per user |
   | `typing:*` | 10 per 5 seconds per user |
   | `call:invite` | 5 per minute per user |
   Because the counters live in Redis, the limits apply across all server instances.
4. **GraphQL protection:**
   - `validationRules: [depthLimit(8)]` (the `Post.comments` and `Comment.post` cycle makes deep queries possible).
   - Clamp every `first` argument to 50 through one shared helper.
   - `introspection: NODE_ENV !== 'production'`; no stack traces in production responses.
   - `formatError`: pass `GraphQLError`s through, replace anything else (Prisma, unknown) with `INTERNAL_SERVER_ERROR` and a request id; log the original.
5. **Logging:** `config/logger.ts` with pino (pretty in development, JSON in production, `LOG_LEVEL` env). `pino-http` adds a request id (`x-request-id`). Never log tokens, keys, passwords, or message bodies.
6. **Health endpoints:** `/health` (liveness: always cheap, includes `instance`) and `/ready` (checks Postgres and Redis; 503 if either is down).
7. **Graceful shutdown** on SIGTERM and SIGINT, in order: stop accepting HTTP, close Socket.IO, `apollo.stop()`, close BullMQ queues/workers, `redis.quit()`, `prisma.$disconnect()`, then exit. Force exit after 10 seconds.
8. Audit: every mutation input has a `zod` schema; every list uses the pagination helper; every post, story, and message read goes through `decideVisibility` or a membership check.

### Smoke test `f19`
1. Call `addComment` 31 times in a minute: the 31st fails with `RATE_LIMITED`; Redis shows the `rl:` key with a TTL.
2. Send 301 requests quickly to `/graphql`: the later ones return HTTP 429.
3. A query nested deeper than 8 levels (`post { comments { items { post { comments { items { post { comments { items { post { id }}}}}}}}}}`) is rejected by validation.
4. Introspection works in development; a unit-level check confirms it is disabled when `NODE_ENV=production`.
5. A forced internal error returns a masked message with a request id (no stack trace).
6. `curl -I http://localhost:4000/health` shows helmet headers. `/ready` returns 200, and 503 when Redis is stopped (`docker compose stop redis`, then start it again).
7. Send SIGTERM to the server: it logs each shutdown step and exits with code 0.

---

## F20 — Unit tests and CI

**Goal:** fast tests for pure logic, plus a one-command check for everything.

### Steps
1. Add `vitest`. Scripts: `"test": "vitest run"`, `"test:watch": "vitest"`.
2. Unit tests (no network, no database) for:
   - `lib/cursor.ts` (encode and decode, invalid cursor)
   - `lib/hashtags.ts` (hashtags and mentions, edge cases)
   - username and input validators
   - `decideVisibility` (a table of at least 12 combinations: owner, public, private with and without accepted follow, blocked either way, anonymous)
   - rate limit window logic (use a separate Redis database index `/15`, flushed in `beforeEach`; skip the suite if Redis is unreachable)
   - TURN credential generator (username format and HMAC output with a known secret)
3. Add `"check": "npm run typecheck && npm test"`.
4. Optional CI: `.github/workflows/ci.yml` running install, `prisma generate`, `typecheck`, `test` with a Redis service container. (Smoke tests need Supabase credentials, so they stay local.)

### Test
`npm run check` passes. Break one rule on purpose (for example make `decideVisibility` ignore blocks): a test must fail. Restore it.

---

## F21 — Docker containerisation

**Goal:** package the API and worker as container images so they run the same everywhere. The database stays in Supabase; Redis and coturn run as containers.

### Steps
1. `server/.dockerignore`: `node_modules`, `dist`, `.env`, `test-users.json`, `*.log`, `.git`.
2. `server/Dockerfile`, multi-stage, base `node:22-slim` (install `openssl` for Prisma):
   - Stage `build`: copy `package*.json` and `prisma/`, `npm ci`, `npx prisma generate`, copy source, `npm run build`, then `npm prune --omit=dev`.
   - Stage `runtime`: copy `node_modules`, `dist`, `package.json`, `prisma` from `build`; `ENV NODE_ENV=production`; `USER node`; `EXPOSE 4000`; `HEALTHCHECK` calling `/health` with Node's `fetch`; `CMD ["node", "dist/server.js"]`.
   - Keep a way to run migrations: a compose service `migrate` built from the `build` stage that runs `npx prisma migrate deploy`.
3. `docker-compose.yml` services:
   - `redis` (existing, add a healthcheck with `redis-cli ping`).
   - `api`: `build: ./server`, `env_file: ./server/.env`, environment override `REDIS_URL=redis://redis:6379`, `depends_on` redis healthy, `ports: "4000:4000"`.
   - `worker`: same image, `command: ["node", "dist/worker.js"]`, same env.
   - `coturn` (from F18).
   - `migrate` as described (profile `tools`, run on demand).
4. Explain to the owner: inside a container `localhost` means the container itself, which is why the Redis URL changes to the service name `redis`.
5. Add the production start script `"start": "node --env-file=.env dist/server.js"` if missing and make sure `npm run build` works.

### Test
1. `docker compose build` succeeds. `docker images` shows the image size (report it).
2. `docker compose up -d`: `docker compose ps` shows `api`, `worker`, `redis` healthy.
3. `curl http://localhost:4000/health` returns `ok` with Postgres and Redis up.
4. `npm run smoke -- all` passes **against the containerised API** (local `npm run dev` stopped).
5. `docker compose exec api id` shows a non-root user.
6. `docker compose logs -f worker` shows jobs being processed when a like is created.
7. `docker compose down` then `docker compose up -d`: data persists (Supabase) and the Redis volume is intact.

---

## F22 — Scaling lab (load balancer and replicas) and architecture doc

**Goal:** prove the system scales horizontally and understand why it works.

### Steps
1. Define three API services `api1`, `api2`, `api3` in compose (use a YAML anchor so they share one definition), each with `INSTANCE_ID` set (`api1`, `api2`, `api3`) and **no host port mapping**.
2. Add `nginx` (`nginx:alpine`) with `nginx/nginx.conf`:
   - `upstream api { server api1:4000; server api2:4000; server api3:4000; }`
   - `location /` proxies to `http://api` with `proxy_http_version 1.1`, `Upgrade` and `Connection "upgrade"` headers (WebSockets), `Host`, `X-Real-IP`, `X-Forwarded-For`, long `proxy_read_timeout` (for example 3600s).
   - Publish nginx on host port 4000.
3. **Socket.IO behind a load balancer:** clients must connect with `transports: ['websocket']` so no sticky sessions are needed. Document that long-polling would require sticky sessions (`ip_hash`).
4. Run the worker as its own service, and show it scaling: `docker compose up -d --scale worker=2`.
5. **Database connection math:** each API instance has its own Prisma connection pool. Document `connection_limit` in `DATABASE_URL`, the Supabase pooler limits, and the optional switch to the **transaction pooler** (port 6543, `?pgbouncer=true`) with a `directUrl` for migrations (`DIRECT_URL`, session pooler). Make this change only if the owner asks.
6. Write `docs/ARCHITECTURE.md` for the owner (plain language, with diagrams): request flow, how a WebSocket message travels across instances (Redis adapter and emitter), what each Redis key family is for (Appendix A), the Cloudinary upload flow, the notification pipeline (API, queue, worker, Redis, Socket.IO, push), the call signaling flow, why services are stateless, and a "what would break at 1 million users and how to fix it" section (read replicas, partitioning, fan-out on write, CDN, separate realtime tier, dedicated Redis for each concern).

### Test
1. `curl http://localhost:4000/health` ten times: the `instance` value cycles through `api1`, `api2`, `api3`.
2. Two socket clients (alice, bob) connect; print the `instance` from each `ready` event. When they are on **different** instances, a message sent by alice still reaches bob instantly (this proves the Redis adapter).
3. `docker compose stop api2`: requests keep working through the other two; start it again.
4. Rate limits are shared: 31 `addComment` calls spread across instances still trigger `RATE_LIMITED` on the 31st (Redis counters).
5. Load test with `autocannon`: compare `GET /health`, an uncached `profile` query (clear `cache:profile:*`) and a cached one. Report requests per second and p99 latency in a table, and explain the difference in two sentences.
6. Create a notification while alice is connected to a different instance than the one handling the request: she still receives `notification:new`.

**Done when:** all six checks pass and `docs/ARCHITECTURE.md` exists.

---

## Phase 2 (NOT part of this PRD)

The Next.js PWA frontend: design system, screens, service worker and manifest, offline support, subscribing to push, WebSocket client, WebRTC call UI. It will be specified in a separate PRD after F22.

---

## Appendix A — Redis key registry

| Key | Type | TTL | Feature |
|---|---|---|---|
| `stats:visits` | counter | none | baseline |
| `cache:profile:{username}` | string (JSON) | 60s | F3 |
| `cache:feed:{userId}:{first}` | string (JSON ids) | 30s | F8 |
| `cache:search:users:{q}`, `cache:search:tags:{q}` | string (JSON) | 30s | F9 |
| `notif:unread:{userId}` | counter | 24h (self-heals) | F10 |
| `presence:conn:{userId}` | counter | 90s, refreshed every 30s | F11 |
| `presence:lastseen:{userId}` | string (ISO time) | none | F11 |
| `chat:unread:{userId}` | hash (conversationId to count) | none | F12 |
| `explore:trending` | sorted set | replaced every 5 min | F14 |
| `call:{callId}` | hash | 2h | F18 |
| `call:active:{userId}` | string | 2h | F18 |
| `rl:{scope}:{id}:{window}` | counter | window length | F19 |
| `bull:*` | BullMQ internals | managed by BullMQ | F14+ |
| Socket.IO adapter channels | pub/sub | n/a | F11 |

## Appendix B — Environment variables

| Variable | Used by | Example / note |
|---|---|---|
| `PORT` | server | `4000` |
| `NODE_ENV` | all | `development` or `production` |
| `INSTANCE_ID` | server | `local`, `api1`, ... |
| `LOG_LEVEL` | logger | `info` |
| `DATABASE_URL` | Prisma | Supabase **session pooler** URI |
| `DIRECT_URL` | Prisma (optional) | only if switching to the transaction pooler |
| `REDIS_URL` | server, worker | `redis://localhost:6379` (`redis://redis:6379` in Docker) |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | auth | publishable key only |
| `CLIENT_ORIGIN` | CORS, Socket.IO | `http://localhost:3000` |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | media | F5 |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | push | F17 |
| `STUN_URL`, `TURN_URL`, `TURN_SECRET` | calls | F18 |
| `RING_TIMEOUT_MS` | calls | default `30000` |
| `SERVER_URL` | smoke tests | default `http://localhost:4000/graphql` |

## Appendix C — Error codes

| Code | When |
|---|---|
| `UNAUTHENTICATED` | missing, invalid, or expired token |
| `FORBIDDEN` | logged in but not allowed (not the owner, private account, not a member, blocked) |
| `NOT_FOUND` | resource missing or hidden from the viewer |
| `BAD_USER_INPUT` | validation failed |
| `CONFLICT` | uniqueness conflict where a distinct code is useful |
| `RATE_LIMITED` | too many requests (HTTP 429, includes `retryAfterSeconds`) |
| `INTERNAL_SERVER_ERROR` | masked unexpected failure |

## Appendix D — Troubleshooting for the agent

- **`P1001` or `Tenant or user not found`:** wrong `DATABASE_URL`; it must be the **session pooler** URI with user `postgres.<project-ref>`.
- **Prisma types missing after a migration:** run `npx prisma generate`, then restart the TypeScript server.
- **Relative import errors:** every relative import needs the `.js` extension; run from inside `server/`.
- **Token expired (about 1 hour):** smoke helpers re-login automatically; for manual tests run `npm run login`.
- **BullMQ error about `maxRetriesPerRequest`:** use a dedicated Redis connection with `maxRetriesPerRequest: null`.
- **Socket connects locally but not in Docker:** `localhost` inside a container is the container; use service names.
- **Cached data looks stale:** check the invalidation list of the feature and the key's TTL in `redis-cli`.

*End of PRD.*
