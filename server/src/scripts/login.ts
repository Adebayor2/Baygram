import { supabase } from "../config/supabase.js";

async function main(): Promise<void> {
  const [email, password, ...extraArgs] = process.argv.slice(2);
  if (!email || !password || extraArgs.length > 0) {
    throw new Error("Usage: npm run login -- <email> <password>");
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error || !data.session?.access_token) {
    throw new Error(`Login failed: ${error?.message ?? "No access token returned."}`);
  }

  console.log(data.session.access_token);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
