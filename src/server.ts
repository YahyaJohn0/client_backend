import { app, logger } from "./app.js";

const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, "0.0.0.0", () => {
  logger.info({ port, environment: process.env.NODE_ENV }, "Zamzam API listening");
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    logger.error({ port }, "port already in use; stop the other process or change PORT");
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
