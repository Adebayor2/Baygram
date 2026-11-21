import { maintenanceQueue } from "../config/queues.js";

async function main(): Promise<void> {
  const name = process.argv[2];
  if (name !== "explore:refresh") {
    throw new Error("Usage: npm run job -- explore:refresh");
  }
  await maintenanceQueue.add("explore:refresh", {});
  await maintenanceQueue.upsertJobScheduler(
    "explore-refresh",
    { every: 5 * 60 * 1000 },
    { name: "explore:refresh", data: {} }
  );
  console.log("Queued explore:refresh");
  await maintenanceQueue.close();
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
