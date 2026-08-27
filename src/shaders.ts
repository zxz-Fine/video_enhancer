function common(prefix: string, extra: string): string {
  return `
struct ${prefix}Uniforms {
  con0 : vec4f,
  con1 : vec4f,
  con2 : vec4f,
  con3 : vec4f,
  sizes : vec4f,
};

@group(0) @binding(0) var srcTex : texture_2d<f32>;
@group(0) @binding(1) var<uniform> u : ${prefix}Uniforms;
@group(0) @binding(2) var outTex : texture_storage_2d<rgba8unorm, write>;

fn ${prefix}LoadTap(p : vec2i) -> vec3f {
  let sz = vec2i(u.sizes.zw);
  let c = clamp(p, vec2i(0), sz - vec2i(1));
  return textureLoad(srcTex, c, 0).rgb;
}

fn ${prefix}LoRcp(a : f32) -> f32 {
  return bitcast<f32>(0x7ef07ebbu - bitcast<u32>(a));
}
${extra}
`;
}

export const EASU_SHADER = /* wgsl */ `
${common('easu', `
fn easuLoRsq(a : f32) -> f32 {
  return bitcast<f32>(0x5f347d74u - (bitcast<u32>(a) >> 1u));
}

fn easuGatherRGB(q : vec2f) -> array<vec3f, 4> {
  let base = vec2i(floor(q - vec2f(0.5)));
  let a = easuLoadTap(base);
  let b = easuLoadTap(base + vec2i(1, 0));
  let c = easuLoadTap(base + vec2i(0, 1));
  let d = easuLoadTap(base + vec2i(1, 1));
  return array<vec3f, 4>(c, d, b, a);
}

struct EasuDirLen {
  dir : vec2f,
  len : f32,
}

fn easuSet(dl : ptr<function, EasuDirLen>, pp : vec2f, biS : bool, biT : bool, biU : bool, biV : bool,
    lA : f32, lB : f32, lC : f32, lD : f32, lE : f32) {
  var w = 0.0;
  if (biS) { w = (1.0 - pp.x) * (1.0 - pp.y); }
  if (biT) { w = pp.x * (1.0 - pp.y); }
  if (biU) { w = (1.0 - pp.x) * pp.y; }
  if (biV) { w = pp.x * pp.y; }

  let dc = lD - lC;
  let cb = lC - lB;
  var lenX = max(abs(dc), abs(cb));
  lenX = easuLoRcp(lenX);
  let dirX = lD - lB;
  (*dl).dir.x = (*dl).dir.x + dirX * w;
  lenX = clamp(abs(dirX) * lenX, 0.0, 1.0);
  lenX = lenX * lenX;
  (*dl).len = (*dl).len + lenX * w;

  let ec = lE - lC;
  let ca = lC - lA;
  var lenY = max(abs(ec), abs(ca));
  lenY = easuLoRcp(lenY);
  let dirY = lE - lA;
  (*dl).dir.y = (*dl).dir.y + dirY * w;
  lenY = clamp(abs(dirY) * lenY, 0.0, 1.0);
  lenY = lenY * lenY;
  (*dl).len = (*dl).len + lenY * w;
}

struct EasuTapAcc {
  color : vec3f,
  weight : f32,
}

fn easuTap(acc : ptr<function, EasuTapAcc>, off : vec2f, dir : vec2f, len : vec2f, lob : f32, clp : f32, c : vec3f) {
  var v : vec2f;
  v.x = off.x * dir.x + off.y * dir.y;
  v.y = off.x * (-dir.y) + off.y * dir.x;
  v = v * len;
  var d2 = v.x * v.x + v.y * v.y;
  d2 = min(d2, clp);

  var wB = 2.0 / 5.0 * d2 + -1.0;
  var wA = lob * d2 + -1.0;
  wB = wB * wB;
  wA = wA * wA;
  wB = 25.0 / 16.0 * wB + -(25.0 / 16.0 - 1.0);
  let w = wB * wA;
  (*acc).color = (*acc).color + c * w;
  (*acc).weight = (*acc).weight + w;
}

