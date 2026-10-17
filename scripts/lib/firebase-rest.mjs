/**
 * Minimal Firestore REST helpers for the maintenance scripts.
 *
 * Google rejects JWTs issued more than a few minutes in the future, so a
 * machine clock that runs ahead breaks the Admin SDK with misleading
 * "invalid authentication credentials" errors. These helpers derive "now"
 * from Google's HTTP Date header and mint a short-lived OAuth token from the
 * service account, which keeps the scripts usable for diagnostics.
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BACKEND_DIR = join(SCRIPTS_DIR, "..");

export function defaultServiceAccountPath() {
  return (
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    join(BACKEND_DIR, "mobapp-4454b-firebase-adminsdk-fbsvc-be6fb304c9.json")
  );
}

export function loadServiceAccount(path = defaultServiceAccountPath()) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function httpsCall(method, url, { headers = {}, body } = {}) {
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

export async function trustedNowSeconds() {
  const res = await httpsCall("GET", "https://www.googleapis.com/generate_204");
  const fromServer = Date.parse(res.headers.date || "");
  if (!Number.isFinite(fromServer)) throw new Error("Could not read Google's Date header.");
  return Math.floor(fromServer / 1000);
}

export function clockSkewSeconds(nowSeconds) {
  return Math.round(Date.now() / 1000 - nowSeconds);
}

export async function mintAccessToken(serviceAccount, nowSeconds, scope = "https://www.googleapis.com/auth/datastore") {
  const base64url = (value) => Buffer.from(value).toString("base64url");
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope,
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
    throw new Error(`Token exchange failed (${res.status}): ${res.json?.error || res.raw.slice(0, 200)}`);
  }
  return res.json.access_token;
}

export function databasePath(projectId, databaseId = "(default)") {
  return `projects/${projectId}/databases/${encodeURIComponent(databaseId)}`;
}

/** Converts a plain JS value into a Firestore REST `Value`. */
export function toFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toFirestoreValue) } };
  }
  if (typeof value === "object") {
    return { mapValue: { fields: toFirestoreFields(value) } };
  }
  return { stringValue: String(value) };
}

/** Converts a plain JS object into a Firestore REST `fields` map. */
export function toFirestoreFields(object) {
  const fields = {};
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined) continue;
    fields[key] = toFirestoreValue(value);
  }
  return fields;
}

export function documentName(projectId, collection, id, databaseId = "(default)") {
  return `${databasePath(projectId, databaseId)}/documents/${collection}/${encodeURIComponent(id)}`;
}

/** Commits a batch of upserts; Firestore allows at most 500 writes per commit. */
export async function commitDocuments(projectId, writes, accessToken, databaseId = "(default)") {
  const results = [];
  for (let index = 0; index < writes.length; index += 400) {
    const batch = writes.slice(index, index + 400);
    const body = JSON.stringify({ writes: batch });
    const res = await httpsCall(
      "POST",
      `https://firestore.googleapis.com/v1/${databasePath(projectId, databaseId)}/documents:commit`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        body,
      },
    );
    if (res.status !== 200) {
      throw new Error(
        `Firestore commit failed (${res.status}): ${res.json?.error?.message || res.raw.slice(0, 300)}`,
      );
    }
    results.push(...(res.json?.writeResults || []));
  }
  return results;
}

export function describeFirestoreError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/DATA_ACCESS_MODE_DISABLED|Data Access modes are configured/i.test(message)) {
    return (
      `${message}\n\n` +
      "The database exists but its data access mode is disabled. Open the Firebase console\n" +
      "and create/convert a Firestore database in Native mode."
    );
  }
  if (/does not exist for project/i.test(message)) {
    return (
      `${message}\n\n` +
      "Create the default Firestore database first:\n" +
      "https://console.firebase.google.com/project/mobapp-4454b/firestore"
    );
  }
  return message;
}
