# Zamzam API

Standalone TypeScript/Express API using Firebase Admin and Cloud Firestore. This workspace was empty when implementation began, so no existing Zamzam frontend contract, `.env`, schema, database provider, Git repository, or lockfile could be inspected. Firestore is the chosen default from the supplied technology stack; confirm that it matches the production Firebase project before deployment.

## Requirements

- Node.js 22 or later (required by the current Firebase Admin SDK)
- A Firebase project with Cloud Firestore and Firebase Authentication enabled
- A Cloudinary account for the optional image endpoints

## Setup

```powershell
npm install
```

Set the required variables in `.env` or in the hosting platform:

| Variable | Required | Purpose |
| --- | --- | --- |
| `NODE_ENV` | No | `development`, `test`, or `production` |
| `PORT` | No | HTTP listen port  |
| `LOG_LEVEL` 
| `CORS_ORIGINS` | No | Additional comma-separated browser origins. Wildcard CORS is enabled by default for this API; set an explicit allowlist in code if the deployment should restrict browser origins. |
| `TRUST_PROXY` | No | Reverse-proxy hops to trust for client IP/HTTPS detection (default `1`; set `false` if exposed directly) |
| `FIREBASE_PROJECT_ID` | Yes | Public Firebase project ID used by the backend |
| `FIREBASE_DATABASE_URL` | Yes | Firebase Realtime Database URL for admin demo products |
| `FIREBASE_SERVICE_ACCOUNT` | One credential source | Entire service-account JSON stored as a hosting secret; use Application Default Credentials only on hosts that provide workload identity |
| `ADMIN_UIDS` | No | Comma-separated Firebase Auth UIDs assigned administrator access by the trusted operator |
| `CLOUDINARY_URL` | For uploads | Private server-side Cloudinary credential URL; never put it in browser config or documentation |
| `CLOUDINARY_CLOUD_NAME` | For uploads | Public Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | For uploads | Cloudinary API key; otherwise read from `CLOUDINARY_URL` |
| `CLOUDINARY_API_SECRET` | For uploads | Cloudinary API secret; otherwise read from `CLOUDINARY_URL`; server-side only |
| `CLOUDINARY_UPLOAD_PRESET` | For uploads | Preset identifier (default `zamzam`); Cloudinary API credentials stay on the backend |
| `CLOUDINARY_ASSET_FOLDER` | No | Restricts product assets (default `samples/ecommerce`) |
| `MAX_UPLOAD_BYTES` | No | Maximum upload size returned to clients (default 5 MiB; configure the Cloudinary signed-upload preset to enforce it) |
| `COD_ENABLED` | No | Enable guest Cash on Delivery checkout (default `true`) |
| `DEFAULT_SHIPPING_FEE` | No | Fallback shipping fee when no store setting is present |
| `ORDER_TRACKING_HMAC_SECRET` | Yes | Random secret of at least 32 characters used to protect guest order lookup |

For local development, keep settings in an ignored `.env` file. Add Firebase Admin credentials through `FIREBASE_SERVICE_ACCOUNT` as a protected secret; never put the credential JSON in a tracked file.

Firebase credentials must never be put in frontend variables or committed. The server uses `FIREBASE_SERVICE_ACCOUNT` when set; otherwise it uses Application Default Credentials.

The backend loads a local `.env` file at startup when present. It deliberately does not read `VITE_*` variables: those belong to browser builds and must not be used for server credentials. The Firebase project ID and Realtime Database URL are public configuration, but Firebase Admin still needs a service account or Application Default Credentials with Firebase access. Keep `CLOUDINARY_URL` and all private Cloudinary credentials in the backend environment only.

## Run and verify

```powershell
npm run dev
npm run typecheck
npm test
npm run build
npm start
```

`GET /health/live` checks process liveness. `GET /health/ready` performs a Firestore read and returns only a generic readiness response. Firestore composite indexes may be required for combinations of catalog filters; create the indexes requested by Firebase for the selected production query patterns before launch.

## Docker

Build the image from the `client_backend/` directory:

```powershell
docker build -t zamzam-backend .
```

Run it with the required application settings supplied through the container environment:

