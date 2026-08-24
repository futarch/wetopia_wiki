// Identity for a request.
//
// v0 placeholder: a single configured user, or the dev header. BetterAuth
// (email/password + its Postgres) replaces the body of `currentUser` — every
// route already treats the returned id as the only source of identity, and the
// workspace/bundle a request may touch is derived from it server-side, so
// swapping this in changes nothing else.
import { config } from "./wetopia-server.ts";

export function currentUser(req: Request): string {
  const dev = req.headers.get("x-wetopia-user");
  if (dev && config.users.includes(dev)) return dev;
  return config.users[0];
}
