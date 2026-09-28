#!/usr/bin/env node
// GameLoom v0.1 — générateur de GLB low-poly portable (Node uniquement, sans Blender)
// Écrit un GLB binaire valide (glTF 2.0: header + chunk JSON + chunk BIN, padding 4)
// avec l'extension com.gameloom.v0 (métadonnées GameLoom) si fournie.
// Cross-platform: aucun chemin absolu, sortie dans assets/ (relative au repo).
//
// Usage:
//   node tools/make_glb.mjs switch      → assets/switch.glb
// (les recettes low-poly sont dans RECIPES; la méta GameLoom est ajoutée APRÈS
//  par le CLI glb: `glb collider auto` + `glb physics set`)

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NS = 'com.gameloom.v0';
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

// ---------- géométrie: boîte (6 faces, normales planes, enroulement CCW extérieur) ----------
// Demi-dimensions (hx, hy, hz), centre (cx, cy, cz). Vérifié: pour chaque face,
// (v1-v0)×(v2-v0) = normale extérieure.
function boxGeometry(hx, hy, hz, cx, cy, cz) {
  const X0 = cx - hx, X1 = cx + hx, Y0 = cy - hy, Y1 = cy + hy, Z0 = cz - hz, Z1 = cz + hz;
  const faces = [
    { v: [[X1, Y0, Z0], [X1, Y1, Z0], [X1, Y1, Z1], [X1, Y0, Z1]], n: [1, 0, 0] },
    { v: [[X0, Y0, Z1], [X0, Y1, Z1], [X0, Y1, Z0], [X0, Y0, Z0]], n: [-1, 0, 0] },
    { v: [[X0, Y1, Z1], [X1, Y1, Z1], [X1, Y1, Z0], [X0, Y1, Z0]], n: [0, 1, 0] },
    { v: [[X0, Y0, Z0], [X1, Y0, Z0], [X1, Y0, Z1], [X0, Y0, Z1]], n: [0, -1, 0] },
    { v: [[X0, Y0, Z1], [X1, Y0, Z1], [X1, Y1, Z1], [X0, Y1, Z1]], n: [0, 0, 1] },
    { v: [[X1, Y0, Z0], [X0, Y0, Z0], [X0, Y1, Z0], [X1, Y1, Z0]], n: [0, 0, -1] },
  ];
  const pos = [], nrm = [], idx = [];
  faces.forEach((f, i) => {
    for (const v of f.v) { pos.push(...v); nrm.push(...f.n); }
    const o = i * 4;
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), idx: new Uint16Array(idx) };
}

// ---------- matériaux (glTF pbrMetallicRoughness) ----------
const MAT_STONE = { name: 'Stone', pbrMetallicRoughness: { baseColorFactor: [0.44, 0.42, 0.38, 1], metallicFactor: 0, roughnessFactor: 0.9 } };
const MAT_GOLD = { name: 'Gold', pbrMetallicRoughness: { baseColorFactor: [0.85, 0.68, 0.2, 1], metallicFactor: 0.5, roughnessFactor: 0.35 } };
const MAT_VEST = { name: 'Vest', pbrMetallicRoughness: { baseColorFactor: [0.95, 0.65, 0.1, 1], metallicFactor: 0, roughnessFactor: 0.8 } };
const MAT_BODYSUIT = { name: 'Bodysuit', pbrMetallicRoughness: { baseColorFactor: [0.3, 0.33, 0.4, 1], metallicFactor: 0, roughnessFactor: 0.85 } };
const MAT_SKIN = { name: 'Skin', pbrMetallicRoughness: { baseColorFactor: [0.87, 0.7, 0.55, 1], metallicFactor: 0, roughnessFactor: 0.7 } };

// ---------- recettes d'assets (origine à la base: y=0 au sol, Y-up glTF) ----------
const RECIPES = {
  // Survivant (low-poly humain ~1.6 m): jambes + gilet haute-visibilité + tête (3 primitives, 1 mesh)
  survivor: {
    name: 'Survivor',
    prims: [
      { geo: boxGeometry(0.28, 0.4, 0.2, 0, 0.4, 0), material: MAT_BODYSUIT },  // jambes 0..0.8
      { geo: boxGeometry(0.36, 0.3, 0.24, 0, 1.1, 0), material: MAT_VEST },    // gilet/torse 0.8..1.4
      { geo: boxGeometry(0.22, 0.1, 0.22, 0, 1.5, 0), material: MAT_SKIN },    // tête 1.4..1.6
    ],
  },
  // Interrupteur: socle + piédestal + levier doré (3 primitives, 1 mesh)
  switch: {
    name: 'Switch',
    prims: [
      { geo: boxGeometry(0.4, 0.04, 0.4, 0, 0.04, 0), material: MAT_STONE },   // plaque 0.8×0.08
      { geo: boxGeometry(0.3, 0.225, 0.3, 0, 0.305, 0), material: MAT_STONE }, // piédestal → 0.53
      { geo: boxGeometry(0.09, 0.13, 0.09, 0, 0.59, 0), material: MAT_GOLD },  // levier → 0.72
    ],
  },
  // Réacteur (installation ~2.5 m): socle large + corps + bande dorée + colonne de tête (4 primitives, 1 mesh)
  reactor: {
    name: 'Reactor',
    prims: [
      { geo: boxGeometry(1.3, 0.25, 1.3, 0, 0.25, 0), material: MAT_STONE },  // socle 2.6×0.5 → 0.5
      { geo: boxGeometry(0.85, 0.5, 0.85, 0, 1.0, 0), material: MAT_STONE },  // corps 1.7×1.0 → 1.5
      { geo: boxGeometry(1.0, 0.08, 1.0, 0, 1.63, 0), material: MAT_GOLD },   // bande → 1.71
      { geo: boxGeometry(0.5, 0.5, 0.5, 0, 2.31, 0), material: MAT_STONE },   // colonne de tête → 2.81
    ],
  },
};

