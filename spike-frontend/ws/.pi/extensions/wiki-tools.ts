// Extension discovered by pi from <cwd>/.pi/extensions/.
// If react-pi's supervisor (which only passes `cwd`) picks this up, our
// custom wiki tools reach the agent WITHOUT patching react-pi.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "wiki_marker",
    label: "Wiki Marker",
    description:
      "Outil de test Wetopia. Retourne une marque prouvant que l'outil custom a bien été appelé.",
    parameters: Type.Object({
      note: Type.String({ description: "un mot à inclure dans la marque" }),
    }),
    execute: async (_id: string, params: { note: string }) => ({
      content: [{ type: "text", text: `WIKI_TOOL_OK:${params.note}` }],
      details: {},
    }),
  });
}