fn fsrEasu(ip : vec2u) -> vec3f {
  let pp0 = vec2f(ip) * u.con0.xy + u.con0.zw;
  let fp = floor(pp0);
  let pp = pp0 - fp;

  let q0 = fp + vec2f(u.con1.z, u.con1.w) * u.sizes.zw;
  let q1 = q0 + vec2f(u.con2.x, u.con2.y) * u.sizes.zw;
  let q2 = q0 + vec2f(u.con2.z, u.con2.w) * u.sizes.zw;
  let q3 = q0 + vec2f(u.con3.x, u.con3.y) * u.sizes.zw;

  let bczz = easuGatherRGB(q0);
  let ijfe = easuGatherRGB(q1);
  let klhg = easuGatherRGB(q2);
  let zzon = easuGatherRGB(q3);

  let bC = bczz[0]; let cC = bczz[1];
  let iC = ijfe[0]; let jC = ijfe[1]; let fC = ijfe[2]; let eC = ijfe[3];
  let kC = klhg[0]; let lC_ = klhg[1]; let hC = klhg[2]; let gC = klhg[3];
  let oC = zzon[2]; let nC = zzon[3];

  let bL = bC.b * 0.5 + (bC.r * 0.5 + bC.g);
  let cL = cC.b * 0.5 + (cC.r * 0.5 + cC.g);
  let iL = iC.b * 0.5 + (iC.r * 0.5 + iC.g);
  let jL = jC.b * 0.5 + (jC.r * 0.5 + jC.g);
  let fL = fC.b * 0.5 + (fC.r * 0.5 + fC.g);
  let eL = eC.b * 0.5 + (eC.r * 0.5 + eC.g);
  let kL = kC.b * 0.5 + (kC.r * 0.5 + kC.g);
  let lL = lC_.b * 0.5 + (lC_.r * 0.5 + lC_.g);
  let hL = hC.b * 0.5 + (hC.r * 0.5 + hC.g);
  let gL = gC.b * 0.5 + (gC.r * 0.5 + gC.g);
  let oL = oC.b * 0.5 + (oC.r * 0.5 + oC.g);
  let nL = nC.b * 0.5 + (nC.r * 0.5 + nC.g);

  var dl : EasuDirLen;
  dl.dir = vec2f(0.0);
  dl.len = 0.0;
  easuSet(&dl, pp, true, false, false, false, bL, eL, fL, gL, jL);
  easuSet(&dl, pp, false, true, false, false, cL, fL, gL, hL, kL);
  easuSet(&dl, pp, false, false, true, false, fL, iL, jL, kL, nL);
  easuSet(&dl, pp, false, false, false, true, gL, jL, kL, lL, oL);

  let dir2 = dl.dir * dl.dir;
  var dirR = dir2.x + dir2.y;
  let zro = dirR < 1.0 / 32768.0;
  dirR = easuLoRsq(dirR);
  var dir = dl.dir;
  dirR = select(dirR, 1.0, zro);
  dir = select(dir, vec2f(1.0), zro);
  dir = dir * vec2f(dirR);

  var len = dl.len * 0.5;
  len = len * len;

  let stretch = (dir.x * dir.x + dir.y * dir.y) * easuLoRcp(max(abs(dir.x), abs(dir.y)));
  let len2 = vec2f(1.0 + (stretch - 1.0) * len, 1.0 + -0.5 * len);
  let lob = 0.5 + (1.0 / 4.0 - 0.04 - 0.5) * len;
  let clp = easuLoRcp(lob);

  let min4 = min(min(min(fC, gC), jC), kC);
  let max4 = max(max(max(fC, gC), jC), kC);

  var acc : EasuTapAcc;
  acc.color = vec3f(0.0);
  acc.weight = 0.0;
  easuTap(&acc, vec2f(0.0, -1.0) - pp, dir, len2, lob, clp, bC);
  easuTap(&acc, vec2f(1.0, -1.0) - pp, dir, len2, lob, clp, cC);
  easuTap(&acc, vec2f(-1.0, 1.0) - pp, dir, len2, lob, clp, iC);
  easuTap(&acc, vec2f(0.0, 1.0) - pp, dir, len2, lob, clp, jC);
  easuTap(&acc, vec2f(0.0, 0.0) - pp, dir, len2, lob, clp, fC);
  easuTap(&acc, vec2f(-1.0, 0.0) - pp, dir, len2, lob, clp, eC);
  easuTap(&acc, vec2f(1.0, 1.0) - pp, dir, len2, lob, clp, kC);
  easuTap(&acc, vec2f(2.0, 1.0) - pp, dir, len2, lob, clp, lC_);
  easuTap(&acc, vec2f(2.0, 0.0) - pp, dir, len2, lob, clp, hC);
  easuTap(&acc, vec2f(1.0, 0.0) - pp, dir, len2, lob, clp, gC);
  easuTap(&acc, vec2f(1.0, 2.0) - pp, dir, len2, lob, clp, oC);
  easuTap(&acc, vec2f(0.0, 2.0) - pp, dir, len2, lob, clp, nC);

  return min(max4, max(min4, acc.color * vec3f(1.0 / acc.weight)));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
  let ip = vec2u(gid.xy);
  if (ip.x >= u32(u.sizes.x) || ip.y >= u32(u.sizes.y)) {
    return;
  }
  let pix = fsrEasu(ip);
  textureStore(outTex, vec2i(ip), vec4f(clamp(pix, vec3f(0.0), vec3f(1.0)), 1.0));
}
`)}
`;

