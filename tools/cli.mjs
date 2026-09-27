#!/usr/bin/env node
// CLI glb — outil d'assets GameLoom v0.1
// Un seul CLI: les assets. Discovery progressive (--help à chaque niveau).
// Métadonnées dans l'extension glTF "com.gameloom.v0" (scènes).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const NS = 'com.gameloom.v0';
const COMPONENTS = ['Health', 'Explosive', 'Scored'];

// ---------- lecture GLB (JSON chunk) ----------
// Un Buffer Node peut être poolé (byteOffset non nul) → on normalise toujours
// sur (arrayBuffer, byteOffset, byteLength).
function bufView(buf) {
  return { ab: buf.buffer, off: buf.byteOffset, len: buf.byteLength };
}
function readGlbJson(buf) {
  const { ab, off, len } = bufView(buf);
  const bytes = new Uint8Array(ab, off, len);
  if (len < 12) return { error: 'fichier trop court' };
  const dv = new DataView(ab, off);
  if (dv.getUint32(0, true) !== 0x46546c67) return { error: 'magic glTF absent — ce n\'est pas un GLB' };
  let offset = 12;
  while (offset + 8 <= len) {
    const cl = dv.getUint32(offset, true);
    const type = dv.getUint32(offset + 4, true);
    if (cl <= 0) break;
    if (type === 0x4e4f534a) {
      try { return { json: JSON.parse(new TextDecoder().decode(bytes.subarray(offset + 8, offset + 8 + cl))) }; }
      catch { return { error: 'chunk JSON illisible' }; }
    }
    offset += 8 + cl;
  }
  return { error: 'chunk JSON introuvable' };
}

// ---------- bbox depuis les accessors POSITION (déclarés dans les primitives) ----------
// IMPORTANT: seuls les accessors référencés par primitives[].attributes.POSITION comptent.
// Normales (VEC3) et couleurs (VEC3) partagent le même type — les ignorer est indispensable.
function computeBbox(json) {
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let found = false;
  const posIndices = new Set();
  for (const mesh of json.meshes ?? [])
    for (const prim of mesh.primitives ?? [])
      if (prim.attributes?.POSITION !== undefined) posIndices.add(prim.attributes.POSITION);
  const bin = readBinChunk();
  if (!bin || posIndices.size === 0) return null;
  for (const idx of posIndices) {
    const acc = json.accessors?.[idx];
    if (!acc || acc.type !== 'VEC3' || acc.componentType !== 5126) continue;
    const bv = json.bufferViews?.[acc.bufferView];
    if (!bv) continue;
    const off = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const f = new Float32Array(bin.buffer, bin.byteOffset + off, acc.count * 3);
    for (let i = 0; i < f.length; i += 3) {
      const x = f[i], y = f[i + 1], z = f[i + 2];
      if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
      if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
      if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
      found = true;
    }
  }
  if (!found) return null;
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]], center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] };
}

