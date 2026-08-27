const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const loRcp = (a) => { const u = (0x7ef07ebb - f32u32(a)) >>> 0; return u32f32(u); };
const loRsq = (a) => { const u = (0x5f347d74 - ((f32u32(a) >>> 1)) >>> 0) >>> 0; return u32f32(u); };

function f32u32(f) { const b = new ArrayBuffer(4); new Float32Array(b)[0] = f; return new Uint32Array(b)[0]; }
function u32f32(u) { const b = new ArrayBuffer(4); new Uint32Array(b)[0] = u >>> 0; return new Float32Array(b)[0]; }

function makeImage(w, h) {
  const img = [];
  let s = 12345;
  for (let y = 0; y < h; y++) {
    img.push([]);
    for (let x = 0; x < w; x++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      img[y].push([((s >> 7) & 255) / 255, ((s >> 13) & 255) / 255, ((s >> 19) & 255) / 255]);
    }
  }
  return img;
}
function load(img, x, y) {
  const h = img.length, w = img[0].length;
  return img[clamp(y, 0, h - 1)][clamp(x, 0, w - 1)];
}
function luma3(c) { return c[2] * 0.5 + (c[0] * 0.5 + c[1]); }

function easuSet(dirLen, pp, biS, biT, biU, biV, lA, lB, lC, lD, lE) {
  let w = 0;
  if (biS) w = (1 - pp[0]) * (1 - pp[1]);
  if (biT) w = pp[0] * (1 - pp[1]);
  if (biU) w = (1 - pp[0]) * pp[1];
  if (biV) w = pp[0] * pp[1];
  const dc = lD - lC, cb = lC - lB;
  let lenX = Math.max(Math.abs(dc), Math.abs(cb));
  lenX = loRcp(lenX);
  const dirX = lD - lB;
  dirLen.dir[0] += dirX * w;
  lenX = clamp(Math.abs(dirX) * lenX, 0, 1);
  dirLen.len += lenX * lenX * w;
  const ec = lE - lC, ca = lC - lA;
  let lenY = Math.max(Math.abs(ec), Math.abs(ca));
  lenY = loRcp(lenY);
  const dirY = lE - lA;
  dirLen.dir[1] += dirY * w;
  lenY = clamp(Math.abs(dirY) * lenY, 0, 1);
  dirLen.len += lenY * lenY * w;
}

function easuTap(acc, off, dir, len, lob, clp, c) {
  const v = [off[0] * dir[0] + off[1] * dir[1], off[0] * -dir[1] + off[1] * dir[0]];
  const vx = v[0] * len[0], vy = v[1] * len[1];
  let d2 = vx * vx + vy * vy;
  d2 = Math.min(d2, clp);
  let wB = (2 / 5) * d2 - 1;
  let wA = lob * d2 - 1;
  wB *= wB; wA *= wA;
  wB = (25 / 16) * wB - (25 / 16 - 1);
  const w = wB * wA;
  acc.color[0] += c[0] * w; acc.color[1] += c[1] * w; acc.color[2] += c[2] * w;
  acc.weight += w;
}

