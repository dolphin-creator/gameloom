// Orchestrateur de tests GameLoom — mécanisme OFFICIEL (mécanisme unique de bout en bout:
// build → vite preview (4173) → Chrome headless CDP (9224) → harnesses → cleanup garanti).
// Windows-safe (bug OpenCode #32504: aucun processus persistant ne doit survivre au tool
// call): ce script possède le cycle de vie COMPLET — pré-nettoyage ports → start
// détaché (DETACHED|NEW_GROUP, logs tmp) → wait ready → run des harnesses (test_*.mjs)
// → kill par arbre → vérification ports libres → exit.
// Usage: node tools/run_harnesses.mjs [test_xxx...] [--repeat N] [--build]
//   - sans arg: les 6 harnesses (v02, headless, temple, ruins, dungeon, outpost)
//   - --build: npm run build + copie assets/ → dist/assets/ AVANT preview (entrée: npm test)
//   - --repeat N: chaque harness lancé N fois (déterminisme/fingerprint)
// Exit codes: 0 = tous verts · 1 = échec harness · 2 = infrastructure (serveur/timeout).
import { spawn, execSync } from 'node:child_process';
import { openSync, cpSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const VITE = join(REPO, 'node_modules', 'vite', 'bin', 'vite.js');
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PREVIEW_PORT = 4173;
const CDP_PORT = 9224;
const DETACHED = 0x00000008;
const NEW_GROUP = 0x00000200;
const tmp = os.tmpdir();

const argv = process.argv.slice(2);
const buildFlag = argv.includes('--build');
const repeatIdx = argv.indexOf('--repeat');
const repeat = repeatIdx >= 0 ? Math.max(1, Number(argv[repeatIdx + 1] ?? 1)) : 1;
const names = argv.filter((a) => a.startsWith('test_'));
const harnesses = names.length ? names : ['test_v02', 'test_headless', 'test_temple', 'test_ruins', 'test_dungeon', 'test_outpost'];

const T0 = Date.now();
const ts = () => `+${((Date.now() - T0) / 1000).toFixed(1)}s`;
const log = (m) => console.log(`${ts()} ${m}`);

if (buildFlag) {
  log('build: npm run build (tsc + vite)');
  execSync('npm run build', { cwd: REPO, stdio: 'inherit' });
  log('build: copie assets/ → dist/assets/ (vite ne copie pas assets/)');
  cpSync(join(REPO, 'assets'), join(REPO, 'dist', 'assets'), { recursive: true });
}

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
// PIDs écouteurs d'un port via netstat (pré-nettoyage des résidus de sessions précédentes)
function listenersOn(port) {
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8' });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^(\S+)\s+(\d+\.\d+\.\d+\.\d+):(\d+)\s+(\S+)\s+(LISTENING)\s+(\d+)$/);
      if (m && Number(m[3]) === port) pids.add(m[6]);
    }
    return [...pids];
  } catch { return []; }
}
function killPids(pids) {
  for (const pid of pids) {
    try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' }); } catch { }
  }
}
function spawnDetached(cmd, cmdArgs, logName) {
  const out = openSync(join(tmp, logName), 'w');
  const p = spawn(cmd, cmdArgs, {
    cwd: REPO,
    stdio: ['ignore', out, out],
    detached: true,
    windowsHide: true,
    creationFlags: process.platform === 'win32' ? DETACHED | NEW_GROUP : 0,
  });
  let dead = false;
  p.on('error', (e) => { log(`ERREUR SPAWN ${cmdName(cmd)}: ${e.code ?? e.message}`); dead = true; });
  p.on('exit', () => { dead = true; });
  return { p, dead: () => dead, logFile: join(tmp, logName) };
}
const cmdName = (c) => String(c).split('\\').pop();

const started = [];
const globalTimer = setTimeout(() => {
  log('TIMEOUT GLOBAL 12 min — kill forcé de tout');
  teardown();
  process.exit(2);
}, 12 * 60 * 1000);
globalTimer.unref?.();

function teardown() {
  for (const s of started) {
    try { if (!s.dead()) execSync(`taskkill /F /T /PID ${s.p.pid}`, { stdio: 'ignore' }); } catch { }
  }
}

