import { randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { v2 as cloudinary } from "cloudinary";
import type { Auth, DecodedIdToken } from "firebase-admin/auth";
import type { DocumentSnapshot, Firestore, Query } from "firebase-admin/firestore";
import helmet from "helmet";
import type { Logger } from "pino";
import { z } from "zod";
import { parseAdminUids, type Config } from "./config.js";
import { HttpError } from "./errors.js";
import { categoryInputSchema, categoryPatchSchema, customerProfilePatchSchema, orderInputSchema, orderStatusSchema, productInputSchema, productPatchSchema, productStatusSchema, publicIdSchema, trackingSchema } from "./schemas.js";

type Dependencies = {
  config: Config;
  db: Firestore;
  auth: Pick<Auth, "verifyIdToken">;
  logger: Logger;
};

type AuthedRequest = Request & { user?: DecodedIdToken; requestId?: string };
type Product = {
  id: string;
  name: string;
  sku: string;
  description: string;
  shortDescription: string;
  categoryId: string;
  price: number;
  salePrice: number | null;
  stock: number;
  images: Array<{ url: string; publicId: string }>;
  isFeatured: boolean;
  isBestSeller: boolean;
  isTrending: boolean;
  isNewArrival: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
};

const transitions: Record<string, string[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["packed", "cancelled"],
  packed: ["shipped", "cancelled"],
  shipped: ["out_for_delivery", "delivered"],
  out_for_delivery: ["delivered"],
  delivered: ["returned"],
  cancelled: [],
  returned: [],
};

const productQuerySchema = z.object({
  includeInactive: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  categoryId: z.string().min(1).max(128).optional(),
  minPrice: z.coerce.number().finite().nonnegative().optional(),
  maxPrice: z.coerce.number().finite().nonnegative().optional(),
  stock: z.enum(["in_stock", "out_of_stock"]).optional(),
  isFeatured: z.enum(["true", "false"]).optional().transform((value) => value === undefined ? undefined : value === "true"),
  isBestSeller: z.enum(["true", "false"]).optional().transform((value) => value === undefined ? undefined : value === "true"),
  isTrending: z.enum(["true", "false"]).optional().transform((value) => value === undefined ? undefined : value === "true"),
  isNewArrival: z.enum(["true", "false"]).optional().transform((value) => value === undefined ? undefined : value === "true"),
  sort: z.enum(["name", "price", "createdAt", "updatedAt"]).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  cursor: z.string().min(1).max(128).optional(),
  search: z.string().trim().max(120).optional(),
}).strict();

function dateIso(value: unknown): string | null {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

function asMillis(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (value && typeof value === "object" && "toMillis" in value && typeof value.toMillis === "function") {
    const timestamp = value.toMillis();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  return null;
}

function safeProduct(doc: DocumentSnapshot): Product {
  const data = doc.data() ?? {};
  return {
    id: doc.id,
    name: String(data.name ?? ""),
    sku: String(data.sku ?? ""),
    description: String(data.description ?? ""),
    shortDescription: String(data.shortDescription ?? ""),
    categoryId: String(data.categoryId ?? ""),
    price: Number(data.price ?? 0),
    salePrice: data.salePrice == null ? null : Number(data.salePrice),
    stock: Number(data.stock ?? 0),
    images: Array.isArray(data.images) ? data.images : [],
    isFeatured: Boolean(data.isFeatured),
    isBestSeller: Boolean(data.isBestSeller),
    isTrending: Boolean(data.isTrending),
    isNewArrival: Boolean(data.isNewArrival),
    isActive: Boolean(data.isActive),
    createdAt: dateIso(data.createdAt) ?? "",
    updatedAt: dateIso(data.updatedAt) ?? "",
  };
}

function requireInput<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, "VALIDATION_ERROR", "The request contains invalid fields.", result.error.issues);
  return result.data;
}

function phoneDigest(phone: string, secret: string): string {
  return createHmac("sha256", secret).update(phone.replace(/[^\d+]/g, "")).digest("hex");
}

function sameDigest(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function collectionCursor(query: Query, cursor: string | undefined, db: Firestore, collectionName = "products"): Promise<Query> {
  if (!cursor) return Promise.resolve(query);
  return db.collection(collectionName).doc(cursor).get().then((doc) => {
    if (!doc.exists) throw new HttpError(400, "INVALID_CURSOR", "The pagination cursor is invalid.");
    return query.startAfter(doc);
  });
}

function routeId(req: Request): string {
  const id = req.params.id;
  if (!id || typeof id !== "string") throw new HttpError(400, "INVALID_ID", "A valid resource ID is required.");
  return id;
}

export function createApp({ config, db, auth, logger }: Dependencies) {
  const app = express();
  const allowedOrigins = new Set(config.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean));
  const admins = parseAdminUids(config.ADMIN_UIDS);

  // Hosting platforms terminate TLS and forward X-Forwarded-* headers. Trusting
  // one hop makes rate limiting and client-IP logging see the real client.
  const trustProxy = config.TRUST_PROXY.trim();
  if (trustProxy && trustProxy !== "false") {
    app.set(
      "trust proxy",
      /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy === "true" ? true : trustProxy,
    );
  }

  app.disable("x-powered-by");
  app.use(helmet());
  app.use((req: AuthedRequest, res, next) => {
    const suppliedId = req.header("x-request-id");
    req.requestId = suppliedId && /^[A-Za-z0-9._-]{1,100}$/.test(suppliedId) ? suppliedId : randomBytes(16).toString("hex");
    res.setHeader("X-Request-Id", req.requestId);
    next();
  });
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      return callback(new HttpError(403, "CORS_ORIGIN_DENIED", "This origin is not allowed."));
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
  }));
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use((req: AuthedRequest, res, next) => {
    logger.info({ requestId: req.requestId, method: req.method, path: req.path }, "request");
    next();
  });
  app.use(rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({
      success: false,
      error: { code: "RATE_LIMITED", message: "Too many requests. Try again later." },
      requestId: String(res.getHeader("X-Request-Id") ?? "unknown"),
    }),
  }));
  const accountRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({
      success: false,
      error: { code: "RATE_LIMITED", message: "Too many account requests. Try again later." },
      requestId: String(res.getHeader("X-Request-Id") ?? "unknown"),
    }),
  });

  const sendData = (res: Response, data: unknown, meta?: unknown, status = 200) => {
    res.status(status).json(meta === undefined ? { success: true, data } : { success: true, data, meta });
  };

  async function authenticated(req: AuthedRequest, _res: Response, next: NextFunction) {
    try {
      const header = req.header("authorization");
      const match = header?.match(/^Bearer\s+(.+)$/i);
      if (!match) throw new HttpError(401, "UNAUTHENTICATED", "A valid Firebase ID token is required.");
      req.user = await auth.verifyIdToken(match[1]!, true);
      next();
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(401, "UNAUTHENTICATED", "A valid Firebase ID token is required."));
    }
  }

  async function optionallyAuthenticated(req: AuthedRequest, _res: Response, next: NextFunction) {
    if (!req.header("authorization")) return next();
    return authenticated(req, _res, next);
  }

  async function synchronizeCustomer(user: DecodedIdToken, recordLogin = false) {
    const ref = db.collection("customerProfiles").doc(user.uid);
    const now = new Date().toISOString();
    return db.runTransaction(async (transaction) => {
      const current = await transaction.get(ref);
      const currentData = current.data();
      if (current.exists && currentData?.status !== "active") {
        throw new HttpError(403, "ACCOUNT_DISABLED", "This customer account is not active.");
      }

      const tokenEmail = typeof user.email === "string" && user.email.trim() ? user.email.trim() : null;
      const email = user.email_verified === true
        ? tokenEmail
        : typeof currentData?.email === "string" ? currentData.email : null;
      const phoneNumber = currentData && Object.hasOwn(currentData, "phoneNumber")
        ? currentData.phoneNumber
        : typeof user.phone_number === "string" ? user.phone_number : null;
      const emailKey = email ? createHash("sha256").update(email.toLowerCase()).digest("hex") : null;
      const oldEmail = typeof currentData?.email === "string" ? currentData.email : null;
      const oldEmailKey = oldEmail ? createHash("sha256").update(oldEmail.toLowerCase()).digest("hex") : null;
      const emailIndex = emailKey ? db.collection("customerEmailIndex").doc(emailKey) : undefined;
      const oldEmailIndex = oldEmailKey && oldEmailKey !== emailKey
        ? db.collection("customerEmailIndex").doc(oldEmailKey)
        : undefined;
      const [emailOwner, oldEmailOwner] = await Promise.all([
        emailIndex ? transaction.get(emailIndex) : Promise.resolve(undefined),
        oldEmailIndex ? transaction.get(oldEmailIndex) : Promise.resolve(undefined),
      ]);
      if (emailOwner?.exists && emailOwner.get("firebaseUid") !== user.uid) {
        throw new HttpError(409, "EMAIL_ALREADY_IN_USE", "This email address is already associated with another customer.");
      }

      const profile = {
        id: user.uid,
        firebaseUid: user.uid,
        email,
        displayName: typeof currentData?.displayName === "string"
          ? currentData.displayName
          : typeof user.name === "string" ? user.name : "",
        photoURL: typeof currentData?.photoURL === "string"
          ? currentData.photoURL
          : typeof user.picture === "string" ? user.picture : null,
        phoneNumber,
        emailVerified: user.email_verified === true,
        role: "customer",
        status: "active",
        createdAt: currentData?.createdAt ?? now,
        updatedAt: currentData?.updatedAt ?? now,
        lastLoginAt: currentData?.lastLoginAt ?? now,
      };
      const profileChanged = !current.exists || Object.entries(profile).some(([key, value]) =>
        key !== "updatedAt" && key !== "lastLoginAt" && currentData?.[key] !== value,
      );
      const synchronizedProfile = {
        ...profile,
        updatedAt: profileChanged || recordLogin ? now : profile.updatedAt,
        lastLoginAt: recordLogin ? now : profile.lastLoginAt,
      };
      if (profileChanged || recordLogin) {
        transaction.set(ref, synchronizedProfile);
      }
      if (emailIndex && !emailOwner?.exists) transaction.set(emailIndex, { firebaseUid: user.uid, updatedAt: now });
      if (oldEmailIndex && oldEmailOwner?.exists && oldEmailOwner.get("firebaseUid") === user.uid) {
        transaction.delete(oldEmailIndex);
      }
      return { profile: synchronizedProfile, created: !current.exists };
    });
  }

  const customerProfilePatch = async (req: AuthedRequest, patch: z.infer<typeof customerProfilePatchSchema>) => {
    const ref = db.collection("customerProfiles").doc(req.user!.uid);
    await synchronizeCustomer(req.user!);
    const now = new Date().toISOString();
    await db.runTransaction(async (transaction) => {
      const current = await transaction.get(ref);
      if (!current.exists || current.get("status") !== "active") {
        throw new HttpError(403, "ACCOUNT_DISABLED", "This customer account is not active.");
      }
      transaction.update(ref, { ...patch, updatedAt: now });
    });
    return synchronizeCustomer(req.user!);
  };

  function administrator(req: AuthedRequest, _res: Response, next: NextFunction) {
    if (!req.user || !(req.user.admin === true || admins.has(req.user.uid))) {
      logger.warn(
        { requestId: req.requestId, uid: req.user?.uid ?? null },
        "administrator access denied",
      );
      return next(new HttpError(403, "FORBIDDEN", "Administrator access is required."));
    }
    next();
  }

  function adminView(req: AuthedRequest, res: Response, next: NextFunction) {
    if (req.query.includeInactive !== "true" && req.query.admin !== "true") return next();
    authenticated(req, res, (error?: unknown) => error ? next(error) : administrator(req, res, next));
  }

  const adminOnly = [authenticated, administrator];
  const api = express.Router();

  api.post("/auth/sync", accountRateLimit, authenticated, async (req: AuthedRequest, res, next) => {
    try {
      const { profile, created } = await synchronizeCustomer(req.user!, true);
      sendData(res, profile, undefined, created ? 201 : 200);
    } catch (error) { next(error); }
  });
  api.get("/auth/me", accountRateLimit, authenticated, async (req: AuthedRequest, res, next) => {
    try {
      const { profile } = await synchronizeCustomer(req.user!);
      sendData(res, profile);
    } catch (error) { next(error); }
  });
  api.patch("/auth/me", accountRateLimit, authenticated, async (req: AuthedRequest, res, next) => {
    try {
      // Record attempts to write fields that only a trusted server process may
      // change. The strict schema rejects them below; this makes the attempt
      // visible in the existing structured logs.
      const protectedFields = ["role", "admin", "status", "firebaseUid", "email", "uid"];
      const attempted = Object.keys((req.body ?? {}) as Record<string, unknown>).filter((key) =>
        protectedFields.includes(key),
      );
      if (attempted.length > 0) {
        logger.warn(
          { requestId: req.requestId, uid: req.user!.uid, fields: attempted },
          "attempt to modify protected profile fields",
        );
      }
      const patch = requireInput(customerProfilePatchSchema, req.body);
      if (Object.keys(patch).length === 0) throw new HttpError(400, "VALIDATION_ERROR", "Provide at least one profile field.");
      const { profile } = await customerProfilePatch(req, patch);
      sendData(res, profile);
    } catch (error) { next(error); }
  });

  api.get("/products", adminView, async (req, res, next) => {
    try {
      const params = requireInput(productQuerySchema, req.query);
      if (params.minPrice !== undefined && params.maxPrice !== undefined && params.minPrice > params.maxPrice) {
        throw new HttpError(400, "VALIDATION_ERROR", "minPrice must not exceed maxPrice.");
      }
      const includeInactive = params.includeInactive;
      let query: Query = db.collection("products");
      if (!includeInactive) query = query.where("isActive", "==", true);
      if (params.categoryId) query = query.where("categoryId", "==", params.categoryId);
      if (params.minPrice !== undefined) query = query.where("price", ">=", params.minPrice);
      if (params.maxPrice !== undefined) query = query.where("price", "<=", params.maxPrice);
      if (params.stock === "in_stock") query = query.where("stock", ">", 0);
      if (params.stock === "out_of_stock") query = query.where("stock", "==", 0);
      for (const flag of ["isFeatured", "isBestSeller", "isTrending", "isNewArrival"] as const) {
        const value = params[flag];
        if (value !== undefined) query = query.where(flag, "==", value);
      }
      const sort = params.sort;
      const direction = params.order;
      const pageSize = params.limit;
      const search = params.search?.toLocaleLowerCase() ?? "";
      if (search) query = query.where("nameLower", ">=", search).where("nameLower", "<=", `${search}\uf8ff`).orderBy("nameLower");
      query = query.orderBy(sort, direction).orderBy("__name__").limit(pageSize + 1);
      query = await collectionCursor(query, params.cursor, db);
      const snapshot = await query.get();
      const items = snapshot.docs.slice(0, pageSize).map(safeProduct);
      sendData(res, items, { limit: pageSize, nextCursor: snapshot.docs.length > pageSize ? snapshot.docs[pageSize - 1]!.id : null });
    } catch (error) { next(error); }
  });

  api.get("/products/:id", adminView, async (req, res, next) => {
    try {
      const doc = await db.collection("products").doc(routeId(req)).get();
      if (!doc.exists || (!doc.get("isActive") && req.query.admin !== "true" && req.query.includeInactive !== "true")) {
        throw new HttpError(404, "NOT_FOUND", "Product not found.");
      }
      sendData(res, safeProduct(doc));
    } catch (error) { next(error); }
  });
  api.post("/products", ...adminOnly, async (req, res, next) => {
    try {
      const input = requireInput(productInputSchema, req.body);
      if (input.images.some((image) => !image.publicId.startsWith(`${config.CLOUDINARY_ASSET_FOLDER}/`))) {
        throw new HttpError(400, "INVALID_IMAGE", "Images must use the configured product asset folder.");
      }
      const now = new Date().toISOString();
      const ref = db.collection("products").doc();
      await db.runTransaction(async (transaction) => {
        const category = await transaction.get(db.collection("categories").doc(input.categoryId));
        if (!category.exists) throw new HttpError(400, "INVALID_CATEGORY", "The selected category does not exist.");
        transaction.create(ref, { ...input, nameLower: input.name.toLocaleLowerCase(), createdAt: now, updatedAt: now, archivedAt: null });
        if (input.stock > 0) {
          const movement = db.collection("inventoryMovements").doc();
          transaction.create(movement, { productId: ref.id, type: "initial_stock", quantity: input.stock, createdAt: now });
        }
      });
      sendData(res, { id: ref.id, ...input, createdAt: now, updatedAt: now }, undefined, 201);
    } catch (error) { next(error); }
  });
  api.patch("/products/:id", ...adminOnly, async (req, res, next) => {
    try {
      const input = requireInput(productPatchSchema, req.body);
      if (Object.keys(input).length === 0) throw new HttpError(400, "VALIDATION_ERROR", "Provide at least one product field.");
      const ref = db.collection("products").doc(routeId(req));
      await db.runTransaction(async (transaction) => {
        const current = await transaction.get(ref);
        if (!current.exists) throw new HttpError(404, "NOT_FOUND", "Product not found.");
        const category = input.categoryId ? await transaction.get(db.collection("categories").doc(input.categoryId)) : undefined;
        if (category && !category.exists) throw new HttpError(400, "INVALID_CATEGORY", "The selected category does not exist.");
        if (input.images) {
          const allowed = new Set((current.get("images") as Array<{ publicId?: string }> | undefined ?? []).map((image) => image.publicId));
          for (const image of input.images) if (!allowed.has(image.publicId) && !image.publicId.startsWith(`${config.CLOUDINARY_ASSET_FOLDER}/`)) {
            throw new HttpError(400, "INVALID_IMAGE", "Images must use the configured product asset folder.");
          }
        }
        const now = new Date().toISOString();
        transaction.update(ref, { ...input, ...(input.name ? { nameLower: input.name.toLocaleLowerCase() } : {}), updatedAt: now });
        if (input.stock !== undefined && input.stock !== Number(current.get("stock") ?? 0)) {
          const movement = db.collection("inventoryMovements").doc();
          transaction.create(movement, {
            productId: ref.id,
            type: "adjustment",
            quantity: input.stock - Number(current.get("stock") ?? 0),
            createdAt: now,
          });
        }
      });
      const updated = await ref.get();
      sendData(res, { id: updated.id, ...updated.data() });
    } catch (error) { next(error); }
  });
  api.delete("/products/:id", ...adminOnly, async (req, res, next) => {
    try {
      const ref = db.collection("products").doc(routeId(req));
      const current = await ref.get();
      if (!current.exists) throw new HttpError(404, "NOT_FOUND", "Product not found.");
      const now = new Date().toISOString();
      await ref.update({ isActive: false, archivedAt: now, updatedAt: now });
      sendData(res, { id: ref.id, archived: true });
    } catch (error) { next(error); }
  });
  api.patch("/products/:id/status", ...adminOnly, async (req, res, next) => {
    try {
      const body = requireInput(productStatusSchema, req.body);
      const ref = db.collection("products").doc(routeId(req));
      if (!(await ref.get()).exists) throw new HttpError(404, "NOT_FOUND", "Product not found.");
      const now = new Date().toISOString();
      await ref.update({ isActive: body.isActive, archivedAt: body.isActive ? null : now, updatedAt: now });
      sendData(res, { id: ref.id, isActive: body.isActive });
    } catch (error) { next(error); }
  });

  api.get("/categories", adminView, async (req, res, next) => {
    try {
      let query: Query = db.collection("categories");
      if (req.query.includeInactive !== "true") query = query.where("isActive", "==", true);
      const docs = await query.orderBy("displayOrder").limit(200).get();
      sendData(res, docs.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
    } catch (error) { next(error); }
  });
  api.get("/categories/:id", adminView, async (req, res, next) => {
    try {
      const doc = await db.collection("categories").doc(routeId(req)).get();
      if (!doc.exists || (!doc.get("isActive") && req.query.admin !== "true" && req.query.includeInactive !== "true")) throw new HttpError(404, "NOT_FOUND", "Category not found.");
      sendData(res, { id: doc.id, ...doc.data() });
    } catch (error) { next(error); }
  });
  api.post("/categories", ...adminOnly, async (req, res, next) => {
    try {
      const input = requireInput(categoryInputSchema, req.body);
      const ref = db.collection("categories").doc();
      const now = new Date().toISOString();
      await ref.create({ ...input, createdAt: now, updatedAt: now });
      sendData(res, { id: ref.id, ...input, createdAt: now, updatedAt: now }, undefined, 201);
    } catch (error) { next(error); }
  });
  api.patch("/categories/:id", ...adminOnly, async (req, res, next) => {
    try {
      const input = requireInput(categoryPatchSchema, req.body);
      if (Object.keys(input).length === 0) throw new HttpError(400, "VALIDATION_ERROR", "Provide at least one category field.");
      const ref = db.collection("categories").doc(routeId(req));
      if (!(await ref.get()).exists) throw new HttpError(404, "NOT_FOUND", "Category not found.");
      await ref.update({ ...input, updatedAt: new Date().toISOString() });
      sendData(res, { id: ref.id, ...(await ref.get()).data() });
    } catch (error) { next(error); }
  });
  api.delete("/categories/:id", ...adminOnly, async (req, res, next) => {
    try {
      const ref = db.collection("categories").doc(routeId(req));
      await db.runTransaction(async (transaction) => {
        const category = await transaction.get(ref);
        if (!category.exists) throw new HttpError(404, "NOT_FOUND", "Category not found.");
        const referenced = await transaction.get(db.collection("products").where("categoryId", "==", ref.id).limit(1));
        if (!referenced.empty) throw new HttpError(409, "CATEGORY_IN_USE", "This category is still referenced by products.");
        transaction.delete(ref);
      });
      sendData(res, { id: ref.id, deleted: true });
    } catch (error) { next(error); }
  });

  api.post("/orders", optionallyAuthenticated, async (req: AuthedRequest, res, next) => {
    try {
      const input = requireInput(orderInputSchema, req.body);
      if (req.user) await synchronizeCustomer(req.user);
      if (!config.COD_ENABLED) throw new HttpError(400, "PAYMENT_METHOD_DISABLED", "Cash on Delivery is not currently available.");
      const idempotencyKey = req.header("idempotency-key");
      if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
        throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "Provide an Idempotency-Key header between 8 and 128 characters.");
      }
      const idemId = createHash("sha256").update(idempotencyKey).digest("hex");
      const requestHash = createHash("sha256").update(JSON.stringify({ customerUid: req.user?.uid ?? null, input })).digest("hex");
      const orderRef = db.collection("orders").doc();
      const idemRef = db.collection("orderIdempotency").doc(idemId);
      const productRefs = [...new Set(input.items.map((item) => item.productId))].map((id) => db.collection("products").doc(id));
      let response: Record<string, unknown> | undefined;
      let created = false;
      await db.runTransaction(async (transaction) => {
        created = false;
        const existing = await transaction.get(idemRef);
        if (existing.exists) {
          if (existing.get("requestHash") !== requestHash) throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "This idempotency key was already used for a different order.");
          const storedResponse = existing.get("responseData");
          if (!storedResponse || typeof storedResponse !== "object") throw new HttpError(503, "ORDER_RECOVERY_FAILED", "The previous order could not be recovered.");
          response = storedResponse as Record<string, unknown>;
          return;
        }
        const productSnapshots = await Promise.all(productRefs.map((ref) => transaction.get(ref)));
        const byId = new Map(productSnapshots.map((snapshot) => [snapshot.id, snapshot]));
        const quantities = new Map<string, number>();
        for (const item of input.items) quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);
        let subtotal = 0;
        const orderItems = [...quantities.entries()].map(([id, quantity]) => {
          const snapshot = byId.get(id)!;
          if (!snapshot.exists || !snapshot.get("isActive")) throw new HttpError(400, "PRODUCT_UNAVAILABLE", "One or more products are unavailable.");
          const available = Number(snapshot.get("stock") ?? 0);
          if (available < quantity) throw new HttpError(409, "INSUFFICIENT_STOCK", "There is not enough stock for one or more products.");
          const unitPrice = Number(snapshot.get("salePrice") ?? snapshot.get("price"));
          if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new HttpError(503, "INVALID_PRODUCT_PRICE", "A product price is not configured correctly.");
          const productName = String(snapshot.get("name") ?? "");
          subtotal += unitPrice * quantity;
          return { productId: id, name: productName, sku: String(snapshot.get("sku") ?? ""), quantity, unitPrice, lineTotal: unitPrice * quantity };
        });

        let discount = 0;
        let couponRef: FirebaseFirestore.DocumentReference | undefined;
        let couponData: FirebaseFirestore.DocumentData | undefined;
        if (input.couponCode) {
          couponRef = db.collection("coupons").doc(input.couponCode.toUpperCase());
          const coupon = await transaction.get(couponRef);
          if (!coupon.exists) throw new HttpError(400, "INVALID_COUPON", "The coupon is not valid.");
          couponData = coupon.data();
          const now = Date.now();
          const starts = asMillis(couponData?.startsAt);
          const ends = asMillis(couponData?.endsAt);
          if (!couponData?.isActive || (couponData.startsAt != null && starts === null) || (couponData.endsAt != null && ends === null) ||
              (starts !== null && starts > now) || (ends !== null && ends < now) ||
              subtotal < Number(couponData?.minimumSubtotal ?? 0) ||
              (couponData?.usageLimit != null && Number(couponData.usageCount ?? 0) >= Number(couponData.usageLimit))) {
            throw new HttpError(400, "INVALID_COUPON", "The coupon is not valid.");
          }
          const value = Number(couponData.discountValue ?? 0);
          if (!Number.isFinite(value) || value <= 0 || (couponData.discountType !== "percent" && couponData.discountType !== "amount")) {
            throw new HttpError(400, "INVALID_COUPON", "The coupon is not valid.");
          }
          if (couponData.discountType === "percent" && value > 100) throw new HttpError(400, "INVALID_COUPON", "The coupon is not valid.");
          discount = couponData.discountType === "percent" ? subtotal * value / 100 : value;
          if (couponData.maxDiscount != null) discount = Math.min(discount, Number(couponData.maxDiscount));
          discount = Math.min(subtotal, Math.max(0, discount));
        }
        const settings = await transaction.get(db.collection("settings").doc("store"));
        if (settings.get("codEnabled") === false) throw new HttpError(400, "PAYMENT_METHOD_DISABLED", "Cash on Delivery is not currently available.");
        const shippingFee = Number(settings.get("shippingFee") ?? config.DEFAULT_SHIPPING_FEE);
        if (!Number.isFinite(shippingFee) || shippingFee < 0) throw new HttpError(503, "INVALID_SHIPPING_CONFIGURATION", "Shipping is not configured correctly.");
        const total = Math.max(0, subtotal - discount + shippingFee);
        const now = new Date().toISOString();
        const orderNumber = `ZZ-${now.slice(0, 10).replaceAll("-", "")}-${orderRef.id.slice(0, 8).toUpperCase()}`;
        transaction.create(orderRef, {
          orderNumber, customerUid: req.user?.uid ?? null,
          customer: { ...input.customer, phoneDigest: phoneDigest(input.customer.phone, config.ORDER_TRACKING_HMAC_SECRET) },
          items: orderItems, subtotal, discount, shippingFee, total, couponCode: input.couponCode?.toUpperCase() ?? null,
          paymentMethod: "cash_on_delivery", paymentStatus: "unpaid", status: "pending",
          statusHistory: [{ status: "pending", at: now }], inventoryRestored: false, createdAt: now, updatedAt: now,
        });
        for (const [id, quantity] of quantities) {
          const ref = db.collection("products").doc(id);
          const previous = Number(byId.get(id)!.get("stock"));
          transaction.update(ref, { stock: previous - quantity, updatedAt: now });
          const movement = db.collection("inventoryMovements").doc();
          transaction.create(movement, { productId: id, type: "sale", quantity: -quantity, orderId: orderRef.id, createdAt: now });
        }
        if (couponRef && couponData) transaction.update(couponRef, { usageCount: Number(couponData.usageCount ?? 0) + 1 });
        response = { id: orderRef.id, orderNumber, subtotal, discount, shippingFee, total, status: "pending" };
        transaction.create(idemRef, { requestHash, orderId: orderRef.id, responseData: response, createdAt: now });
        created = true;
      });
      sendData(res, response, undefined, created ? 201 : 200);
    } catch (error) { next(error); }
  });

  api.get("/orders/my", authenticated, async (req: AuthedRequest, res, next) => {
    try {
      const profile = await synchronizeCustomer(req.user!);
      const queryParams = z.object({
        limit: z.coerce.number().int().min(1).max(100).default(25),
        cursor: z.string().min(1).max(128).optional(),
      }).strict().parse(req.query);
      let query: Query = db.collection("orders")
        .where("customerUid", "==", profile.profile.firebaseUid)
        .orderBy("createdAt", "desc")
        .orderBy("__name__", "desc")
        .limit(queryParams.limit + 1);
      query = await collectionCursor(query, queryParams.cursor, db, "orders");
      const snapshot = await query.get();
      const items = snapshot.docs.slice(0, queryParams.limit).map((doc) => {
        const data = doc.data();
        const customer = data.customer as Record<string, unknown> | undefined;
        const { phoneDigest: _digest, ...safeCustomer } = customer ?? {};
        return { id: doc.id, ...data, customer: safeCustomer };
      });
      sendData(res, items, {
        limit: queryParams.limit,
        nextCursor: snapshot.docs.length > queryParams.limit ? snapshot.docs[queryParams.limit - 1]!.id : null,
      });
    } catch (error) { next(error); }
  });
  api.get("/orders/my/:id", authenticated, async (req: AuthedRequest, res, next) => {
    try {
      const profile = await synchronizeCustomer(req.user!);
      const doc = await db.collection("orders").doc(routeId(req)).get();
      if (!doc.exists || doc.get("customerUid") !== profile.profile.firebaseUid) {
        throw new HttpError(404, "NOT_FOUND", "Order not found.");
      }
      const data = doc.data() ?? {};
      const customer = data.customer as Record<string, unknown> | undefined;
      const { phoneDigest: _digest, ...safeCustomer } = customer ?? {};
      sendData(res, { id: doc.id, ...data, customer: safeCustomer });
    } catch (error) { next(error); }
  });

  api.get("/orders", ...adminOnly, async (req, res, next) => {
    try {
      const queryParams = z.object({
        limit: z.coerce.number().int().min(1).max(100).default(25),
        cursor: z.string().min(1).max(128).optional(),
      }).strict().parse(req.query);
      const limit = queryParams.limit;
      let query = db.collection("orders").orderBy("createdAt", "desc").orderBy("__name__").limit(limit + 1);
      query = await collectionCursor(query, queryParams.cursor, db, "orders");
      const snapshot = await query.get();
      sendData(res, snapshot.docs.map((doc) => {
        const { customer, ...order } = doc.data();
        const { phoneDigest: _digest, ...safeCustomer } = customer as Record<string, unknown>;
        return { id: doc.id, ...order, customer: safeCustomer };
      }).slice(0, limit), { limit, nextCursor: snapshot.docs.length > limit ? snapshot.docs[limit - 1]!.id : null });
    } catch (error) { next(error); }
  });
  api.get("/orders/:id", ...adminOnly, async (req, res, next) => {
    try {
      const doc = await db.collection("orders").doc(routeId(req)).get();
      if (!doc.exists) throw new HttpError(404, "NOT_FOUND", "Order not found.");
      const { phoneDigest: _digest, ...customer } = doc.get("customer") as Record<string, unknown>;
      sendData(res, { id: doc.id, ...doc.data(), customer });
    } catch (error) { next(error); }
  });
  api.post("/orders/:id/track", async (req, res, next) => {
    try {
      const body = requireInput(trackingSchema, req.body);
      const doc = await db.collection("orders").doc(routeId(req)).get();
      const stored = doc.get("customer.phoneDigest");
      if (!doc.exists || typeof stored !== "string" || !sameDigest(stored, phoneDigest(body.phone, config.ORDER_TRACKING_HMAC_SECRET))) {
        throw new HttpError(404, "ORDER_NOT_FOUND", "Order could not be found.");
      }
      sendData(res, {
        orderNumber: doc.get("orderNumber"),
        status: doc.get("status"),
        statusHistory: doc.get("statusHistory"),
        createdAt: doc.get("createdAt"),
        updatedAt: doc.get("updatedAt"),
      });
    } catch (error) { next(error); }
  });
  api.patch("/orders/:id/status", ...adminOnly, async (req, res, next) => {
    try {
      const { status } = requireInput(orderStatusSchema, req.body);
      const ref = db.collection("orders").doc(routeId(req));
      const result = await db.runTransaction(async (transaction) => {
        const order = await transaction.get(ref);
        if (!order.exists) throw new HttpError(404, "NOT_FOUND", "Order not found.");
        const previous = String(order.get("status"));
        if (!transitions[previous]?.includes(status)) throw new HttpError(409, "INVALID_STATUS_TRANSITION", `Cannot change order status from ${previous} to ${status}.`);
        const now = new Date().toISOString();
        let productSnapshots: FirebaseFirestore.DocumentSnapshot[] = [];
        const items = status === "cancelled" ? order.get("items") as Array<{ productId: string; quantity: number }> : [];
        if (status === "cancelled" && !order.get("inventoryRestored")) {
          productSnapshots = await Promise.all(items.map((item) => transaction.get(db.collection("products").doc(item.productId))));
        }
        if (status === "cancelled") {
          if (!order.get("inventoryRestored")) {
            items.forEach((item, index) => {
              const product = productSnapshots[index]!;
              if (product.exists) transaction.update(product.ref, { stock: Number(product.get("stock") ?? 0) + item.quantity, updatedAt: now });
              const movement = db.collection("inventoryMovements").doc();
              transaction.create(movement, { productId: item.productId, type: "cancellation", quantity: item.quantity, orderId: ref.id, createdAt: now });
            });
          }
        }
        transaction.update(ref, {
          status, updatedAt: now,
          statusHistory: [...(order.get("statusHistory") as unknown[] ?? []), { status, at: now }],
          ...(status === "cancelled" ? { inventoryRestored: true } : {}),
        });
        return { id: ref.id, status };
      });
      sendData(res, result);
    } catch (error) { next(error); }
  });

  api.post("/uploads/signature", ...adminOnly, (_req, res, next) => {
    try {
      requireCloudinary(config);
      const timestamp = Math.floor(Date.now() / 1000);
      const params = { timestamp, folder: config.CLOUDINARY_ASSET_FOLDER, allowed_formats: "jpg,jpeg,png,webp,avif" };
      if (!config.CLOUDINARY_UPLOAD_PRESET) throw new HttpError(503, "UPLOADS_NOT_CONFIGURED", "Image uploads are not configured.");
      const signedParams = { ...params, upload_preset: config.CLOUDINARY_UPLOAD_PRESET };
      const signature = cloudinary.utils.api_sign_request(signedParams, config.CLOUDINARY_API_SECRET!);
      sendData(res, {
        cloudName: config.CLOUDINARY_CLOUD_NAME,
        apiKey: config.CLOUDINARY_API_KEY,
        timestamp,
        folder: config.CLOUDINARY_ASSET_FOLDER,
        uploadPreset: config.CLOUDINARY_UPLOAD_PRESET,
        allowedFormats: ["jpg", "jpeg", "png", "webp", "avif"],
        maxBytes: config.MAX_UPLOAD_BYTES,
        signature,
        uploadUrl: `https://api.cloudinary.com/v1_1/${config.CLOUDINARY_CLOUD_NAME}/image/upload`,
      });
    } catch (error) { next(error); }
  });
  api.delete("/uploads", ...adminOnly, async (req, res, next) => {
    try {
      requireCloudinary(config);
      const body = requireInput(publicIdSchema, req.body);
      if (!body.publicId.startsWith(`${config.CLOUDINARY_ASSET_FOLDER}/`) || body.publicId.includes("//")) {
        throw new HttpError(400, "INVALID_ASSET", "The asset is outside the permitted folder.");
      }
      const products = await db.collection("products").get();
      const inUse = products.docs.some((doc) => (doc.get("images") as Array<{ publicId?: string }> | undefined ?? []).some((image) => image.publicId === body.publicId));
      if (inUse) throw new HttpError(409, "ASSET_IN_USE", "This image is still referenced by a product.");
      const result = await cloudinary.uploader.destroy(body.publicId, { resource_type: "image", invalidate: true });
      if (result.result !== "ok" && result.result !== "not found") throw new HttpError(502, "ASSET_DELETE_FAILED", "Cloudinary could not delete the image.");
      sendData(res, { publicId: body.publicId, deleted: result.result === "ok" });
    } catch (error) { next(error); }
  });

  app.get("/health/live", (_req, res) => sendData(res, { status: "ok" }));
  app.get("/health/ready", async (_req, res, next) => {
    try {
      await db.collection("_health").doc("readiness").get();
      sendData(res, { status: "ready" });
    } catch { next(new HttpError(503, "NOT_READY", "A required service is unavailable.")); }
  });
  app.use("/api/v1", api);
  app.use((_req, _res, next) => next(new HttpError(404, "NOT_FOUND", "The requested endpoint was not found.")));
  app.use((error: unknown, req: AuthedRequest, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const httpError = error instanceof HttpError ? error : undefined;
    if (!httpError) logger.error({ requestId: req.requestId, error }, "request failed");
    const malformedJson = error instanceof SyntaxError && "body" in error;
    const status = httpError?.status ?? (malformedJson ? 400 : 500);
    res.status(status).json({
      success: false,
      error: {
        code: httpError?.code ?? (malformedJson ? "INVALID_JSON" : "INTERNAL_ERROR"),
        message: httpError?.message ?? (malformedJson ? "The request body is not valid JSON." : "An unexpected error occurred."),
        ...(httpError?.details === undefined ? {} : { details: httpError.details }),
      },
      requestId: req.requestId ?? "unknown",
    });
  });
  return app;
}

function requireCloudinary(config: Config) {
  if (!config.CLOUDINARY_CLOUD_NAME || !config.CLOUDINARY_API_KEY || !config.CLOUDINARY_API_SECRET) {
    throw new HttpError(503, "UPLOADS_NOT_CONFIGURED", "Image uploads are not configured.");
  }

  cloudinary.config({ cloud_name: config.CLOUDINARY_CLOUD_NAME, api_key: config.CLOUDINARY_API_KEY, api_secret: config.CLOUDINARY_API_SECRET });
}
