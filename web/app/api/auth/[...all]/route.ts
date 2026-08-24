import { toNextJsHandler } from "better-auth/next-js";
import { auth, migrateAuth } from "../../../../lib/server/auth.ts";

export const runtime = "nodejs";

const handlers = toNextJsHandler(auth);

// Auth is reached before anything else on a cold start, so the tables are
// ensured here too — a fresh deployment must not need a manual migration.
export async function GET(req: Request) {
  await migrateAuth();
  return handlers.GET(req);
}

export async function POST(req: Request) {
  await migrateAuth();
  return handlers.POST(req);
}
