// Three-pane check: chat (assistant-ui) | graph (sigma) | page (react-markdown).
//
// Credentials come from the environment, never the repository — see
// lib/ui.check.mjs for the same rule.
//   WETOPIA_TEST_EMAIL=… WETOPIA_TEST_PASSWORD=… node panes.check.mjs [url]
import { chromium } from "playwright";

const base = process.argv[2] ?? process.env.WETOPIA_BASE_URL ?? "http://localhost:3200";
const EMAIL = process.env.WETOPIA_TEST_EMAIL;
const PASSWORD = process.env.WETOPIA_TEST_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error("WETOPIA_TEST_EMAIL et WETOPIA_TEST_PASSWORD sont requis.");
  process.exit(2);
}

const b = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
const ctx = await b.newContext({ viewport: { width: 1600, height: 900 }, permissions: ["microphone"] });
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push("pageerror: " + e.message));
p.on("console", (m) => {
  if (m.type() === "error" && !/favicon/i.test(m.text())) errs.push("console: " + m.text().slice(0, 160));
});
let fails = 0;
const ok = (n, c) => {
  console.log(` ${c ? "✓" : "✗"} ${n}`);
  if (!c) fails++;
};

await p.goto(base, { waitUntil: "networkidle" });
await p.getByLabel("Adresse e-mail").fill(EMAIL);
await p.getByLabel("Mot de passe").fill(PASSWORD);
await p.getByRole("button", { name: "Se connecter" }).click();
await p.waitForSelector(".composer textarea:not([disabled])", { timeout: 90000 });

// --- layout ---
ok("trois panneaux présents", (await p.locator(".pane").count()) === 3);
const order = await p.locator(".pane").evaluateAll((els) => els.map((e) => e.className.replace("pane ", "")));
ok(
  `ordre gauche→droite : ${order.join(" | ")}`,
  order[0].includes("chat") && order[1].includes("graph") && order[2].includes("page"),
);
ok("panneau page en attente", (await p.locator(".pane-page .pane-empty").innerText()).includes("Aucune page"));

// --- header ---
const topbar = await p.locator(".topbar").innerText();
ok("plus de sous-titre « Le wiki de la communauté »", !topbar.includes("wiki de la communauté"));
ok("prénom et nom affichés", /\p{L}+\s+\p{L}+/u.test(await p.locator(".who span").innerText()));
ok("plus de bandeau de portée", (await p.locator(".scope-line").count()) === 0);
ok("le toggle est dans le panneau chat", (await p.locator(".pane-chat .composer .scope-switch").count()) === 1);
ok("le toggle n'est plus dans l'en-tête", (await p.locator(".topbar .scope-switch").count()) === 0);

// --- composer ---
const ta = p.locator(".pane-chat .composer textarea");
ok("placeholder « Écrire… »", (await ta.getAttribute("placeholder")) === "Écrire…");
const wide = await p.locator(".pane-chat .composer").evaluate((el) => {
  const t = el.querySelector("textarea").getBoundingClientRect();
  const f = el.querySelector("form").getBoundingClientRect();
  const row = el.querySelector(".composer-row").getBoundingClientRect();
  return { full: t.width / f.width, below: row.top >= t.bottom - 1 };
});
ok(`la barre prend toute la largeur (${Math.round(wide.full * 100)} %)`, wide.full > 0.97);
ok("toggle, micro et envoi sont en dessous", wide.below);
ok("bouton micro présent", (await p.locator('.pane-chat .composer button[aria-label="Dicter"]').count()) === 1);
const icon = await p.locator('.pane-chat .composer button[aria-label="Dicter"] svg').getAttribute("class");
ok(`icône lucide pour la dictée (${icon})`, /lucide/.test(icon ?? ""));

// Entrée = retour à la ligne ; seul « Envoyer » soumet.
await ta.fill("première ligne");
await ta.press("Enter");
await ta.type("deuxième ligne");
ok("Entrée insère un saut de ligne", (await ta.inputValue()).includes("\n"));
ok("Entrée n'envoie pas le message", (await p.locator(".row[data-role='user']").count()) === 0);
await ta.fill("");

// --- vouvoiement ---
const empty = await p.locator(".pane-chat .empty").innerText();
ok(`vouvoiement dans la description (« ${empty.split("\n").pop().slice(0, 46)}… »)`, /\bvos\b|\bvous\b/.test(empty) && !/\btes\b|\btoi\b|\bchez toi\b/.test(empty));

// --- graph ---
await p.waitForTimeout(2500);
await p.waitForSelector(".pane-graph canvas", { timeout: 60000 }).catch(() => {});
ok("graphe rendu (canvas sigma)", (await p.locator(".pane-graph canvas").count()) > 0);

