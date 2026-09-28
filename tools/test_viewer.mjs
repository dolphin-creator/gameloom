// Harness autonome de l'Asset Viewer — cycle de vie complet dans un seul processus :
// build → vite preview (4180, host 127.0.0.1) → Chrome headless CDP (9225) → checks →
// teardown garanti + ports vérifiés + cleanup des assets temporaires.
// VOLONTAIREMENT HORS de la suite officielle des 8 harnesses jeux (§15, ports 4173/9224) :
// c'est un test d'OUTILLAGE, pas un harness gameplay — les 7 jeux et le compte officiel
// ne sont pas affectés. Ports distincts → compatible avec un npm test parallèle.
// Usage: node tools/test_viewer.mjs   (exit 0 = verts, 1 = échec, 2 = infrastructure)
import { spawn, execSync } from 'node:child_process';
import { openSync, cpSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const VITE = join(REPO, 'node_modules', 'vite', 'bin', 'vite.js');
const CHROME = process.env.CHROME_PATH ?? (
  process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : 'google-chrome-stable'
);
const PORT = 4180;
const CDP_PORT = 9225;
const BASE = `http://127.0.0.1:${PORT}`; // host/port NON par défaut → prouve la configurabilité
const tmp = os.tmpdir();
const T0 = Date.now();
const ts = () => `+${((Date.now() - T0) / 1000).toFixed(1)}s`;
const log = (m) => console.log(`${ts()} ${m}`);

// ---------- build (le viewer est servi depuis dist/, comme les jeux) ----------
log('build: npm run build (tsc + vite)');
execSync('npm run build', { cwd: REPO, stdio: 'inherit' });
cpSync(join(REPO, 'assets'), join(REPO, 'dist', 'assets'), { recursive: true });
log('build: OK (assets/ copiés dans dist/assets/)');

// ---------- infrastructure (même pattern que run_harnesses.mjs) ----------
const portOpen = (port) => new Promise((res) => {
  const s = net.connect({ port, host: '127.0.0.1' }, () => { s.destroy(); res(true); });
  s.setTimeout(800, () => { s.destroy(); res(false); });
  s.on('error', () => res(false));
  s.on('close', () => { });
});
const waitPort = async (port, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await portOpen(port)) return true; await new Promise((r) => setTimeout(r, 400)); }
  return await portOpen(port);
};
const waitPortClosed = async (port, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!(await portOpen(port))) return true; await new Promise((r) => setTimeout(r, 400)); }
  return !(await portOpen(port));
};
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch { }
}
function spawnDetached(cmd, cmdArgs, logName) {
  const out = openSync(join(tmp, logName), 'w');
  const p = spawn(cmd, cmdArgs, {
    cwd: REPO,
    stdio: ['ignore', out, out],
    detached: true,
    windowsHide: true,
    creationFlags: process.platform === 'win32' ? 0x00000008 | 0x00000200 : 0,
  });
  let dead = false;
  p.on('error', (e) => { log(`ERREUR SPAWN: ${e.code ?? e.message}`); dead = true; });
  p.on('exit', () => { dead = true; });
  return { p, dead: () => dead, logFile: join(tmp, logName) };
}

