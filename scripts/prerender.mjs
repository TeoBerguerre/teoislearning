// Poor-man's prerender: serves the freshly built dist/, lets the SPA render
// /blog and /blog/:slug in a real browser (so the per-route <title>,
// <meta>, canonical and JSON-LD from useSEO are actually in the markup),
// then snapshots the resulting HTML to disk. Crawlers/social-share bots
// that don't execute JS get real per-post meta instead of the generic
// index.html shell; browsers get the same bundle and just re-render/
// hydrate normally on top of it.
import { readdirSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(root, "dist");
const postsDir = path.join(root, "src", "posts");

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".txt": "text/plain",
  ".xml": "application/xml",
};

function serveDist(port) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      let filePath = path.join(distDir, urlPath);
      if (!path.extname(filePath)) filePath = path.join(distDir, "index.html");
      try {
        const body = readFileSync(filePath);
        res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] ?? "application/octet-stream" });
        res.end(body);
      } catch {
        const fallback = readFileSync(path.join(distDir, "index.html"));
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(fallback);
      }
    });
    server.listen(port, () => resolve(server));
  });
}

const port = 4173;
const server = await serveDist(port);

// Prerendering is an SEO enhancement, not a build requirement — if Chromium
// isn't installed on this machine (`npx playwright install chromium`),
// skip it rather than fail the whole build. The site still works fine as a
// plain client-rendered SPA without it.
// Playwright refuses to load on Node < 20 (it calls process.exit(1) on
// import), so check first and skip instead of failing the build.
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 20) {
  console.warn(`[prerender] skipped — Node ${process.versions.node} is too old for Playwright (needs 20+).`);
  server.close();
  process.exit(0);
}

let browser;
try {
  const { chromium } = await import("playwright");
  browser = await chromium.launch();
} catch (err) {
  console.warn(`[prerender] skipped — Chromium unavailable (${err.message.split("\n")[0]}).`);
  console.warn("[prerender] run `npx playwright install chromium` to enable prerendering.");
  server.close();
  process.exit(0);
}

const page = await browser.newPage();

const slugs = readdirSync(postsDir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
const routes = [{ url: "/blog", waitFor: "h1", out: "blog/index.html" },
  ...slugs.map((slug) => ({ url: `/blog/${slug}`, waitFor: "article h1", out: `blog/${slug}/index.html` }))];

for (const route of routes) {
  await page.goto(`http://localhost:${port}${route.url}`, { waitUntil: "networkidle" });
  await page.waitForSelector(route.waitFor, { timeout: 5000 });
  await page.waitForTimeout(50); // let the useSEO effect commit meta/JSON-LD
  const html = await page.content();
  const outPath = path.join(distDir, route.out);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);
  console.log(`prerendered ${route.url} -> dist/${route.out}`);
}

await browser.close();
server.close();
