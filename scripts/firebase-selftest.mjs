#!/usr/bin/env node
/**
 * Firebase/Firestore self-test for the Zamzam project.
 *
 * The Admin SDK (and any Google JWT flow) refuses requests whose `iat` is in
 * the future, so a machine clock that runs ahead breaks Firestore access with
 * misleading "invalid authentication credentials" errors. This script derives
 * an accurate "now" from Google's own HTTP Date header, mints a short-lived
 * OAuth token from the service account, and reports whether Firestore exists.
 *
 * Set FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT_PATH or
 * GOOGLE_APPLICATION_CREDENTIALS, then run from client_backend/:
 *   node scripts/firebase-selftest.mjs
 *
 * Exit code 0 = Firestore reachable and authenticated; 1 = a problem was found.
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const SERVICE_ACCOUNT_PATH = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS;

function httpsCall(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method, headers }, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        let json = null;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, json, raw });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

async function trustedNowSeconds() {
  const res = await httpsCall("GET", "https://www.googleapis.com/generate_204");
  const fromServer = Date.parse(res.headers.date || "");
  if (!Number.isFinite(fromServer)) throw new Error("Could not read Google's Date header.");
  return Math.floor(fromServer / 1000);
}

async function mintAccessToken(serviceAccount, nowSeconds) {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/datastore",
      aud: "https://oauth2.googleapis.com/token",
      iat: nowSeconds - 30,
      exp: nowSeconds + 3000,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(serviceAccount.private_key, "base64url");

  const body =
    "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" +
    encodeURIComponent(`${signingInput}.${signature}`);

  const res = await httpsCall("POST", "https://oauth2.googleapis.com/token", {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
    },
    body,
  });

  if (!res.json?.access_token) {
    throw new Error(
      `Token exchange failed (${res.status}): ${res.json?.error || res.raw.slice(0, 200)}`,
    );
  }
  return res.json.access_token;
}

async function main() {
  if (!PROJECT_ID) throw new Error("Set FIREBASE_PROJECT_ID before running this self-test.");
  if (!SERVICE_ACCOUNT_PATH) {
    throw new Error("Set FIREBASE_SERVICE_ACCOUNT_PATH or GOOGLE_APPLICATION_CREDENTIALS to a protected credential file.");
  }

  const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, "utf8"));
  if (serviceAccount.project_id !== PROJECT_ID) {
    throw new Error("FIREBASE_PROJECT_ID does not match the configured service account.");
  }
  console.log("Service account : configured");
  console.log(`Project         : ${serviceAccount.project_id}`);

  const now = await trustedNowSeconds();
  const skewSeconds = Math.round(Date.now() / 1000 - now);
  console.log(`Clock skew      : ${skewSeconds}s (${skewSeconds > 0 ? "system ahead of" : "system behind"} Google)`);
  if (Math.abs(skewSeconds) > 300) {
    console.log("  WARNING: more than 5 minutes of skew breaks Google JWT authentication.");
    console.log("  Fix with: w32tm /resync   (or Settings > Time & language > Sync now)");
  }

  const token = await mintAccessToken(serviceAccount, now);
  console.log("OAuth token     : OK (minted using trusted time)");
  const auth = { Authorization: `Bearer ${token}` };

  const databases = await httpsCall(
    "GET",
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases`,
    { headers: auth },
  );
  const databaseNames = (databases.json?.databases || []).map((db) => db.name);
  console.log(`Databases       : ${databases.status} ${JSON.stringify(databaseNames)}`);
  for (const db of databases.json?.databases || []) {
    console.log(
      `  - ${db.name} (type=${db.type ?? "?"}, location=${db.locationId ?? "?"}, state=${db.state ?? "?"})`,
    );
    const details = await httpsCall("GET", `https://firestore.googleapis.com/v1/${db.name}`, {
      headers: auth,
    });
    if (details.status === 200) {
      console.log(
        `    edition=${details.json.databaseEdition ?? "?"} accessMode=${details.json.firestoreDataAccessMode ?? "?"} concurrency=${details.json.concurrencyMode ?? "?"}`,
      );
    }
  }

  const buckets = await httpsCall(
    "GET",
    `https://storage.googleapis.com/storage/v1/b?project=${PROJECT_ID}`,
    { headers: auth },
  );
  console.log(
    `Storage buckets : ${buckets.status} ${JSON.stringify((buckets.json?.items || []).map((b) => b.name))}`,
  );
  for (const bucketName of [
    `${PROJECT_ID}.firebasestorage.app`,
    `${PROJECT_ID}.appspot.com`,
  ]) {
    const bucket = await httpsCall(
      "GET",
      `https://storage.googleapis.com/storage/v1/b/${bucketName}`,
      { headers: auth },
    );
    console.log(`  - bucket ${bucketName}: ${bucket.status}`);
  }

  // Firestore's conventional default database is "(default)", but a database
  // created with an explicit id (for example "default") is a different one.
  const candidates = ["(default)", ...databaseNames.map((name) => name.split("/").pop())];
  const tried = new Set();

  for (const databaseId of candidates) {
    if (!databaseId || tried.has(databaseId)) continue;
    tried.add(databaseId);
    const path = `projects/${PROJECT_ID}/databases/${databaseId}/documents/products?pageSize=5`;
    const docs = await httpsCall(
      "GET",
      `https://firestore.googleapis.com/v1/${encodeURI(path)}`,
      { headers: auth },
    );

    if (docs.status === 200) {
      const count = docs.json?.documents?.length ?? 0;
      console.log(`Firestore read  : OK via database "${databaseId}" (${count} product document(s))`);
      for (const doc of docs.json?.documents || []) {
        const name = doc.name.split("/").pop();
        console.log(`  - ${name}: ${doc.fields?.name?.stringValue ?? "(no name)"}`);
      }
      console.log(`\nRESULT: Firebase is ready. Use FIRESTORE_DATABASE_ID=${databaseId}.`);
      process.exit(0);
    }

    console.log(`Firestore read  : database "${databaseId}" -> ${docs.status} ${docs.raw.slice(0, 160)}`);
  }

  console.log("\nRESULT: no readable Firestore database was found for this project.");
  console.log("Fix: open https://console.firebase.google.com/project/" + PROJECT_ID + "/firestore");
  console.log("     and create the default database, then re-run this script.");

  const permissionBody = JSON.stringify({ permissions: ["datastore.databases.create"] });
  const permissionCheck = await httpsCall(
    "POST",
    `https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT_ID}:testIamPermissions`,
    {
      headers: {
        ...auth,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(permissionBody),
      },
      body: permissionBody,
    },
  );
  const granted = permissionCheck.json?.permissions || [];
  console.log(
    `Service account can create databases: ${granted.includes("datastore.databases.create") ? "yes" : "no"}`,
  );
  process.exit(1);
}

main().catch((error) => {
  console.error(`FIREBASE SELF-TEST FAILED: ${error.message}`);
  process.exit(1);
});
