// Browser smoke test: sign in, hold one ephemeral conversation, dictate.
//   node lib/ui.check.mjs [baseUrl]
//
// Uses Chromium's fake microphone so the dictation path (record → POST
// /api/transcribe → Mistral speech model → composer) runs end to end unattended.
import { chromium } from "playwright";

const base = process.argv[2] ?? process.env.WETOPIA_BASE_URL ?? "http://localhost:3200";
// Credentials come from the environment only. A default here would be a real
// account's password living in the repository — and it would keep working long
// after everyone forgot it was there.
const EMAIL = process.env.WETOPIA_TEST_EMAIL;
const PASSWORD = process.env.WETOPIA_TEST_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error(
    "WETOPIA_TEST_EMAIL et WETOPIA_TEST_PASSWORD sont requis.\n" +
      "  ex. WETOPIA_TEST_EMAIL=… WETOPIA_TEST_PASSWORD=… node lib/ui.check.mjs [url]",
  );
  process.exit(2);
}
const shot = "/tmp/wetopia-ui.png";

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    // CHECK_TLS_SPKI lets a sandboxed environment name the public keys of the
    // CA its proxy intercepts with. Every other certificate is still verified.
    ...(process.env.CHECK_TLS_SPKI
      ? [`--ignore-certificate-errors-spki-list=${process.env.CHECK_TLS_SPKI}`]
      : []),
  ],
  // Outbound HTTPS from such an environment goes through a local proxy; without
  // it a run against a deployed URL just resets the connection.
  ...(process.env.HTTPS_PROXY
    ? { proxy: { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1,::1" } }
    : {}),
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 860 },
  permissions: ["microphone"],
});
const page = await context.newPage();

const problems = [];
const transcribeCalls = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const where = m.location?.()?.url ?? "";
  if (/favicon|icon\.svg/i.test(where + m.text())) return;
  problems.push(`console: ${m.text().slice(0, 200)}`);
});
page.on("requestfailed", (r) => {
  const why = r.failure()?.errorText ?? "";
  // Two aborts are normal: assistant-ui drops the message POST once SSE
  // confirms delivery, and an event stream is closed when its conversation is
  // replaced (scope switch, reload).
  const benignAbort =
    why.includes("ERR_ABORTED") && (r.url().includes("/messages") || r.url().includes("/events"));
  if (/favicon/i.test(r.url()) || benignAbort) return;
  problems.push(`request failed: ${r.url()} — ${why}`);
});
page.on("response", (r) => {
  if (r.url().includes("/api/transcribe")) transcribeCalls.push(r.status());
  else if (r.status() >= 400 && !/favicon/i.test(r.url())) problems.push(`HTTP ${r.status()} ${r.url()}`);
});

let failures = 0;
const expect = (name, ok) => {
  console.log(` ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failures++;
};

// ---- sign in ----
await page.goto(base, { waitUntil: "networkidle" });
expect("écran de connexion affiché", await page.locator(".signin").isVisible());
await page.getByLabel("Adresse e-mail").fill(EMAIL);
await page.getByLabel("Mot de passe").fill(PASSWORD);
await page.getByRole("button", { name: "Se connecter" }).click();

await page.waitForSelector(".composer textarea", { timeout: 90_000 });
expect("connecté : la conversation s'ouvre seule", true);
expect("aucune liste de conversations (session unique)", (await page.locator(".thread-item").count()) === 0);

// ---- scope ----
// La portée se lit dans le composeur depuis l'interface trois panneaux. Ce
// contrôle interrogeait encore le bandeau `.scope-line`, retiré en 25a5b71 :
// il levait une exception au lieu d'échouer, donc il ne disait plus rien — ni
// que la portée était juste, ni qu'il avait cessé de la vérifier.
const scopeSwitch = page.locator(".composer .scope-switch");
const scopeNow = async () => {
  const on = scopeSwitch.locator('button[data-on="true"]');
  return (await on.count()) ? (await on.first().innerText()).trim() : "(aucune)";
};
const scopeInitiale = await scopeNow();
expect(`portée privée par défaut (${scopeInitiale})`, scopeInitiale === "Privé");

await scopeSwitch.getByRole("button", { name: "Partagé", exact: true }).click();
await page.waitForFunction(
  () => document.querySelector('.composer .scope-switch button[data-on="true"]')?.textContent?.trim() === "Partagé",
  { timeout: 30_000 },
);
// Changer de portée ouvre une autre conversation : le composeur est désactivé
// le temps qu'elle s'ouvre.
await page.waitForSelector(".composer textarea:not([disabled])", { timeout: 90_000 });
expect("bascule vers partagé (nouvelle conversation)", (await scopeNow()) === "Partagé");
expect("la conversation repart vierge", (await page.locator('.row[data-role="assistant"]').count()) === 0);

// ---- dictation ----
const mic = page.locator("button.mic").first();
const hasMic = (await mic.count()) > 0;
expect("bouton de dictée présent", hasMic);
if (hasMic) {
  await mic.click();
  await page.waitForTimeout(2500); // let the fake mic produce audio
  const stop = page.locator('button.mic[data-recording="true"]');
  if (await stop.count()) await stop.first().click();
  await page.waitForTimeout(8000); // upload + transcription round trip
  expect(
    `dictée : /api/transcribe appelé et accepté (${transcribeCalls.join(",") || "aucun appel"})`,
    transcribeCalls.length > 0 && transcribeCalls.every((s) => s === 200),
  );
}

// ---- conversation ----
await page.locator(".composer textarea").fill("Bonjour ! Que sais-tu sur le jardin des Balmes ?");
await page.getByRole("button", { name: "Envoyer" }).click();
await page.getByRole("button", { name: "Envoyer" }).waitFor({ state: "visible", timeout: 300_000 });
// Le texte de la réponse seul : le bloc d'étapes et les appels d'outils
// portent eux aussi du texte, et « 3 étapes dans le wiki » suffirait presque à
// faire passer un seuil posé sur la bulle entière.
const reponses = () =>
  [...document.querySelectorAll('.row[data-role="assistant"] .bubble')].map((r) => {
    const c = r.cloneNode(true);
    for (const n of c.querySelectorAll(".steps, .tool")) n.remove();
    return (c.textContent ?? "").trim();
  });
await page.waitForFunction(
  () =>
    [...document.querySelectorAll('.row[data-role="assistant"] .bubble')].some((r) => {
      const c = r.cloneNode(true);
      for (const n of c.querySelectorAll(".steps, .tool")) n.remove();
      return (c.textContent ?? "").trim().length > 40;
    }),
  undefined,
  { timeout: 300_000 },
);
const reply = (await page.evaluate(reponses)).at(-1) ?? "";
expect(`réponse de l'agent affichée (${reply.length} caractères)`, reply.length > 40);

await page.screenshot({ path: shot });

// ---- refresh starts a new conversation ----
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".composer textarea", { timeout: 90_000 });
expect(
  "après rafraîchissement : conversation vierge",
  (await page.locator('.row[data-role="assistant"] .bubble').count()) === 0,
);

await browser.close();

console.log(`\ncapture : ${shot}`);
if (problems.length) {
  console.log("ERREURS NAVIGATEUR :");
  for (const p of problems.slice(0, 8)) console.log(" -", p);
}
const ok = failures === 0 && problems.length === 0;
console.log(`\n${ok ? "✓ UI fonctionnelle" : `✗ ${failures} échec(s), ${problems.length} erreur(s)`}`);
process.exit(ok ? 0 : 1);
