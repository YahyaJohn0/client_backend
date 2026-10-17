import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import type { Config } from "./config.js";

export function initializeFirebase(config: Config) {
  const credential = config.FIREBASE_SERVICE_ACCOUNT_JSON
    ? cert(JSON.parse(config.FIREBASE_SERVICE_ACCOUNT_JSON) as Parameters<typeof cert>[0])
    : applicationDefault();
  const app = getApps()[0] ?? initializeApp({
    credential,
    projectId: config.FIREBASE_PROJECT_ID,
  });
  return { auth: getAuth(app), db: getFirestore(app) };
}
