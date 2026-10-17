import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { initializeFirebase } from "./firebase.js";
import { createLogger } from "./logger.js";

try {
  const envFile = join(process.cwd(), ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const config = loadConfig();
  const logger = createLogger(config);

  // A failing Firebase/Cloudinary transport can surface as an unhandled
  // rejection (for example when Application Default Credentials are missing).
  // Log it instead of letting Node terminate the API process.
  process.on("unhandledRejection", (reason) => {
    logger.error(
      { error: reason instanceof Error ? reason.message : String(reason) },
      "unhandled promise rejection",
    );
  });

  const { db, auth } = initializeFirebase(config);
  const app = createApp({ config, db, auth, logger });
  const server = app.listen(config.PORT, () =>
    logger.info({ port: config.PORT, environment: config.NODE_ENV }, "Zamzam API listening"),
  );

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      logger.error(
        { port: config.PORT },
        "port already in use; stop the other process or change PORT",
      );
    } else {
      logger.error({ error: error.message }, "server error");
    }
    process.exitCode = 1;
  });

  const shutdown = (signal: NodeJS.Signals) => {
    logger.info({ signal }, "shutting down");
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown startup error.";
  console.error(`Startup failed: ${message}`);
  process.exitCode = 1;
}
