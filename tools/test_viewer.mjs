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

const TMP_GLBs = ['dist/assets/_viewer_tmp_sphere.glb', 'dist/assets/_viewer_tmp_capsule.glb'];

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
    '--user-data-dir=' + join(tmp, 'chrome_gl_viewer_cdp'), '--window-size=1280,720', '--mute-audio', 'about:blank',
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
  const noErrorSegment = (label) => {
    check(`${label}: sans exception JS`, cdp.exceptions.length === 0, cdp.exceptions.slice(0, 2));
    const real = cdp.errors.filter((e) => !/WebGL|GL |audio|Audio/i.test(e));
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