// Sigma draws to a canvas, so there is no element to target. Click empty space
// once: the app reports where sigma placed each node (viewport coordinates,
// relative to the graph pane), then aim at the first one.
const box = await p.locator(".pane-graph").boundingBox();
let places = [];
p.on("console", (m) => {
  const t = m.text();
  const i = t.indexOf("[");
  if (!t.includes("sigma place") || i < 0) return;
  try {
    places = JSON.parse(t.slice(i));
  } catch {
    /* keep the previous reading */
  }
});
/**
 * Ask the app where sigma put each node right now. Only a click on empty stage
 * publishes them, and a corner can happen to hold a node, so try a few.
 */
async function readPlaces() {
  const corners = [
    [8, 8],
    [box.width - 8, box.height - 8],
    [8, box.height - 8],
    [box.width - 8, 8],
  ];
  for (const [dx, dy] of corners) {
    places = [];
    await p.mouse.click(box.x + dx, box.y + dy);
    for (let i = 0; i < 20 && !places.length; i++) await p.waitForTimeout(100);
    if (places.length) break;
  }
  if (process.env.DEBUG_PLACES) console.log("    places:", JSON.stringify(places));
  return places;
}

/** Sigma resolves clicks from its own pointer state, so hover before pressing. */
async function clickAt(x, y) {
  await p.mouse.move(x, y);
  await p.waitForTimeout(300);
  await p.mouse.click(x, y);
}

let opened = null;
for (const n of await readPlaces()) {
  await clickAt(box.x + n.vx, box.y + n.vy);
  await p.waitForTimeout(900);
  if (await p.locator(".pane-page .page").count()) {
    opened = n;
    break;
  }
}
ok("clic sur un nœud ouvre la page à droite", !!opened);
if (opened) {
  const head = await p.locator(".pane-page .page-head").innerText();
  console.log("    page ouverte :", head.replace(/\n/g, " · "));
  ok("la page affiche du markdown rendu", (await p.locator(".pane-page .page-body").count()) > 0);
  ok("le chemin du fichier n'est pas affiché", (await p.locator(".pane-page .page-head code").count()) === 0);
  const chip = await p.locator(".pane-page .type-chip").count();
  if (chip) {
    const t = await p.locator(".pane-page .type-chip").innerText();
    ok(`type en français (« ${t} »)`, !/^(Person|Organization|Place|Project|Event|Task|Decision)$/.test(t));
  }

  // --- dragging: the node follows the pointer, the others stay put ---
  const before = await readPlaces();
  await p.mouse.move(box.x + opened.vx, box.y + opened.vy);
  await p.waitForTimeout(300);
  await p.mouse.down();
  await p.mouse.move(box.x + opened.vx + 90, box.y + opened.vy + 60, { steps: 14 });
  await p.mouse.up();
  await p.waitForTimeout(400);
  const after = await readPlaces();
  const at = (list, id) => list.find((n) => n.id === id);
  const shift = (id) => {
    const a = at(before, id);
    const b = at(after, id);
    return a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
  };
  const pulled = shift(opened.id);
  const others = before.filter((n) => n.id !== opened.id).map((n) => shift(n.id));
  ok(`le nœud tiré se déplace (${pulled.toFixed(1)} en unités du graphe)`, pulled > 1);
  ok(
    `les autres nœuds ne bougent pas (max ${Math.max(0, ...others).toFixed(3)})`,
    others.every((d) => d < 0.001),
  );
}

// --- the barrier, seen from the interface ---
// Private scope may show both spaces; shared scope must never name a private
// page. wiki-view.test.ts proves this on the server; this is the same claim
// checked through the browser.
const inPrivate = await readPlaces();
ok(
  `la portée privée montre les deux espaces (${inPrivate.filter((n) => n.id.startsWith("/users/")).length} privé(s), ${inPrivate.filter((n) => n.id.startsWith("/shared/")).length} partagé(s))`,
  inPrivate.length > 0,
);
await p.locator(".scope-switch button", { hasText: "Partagé" }).click();
await p.waitForSelector(".composer textarea:not([disabled])", { timeout: 90000 });
await p.waitForTimeout(3000);
const shared = await readPlaces();
ok(
  `aucune page privée en portée partagée (${shared.length} nœud(s))`,
  shared.length > 0 && shared.every((n) => n.id.startsWith("/shared/")),
);

await p.screenshot({ path: "/tmp/panes.png" });
await b.close();
if (errs.length) {
  console.log("ERREURS :");
  errs.slice(0, 5).forEach((e) => console.log("  -", e));
}
console.log(`\n${fails === 0 && errs.length === 0 ? "✓ interface trois panneaux conforme" : `✗ ${fails} échec(s), ${errs.length} erreur(s)`}`);
process.exit(fails === 0 && errs.length === 0 ? 0 : 1);
