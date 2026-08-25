import { currentViewer } from "../../../../lib/server/auth.ts";
import { config, ready } from "../../../../lib/server/wetopia-server.ts";
import { readPageView, type Scope } from "../../../../lib/wiki-view.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const viewer = await currentViewer(req.headers);
  if (!viewer) return new Response("non authentifié", { status: 401 });
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope");
  const page = url.searchParams.get("path") ?? "";
  if (scope !== "private" && scope !== "shared") {
    return Response.json({ error: "scope invalide" }, { status: 400 });
  }
  await ready();
  try {
    return Response.json(readPageView(config.dataRoot, viewer.wikiId, scope as Scope, page));
  } catch (e) {
    // The guard refused: out of scope, cross-user, or malformed.
    return Response.json({ error: (e as Error).message }, { status: 403 });
  }
}
