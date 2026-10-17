# Frontend integration

> **Which API am I talking to?**
> The app in `../client_frontend` runs with its own bundled Express server
> (`client_frontend/server.ts`) on port 3000, which serves the storefront and a
> `/api` + `/api/v1` API from the same origin. This document describes the
> optional standalone Firebase API in this directory. A frontend can be pointed
> at it with `VITE_API_BASE_URL`, but note that this API has no
> `POST /api/admin/login` (administrator access is derived from a Firebase ID
> token plus the `ADMIN_UIDS` allowlist) and no banner/coupon-admin/settings
> management endpoints.

Keep the API host in one configurable frontend variable. For a Vite frontend, use a local `.env` and the deployment platform's equivalent setting:

```env
VITE_API_BASE_URL=https://your-deployed-api.example.com/api/v1
```

The value above is a placeholder. For local use, configure the backend URL with `/api/v1` included. The frontend contains no Firebase Admin credentials, Cloudinary API secret, or order-tracking HMAC secret. A trailing `/api/v1` is normalized by the storefront client, so both the bare origin and the versioned form work.

## Public catalog and errors

```ts
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL.replace(/\/+$/, "");

type ApiSuccess<T> = { success: true; data: T; meta?: Record<string, unknown> };
type ApiFailure = {
  success: false;
  error: { code: string; message: string; details?: unknown };
  requestId: string;
};

async function api<T>(path: string, init: RequestInit = {}): Promise<ApiSuccess<T>> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  const body = await response.json() as ApiSuccess<T> | ApiFailure;
  if (!response.ok || !body.success) {
    const failure = body as ApiFailure;
    throw new Error(`${failure.error.code}: ${failure.error.message} (request ${failure.requestId})`);
  }
  return body;
}

const products = await api<unknown[]>("/products?limit=24&sort=createdAt&order=desc");
```

Catalog filters include `search` (name prefix), `categoryId`, `minPrice`, `maxPrice`, `stock=in_stock|out_of_stock`, and `isFeatured=true`, `isBestSeller=true`, `isTrending=true`, `isNewArrival=true`. Pagination uses the `meta.nextCursor` value as the next request's `cursor`. `includeInactive=true` is administrator-only.

## Firebase administrator requests

Sign in using the frontend Firebase client SDK and send its current Firebase ID token only to protected API routes:

```ts
const token = await firebaseUser.getIdToken();
const result = await api<unknown>("/products", {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
  body: JSON.stringify(productInput),
});
```

The token proves identity, not administrator status. The backend checks a trusted Firebase custom claim or server-side `ADMIN_UIDS` allowlist. Do not send a role field as an authorization mechanism.

## Customer authentication and profile

Email/password signup, Google sign-in, password reset, and frontend logout are handled by the Firebase client SDK. After sign-in, send the Firebase ID token to the backend to synchronize or retrieve only the signed-in user's profile:

```ts
const token = await firebaseUser.getIdToken();
const profile = await api("/auth/sync", {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
});
```

`GET /auth/me` also returns the current profile and creates it on a customer's first authenticated request. `PATCH /auth/me` accepts only `displayName` and `phoneNumber`; email, role, UID, and account status cannot be changed through this endpoint. Update email through Firebase Authentication and call `/auth/sync` to synchronize its verified token claim. There is no backend logout endpoint: call Firebase `signOut` and clear customer-specific frontend state. This does not revoke an already issued ID token.

## Customer order history

Checkout remains compatible with guests. If a signed-in customer includes a Firebase ID token on `POST /orders`, the API associates the order with the verified UID; it never accepts an owner UID from the request body. The authenticated history endpoints return only that UID's orders:

```ts
const token = await firebaseUser.getIdToken();
const orders = await api("/orders/my", {
  headers: { Authorization: `Bearer ${token}` },
});
```

Fetch a single owned order with `GET /orders/my/{orderId}`. An order owned by another customer is returned as `404`. The API currently has no persistent cart; keep cart state in the frontend and submit product IDs and quantities at checkout. The backend reloads prices and stock and calculates totals itself.

## Signed image upload

1. Request `POST /uploads/signature` with the Firebase bearer token.
2. Upload the file directly to the returned `uploadUrl` using multipart form fields `file`, `api_key`, `timestamp`, `folder`, `allowed_formats`, `upload_preset`, and `signature`.
3. Check the file size against returned `maxBytes` before sending; Cloudinary must also enforce the same limit in its upload preset.
4. Save the returned Cloudinary `secure_url` and actual `public_id` as `{ url, publicId }` in a product's `images` array.
5. Omit `images` from a product patch to preserve all current images. To remove an image from a product, patch its image array explicitly. Delete a Cloudinary asset through `DELETE /uploads` only after it is no longer referenced.

Never send the Cloudinary API secret to the browser.

## Creating products

After uploading images, send their Cloudinary URL and `publicId` along with the rest of the product fields to the protected product endpoint. The API validates the category and image folder, then saves the product document in Firestore's `products` collection:

```ts
const product = await api("/products", {
  method: "POST",
  headers: { Authorization: `****** },
  body: JSON.stringify({
    name: "Example product",
    sku: "EXAMPLE-001",
    description: "Product details",
    shortDescription: "Short details",
    categoryId: "existing-category-id",
    price: 25,
    salePrice: null,
    stock: 10,
    images: [{ url: uploadedImage.secure_url, publicId: uploadedImage.public_id }],
    isFeatured: false,
    isBestSeller: false,
    isTrending: false,
    isNewArrival: true,
    isActive: true,
  }),
});
```

## Guest checkout and tracking

Create an unpredictable idempotency key per user-initiated checkout attempt and reuse the same key only when retrying that same request:

```ts
const response = await api<{ id: string; orderNumber: string; total: number; status: string }>("/orders", {
  method: "POST",
  headers: { "Idempotency-Key": crypto.randomUUID() },
  body: JSON.stringify({
    customer: { name: "Customer", phone: "+10000000000", address: "Delivery address", city: "City" },
    items: [{ productId: "server-product-id", quantity: 1 }],
    paymentMethod: "cash_on_delivery",
  }),
});
```

Do not send product prices, shipping fees, discounts, or totals as trusted values: the backend loads catalog data and computes them. Save the returned order `id` for tracking. Track it with both that identifier and the matching customer phone:

```ts
const tracking = await api("/orders/ORDER_ID/track", {
  method: "POST",
  body: JSON.stringify({ phone: "+10000000000" }),
});
```

Tracking intentionally returns status information only, not the address, phone, or complete order contents.

## Local development

Run the backend using `npm run dev`, configure the frontend's local `VITE_API_BASE_URL`, and set the backend's `CORS_ORIGINS` to the exact local frontend origin (for example `http://localhost:5173`). For production, configure the exact HTTPS frontend origin in the backend hosting environment and set the API base URL in the frontend's deployment environment.
