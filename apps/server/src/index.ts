import { startOmni } from "./runtime";

try {
  process.loadEnvFile();
} catch {
  // No .env file — configuration comes from the environment.
}

const runtime = await startOmni();

if (runtime.config.ephemeralSessionSecret) {
  console.warn(
    "SESSION_SECRET not set — admin sessions reset on every server restart. Set it for production deployments.",
  );
}
console.log(`omni control plane listening on http://0.0.0.0:${runtime.port}`);

const shutdown = async (signal: string) => {
  console.log(`${signal} received, shutting down`);
  try {
    await runtime.close();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
