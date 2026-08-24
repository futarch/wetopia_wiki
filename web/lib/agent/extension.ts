// Bridge between a pi session and the Wetopia runtime.
//
// react-pi's ThreadSupervisor only forwards `cwd` to createAgentSession, so
// this is how our tools, and only our tools, reach the agent: each workspace
// carries a generated extension that calls in here with its (user, scope).
import { createSessionContext } from "../guard.ts";
import { createWikiTools } from "./tools.ts";
import { getWetopia } from "./runtime.ts";

export function registerWetopia(pi: any, Type: any, user: string, scope: "private" | "shared") {
  const { store, dataRoot } = getWetopia();
  const ctx = createSessionContext({ dataRoot, user, scope });

  for (const tool of createWikiTools({ ctx, store }, Type)) pi.registerTool(tool);

  // Durability barrier: the turn is not "done" until the touched bundles are
  // stored. The user is told the wiki changed only after this resolves.
  pi.on("agent_end", async () => {
    if (store.hasPendingWrites()) {
      await store.flushDirty(`conversation ${scope} — ${user}`);
    }
  });
}