```powershell
docker run --rm -p 8080:8080 --env-file .env zamzam-backend
```

The image does not include `.env` or service-account files. For Firebase authentication, supply `FIREBASE_SERVICE_ACCOUNT` as a protected environment secret. Do not copy credentials into the image. Set `PORT` to the port assigned by your container host.

### Back4App Containers

Create the Back4App Container from the Git repository and branch containing this `Dockerfile`. Set the repository root directory to the directory containing `Dockerfile` and `package.json`. The image listens on `0.0.0.0` using `PORT` (default `8080`); configure the container's web port as `8080`, or set `PORT` to the port configured for the container.

Add these variables in the Back4App container's Environment Variables settings before deploying:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `PORT` | `8080` (unless Back4App specifies a different container port) |
| `CORS_ORIGINS` | Optional extra exact origins. `https://ahsanapp.netlify.app` is included by default; add any custom storefront or preview domains here. |
| `FIREBASE_PROJECT_ID` | Firebase project ID |
| `FIREBASE_SERVICE_ACCOUNT` | Complete Firebase service-account JSON as a protected variable; do not upload it into the image or commit it |
| `ORDER_TRACKING_HMAC_SECRET` | Random secret of at least 32 characters |

Generate an HMAC secret locally with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` and paste its output into Back4App. `ADMIN_UIDS` and Cloudinary settings are only needed when using those features. Keep the Firebase service account and HMAC secret out of build arguments and source control.

After deployment, check `https://<your-container-domain>/health/live`. A process-start error naming `FIREBASE_PROJECT_ID` or `ORDER_TRACKING_HMAC_SECRET` means the corresponding Back4App environment variable is missing or empty. `/health/ready` additionally requires Firestore connectivity.

For this storefront, the backend listens on the platform-provided `PORT` (Back4App normally uses `8080`); `PORT` is the backend container port, not a browser URL. The frontend is served separately by Netlify and uses `https://clientbackend-taxt7mcy.b4a.run` as its API origin. Wildcard CORS is enabled by default without credentialed cookies; protected API routes must continue to enforce Firebase authorization independently of CORS.

## Vercel

This repository deploys the Express API as a Vercel Node.js Function. In Vercel, import the backend repository and set its Root Directory to the directory containing this `package.json` (for a backend-only repository, leave it at `./`). Vercel uses `vercel.json` to build the TypeScript app and route requests to `api/[...path].js`.

Add the required variables from the table above in the Vercel project's Settings > Environment Variables for each deployment environment. `FIREBASE_SERVICE_ACCOUNT` must contain the complete service-account JSON; enter it as a protected environment variable and never commit the credential file. Do not set `PORT` on Vercel; the platform manages the function runtime. Deploy after saving the environment variables.

The API routes remain `/api/v1/...`; `/health/live` and `/health/ready` are routed through the function as well. Authenticated admins upload images through `POST /api/v1/uploads/product-image`. The backend validates the image content type and size, streams the bytes to Cloudinary using its server-side credentials, and returns the HTTPS URL and public ID. Cloudinary credentials never reach the browser.

## API

The versioned API prefix is `/api/v1`. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors include a stable `error.code`, safe `error.message`, and `requestId`. See [`openapi.yaml`](./openapi.yaml) for the API schema and [`FRONTEND_INTEGRATION.md`](./FRONTEND_INTEGRATION.md) for client examples.

### Implemented routes

