// Live check: after a real answer, the graph shows what the answer was built
// from.
//
// Worth running against a real model rather than a fixture, because the sources
// are read out of the rendered tool calls — assistant-ui's shape for those is
// the load-bearing assumption, and a version bump could change it without any
// type error. cited.test.ts covers the parsing; this covers the wiring.
//
//   WETOPIA_TEST_EMAIL=… WETOPIA_TEST_PASSWORD=… node cite.check.mjs [url]
import { chromium } from "playwright";

const base = process.argv[2] ?? process.env.WETOPIA_BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.WETOPIA_TEST_EMAIL;
const PASSWORD = process.env.WETOPIA_TEST_PASSWORD;
const QUESTION = process.env.WETOPIA_TEST_QUESTION ?? "Que sais-tu sur le compost des Balmes ?";
if (!EMAIL || !PASSWORD) {
  console.error("WETOPIA_TEST_EMAIL et WETOPIA_TEST_PASSWORD sont requis.");
  process.exit(2);
}

const b = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  args: process.env.CHECK_TLS_SPKI
    ? [`--ignore-certificate-errors-spki-list=${process.env.CHECK_TLS_SPKI}`]
    : [],
  ...(process.env.HTTPS_PROXY
    ? { proxy: { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1,::1" } }
    : {}),
});
const p = await (await b.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
const errs = [];
p.on("pageerror", (e) => errs.push("pageerror: " + e.message));

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
await p.waitForTimeout(3000);

ok("aucune surbrillance avant la question", (await p.locator(".cited-note").count()) === 0);

await p.locator(".composer textarea").fill(QUESTION);
await p.getByRole("button", { name: "Envoyer" }).click();
await p.waitForSelector(".row[data-role='assistant']", { timeout: 180000 });
for (let i = 0; i < 120; i++) {
  const busy = await p.locator(".state", { hasText: "L'agent travaille" }).count();
  if (!busy && i > 3) break;
  await p.waitForTimeout(2000);
}
await p.waitForTimeout(3000);

const tools = await p.locator(".tool code").allInnerTexts();
ok(`l'agent a consulté le wiki (${tools.length} appel(s))`, tools.length > 0);

const note = await p.locator(".cited-note").count();
ok("la surbrillance annonce les pages utilisées", note === 1);
const annonce = note ? await p.locator(".cited-note").innerText() : "";
const annoncees = Number(/^(\d+)/.exec(annonce.trim())?.[1] ?? (/^1 page/.test(annonce.trim()) ? 1 : 0));
if (note) console.log("   ", annonce.replace(/\n/g, " · "));

// The graph is a canvas: clicking empty space makes the app publish each node
// as it was drawn, which is the only way to see the highlight from outside.
let drawn = null;
p.on("console", (m) => {
  const t = m.text();
  const i = t.indexOf("[");
  if (!t.includes("sigma place") || i < 0) return;
  try {
    drawn = JSON.parse(t.slice(i));
  } catch {
    /* keep the previous reading */
  }
});
const box = await p.locator(".pane-graph").boundingBox();
const FADED = "#e2e6e0";
/** Ask the app for the nodes as drawn; only a click on empty stage publishes them. */
async function lire() {
  drawn = null;
  for (const [dx, dy] of [[8, 8], [box.width - 8, box.height - 8], [8, box.height - 8], [box.width - 8, 8]]) {
    await p.mouse.click(box.x + dx, box.y + dy);
    await p.waitForTimeout(700);
    if (drawn) return drawn;
  }
  return null;
}

const pendant = await lire();
if (!pendant) {
  ok("le graphe publie son état", false);
} else {
  const faded = pendant.filter((n) => n.color === FADED);
  const lit = pendant.filter((n) => n.color !== FADED);
  console.log(`    ${lit.length} nœud(s) en avant, ${faded.length} estompé(s) sur ${pendant.length}`);
  for (const n of lit) console.log(`      ${n.id}`);
  ok("au moins une page est mise en avant", lit.length > 0);
  // How many pages light up depends on what the agent chose to open, so the
  // property is the agreement between the two, not a fixed count.
  ok(`les nœuds en avant ne dépassent pas les ${annoncees} annoncés`, lit.length <= annoncees);
  ok("un nœud estompé ne porte pas d'étiquette", faded.every((n) => n.label === ""));
  ok("un nœud en avant garde la sienne", lit.every((n) => n.label !== ""));
}

await p.screenshot({ path: "/tmp/wetopia-cite.png" });
await p.getByRole("button", { name: "tout réafficher" }).click();
await p.waitForTimeout(800);
ok("« tout réafficher » retire l'annonce", (await p.locator(".cited-note").count()) === 0);

const apres = await lire();
if (!apres) {
  ok("le graphe publie son état après remise à zéro", false);
} else {
  ok("plus aucun nœud estompé", apres.every((n) => n.color !== FADED));
  ok("toutes les étiquettes sont revenues", apres.every((n) => n.label !== ""));
}

await b.close();
if (errs.length) errs.slice(0, 5).forEach((e) => console.log("  -", e));
console.log(`\n${fails === 0 && errs.length === 0 ? "✓ les sources de la réponse sont visibles sur le graphe" : `✗ ${fails} échec(s), ${errs.length} erreur(s)`}`);
process.exit(fails === 0 && errs.length === 0 ? 0 : 1);
