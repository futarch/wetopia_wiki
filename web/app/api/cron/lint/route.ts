// Trigger for the nightly lint.
//
// The cron is only a doorbell: the work runs inside this instance, through the
// same write queue as every conversation. That is what keeps the "exactly one
// writer" invariant true — a cron container with its own checkout would be a
// second writer racing this one over the same bundles.
//
// Clever Cloud:  0 3 * * *  curl -fsS -H "authorization: Bearer $WETOPIA_CRON_SECRET" https://…/api/cron/lint
import { getWetopia, listUsersWithBundles, ready } from "../../../../lib/server/wetopia-server.ts";
import { config } from "../../../../lib/server/config.ts";
import { runLint } from "../../../../lib/lint/run.ts";
import { archiveSessions } from "../../../../lib/store/sessionArchive.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorised(req: Request): boolean {
  const secret = process.env.WETOPIA_CRON_SECRET;
  // Without a configured secret the endpoint stays shut, rather than open.
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token.length !== secret.length) return false;
  // Constant-time-ish comparison: no early exit on the first differing byte.
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= token.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

async function handle(req: Request): Promise<Response> {
  if (!authorised(req)) return new Response("interdit", { status: 403 });

  await ready();
  const url = new URL(req.url);
  const withModel = url.searchParams.get("model") !== "off";

  const started = Date.now();
  try {
    const reports = await runLint({ users: listUsersWithBundles(), withModel });

    // Transcripts ride the same nightly pass: they are kept durably beside the
    // bundles, never inside them.
    const archive = await archiveSessions(getWetopia().bundleStore, config.sessionsDir, {
      retentionDays: config.sessionRetentionDays,
    });

    return Response.json({
      ok: true,
      durationMs: Date.now() - started,
      sessions: {
        uploaded: archive.uploaded.length,
        skipped: archive.skipped,
        deleted: archive.deleted.length,
      },
      bundles: reports.map((r) => ({
        bundle: r.bundle,
        findings: r.findings.length,
        byKind: r.findings.reduce<Record<string, number>>((acc, f) => {
          acc[f.kind] = (acc[f.kind] ?? 0) + 1;
          return acc;
        }, {}),
        indexAdded: r.indexAdded.length,
        indexRemoved: r.indexRemoved.length,
        ...(r.modelError ? { modelError: r.modelError } : {}),
      })),
    });
  } catch (e) {
    // Surface the failure loudly: a lint that silently stops running is the
    // operational risk this project flagged for itself.
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export { handle as GET, handle as POST };
