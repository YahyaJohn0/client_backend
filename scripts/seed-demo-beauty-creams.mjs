#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { createSign } from "node:crypto";
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { v2 as cloudinary } from "cloudinary";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(SCRIPT_DIR, "..");
const DATABASE_PATH = "demoProducts";
const CLOUDINARY_FOLDER = "zamzam/demo-products/beauty-creams";
const SEEDER_ID = "zamzam-demo-beauty-creams-seeder";
const MAX_SOURCE_BYTES = 15 * 1024 * 1024;
const NETWORK_TIMEOUT_MS = 20_000;
const CONCURRENCY = 2;

const PRODUCTS = [
  {
    id: "demo-biocos-beauty-cream",
    name: "Biocos Beauty Cream",
    brand: "Biocos",
    sku: "DEMO-BIOCOS-BEAUTY-CREAM",
    price: 1200,
    sourceUrl: "https://www.biocospk.com/cdn/shop/files/Front_image.jpg?v=1759305216&width=1024",
    sourcePage: "https://www.biocospk.com/products/beauty-cream-small",
  },
  {
    id: "demo-organic-bloom-even-out-cream",
    name: "Organic Bloom Even Out Day & Night Cream",
    brand: "Organic Bloom",
    sku: "DEMO-ORGANIC-BLOOM-EVEN-OUT",
    price: 1500,
    sourceUrl: "https://www.organicbloom.pk/cdn/shop/files/01-18_270895b4-e06c-4453-b081-a4d34972fc1e.jpg?v=1706531623",
    sourcePage: "https://www.organicbloom.pk/products/even-out-day-night-cream",
  },
  {
    id: "demo-asraderm-relumin-cream",
    name: "Asraderm Relumin Cream",
    brand: "Asraderm",
    sku: "DEMO-ASRADERM-RELUMIN",
    price: 1400,
    sourceUrl: "https://www.asraderm.pk/cdn/shop/files/ReluminFairnessCream2.png?v=1737378486&width=600",
    sourcePage: "https://www.asraderm.pk/collections/asraderm-vitals",
  },
  {
    id: "demo-citrix-c-vitamin-cream",
    name: "Citrix-C Vitamin C Cream",
    brand: "Citrix-C",
    sku: "DEMO-CITRIX-C-VITAMIN-CREAM",
    price: 1800,
    sourceUrl: "https://theskinlab.pk/cdn/shop/files/Citrix.webp?v=1732105657&width=533",
    sourcePage: "https://theskinlab.pk/collections/whitening-creams?page=3",
  },
  {
    id: "demo-mk-cosmetics-age-miracle-creme",
    name: "MK Cosmetics Age Miracle Crème",
    brand: "MK Cosmetics",
    sku: "DEMO-MK-AGE-MIRACLE-CREME",
    price: 2000,
    sourceUrl: "https://www.mkcosmetics.com.pk/cdn/shop/files/4_47f7abeb-e94d-4480-b649-5d4e663099e9_1000x.jpg?v=1712401748",
    sourcePage: "https://www.mkcosmetics.com.pk/collections/cream",
  },
];

const summary = {
  uploaded: 0,
  skipped: 0,
  failed: 0,
  databaseWrites: 0,
};
const orphanedAssets = [];

function errorMessage(error) {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const fields = ["message", "code", "status", "statusCode", "name"]
      .filter((field) => typeof error[field] === "string" || typeof error[field] === "number")
      .map((field) => `${field}=${error[field]}`);
    if (typeof error.error === "string") fields.push(`detail=${error.error.slice(0, 240)}`);
    else if (error.error && typeof error.error === "object") {
      for (const field of ["message", "code", "status"]) {
        if (typeof error.error[field] === "string" || typeof error.error[field] === "number") {
          fields.push(`detail.${field}=${error.error[field]}`);
        }
      }
      fields.push(`detailKeys=${Object.keys(error.error).join(",") || "none"}`);
    }
    return fields.length ? fields.join(", ") : `Unknown error object (${Object.keys(error).join(", ") || "no details"})`;
  }
  return String(error);
}