// ---------- PNG minimal (Node pur, zlib intégré) — fixtures images Choice Mode ----------
const CRC_T = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_T[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(w, h, rgb) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolor RGB
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = rgb[0]; row[1 + x * 3 + 1] = rgb[1]; row[1 + x * 3 + 2] = rgb[2]; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// WAV RIFF/PCM 16-bit mono (Node pur) — fixtures audio Choice/mono Mode (sinus synthétique,
// aucune dépendance réseau/license ; uniquement dans dist/, jamais dans assets/).
function makeWav(freqHz, seconds) {
  const rate = 22050;
  const n = Math.floor(rate * seconds);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const s = Math.round(Math.sin(2 * Math.PI * freqHz * i / rate) * 12000); // ~-9 dBFS, pas de clip
    data.writeInt16LE(s, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);           // PCM, mono
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); // sample rate, byte rate
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);          // block align, bits
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// ---------- Fixtures JPEG/WebP (base64 embarqué) ----------
// Node pur n'encode ni JPEG ni WebP (zéro dépendance autorisée) : deux images de test
// VALIDES (192×104 JPEG baseline, 128×96 WebP) générées hors repo (canvas navigateur)
// et embarquées en base64 — aucun chemin de machine, aucune dépendance réseau. Le PNG
// reste généré Node pur (makePng). Écrits dans dist/assets/ (gitignored), jamais dans
// assets/ (invariant GLB-only du checker de cohérence).
const FIX_JPEG_B64 = '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';
const FIX_WEBP_B64 = 'UklGRiIEAABXRUJQVlA4WAoAAAAgAAAAfwAAXwAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggNAIAALANAJ0BKoAAYAA+USiQRaOioZRfXAA4BQSygGqA07+M2A7RiKV4UB0f++AOVWyniBHArgJUEM98kj0keqxbmAdyCv2Ncb1Zz6pjKgm+97ItnY/NtXB+/e0RyuJ4OIuMtXUOsg58CmSxTeJ3IskK4SFss0becQAA/vOkwUIMKZ7LcqdD1NgKGNPcI7r3sizdzFcOMirbL6CVGTLIrdp19uGcs0Oo59mLuGwd3r1siKIsJKx42ePoC0L5Z0w+dUF59Hz0WqQjFpg88jiLk6/v+qrs/JiI43RKUPsmBmpZewkMZm5bC6e03QJHb67zIB+7fD/RIz/SHgCYz3lJ9fU5ag7243GJrAuHlzm4lEzemDgPJgq/U1ET9CjFzxiGy1CpHkA3hmTNy+ToQebjmCulvoo8x8x+VcyvvJe1DCgSdUPjYDZ3XXdaQLODmY87ohiudk0F0MIqlZZm+e9PfZdnD8YO7xGvyKIQVqCj6VnbOhDdGlox5dYJY1IrdnUpiDIJYS/p/09PmFsjGQkz/CO0VXG2KpiSDDC60bibAysVUjABI4lL+P6ZD3gJAdI3V6/PefTn5bjYaA9RSUDm+Ow+AnvHNtMHPz8iOorQD7bMQsn9r0pQeNpzxi6nT6TNJu/DeIdH1Osxg2+sl9eLx5q3nHYFSM0gTUw533D8DenW/1GbyvgEvNvv9EjP9d2nImKIDL6mX3VSdz2L0IkqjMy9kPqUG9mnrb+wrZ/Y3om/8kgADMQAAA==';

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${ts()} ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`);
}

const globalTimer = setTimeout(() => { log('TIMEOUT GLOBAL 8 min — kill forcé'); teardown(); process.exit(2); }, 8 * 60 * 1000);
globalTimer.unref?.();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { teardown(); process.exit(130); });

const started = [];
let tornDown = false;
function teardown() {
  if (tornDown) return;
  tornDown = true;
  for (const s of started) { if (!s.dead()) killTree(s.p.pid); }
}

  const TMP_GLBs = [
    'dist/assets/_viewer_tmp_sphere.glb',
    'dist/assets/_viewer_tmp_capsule.glb',
    'dist/assets/_viewer_tmp_bad.glb',
    'dist/assets/_viewer_tmp_img_a.png',
    'dist/assets/_viewer_tmp_img_b.png',
    'dist/assets/_viewer_tmp_img_c.png',
    'dist/assets/_viewer_tmp_img_jpeg.jpg',
    'dist/assets/_viewer_tmp_img_webp.webp',
    'dist/assets/_viewer_tmp_tone_low.wav',
    'dist/assets/_viewer_tmp_tone_mid.wav',
    'dist/assets/_viewer_tmp_tone_high.wav',
    'dist/assets/_viewer_tmp_bad.wav',
  ];

(async () => {
  for (const port of [PORT, CDP_PORT]) {
    if (await portOpen(port)) {
      log(`FAIL: port ${port} déjà occupé — libérez-le avant de relancer.`);
      process.exit(2);
    }
  }

  const pv = spawnDetached(process.execPath, [VITE, 'preview', '--host', '127.0.0.1', '--port', String(PORT)], 'gameloom_viewer_pv.log');
  started.push(pv);
  if (!(await waitPort(PORT, 20000))) { log(`FAIL: vite preview ne répond pas sur ${PORT}`); teardown(); process.exit(2); }
  log(`vite preview prêt sur 127.0.0.1:${PORT} (PID ${pv.p.pid})`);

  const ch = spawnDetached(CHROME, [
    '--headless=new', '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', `--remote-debugging-port=${CDP_PORT}`,
    '--user-data-dir=' + join(tmp, 'chrome_gl_viewer_cdp'), '--window-size=1280,720',
    // --mute-audio : pas de sortie sonore en test ; --autoplay-policy : débloquer
    // play() programmatique sans geste utilisateur (sections audio S13/S15 uniquement).
    '--mute-audio', '--autoplay-policy=no-user-gesture-required', 'about:blank',
  ], 'gameloom_viewer_ch.log');
  started.push(ch);
  if (!(await waitPort(CDP_PORT, 20000))) { log(`FAIL: Chrome CDP ne répond pas sur ${CDP_PORT}`); teardown(); process.exit(2); }
  log(`chrome headless prêt (PID ${ch.p.pid})`);

  // ---------- assets temporaires de collider (sphere/capsule) — dans dist/ uniquement ----------
  // Les 14 assets officiels ont tous un collider box : pour valider les branches
  // sphere/capsule du viewer SANS toucher aux assets officiels (ni aux jeux), on génère
  // 2 GLB éphémères dans dist/assets/ (gitignored) via le CLI glb lui-même.
  for (const [name, type, size] of [['sphere', 'sphere', '1'], ['capsule', 'capsule', '0.5,0.5']]) {
    const dst = join(REPO, `dist/assets/_viewer_tmp_${type}.glb`);
    cpSync(join(REPO, 'assets', 'crate.glb'), dst);
    execSync(`node tools/cli.mjs collider set "dist/assets/_viewer_tmp_${type}.glb" --type ${type} --size ${size} --center 0,0.75,0`, { cwd: REPO, stdio: 'inherit' });
  }
  log('assets temporaires de test (sphere/capsule) générés dans dist/ (jamais dans assets/)');

  // ---------- CDP ----------
  class CDP {
    constructor(wsUrl) {
      this.ws = new WebSocket(wsUrl, { perMessageDeflate: false });
      this.id = 0; this.pending = new Map();
      this.consoleLogs = []; this.errors = []; this.exceptions = [];
    }
    connect() {
      return new Promise((res, rej) => {
        this.ws.on('open', res);
        this.ws.on('error', rej);
        this.ws.on('message', (raw) => {
          const m = JSON.parse(raw.toString());
          if (m.id && this.pending.has(m.id)) {
            const { resolve, reject } = this.pending.get(m.id);
            this.pending.delete(m.id);
            m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
          } else if (m.method) {
            if (m.method === 'Runtime.consoleAPICalled') {
              const text = m.params.args.map((a) => a.value ?? a.description ?? a.unserializableValue ?? '').join(' ');
              this.consoleLogs.push({ type: m.params.type, text });
              if (m.params.type === 'error') this.errors.push(text);
            }
            if (m.method === 'Runtime.exceptionThrown') {
              const d = m.params.exceptionDetails;
              this.exceptions.push(d.exception?.description ?? d.text ?? 'exception');
            }
          }
        });
      });
    }
    send(method, params = {}) {
      const id = ++this.id;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout ${method}`)); } }, 15000);
      });
    }
    async eval(expr, { awaitPromise = true } = {}) {
      const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
      if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
      return r.result.value;
    }
    close() { try { this.ws.close(); } catch { } }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let page;
  try {
    let r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' });
    if (!r.ok) r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`);
    page = await r.json();
  } catch (e) { log(`ERREUR: création du target page: ${e.message}`); teardown(); process.exit(2); }
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

  async function navigate(url) {
    cdp.errors.length = 0;
    cdp.exceptions.length = 0;
    await cdp.send('Page.navigate', { url });
  }
  async function waitLoaded() {
    for (let i = 0; i < 80; i++) {
      await sleep(300);
      try {
        if (await cdp.eval('typeof window.GameLoomViewer === "object"')) {
          if (await cdp.eval('GameLoomViewer.asset().loaded')) return true;
        }
      } catch { }
    }
    return false;
  }
  async function waitApi() {
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      try { if (await cdp.eval('typeof window.GameLoomViewer === "object"')) return true; } catch { }
    }
    return false;
  }
  async function waitChoice(n) {
    for (let i = 0; i < 80; i++) {
      await sleep(300);
      try {
        const st = await cdp.eval(`typeof GameLoomViewer === 'object' && GameLoomViewer.mode().mode === 'choice' && GameLoomViewer.choices().length === ${n} && GameLoomViewer.choices().every(c => c.loaded || c.error)`);
        if (st) return true;
      } catch { }
    }
    return false;
  }
  const noErrorSegment = (label) => {
    check(`${label}: sans exception JS`, cdp.exceptions.length === 0, cdp.exceptions.slice(0, 2));
    // Bruit attendu et toléré : WebGL/SwiftShader (headless) + erreurs media natifs Chrome
    // sur les fixtures INVALIDES volontaires (candidat invalide = erreur locale par contrat).
    const real = cdp.errors.filter((e) => !/WebGL|GL |audio|Audio|MEDIA_ELEMENT/i.test(e));
    check(`${label}: sans console.error inattendue`, real.length === 0, real.slice(0, 2));
  };

  // ---------- S1: boot + barrel.glb (GLB réel, metadata complètes) ----------
  await navigate(`${BASE}/viewer.html?asset=/assets/barrel.glb&collider=1`);
  const apiReady = await waitApi();
  check('S1 boot: window.GameLoomViewer exposé', apiReady);
  const loaded1 = await waitLoaded();
  check('S1 barrel: GLB réel chargé (loaded=true)', loaded1);
  if (!apiReady || !loaded1) {
    console.log('ERREURS:', JSON.stringify(cdp.errors.slice(-5)));
    console.log('EXCEPTIONS:', JSON.stringify(cdp.exceptions.slice(-3)));
  }

  const infoJson = await cdp.eval('JSON.stringify(GameLoomViewer.info())');
  let info1 = null;
  try { info1 = JSON.parse(infoJson); } catch { }
  check('S1 info(): sérialisable JSON (round-trip)', info1 !== null && info1.loaded === true, info1 && { keys: Object.keys(info1).length });
  check('S1 metadata détectées (collider box + dynamic + Health 50)',
    info1?.metadata?.collider?.type === 'box' && info1?.metadata?.physics?.body === 'dynamic' && info1?.metadata?.physics?.mass === 30 && info1?.metadata?.components?.Health?.max === 50,
    info1?.metadata);
  check('S1 mesh count > 0 + vertices/triangles > 0', info1?.meshes > 0 && info1?.vertices > 0 && info1?.triangles > 0, info1 && { meshes: info1.meshes, vertices: info1.vertices, triangles: info1.triangles });
  check('S1 bounding box valide (size > 0, min < max)',
    info1?.bbox && info1.bbox.size.every((n) => n > 0) && [0, 1, 2].every((i) => info1.bbox.min[i] < info1.bbox.max[i]), info1?.bbox);
  check('S1 collider détecté sur asset pourvu d’un collider (box)', info1?.metadata?.collider?.type === 'box', { type: info1?.metadata?.collider?.type, size: info1?.metadata?.collider?.size });

  const wf1 = await cdp.eval('GameLoomViewer.setWireframe(true)');
  check('S1 toggle wireframe ON', wf1?.ok === true && wf1?.wireframe === true, wf1);
  const urlWf = await cdp.eval('location.search');
  check('S1 URL réécrite (wireframe=1 présent)', /wireframe=1/.test(urlWf), urlWf);
  const wf0 = await cdp.eval('GameLoomViewer.setWireframe(false)');
  check('S1 toggle wireframe OFF (réversible, matériaux intact)', wf0?.ok === true && wf0?.wireframe === false, wf0);
  const mat0 = await cdp.eval('GameLoomViewer.setMaterialsVisible(false)');
  const mat1 = await cdp.eval('GameLoomViewer.setMaterialsVisible(true)');
  check('S1 toggle materials OFF→ON (restauration originaux)', mat0?.ok === true && mat1?.ok === true && mat1?.visible === true, { mat0, mat1 });
  const bb = await cdp.eval('GameLoomViewer.setBoundingBoxVisible(true)');
  check('S1 toggle bounding box ON', bb?.ok === true && bb?.visible === true, bb);
  const sk1 = await cdp.eval('GameLoomViewer.setSkeletonVisible(true)');
  check('S1 skeleton API sans rig: ne plante pas (no-op propre)', sk1?.ok === true && sk1?.visible === true, sk1);
  const g0 = await cdp.eval('GameLoomViewer.setGridVisible(false)');
  const g1 = await cdp.eval('GameLoomViewer.setGridVisible(true)');
  const ax = await cdp.eval('GameLoomViewer.setAxesVisible(true)');
  const m0 = await cdp.eval('GameLoomViewer.setMeshVisible(false)');
  const m1 = await cdp.eval('GameLoomViewer.setMeshVisible(true)');
  check('S1 toggles grid/axes/mesh', g0?.ok && g1?.ok && ax?.ok === true && m0?.ok === true && m1?.ok === true && m1?.visible === true, { g1, ax, m1 });
  noErrorSegment('S1 barrel');

  // ---------- S2: animations — comportement négatif (aucun clip dans barrel.glb) ----------
  const anims = await cdp.eval('GameLoomViewer.animations()');
  check('S2 animations(): liste vide (aucun clip) sans crash', Array.isArray(anims) && anims.length === 0, anims);
  const pl = await cdp.eval('GameLoomViewer.playAnimation("Walk")');
  check('S2 playAnimation sans animation: {ok:false, error} sans exception', pl?.ok === false && typeof pl?.error === 'string', pl);
  const pa = await cdp.eval('GameLoomViewer.pauseAnimation()');
  const st = await cdp.eval('GameLoomViewer.stopAnimation()');
  const at = await cdp.eval('GameLoomViewer.setAnimationTime(1)');
  const sp = await cdp.eval('GameLoomViewer.setAnimationSpeed(2)');
  const st2 = await cdp.eval('GameLoomViewer.getState()');
  check('S2 pause/stop/setTime sans animation: pas de crash', pa?.ok === false && st?.ok === false && at?.ok === false, { pa, st, at });
  check('S2 setAnimationSpeed: valeur stockée (speed=2 dans getState)', sp?.ok === true && st2?.speed === 2, { sp, speed: st2?.speed });
  noErrorSegment('S2 animations négatif');

  // ---------- S3: skeleton — comportement négatif (aucun rig dans barrel.glb) ----------
  check('S3 rig détecté: NON (barrel), 0 skinned mesh, 0 bones', info1?.rigDetected === false && info1?.skinnedMeshes === 0 && info1?.bones === 0,
    { rigDetected: info1?.rigDetected, skinnedMeshes: info1?.skinnedMeshes, bones: info1?.bones });
  noErrorSegment('S3 skeleton négatif');

  // ---------- S4: autre asset (guardian: kinematic + Health 100) ----------
  await navigate(`${BASE}/viewer.html?asset=/assets/guardian.glb&collider=1&bbox=1`);
  const loaded4 = await waitLoaded();
  const info4 = await cdp.eval('JSON.stringify(GameLoomViewer.info())').then((j) => JSON.parse(j));
  check('S4 guardian chargé + metadata (kinematic, Health 100, collider box)',
    loaded4 && info4?.loaded === true && info4?.metadata?.physics?.body === 'kinematic' && info4?.metadata?.components?.Health?.max === 100 && info4?.metadata?.collider?.type === 'box',
    { body: info4?.metadata?.physics?.body, health: info4?.metadata?.components?.Health?.max, collider: info4?.metadata?.collider?.type });
  const st4 = await cdp.eval('GameLoomViewer.getState()');
  check('S4 URL state: bbox=1 respecté (getState bbox=true)', st4?.bbox === true, st4);
  noErrorSegment('S4 guardian');

  // ---------- S5: collider sphere (asset temporaire, branche positive) ----------
  await navigate(`${BASE}/viewer.html?asset=/assets/_viewer_tmp_sphere.glb&collider=1`);
  const loaded5 = await waitLoaded();
  const info5 = await cdp.eval('JSON.stringify(GameLoomViewer.info())').then((j) => JSON.parse(j));
  const col5 = await cdp.eval('GameLoomViewer.setColliderVisible(true)');
  check('S5 collider SPHERE: asset chargé + type sphere dans la méta + overlay sans crash',
    loaded5 && info5?.loaded === true && info5?.metadata?.collider?.type === 'sphere' && info5?.metadata?.collider?.size?.[0] === 1 && col5?.ok === true,
    { type: info5?.metadata?.collider?.type, size: info5?.metadata?.collider?.size });
  noErrorSegment('S5 sphere');

  // ---------- S6: collider capsule (asset temporaire, branche positive) ----------
  await navigate(`${BASE}/viewer.html?asset=/assets/_viewer_tmp_capsule.glb&collider=1`);
  const loaded6 = await waitLoaded();
  const info6 = await cdp.eval('JSON.stringify(GameLoomViewer.info())').then((j) => JSON.parse(j));
  check('S6 collider CAPSULE: chargé + type capsule size [rayon, demi-hauteur]',
    loaded6 && info6?.metadata?.collider?.type === 'capsule' && info6?.metadata?.collider?.size?.length === 2,
    { type: info6?.metadata?.collider?.type, size: info6?.metadata?.collider?.size });
  noErrorSegment('S6 capsule');

  // ---------- S7: URL state complet (vue partagée par un agent) ----------
  await navigate(`${BASE}/viewer.html?asset=/assets/barrel.glb&wireframe=1&bbox=1&axes=1&mesh=0&materials=0&collider=1&speed=1.5`);
  const loaded7 = await waitLoaded();
  const st7 = await cdp.eval('GameLoomViewer.getState()');
  check('S7 URL state: wireframe/bbox/axes=1, mesh/materials=0, speed=1.5',
    loaded7 && st7?.wireframe === true && st7?.bbox === true && st7?.axes === true && st7?.mesh === false && st7?.materials === false && st7?.speed === 1.5, st7);
  noErrorSegment('S7 URL state');

  // ---------- S8: boot vide (aucun ?asset) — pas de liste codée en dur, pas de crash ----------
  await navigate(`${BASE}/viewer.html`);
  const api8 = await waitApi();
  const a8 = await cdp.eval('GameLoomViewer.asset()');
  const i8 = await cdp.eval('JSON.stringify(GameLoomViewer.info())').then((j) => JSON.parse(j));
  check('S8 boot vide: API disponible, loaded=false, info().loaded=false (aucun asset imposé)',
    api8 && a8?.loaded === false && i8?.loaded === false && i8?.uri === null, { a8, i8 });
  noErrorSegment('S8 boot vide');

  // ---------- S9: screenshot de validation visuelle (gitignored tools/*_screenshot.png) ----------
  await navigate(`${BASE}/viewer.html?asset=/assets/guardian.glb&collider=1&bbox=1`);
  await waitLoaded();
  await sleep(600);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(REPO, 'tools', 'viewer_screenshot.png'), Buffer.from(shot.data, 'base64'));
  check('S9 screenshot capturé (validation visuelle)', true, 'tools/viewer_screenshot.png');

  // ---------- S10: CHOICE GLB — 3 candidats simultanés sur UNE page ----------
  await navigate(`${BASE}/viewer.html?choice=/assets/ammo_military.glb,/assets/ammo_scifi.glb,/assets/ammo_industrial.glb`);
  const choiceReady = await waitChoice(3);
  const mode10 = await cdp.eval('GameLoomViewer.mode().mode').catch(() => null);
  check('S10 choice: mode=choice + 3 candidats chargés simultanément', choiceReady && mode10 === 'choice', { mode10 });
  const nCards = await cdp.eval('document.querySelectorAll(".card").length');
  const nCanvases = await cdp.eval('document.querySelectorAll(".card-vp canvas").length');
  check('S10 choice: 3 cartes + 3 viewports canvas indépendants (1 page, 0 onglet)', nCards === 3 && nCanvases === 3, { nCards, nCanvases });
  const ch10 = await cdp.eval('JSON.stringify(GameLoomViewer.choices())').then((j) => JSON.parse(j));
  check('S10 choice: 3 URI correctes, toutes loaded=true', ch10.length === 3 && ch10.every((c) => c.loaded === true), ch10.map((c) => c.uri));
  const tris = ch10.map((c) => c.info && c.info.triangles);
  const bbs = ch10.map((c) => c.info && c.info.bbox && c.info.bbox.size);
  check('S10 choice: metadata INDÉPENDANTES par candidat (triangles + bbox distincts)',
    new Set(tris).size === 3 && new Set(bbs.map((b) => JSON.stringify(b))).size === 3, { tris, bbs });
  const selA = await cdp.eval("GameLoomViewer.selectChoice('/assets/ammo_military.glb')");
  const getA = await cdp.eval('JSON.stringify(GameLoomViewer.getChoice())');
  const urlA = await cdp.eval('location.search');
  check('S10 choice: choix A — selectChoice + getChoice() + état URL &selected=',
    selA?.ok === true && JSON.parse(getA).selected === '/assets/ammo_military.glb' && /selected=%2Fassets%2Fammo_military\.glb/.test(urlA), { selA, urlA });
  const selB = await cdp.eval("GameLoomViewer.selectChoice('/assets/ammo_scifi.glb')");
  const getB = await cdp.eval('JSON.stringify(GameLoomViewer.getChoice())');
  const visB = await cdp.eval('document.querySelectorAll(".card.selected .card-title strong").length');
  check('S10 choice: changement A→B — getChoice() exact + 1 seule carte sélectionnée visuellement',
    selB?.ok === true && JSON.parse(getB).selected === '/assets/ammo_scifi.glb' && visB === 1, { getB: JSON.parse(getB), visB });
  const selBad = await cdp.eval("GameLoomViewer.selectChoice('/assets/inconnu.glb')");
  check('S10 choice: URI inconnue refusée proprement ({ok:false, error}, sans exception)', selBad?.ok === false && typeof selBad?.error === 'string', selBad);
  noErrorSegment('S10 choice GLB');

  // ---------- S10d: PUSH — window event "gameloom:choice" (contrat complémentaire du pull) ----------
  // Le listener est installé AVANT toute sélection ; le pont localStorage permet de
  // vérifier (après navigation) qu'INSPECT n'a pas émis d'événement CHOOSE.
  await cdp.eval(`localStorage.setItem('gc_events', '[]');
    window.addEventListener('gameloom:choice', (e) => {
      const a = JSON.parse(localStorage.getItem('gc_events') || '[]');
      a.push(e.detail);
      localStorage.setItem('gc_events', JSON.stringify(a));
    });`);
  const evCount0 = await cdp.eval('JSON.parse(localStorage.getItem("gc_events")).length');
  check('S10d push: aucun événement avant sélection (listener installé avant)', evCount0 === 0, { evCount0 });
  await cdp.eval("document.querySelectorAll('.btn-choose')[0].click()");
  const evA = await cdp.eval('JSON.parse(localStorage.getItem("gc_events"))');
  const getEvA = await cdp.eval('JSON.stringify(GameLoomViewer.getChoice())');
  check('S10d push: CHOOSE A (bouton réel) — exactement 1 événement, detail.selected === URI A, getChoice() === URI A',
    evA.length === 1 && evA[0].selected === '/assets/ammo_military.glb' && JSON.parse(getEvA).selected === '/assets/ammo_military.glb', evA);
  const evRoundTrip = await cdp.eval(`(() => { const s = JSON.stringify(JSON.parse(localStorage.getItem('gc_events'))); const p = JSON.parse(s); return p.length === 1 && p[0].selected === '/assets/ammo_military.glb'; })()`);
  check('S10d push: payload JSON.stringify-compatible (round-trip) + champs {selected,index,type} GLB',
    evA[0].index === 0 && evA[0].type === 'glb' && evRoundTrip === true, evA[0]);
  await cdp.eval("document.querySelectorAll('.btn-choose')[1].click()");
  const evB = await cdp.eval('JSON.parse(localStorage.getItem("gc_events"))');
  const getEvB = await cdp.eval('JSON.stringify(GameLoomViewer.getChoice())');
  check('S10d push: CHOOSE B — exactement 1 nouvel événement (2 au total), detail.selected === URI B, getChoice() === URI B',
    evB.length === 2 && evB[1].selected === '/assets/ammo_scifi.glb' && JSON.parse(getEvB).selected === '/assets/ammo_scifi.glb', evB.map((e) => e.selected));
  noErrorSegment('S10d push GLB');

  // ---------- S10b: INSPECT — bouton réel → viewer mono-asset existant ----------
  await cdp.eval('document.querySelectorAll(".btn-inspect")[1].click()');
  const api10b = await waitApi();
  const loaded10b = await waitLoaded();
  const mode10b = await cdp.eval('GameLoomViewer.mode().mode');
  const asset10b = await cdp.eval('JSON.stringify(GameLoomViewer.asset())');
  check('S10b INSPECT: bouton → viewer mono-asset ?asset= (mode single + asset correct chargé)',
    api10b && loaded10b && mode10b === 'single' && JSON.parse(asset10b).uri === '/assets/ammo_scifi.glb', { mode10b, asset: asset10b });
  const evInspect = await cdp.eval('JSON.parse(localStorage.getItem("gc_events") || "[]").length');
  check('S10b INSPECT: aucun événement gameloom:choice artificiel (compteur inchangé = 2 après navigation)', evInspect === 2, { evInspect });
  noErrorSegment('S10b inspect');

  // ---------- S10c: retour Choice Mode — URL partagée conserve la sélection ----------
  await navigate(`${BASE}/viewer.html?choice=/assets/ammo_military.glb,/assets/ammo_scifi.glb,/assets/ammo_industrial.glb&selected=/assets/ammo_scifi.glb`);
  const choiceBack = await waitChoice(3);
  const selBack = await cdp.eval('JSON.stringify(GameLoomViewer.getChoice())');
  check('S10c retour choice: &selected= restauré au boot (sélection humaine préservée, stateless)',
    choiceBack && JSON.parse(selBack).selected === '/assets/ammo_scifi.glb', selBack);
  noErrorSegment('S10c retour choice');

  // ---------- S11: CHOICE GLB — candidat invalide : erreur LOCALE, autres opérationnels ----------
  writeFileSync(join(REPO, 'dist/assets/_viewer_tmp_bad.glb'), Buffer.from('CECI N EST PAS UN GLB'));
  await navigate(`${BASE}/viewer.html?choice=/assets/ammo_military.glb,/assets/_viewer_tmp_bad.glb,/assets/ammo_scifi.glb`);
  const choice11 = await waitChoice(3);
  const ch11 = await cdp.eval('JSON.stringify(GameLoomViewer.choices())').then((j) => JSON.parse(j));
  check('S11 GLB invalide: erreur locale sur SA carte seulement (loaded=false + error, sans crash global)',
    choice11 && ch11[1].loaded === false && typeof ch11[1].error === 'string' && ch11[1].error.length > 0,
    ch11[1] && { loaded: ch11[1].loaded, error: ch11[1].error });
  check('S11 GLB invalide: les 2 autres candidats restent chargés et fonctionnels',
    ch11[0].loaded === true && ch11[2].loaded === true, ch11.map((c) => ({ uri: c.uri, loaded: c.loaded })));
  const sel11 = await cdp.eval("GameLoomViewer.selectChoice('/assets/ammo_scifi.glb')");
  const get11 = await cdp.eval('JSON.stringify(GameLoomViewer.getChoice())');
  check('S11 GLB invalide: sélection sur un candidat valide fonctionne quand même',
    sel11?.ok === true && JSON.parse(get11).selected === '/assets/ammo_scifi.glb', get11);
  noErrorSegment('S11 GLB invalide');

  // ---------- S12: CHOICE IMAGE — 3 images (PNG générés Node pur), dimensions + sélection ----------
  for (const [name, w, h, rgb] of [['img_a', 320, 200, [200, 40, 60]], ['img_b', 256, 128, [40, 90, 200]], ['img_c', 400, 150, [50, 160, 80]]]) {
    writeFileSync(join(REPO, `dist/assets/_viewer_tmp_${name}.png`), makePng(w, h, rgb));
  }
  await navigate(`${BASE}/viewer.html?choice=/assets/_viewer_tmp_img_a.png,/assets/_viewer_tmp_img_b.png,/assets/_viewer_tmp_img_c.png`);
  const choice12 = await waitChoice(3);
  const ch12 = await cdp.eval('JSON.stringify(GameLoomViewer.choices())').then((j) => JSON.parse(j));
  const dims = ch12.map((c) => `${c.width}x${c.height}:${c.format}`);
  check('S12 choice images: 3 images chargées + dimensions exactes (320x200 / 256x128 / 400x150 PNG)',
    choice12 && dims.join(',') === '320x200:PNG,256x128:PNG,400x150:PNG', dims);
  const nCanvas12 = await cdp.eval('document.querySelectorAll(".card-vp canvas").length');
  check('S12 choice images: PAS de viewport Three.js inutile pour des images (0 canvas)', nCanvas12 === 0, nCanvas12);
  const sel12 = await cdp.eval("GameLoomViewer.selectChoice('/assets/_viewer_tmp_img_b.png')");
  const get12 = await cdp.eval('JSON.stringify(GameLoomViewer.getChoice())');
  const url12 = await cdp.eval('location.search');
  check('S12 choice images: sélection + getChoice() + état URL &selected=',
    sel12?.ok === true && JSON.parse(get12).selected === '/assets/_viewer_tmp_img_b.png' && /selected=/.test(url12), get12);
  noErrorSegment('S12 choice images');

  // ---------- S12b: PUSH — window event "gameloom:choice" sur des images (type=image) ----------
  await cdp.eval(`localStorage.setItem('gc_img', '[]');
    window.addEventListener('gameloom:choice', (e) => {
      const a = JSON.parse(localStorage.getItem('gc_img') || '[]');
      a.push(e.detail);
      localStorage.setItem('gc_img', JSON.stringify(a));
    });`);
  await cdp.eval("document.querySelectorAll('.btn-choose')[0].click()");
  const evImg = await cdp.eval('JSON.parse(localStorage.getItem("gc_img"))');
  const getImg = await cdp.eval('JSON.stringify(GameLoomViewer.getChoice())');
  check('S12b push images: CHOOSE image A (bouton réel) — 1 événement, detail.selected === URI A, getChoice() === URI A, type=image index=0',
    evImg.length === 1 && evImg[0].selected === '/assets/_viewer_tmp_img_a.png' && evImg[0].type === 'image' && evImg[0].index === 0 && JSON.parse(getImg).selected === '/assets/_viewer_tmp_img_a.png', evImg[0]);
  const imgRoundTrip = await cdp.eval(`(() => { const s = JSON.stringify(JSON.parse(localStorage.getItem('gc_img'))); const p = JSON.parse(s); return p.length === 1 && p[0].selected === '/assets/_viewer_tmp_img_a.png'; })()`);
  check('S12b push images: payload JSON.stringify-compatible (round-trip)', imgRoundTrip === true, evImg[0]);
  noErrorSegment('S12b push images');

  // ---------- S13: AUDIO MONO — ?asset=.wav (lecteur natif, zéro Three.js) ----------
  // Fixtures WAV synthétisés (Node pur, RIFF/PCM) — dans dist/ uniquement (gitignored),
  // jamais dans assets/ (invariant GLB-only du checker).
  for (const [name, freq, secs] of [['low', 220, 0.8], ['mid', 440, 0.6], ['high', 880, 0.5]]) {
    writeFileSync(join(REPO, `dist/assets/_viewer_tmp_tone_${name}.wav`), makeWav(freq, secs));
  }
  await navigate(`${BASE}/viewer.html?asset=/assets/_viewer_tmp_tone_mid.wav`);
  const api13 = await waitApi();
  const loaded13 = await waitLoaded();
  const a13 = await cdp.eval('JSON.stringify(GameLoomViewer.asset())').then((j) => JSON.parse(j));
  check('S13 audio mono: API + asset().loaded=true (WAV chargé)', api13 && loaded13 && a13?.loaded === true && a13?.uri === '/assets/_viewer_tmp_tone_mid.wav', a13);
  const i13 = await cdp.eval('JSON.stringify(GameLoomViewer.info())').then((j) => JSON.parse(j));
  check('S13 audio mono: info() JSON (type=audio, format WAV, durée ≈ 0.60 s)',
    i13?.loaded === true && i13?.type === 'audio' && i13?.format === 'WAV' && Math.abs((i13?.duration ?? 0) - 0.6) < 0.05, i13);
  const mode13 = await cdp.eval('GameLoomViewer.mode().mode');
  check('S13 audio mono: mode() = single (contrat mono inchangé)', mode13 === 'single', { mode13 });
  const nCanvas13 = await cdp.eval('document.querySelectorAll("canvas").length');
  check('S13 audio mono: ZÉRO Three.js initialisé (0 canvas WebGL sur la page)', nCanvas13 === 0, nCanvas13);
  const hasCtl13 = await cdp.eval('document.querySelector("#viewport .audio-stage audio")?.controls === true');
  check('S13 audio mono: lecteur natif <audio controls> (Play/Pause/position/volume)', hasCtl13 === true);
  const dur13 = await cdp.eval('document.querySelector("#viewport audio").duration');
  check('S13 audio mono: durée lue ≈ 0.6 s (0.5–0.7)', dur13 > 0.5 && dur13 < 0.7, { dur13 });
  await cdp.eval('(() => { const a = document.querySelector("#viewport audio"); a.muted = true; a.play().catch(() => null); })()');
  await sleep(250);
  const playing13 = await cdp.eval('!document.querySelector("#viewport audio").paused');
  check('S13 audio mono: play() → lecture en cours (paused=false)', playing13 === true);
  await cdp.eval('document.querySelector("#viewport audio").pause()');
  await sleep(50);
  const paused13 = await cdp.eval('document.querySelector("#viewport audio").paused');
  check('S13 audio mono: pause() → paused=true', paused13 === true);
  const vol13 = await cdp.eval('(() => { const a = document.querySelector("#viewport audio"); a.volume = 0.5; return a.volume; })()');
  check('S13 audio mono: volume contrôlable (0.5 appliqué)', vol13 === 0.5, { vol13 });
  const st13 = await cdp.eval('GameLoomViewer.setWireframe(true)');
  check('S13 audio mono: méthode GLB inapplicable → {ok:false,error} sans exception (surface sûre)',
    st13?.ok === false && typeof st13?.error === 'string', st13);
  noErrorSegment('S13 audio mono');

  // ---------- S14: IMAGE MONO — ?asset=.png/.jpg/.webp (<img> natif, zéro Three.js) ----------
  // PNG : fixture du S12 (makePng Node pur) · JPEG/WebP : base64 embarquées (valides).
  writeFileSync(join(REPO, 'dist/assets/_viewer_tmp_img_jpeg.jpg'), Buffer.from(FIX_JPEG_B64, 'base64'));
  writeFileSync(join(REPO, 'dist/assets/_viewer_tmp_img_webp.webp'), Buffer.from(FIX_WEBP_B64, 'base64'));

  await navigate(`${BASE}/viewer.html?asset=/assets/_viewer_tmp_img_a.png`);
  const loaded14 = await waitLoaded();
  const info14 = await cdp.eval('JSON.stringify(GameLoomViewer.info())').then((j) => JSON.parse(j));
  const mode14 = await cdp.eval('GameLoomViewer.mode().mode');
  check('S14 image mono PNG: mode single + info() exacte {type:"image", format:"PNG", 320×200, error:null}',
    loaded14 && mode14 === 'single' && info14?.loaded === true && info14?.type === 'image'
    && info14?.format === 'PNG' && info14?.width === 320 && info14?.height === 200 && info14?.error === null, info14);
  const dom14 = await cdp.eval(`(() => {
    const el = document.querySelector('#viewport .img-stage img');
    if (!el) return null;
    return { nw: el.naturalWidth, nh: el.naturalHeight, box: Math.round(el.getBoundingClientRect().width) };
  })()`);
  check('S14 image mono PNG: image RÉELLEMENT affichée (naturalWidth 320, bounding box > 0)',
    dom14?.nw === 320 && dom14?.nh === 200 && dom14?.box > 0, dom14);
  const nCanvas14 = await cdp.eval('document.querySelectorAll("canvas").length');
  check('S14 image mono PNG: ZÉRO Three.js (0 canvas sur la page = aucun WebGLRenderer)', nCanvas14 === 0, nCanvas14);
  noErrorSegment('S14 image mono PNG');

  await navigate(`${BASE}/viewer.html?asset=/assets/_viewer_tmp_img_jpeg.jpg`);
  const loaded14b = await waitLoaded();
  const info14b = await cdp.eval('JSON.stringify(GameLoomViewer.info())').then((j) => JSON.parse(j));
  check('S14 image mono JPEG: format exact + dimensions exactes (JPEG 192×104)',
    loaded14b && info14b?.loaded === true && info14b?.format === 'JPEG' && info14b?.width === 192 && info14b?.height === 104, info14b);
  noErrorSegment('S14 image mono JPEG');

  await navigate(`${BASE}/viewer.html?asset=/assets/_viewer_tmp_img_webp.webp`);
  const loaded14c = await waitLoaded();
  const info14c = await cdp.eval('JSON.stringify(GameLoomViewer.info())').then((j) => JSON.parse(j));
  check('S14 image mono WebP: format exact + dimensions exactes (WebP 128×96)',
    loaded14c && info14c?.loaded === true && info14c?.format === 'WebP' && info14c?.width === 128 && info14c?.height === 96, info14c);
  noErrorSegment('S14 image mono WebP');

  // ---------- S14b: CHOICE IMAGES → INSPECT réel → mono-asset image fonctionnel ----------
  await navigate(`${BASE}/viewer.html?choice=/assets/_viewer_tmp_img_a.png,/assets/_viewer_tmp_img_jpeg.jpg,/assets/_viewer_tmp_img_webp.webp`);
  const choiceI = await waitChoice(3);
  check('S14b choice images: 3 candidats chargés (précondition INSPECT réel)', choiceI === true);
  await cdp.eval('document.querySelectorAll(".btn-inspect")[1].click()');
  const apiI = await waitApi();
  const loadedI = await waitLoaded();
  const modeI = await cdp.eval('GameLoomViewer.mode().mode');
  const assetI = await cdp.eval('JSON.stringify(GameLoomViewer.asset())').then((j) => JSON.parse(j));
  const infoI = await cdp.eval('JSON.stringify(GameLoomViewer.info())').then((j) => JSON.parse(j));
  check('S14b INSPECT image: clic réel → ?asset=<URI image> → single image chargée (mode single, JPEG 192×104)',
    apiI && loadedI && modeI === 'single' && assetI?.uri === '/assets/_viewer_tmp_img_jpeg.jpg' && assetI?.loaded === true
    && infoI?.type === 'image' && infoI?.loaded === true && infoI?.width === 192 && infoI?.height === 104,
    { modeI, uri: assetI?.uri, info: infoI && { format: infoI.format, width: infoI.width, height: infoI.height } });
  noErrorSegment('S14b inspect image');

  // ---------- S15: CHOICE AUDIO — 3 WAV + single active audio + CHOOSE A→B + push ----------
  await navigate(`${BASE}/viewer.html?choice=/assets/_viewer_tmp_tone_low.wav,/assets/_viewer_tmp_tone_mid.wav,/assets/_viewer_tmp_tone_high.wav`);
  const choice15 = await waitChoice(3);
  const ch15 = await cdp.eval('JSON.stringify(GameLoomViewer.choices())').then((j) => JSON.parse(j));
  const durs15 = ch15.map((c) => c.duration);
  check('S15 choice audio: 3 WAV chargés (kinds audio, format WAV, durées ≈ 0.8/0.6/0.5 = fichiers distincts)',
    choice15 && ch15.length === 3 && ch15.every((c) => c.loaded === true && c.kind === 'audio' && c.format === 'WAV')
    && Math.abs(durs15[0] - 0.8) < 0.05 && Math.abs(durs15[1] - 0.6) < 0.05 && Math.abs(durs15[2] - 0.5) < 0.05,
    { durs15, kinds: ch15.map((c) => c.kind) });
  const nCanvas15 = await cdp.eval('document.querySelectorAll(".card canvas").length');
  const nAudio15 = await cdp.eval('document.querySelectorAll(".card audio").length');
  check('S15 choice audio: 3 lecteurs <audio>, PAS de Three.js (0 canvas)', nCanvas15 === 0 && nAudio15 === 3, { nCanvas15, nAudio15 });
  // single active audio : lancer B pendant que A joue → A mis en pause
  await cdp.eval(`(() => { const a = document.querySelectorAll('.card audio'); a[0].muted = true; a[0].volume = 0.3; a[0].play().catch(() => null); })()`);
  await sleep(250);
  const aBefore15 = await cdp.eval('!document.querySelectorAll(".card audio")[0].paused');
  check('S15 single active: A joue (précondition)', aBefore15 === true);
  await cdp.eval(`(() => { const a = document.querySelectorAll('.card audio'); a[1].muted = true; a[1].play().catch(() => null); })()`);
  await sleep(250);
  const aPaused15 = await cdp.eval('document.querySelectorAll(".card audio")[0].paused');
  const bPlaying15 = await cdp.eval('!document.querySelectorAll(".card audio")[1].paused');
  check('S15 single active audio: lancer B met A en pause (un seul son actif à la fois)',
    aPaused15 === true && bPlaying15 === true, { aPaused15, bPlaying15 });
  await cdp.eval(`document.querySelectorAll('.card audio')[1].pause()`);
  // CHOOSE A puis B (boutons réels) + push event (contrat gameloom:choice)
  await cdp.eval(`localStorage.setItem('gc_audio', '[]');
    window.addEventListener('gameloom:choice', (e) => {
      const a = JSON.parse(localStorage.getItem('gc_audio') || '[]');
      a.push(e.detail);
      localStorage.setItem('gc_audio', JSON.stringify(a));
    });`);
  await cdp.eval("document.querySelectorAll('.btn-choose')[0].click()");
  const evA15 = await cdp.eval('JSON.parse(localStorage.getItem("gc_audio"))');
  const getA15 = await cdp.eval('JSON.stringify(GameLoomViewer.getChoice())');
  check('S15 choice audio: CHOOSE A — exactement 1 événement, selected=URI A, getChoice()=URI A',
    evA15.length === 1 && evA15[0].selected === '/assets/_viewer_tmp_tone_low.wav' && JSON.parse(getA15).selected === '/assets/_viewer_tmp_tone_low.wav', evA15);
  const rt15 = await cdp.eval(`(() => { const p = JSON.parse(JSON.stringify(JSON.parse(localStorage.getItem('gc_audio')))); return p.length === 1 && p[0].selected === '/assets/_viewer_tmp_tone_low.wav' && p[0].type === 'audio' && p[0].index === 0; })()`);
  check('S15 choice audio: payload {selected,index,type} avec type="audio" index=0 (round-trip JSON)', rt15 === true, evA15[0]);
  await cdp.eval("document.querySelectorAll('.btn-choose')[1].click()");
  const evB15 = await cdp.eval('JSON.parse(localStorage.getItem("gc_audio"))');
  const getB15 = await cdp.eval('JSON.stringify(GameLoomViewer.getChoice())');
  check('S15 choice audio: CHOOSE B — exactement 1 nouvel événement (2 au total), getChoice()=URI B, type="audio"',
    evB15.length === 2 && evB15[1].selected === '/assets/_viewer_tmp_tone_mid.wav' && evB15[1].type === 'audio' && evB15[1].index === 1 && JSON.parse(getB15).selected === '/assets/_viewer_tmp_tone_mid.wav',
    evB15.map((e) => e.selected));
  const urlSel15 = await cdp.eval('location.search');
  check('S15 choice audio: état URL &selected= (choix mémorisé, stateless)', /selected=%2Fassets%2F_viewer_tmp_tone_mid\.wav/.test(urlSel15), urlSel15);
  noErrorSegment('S15 choice audio');

  // ---------- S16: CHOICE AUDIO — candidat invalide = erreur LOCALE, autres opérationnels ----------
  writeFileSync(join(REPO, 'dist/assets/_viewer_tmp_bad.wav'), Buffer.from('CECI N EST PAS UN WAV'));
  await navigate(`${BASE}/viewer.html?choice=/assets/_viewer_tmp_tone_low.wav,/assets/_viewer_tmp_bad.wav,/assets/_viewer_tmp_tone_high.wav`);
  const choice16 = await waitChoice(3);
  const ch16 = await cdp.eval('JSON.stringify(GameLoomViewer.choices())').then((j) => JSON.parse(j));
  check('S16 WAV invalide: erreur locale sur SA carte seulement (loaded=false + error, sans crash global)',
    choice16 && ch16[1].loaded === false && typeof ch16[1].error === 'string' && ch16[1].error.length > 0,
    ch16[1] && { loaded: ch16[1].loaded, error: ch16[1].error });
  check('S16 WAV invalide: les 2 autres candidats restent chargés et fonctionnels',
    ch16[0].loaded === true && ch16[2].loaded === true, ch16.map((c) => ({ uri: c.uri, loaded: c.loaded })));
  const sel16 = await cdp.eval("GameLoomViewer.selectChoice('/assets/_viewer_tmp_tone_high.wav')");
  const get16 = await cdp.eval('JSON.stringify(GameLoomViewer.getChoice())');
  check('S16 WAV invalide: sélection sur un candidat valide fonctionne quand même',
    sel16?.ok === true && JSON.parse(get16).selected === '/assets/_viewer_tmp_tone_high.wav', get16);
  noErrorSegment('S16 WAV invalide');

  // ---------- S17: MIXED CHOICE — GLB + image + audio sur UNE page (viewer générique) ----------
  await navigate(`${BASE}/viewer.html?choice=/assets/barrel.glb,/assets/_viewer_tmp_img_a.png,/assets/_viewer_tmp_tone_low.wav`);
  const choice17 = await waitChoice(3);
  const ch17 = await cdp.eval('JSON.stringify(GameLoomViewer.choices())').then((j) => JSON.parse(j));
  check('S17 mixed: GLB + image + audio simultanés, tous chargés, kinds [glb,image,audio]',
    choice17 && ch17.length === 3 && ch17.every((c) => c.loaded === true)
    && ch17.map((c) => c.kind).join(',') === 'glb,image,audio',
    ch17.map((c) => ({ uri: c.uri, kind: c.kind, loaded: c.loaded })));
  const nCanvas17 = await cdp.eval('document.querySelectorAll(".card canvas").length');
  const nImg17 = await cdp.eval('document.querySelectorAll(".card img").length');
  const nAudio17 = await cdp.eval('document.querySelectorAll(".card audio").length');
  check('S17 mixed: chaque candidat = son renderer (1 canvas GLB, 1 <img>, 1 <audio>)',
    nCanvas17 === 1 && nImg17 === 1 && nAudio17 === 1, { nCanvas17, nImg17, nAudio17 });
  const sel17 = await cdp.eval("GameLoomViewer.selectChoice('/assets/_viewer_tmp_tone_low.wav')");
  const get17 = await cdp.eval('JSON.stringify(GameLoomViewer.getChoice())');
  check('S17 mixed: CHOOSE du candidat audio — getChoice() = URI audio (contrat identique GLB/image)',
    sel17?.ok === true && JSON.parse(get17).selected === '/assets/_viewer_tmp_tone_low.wav', get17);
  noErrorSegment('S17 mixed');

  // INSPECT réel depuis le Choice MIXTE (GLB/image/audio) → mono-asset image
  await cdp.eval('document.querySelectorAll(".btn-inspect")[1].click()');
  const api17b = await waitApi();
  const loaded17b = await waitLoaded();
  const mode17b = await cdp.eval('GameLoomViewer.mode().mode');
  const asset17b = await cdp.eval('JSON.stringify(GameLoomViewer.asset())').then((j) => JSON.parse(j));
  const info17b = await cdp.eval('JSON.stringify(GameLoomViewer.info())').then((j) => JSON.parse(j));
  check('S17 mixed INSPECT: clic réel sur la carte image → ?asset= image → single image chargée (PNG 320×200)',
    api17b && loaded17b && mode17b === 'single' && asset17b?.uri === '/assets/_viewer_tmp_img_a.png'
    && info17b?.type === 'image' && info17b?.loaded === true && info17b?.width === 320,
    { mode17b, uri: asset17b?.uri, dims: info17b && `${info17b.width}x${info17b.height}` });
  noErrorSegment('S17 mixed inspect');

  // retour Choice Mode : URL partagée mixte + sélection préservée (Choice Mode toujours fonctionnel)
  await navigate(`${BASE}/viewer.html?choice=/assets/barrel.glb,/assets/_viewer_tmp_img_a.png,/assets/_viewer_tmp_tone_low.wav&selected=/assets/_viewer_tmp_tone_low.wav`);
  const choice17c = await waitChoice(3);
  const sel17c = await cdp.eval('JSON.stringify(GameLoomViewer.getChoice())').then((j) => JSON.parse(j));
  check('S17 retour choice mixte: 3 candidats rechargés + &selected= préservé (Choice Mode toujours fonctionnel)',
    choice17c && sel17c?.selected === '/assets/_viewer_tmp_tone_low.wav', { sel17c });
  noErrorSegment('S17 retour mixed');

  // ---------- bilan + teardown ----------
  cdp.close();
  teardown();
  const pvFree = await waitPortClosed(PORT, 8000);
  const chFree = await waitPortClosed(CDP_PORT, 8000);
  log(`PORT_${PORT}=${pvFree ? 'LIBRE' : 'OCCUPIÉ'} PORT_${CDP_PORT}=${chFree ? 'LIBRE' : 'OCCUPIÉ'}`);
  for (const f of TMP_GLBs) { try { rmSync(join(REPO, f), { force: true }); } catch { } }
  log('assets temporaires nettoyés');
  const failed = results.filter((r) => !r.pass);
  if (failed.length) { log(`BILAN VIEWER: ${failed.length} échec(s)`); process.exit(1); }
  if (!pvFree || !chFree) { log('FAIL: port(s) non libéré(s) après teardown'); process.exit(2); }
  console.log(`\n=== BILAN VIEWER: ${results.length}/${results.length} tests passés ===`);
  process.exit(0);
})().catch((e) => {
  log('FATALE: ' + e.message);
  teardown();
  for (const f of TMP_GLBs) { try { rmSync(join(REPO, f), { force: true }); } catch { } }
  process.exit(2);
});
