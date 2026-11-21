import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closeSmokeResources } from "./helpers.js";

type SmokeModule = { run: () => Promise<void> };

function matchesFeature(file: string, feature: string): boolean {
  if (feature === "all") return /^(t0|f\d{2})-.+\.ts$/.test(file);
  if (feature === "t0") return /^t0-.+\.ts$/.test(file);
  if (/^f\d{2}$/.test(feature)) {
    return file.startsWith(`${feature}-`) && file.endsWith(".ts");
  }
  return false;
}

async function main(): Promise<void> {
  try {
    const feature = process.argv[2] ?? "t0";
    if (!["all", "t0"].includes(feature) && !/^f\d{2}$/.test(feature)) {
      throw new Error("Usage: npm run smoke -- <t0|fNN|all>");
    }

    const folder = fileURLToPath(new URL(".", import.meta.url));
    const scripts = (await readdir(folder))
      .filter((file) => matchesFeature(file, feature))
      .sort((left, right) => {
        const order = (file: string) =>
          file.startsWith("t0-")
            ? 0
            : Number(/^f(\d{2})-/.exec(file)?.[1] ?? Number.MAX_SAFE_INTEGER);
        return order(left) - order(right) || left.localeCompare(right);
      });
    if (scripts.length === 0) {
      throw new Error(`No smoke tests found for "${feature}".`);
    }

    for (const script of scripts) {
      const loaded = (await import(
        pathToFileURL(join(folder, script)).href
      )) as SmokeModule;
      await loaded.run();
      if (process.exitCode && process.exitCode !== 0) return;
    }
  } finally {
    await closeSmokeResources();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
