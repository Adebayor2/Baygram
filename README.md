# BayGram

BayGram uses a Next.js client, an Express/GraphQL API, Supabase Auth, PostgreSQL, and Redis.

## Local configuration

Create `server/.env` with `DATABASE_URL`, `REDIS_URL`, `SUPABASE_URL`, and `SUPABASE_PUBLISHABLE_KEY`. For this Node.js server, `DATABASE_URL` must be a pooled PostgreSQL TCP URL (`postgres://` or `postgresql://`), not a hosted Prisma Accelerate `prisma+postgres://` URL. For Supabase, use the Session pooler URI and retain `?sslmode=require` for an encrypted database connection. `SUPABASE_URL` must be the project's HTTP(S) URL (for example, `https://<project-ref>.supabase.co`), not the PostgreSQL connection string.

Create `client/.env.local` with:

```env
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable-key>
NEXT_PUBLIC_GRAPHQL_URL=http://localhost:4000/graphql
```

The Supabase publishable key is intended for browser use. Never put a Supabase secret/service-role key in a `NEXT_PUBLIC_` variable.

## Run locally

Start Redis with `docker compose up -d redis`, then start each app in its own terminal:

```bash
cd server
npm run dev
```

```bash
cd client
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The API health check is at [http://localhost:4000/health](http://localhost:4000/health) and checks Supabase Auth, PostgreSQL, and Redis. Sign-up may require email confirmation depending on the Supabase project's Auth settings.
