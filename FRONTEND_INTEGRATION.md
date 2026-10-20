# Frontend integration

> **Production integration**
> The Netlify storefront at `https://ahsanapp.netlify.app` calls this API at
> `https://clientbackend2-qu4dpdu9.b4a.run`. The backend allows that origin and
> common local development origins. Administrator access uses Firebase ID
> tokens and the server-side `ADMIN_UIDS` allowlist; local username/password
> admin sessions and admin management for banners, coupons, settings, and audit
> logs are not supported by this backend.

Keep the API host in one configurable frontend variable. The storefront accepts the unprefixed public variable in local `.env` and the deployment platform's build environment:

```env
API_BASE_URL=https://clientbackend-taxt7mcy.b4a.run
```

The backend base URL is an origin; the frontend adds `/api/v1` to API calls. A trailing `/api/v1` is also normalized if supplied. The frontend contains no Firebase Admin credentials, Cloudinary API secret, or order-tracking HMAC secret.

## Public catalog and errors

```ts
const API_BASE_URL = import.meta.env.API_BASE_URL.replace(/\/+$/, "");

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

## Cloudinary image upload

1. Send the selected image bytes to `POST /uploads/product-image` with its image
   MIME type and the Firebase administrator bearer token.
2. The backend checks the administrator identity, accepted content type, and
   configured size limit, then uses the Cloudinary Node SDK and server-side
   credentials to stream the image into the configured asset folder.
3. The API returns `secureUrl` and `publicId`. Keep these values in the product
   form and submit them with product fields to the protected demo-product
   endpoint; the admin dashboard writes demo records to Realtime Database
   `/demoProducts` when the product is saved.
4. Omit `images` from a product patch to preserve current images. To remove an
   image from a product, patch the image array explicitly. Delete a Cloudinary
   asset through `DELETE /uploads` only after it is no longer referenced.

Never send Cloudinary credentials to the browser.

## Saving demo products to Realtime Database

After uploading images, send each Cloudinary HTTPS URL and `publicId` with the product fields to the protected demo-product endpoint. The admin dashboard uses `/demo-products`; the API stores these demo records at `/demoProducts` in Firebase Realtime Database:

```ts
const product = await api("/demo-products", {
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
    images: [{ url: uploadedImage.secureUrl, publicId: uploadedImage.publicId }],
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

Run the backend using `npm run dev` (default API port 8080). Set local frontend
`API_BASE_URL` to the backend origin if it differs from the default. The backend
allows localhost ports 3000, 5173, and 8080 by default. Add any custom frontend
domains to backend `CORS_ORIGINS` as exact origins, comma-separated. Never
include a path or trailing slash in an origin.
