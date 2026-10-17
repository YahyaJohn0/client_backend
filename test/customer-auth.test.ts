import type { Auth, DecodedIdToken } from "firebase-admin/auth";
import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

type StoredDocument = Record<string, unknown>;

class MemorySnapshot {
  readonly exists: boolean;

  constructor(readonly id: string, private readonly value: StoredDocument | undefined) {
    this.exists = value !== undefined;
  }

  data() {
    return this.value ? { ...this.value } : undefined;
  }

  get(field: string): unknown {
    return field.split(".").reduce<unknown>((value, part) =>
      value && typeof value === "object" ? (value as StoredDocument)[part] : undefined, this.value);
  }
}

class MemoryDocument {
  constructor(readonly path: string, private readonly database: MemoryFirestore) {}

  get id() {
    return this.path.split("/").at(-1)!;
  }

  get() {
    return Promise.resolve(this.database.snapshot(this));
  }

  create(value: StoredDocument) {
    this.database.documents.set(this.path, { ...value });
    return Promise.resolve();
  }

  set(value: StoredDocument) {
    this.database.documents.set(this.path, { ...value });
    return Promise.resolve();
  }

  update(value: StoredDocument) {
    const current = this.database.documents.get(this.path) ?? {};
    this.database.documents.set(this.path, { ...current, ...value });
    return Promise.resolve();
  }
}

class MemoryQuery {
  private readonly filters: Array<{ field: string; value: unknown }> = [];
  private readonly ordering: Array<{ field: string; direction: string }> = [];
  private maxResults = Number.POSITIVE_INFINITY;
  private cursor: string | undefined;

  constructor(protected readonly path: string, protected readonly database: MemoryFirestore) {}

  where(field: string, _operator: string, value: unknown) {
    this.filters.push({ field, value });
    return this;
  }

  orderBy(field: string, direction = "asc") {
    this.ordering.push({ field, direction });
    return this;
  }

  limit(value: number) {
    this.maxResults = value;
    return this;
  }

  startAfter(snapshot: MemorySnapshot) {
    this.cursor = snapshot.id;
    return this;
  }

  async get() {
    let docs = [...this.database.documents.entries()]
      .filter(([path]) => path.startsWith(`${this.path}/`) && path.slice(this.path.length + 1).indexOf("/") < 0)
      .map(([path, value]) => new MemorySnapshot(path.slice(this.path.length + 1), value));
    docs = docs.filter((doc) => this.filters.every(({ field, value }) => doc.get(field) === value));
    if (this.cursor) {
      const index = docs.findIndex((doc) => doc.id === this.cursor);
      if (index >= 0) docs = docs.slice(index + 1);
    }
    docs.sort((left, right) => {
      for (const order of this.ordering) {
        const leftValue = left.get(order.field);
        const rightValue = right.get(order.field);
        const comparison = String(leftValue ?? "").localeCompare(String(rightValue ?? ""));
        if (comparison !== 0) return order.direction === "desc" ? -comparison : comparison;
      }
      return left.id.localeCompare(right.id);
    });
    return { docs: docs.slice(0, this.maxResults), empty: docs.length === 0 };
  }
}

class MemoryCollection extends MemoryQuery {
  private nextId = 0;

  doc(id?: string) {
    this.nextId += 1;
    return new MemoryDocument(`${this.path}/${id ?? `generated-${this.nextId}`}`, this.database);
  }
}

class MemoryFirestore {
  readonly documents = new Map<string, StoredDocument>();

  collection(path: string) {
    return new MemoryCollection(path, this);
  }

  snapshot(reference: MemoryDocument) {
    return new MemorySnapshot(reference.id, this.documents.get(reference.path));
  }

  seed(collection: string, id: string, value: StoredDocument) {
    this.documents.set(`${collection}/${id}`, { ...value });
  }

  async runTransaction<T>(operation: (transaction: {
    get: (resource: MemoryDocument | MemoryQuery) => Promise<MemorySnapshot | Awaited<ReturnType<MemoryQuery["get"]>>>;
    set: (reference: MemoryDocument, value: StoredDocument) => void;
    create: (reference: MemoryDocument, value: StoredDocument) => void;
    update: (reference: MemoryDocument, value: StoredDocument) => void;
    delete: (reference: MemoryDocument) => void;
  }) => Promise<T>): Promise<T> {
    return operation({
      get: async (resource) => resource instanceof MemoryQuery ? resource.get() : this.snapshot(resource),
      set: (reference, value) => { this.documents.set(reference.path, { ...value }); },
      create: (reference, value) => { this.documents.set(reference.path, { ...value }); },
      update: (reference, value) => {
        const current = this.documents.get(reference.path) ?? {};
        this.documents.set(reference.path, { ...current, ...value });
      },
      delete: (reference) => { this.documents.delete(reference.path); },
    });
  }
}

