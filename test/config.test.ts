import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const requiredConfig = {
  CORS_ORIGINS: "http://localhost:5173",
  FIREBASE_PROJECT_ID: "your-firebase-project-id",
  ORDER_TRACKING_HMAC_SECRET: "a".repeat(32),
};

describe("loadConfig", () => {
  it("preserves normal runtime configuration and local port defaults", () => {
    const config = loadConfig(requiredConfig);

    expect(config.NODE_ENV).toBe("development");
    expect(config.PORT).toBe(8080);
    expect(config.LOG_LEVEL).toBe("info");
    expect(loadConfig({ ...requiredConfig, PORT: "4321", LOG_LEVEL: "debug" })).toMatchObject({
      PORT: 4321,
      LOG_LEVEL: "debug",
    });
  });

  it("requires the backend Firebase project setting instead of a Vite alias", () => {
    expect(() =>
      loadConfig({
        CORS_ORIGINS: requiredConfig.CORS_ORIGINS,
        VITE_FIREBASE_PROJECT_ID: "your-firebase-project-id",
        ORDER_TRACKING_HMAC_SECRET: requiredConfig.ORDER_TRACKING_HMAC_SECRET,
      }),
    ).toThrow(/FIREBASE_PROJECT_ID/);
  });
});