function parseArgs(args) {
  const options = { dryRun: false, confirmImageRights: false };
  for (const arg of args) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--confirm-image-rights") options.confirmImageRights = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function loadProjectEnv() {
  const envPath = resolve(PROJECT_DIR, ".env");
  if (existsSync(envPath)) process.loadEnvFile(envPath);

  const frontendEnvPath = resolve(PROJECT_DIR, "..", "Client1_Frontend", ".env");
  if (!process.env.FIREBASE_DATABASE_URL && existsSync(frontendEnvPath)) {
    process.loadEnvFile(frontendEnvPath);
    if (process.env.VITE_FIREBASE_PROJECT_ID &&
        process.env.VITE_FIREBASE_PROJECT_ID !== process.env.FIREBASE_PROJECT_ID) {
      throw new Error("The frontend Firebase project ID does not match FIREBASE_PROJECT_ID.");
    }
  }
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function trustedTimeCredential(serviceAccount) {
  let cachedToken;
  let tokenExpiresAt = 0;

  return {
    async getAccessToken() {
      if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
        return { access_token: cachedToken, expires_in: Math.max(60, Math.floor((tokenExpiresAt - Date.now()) / 1000)) };
      }

      const timeResponse = await fetch("https://www.googleapis.com/generate_204", {
        method: "GET",
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      });
      const trustedNow = Date.parse(timeResponse.headers.get("date") ?? "");
      if (!timeResponse.ok || !Number.isFinite(trustedNow)) {
        throw new Error("Could not obtain trusted Google server time for Firebase authentication.");
      }

      const encode = (value) => Buffer.from(value).toString("base64url");
      const nowSeconds = Math.floor(trustedNow / 1000);
      const claims = encode(JSON.stringify({
        iss: serviceAccount.client_email,
        scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
        aud: "https://oauth2.googleapis.com/token",
        iat: nowSeconds - 30,
        exp: nowSeconds + 3000,
      }));
      const header = encode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
      const signingInput = `${header}.${claims}`;
      const signature = createSign("RSA-SHA256")
        .update(signingInput)
        .sign(serviceAccount.private_key, "base64url");
      const form = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${signingInput}.${signature}`,
      });
      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      });
      const tokenData = await tokenResponse.json().catch(() => ({}));
      if (!tokenResponse.ok || typeof tokenData.access_token !== "string" ||
          !Number.isFinite(tokenData.expires_in)) {
        const code = typeof tokenData.error === "string" ? tokenData.error : `HTTP ${tokenResponse.status}`;
        throw new Error(`Firebase OAuth token exchange failed (${code}).`);
      }

      cachedToken = tokenData.access_token;
      tokenExpiresAt = Date.now() + tokenData.expires_in * 1000;
      return { access_token: cachedToken, expires_in: tokenData.expires_in };
    },
  };
}

function getFirebaseCredential(projectId) {
  const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (rawServiceAccount) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(rawServiceAccount);
    } catch {
      throw new Error("FIREBASE_SERVICE_ACCOUNT must contain valid service-account JSON.");
    }
    if (serviceAccount.project_id && serviceAccount.project_id !== projectId) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT belongs to a different Firebase project than FIREBASE_PROJECT_ID.");
    }
    if (!serviceAccount.client_email || !serviceAccount.private_key) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT is missing its client email or private key.");
    }
    return trustedTimeCredential(serviceAccount);
  }

  const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (credentialPath) {
    const resolvedCredentialPath = isAbsolute(credentialPath)
      ? credentialPath
      : resolve(PROJECT_DIR, credentialPath);
    if (!existsSync(resolvedCredentialPath)) {
      throw new Error("GOOGLE_APPLICATION_CREDENTIALS points to a file that does not exist.");
    }
    process.env.GOOGLE_APPLICATION_CREDENTIALS = resolvedCredentialPath;
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(readFileSync(resolvedCredentialPath, "utf8"));
    } catch {
      throw new Error("GOOGLE_APPLICATION_CREDENTIALS must point to valid service-account JSON.");
    }
    if (serviceAccount.type !== "service_account" ||
        serviceAccount.project_id !== projectId ||
        !serviceAccount.client_email ||
        !serviceAccount.private_key) {
      throw new Error("GOOGLE_APPLICATION_CREDENTIALS must be a service account for FIREBASE_PROJECT_ID.");
    }
    return trustedTimeCredential(serviceAccount);
  }
  return applicationDefault();
}

function configureCloudinary() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
  if (cloudName && apiKey && apiSecret) {
    cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });
    return;
  }

  const cloudinaryUrl = process.env.CLOUDINARY_URL?.trim();
  if (cloudinaryUrl) {
    let parsed;
    try {
      parsed = new URL(cloudinaryUrl);
    } catch {
      throw new Error("CLOUDINARY_URL is invalid.");
    }
    if (parsed.protocol !== "cloudinary:" || !parsed.hostname || !parsed.username || !parsed.password) {
      throw new Error("CLOUDINARY_URL must be a valid Cloudinary credential URL.");
    }
    cloudinary.config({
      cloud_name: parsed.hostname,
      api_key: decodeURIComponent(parsed.username),
      api_secret: decodeURIComponent(parsed.password),
    });
    return;
  }

  const missing = [
    ...(!cloudName ? ["CLOUDINARY_CLOUD_NAME"] : []),
    ...(!apiKey ? ["CLOUDINARY_API_KEY"] : []),
    ...(!apiSecret ? ["CLOUDINARY_API_SECRET"] : []),
    "CLOUDINARY_URL (or all three CLOUDINARY_* values above)",
  ];
  throw new Error(`Missing Cloudinary configuration: ${missing.join(", ")}.`);
}

function createFirebaseDatabase(projectId, databaseUrl, credential) {
  const existing = getApps().find((app) => app.name === SEEDER_ID);
  const app = existing ?? initializeApp({
    credential,
    projectId,
    databaseURL: databaseUrl,
  }, SEEDER_ID);
  if (app.options.projectId !== projectId || app.options.databaseURL !== databaseUrl) {
    throw new Error("An initialized Firebase app does not match the configured project and database URL.");
  }
  return getDatabase(app);
}

function isImageBytes(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return true;
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP") return true;
  if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp" &&
      /^(avif|avis)$/.test(buffer.toString("ascii", 8, 12))) return true;
  return false;
}

async function readVerifiedImage(sourceUrl) {
  const parsedUrl = new URL(sourceUrl);
  if (parsedUrl.protocol !== "https:") throw new Error("Image source must use HTTPS.");

  const response = await fetch(parsedUrl, {
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    headers: { "User-Agent": "ZamzamDemoCatalogSeeder/1.0" },
  });
  if (!response.ok) throw new Error(`Image source returned HTTP ${response.status}.`);
  if (!response.url.startsWith("https://")) throw new Error("Image source redirected to a non-HTTPS URL.");

  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (!contentType?.startsWith("image/")) throw new Error("Image source did not return an image content type.");

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SOURCE_BYTES) {
    throw new Error("Image source exceeds the 15 MiB size limit.");
  }

  const chunks = [];
  let totalBytes = 0;
  if (!response.body) throw new Error("Image source returned an empty response.");
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > MAX_SOURCE_BYTES) throw new Error("Image source exceeds the 15 MiB size limit.");
    chunks.push(bytes);
  }
  const image = Buffer.concat(chunks);
  if (!isImageBytes(image)) throw new Error("Image source response does not contain a supported image file.");
  return image;
}

async function withConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await task(items[index]) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function assertCloudinaryAssetIsOurs(publicId) {
  try {
    const existing = await cloudinary.api.resource(publicId, { resource_type: "image" });
    if (!Array.isArray(existing.tags) || !existing.tags.includes(SEEDER_ID)) {
      throw new SkipProductError("the stable Cloudinary public ID is occupied by an asset not owned by this seeder");
    }
  } catch (error) {
    const status = error?.http_code ?? error?.statusCode ?? error?.status ??
      error?.error?.http_code ?? error?.error?.statusCode ?? error?.error?.status;
    if (status === 404) return null;
    throw error;
  }
  return true;
}

function uploadImage(buffer, publicId) {
  return new Promise((resolveUpload, rejectUpload) => {
    const upload = cloudinary.uploader.upload_stream({
      resource_type: "image",
      public_id: publicId,
      overwrite: true,
      invalidate: true,
      tags: [SEEDER_ID],
      timeout: 60_000,
    }, (error, result) => {
      if (error) return rejectUpload(error);
      resolveUpload(result);
    });
    Readable.from(buffer).pipe(upload);
  });
}

function makeProductRecord(product, secureUrl, publicId, existingRecord) {
  const now = new Date().toISOString();
  const imageMetadata = [{ url: secureUrl, publicId, isPrimary: true, sortOrder: 0 }];
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    brand: product.brand,
    description: "Demo catalog content. Product details are not independently verified.",
    shortDescription: "Demo product; details and pricing are placeholders.",
    categoryId: "demo-beauty-creams",
    category: "Beauty Creams (Demo)",
    price: product.price,
    salePrice: null,
    priceCurrency: "PKR",
    priceLabel: "Demo price only; not verified manufacturer pricing.",
    stock: 10,
    images: [secureUrl],
    imageMetadata,
    imageUrl: secureUrl,
    imageSourceUrl: product.sourceUrl,
    imageSourcePage: product.sourcePage,
    cloudinaryPublicId: publicId,
    isFeatured: false,
    isBestSeller: false,
    isTrending: false,
    isNewArrival: false,
    isActive: true,
    isDemo: true,
    seededBy: SEEDER_ID,
    createdAt: existingRecord?.createdAt ?? now,
    updatedAt: now,
  };
}

async function seedOne(database, product) {
  let sourceImage;
  try {
    sourceImage = await readVerifiedImage(product.sourceUrl);
  } catch (error) {
    throw new SkipProductError(`image source could not be verified: ${errorMessage(error)}`);
  }

  const productRef = database.ref(`${DATABASE_PATH}/${product.id}`);
  const existingSnapshot = await productRef.get();
  const currentRecord = existingSnapshot.val();
  if (currentRecord !== null &&
      (currentRecord.isDemo !== true || currentRecord.seededBy !== SEEDER_ID)) {
    throw new SkipProductError("an existing record is not owned by this seeder");
  }

  const publicId = `${CLOUDINARY_FOLDER}/${product.id}`;
  if (await assertCloudinaryAssetIsOurs(publicId) === false) {
    throw new SkipProductError("the stable Cloudinary public ID is occupied by an asset not owned by this seeder");
  }

  const uploaded = await uploadImage(sourceImage, publicId);
  let secureUrl;
  try {
    secureUrl = typeof uploaded?.secure_url === "string" ? new URL(uploaded.secure_url) : null;
  } catch {
    secureUrl = null;
  }
  if (!secureUrl || secureUrl.protocol !== "https:" ||
      secureUrl.hostname !== "res.cloudinary.com" ||
      uploaded.public_id !== publicId) {
    orphanedAssets.push(publicId);
    throw new Error("Cloudinary returned an invalid secure URL or unexpected public ID.");
  }
  summary.uploaded += 1;

  let conflict = false;
  try {
    const transaction = await productRef.transaction((current) => {
      if (current !== null && (current.isDemo !== true || current.seededBy !== SEEDER_ID)) {
        conflict = true;
        return;
      }
      return makeProductRecord(product, secureUrl.href, uploaded.public_id, current);
    }, undefined, false);

    if (!transaction.committed) {
      if (conflict) {
        summary.skipped += 1;
        console.warn(`SKIPPED ${product.id}: an existing record is not owned by this seeder.`);
      } else {
        orphanedAssets.push(uploaded.public_id);
        summary.failed += 1;
        console.error(`FAILED ${product.id}: Firebase transaction did not commit; review Cloudinary asset ${uploaded.public_id}.`);
      }
      return;
    }
    const saved = transaction.snapshot.val();
    if (saved?.isDemo !== true || saved?.seededBy !== SEEDER_ID ||
        saved?.imageUrl !== secureUrl.href ||
        saved?.imageSourceUrl !== product.sourceUrl ||
        saved?.imageSourcePage !== product.sourcePage ||
        !Array.isArray(saved?.images) || saved.images[0] !== secureUrl.href) {
      orphanedAssets.push(uploaded.public_id);
      summary.failed += 1;
      console.error(`FAILED ${product.id}: Firebase write completed but the saved demo record did not pass verification; review Cloudinary asset ${uploaded.public_id}.`);
      return;
    }
    summary.databaseWrites += 1;
    console.log(`SEEDED ${product.name}: ${secureUrl.href}`);
  } catch (error) {
    orphanedAssets.push(uploaded.public_id);
    summary.failed += 1;
    console.error(`FAILED ${product.id}: Firebase write failed; review Cloudinary asset ${uploaded.public_id}. ${errorMessage(error)}`);
  }
}

function printSummary() {
  console.log("\nSeed summary");
  console.log(`  Cloudinary uploads: ${summary.uploaded}`);
  console.log(`  Skipped products:   ${summary.skipped}`);
  console.log(`  Failed products:    ${summary.failed}`);
  console.log(`  Firebase writes:    ${summary.databaseWrites}`);
  console.log(`  Firebase path:      /${DATABASE_PATH}`);
  if (orphanedAssets.length) {
    console.log("  Cloudinary assets to review after failed Firebase writes:");
    for (const publicId of orphanedAssets) console.log(`    ${publicId}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log(`Products: ${PRODUCTS.length}`);
  console.log(`Firebase Realtime Database path: /${DATABASE_PATH}`);
  console.log(`Cloudinary folder: ${CLOUDINARY_FOLDER}`);

  if (options.dryRun) {
    for (const product of PRODUCTS) {
      console.log(`  ${product.id}: ${product.name} — demo PKR ${product.price} — ${product.sourceUrl}`);
    }
    console.log("DRY RUN: no credentials were checked, no network requests were made, and no data was changed.");
    return;
  }

  if (!options.confirmImageRights) {
    summary.skipped = PRODUCTS.length;
    throw new Error(
      "No image uploads were attempted. Confirm you have permission to reuse these third-party product images, then rerun with --confirm-image-rights.",
    );
  }

  loadProjectEnv();
  const projectId = requiredEnv("FIREBASE_PROJECT_ID");
  const databaseUrl = process.env.FIREBASE_DATABASE_URL?.trim() ||
    process.env.VITE_FIREBASE_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("Missing required environment variable: FIREBASE_DATABASE_URL (or VITE_FIREBASE_DATABASE_URL in Client1_Frontend/.env).");
  }
  const parsedDatabaseUrl = new URL(databaseUrl);
  if (parsedDatabaseUrl.protocol !== "https:") {
    throw new Error("FIREBASE_DATABASE_URL must be an HTTPS Firebase Realtime Database URL.");
  }
  configureCloudinary();
  const credential = getFirebaseCredential(projectId);
  try {
    const accessToken = await credential.getAccessToken();
    if (!accessToken?.access_token) throw new Error();
  } catch {
    throw new Error(
      "Firebase Admin credentials are unavailable. Configure FIREBASE_SERVICE_ACCOUNT, GOOGLE_APPLICATION_CREDENTIALS, or valid Application Default Credentials.",
    );
  }
  const database = createFirebaseDatabase(projectId, databaseUrl, credential);
  await database.ref(DATABASE_PATH).get();

  const results = await withConcurrency(PRODUCTS, CONCURRENCY, (product) => seedOne(database, product));
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (!result.ok) {
      if (result.error instanceof SkipProductError) {
        summary.skipped += 1;
        console.warn(`SKIPPED ${PRODUCTS[index].id}: ${result.error.message}.`);
      } else {
        summary.failed += 1;
        console.error(`FAILED ${PRODUCTS[index].id}: ${errorMessage(result.error)}`);
      }
    }
  }
  if (summary.skipped > 0 || summary.failed > 0) {
    throw new Error("One or more products were not written; inspect the summary above.");
  }
}

class SkipProductError extends Error {}

try {
  await main();
} catch (error) {
  console.error(`\nSeeder stopped: ${errorMessage(error)}`);
  process.exitCode = 1;
} finally {
  printSummary();
  for (const app of getApps().filter((candidate) => candidate.name === SEEDER_ID)) {
    await app.delete().catch(() => {
      console.error("Failed to close the Firebase Admin app cleanly.");
      process.exitCode = 1;
    });
  }
}