function token(uid: string, overrides: Partial<DecodedIdToken> = {}): DecodedIdToken {
  return {
    aud: "test-project",
    auth_time: 1,
    exp: 9999999999,
    iat: 1,
    iss: "https://securetoken.google.com/test-project",
    sub: uid,
    uid,
    user_id: uid,
    email: `${uid}@example.com`,
    email_verified: true,
    phone_number: undefined,
    name: `User ${uid}`,
    picture: undefined,
    firebase: { identities: {}, sign_in_provider: "password" },
    ...overrides,
  };
}

function setup(options: { adminUids?: string } = {}) {
  const database = new MemoryFirestore();
  const users = new Map([
    ["customer-a", token("customer-a")],
    ["customer-b", token("customer-b")],
    ["admin", token("admin", { admin: true })],
    ["allowlisted-admin", token("allowlisted-admin")],
  ]);
  const verifyIdToken = vi.fn(async (idToken: string, checkRevoked?: boolean) => {
    if (checkRevoked !== true || !users.has(idToken)) throw new Error("Invalid token.");
    return users.get(idToken)!;
  });
  const app = createApp({
    config: loadConfig({
      NODE_ENV: "test",
      CORS_ORIGINS: "http://localhost:5173",
      FIREBASE_PROJECT_ID: "test-project",
      ORDER_TRACKING_HMAC_SECRET: "test-secret-that-is-at-least-32-characters",
      ADMIN_UIDS: options.adminUids ?? "",
    }),
    db: database as unknown as FirebaseFirestore.Firestore,
    auth: { verifyIdToken } as unknown as Auth,
    logger: pino({ level: "silent" }),
  });
  return { app, database, verifyIdToken, users };
}

function call(app: ReturnType<typeof setup>["app"], method: string, route: string) {
  const agent = request(app);
  if (method === "get") return agent.get(route);
  if (method === "post") return agent.post(route);
  if (method === "patch") return agent.patch(route);
  if (method === "delete") return agent.delete(route);
  throw new Error(`Unsupported method ${method}`);
}

describe("customer authentication and data ownership", () => {
  it("rejects missing and invalid Firebase ID tokens", async () => {
    const { app } = setup();
    await request(app).get("/api/v1/auth/me").expect(401);
    await request(app).get("/api/v1/auth/me").set("Authorization", "Bearer invalid").expect(401);
  });

  it("creates a profile once and synchronizes repeat sign-ins without role escalation", async () => {
    const { app, database, verifyIdToken } = setup();
    const first = await request(app)
      .post("/api/v1/auth/sync")
      .set("Authorization", "Bearer customer-a")
      .send({ role: "admin" })
      .expect(201);
    const second = await request(app)
      .post("/api/v1/auth/sync")
      .set("Authorization", "Bearer customer-a")
      .expect(200);

    expect(first.body.data.role).toBe("customer");
    expect(second.body.data.firebaseUid).toBe("customer-a");
    expect([...database.documents.keys()].filter((path) => path.startsWith("customerProfiles/"))).toHaveLength(1);
    expect(verifyIdToken).toHaveBeenCalledWith("customer-a", true);
  });

  it("allows only explicit profile fields and rejects mass assignment", async () => {
    const { app } = setup();
    await request(app)
      .patch("/api/v1/auth/me")
      .set("Authorization", "Bearer customer-a")
      .send({ displayName: "Updated Name", phoneNumber: null })
      .expect(200)
      .expect((response) => {
        expect(response.body.data.displayName).toBe("Updated Name");
        expect(response.body.data.phoneNumber).toBeNull();
      });
    await request(app)
      .patch("/api/v1/auth/me")
      .set("Authorization", "Bearer customer-a")
      .send({ role: "admin", firebaseUid: "customer-b" })
      .expect(400);
  });

  it("returns only the authenticated customer's orders and hides foreign order details", async () => {
    const { app, database } = setup();
    database.seed("orders", "order-a", { customerUid: "customer-a", status: "pending", customer: { name: "A", phoneDigest: "private" } });
    database.seed("orders", "order-b", { customerUid: "customer-b", status: "pending", customer: { name: "B", phoneDigest: "private" } });

    const history = await request(app)
      .get("/api/v1/orders/my")
      .set("Authorization", "Bearer customer-a")
      .expect(200);
    expect(history.body.data.map((order: { id: string }) => order.id)).toEqual(["order-a"]);
    expect(history.body.data[0].customer).not.toHaveProperty("phoneDigest");

    await request(app)
      .get("/api/v1/orders/my/order-b")
      .set("Authorization", "Bearer customer-a")
      .expect(404);
    await request(app)
      .get("/api/v1/orders/my/order-a")
      .set("Authorization", "Bearer customer-a")
      .expect(200);
  });

  it("prices authenticated checkout from Firestore and binds ownership to the verified UID", async () => {
    const { app, database } = setup();
    database.seed("products", "product-1", {
      isActive: true,
      name: "Test product",
      sku: "TEST-1",
      price: 50,
      salePrice: 35,
      stock: 3,
    });
    const body = {
      customer: { name: "Customer", phone: "+10000000000", address: "Delivery address", city: "City" },
      items: [{ productId: "product-1", quantity: 2 }],
      paymentMethod: "cash_on_delivery",
    };

    const created = await request(app)
      .post("/api/v1/orders")
      .set("Authorization", "Bearer customer-a")
      .set("Idempotency-Key", "customer-a-checkout-1")
      .send(body)
      .expect(201);
    expect(created.body.data.total).toBe(70);
    expect(database.documents.get("orders/generated-1")?.customerUid).toBe("customer-a");
    expect(database.documents.get("products/product-1")?.stock).toBe(1);

    await request(app)
      .post("/api/v1/orders")
      .set("Authorization", "Bearer customer-b")
      .set("Idempotency-Key", "customer-a-checkout-1")
      .send(body)
      .expect(409);
  });

  it("denies customers from administrator endpoints while accepting a trusted admin claim", async () => {
    const { app } = setup();
    await request(app)
      .get("/api/v1/orders")
      .set("Authorization", "Bearer customer-a")
      .expect(403);
    await request(app)
      .get("/api/v1/orders")
      .set("Authorization", "Bearer admin")
      .expect(200);
  });

  it("enforces unique normalized customer email profiles", async () => {
    const { app, users } = setup();
    users.set("customer-b", token("customer-b", { email: "CUSTOMER-A@example.com" }));
    await request(app).post("/api/v1/auth/sync").set("Authorization", "Bearer customer-a").expect(201);
    await request(app).post("/api/v1/auth/sync").set("Authorization", "Bearer customer-b").expect(409);
  });

  it("does not synchronize an unverified email as the customer's profile email", async () => {
    const { app, database, users } = setup();
    users.set("customer-b", token("customer-b", { email: "pending@example.com", email_verified: false }));
    const pending = await request(app)
      .post("/api/v1/auth/sync")
      .set("Authorization", "Bearer customer-b")
      .expect(201);
    expect(pending.body.data.email).toBeNull();
    expect([...database.documents.keys()].filter((path) => path.startsWith("customerEmailIndex/"))).toHaveLength(0);

    users.set("customer-b", token("customer-b", { email: "pending@example.com", email_verified: true }));
    const verified = await request(app)
      .post("/api/v1/auth/sync")
      .set("Authorization", "Bearer customer-b")
      .expect(200);
    expect(verified.body.data.email).toBe("pending@example.com");
  });
});

