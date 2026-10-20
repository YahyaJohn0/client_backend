#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSign } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(SCRIPT_DIR, "..");
const DATABASE_PATH = "demoProducts";
const SEEDER_ID = "zamzam-provided-cloudinary-images-seeder";
const CLOUDINARY_FOLDER = "samples/ecommerce";
const NETWORK_TIMEOUT_MS = 20_000;

const IMAGES = [
  {
    id: "demo-cloudinary-image-01",
    name: "Demo Image 01",
    url: "https://res.cloudinary.com/dqtawjwph/image/upload/v1792480776/samples/ecommerce/wwhxiclt2uugr8rskjq1.webp",
  },
  {
    id: "demo-cloudinary-banner-image",
    name: "Banner Image (Demo)",
    url: "https://res.cloudinary.com/dqtawjwph/image/upload/v1792480777/samples/ecommerce/dmecu1jyaaiulutwgnpu.webp",
  },
  {
    id: "demo-cloudinary-crytera-image",
    name: "Crytera Image (Demo)",
    url: "https://res.cloudinary.com/dqtawjwph/image/upload/v1792480778/samples/ecommerce/nbyxa297pyot0hgdkqyz.webp",
  },
  {
    id: "demo-cloudinary-image-04",
    name: "Demo Image 04",
    url: "https://res.cloudinary.com/dqtawjwph/image/upload/v1792480779/samples/ecommerce/t14w5kegighx29gwhy4u.jpg",
  },
  {
    id: "demo-cloudinary-image-05",
    name: "Demo Image 05",
    url: "https://res.cloudinary.com/dqtawjwph/image/upload/v1792480780/samples/ecommerce/rdnrworo7dywt9egoxle.jpg",
  },
  {
    id: "demo-cloudinary-image-06",
    name: "Demo Image 06",
    url: "https://res.cloudinary.com/dqtawjwph/image/upload/v1792480781/samples/ecommerce/tgkwnuhe6fwfgdra8v1r.jpg",
  },
  {
    id: "demo-cloudinary-image-07",
    name: "Demo Image 07",
    url: "https://res.cloudinary.com/dqtawjwph/image/upload/v1792480781/samples/ecommerce/mpewlagslcbwsn10fmpj.jpg",
  },
  {
    id: "demo-cloudinary-image-08",
    name: "Demo Image 08",
    url: "https://res.cloudinary.com/dqtawjwph/image/upload/v1792480782/samples/ecommerce/uxqvwxavgiuqeyws1yd4.webp",
  },
  {
    id: "demo-cloudinary-image-09",
    name: "Demo Image 09",
    url: "https://res.cloudinary.com/dqtawjwph/image/upload/v1792480783/samples/ecommerce/fhghfc2uv9u846ai3xkb.webp",
  },
  {
    id: "demo-cloudinary-image-10",
    name: "Demo Image 10",
    url: "https://res.cloudinary.com/dqtawjwph/image/upload/v1792480784/samples/ecommerce/yhilxph3awd4h0lhwgbd.webp",
  },
  {
    id: "demo-cloudinary-image-11",
    name: "Demo Image 11",
    url: "https://res.cloudinary.com/dqtawjwph/image/upload/v1792480785/samples/ecommerce/eyyd2mkd32rj29i3c84q.webp",
  },
];

const summary = { verified: 0, written: 0, skipped: 0, failed: 0 };