let _bin = null;
let _glbBytes = null;
let _glbView = null; // { ab, off, len } du GLB courant
function load(file) {
  _glbBytes = readFileSync(file);
  _glbView = bufView(_glbBytes);
  const r = readGlbJson(_glbBytes);
  if (r.error) { console.error(`✗ ${r.error}`); process.exit(1); }
  if (!r.json.scenes?.length) { console.error('✗ scène glTF absente'); process.exit(1); }
  return r.json;
}
function readBinChunk() {
  if (!_glbView) return null;
  const { ab, off, len } = _glbView;
  const dv = new DataView(ab, off);
  const bytes = new Uint8Array(ab, off, len);
  let offset = 12;
  while (offset + 8 <= len) {
    const cl = dv.getUint32(offset, true);
    const type = dv.getUint32(offset + 4, true);
    if (cl <= 0) break;
    if (type === 0x004e4942) return new Uint8Array(ab, off + offset + 8, cl);
    offset += 8 + cl;
  }
  return null;
}
function save(file, json) {
  writeFileSync(file, Buffer.from(JSON.stringify(json)));
}
// Réécriture du GLB: header + chunk JSON (padding 0x20) + chunk BIN (padding 0x00),
// le BIN est préservé tel quel. @gltf-transform n'est PAS utilisé (cf. GAMELOOM.md §2/§8).
// Sans chunk BIN: réécriture en JSON seul (glTF pur).
function writeGlb(file, json) {
  const { ab, off, len } = _glbView;
  const dv = new DataView(ab, off);
  let hasBin = false;
  let binData = null;
  let offset = 12;
  while (offset + 8 <= len) {
    const cl = dv.getUint32(offset, true);
    const type = dv.getUint32(offset + 4, true);
    if (cl <= 0) break;
    if (type === 0x004e4942) { hasBin = true; binData = new Uint8Array(ab, off + offset + 8, cl); break; }
    offset += 8 + cl;
  }
  if (!hasBin) {
    save(file, json); // pas de données binaires: JSON seul
    return;
  }
  // avec BIN: on reconstruit le GLB = header + JSON chunk + BIN chunk
  const newJson = Buffer.from(JSON.stringify(json));
  // padding JSON à 4 (espace 0x20)
  const jsonPadded = pad4(newJson, 0x20);
  const binPadded = pad4(Buffer.from(binData), 0x00);
  const total = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0); // glTF
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  let o = 12;
  out.writeUInt32LE(jsonPadded.length, o); o += 4;
  out.writeUInt32LE(0x4e4f534a, o); o += 4;
  jsonPadded.copy(out, o); o += jsonPadded.length;
  out.writeUInt32LE(binPadded.length, o); o += 4;
  out.writeUInt32LE(0x004e4942, o); o += 4;
  binPadded.copy(out, o);
  writeFileSync(file, out);
}
function pad4(buf, fill) {
  const rem = buf.length % 4;
  if (!rem) return buf;
  const p = Buffer.alloc(buf.length + (4 - rem));
  buf.copy(p);
  p.fill(fill, buf.length);
  return p;
}

function getMeta(json) {
  return json.scenes[0]?.extensions?.[NS] ?? null;
}
function setMeta(json, meta) {
  const s = json.scenes[0];
  s.extensions = s.extensions ?? {};
  s.extensions[NS] = meta;
  json.extensionsUsed = json.extensionsUsed ?? [];
  if (!json.extensionsUsed.includes(NS)) json.extensionsUsed.push(NS);
}

