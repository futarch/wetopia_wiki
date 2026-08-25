// One colour and one French label per charter type, so the shape of the wiki
// reads at a glance.
//
// Kept out of graph.tsx on purpose: that module pulls in sigma, which needs
// WebGL and cannot be evaluated on the server. Anything the server-rendered
// tree touches imports from here instead.
export const TYPE_COLOURS: Record<string, string> = {
  Person: "#2e6b4e",
  Organization: "#3f6ea8",
  Place: "#a8763f",
  Project: "#7a3fa8",
  Concept: "#3f9aa8",
  Event: "#a83f6e",
  Task: "#8a8f3f",
  Decision: "#6b3f2e",
};

/** The charter keeps type names in English; people read them in French. */
export const TYPE_LABELS: Record<string, string> = {
  Person: "Personne",
  Organization: "Organisation",
  Place: "Lieu",
  Project: "Projet",
  Concept: "Concept",
  Event: "Événement",
  Task: "Tâche",
  Decision: "Décision",
};

export const MISSING_COLOUR = "#b9c0b6";
export const typeColour = (type: string) => TYPE_COLOURS[type] ?? "#7d8a80";
export const typeLabel = (type: string) => TYPE_LABELS[type] ?? type;
export const TYPES = Object.keys(TYPE_COLOURS);
