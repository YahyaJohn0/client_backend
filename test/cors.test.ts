import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createCorsMiddleware, parseCorsOrigins } from "../src/cors.js";

describe("API CORS configuration", () => {
  it("allows the production storefront and common local frontend ports", () => {
    const origins = parseCorsOrigins("");
    expect(origins.has("https://ahsanapp.netlify.app")).toBe(true);
    expect(origins.has("http://localhost:5173")).toBe(true);
    expect(origins.has("http://localhost:8080")).toBe(true);
  });

  it("accepts configured origins and excludes unconfigured origins", () => {
    const origins = parseCorsOrigins(" https://preview.example.com, ,https://admin.example.com ");
    expect(origins.has("https://preview.example.com")).toBe(true);
    expect(origins.has("https://admin.example.com")).toBe(true);
    expect(origins.has("https://attacker.example")).toBe(false);
  });

  it("answers cross-origin preflight for authenticated and idempotent API requests", async () => {
    const app = express();
    app.use(createCorsMiddleware("https://ahsanapp.netlify.app"));
    app.post("/api/v1/orders", (_req, res) => res.sendStatus(201));
    app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(403).json({ error: error.message });
    });

    const response = await request(app)
      .options("/api/v1/orders")
      .set("Origin", "https://ahsanapp.netlify.app")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "authorization,content-type,idempotency-key");

    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("https://ahsanapp.netlify.app");
    expect(response.headers["access-control-allow-methods"]).toContain("POST");
    const allowedHeaders = String(response.headers["access-control-allow-headers"]).toLowerCase();
    expect(allowedHeaders).toContain("authorization");
    expect(allowedHeaders).toContain("idempotency-key");
  });

  it("does not grant CORS access to unlisted origins", async () => {
    const app = express();
    app.use(createCorsMiddleware(""));
    app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
    app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(403).json({ error: error.message });
    });

    const response = await request(app)
      .get("/health/live")
      .set("Origin", "https://attacker.example");

    expect(response.status).toBe(403);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