export const RCAS_SHADER = /* wgsl */ `
${common('rcas', `
fn rcasMedRcp(a : f32) -> f32 {
  let b = bitcast<f32>(0x7ef19fffu - bitcast<u32>(a));
  return b * (-b * a + 2.0);
}

fn fsrRcas(ip : vec2u) -> vec3f {
  let sp = vec2i(ip);
  let b = rcasLoadTap(sp + vec2i(0, -1));
  let d = rcasLoadTap(sp + vec2i(-1, 0));
  let e = rcasLoadTap(sp);
  let f = rcasLoadTap(sp + vec2i(1, 0));
  let h = rcasLoadTap(sp + vec2i(0, 1));

  let bL = b.b * 0.5 + (b.r * 0.5 + b.g);
  let dL = d.b * 0.5 + (d.r * 0.5 + d.g);
  let eL = e.b * 0.5 + (e.r * 0.5 + e.g);
  let fL = f.b * 0.5 + (f.r * 0.5 + f.g);
  let hL = h.b * 0.5 + (h.r * 0.5 + h.g);

  var nz = 0.25 * bL + 0.25 * dL + 0.25 * fL + 0.25 * hL - eL;
  nz = clamp(abs(nz) * rcasMedRcp(max(max(bL, dL), max(eL, max(fL, hL))) - min(min(bL, dL), min(eL, min(fL, hL)))), 0.0, 1.0);
  nz = -0.5 * nz + 1.0;

  let mn4 = min(min(b, d), min(f, h));
  let mx4 = max(max(b, d), max(f, h));

  let hitMin = min(mn4, e) * vec3f(1.0 / (4.0 * mx4.r), 1.0 / (4.0 * mx4.g), 1.0 / (4.0 * mx4.b));
  let hitMax = (vec3f(1.0) - max(mx4, e)) * vec3f(1.0 / (4.0 * mn4.r - 4.0), 1.0 / (4.0 * mn4.g - 4.0), 1.0 / (4.0 * mn4.b - 4.0));
  let lobe3 = max(-hitMin, hitMax);
  let lobe0 = max(-0.1875, min(max(max(lobe3.r, lobe3.g), lobe3.b), 0.0));
  let lobe = lobe0 * u.con0.x * nz;

  let rcpL = rcasMedRcp(4.0 * lobe + 1.0);
  let pixR = (lobe * b.r + lobe * d.r + lobe * h.r + lobe * f.r + e.r) * rcpL;
  let pixG = (lobe * b.g + lobe * d.g + lobe * h.g + lobe * f.g + e.g) * rcpL;
  let pixB = (lobe * b.b + lobe * d.b + lobe * h.b + lobe * f.b + e.b) * rcpL;
  return vec3f(pixR, pixG, pixB);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
  let ip = vec2u(gid.xy);
  if (ip.x >= u32(u.sizes.x) || ip.y >= u32(u.sizes.y)) {
    return;
  }
  let pix = fsrRcas(ip);
  textureStore(outTex, vec2i(ip), vec4f(clamp(pix, vec3f(0.0), vec3f(1.0)), 1.0));
}
`)}
`;