describe("administrator authorization", () => {
  const adminRoutes: Array<[string, string]> = [
    ["get", "/api/v1/orders"],
    ["get", "/api/v1/orders/any-order"],
    ["patch", "/api/v1/orders/any-order/status"],
    ["get", "/api/v1/products?includeInactive=true"],
    ["post", "/api/v1/products"],
    ["patch", "/api/v1/products/any-product/status"],
    ["delete", "/api/v1/products/any-product"],
    ["post", "/api/v1/categories"],
    ["patch", "/api/v1/categories/any-category"],
    ["delete", "/api/v1/categories/any-category"],
    ["post", "/api/v1/uploads/signature"],
    ["delete", "/api/v1/uploads"]
  ];

  it("rejects missing, invalid and customer credentials on every protected admin route", async () => {
    const { app } = setup();

    for (const [method, route] of adminRoutes) {
      await call(app, method, route).expect(401);
      await call(app, method, route).set("Authorization", "Bearer invalid").expect(401);
      await call(app, method, route).set("Authorization", "Bearer customer-a").expect(403);
    }
  });

  it("authorizes only a trusted admin claim or the server-side ADMIN_UIDS allowlist", async () => {
    const { app } = setup({ adminUids: "allowlisted-admin" });

    await call(app, "get", "/api/v1/orders").set("Authorization", "Bearer admin").expect(200);
    await call(app, "get", "/api/v1/orders").set("Authorization", "Bearer allowlisted-admin").expect(200);
    await call(app, "get", "/api/v1/orders").set("Authorization", "Bearer customer-a").expect(403);
  });

  it("cannot turn a customer into an administrator through signup or profile fields", async () => {
    const { app, database } = setup({ adminUids: "some-other-admin" });

    await request(app)
      .post("/api/v1/auth/sync")
      .set("Authorization", "Bearer customer-a")
      .send({ role: "admin", admin: true, uid: "admin", firebaseUid: "admin" })
      .expect(201);

    expect(database.documents.get("customerProfiles/customer-a")?.role).toBe("customer");
    await call(app, "get", "/api/v1/orders").set("Authorization", "Bearer customer-a").expect(403);
  });

  it("keeps health and guest checkout public while admin routes stay protected", async () => {
    const { app, database } = setup();
    database.seed("products", "product-1", {
      isActive: true,
      name: "Guest product",
      sku: "GUEST-1",
      price: 50,
      salePrice: null,
      stock: 2
    });

    await request(app).get("/health/live").expect(200);
    await request(app)
      .post("/api/v1/orders")
      .set("Idempotency-Key", "guest-checkout-1")
      .send({
        customer: { name: "Guest", phone: "+10000000000", address: "Delivery address", city: "City" },
        items: [{ productId: "product-1", quantity: 1 }],
        paymentMethod: "cash_on_delivery"
      })
      .expect(201);

    await call(app, "get", "/api/v1/orders").expect(401);
  });
});
