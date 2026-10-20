import { z } from "zod";

const booleanValue = z.enum(["true", "false"]).transform((value) => value === "true");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  CORS_ORIGINS: z.string().default(""),
  /** Number of reverse-proxy hops to trust (e.g. 1 on a hosting platform). */
  TRUST_PROXY: z.string().default("1"),
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_DATABASE_URL: z.string().url(),
  FIREBASE_SERVICE_ACCOUNT: z.string().optional(),
  ADMIN_UIDS: z.string().default(""),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  CLOUDINARY_UPLOAD_PRESET: z.string().default("zamzam"),
  CLOUDINARY_ASSET_FOLDER: z.string().regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/).default("samples/ecommerce"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().max(20 * 1024 * 1024).default(5 * 1024 * 1024),
  COD_ENABLED: booleanValue.default("true"),
  DEFAULT_SHIPPING_FEE: z.coerce.number().nonnegative().default(0),
  ORDER_TRACKING_HMAC_SECRET: z.string().min(32),
});

export type Config = z.infer<typeof schema>;

function cloudinaryCredentials(value: string | undefined) {
  if (!value) return {};
  try {
    const url = new URL(value);
    if (url.protocol !== "cloudinary:" || !url.hostname || !url.username || !url.password) throw new Error();
    return {
      cloudName: url.hostname,
      apiKey: decodeURIComponent(url.username),
      apiSecret: decodeURIComponent(url.password),
    };
  } catch {
    throw new Error("Invalid configuration. Check these environment variables: CLOUDINARY_URL");
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cloudinary = cloudinaryCredentials(env.CLOUDINARY_URL);
  const parsed = schema.safeParse({
    ...env,
    CLOUDINARY_CLOUD_NAME: env.CLOUDINARY_CLOUD_NAME ?? cloudinary.cloudName,
    CLOUDINARY_API_KEY: env.CLOUDINARY_API_KEY ?? cloudinary.apiKey,
    CLOUDINARY_API_SECRET: env.CLOUDINARY_API_SECRET ?? cloudinary.apiSecret,
  });
  if (!parsed.success) {
    const missing = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new Error(`Invalid configuration. Check these environment variables: ${missing.join(", ")}`);
  }
  return parsed.data;
}

export function parseAdminUids(value: string): Set<string> {
  return new Set(value.split(",").map((uid) => uid.trim()).filter(Boolean));
}
