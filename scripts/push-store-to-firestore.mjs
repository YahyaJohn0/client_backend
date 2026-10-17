#!/usr/bin/env node
/**
 * Mirrors the bundled store's catalogue into Firebase Firestore.
 *
 * The storefront's Express server keeps the authoritative data in
 * frontent/data/store.json; this script pushes that data to Firestore with the
 * service account, so the same products are available to Firebase clients and
 * to the standalone backend API.
 *
 * Usage (from backend/):
 *   node scripts/push-store-to-firestore.mjs --dry-run
 *   node scripts/push-store-to-firestore.mjs                 # products only
 *   node scripts/push-store-to-firestore.mjs --all           # + categories, banners, settings
 *   node scripts/push-store-to-firestore.mjs --store <path> --database <id>
 *
 * Exit code 0 = data written (or a clean dry run); 1 = nothing was written.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BACKEND_DIR,
  clockSkewSeconds,
  commitDocuments,
  databasePath,
  describeFirestoreError,
  documentName,
  httpsCall,
  loadServiceAccount,
  mintAccessToken,
  toFirestoreFields,
  trustedNowSeconds,
} from "./lib/firebase-rest.mjs";

function parseArgs(argv) {
  const options = {
    store: join(BACKEND_DIR, "..", "frontent", "data", "store.json"),
    database: "(default)",
    all: false,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--store") options.store = argv[++index];
    else if (arg === "--database") options.database = argv[++index];
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return options;
}

function upsertWrite(projectId, collection, id, data, databaseId) {
  return {
    update: {
      name: documentName(projectId, collection, id, databaseId),
      fields: toFirestoreFields(data),
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const store = JSON.parse(readFileSync(options.store, "utf8"));
  const serviceAccount = loadServiceAccount();
  const projectId = serviceAccount.project_id;

  const products = Array.isArray(store.products) ? store.products : [];
  const categories = Array.isArray(store.categories) ? store.categories : [];
  const banners = Array.isArray(store.banners) ? store.banners : [];
  const syncedAt = new Date().toISOString();

  console.log(`Store file      : ${options.store}`);
  console.log(`Service account : ${serviceAccount.client_email}`);
  console.log(`Project         : ${projectId}`);
  console.log(`Database        : ${options.database}`);
  console.log(`Mode            : ${options.dryRun ? "dry run" : "write"}`);

  const now = await trustedNowSeconds();
  const skew = clockSkewSeconds(now);
  console.log(`Clock skew      : ${skew}s`);
  if (Math.abs(skew) > 300) {
    console.log("  NOTE: the machine clock is off; tokens below use Google's time.");
    console.log("  Run 'w32tm /resync' as administrator so the app's own Firebase calls work too.");
  }

  const writes = [];
  const ids = { products: [], categories: [], banners: [] };

  for (const product of products) {
    if (!product?.id) continue;
    ids.products.push(product.id);
    writes.push(
      upsertWrite(
        projectId,
        "products",
        product.id,
        { ...product, source: "admin-portal", syncedAt },
        options.database,
      ),
    );
  }

  if (options.all) {
    for (const category of categories) {
      if (!category?.id) continue;
      ids.categories.push(category.id);
      writes.push(
        upsertWrite(
          projectId,
          "categories",
          category.id,
          { ...category, source: "admin-portal", syncedAt },
          options.database,
        ),
      );
    }
    for (const banner of banners) {
      if (!banner?.id) continue;
      ids.banners.push(banner.id);
      writes.push(
        upsertWrite(
          projectId,
          "banners",
          banner.id,
          { ...banner, source: "admin-portal", syncedAt },
          options.database,
        ),
      );
    }
    if (store.settings) {
      writes.push(
        upsertWrite(
          projectId,
          "settings",
          "store",
          { ...store.settings, source: "admin-portal", syncedAt },
          options.database,
        ),
      );
    }
  }

  console.log(
    `Documents       : ${writes.length} (products ${ids.products.length}` +
      (options.all ? `, categories ${ids.categories.length}, banners ${ids.banners.length}` : "") +
      ")",
  );

  if (writes.length === 0) {
    console.log("Nothing to sync.");
    return;
  }

  if (options.dryRun) {
    const sample = writes[0].update;
    console.log(`First document  : ${sample.name}`);
    console.log(`Fields          : ${Object.keys(sample.fields).join(", ")}`);
    console.log("\nDRY RUN: no data was sent to Firebase.");
    return;
  }

  const token = await mintAccessToken(serviceAccount, now);
  try {
    const results = await commitDocuments(projectId, writes, token, options.database);
    console.log(`\nWROTE ${results.length} document(s) to Firestore.`);

    const probeId = ids.products[0];
    if (probeId) {
      const readBack = await httpsCall(
        "GET",
        `https://firestore.googleapis.com/v1/${databasePath(projectId, options.database)}/documents/products/${encodeURIComponent(probeId)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (readBack.status === 200) {
        console.log(
          `Verified read-back: products/${probeId} = ${readBack.json.fields?.name?.stringValue ?? "(no name)"}`,
        );
      } else {
        console.log(`Read-back check failed (${readBack.status}) ${readBack.raw.slice(0, 200)}`);
      }
    }
  } catch (error) {
    console.error(`\nNOTHING WAS WRITTEN.\n${describeFirestoreError(error)}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`SYNC FAILED: ${describeFirestoreError(error)}`);
  process.exitCode = 1;
});
