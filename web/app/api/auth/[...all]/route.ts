import { toNextJsHandler } from "better-auth/next-js";
import { auth, migrateAuth, signUpAllowed } from "../../../../lib/server/auth.ts";

export const runtime = "nodejs";

const handlers = toNextJsHandler(auth);

/**
 * Sign-up is gated here rather than inside better-auth: the policy of who may
 * join belongs with the app's other policies, and this stays independent of the
 * library's hook API.
 *
 * It matters as soon as the app is on the internet — an open sign-up would let
 * anyone who finds the URL create an account inside a private wiki.
 */
async function guardSignUp(req: Request): Promise<Response | null> {
  if (!new URL(req.url).pathname.endsWith("/sign-up/email")) return null;
  let email = "";
  try {
    email = String(((await req.clone().json()) as { email?: string }).email ?? "");
  } catch {
    return null; // malformed body: let better-auth produce its own error
  }
  if (signUpAllowed(email)) return null;
  return Response.json(
    { message: "Cette adresse n'est pas autorisée à créer un compte sur ce wiki." },
    { status: 403 },
  );
}

export async function GET(req: Request) {
  await migrateAuth();
  return handlers.GET(req);
}

export async function POST(req: Request) {
  await migrateAuth();
  return (await guardSignUp(req)) ?? handlers.POST(req);
}
