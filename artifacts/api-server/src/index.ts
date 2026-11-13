import app from "./app";
import { logger } from "./lib/logger";
import { reconcileOpenNearIntentQuotes } from "./lib/near-intent-workflows";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  const interval = Math.max(15_000, Number(process.env.NEAR_INTENTS_STATUS_POLL_MS || "15000"));
  const monitor = () => { void reconcileOpenNearIntentQuotes(); };
  const startupTimer = setTimeout(monitor, 2_000);
  startupTimer.unref();
  const intervalTimer = setInterval(monitor, interval);
  intervalTimer.unref();
  logger.info({ interval }, "NEAR Intents settlement monitor started");
});