// ---------- aide + suggestions ----------
const HELP = {
  '': [
    'glb — outil d\'assets GameLoom v0.1 (namespace com.gameloom.v0)',
    '',
    'Usage: glb <commande> <fichier.glb> [options]',
    '',
    'Commandes:',
    '  inspect    affiche le contenu (méta + géométrie)  — --json pour JSON brut',
    '  validate   vérifie la structure et les métadonnées',
    '  doctor     diagnostic complet (erreurs + avertissements)',
    '  collider   sous-commandes: auto | set',
    '  physics    sous-commandes: set',
    '  component  sous-commandes: add (Health | Explosive | Scored)',
    '',
    'Exemples:',
    '  glb inspect assets/barrel.glb',
    '  glb collider auto assets/barrel.glb',
    '  glb physics set assets/barrel.glb --body dynamic --mass 30',
    '  glb component add assets/barrel.glb Health --max 50',
    '  glb doctor assets/barrel.glb',
    '',
    'Chaque commande accepte --help pour la documentation détaillée.',
  ],
  'inspect': [
    'glb inspect — affiche le contenu d\'un asset (métadonnées + géométrie)',
    '',
    '  inspect <file.glb> [--json]',
    '',
    '    --json   JSON brut (sinon affichage lisible)',
    '',
    'Résultat: file, ns, meshes, vertices (sommets VEC3), boundingBox (min/max/size/center),',
    'gameloom (métadonnées com.gameloom.v0, ou null si asset brut).',
    '',
    'Exemple: glb inspect assets/barrel.glb',
  ],
  'validate': [
    'glb validate — vérifie la structure et les métadonnées d\'un asset',
    '',
    '  validate <file.glb>',
    '',
    'Vérifie: présence mesh; collider.type ∈ box|sphere|capsule, size = nombres > 0',
    '(box: 3 nombres); physics.body ∈ static|dynamic|kinematic (dynamic → masse > 0);',
    'Health.max nombre > 0; Explosive.{radius,damage,impulse} nombres; composants canoniques.',
    '',
    '✓ valide (exit 0) / ✗ INVALIDE + liste des problèmes (exit 1). Avertissements (!) non bloquants.',
  ],
  'doctor': [
    'glb doctor — diagnostic complet d\'un asset (erreurs + avertissements, sortie JSON)',
    '',
    '  doctor <file.glb>',
    '',
    'Résultat JSON: checks.gltf (magic, scenes, meshes, bin_chunk), checks.bbox, checks.gameloom',
    '(présence collider/physics/components), checks.warnings, ok.',
  ],
  'collider': [
    'glb collider — collider de l\'asset (espace local)',
    '',
    '  auto <file>      calcule le collider box depuis la bounding box du mesh',
    '  set <file> --type box|sphere|capsule --size x,y,z --center x,y,z',
    '    box:     size = [largeur, hauteur, profondeur] (dimensions TOTALES, le runtime prend la moitié pour le cuboid Rapier)',
    '    sphere:  size = [rayon]',
    '    capsule: size = [rayon, demi-hauteur]',
    '',
    'Exemple: glb collider set assets/crate.glb --type box --size 1.5,1.5,1.5 --center 0,0.75,0',
  ],
  'physics': [
    'glb physics — propriétés physiques de l\'asset',
    '',
    '  set <file> --body static|dynamic|kinematic [--mass N]',
    '',
    'Exemple: glb physics set assets/barrel.glb --body dynamic --mass 30',
  ],
  'component': [
    'glb component — capacités statiques de l\'asset',
    '',
    `  add <file> <${COMPONENTS.join('|')}> --cle valeur [--cle2 valeur2 ...]`,
    '',
    'Champs connus (autocomplétion des erreurs):',
    '  Health:     max',
    '  Explosive:  radius, damage, impulse',
    '  Scored:     points',
    '',
    'Exemple: glb component add assets/barrel.glb Explosive --radius 8 --damage 120 --impulse 20',
  ],
};

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
function didYouMean(word, candidates) {
  const best = candidates.map((c) => [c, levenshtein(word.toLowerCase(), c.toLowerCase())]).sort((a, b) => a[1] - b[1])[0];
  return best && best[1] <= 2 ? best[0] : null;
}

function parseOpts(args, allowed, bool = []) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') { return { help: true }; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (!allowed.includes(key) && !bool.includes(key)) {
        const sug = didYouMean(key, [...allowed, ...bool]);
        console.error(`✗ option inconnue: --${key}`);
        if (sug) console.error(`  Did you mean --${sug}? (voir --help)`);
        else console.error(`  Options: ${[...allowed, ...bool].map((k) => '--' + k).join(' ')}`);
        process.exit(2);
      }
      if (bool.includes(key)) { opts[key] = true; continue; }
      opts[key] = args[++i];
      if (opts[key] === undefined) { console.error(`✗ --${key} attend une valeur`); process.exit(2); }
    } else pos.push(a);
  }
  return { opts, pos };
}

function die(msg) { console.error(`✗ ${msg}`); process.exit(1); }
const r3 = (n) => Math.round(n * 1000) / 1000;

