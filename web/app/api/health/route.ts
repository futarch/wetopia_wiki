// Health endpoint.
//
// Two levels on purpose: an external uptime probe only needs to know whether
// the thing is alive, and should not be handed the shape of the wiki. The full
// report — bundle counts, lint age, config gaps — needs the same machine secret
// as the cron.
//
//   curl -fsS https://…/api/health                    → {status, uptime}
//   curl -fsS -H "authorization: Bearer $SECRET" …    → every check, with detail
//
// The HTTP status carries the verdict so a dumb probe (or `curl -f`) is enough:
// 200 ok, 200 warn, 503 down.
import { computeHealth } from "../../../lib/monitor/health.ts";
import { ready } from "../../../lib/server/wetopia-server.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorised(req: Request): boolean {
  const secret = process.env.WETOPIA_CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= token.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

export async function GET(req: Request): Promise<Response> {
  const detailed = authorised(req);
  try {
    await ready();
    const health = await computeHealth();
    const body = detailed
      ? health
      : { status: health.status, checkedAt: health.checkedAt, uptimeSeconds: health.uptimeSeconds };
    return Response.json(body, { status: health.status === "down" ? 503 : 200 });
  } catch (e) {
    // Failing to boot IS the health answer, not an internal error to hide.
    return Response.json(
      {
        status: "down",
        checkedAt: new Date().toISOString(),
        ...(detailed ? { error: (e as Error).message } : {}),
      },
      { status: 503 },
    );
  }
}
