import cors from "cors";
import { HttpError } from "./errors.js";

const DEFAULT_CORS_ORIGINS = [
  "https://ahsanapp.netlify.app",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:8080",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:8080",
];

export function parseCorsOrigins(configuredOrigins: string): Set<string> {
  return new Set([
    ...DEFAULT_CORS_ORIGINS,
    ...configuredOrigins.split(",").map((origin) => origin.trim()).filter(Boolean),
  ]);
}

export function createCorsMiddleware(configuredOrigins: string) {
  const allowedOrigins = parseCorsOrigins(configuredOrigins);
  return cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      return callback(new HttpError(403, "CORS_ORIGIN_DENIED", "This origin is not allowed."));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Request-Id"],
    maxAge: 600,
  });
}
