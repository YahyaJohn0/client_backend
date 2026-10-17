# Zamzam API

Standalone TypeScript/Express API using Firebase Admin and Cloud Firestore. This workspace was empty when implementation began, so no existing Zamzam frontend contract, `.env`, schema, database provider, Git repository, or lockfile could be inspected. Firestore is the chosen default from the supplied technology stack; confirm that it matches the production Firebase project before deployment.

## Requirements

- Node.js 22 or later (required by the current Firebase Admin SDK)
- A Firebase project with Cloud Firestore and Firebase Authentication enabled
- A Cloudinary account for the optional image endpoints

## Setup

```powershell
npm install
Copy-Item .env.example .env
```

Set the required variables in `.env` or in the hosting platform:

| Variable | Required | Purpose |
| --- | --- | --- |
| `NODE_ENV` | No | `development`, `test`, or `production` |
| `PORT` | No | HTTP listen port (default `8080`) |
| `LOG_LEVEL` | No | Structured log level |
| `CORS_ORIGINS` | Yes | Comma-separated exact browser origins; no wildcard is accepted as a configuration default |
| `TRUST_PROXY` | No | Reverse-proxy hops to trust for client IP/HTTPS detection (default `1`; set `false` if exposed directly) |
| `FIREBASE_PROJECT_ID` | Yes | Public Firebase project ID used by the backend |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | One credential source | Service account JSON stored as a hosting secret |
| `GOOGLE_APPLICATION_CREDENTIALS` | One credential source | Path to a protected service-account file; alternatively use workload identity / Application Default Credentials |
| `ADMIN_UIDS` | No | Comma-separated Firebase Auth UIDs assigned administrator access by the trusted operator |
| `CLOUDINARY_URL` | For uploads | Private server-side Cloudinary credential URL; never put it in browser config or documentation |
| `CLOUDINARY_CLOUD_NAME` | For uploads | Public Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | For uploads | Cloudinary API key; otherwise read from `CLOUDINARY_URL` |
| `CLOUDINARY_API_SECRET` | For uploads | Cloudinary API secret; otherwise read from `CLOUDINARY_URL`; server-side only |
| `CLOUDINARY_UPLOAD_PRESET` | For signed uploads | Public preset identifier; uploads are signed server-side with `CLOUDINARY_API_SECRET` |
| `CLOUDINARY_ASSET_FOLDER` | No | Restricts product assets (default `zamzam/products`) |
| `MAX_UPLOAD_BYTES` | No | Maximum upload size returned to clients (default 5 MiB; configure the Cloudinary signed-upload preset to enforce it) |
| `COD_ENABLED` | No | Enable guest Cash on Delivery checkout (default `true`) |
| `DEFAULT_SHIPPING_FEE` | No | Fallback shipping fee when no store setting is present |
| `ORDER_TRACKING_HMAC_SECRET` | Yes | Random secret of at least 32 characters used to protect guest order lookup |

Copy `.env.example` to `.env` as a starting point. Add Firebase Admin credentials through a protected local file path or hosting secret; neither credential value belongs in the example file.

Firebase credentials must never be put in frontend variables, committed, or written into `.env.example`. The server uses `FIREBASE_SERVICE_ACCOUNT_JSON` when set; otherwise it uses Application Default Credentials. On local Windows development, protect the service-account file and set `GOOGLE_APPLICATION_CREDENTIALS` to its absolute path. Do not check it into source control.

The backend loads a local `.env` file at startup when present. It deliberately does not read `VITE_*` variables: those belong to browser builds and must not be used for server credentials. The Firebase project ID is public, but Firebase Admin still needs a service account or Application Default Credentials with Firestore access. Keep `CLOUDINARY_URL` and all private Cloudinary credentials in the backend environment only.

## Run and verify

```powershell
npm run dev
npm run typecheck
npm test
npm run build
npm start
```

`GET /health/live` checks process liveness. `GET /health/ready` performs a Firestore read and returns only a generic readiness response. Firestore composite indexes may be required for combinations of catalog filters; create the indexes requested by Firebase for the selected production query patterns before launch.

## API

The versioned API prefix is `/api/v1`. Success responses are `{ "success": true, "data": ..., "meta": ... }`; errors include a stable `error.code`, safe `error.message`, and `requestId`. See [`openapi.yaml`](./openapi.yaml) for the API schema and [`FRONTEND_INTEGRATION.md`](./FRONTEND_INTEGRATION.md) for client examples.

### Implemented routes

- `GET /health/live`, `GET /health/ready`
- Customer accounts: `POST /api/v1/auth/sync`, `GET /api/v1/auth/me`, `PATCH /api/v1/auth/me`
- Products: `GET /api/v1/products`, `GET /api/v1/products/:id`, `POST /api/v1/products`, `PATCH /api/v1/products/:id`, `DELETE /api/v1/products/:id` (archives), `PATCH /api/v1/products/:id/status`
- Categories: `GET /api/v1/categories`, `GET /api/v1/categories/:id`, `POST /api/v1/categories`, `PATCH /api/v1/categories/:id`, `DELETE /api/v1/categories/:id`
- Images: `POST /api/v1/uploads/signature`, `DELETE /api/v1/uploads`
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

Creating a product with `POST /api/v1/products` stores its validated product fields, including each Cloudinary image's `url` and `publicId`, in the Firestore `products` collection. The referenced category must already exist.

Guest tracking requires the order document ID and the matching phone number, returns only order number/status/timestamps/status history, and stores a keyed HMAC rather than a second tracking copy of the phone. Admin order views retain customer delivery details.

Only cancellation automatically restores stock; a return is a fulfillment state and does not automatically restock. This avoids treating an uninspected return as sellable inventory. Product status changes are not a substitute for a stock movement.

Cloudinary upload signatures constrain asset folder, preset, and formats. Configure the Cloudinary signed upload preset to enforce `MAX_UPLOAD_BYTES` in the Cloudinary account: the returned size value is also suitable for client-side preflight but is not a trusted security boundary by itself. The API never returns the Cloudinary secret. Asset deletion is refused while a product references the `publicId`.

No existing banners, store settings management, coupon administration, exports, reports, audit-log, or manual inventory workflow was present to extend. Coupon use and checkout shipping settings are supported, but those additional admin-management/reporting APIs are not implemented in this standalone baseline.

## Administrator bootstrap

Have a trusted project operator obtain the target user's Firebase Auth UID out of band, then set that exact UID in the hosting platform's `ADMIN_UIDS` secret/config and restart or redeploy the service. The list is an authoritative server-side allowlist; it is never controlled by the browser. For larger teams, replace it with a trusted custom-claims provisioning workflow. This API intentionally has no public admin bootstrap endpoint.

## Maintenance scripts

Two Node scripts under [`scripts/`](./scripts) talk to Firebase with the service account directly, which makes them usable for diagnostics before the API itself is deployed:

- `node scripts/firebase-selftest.mjs` — reports clock skew, mints an OAuth token, lists Firestore databases and Storage buckets, and reads the `products` collection. Set `FIREBASE_PROJECT_ID` and `FIREBASE_SERVICE_ACCOUNT_PATH` (or `GOOGLE_APPLICATION_CREDENTIALS`) first.
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
