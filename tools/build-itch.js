// Build the itch.io version: itch/index.html + sim-core.js + three.min.js, zipped as itch/cube-wars-itch.zip.
// On itch the game runs inside an iframe on itch's domain and talks to the cubewars.io server (CORS allows it).
// Run: node tools/build-itch.js            (deploy.sh also publishes the zip at https://cubewars.io/itch/)
'use strict';
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');

const root = path.join(__dirname, '..'), out = path.join(root, 'itch');
const THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const three = path.join(out, 'three.min.js');
  if (!fs.existsSync(three)) fs.writeFileSync(three, Buffer.from(await (await fetch(THREE_URL)).arrayBuffer()));

  let html = fs.readFileSync(path.join(root, 'sim.html'), 'utf8');
  const swap = (from, to) => { if (!html.includes(from)) throw new Error('not found in sim.html: ' + from); html = html.replace(from, to); };
  swap(`<script src="${THREE_URL}"></script>`,
    `<script>window.CUBE_WARS = { api: 'https://cubewars.io', site: 'https://cubewars.io/' };</script>\n<script src="three.min.js"></script>`);
  for (const tag of ['<link rel="manifest" href="manifest.webmanifest">', '<link rel="icon" type="image/png" href="icon-192.png">',
                     '<link rel="apple-touch-icon" href="icon-192.png">']) swap(tag + '\n', '');
  fs.writeFileSync(path.join(out, 'index.html'), html);
  fs.copyFileSync(path.join(root, 'sim-core.js'), path.join(out, 'sim-core.js'));

  const zip = path.join(out, 'cube-wars-itch.zip');
  if (fs.existsSync(zip)) fs.unlinkSync(zip);
  execFileSync('python3', ['-m', 'zipfile', '-c', zip, ...['index.html', 'sim-core.js', 'three.min.js'].map(f => path.join(out, f))]);
  console.log(`itch build: ${zip} (${(fs.statSync(zip).size / 1024).toFixed(0)} KB)`);
})();
