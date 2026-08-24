// Browser smoke test: sign in, hold one ephemeral conversation, dictate.
//   node lib/ui.check.mjs [baseUrl]
//
// Uses Chromium's fake microphone so the dictation path (record → POST
// /api/transcribe → Mistral speech model → composer) runs end to end unattended.
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:3100";
const EMAIL = process.env.WETOPIA_TEST_EMAIL ?? "albert.dessaint@gmail.com";
const PASSWORD = process.env.WETOPIA_TEST_PASSWORD ?? "motdepasse-solide-2026";
const shot = "/tmp/wetopia-ui.png";

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
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
expect("scope privé par défaut", (await page.locator(".scope-line").getAttribute("data-scope")) === "private");
await page.getByRole("button", { name: "Partagé", exact: true }).click();
await page.waitForFunction(
  () => document.querySelector(".scope-line")?.getAttribute("data-scope") === "shared",
  { timeout: 30_000 },
);
await page.waitForSelector(".composer textarea", { timeout: 90_000 });
expect("bascule vers partagé (nouvelle conversation)", true);

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
await page.waitForFunction(
  () => {
    const rows = [...document.querySelectorAll('.row[data-role="assistant"] .bubble')];
    return rows.some((r) => {
      const tools = [...r.querySelectorAll(".tool")].map((t) => t.textContent ?? "").join("");
      return (r.textContent ?? "").replace(tools, "").trim().length > 40;
    });
  },
  { timeout: 300_000 },
);
const reply = await page.locator('.row[data-role="assistant"] .bubble').last().innerText();
expect("réponse de l'agent affichée", reply.length > 40);

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