// ---------- assemblage GLB ----------
function buildGlb(recipe) {
  const materials = [...new Set(recipe.prims.map((p) => p.material))];
  const bufferViews = [];
  const accessors = [];
  const binParts = [];
  let binLen = 0;

  function addView(typed, target) {
    const pad = (4 - (typed.byteLength % 4)) % 4;
    const buf = new Uint8Array(typed.byteLength + pad);
    buf.set(new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength), 0);
    bufferViews.push({ buffer: 0, byteOffset: binLen, byteLength: typed.byteLength, target });
    binParts.push(buf);
    binLen += typed.byteLength + pad;
    return bufferViews.length - 1;
  }

  const primitives = recipe.prims.map((p) => {
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.geo.pos.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        if (p.geo.pos[i + a] < min[a]) min[a] = p.geo.pos[i + a];
        if (p.geo.pos[i + a] > max[a]) max[a] = p.geo.pos[i + a];
      }
    }
    const vPos = addView(p.geo.pos, 34962);
    accessors.push({ bufferView: vPos, componentType: 5126, count: p.geo.pos.length / 3, type: 'VEC3', min, max });
    const aPos = accessors.length - 1;
    const vNrm = addView(p.geo.nrm, 34962);
    accessors.push({ bufferView: vNrm, componentType: 5126, count: p.geo.nrm.length / 3, type: 'VEC3' });
    const aNrm = accessors.length - 1;
    const vIdx = addView(p.geo.idx, 34963);
    accessors.push({ bufferView: vIdx, componentType: 5123, count: p.geo.idx.length, type: 'SCALAR' });
    const aIdx = accessors.length - 1;
    return { attributes: { POSITION: aPos, NORMAL: aNrm }, indices: aIdx, material: materials.indexOf(p.material), mode: 4 };
  });

  const json = {
    asset: { version: '2.0', generator: 'gameloom-tools/make_glb' },
    scene: 0,
    scenes: [{ name: recipe.name, nodes: [0] }],
    nodes: [{ name: recipe.name, mesh: 0 }],
    meshes: [{ name: recipe.name, primitives }],
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLen }],
  };
  return { json, bin: Buffer.concat(binParts.map((b) => Buffer.from(b))) };
}

// Encode GLB: header + chunk JSON (padding 0x20) + chunk BIN (padding 0x00)
function encodeGlb(json, bin) {
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jp = (4 - (jsonBuf.length % 4)) % 4;
  if (jp) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jp, 0x20)]);
  let binBuf = bin;
  const bp = (4 - (binBuf.length % 4)) % 4;
  if (bp) binBuf = Buffer.concat([binBuf, Buffer.alloc(bp, 0)]);
  const total = 12 + 8 + jsonBuf.length + 8 + binBuf.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0); // "glTF"
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonBuf.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16); // "JSON"
  jsonBuf.copy(out, 20);
  const o = 20 + jsonBuf.length;
  out.writeUInt32LE(binBuf.length, o);
  out.writeUInt32LE(0x004e4942, o + 4); // "BIN"
  binBuf.copy(out, o + 8);
  return out;
}

// ---------- main ----------
const name = process.argv[2];
const recipe = RECIPES[name];
if (!recipe) {
  console.error(`✗ recette inconnue: ${name ?? '(manquant)'} (connues: ${Object.keys(RECIPES).join(', ')})`);
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });
const out = join(OUT_DIR, `${name}.glb`);
const { json, bin } = buildGlb(recipe);
writeFileSync(out, encodeGlb(json, bin));
console.log(`✓ ${name}.glb écrit (${Buffer.from(encodeGlb(json, bin)).length} octets, ${json.meshes[0].primitives.length} primitives)`);
console.log(`  méta GameLoom (${NS}): absente — à ajouter via le CLI glb (collider auto, physics set, component add)`);
