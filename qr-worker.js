// QR detection off the main thread, so a slow decode never stalls rendering.
// jsQR reports the four outer corners of the symbol (finder-pattern edges, not
// the quiet zone), in the QR's own orientation: TL, TR, BR, BL.
importScripts('vendor/jsqr/jsQR.js');

// jsQR copes with light-on-dark ("inverted") codes only when the dark field is
// near black: in a flat mid-tone area its binarizer calls everything light. The
// invitation prints warm-white modules on a pink field, which it therefore
// misses. So each frame is first thresholded against a large local mean
// (window ~1/6 of the frame, which always spans the code and its quiet zone) and
// handed over as pure black/white, where either polarity decodes reliably.
//
// A pixel counts as bright only if it is clearly brighter than its surroundings
// (BIAS). Flat areas then come out solid, not as camera-noise speckle, which swamps
// jsQR with false finder patterns -- and they become exactly the quiet zone an
// inverted code needs; ordinary dark-on-light codes are covered by the raw pass.
const BIAS = 10;
let tick = 0;

function binarize(rgba, w, h) {
  const n = w * h, lum = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4)            // integer Rec.709 luma
    lum[i] = (54 * rgba[j] + 183 * rgba[j + 1] + 19 * rgba[j + 2]) >> 8;
  // integral image for O(1) box means (max 1280*1280*255 fits in 32 bits)
  const W = w + 1, S = new Uint32Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    const o = (y + 1) * W + 1, p = y * W + 1, q = y * w;
    for (let x = 0; x < w; x++) { row += lum[q + x]; S[o + x] = S[p + x] + row; }
  }
  const r = Math.max(8, Math.round(Math.max(w, h) / 12));
  const out = new Uint8ClampedArray(n * 4), out32 = new Uint32Array(out.buffer);
  const BLACK = 0xff000000, WHITE = 0xffffffff;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    const a0 = y0 * W, a1 = y1 * W, q = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const sum = S[a1 + x1] - S[a0 + x1] - S[a1 + x0] + S[a0 + x0];
      // bright -> BLACK: see detectBinarized
      out32[q + x] = lum[q + x] * (y1 - y0) * (x1 - x0) > sum + BIAS * (y1 - y0) * (x1 - x0)
        ? BLACK : WHITE;
    }
  }
  return out;
}

// binarize() writes bright pixels as BLACK, i.e. it already inverts, so a
// light-on-dark code (the invitation) comes out as an ordinary one and a single
// jsQR pass suffices. (jsQR 1.4's own 'onlyInvert' option crashes.) The raw pass
// is the fallback for an ordinary dark-on-light code, tried every third frame.
function detectBinarized(rgba, w, h) {
  return jsQR(binarize(rgba, w, h), w, h, { inversionAttempts: 'dontInvert' });
}
function detectRaw(rgba, w, h) {
  return jsQR(rgba, w, h, { inversionAttempts: 'attemptBoth' });
}

self.onmessage = e => {
  // ctx (crop offset and scale) is passed straight back so the page can map
  // the corners to video pixels
  const { buf, width, height, ctx } = e.data;
  const rgba = new Uint8ClampedArray(buf);
  let r = detectBinarized(rgba, width, height);
  if (!r && tick++ % 3 === 0) r = detectRaw(rgba, width, height);
  const L = r && r.location;
  self.postMessage({
    ctx,
    corners: L ? [L.topLeftCorner, L.topRightCorner,
                  L.bottomRightCorner, L.bottomLeftCorner] : null,
  });
};
