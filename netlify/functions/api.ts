import serverless from "serverless-http";
import { app } from "../../dist/app.js";

type FunctionEvent = {
  path?: string;
  requestPath?: string;
  [key: string]: unknown;
};

const functionPath = "/.netlify/functions/api";
const expressHandler = serverless(app, { basePath: functionPath });

export const handler = (event: FunctionEvent, context: Record<string, unknown>) => {
  const requestedPath = event.requestPath ?? event.path;
  if (typeof requestedPath !== "string" || !requestedPath.startsWith(`${functionPath}/`)) {
    return expressHandler(event, context);
  }

  const forwardedPath = requestedPath.slice(functionPath.length);
  const expressPath = /^\/v1(?:\/|$)/.test(forwardedPath)
    ? `/api${forwardedPath}`
    : requestedPath;
  if (expressPath === requestedPath) return expressHandler(event, context);

  return expressHandler({ ...event, path: expressPath, requestPath: expressPath }, context);
};
