function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

const rawDatabaseUrl = requiredEnv("DATABASE_URL");
let parsedDatabaseUrl: URL;
try {
  // Supabase's connection string is occasionally copied without its
  // `postgresql://` scheme (it then starts with `/postgres.<project-ref>`).
  const normalizedDatabaseUrl = rawDatabaseUrl.startsWith("/postgres.")
    ? `postgresql:/${rawDatabaseUrl}`
    : rawDatabaseUrl;
  parsedDatabaseUrl = new URL(normalizedDatabaseUrl);
} catch {
  throw new Error(
    "DATABASE_URL must be a valid PostgreSQL connection URL (for Supabase, use the pooler URI beginning postgresql://)."
  );
}

if (!["postgres:", "postgresql:"].includes(parsedDatabaseUrl.protocol)) {
  throw new Error(
    "DATABASE_URL must use postgres:// or postgresql://, not a Prisma Accelerate URL."
  );
}

const rawRedisUrl = requiredEnv("REDIS_URL");
let parsedRedisUrl: URL;
try {
  parsedRedisUrl = new URL(rawRedisUrl);
} catch {
  throw new Error("REDIS_URL must be a valid redis:// or rediss:// URL.");
}
if (!["redis:", "rediss:"].includes(parsedRedisUrl.protocol)) {
  throw new Error("REDIS_URL must use redis:// or rediss://.");
}

const supabaseUrl = requiredEnv("SUPABASE_URL");
let parsedSupabaseUrl: URL;
try {
  parsedSupabaseUrl = new URL(supabaseUrl);
} catch {
  throw new Error("SUPABASE_URL must be a valid Supabase project URL.");
}

if (
  !["https:", "http:"].includes(parsedSupabaseUrl.protocol) ||
  (parsedSupabaseUrl.protocol === "http:" &&
    parsedSupabaseUrl.hostname !== "localhost" &&
    parsedSupabaseUrl.hostname !== "127.0.0.1")
) {
  throw new Error(
    "SUPABASE_URL must be the Supabase project HTTP(S) URL, not a database connection URL."
  );
}

export const env = {
  port: Number(process.env.PORT) || 4000,
  nodeEnv: process.env.NODE_ENV ?? "development",
  databaseUrl: parsedDatabaseUrl.toString(),
  redisUrl: parsedRedisUrl.toString(),
  supabaseUrl: parsedSupabaseUrl.toString().replace(/\/$/, ""),
  supabasePublishableKey: requiredEnv("SUPABASE_PUBLISHABLE_KEY"),
  cloudinaryCloudName: requiredEnv("CLOUDINARY_CLOUD_NAME"),
  cloudinaryApiKey: requiredEnv("CLOUDINARY_API_KEY"),
  cloudinaryApiSecret: requiredEnv("CLOUDINARY_API_SECRET"),
  clientOrigin: process.env.CLIENT_ORIGIN ?? "http://localhost:3000",
  instanceId: process.env.INSTANCE_ID ?? "local",
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? "",
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? "",
  vapidSubject: process.env.VAPID_SUBJECT ?? "mailto:you@example.com",
  stunUrl: process.env.STUN_URL ?? "stun:stun.l.google.com:19302",
  turnUrl: process.env.TURN_URL ?? "",
  turnSecret: process.env.TURN_SECRET ?? "",
  logLevel: process.env.LOG_LEVEL ?? "info",
};
