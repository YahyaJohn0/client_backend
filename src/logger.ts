import pino from "pino";
import type { Config } from "./config.js";

export function createLogger(config: Config) {
  return pino({
    level: config.LOG_LEVEL,
    redact: {
      paths: [
        "req.headers.authorization",
        "authorization",
        "token",
        "password",
        "api_key",
        "api_secret",
        "secret",
        "FIREBASE_SERVICE_ACCOUNT",
      ],
      censor: "[REDACTED]",
    },
  });
}
