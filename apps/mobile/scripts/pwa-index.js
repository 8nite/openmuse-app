// Post-export patch: inject PWA tags into dist/web/index.html.
// Expo emits theme-color/description/favicon from app.json but no manifest link,
// apple-touch-icon, or service-worker registration. This keeps those in static
// HTML so installability doesn't depend on runtime JS injection.
const fs = require("node:fs");
const path = require("node:path");

const outDir = path.join(__dirname, "..", "dist", "web");
const indexPath = path.join(outDir, "index.html");
if (!fs.existsSync(indexPath)) {
  console.error(`pwa-index: ${indexPath} not found, skipping`);
  process.exit(0);
}
let html = fs.readFileSync(indexPath, "utf8");
const tags = [
  `<link rel="manifest" href="/manifest.webmanifest">`,
  `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`,
  `<meta name="mobile-web-app-capable" content="yes">`,
  `<meta name="apple-mobile-web-app-capable" content="yes">`,
  `<meta name="apple-mobile-web-app-status-bar-style" content="default">`,
  `<meta name="apple-mobile-web-app-title" content="OpenMuse">`,
];
for (const tag of tags) {
  if (!html.includes(tag)) html = html.replace("</head>", `  ${tag}\n</head>`);
}
// Service-worker registration (guarded; no-op where unsupported).
const swSnippet = `<script>if("serviceWorker" in navigator){window.addEventListener("load",function(){navigator.serviceWorker.register("/sw.js").catch(function(){})})}</script>`;
if (!html.includes("sw.js")) html = html.replace("</body>", `  ${swSnippet}\n</body>`);
fs.writeFileSync(indexPath, html);
console.log("pwa-index: patched", indexPath);
