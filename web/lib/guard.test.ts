// Standalone security regression suite for the Wetopia path guard.
// Deterministic: no model, no API key, runs in milliseconds.
//   node guard.test.mjs
//
// Every "bypass" case below is a payload the pre-build audit proved could
// defeat the previous guard. They must stay refused forever.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSessionContext } from "./guard.ts";

const results = [];
const check = (name, cond) => results.push([name, !!cond]);

// -- fixture: a throwaway wiki tree with two users --
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wetopia-guard-"));
for (const d of ["shared/people", "users/albert", "users/marie"]) {
  fs.mkdirSync(path.join(dataRoot, d), { recursive: true });
}
fs.writeFileSync(path.join(dataRoot, "shared/index.md"), "# index\n");
fs.writeFileSync(path.join(dataRoot, "shared/AGENTS.md"), "# charte\n");
fs.writeFileSync(path.join(dataRoot, "users/albert/profile.md"), "SECRET-ALBERT\n");
fs.writeFileSync(path.join(dataRoot, "users/marie/secret.md"), "SECRET-MARIE\n");

const priv = createSessionContext({ dataRoot, user: "albert", scope: "private" });
const shar = createSessionContext({ dataRoot, user: "albert", scope: "shared" });
type Ctx = ReturnType<typeof createSessionContext>;
type Opts = { forWrite?: boolean };
const denied = (ctx: Ctx, p: unknown, opts?: Opts) => {
  try {
    ctx.resolveBundlePath(p as string, opts);
    return false;
  } catch {
    return true;
  }
};
const allowed = (ctx: Ctx, p: unknown, opts?: Opts) => !denied(ctx, p, opts);

// ---- baseline: the guard must not be uselessly strict ----
check("lire /shared/index.md (privé)", allowed(priv, "/shared/index.md"));
check("lire /shared/index.md (partagé)", allowed(shar, "/shared/index.md"));
check("lire son propre bundle (privé)", allowed(priv, "/users/albert/profile.md"));
check("écrire son propre bundle (privé)", allowed(priv, "/users/albert/x.md", { forWrite: true }));
check("écrire /shared (partagé)", allowed(shar, "/shared/x.md", { forWrite: true }));
check("écrire une page inexistante en profondeur (privé)", allowed(priv, "/users/albert/a/b/c.md", { forWrite: true }));

// ---- charter §3: the information barrier ----
check("barrière : lire le privé en scope partagé refusé", denied(shar, "/users/albert/profile.md"));
check("barrière : écrire le privé en scope partagé refusé", denied(shar, "/users/albert/x.md", { forWrite: true }));
check("charte §10 : écrire /shared en scope privé refusé", denied(priv, "/shared/x.md", { forWrite: true }));
check("cross-user : lire le bundle de Marie refusé", denied(priv, "/users/marie/secret.md"));
check("cross-user : écrire chez Marie refusé", denied(priv, "/users/marie/x.md", { forWrite: true }));

// ---- CRITIQUE 1 (audit) : raw-string checks vs resolved path ----
check("bypass .. : partagé lit le privé", denied(shar, "/shared/../users/albert/profile.md"));
check("bypass .. imbriqué : partagé lit le privé", denied(shar, "/shared/a/b/../../../users/albert/profile.md"));
check("bypass .. : privé écrit dans /shared", denied(priv, "/users/albert/../../shared/pwned.md", { forWrite: true }));
check("bypass .. : cross-user", denied(priv, "/users/albert/../marie/secret.md"));
check("bypass /./ : écrasement de la charte", denied(shar, "/shared/./AGENTS.md", { forWrite: true }));
check("bypass // : écrasement de la charte", denied(shar, "/shared//AGENTS.md", { forWrite: true }));
check("bypass x/.. : écrasement de la charte", denied(shar, "/shared/x/../AGENTS.md", { forWrite: true }));
check("bypass casse : écrasement de la charte", denied(shar, "/shared/agents.md", { forWrite: true }));
check("charte protégée même chemin direct", denied(shar, "/shared/AGENTS.md", { forWrite: true }));
check("charte reste LISIBLE", allowed(shar, "/shared/AGENTS.md"));

// ---- malformed input ----
check("évasion hors dataRoot refusée", denied(priv, "/shared/../../etc/passwd"));
check("chemin relatif refusé", denied(priv, "shared/index.md"));
check("octet nul refusé", denied(priv, "/shared/index.md\0.txt"));
check("non-string refusé", denied(priv, 42));

// ---- MOYEN 6 (audit) : symlinks must not straddle the barrier ----
try {
  fs.symlinkSync(path.join(dataRoot, "users/marie"), path.join(dataRoot, "users/albert/evasion"), "dir");
  check("symlink vers un autre bundle refusé", denied(priv, "/users/albert/evasion/secret.md"));
  fs.symlinkSync(path.join(dataRoot, "users/albert"), path.join(dataRoot, "shared/backdoor"), "dir");
  check("symlink /shared → privé refusé en scope partagé", denied(shar, "/shared/backdoor/profile.md"));
} catch (e) {
  check("symlinks testés", false);
  console.error("symlink setup failed:", e.message);
}

// ---- CRITIQUE 2 (audit) : no ambient state between concurrent sessions ----
check("isolation : contextes concurrents indépendants", (() => {
  const a = createSessionContext({ dataRoot, user: "albert", scope: "private" });
  const b = createSessionContext({ dataRoot, user: "albert", scope: "shared" });
  const m = createSessionContext({ dataRoot, user: "marie", scope: "private" });
  a.resolveBundlePath("/users/albert/profile.md");           // a works...
  return denied(b, "/users/albert/profile.md")               // ...b stays blind
      && allowed(m, "/users/marie/secret.md")                // marie sees her own
      && denied(m, "/users/albert/profile.md")               // ...not albert's
      && allowed(a, "/users/albert/profile.md");             // a still works
})());
check("scope invalide rejeté", (() => { try { createSessionContext({ dataRoot, user: "albert", scope: "admin" }); return false; } catch { return true; } })());
check("user avec séparateur rejeté", (() => { try { createSessionContext({ dataRoot, user: "../marie", scope: "private" }); return false; } catch { return true; } })());

fs.rmSync(dataRoot, { recursive: true, force: true });

// ---- report ----
const failed = results.filter(([, ok]) => !ok);
for (const [name, ok] of results) console.log(` ${ok ? "✓" : "✗"} ${name}`);
console.log(`\n${results.length - failed.length}/${results.length} guard checks passed`);
process.exit(failed.length ? 1 : 0);
