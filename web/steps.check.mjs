// Le bloc repliable des étapes, exercé sur un vrai tour d'agent.
//
// Il faut un serveur qui parle au modèle : ce contrôle fait travailler l'agent
// pour de bon, c'est tout l'intérêt. Identifiants par l'environnement, jamais
// par le dépôt — même règle que panes.check.mjs.
//
//   WETOPIA_TEST_EMAIL=… WETOPIA_TEST_PASSWORD=… node steps.check.mjs [url]
import { chromium } from "playwright";

const base = process.argv[2] ?? process.env.WETOPIA_BASE_URL ?? "http://localhost:3200";
const EMAIL = process.env.WETOPIA_TEST_EMAIL;
const PASSWORD = process.env.WETOPIA_TEST_PASSWORD;
const SHOT = process.env.SHOT_DIR;
if (!EMAIL || !PASSWORD) {
  console.error("WETOPIA_TEST_EMAIL et WETOPIA_TEST_PASSWORD sont requis.");
  process.exit(2);
}

const b = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  args: process.env.CHECK_TLS_SPKI ? [`--ignore-certificate-errors-spki-list=${process.env.CHECK_TLS_SPKI}`] : [],
  ...(process.env.HTTPS_PROXY
    ? { proxy: { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1,::1" } }
    : {}),
});
const ctx = await b.newContext({ viewport: { width: 1600, height: 900 } });
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push("pageerror: " + e.message));
p.on("console", (m) => {
  if (m.type() === "error" && !/favicon/i.test(m.text())) errs.push("console: " + m.text().slice(0, 200));
});

let fails = 0;
const ok = (n, c, extra = "") => {
  console.log(` ${c ? "✓" : "✗"} ${n}${extra ? " — " + extra : ""}`);
  if (!c) fails++;
};

await p.goto(base, { waitUntil: "networkidle" });
await p.getByLabel("Adresse e-mail").fill(EMAIL);
await p.getByLabel("Mot de passe").fill(PASSWORD);
await p.getByRole("button", { name: "Se connecter" }).click();
await p.waitForSelector(".composer textarea:not([disabled])", { timeout: 90000 });

// L'état « en cours » ne dure que le temps d'attente réel ; l'échantillonner
// depuis le pilote le manque. Un observateur dans la page date chaque état,
// y compris ceux qui ne tiennent qu'une frame — c'est ainsi qu'on a pris en
// défaut une version où il tenait 25 ms.
await p.evaluate(() => {
  window.__steps = [];
  const t0 = performance.now();
  const snap = () => {
    const bubble = document.querySelector('.pane-chat [data-role="assistant"] .bubble');
    const after = bubble
      ? [...bubble.children].filter((c) => !c.classList.contains("steps")).map((c) => `${c.tagName.toLowerCase()}:${(c.textContent ?? "").length}`).join(",")
      : "";
    const state =
      [...document.querySelectorAll(".pane-chat .steps")]
        .map((e) => `${e.getAttribute("data-running")}|${e.hasAttribute("open") ? "ouvert" : "fermé"}|${e.querySelector("summary")?.textContent?.trim()}`)
        .join(" ;; ") + `  ⟨après le bloc : ${after || "rien"}⟩`;
    const last = window.__steps.at(-1);
    if (!last || last.state !== state) window.__steps.push({ t: Math.round(performance.now() - t0), state });
  };
  new MutationObserver(snap).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  snap();
});

// Une question à laquelle on ne peut répondre qu'en allant lire le wiki.
await p.locator(".pane-chat .composer textarea").fill("Qui est René Dupont et à quel projet participe-t-il ?");
await p.getByRole("button", { name: "Envoyer" }).click();
// Fin réelle du tour : le bouton redevient « Envoyer ».
await p.waitForSelector('.pane-chat .composer button[type="submit"]:has-text("Envoyer")', { timeout: 120000 });
await p.waitForTimeout(400);

// --- pendant le travail ---
const log = await p.evaluate(() => window.__steps);
const runs = log.filter((e) => e.state.includes("true|"));
const first = runs[0];
const left = first ? log.find((e) => e.t > first.t && !e.state.includes("true|")) : null;
const heldFor = first && left ? left.t - first.t : 0;

