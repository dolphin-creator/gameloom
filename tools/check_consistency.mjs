// GameLoom — checker de cohérence mécanique (lecture seule, Node pur, aucune dépendance).
// Compare les sources de vérité (fichiers réels) aux claims de GAMELOOM.md.
// Ne modifie JAMAIS un fichier. exit 0 = cohérent · exit 1 = incohérence(s).
// Sources de vérité : src/core/runtime.ts (version publique), vite.config.ts (entrées),
// tools/run_harnesses.mjs (liste OFFICIAL), assets/ (contenu réel).
// L'inventaire GLB n'est PLUS documenté dans GAMELOOM.md (découverte : `npm run glb --
// inspect assets/<nom>.glb`) — le checker contrôle l'invariant du répertoire à la place
// du catalogue, et les claims du manuel sont limités aux valeurs stables.
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

// ---------- 5. assets/ : contenu du répertoire = GLB uniquement, conteneurs glTF v2 valides ----------
// L'inventaire détaillé n'est plus documenté dans GAMELOOM.md (découverte : `npm run glb --
// inspect`) : l'invariant contrôlé = le répertoire ne contient que des GLB binaires valides.
const assetAll = readdirSync(join(ROOT, 'assets'));
const aIssues = [];
for (const f of assetAll) {
  const buf = readFileSync(join(ROOT, 'assets', f));
  if (!f.endsWith('.glb')) { aIssues.push('fichier non-GLB dans assets/: ' + f); continue; }
  if (buf.length < 12) { aIssues.push('GLB trop court: ' + f); continue; }
  const magic = buf.subarray(0, 4).toString('ascii');
  const ver = buf.readUInt32LE(4);
  if (magic !== 'glTF' || ver !== 2) aIssues.push('GLB invalide (magic/version): ' + f + ' (' + magic + ' v' + ver + ')');
}
if (aIssues.length) bad('assets/ (GLB valides)', aIssues);
else ok('assets/: ' + assetAll.length + ' fichiers, tous GLB v2 valides');

// ---------- 6. claims mécaniques GAMELOOM.md (phrases stables, pas un parser de Markdown) ----------
const doc = read('GAMELOOM.md');
let claimsOk = 0;
const claim = (label, re, expected) => {
  const m = doc.match(re);
  if (!m) { bad('claim ' + label, ['non trouvée dans GAMELOOM.md (texte restructuré ?)']); return; }
  if (String(m[1]) !== String(expected)) bad('claim ' + label, ['documenté: ' + m[1], 'réel: ' + expected]);
  else claimsOk++;
};
const claimPresent = (label, re) => {
  if (doc.match(re)) { claimsOk++; }
  else bad('claim ' + label, ['absente de GAMELOOM.md (mécanisme de découverte perdu ?)']);
};
claim('version', /\|\s*`version`\s*\|\s*["'`]{0,2}(\d+\.\d+\.\d+)/, rtVer);
claimPresent('découverte GLB (commande inspect documentée)', /npm run glb -- inspect/);
if (claimsOk === 2) ok('GAMELOOM mechanical claims: 2/2');
else bad('GAMELOOM mechanical claims: ' + claimsOk + '/2', ['voir les claims ✗ ci-dessus']);

// ---------- bilan ----------
console.log('');
if (problems.length) {
  console.log('CONSISTENCY CHECK: FAIL');
  console.log(problems.length + (problems.length > 1 ? ' inconsistencies found' : ' inconsistency found'));
  process.exit(1);
}
console.log('CONSISTENCY CHECK: PASS');