const results = [];
(async () => {
  // ---------- pré-nettoyage (résidus éventuels) ----------
  for (const port of [PREVIEW_PORT, CDP_PORT]) {
    const pids = listenersOn(port);
    if (pids.length) { log(`pré-nettoyage port ${port}: kill ${pids.join(', ')}`); killPids(pids); await new Promise((r) => setTimeout(r, 1500)); }
  }

  // ---------- start vite preview (node direct, AUCUN shell) ----------
  const pv = spawnDetached(process.execPath, [VITE, 'preview'], 'opencode_pv.log');
  started.push(pv);
  const pvOk = await waitPort(PREVIEW_PORT, 20000);
  if (!pvOk) { log(`FAIL: vite preview ne répond pas sur ${PREVIEW_PORT} (log: ${pv.logFile})`); teardown(); process.exit(2); }
  log(`vite preview prêt (PID ${pv.p.pid})`);

  // ---------- start Chrome headless CDP ----------
  const ch = spawnDetached(CHROME, [
    '--headless=new', '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', `--remote-debugging-port=${CDP_PORT}`,
    '--user-data-dir=' + join(tmp, 'chrome_gl_cdp'), '--window-size=1280,720', '--mute-audio', 'about:blank',
  ], 'opencode_ch.log');
  started.push(ch);
  const chOk = await waitPort(CDP_PORT, 20000);
  if (!chOk) { log(`FAIL: Chrome CDP ne répond pas sur ${CDP_PORT} (log: ${ch.logFile})`); teardown(); process.exit(2); }
  log(`chrome headless prêt (PID ${ch.p.pid})`);

  // ---------- 1 target page FRAIS par harness (isolation console) ----------
  // Chaque harness choisit le 1er target 'page' de ce Chrome. Réutiliser la
  // page du harness précédent ferait fuiter ses console.error dans la vérif
  // console du suivant (ex: refus moveEntity volontaires de test_v02 → T8 headless).
  // On crée d'abord le nouveau target (jamais 0 onglet: headless=new quitte
  // sinon), puis on ferme les anciens.
  async function freshPageTarget() {
    const base = `http://127.0.0.1:${CDP_PORT}/json`;
    let created = null;
    try {
      let r = await fetch(`${base}/new?about:blank`, { method: 'PUT' });
      if (!r.ok) r = await fetch(`${base}/new?about:blank`);
      created = await r.json();
    } catch (e) { log(`ERREUR: création du target page: ${e.message}`); return null; }
    const list = await (await fetch(base)).json();
    for (const t of list) {
      if (t.type === 'page' && t.id !== created?.id) {
        await fetch(`${base}/close/${t.id}`).catch(() => {});
      }
    }
    return created;
  }

  // ---------- run des harnesses ----------
  for (const h of harnesses) {
    for (let r = 1; r <= repeat; r++) {
      const label = repeat > 1 ? `${h} [run ${r}/${repeat}]` : h;
      const fresh = await freshPageTarget();
      if (!fresh) { teardown(); process.exit(2); }
      log(`--- ${label} ---`);
      const code = await new Promise((res) => {
        const t = setTimeout(() => { try { child.kill(); } catch { } res('TIMEOUT'); }, 150000);
        const child = spawn(process.execPath, [join(REPO, 'tools', `${h}.mjs`)], { cwd: REPO, stdio: 'inherit' });
        child.on('exit', (c) => { clearTimeout(t); res(c); });
        child.on('error', (e) => { clearTimeout(t); res('SPAWN_ERR:' + e.message); });
      });
      results.push({ h, r, code });
      log(`--- ${label}: code=${code} ---`);
      if (code !== 0 && code !== '0') { log(`FAIL: ${h} code=${code} — arrêt, teardown`); teardown(); process.exit(1); }
    }
  }

  // ---------- teardown + vérification ----------
  teardown();
  const pvFree = await waitPortClosed(PREVIEW_PORT, 8000);
  const chFree = await waitPortClosed(CDP_PORT, 8000);
  for (const port of [PREVIEW_PORT, CDP_PORT]) {
    const leftover = listenersOn(port);
    if (leftover.length) killPids(leftover);
  }
  log(`PORT_4173=${pvFree ? 'LIBRE' : 'OCCUPIÉ'} PORT_9224=${chFree ? 'LIBRE' : 'OCCUPIÉ'}`);
  const failed = results.filter((r) => r.code !== 0 && r.code !== '0');
  log(failed.length === 0 ? `BILAN ORCHESTRATEUR: ${results.length}/${results.length} harnesses OK` : `BILAN ORCHESTRATEUR: ${failed.length} échec(s)`);
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => {
  log('FATALE: ' + e.message);
  teardown();
  process.exit(2);
});
