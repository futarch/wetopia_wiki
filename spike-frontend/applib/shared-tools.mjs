export function makeMarker(pi, Type, label) {
  pi.registerTool({
    name: "app_tool",
    label: "App Tool",
    description: "Outil fourni par le code applicatif importé hors workspace.",
    parameters: Type.Object({ x: Type.String() }),
    execute: async (_id, p) => ({ content: [{ type: "text", text: `APP_IMPORT_OK:${label}:${p.x}` }], details: {} }),
  });
}