if (!runs.length) {
  console.log("  relevé brut de l'observateur :");
  for (const e of log) console.log(`    ${String(e.t).padStart(6)} ms  ${e.state || "(aucun bloc)"}`);
}
ok("l'état « en cours » apparaît", runs.length > 0);
ok("il annonce « Consultation du wiki… »", !!first?.state.includes("Consultation du wiki…"), first?.state ?? "");
ok("il est fermé pendant le travail", !!first?.state.includes("|fermé|"));
// Le seuil garde contre la régression trouvée : un état juste, mais invisible.
ok("il tient assez longtemps pour être lu (≥ 300 ms)", heldFor >= 300, `${heldFor} ms`);

// --- une fois fini ---
const block = p.locator('.pane-chat [data-role="assistant"]').last().locator(".steps");
ok("un bloc et un seul pour ce tour", (await block.count()) === 1, `${await block.count()}`);
const doneLabel = (await block.innerText()).split("\n")[0].trim();
ok("libellé final « N étape(s) dans le wiki »", /^\d+ étapes? dans le wiki$/.test(doneLabel), doneLabel);

const claimed = Number(doneLabel.match(/^(\d+)/)?.[1] ?? -1);
ok("l'accord suit le compte", claimed === 1 ? /^1 étape /.test(doneLabel) : /^\d+ étapes /.test(doneLabel));
ok("fermé par défaut", !(await block.evaluate((e) => e.hasAttribute("open"))));
ok("le détail est masqué tant qu'il est fermé", !(await block.locator(".steps-body").isVisible()));
if (SHOT) await p.screenshot({ path: `${SHOT}/steps-closed.png` });

// --- on l'ouvre ---
await block.locator("summary").click();
await p.waitForTimeout(250);
ok("un clic l'ouvre", await block.evaluate((e) => e.hasAttribute("open")));
ok("le détail devient visible", await block.locator(".steps-body").isVisible());
const shown = await block.locator(".steps-body .tool").count();
ok("le compte annoncé correspond aux étapes montrées", shown === claimed, `annoncé ${claimed}, montré ${shown}`);
const toolText = (await block.locator(".steps-body").innerText()).replace(/\n/g, " | ");
ok(
  "les étapes sont nommées en français",
  /lecture d'une page|recherche dans le wiki|écriture d'une page|mise à jour du journal/.test(toolText),
  toolText.slice(0, 110),
);
if (SHOT) await p.screenshot({ path: `${SHOT}/steps-open.png` });

// --- ce que le regroupement devait corriger ---
const loose = await p
  .locator('.pane-chat [data-role="assistant"] .tool')
  .evaluateAll((els) => els.filter((e) => !e.closest(".steps-body")).length);
ok("aucun appel d'outil à plat hors du bloc", loose === 0, `${loose} à plat`);

const bubble = p.locator('.pane-chat [data-role="assistant"] .bubble').last();
const answer = (await bubble.innerText()).replace(doneLabel, "").replace(toolText, "").trim();
ok("l'agent a répondu", answer.length > 40, `${answer.length} caractères`);
ok(
  "le bloc est au-dessus de la réponse",
  await bubble.evaluate((el) => [...el.children].findIndex((k) => k.classList.contains("steps")) === 0),
);

// indicator="never" : le composeur dit déjà que l'agent travaille.
const dots = await p
  .locator('.pane-chat [data-role="assistant"] .aui-indicator, .pane-chat [data-role="assistant"] [data-indicator]')
  .count();
ok("pas de second indicateur sous le message", dots === 0, `${dots} trouvé(s)`);

if (errs.length) console.log(`\nerreurs de page :\n  ${errs.join("\n  ")}`);
console.log(`\n${fails === 0 && !errs.length ? "✓ tout passe" : `✗ ${fails} échec(s), ${errs.length} erreur(s) de page`}`);
await b.close();
process.exit(fails === 0 && errs.length === 0 ? 0 : 1);
