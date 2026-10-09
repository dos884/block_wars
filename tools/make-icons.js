// Render icon.svg to the PNG icons the web app manifest needs. Run: node tools/make-icons.js
'use strict';
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'icon.svg'), 'utf8');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  // [file, size, scale of the art: maskable icons keep everything inside the middle 80%]
  for (const [file, size, scale] of [['icon-192.png', 192, 1], ['icon-512.png', 512, 1], ['icon-maskable-512.png', 512, 0.78]]) {
    await p.setViewportSize({ width: size, height: size });
    await p.setContent(`<body style="margin:0;background:#bcd6e8;display:grid;place-items:center;height:${size}px">
      <div style="width:${size * scale}px;height:${size * scale}px">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div></body>`);
    await p.screenshot({ path: path.join(root, file) });
  }
  await b.close();
  console.log('icons written');
})();