- `GET /health/live`, `GET /health/ready`
- Public store data: `GET /api/v1/settings`, `GET /api/v1/banners`, `POST /api/v1/coupons/validate`
- Customer accounts: `POST /api/v1/auth/sync`, `GET /api/v1/auth/me`, `PATCH /api/v1/auth/me`; admin identity: `GET /api/v1/auth/admin/me`
- Products: `GET /api/v1/products`, `GET /api/v1/products/:id`, `POST /api/v1/products`, `PATCH /api/v1/products/:id`, `DELETE /api/v1/products/:id` (archives), `PATCH /api/v1/products/:id/status`
- Categories: `GET /api/v1/categories`, `GET /api/v1/categories/:id`, `POST /api/v1/categories`, `PATCH /api/v1/categories/:id`, `DELETE /api/v1/categories/:id`
- Images: `POST /api/v1/uploads/product-image`, `DELETE /api/v1/uploads`
- Admin demo products in Realtime Database `/demoProducts`: `GET /api/v1/demo-products`, `GET /api/v1/demo-products/:id`, `POST /api/v1/demo-products`, `PATCH /api/v1/demo-products/:id`, `DELETE /api/v1/demo-products/:id` (archives), `PATCH /api/v1/demo-products/:id/status`
- Orders: `POST /api/v1/orders` (guest-compatible; optionally authenticated), `GET /api/v1/orders/my`, `GET /api/v1/orders/my/:id`, `POST /api/v1/orders/:id/track`
- Admin orders: `GET /api/v1/orders`, `GET /api/v1/orders/:id`, `PATCH /api/v1/orders/:id/status`

Protected endpoints require `Authorization: Bearer <Firebase ID token>` and either a trusted `admin: true` Firebase custom claim or a UID in the server-side `ADMIN_UIDS` allowlist. `includeInactive=true` catalog queries also require an administrator. Never accept a browser-supplied role.

Denied administrator requests and attempts to write protected customer-profile fields (`role`, `admin`, `status`, `firebaseUid`, `email`, `uid`) are logged through the existing pino logger with the request id and UID. Passwords, ID tokens and private keys are never logged.

## Data and operational notes

Firestore collections used by this API: `products`, `categories`, `customerProfiles`, `customerEmailIndex`, `orders`, `orderIdempotency`, `coupons`, `inventoryMovements`, and `settings/store`. Product documents have a server-generated `nameLower` search field. Product deletion is archival to preserve historical order records. Order placement and inventory deductions are committed in one Firestore transaction; a client-generated `Idempotency-Key` is mandatory. Authenticated order documents store the verified `customerUid`; guest orders store `null`. Customer order routes filter and check that UID server-side. The customer order history query requires a Firestore composite index for `customerUid` ascending and `createdAt` descending (with document name descending); deploy the corresponding index before enabling customer order history in production. Coupon validation during checkout expects an active coupon document keyed by uppercase code with `discountType` (`percent` or `amount`), `discountValue`, optional `minimumSubtotal`, `maxDiscount`, `usageLimit`, `usageCount`, `startsAt`, and `endsAt`.

Customer profiles are stored at `customerProfiles/{firebaseUid}` and synchronized from verified Firebase tokens. A hashed `customerEmailIndex` prevents two profiles claiming the same normalized email. Profile writes only allow `displayName` and `phoneNumber`; email changes must be performed in Firebase Authentication and are synchronized from the next verified token. The profile's role is always `customer`; administrator access is independently derived only from a trusted Firebase `admin: true` custom claim or the server-side `ADMIN_UIDS` allowlist.

Firebase Authentication handles email/password and Google sign-in, password resets, email verification, and client logout. After sign-in, the frontend calls `/auth/sync` or `/auth/me` with the current Firebase ID token. No backend password, custom JWT, refresh-token session, or logout endpoint is used. Firebase client `signOut` ends the frontend session; it does not revoke a previously issued ID token, which the backend validates with revocation checks. For security incidents, an administrator must revoke the user's Firebase refresh tokens through a trusted operational process. Profile disabling is operator-managed in Firestore (`status: "disabled"`); profiles are not publicly deleted and order history is retained.

In Firebase Console, enable Email/Password and Google under Authentication providers, configure the production authorized domains, and create Firestore with the backend service identity. Firestore access from the frontend must not bypass API ownership checks: deny direct client reads/writes to `customerProfiles`, `customerEmailIndex`, and `orders` unless separately protected rules are designed and reviewed. Existing guest orders are not automatically assigned to Firebase users; only newly submitted authenticated orders appear in `/orders/my`.

No backend-persisted cart exists. Until a cart API and product/stock synchronization requirements are agreed, the frontend must manage its cart and submit product IDs and quantities at checkout; the backend ignores client prices and revalidates availability and stock transactionally.

