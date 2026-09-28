// GameLoom — checker de cohérence mécanique (lecture seule, Node pur, aucune dépendance).
// Compare les sources de vérité (fichiers réels) aux claims de GAMELOOM.md.
// Ne modifie JAMAIS un fichier. exit 0 = cohérent · exit 1 = incohérence(s).
// Sources de vérité : src/core/runtime.ts (version publique), vite.config.ts (entrées),
// tools/run_harnesses.mjs (liste OFFICIAL), assets/*.glb (inventaire réel).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const problems = [];
const ok = (m) => console.log('✓ ' + m);
const bad = (m, lines) => { problems.push(m); console.log('✗ ' + m); for (const l of lines) console.log('  ' + l); };

console.log('GameLoom consistency check\n');

// ---------- 1. version publique (source de vérité: runtime.ts → window.GameLoom.version) ----------
const mVer = read('src/core/runtime.ts').match(/version:\s*'(\d+\.\d+\.\d+)'/);
const rtVer = mVer && mVer[1];
if (!mVer) bad('version runtime', ['version: "x.y.z" introuvable dans src/core/runtime.ts']);
const pkg = JSON.parse(read('package.json'));
if (rtVer && pkg.version !== rtVer) bad('version mismatch', ['package.json: ' + pkg.version, 'runtime: ' + rtVer]);
else if (rtVer) ok('version: ' + rtVer);

// ---------- 2. version racine package-lock == package.json ----------
const lock = JSON.parse(read('package-lock.json'));
const lockVer = lock.packages && lock.packages[''] ? lock.packages[''].version : undefined;
if (lockVer !== pkg.version) bad('package-lock désynchronisé', ['package.json: ' + pkg.version, 'package-lock: ' + lockVer]);
else ok('package-lock version');

// ---------- 3. entrées Vite: chaque entrée existe, aucune page HTML orpheline ----------
const vite = read('vite.config.ts');
const entries = [...vite.matchAll(/:\s*'([^']+\.html)'/g)].map((m) => m[1]);
const htmlFiles = readdirSync(ROOT).filter((f) => f.endsWith('.html'));
const eIssues = [
  ...entries.filter((e) => !htmlFiles.includes(e)).map((e) => 'entrée Vite sans fichier: ' + e),
  ...htmlFiles.filter((f) => !entries.includes(f)).map((f) => 'page HTML sans entrée Vite: ' + f),
];
if (!entries.length) bad('Vite entries', ['rollupOptions.input (entrées .html) introuvable dans vite.config.ts']);
else if (eIssues.length) bad('Vite entries vs HTML', eIssues);
else ok('Vite entries: ' + entries.length + ' (fichiers + pages alignés)');

// ---------- 4. harnesses officiels (source de vérité: OFFICIAL de run_harnesses.mjs) ----------
const mOff = read('tools/run_harnesses.mjs').match(/OFFICIAL\s*=\s*\[([^\]]*)\]/);
const official = mOff ? [...mOff[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
if (!mOff) bad('official harnesses', ['liste OFFICIAL introuvable dans tools/run_harnesses.mjs']);
const hIssues = [];
for (const h of official) {
  if (!existsSync(join(ROOT, 'tools', h + '.mjs'))) hIssues.push('harness officiel sans fichier: ' + h);
  const key = 'test:' + h.replace(/^test_/, '');
  if (!pkg.scripts[key]) hIssues.push('harness officiel sans script npm: ' + h + ' (' + key + ')');
  else if (pkg.scripts[key].indexOf('node tools/' + h + '.mjs') < 0) hIssues.push('script npm incohérent: ' + key + ' → ' + pkg.scripts[key]);
}
if (official.length && hIssues.length) bad('official harnesses: ' + official.length, hIssues);
else if (official.length) ok('official harnesses: ' + official.length + ' (fichiers + scripts npm alignés)');
const unofficial = readdirSync(join(ROOT, 'tools')).filter((f) => /^test_.+\.mjs$/.test(f)).map((f) => f.slice(0, -4)).filter((t) => !official.includes(t));
if (unofficial.length) console.log('ℹ test_*.mjs hors suite officielle: ' + unofficial.join(', '));

// ---------- 5. inventaire GLB: table GAMELOOM.md vs assets/*.glb (ensemble bidirectionnel) ----------
const doc = read('GAMELOOM.md');
const tableGlbs = [...doc.matchAll(/^\|\s*`([a-z0-9_]+\.glb)`\s*\|/gm)].map((m) => m[1]);
const realGlbs = readdirSync(join(ROOT, 'assets')).filter((f) => f.endsWith('.glb'));
const gIssues = [
  ...tableGlbs.filter((g) => !realGlbs.includes(g)).map((g) => 'GLB documenté mais absent: ' + g),
  ...realGlbs.filter((g) => !tableGlbs.includes(g)).map((g) => 'GLB présent mais non documenté: ' + g),
];
if (!tableGlbs.length) bad('GLB inventory', ['table d\'inventaire (| `x.glb` | …) introuvable dans GAMELOOM.md']);
else if (gIssues.length) bad('GLB inventory: ' + realGlbs.length, gIssues);
else ok('GLB inventory: ' + realGlbs.length + ' (table = assets/)');

// ---------- 6. claims mécaniques GAMELOOM.md (phrases stables, pas un parser de Markdown) ----------
const gameCount = entries.filter((e) => e !== 'v02_test.html').length; // v02_test = page debug, pas un jeu
let claimsOk = 0;
const claim = (label, re, expected) => {
  const m = doc.match(re);
  if (!m) { bad('claim ' + label, ['non trouvée dans GAMELOOM.md (texte restructuré ?)']); return; }
  if (String(m[1]) !== String(expected)) bad('claim ' + label, ['documenté: ' + m[1], 'réel: ' + expected]);
  else claimsOk++;
};
claim('version', /\|\s*`version`\s*\|\s*["'`]{0,2}(\d+\.\d+\.\d+)/, rtVer);
claim('Vite entries', /multi-entry \((\d+) HTML\)/, entries.length);
claim('official harnesses', /tests OFFICIELS \(build \+ preview \+ Chrome \+ (\d+) harnesses/, official.length);
claim('jeux (shells)', /shells des (\d+) jeux/, gameCount);
claim('jeux (slices)', /(\d+) vertical slices validées/, gameCount);
claim('GLB (structure)', /assets\/ ← (\d+) GLB/, realGlbs.length);
claim('GLB (inventaire)', /Inventaire des (\d+) GLB existants/, realGlbs.length);
if (claimsOk === 7) ok('GAMELOOM mechanical claims: 7/7');
else bad('GAMELOOM mechanical claims: ' + claimsOk + '/7', ['voir les claims ✗ ci-dessus']);

// ---------- bilan ----------
console.log('');
if (problems.length) {
  console.log('CONSISTENCY CHECK: FAIL');
  console.log(problems.length + (problems.length > 1 ? ' inconsistencies found' : ' inconsistency found'));
  process.exit(1);
}
console.log('CONSISTENCY CHECK: PASS');
