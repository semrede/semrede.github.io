// Renders flyer-drafts/flyer.html into a PNG poster (A4 at 150dpi).
// Needs a local web server for the images and a headless browser on the CDP
// port; see the README for the exact commands.
import { chromium } from '../tools/node_modules/playwright-core/index.mjs';
const target = process.argv[2] || 'http://localhost:8782/flyer-drafts/flyer.html';
const out = process.argv[3] || 'flyer-drafts/semrede-2026-flyer.png';
const browser = await chromium.connectOverCDP(process.env.CDP || 'http://localhost:9393');
const page = await browser.contexts()[0].newPage();
await page.setViewportSize({ width: 1240, height: 1754 });
await page.goto(target, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.screenshot({ path: out });
console.log('wrote', out);
process.exit(0);