function loadEnv() {
  const envPath = resolve(PROJECT_DIR, ".env");
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function readServiceAccount(projectId) {
  let account;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (raw) {
    try {
      account = JSON.parse(raw);
    } catch {
      throw new Error("FIREBASE_SERVICE_ACCOUNT must contain valid service-account JSON.");
    }
  } else {
    const configuredPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
    if (!configuredPath) {
      throw new Error("Set FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS in client_backend/.env.");
    }
    const credentialPath = resolve(PROJECT_DIR, configuredPath);
    if (!existsSync(credentialPath)) {
      throw new Error("GOOGLE_APPLICATION_CREDENTIALS points to a file that does not exist.");
    }
    try {
      account = JSON.parse(readFileSync(credentialPath, "utf8"));
    } catch {
      throw new Error("GOOGLE_APPLICATION_CREDENTIALS must point to valid service-account JSON.");
    }
  }

  if (account.type !== "service_account" || account.project_id !== projectId ||
      !account.client_email || !account.private_key) {
    throw new Error("Firebase service-account credentials do not match FIREBASE_PROJECT_ID.");
  }
  return account;
}

function createTrustedTimeCredential(account) {
  let accessToken;
  let expiresAt = 0;
  return {
    async getAccessToken() {
      if (accessToken && Date.now() < expiresAt - 60_000) {
        return { access_token: accessToken, expires_in: Math.max(60, Math.floor((expiresAt - Date.now()) / 1000)) };
      }

      const timeResponse = await fetch("https://www.googleapis.com/generate_204", {
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      });
      const trustedNow = Date.parse(timeResponse.headers.get("date") ?? "");
      if (!timeResponse.ok || !Number.isFinite(trustedNow)) {
        throw new Error("Could not obtain trusted Google server time for Firebase authentication.");
      }

      const encode = (value) => Buffer.from(value).toString("base64url");
      const claims = encode(JSON.stringify({
        iss: account.client_email,
        scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
        aud: "https://oauth2.googleapis.com/token",
        iat: Math.floor(trustedNow / 1000) - 30,
        exp: Math.floor(trustedNow / 1000) + 3000,
      }));
      const header = encode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
      const signingInput = `${header}.${claims}`;
      const signature = createSign("RSA-SHA256").update(signingInput).sign(account.private_key, "base64url");
      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: `${signingInput}.${signature}`,
        }),
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || typeof result.access_token !== "string" || !Number.isFinite(result.expires_in)) {
        throw new Error(`Firebase OAuth token exchange failed (${result.error || `HTTP ${response.status}`}).`);
      }
      accessToken = result.access_token;
      expiresAt = Date.now() + result.expires_in * 1000;
      return { access_token: accessToken, expires_in: result.expires_in };
    },
  };
}

function cloudinaryPublicId(imageUrl) {
  const url = new URL(imageUrl);
  if (url.protocol !== "https:" || url.hostname !== "res.cloudinary.com") {
    throw new Error(`Not a valid HTTPS Cloudinary URL: ${imageUrl}`);
  }
  const match = url.pathname.match(/^\/[^/]+\/image\/upload\/(?:v\d+\/)?(.+)$/);
  if (!match) throw new Error(`Cloudinary URL has an unexpected path: ${imageUrl}`);
  const assetPath = decodeURIComponent(match[1]);
  const withoutExtension = assetPath.replace(/\.[A-Za-z0-9]+$/, "");
  if (!withoutExtension.startsWith(`${CLOUDINARY_FOLDER}/`) || withoutExtension.includes("//")) {
    throw new Error(`Image is not in the configured Cloudinary folder: ${imageUrl}`);
  }
  return withoutExtension;
}