// ---------- commandes ----------
function cmdInspect(file, args) {
  const { help, opts } = parseOpts(args, [], ['json']);
  if (help) { console.log(HELP['inspect'] ?? HELP[''].join('\n')); return; }
  if (!existsSync(file)) die(`fichier introuvable: ${file}`);
  const json = load(file);
  const meta = getMeta(json);
  const bbox = computeBbox(json);
  const posCount = (() => {
    let n = 0;
    const seen = new Set();
    for (const mesh of json.meshes ?? [])
      for (const prim of mesh.primitives ?? [])
        if (prim.attributes?.POSITION !== undefined && !seen.has(prim.attributes.POSITION)) {
          seen.add(prim.attributes.POSITION);
          n += json.accessors?.[prim.attributes.POSITION]?.count ?? 0;
        }
    return n;
  })();
  const out = {
    file: basename(file),
    ns: NS,
    meshes: json.meshes?.length ?? 0,
    vertices: posCount,
    boundingBox: bbox ? { min: bbox.min.map(r3), max: bbox.max.map(r3), size: bbox.size.map(r3), center: bbox.center.map(r3) } : null,
    gameloom: meta ?? null,
  };
  if (opts.json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`asset: ${basename(file)}`);
    console.log(`meshes: ${out.meshes} · sommets VEC3: ${out.vertices}`);
    if (out.boundingBox) console.log(`bbox: size=[${out.boundingBox.size}] center=[${out.boundingBox.center}]`);
    if (meta) {
      console.log(`GameLoom ${NS}:`);
      console.log(JSON.stringify(meta, null, 2));
    } else console.log('GameLoom: aucune métadonnées (asset brut)');
  }
}

function cmdValidate(file) {
  if (!existsSync(file)) die(`fichier introuvable: ${file}`);
  const json = load(file);
  const meta = getMeta(json);
  const problems = [], warnings = [];
  if (!json.meshes?.length) problems.push('aucun mesh');
  if (meta) {
    if (meta.collider) {
      if (!['box', 'sphere', 'capsule'].includes(meta.collider.type)) problems.push(`collider.type invalide: ${meta.collider.type}`);
      if (!Array.isArray(meta.collider.size) || !meta.collider.size.every((n) => typeof n === 'number' && n > 0)) problems.push('collider.size invalide (tableau de nombres > 0)');
      if (meta.collider.type === 'box' && meta.collider.size.length !== 3) problems.push('collider box attend size [x,y,z]');
    } else warnings.push('pas de collider défini — le runtime utilisera la bbox auto');
    if (meta.physics) {
      if (!['static', 'dynamic', 'kinematic'].includes(meta.physics.body)) problems.push(`physics.body invalide: ${meta.physics.body}`);
      if (meta.physics.body === 'dynamic' && (typeof meta.physics.mass !== 'number' || meta.physics.mass <= 0)) problems.push('physics.dynamic sans masse positive');
    } else warnings.push('pas de physique définie — le runtime utilisera static/1kg');
    if (meta.components) {
      for (const [k, v] of Object.entries(meta.components)) {
        if (!COMPONENTS.includes(k)) warnings.push(`composant non canonique: ${k}`);
      }
      const h = meta.components.Health;
      if (h && (typeof h.max !== 'number' || h.max <= 0)) problems.push('Health.max doit être un nombre > 0');
      const ex = meta.components.Explosive;
      if (ex) for (const f of ['radius', 'damage', 'impulse']) if (typeof ex[f] !== 'number') problems.push(`Explosive.${f} doit être un nombre`);
    }
  }
  if (problems.length) { console.error(`✗ ${basename(file)} INVALIDE:`); for (const p of problems) console.error(`  - ${p}`); for (const w of warnings) console.error(`  ! ${w}`); process.exit(1); }
  console.log(`✓ ${basename(file)} valide`);
  for (const w of warnings) console.log(`  ! ${w}`);
}

