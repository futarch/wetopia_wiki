import { chromium } from "playwright";
const base = "http://localhost:3200";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args:["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream"] });
const ctx = await b.newContext({ viewport: { width: 1600, height: 900 }, permissions:["microphone"] });
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", e => errs.push("pageerror: " + e.message));
p.on("console", m => { if (m.type()==="error" && !/favicon/i.test(m.text())) errs.push("console: " + m.text().slice(0,160)); });
let fails = 0;
const ok = (n, c) => { console.log(` ${c ? "✓" : "✗"} ${n}`); if (!c) fails++; };

await p.goto(base, { waitUntil: "networkidle" });
await p.getByLabel("Adresse e-mail").fill("albert.dessaint@gmail.com");
await p.getByLabel("Mot de passe").fill("mot-de-passe-local-2026");
await p.getByRole("button", { name: "Se connecter" }).click();
await p.waitForSelector(".composer textarea", { timeout: 90000 });

ok("trois panneaux présents", await p.locator(".pane").count() === 3);
const order = await p.locator(".pane").evaluateAll(els => els.map(e => e.className.replace("pane ","")));
ok(`ordre gauche→droite : ${order.join(" | ")}`, order[0].includes("chat") && order[1].includes("graph") && order[2].includes("page"));
ok("chat à gauche visible", await p.locator(".pane-chat .composer textarea").isVisible());
ok("panneau page en attente", (await p.locator(".pane-page .pane-empty").innerText()).includes("Aucune page"));

await p.waitForTimeout(2500);
await p.waitForSelector(".pane-graph canvas", { timeout: 60000 }).catch(()=>{});
ok("graphe rendu (canvas sigma)", await p.locator(".pane-graph canvas").count() > 0);

// click a node: sigma draws on canvas, so click the centre area and check the page pane
// Sigma draws to a canvas, so there is no element to target. Click empty space
// once: the app reports where sigma placed each node (viewport coordinates,
// relative to the graph pane), then aim at the first one.
const box = await p.locator(".pane-graph").boundingBox();
let places = [];
p.on("console", (m) => {
  const t = m.text();
  if (!t.includes("sigma place")) return;
  places = [...t.matchAll(/@ (\d+),(\d+)/g)].map((x) => [Number(x[1]), Number(x[2])]);
});
await p.mouse.click(box.x + 8, box.y + 8);
await p.waitForTimeout(600);
let opened = false;
for (const [nx, ny] of places) {
  await p.mouse.click(box.x + nx, box.y + ny);
  await p.waitForTimeout(1000);
  if (await p.locator(".pane-page .page").count()) { opened = true; break; }
}
ok("clic sur un nœud ouvre la page à droite", opened);
if (opened) {
  const title = await p.locator(".pane-page .page-head h2").innerText();
  console.log("    page ouverte :", title);
  ok("la page affiche du markdown rendu", await p.locator(".pane-page .page-body").count() > 0);
}
await p.screenshot({ path: "/tmp/panes.png" });
await b.close();
if (errs.length) { console.log("ERREURS :"); errs.slice(0,5).forEach(e=>console.log("  -", e)); }
console.log(`\n${fails===0 && errs.length===0 ? "✓ interface trois panneaux fonctionnelle" : `✗ ${fails} échec(s), ${errs.length} erreur(s)`}`);
process.exit(fails===0 && errs.length===0 ? 0 : 1);
