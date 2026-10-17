import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

function requiredEnv(): NodeJS.ProcessEnv {
  return {
    CORS_ORIGINS: "http://localhost:5173",
    VITE_FIREBASE_PROJECT_ID: "test-project",
    ORDER_TRACKING_HMAC_SECRET: "test-secret-that-is-at-least-32-characters",
  };
}

describe("loadConfig", () => {
  it("supports the Vite project and Cloudinary settings with a server Cloudinary URL", () => {
    const config = loadConfig({
      ...requiredEnv(),
      CLOUDINARY_URL: "cloudinary://api-key:api-secret@cloud-name",
      VITE_CLOUDINARY_CLOUD_NAME: "cloud-name",
      VITE_CLOUDINARY_UPLOAD_PRESET: "signed-products",
    });

    expect(config.FIREBASE_PROJECT_ID).toBe("test-project");
    expect(config.CLOUDINARY_CLOUD_NAME).toBe("cloud-name");
    expect(config.CLOUDINARY_API_KEY).toBe("api-key");
    expect(config.CLOUDINARY_API_SECRET).toBe("api-secret");
    expect(config.CLOUDINARY_UPLOAD_PRESET).toBe("signed-products");
    expect(config).not.toHaveProperty("CLOUDINARY_URL");
  });

  it("prefers explicit backend values over Vite aliases and URL credentials", () => {
    const config = loadConfig({
      ...requiredEnv(),
      FIREBASE_PROJECT_ID: "backend-project",
      CLOUDINARY_URL: "cloudinary://url-key:url-secret@url-cloud",
      CLOUDINARY_CLOUD_NAME: "backend-cloud",
      CLOUDINARY_API_KEY: "backend-key",
      CLOUDINARY_API_SECRET: "backend-secret",
      CLOUDINARY_UPLOAD_PRESET: "backend-preset",
      VITE_CLOUDINARY_CLOUD_NAME: "vite-cloud",
      VITE_CLOUDINARY_UPLOAD_PRESET: "vite-preset",
    });

    expect(config.FIREBASE_PROJECT_ID).toBe("backend-project");
    expect(config.CLOUDINARY_CLOUD_NAME).toBe("backend-cloud");
    expect(config.CLOUDINARY_API_KEY).toBe("backend-key");
    expect(config.CLOUDINARY_API_SECRET).toBe("backend-secret");
    expect(config.CLOUDINARY_UPLOAD_PRESET).toBe("backend-preset");
  });

  it("rejects Cloudinary URLs without credentials", () => {
    expect(() => loadConfig({
      ...requiredEnv(),
      CLOUDINARY_URL: "https://cloud-name",
    })).toThrow("CLOUDINARY_URL");
  });
});
