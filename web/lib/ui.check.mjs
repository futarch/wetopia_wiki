// Browser smoke test for the chat UI: create a shared conversation, send a
// message, and confirm the streamed reply reaches the page.
//   node lib/ui.check.mjs [baseUrl]
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:3100";
const shot = "/tmp/wetopia-ui.png";
// Use the environment's preinstalled Chromium rather than downloading one.
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const where = m.location?.()?.url ?? "";
  if (/favicon|icon\.svg/i.test(where + m.text())) return; // cosmetic
  problems.push(`console: ${m.text().slice(0, 200)}`);
});
page.on("requestfailed", (r) => {
  const why = r.failure()?.errorText ?? "";
  // assistant-ui aborts the message POST once SSE confirms delivery; the server
  // has already processed it (verified: exactly one user message per send).
  if (/favicon/i.test(r.url()) || (why.includes("ERR_ABORTED") && r.url().includes("/messages"))) return;
  problems.push(`request failed: ${r.url()} — ${why}`);
});
page.on("response", (r) => {
  if (r.status() >= 400 && !/favicon/i.test(r.url())) problems.push(`HTTP ${r.status()} ${r.url()}`);
});

await page.goto(base, { waitUntil: "networkidle" });
console.log("titre:", await page.title());

// The scope toggle picks the workspace the conversation will live in.
await page.getByRole("button", { name: "Partagé", exact: true }).click();
await page.getByRole("button", { name: /Nouvelle conversation/ }).click();
await page.waitForSelector(".composer textarea", { timeout: 30_000 });
console.log("badge de portée:", await page.locator(".badge").first().innerText());

await page.locator(".composer textarea").fill("Qu'est-ce que le wiki sait sur le jardin des Balmes ?");
await page.getByRole("button", { name: "Envoyer" }).click();

// Wait for the run to finish (composer returns to "Envoyer"), then for prose.
await page.getByRole("button", { name: "Envoyer" }).waitFor({ state: "visible", timeout: 240_000 });
await page.waitForFunction(
  () => {
    const rows = [...document.querySelectorAll('.row[data-role="assistant"] .bubble')];
    // Text that is not just the tool markers.
    return rows.some((r) => {
      const tools = [...r.querySelectorAll(".tool")].map((t) => t.textContent ?? "").join("");
      const all = (r.textContent ?? "").trim();
      return all.replace(tools, "").trim().length > 40;
    });
  },
  { timeout: 240_000 },
);

const reply = await page.locator('.row[data-role="assistant"] .bubble').last().innerText();
const tools = await page.locator(".tool code").allInnerTexts();
await page.screenshot({ path: shot, fullPage: false });
await browser.close();

console.log("outils affichés:", JSON.stringify(tools));
console.log("réponse (extrait):", JSON.stringify(reply.slice(0, 220)));
console.log("capture:", shot);
if (problems.length) {
  console.log("\nERREURS NAVIGATEUR:");
  for (const p of problems.slice(0, 8)) console.log(" -", p);
}
const ok = reply.length > 40 && problems.length === 0;
console.log(`\n${ok ? "✓ UI fonctionnelle" : "✗ UI en échec"}`);
process.exit(ok ? 0 : 1);
