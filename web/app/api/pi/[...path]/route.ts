// The route layer react-pi's browser client expects (see its httpClient header).
// Every handler resolves identity server-side and refuses to touch a thread
// that does not belong to the caller.
import { currentViewer } from "../../../../lib/server/auth.ts";
import { describeWorkspace, resolveWorkspace, supervisor } from "../../../../lib/server/wetopia-server.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noContent = () => new Response(null, { status: 204 });
const oops = (status: number, message: string) => json({ error: message }, status);

/** A thread is reachable only from the workspaces of the user who owns it. */
async function ownedThread(sup: any, threadId: string, user: string) {
  const snapshot = await sup.getThread(threadId);
  const who = describeWorkspace(snapshot?.metadata?.workspacePath ?? "");
  if (!who || who.user !== user) return null;
  return snapshot;
}

async function handler(req: Request, ctx: { params: Promise<{ path?: string[] }> }): Promise<Response> {
  const segs = (await ctx.params).path ?? [];
  const method = req.method.toUpperCase();
  const body = async () => {
    try {
      return await req.json();
    } catch {
      return {};
    }
  };

  // Every route is gated: no session, no wiki.
  const viewer = await currentViewer(req.headers);
  if (!viewer) return oops(401, "non authentifié");
  const user = viewer.wikiId;

  let sup: any;
  try {
    sup = await supervisor();
  } catch (e) {
    return oops(503, `démarrage impossible : ${(e as Error).message}`);
  }

  try {
    // GET /models
    if (segs[0] === "models" && segs.length === 1 && method === "GET") {
      return json(await sup.getAvailableModels());
    }

    if (segs[0] !== "threads") return oops(404, "route inconnue");

    // /threads
    if (segs.length === 1) {
      if (method === "GET") {
        const all = [];
        for (const scope of ["private", "shared"] as const) {
          all.push(...(await sup.listThreads({ workspacePath: await resolveWorkspace(user, scope) })));
        }
        return json(all);
      }
      if (method === "POST") {
        const input = await body();
        // The client may ask for a scope; it may NEVER name a workspace path.
        const workspacePath = await resolveWorkspace(user, input.scope ?? "private");
        return json(
          await sup.createThread({
            workspacePath,
            ...(input.title ? { title: input.title } : {}),
            ...(input.initialMessage ? { initialMessage: input.initialMessage } : {}),
          }),
        );
      }
      return oops(405, "méthode non supportée");
    }

    const threadId = decodeURIComponent(segs[1]);
    const snapshot = await ownedThread(sup, threadId, user);
    if (!snapshot) return oops(404, "conversation introuvable");
    const action = segs[2];

    // /threads/:id
    if (segs.length === 2) {
      if (method === "GET") return json(snapshot);
      if (method === "PATCH") {
        const { title } = await body();
        await sup.renameThread(threadId, String(title ?? ""));
        return noContent();
      }
      if (method === "DELETE") {
        await sup.deleteThread(threadId);
        return noContent();
      }
      return oops(405, "méthode non supportée");
    }

    // /threads/:id/events  (SSE)
    if (action === "events" && method === "GET") {
      const includeSnapshot = new URL(req.url).searchParams.get("snapshot") !== "false";
      const encoder = new TextEncoder();
      let unsubscribe = () => {};
      const stream = new ReadableStream({
        start(controller) {
          const send = (event: unknown) => {
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            } catch {
              /* client vanished */
            }
          };
          unsubscribe = sup.subscribe(threadId, send, { includeSnapshot });
          const ping = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": ping\n\n"));
            } catch {
              /* ignore */
            }
          }, 25_000);
          const stop = unsubscribe;
          unsubscribe = () => {
            clearInterval(ping);
            stop();
          };
          req.signal.addEventListener("abort", () => unsubscribe());
        },
        cancel() {
          unsubscribe();
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        },
      });
    }

    if (method !== "POST") return oops(405, "méthode non supportée");

    switch (action) {
      case "messages": {
        const { input } = await body();
        await sup.sendMessage(threadId, input);
        return noContent();
      }
      case "cancel":
        await sup.cancelRun(threadId);
        return noContent();
      case "archive":
        await sup.archiveThread(threadId);
        return noContent();
      case "unarchive":
        await sup.unarchiveThread(threadId);
        return noContent();
      case "queue":
        if (segs[3] === "clear") return json(await sup.clearQueue(threadId));
        return oops(404, "route inconnue");
      case "host-ui": {
        const { response } = await body();
        await sup.respondToHostUiRequest(threadId, response);
        return noContent();
      }
      // Model and thinking level are fixed by the server: Mistral rejects pi's
      // default reasoning mode, and the model is a deployment decision.
      case "model":
      case "thinking":
        return oops(405, "réglage fixé par le serveur");
      default:
        return oops(404, "route inconnue");
    }
  } catch (e) {
    return oops(500, (e as Error).message);
  }
}

export { handler as GET, handler as POST, handler as PATCH, handler as DELETE };