export const CAS_SHADER = /* wgsl */ `
${common('cas', `
fn casFilter(ip : vec2u) -> vec3f {
  let sp = vec2i(ip);
  let a = casLoadTap(sp + vec2i(-1, -1));
  let b = casLoadTap(sp + vec2i(0, -1));
  let c = casLoadTap(sp + vec2i(1, -1));
  let d = casLoadTap(sp + vec2i(-1, 0));
  let e = casLoadTap(sp);
  let f = casLoadTap(sp + vec2i(1, 0));
  let g = casLoadTap(sp + vec2i(-1, 1));
  let h = casLoadTap(sp + vec2i(0, 1));
  let i = casLoadTap(sp + vec2i(1, 1));

  var mnR = min(min(d.r, e.r), min(f.r, min(b.r, h.r)));
  var mnG = min(min(d.g, e.g), min(f.g, min(b.g, h.g)));
  var mnB = min(min(d.b, e.b), min(f.b, min(b.b, h.b)));
  mnR = mnR + min(min(mnR, a.r), min(c.r, min(g.r, i.r)));
  mnG = mnG + min(min(mnG, a.g), min(c.g, min(g.g, i.g)));
  mnB = mnB + min(min(mnB, a.b), min(c.b, min(g.b, i.b)));

  var mxR = max(max(d.r, e.r), max(f.r, max(b.r, h.r)));
  var mxG = max(max(d.g, e.g), max(f.g, max(b.g, h.g)));
  var mxB = max(max(d.b, e.b), max(f.b, max(b.b, h.b)));
  mxR = mxR + max(max(mxR, a.r), max(c.r, max(g.r, i.r)));
  mxG = mxG + max(max(mxG, a.g), max(c.g, max(g.g, i.g)));
  mxB = mxB + max(max(mxB, a.b), max(c.b, max(g.b, i.b)));

  var amp = clamp(
    min(vec3f(mnR, mnG, mnB), vec3f(2.0) - vec3f(mxR, mxG, mxB)) /
      vec3f(max(mxR, 1.0e-6), max(mxG, 1.0e-6), max(mxB, 1.0e-6)),
    vec3f(0.0),
    vec3f(1.0),
  );
  amp = sqrt(amp);

  let peak = -1.0 / (8.0 + (5.0 - 8.0) * u.con0.x);
  let w = amp * vec3f(peak);
  let rcpWeight = 1.0 / (1.0 + 4.0 * w.g);

  let pix = (b * w.g + d * w.g + f * w.g + h * w.g + e) * rcpWeight;
  return clamp(pix, vec3f(0.0), vec3f(1.0));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
  let ip = vec2u(gid.xy);
  if (ip.x >= u32(u.sizes.x) || ip.y >= u32(u.sizes.y)) {
    return;
  }
  let pix = casFilter(ip);
  textureStore(outTex, vec2i(ip), vec4f(pix, 1.0));
}
`)}
`;
