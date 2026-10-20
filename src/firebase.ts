import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getDatabase } from "firebase-admin/database";
import type { Config } from "./config.js";

export function initializeFirebase(config: Config) {
  const credential = config.FIREBASE_SERVICE_ACCOUNT
    ? cert(JSON.parse(config.FIREBASE_SERVICE_ACCOUNT) as Parameters<typeof cert>[0])
    : applicationDefault();
  const app = getApps()[0] ?? initializeApp({
    credential,
    projectId: config.FIREBASE_PROJECT_ID,
    databaseURL: config.FIREBASE_DATABASE_URL,
  });
  return { auth: getAuth(app), db: getFirestore(app), realtimeDb: getDatabase(app) };
}