async function verifyImage(image) {
  const response = await fetch(image.url, {
    method: "HEAD",
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
  if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) {
    throw new Error(`${image.id}: image URL check failed (HTTP ${response.status}).`);
  }
  const publicId = cloudinaryPublicId(image.url);
  if (process.env.CLOUDINARY_CLOUD_NAME &&
      new URL(image.url).pathname.split("/")[1] !== process.env.CLOUDINARY_CLOUD_NAME.trim()) {
    throw new Error(`${image.id}: URL Cloudinary account does not match CLOUDINARY_CLOUD_NAME.`);
  }
  summary.verified += 1;
  return { ...image, publicId };
}

function makeRecord(image, existing) {
  const now = new Date().toISOString();
  return {
    ...existing,
    id: image.id,
    name: image.name,
    sku: image.id.toUpperCase(),
    brand: "Demo",
    description: "Demo catalog placeholder for a user-provided image. Product identity, manufacturer details, benefits, and price have not been verified.",
    shortDescription: "Demo image record; details are unverified.",
    categoryId: "demo-products",
    price: 0,
    salePrice: null,
    stock: 0,
    images: [image.url],
    imageUrl: image.url,
    imageMetadata: [{
      url: image.url,
      publicId: image.publicId,
      altText: `${image.name} (demo image)`,
      isPrimary: true,
      sortOrder: 0,
    }],
    cloudinaryPublicId: image.publicId,
    isFeatured: false,
    isBestSeller: false,
    isTrending: false,
    isNewArrival: false,
    isActive: true,
    isDemo: true,
    seededBy: SEEDER_ID,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

async function main() {
  loadEnv();
  const projectId = requiredEnv("FIREBASE_PROJECT_ID");
  const databaseUrl = requiredEnv("FIREBASE_DATABASE_URL");
  if (new URL(databaseUrl).protocol !== "https:") {
    throw new Error("FIREBASE_DATABASE_URL must use HTTPS.");
  }
  const account = readServiceAccount(projectId);
  const images = await Promise.all(IMAGES.map(verifyImage));
  const credential = createTrustedTimeCredential(account);
  await credential.getAccessToken();

  const appName = "zamzam-provided-cloudinary-images-seeder";
  const app = getApps().find((item) => item.name === appName) ??
    initializeApp({ credential, projectId, databaseURL: databaseUrl }, appName);
  const database = getDatabase(app);
  try {
    const root = database.ref(DATABASE_PATH);
    const existingSnapshot = await root.get();
    const existingRecords = existingSnapshot.val() ?? {};
    const conflicts = images.filter((image) => {
      const existing = existingRecords[image.id];
      return existing && (existing.isDemo !== true || existing.seededBy !== SEEDER_ID);
    });
    if (conflicts.length) {
      for (const image of conflicts) {
        summary.skipped += 1;
        console.warn(`SKIPPED ${image.id}: an existing record is not owned by this seeder.`);
      }
    }

    for (const image of images) {
      if (conflicts.some((conflict) => conflict.id === image.id)) continue;
      try {
        const productRef = root.child(image.id);
        let conflict = false;
        const result = await productRef.transaction((current) => {
          if (current && (current.isDemo !== true || current.seededBy !== SEEDER_ID)) {
            conflict = true;
            return;
          }
          return makeRecord(image, current);
        }, undefined, false);

        if (!result.committed) {
          if (conflict) {
            summary.skipped += 1;
            console.warn(`SKIPPED ${image.id}: an existing record is not owned by this seeder.`);
            continue;
          }
          throw new Error("Firebase transaction was not committed.");
        }
        const saved = result.snapshot.val();
        if (saved?.isDemo !== true || saved?.seededBy !== SEEDER_ID ||
            saved?.imageUrl !== image.url || saved?.imageMetadata?.[0]?.publicId !== image.publicId) {
          throw new Error("Saved record did not pass verification.");
        }
        summary.written += 1;
        console.log(`SAVED ${image.id}: ${image.name}`);
      } catch (error) {
        summary.failed += 1;
        console.error(`FAILED ${image.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    console.log("\nSeed summary");
    console.log(`  Verified Cloudinary images: ${summary.verified}`);
    console.log(`  Firebase writes:            ${summary.written}`);
    console.log(`  Skipped conflicts:          ${summary.skipped}`);
    console.log(`  Failed writes:              ${summary.failed}`);
    console.log(`  Firebase path:              /${DATABASE_PATH}`);
    if (summary.failed || summary.skipped) process.exitCode = 1;
  } finally {
    database.goOffline();
    await app.delete();
  }
}

main().catch((error) => {
  console.error(`Seed failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