Creating a product in the admin panel stores its validated fields in Firebase Realtime Database at `/demoProducts/{id}`. Image URLs are saved in `images`, `imageMetadata`, and `imageUrl`; product image metadata contains the Cloudinary `secure_url` and public ID. These admin-only demo products are separate from the Firestore `products` collection used for checkout inventory. The referenced category is stored as a category ID but is not copied into Firestore.

Guest tracking requires the order document ID and the matching phone number, returns only order number/status/timestamps/status history, and stores a keyed HMAC rather than a second tracking copy of the phone. Admin order views retain customer delivery details.

Only cancellation automatically restores stock; a return is a fulfillment state and does not automatically restock. This avoids treating an uninspected return as sellable inventory. Product status changes are not a substitute for a stock movement.

Cloudinary image uploads are performed by the authenticated backend with the configured preset, asset folder, format allowlist, and `MAX_UPLOAD_BYTES` request limit. The API never returns Cloudinary credentials. Product URLs and Cloudinary `publicId` values are written to `/demoProducts` when the admin saves the product. Asset deletion is refused while a product references the `publicId`.

No existing banners, store settings management, coupon administration, exports, reports, audit-log, or manual inventory workflow was present to extend. Coupon use and checkout shipping settings are supported, but those additional admin-management/reporting APIs are not implemented in this standalone baseline.

## Administrator bootstrap

Have a trusted project operator obtain the target user's Firebase Auth UID out of band, then set that exact UID in the hosting platform's `ADMIN_UIDS` secret/config and restart or redeploy the service. The list is an authoritative server-side allowlist; it is never controlled by the browser. For larger teams, replace it with a trusted custom-claims provisioning workflow. This API intentionally has no public admin bootstrap endpoint.

## Maintenance scripts

Two Node scripts under [`scripts/`](./scripts) talk to Firebase with the service account directly, which makes them usable for diagnostics before the API itself is deployed:

- `node scripts/firebase-selftest.mjs` — reports clock skew, mints an OAuth token, lists Firestore databases and Storage buckets, and reads the `products` collection. Set `FIREBASE_PROJECT_ID` and `FIREBASE_SERVICE_ACCOUNT` (or `FIREBASE_SERVICE_ACCOUNT_PATH`) first.
- `node scripts/push-store-to-firestore.mjs [--all] [--dry-run]` — mirrors `../client_frontend/data/store.json` into the default Firestore database (products by default; add `--all` for categories, banners and settings).

Prerequisites:

1. **Sync the machine clock.** Google rejects signed requests whose `iat` is in the future. Run `w32tm /resync` from an elevated prompt (or Settings → Time & language → Sync now). The scripts compensate by using Google's own time, but the app's Firebase calls cannot.
2. **Create the default Firestore database in Native mode** in the configured Firebase project's console. A database created with an explicit id (for example `default`) or one whose data access mode is disabled cannot be used by the Firebase SDKs.

## Deployment

Deploy the Node.js service to a platform that supports Node 22+, environment secrets, outbound Firebase/Cloudinary calls, and HTTPS termination. Run `npm ci`, `npm run build`, then `npm start`. Provide Firebase credentials through workload identity/ADC or a protected hosting secret, set exact production `CORS_ORIGINS`, set `TRUST_PROXY=1` behind the platform proxy, configure the Firebase project and Firestore indexes, provide Cloudinary credentials if uploads are enabled, and set a unique random `ORDER_TRACKING_HMAC_SECRET`. Confirm that backups, billing limits, retention, monitoring, and deployment health checks are configured by the operator. No deployment has been performed.

## Limitations to resolve before production

- Confirm Firestore is the intended database; no existing project files were available to verify it.
- Add the intended frontend's actual response/field conventions once its source is available.
- Configure and test Firestore composite indexes for real catalog query combinations.
- Set Cloudinary's upload-size restrictions to match `MAX_UPLOAD_BYTES`.
- Decide whether to add coupon/banner/settings administration, audit logs, inventory adjustments, reports, and exports; there was no existing implementation/schema in this workspace.
- Run tests/build in the target deployment environment and test against a non-production Firebase project before release.
