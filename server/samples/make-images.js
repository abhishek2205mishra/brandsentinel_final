// Generates sample PNGs: on-brand, off-brand, stretched logo. Run: node samples/make-images.js
const { PNG } = require('pngjs');
const fs = require('fs'); const path = require('path');
function make(name, w, h, bg, fg) {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (w * y + x) << 2; const inBox = x > w * 0.3 && x < w * 0.7 && y > h * 0.3 && y < h * 0.7;
    const c = inBox ? fg : bg; p.data[i] = c[0]; p.data[i + 1] = c[1]; p.data[i + 2] = c[2]; p.data[i + 3] = 255;
  }
  fs.writeFileSync(path.join(__dirname, name), PNG.sync.write(p));
}
make('on-brand.png', 400, 400, [0x2b, 0x1d, 0x14], [0xf3, 0xe9, 0xdc]);
make('off-brand.png', 400, 400, [0xff, 0x00, 0xff], [0x00, 0xff, 0x00]);
make('stretched-logo.png', 600, 150, [0xf3, 0xe9, 0xdc], [0x2b, 0x1d, 0x14]);
console.log('Sample images written.');