function easuCore(img, ip, taps) {
  const inW = img[0].length, inH = img.length;
  const outW = inW * 2, outH = inH * 2;
  const con0 = [inW / outW, inH / outH, 0.5 * (inW / outW) - 0.5, 0.5 * (inH / outH) - 0.5];
  const pp0 = [ip[0] * con0[0] + con0[2], ip[1] * con0[1] + con0[3]];
  const fp = [Math.floor(pp0[0]), Math.floor(pp0[1])];
  const pp = [pp0[0] - fp[0], pp0[1] - fp[1]];
  const named = taps(fp);

  const bL = luma3(named.b), cL = luma3(named.c), iL = luma3(named.i), jL = luma3(named.j),
    fL = luma3(named.f), eL = luma3(named.e), kL = luma3(named.k), lL = luma3(named.l),
    hL = luma3(named.h), gL = luma3(named.g), oL = luma3(named.o), nL = luma3(named.n);

  const dl = { dir: [0, 0], len: 0 };
  easuSet(dl, pp, true, false, false, false, bL, eL, fL, gL, jL);
  easuSet(dl, pp, false, true, false, false, cL, fL, gL, hL, kL);
  easuSet(dl, pp, false, false, true, false, fL, iL, jL, kL, nL);
  easuSet(dl, pp, false, false, false, true, gL, jL, kL, lL, oL);

  const dir2 = [dl.dir[0] * dl.dir[0], dl.dir[1] * dl.dir[1]];
  let dirR = dir2[0] + dir2[1];
  const zro = dirR < 1 / 32768;
  dirR = loRsq(dirR);
  let dir = [dl.dir[0], dl.dir[1]];
  dirR = zro ? 1 : dirR;
  dir = zro ? [1, 1] : dir;
  dir = [dir[0] * dirR, dir[1] * dirR];

  let len = dl.len * 0.5;
  len *= len;
  const stretch = (dir[0] * dir[0] + dir[1] * dir[1]) * loRcp(Math.max(Math.abs(dir[0]), Math.abs(dir[1])));
  const len2 = [1 + (stretch - 1) * len, 1 - 0.5 * len];
  const lob = 0.5 + (1 / 4 - 0.04 - 0.5) * len;
  const clp = loRcp(lob);

  const min4 = [Math.min(Math.min(named.f[0], named.g[0]), Math.min(named.j[0], named.k[0])),
    Math.min(Math.min(named.f[1], named.g[1]), Math.min(named.j[1], named.k[1])),
    Math.min(Math.min(named.f[2], named.g[2]), Math.min(named.j[2], named.k[2]))];
  const max4 = [Math.max(Math.max(named.f[0], named.g[0]), Math.max(named.j[0], named.k[0])),
    Math.max(Math.max(named.f[1], named.g[1]), Math.max(named.j[1], named.k[1])),
    Math.max(Math.max(named.f[2], named.g[2]), Math.max(named.j[2], named.k[2]))];

  const acc = { color: [0, 0, 0], weight: 0 };
  easuTap(acc, [0, -1].map((v, idx) => v - pp[idx]), dir, len2, lob, clp, named.b);
  easuTap(acc, [1, -1].map((v, idx) => v - pp[idx]), dir, len2, lob, clp, named.c);
  easuTap(acc, [-1, 1].map((v, idx) => v - pp[idx]), dir, len2, lob, clp, named.i);
  easuTap(acc, [0, 1].map((v, idx) => v - pp[idx]), dir, len2, lob, clp, named.j);
  easuTap(acc, [-pp[0], -pp[1]], dir, len2, lob, clp, named.f);
  easuTap(acc, [-1, 0].map((v, idx) => v - pp[idx]), dir, len2, lob, clp, named.e);
  easuTap(acc, [1, 1].map((v, idx) => v - pp[idx]), dir, len2, lob, clp, named.k);
  easuTap(acc, [2, 1].map((v, idx) => v - pp[idx]), dir, len2, lob, clp, named.l);
  easuTap(acc, [2, 0].map((v, idx) => v - pp[idx]), dir, len2, lob, clp, named.h);
  easuTap(acc, [1, 0].map((v, idx) => v - pp[idx]), dir, len2, lob, clp, named.g);
  easuTap(acc, [1, 2].map((v, idx) => v - pp[idx]), dir, len2, lob, clp, named.o);
  easuTap(acc, [0, 2].map((v, idx) => v - pp[idx]), dir, len2, lob, clp, named.n);

  const r = loRcp(acc.weight);
  return [0, 1, 2].map((ch) => clamp(min4[ch], max4[ch], acc.color[ch] * r));
}

// Reference: taps read directly at their true integer positions.
function refTaps(img) {
  return (fp) => ({
    b: load(img, fp[0], fp[1] - 1),
    c: load(img, fp[0] + 1, fp[1] - 1),
    e: load(img, fp[0] - 1, fp[1]),
    f: load(img, fp[0], fp[1]),
    g: load(img, fp[0] + 1, fp[1]),
    h: load(img, fp[0] + 2, fp[1]),
    i: load(img, fp[0] - 1, fp[1] + 1),
    j: load(img, fp[0], fp[1] + 1),
    k: load(img, fp[0] + 1, fp[1] + 1),
    l: load(img, fp[0] + 2, fp[1] + 1),
    n: load(img, fp[0], fp[1] + 2),
    o: load(img, fp[0] + 1, fp[1] + 2),
  });
}

// Emulated gather path, mirrors shaders.ts exactly.
function emuTaps(img) {
  return (fp) => {
    const gatherRGB = (q) => {
      const base = [Math.floor(q[0] - 0.5), Math.floor(q[1] - 0.5)];
      const A = load(img, base[0], base[1]);
      const B = load(img, base[0] + 1, base[1]);
      const C = load(img, base[0], base[1] + 1);
      const D = load(img, base[0] + 1, base[1] + 1);
      return [C, D, B, A];
    };
    const q0 = [fp[0] + 1, fp[1] - 1];
    const bczz = gatherRGB(q0);
    const ijfe = gatherRGB([q0[0] - 1, q0[1] + 2]);
    const klhg = gatherRGB([q0[0] + 1, q0[1] + 2]);
    const zzon = gatherRGB([q0[0], q0[1] + 4]);
    return {
      b: bczz[0], c: bczz[1],
      i: ijfe[0], j: ijfe[1], f: ijfe[2], e: ijfe[3],
      k: klhg[0], l: klhg[1], h: klhg[2], g: klhg[3],
      o: zzon[2], n: zzon[3],
    };
  };
}

const img = makeImage(37, 23);
let maxDiff = 0;
for (let y = 0; y < img.length * 2; y++) {
  for (let x = 0; x < img[0].length * 2; x++) {
    const ref = easuCore(img, [x, y], refTaps(img));
    const emu = easuCore(img, [x, y], emuTaps(img));
    for (let ch = 0; ch < 3; ch++) maxDiff = Math.max(maxDiff, Math.abs(ref[ch] - emu[ch]));
  }
}
console.log(`max |ref - emulated| over ${img[0].length * img.length * 4} output pixels: ${maxDiff}`);
console.log(maxDiff === 0 ? 'PASS: gather-emulation ordering exactly matches reference' : 'FAIL: ordering mismatch');
process.exit(maxDiff === 0 ? 0 : 1);
