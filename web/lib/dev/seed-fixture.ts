// Development fixture: a few pages in both spaces, so the graph, the scope tag
// and the browser checks have something to work on.
//
// Written through the store, like everything else that touches the wiki: a file
// dropped into the working tree is wiped the next time a bundle is restored.
//
//   npm run seed:dev
//
// Never runs in production — it refuses to touch a wiki that already has pages.
import fs from "node:fs";
import path from "node:path";
import { boot } from "../agent/runtime.ts";
import { config } from "../server/config.ts";

const USER = process.env.WETOPIA_DEV_USER ?? "albert-dessaint";

const shared: Record<string, string> = {
  "people/rene-dupont.md": `---
type: Person
title: "René Dupont"
description: "Maraîcher installé dans les Balmes, référent compost."
tags: [permaculture, balmes]
generated: { by: "fixture-de-developpement", at: "2026-08-25T09:00:00Z" }
---

# René Dupont

René Dupont est maraîcher dans les Balmes. Il anime l'atelier compost et
connaît bien le [Compost des Balmes](/shared/projects/compost-des-balmes.md).
`,
  "projects/compost-des-balmes.md": `---
type: Project
title: "Compost des Balmes"
description: "Le compost partagé du quartier des Balmes."
generated: { by: "fixture-de-developpement", at: "2026-08-25T09:00:00Z" }
---

# Compost des Balmes

Compost partagé du quartier, animé par [René Dupont](/shared/people/rene-dupont.md)
et installé aux [Balmes](/shared/places/les-balmes.md).
`,
  "index.md": `# Index du wiki partagé

- [René Dupont](/shared/people/rene-dupont.md) — maraîcher, référent compost.
- [Compost des Balmes](/shared/projects/compost-des-balmes.md) — le compost partagé du quartier.
`,
};

const priv = (user: string): Record<string, string> => ({
  "people/rene-dupont.md": `---
type: Person
title: "René Dupont"
description: "Mes notes personnelles sur René."
generated: { by: "fixture-de-developpement", at: "2026-08-25T09:00:00Z" }
---

# René Dupont

Voir la [fiche partagée](/shared/people/rene-dupont.md). Rencontré au marché ;
il pourrait aider sur le [compost](/users/${user}/projects/compost.md).
`,
  "projects/compost.md": `---
type: Project
title: "Mon compost de balcon"
description: "Ce que je veux essayer chez moi."
generated: { by: "fixture-de-developpement", at: "2026-08-25T09:00:00Z" }
---

# Mon compost de balcon

Essai de lombricompostage, en s'inspirant du
[Compost des Balmes](/shared/projects/compost-des-balmes.md). Demander conseil à
[René](/users/${user}/people/rene-dupont.md).
`,
  "index.md": `# Index — bundle privé de ${user}

- [René Dupont](/users/${user}/people/rene-dupont.md) — mes notes sur René.
- [Mon compost de balcon](/users/${user}/projects/compost.md) — essai à la maison.
`,
});

if (process.env.NODE_ENV === "production" && !process.env.WETOPIA_DEV_SEED_FORCE) {
  console.error("Refus : cette fixture n'a rien à faire en production.");
  process.exit(2);
}

const dataRoot = config.dataRoot;
const w = await boot({
  dataRoot,
  bundleDir: config.bundleDir,
  seedDir: config.seedDir,
  users: [USER],
});

const write = (repoDir: string, pages: Record<string, string>) => {
  for (const [rel, body] of Object.entries(pages)) {
    const file = path.join(dataRoot, repoDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
};

await w.store.write("shared", "fixture de développement", () => write("shared", shared));
await w.store.write(`users-${USER}`, "fixture de développement", () =>
  write(path.join("users", USER), priv(USER)),
);

console.log(`fixture écrite : 2 pages partagées, 2 pages privées pour ${USER}`);