function cmdDoctor(file) {
  if (!existsSync(file)) die(`fichier introuvable: ${file}`);
  const json = load(file);
  const meta = getMeta(json);
  const bbox = computeBbox(json);
  const out = { file: basename(file), ok: true, checks: {} };
  out.checks.gltf = { magic: 'ok', scenes: json.scenes?.length ?? 0, meshes: json.meshes?.length ?? 0, bin_chunk: readBinChunk() ? 'present' : 'absent (json only)' };
  out.checks.bbox = bbox ? { size: bbox.size.map(r3), center: bbox.center.map(r3) } : { error: 'aucune donnée VEC3 lisible' };
  if (!meta) { out.checks.gameloom = { present: false, note: 'aucune métadonnées — collider auto + static au runtime' }; out.checks.warnings = ['asset sans métadonnées GameLoom']; }
  else {
    out.checks.gameloom = { present: true, collider: !!meta.collider, physics: !!meta.physics, components: Object.keys(meta.components ?? {}) };
    const w = [];
    if (!meta.collider) w.push('pas de collider — `glb collider auto` recommandé');
    if (meta.collider?.type === 'box' && bbox) {
      const over = meta.collider.size.map((s, i) => s < bbox.size[i] * 0.95);
      if (over.some(Boolean)) w.push(`collider box plus petit que la bbox ([${meta.collider.size}] < [${bbox.size.map(r3)}]) — possible tunneling`);
    }
    if (!meta.physics) w.push('pas de physique — static par défaut');
    if (meta.components?.Explosive && !meta.components.Health) w.push('Explosive sans Health: l\'explosion ne se déclenchera jamais (règle health.zero sans cible)');
    out.checks.warnings = w;
    out.ok = w.length === 0;
  }
  console.log(JSON.stringify(out, null, 2));
}

function cmdCollider(args) {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP.collider.join('\n')); return; }
  if (!['auto', 'set'].includes(sub)) {
    const sug = didYouMean(sub, ['auto', 'set']);
    die(`sous-commande inconnue: ${sug ? `"${sub}" (did you mean "${sug}"?)` : sub} — voir: glb collider --help`);
  }
  const rest = args.slice(1);
  const parsed = sub === 'auto' ? parseOpts(rest, []) : parseOpts(rest, ['type', 'size', 'center']);
  if (parsed.help) { console.log(HELP.collider.join('\n')); return; }
  const { opts, pos } = parsed;
  const fileArg = pos[0];
  if (!fileArg || !existsSync(fileArg)) die(`fichier introuvable: ${fileArg ?? '(manquant)'}`);
  const json = load(fileArg);
  const meta = getMeta(json) ?? {};
  if (sub === 'auto') {
    const bbox = computeBbox(json);
    if (!bbox) die('bounding box non calculable (accessor VEC3 absente?)');
    meta.collider = { type: 'box', size: bbox.size.map(r3), center: bbox.center.map(r3) };
    setMeta(json, meta);
    writeGlb(fileArg, json);
    console.log(`✓ collider auto: box size=[${meta.collider.size}] center=[${meta.collider.center}]`);
  } else {
    const type = opts.type ?? 'box';
    if (!['box', 'sphere', 'capsule'].includes(type)) die(`type invalide: ${type} (box|sphere|capsule)`);
    const size = (opts.size ?? '1,1,1').split(',').map(Number);
    const center = (opts.center ?? '0,0,0').split(',').map(Number);
    const need = type === 'box' ? 3 : type === 'sphere' ? 1 : 2;
    if (size.length !== need || size.some((n) => !isFinite(n) || n <= 0)) die(`--size invalide pour ${type} (attend ${need} nombres > 0)`);
    meta.collider = { type, size: size.map(r3), center: center.map(r3) };
    setMeta(json, meta);
    writeGlb(fileArg, json);
    console.log(`✓ collider: ${type} size=[${meta.collider.size}] center=[${meta.collider.center}]`);
  }
}

