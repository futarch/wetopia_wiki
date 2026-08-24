/** @type {import('next').NextConfig} */
export default {
  // Next writes its own AGENTS.md/CLAUDE.md; ours is the wiki charter — keep it out.
  agentRules: false,
  turbopack: { root: process.cwd() },
  // pi must stay server-side, never bundled for the browser.
  serverExternalPackages: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"],
};
