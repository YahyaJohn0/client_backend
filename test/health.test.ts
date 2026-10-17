import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import request from "supertest";
import type { Firestore } from "firebase-admin/firestore";
import type { Auth } from "firebase-admin/auth";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

function appWithReadiness(read: () => Promise<unknown>) {
  const db = {
    collection: () => ({
      doc: () => ({ get: read }),
    }),
  } as unknown as Firestore;
  const auth: Pick<Auth, "verifyIdToken"> = {
    verifyIdToken: async () => {
      throw new Error("Authentication is not used by health routes.");
    },
  };

  return createApp({
    config: loadConfig({
      CORS_ORIGINS: "http://localhost:5173",
      FIREBASE_PROJECT_ID: "your-firebase-project-id",
      ORDER_TRACKING_HMAC_SECRET: "a".repeat(32),
    }),
    db,
    auth,
    logger: pino({ level: "silent" }),
  });
}

describe("health endpoints", () => {
  it("reports liveness without requiring a Firestore request", async () => {
    const app = appWithReadiness(vi.fn());

    const response = await request(app).get("/health/live");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, data: { status: "ok" } });
  });

  it("reports readiness only after Firestore responds", async () => {
    const read = vi.fn().mockResolvedValue({});
    const app = appWithReadiness(read);

    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, data: { status: "ready" } });
    expect(read).toHaveBeenCalledOnce();
  });

  it("returns a safe unavailable response when Firestore readiness fails", async () => {
    const app = appWithReadiness(vi.fn().mockRejectedValue(new Error("private backend detail")));

    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(503);
    expect(response.body.error.message).toBe("A required service is unavailable.");
    expect(JSON.stringify(response.body)).not.toContain("private backend detail");
  });
});