function cmdPhysics(args) {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP.physics.join('\n')); return; }
  if (sub !== 'set') die(`sous-commande inconnue: ${sub} — voir: glb physics --help`);
  const parsed = parseOpts(args.slice(1), ['body', 'mass']);
  if (parsed.help) { console.log(HELP.physics.join('\n')); return; }
  const { opts, pos } = parsed;
  if (!existsSync(pos[0])) die(`fichier introuvable: ${pos[0]}`);
  const json = load(pos[0]);
  const meta = getMeta(json) ?? {};
  const body = opts.body ?? 'dynamic';
  if (!['static', 'dynamic', 'kinematic'].includes(body)) die(`--body invalide: ${body} (static|dynamic|kinematic)`);
  meta.physics = { body, mass: opts.mass ? Number(opts.mass) : 1 };
  if (body === 'dynamic' && (!meta.physics.mass || meta.physics.mass <= 0)) die('--mass doit être > 0 pour dynamic');
  setMeta(json, meta);
  writeGlb(pos[0], json);
  console.log(`✓ physique: ${body}${meta.physics.mass ? ` mass=${meta.physics.mass}kg` : ''}`);
}

function cmdComponent(args) {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP.component.join('\n')); return; }
  if (sub !== 'add') die(`sous-commande inconnue: ${sub} — voir: glb component --help`);
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP.component.join('\n')); return; }
  const rest = args.slice(1);
  const known = { Health: ['max'], Explosive: ['radius', 'damage', 'impulse'], Scored: ['points'] };
  const comp = rest[1];
  if (!comp || !COMPONENTS.includes(comp)) {
    const sug = didYouMean(comp ?? '', COMPONENTS);
    die(`composant inconnu: ${comp ?? '(manquant)'}${sug ? ` (did you mean "${sug}"?)` : ''} — voir: glb component --help`);
  }
  const fileArg = rest[0];
  if (!existsSync(fileArg)) die(`fichier introuvable: ${fileArg}`);
  const json = load(fileArg);
  const meta = getMeta(json) ?? {};
  meta.components = meta.components ?? {};
  meta.components[comp] = meta.components[comp] ?? {};
  const kv = rest.slice(2);
  for (let i = 0; i < kv.length; i += 2) {
    if (!kv[i].startsWith('--')) die(`option attendue (retrouvé "${kv[i]}")`);
    const key = kv[i].slice(2), val = kv[i + 1];
    if (!known[comp].includes(key)) {
      const sug = didYouMean(key, known[comp]);
      die(`champ inconnu pour ${comp}: --${key}${sug ? ` (did you mean --${sug}?)` : ` (connus: ${known[comp].join(', ')})`}`);
    }
    const n = Number(val);
    meta.components[comp][key] = isFinite(n) && val !== '' && !isNaN(val) ? n : val;
  }
  setMeta(json, meta);
  writeGlb(fileArg, json);
  console.log(`✓ ${comp}: ${JSON.stringify(meta.components[comp])}`);
}

// ---------- main ----------
const [, , cmd, ...rest] = process.argv;
if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
  console.log(HELP[''].join('\n'));
  process.exit(cmd ? 0 : 1);
}
const file = rest.find((a) => !a.startsWith('-') && a !== cmd);
switch (cmd) {
  case 'inspect':
    if (rest[0] === '--help' || rest[0] === '-h') { console.log(HELP.inspect.join('\n')); process.exit(0); }
    cmdInspect(file ?? rest[0], rest.slice(1)); break;
  case 'validate':
    if (rest[0] === '--help' || rest[0] === '-h') { console.log(HELP.validate.join('\n')); process.exit(0); }
    cmdValidate(rest[0]); break;
  case 'doctor':
    if (rest[0] === '--help' || rest[0] === '-h') { console.log(HELP.doctor.join('\n')); process.exit(0); }
    cmdDoctor(rest[0]); break;
  case 'collider': cmdCollider(rest); break;
  case 'physics': cmdPhysics(rest); break;
  case 'component': cmdComponent(rest); break;
  default: {
    const sug = didYouMean(cmd, ['inspect', 'validate', 'doctor', 'collider', 'physics', 'component', 'help']);
    console.error(`✗ commande inconnue: ${cmd}`);
    if (sug) console.error(`  Did you mean "${sug}"?`);
    console.error('  glb --help pour la liste');
    process.exit(2);
  }
}
