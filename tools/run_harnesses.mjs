// Orchestrateur de tests GameLoom — mécanisme OFFICIEL (mécanisme unique de bout en bout:
// build → vite preview (4173) → Chrome headless CDP (9224) → harnesses → cleanup garanti).
// Portable Windows/macOS/Linux: les serveurs sont lancés détachés (aucun stdio hérité,
// logs → fichiers tmp, PIDs conservés) et tués par arbre/groupe sur TOUS les chemins de
// sortie (normal, FAIL, exception, timeout, SIGINT/SIGTERM). Ports 4173/9224: l'orchestrateur
// REFUSE de démarrer s'ils sont occupés — il ne tue jamais un processus qu'il n'a pas créé.
// Usage: node tools/run_harnesses.mjs [test_xxx...] [--repeat N] [--build]
//   - sans arg: les 9 harnesses officiels (v02 + jeux #1–#8)
//   - --build: npm run build + copie assets/ → dist/assets/ AVANT preview (entrée: npm test)
//   - --repeat N: chaque harness lancé N fois (déterminisme/fingerprint)
// Exit codes: 0 = tous verts · 1 = échec harness · 2 = infrastructure (serveur/timeout/ports).
import { spawn, execSync } from 'node:child_process';
import { openSync, cpSync, existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const VITE = join(REPO, 'node_modules', 'vite', 'bin', 'vite.js');
// Chrome: override CHROME_PATH, sinon défaut par plateforme.
const CHROME = process.env.CHROME_PATH ?? (
  process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : 'google-chrome-stable'
);
const PREVIEW_PORT = 4173;
const CDP_PORT = 9224;
const tmp = os.tmpdir();

const argv = process.argv.slice(2);
const buildFlag = argv.includes('--build');
const repeatIdx = argv.indexOf('--repeat');
const repeat = repeatIdx >= 0 ? Math.max(1, Number(argv[repeatIdx + 1] ?? 1)) : 1;
const names = argv.filter((a) => a.startsWith('test_'));
// SUITE OFFICIELLE (source de vérité unique — liste explicite, pas de découverte).
const OFFICIAL = ['test_v02', 'test_headless', 'test_temple', 'test_ruins', 'test_dungeon', 'test_outpost', 'test_reactor', 'test_cargo', 'test_siege'];
const harnesses = names.length ? names : OFFICIAL;
for (const h of harnesses) {
  if (!existsSync(join(REPO, 'tools', `${h}.mjs`))) { console.error(`ERREUR: harness inconnu: ${h}`); process.exit(2); }
}

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
// Kill portable d'un arbre de processus (spawn détaché → groupe/arbre propre):
// win32 = taskkill /T sur l'arbre · POSIX = SIGKILL sur le groupe de processus (-pid).
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
    creationFlags: process.platform === 'win32' ? 0x00000008 | 0x00000200 : 0, // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
  });
  let dead = false;
  p.on('error', (e) => { log(`ERREUR SPAWN ${cmdName(cmd)}: ${e.code ?? e.message}`); dead = true; });
  p.on('exit', () => { dead = true; });
  return { p, dead: () => dead, logFile: join(tmp, logName) };
}
const cmdName = (c) => String(c).split('\\').pop();

const started = [];
let tornDown = false;
function teardown() {
  if (tornDown) return;
  tornDown = true;
  for (const s of started) { if (!s.dead()) killTree(s.p.pid); }
}

const globalTimer = setTimeout(() => {
  log('TIMEOUT GLOBAL 12 min — kill forcé de tout');
  teardown();
  process.exit(2);
}, 12 * 60 * 1000);
globalTimer.unref?.();
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`${sig} reçu — teardown des serveurs de test`);
    teardown();
    process.exit(130);
  });
}

const results = [];
(async () => {
  // ---------- ports LIBRES au démarrage (refus net, jamais de kill d'écouteur inconnu) ----------
  for (const port of [PREVIEW_PORT, CDP_PORT]) {
    if (await portOpen(port)) {
      log(`FAIL: port ${port} déjà occupé — libérez-le avant de relancer (résidu vite preview / Chrome CDP d'un run de test précédent, ou lancement manuel). L'orchestrateur ne tue pas les processus qu'il n'a pas créés.`);
      process.exit(2);
    }
  }

  // ---------- start vite preview (node direct, AUCUN shell) ----------
  const pv = spawnDetached(process.execPath, [VITE, 'preview'], 'gameloom_test_pv.log');
  started.push(pv);
  const pvOk = await waitPort(PREVIEW_PORT, 20000);
  if (!pvOk) { log(`FAIL: vite preview ne répond pas sur ${PREVIEW_PORT} (log: ${pv.logFile})`); teardown(); process.exit(2); }
  log(`vite preview prêt (PID ${pv.p.pid})`);

  // ---------- start Chrome headless CDP ----------
  const ch = spawnDetached(CHROME, [
    '--headless=new', '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', `--remote-debugging-port=${CDP_PORT}`,
    '--user-data-dir=' + join(tmp, 'chrome_gl_cdp'), '--window-size=1280,720', '--mute-audio', 'about:blank',
  ], 'gameloom_test_ch.log');
  started.push(ch);
  const chOk = await waitPort(CDP_PORT, 20000);
  if (!chOk) { log(`FAIL: Chrome CDP ne répond pas sur ${CDP_PORT} (log: ${ch.logFile})`); teardown(); process.exit(2); }
  log(`chrome headless prêt (PID ${ch.p.pid})`);

  // ---------- 1 target page FRAIS par harness (isolation console) ----------
  // On crée d'abord le nouveau target (jamais 0 onglet: headless=new quitte sinon),
  // on ferme les anciens, et on VÉRIFIE qu'il reste exactement 1 page. Le harness reçoit
  // l'identité de SA target via CDP_TARGET_WS — il ne choisit jamais la 1re de la liste.
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
      if (t.type === 'page' && t.id !== created?.id) await fetch(`${base}/close/${t.id}`).catch(() => {});
    }
    // Les targets fermées disparaissent de /json avec un léger délai: on attend
    // l'invariant « exactement 1 page » (le target créé) avant de passer la main.
    let pages = [];
    for (let i = 0; i < 25; i++) {
      const after = await (await fetch(base)).json();
      pages = after.filter((t) => t.type === 'page');
      if (pages.length === 1 && pages[0].id === created.id) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (pages.length !== 1 || pages[0].id !== created.id) {
      log(`ERREUR: 1 target page attendu après freshPageTarget, ${pages.length} observé(s)`);
      return null;
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
        const child = spawn(process.execPath, [join(REPO, 'tools', `${h}.mjs`)], {
          cwd: REPO,
          stdio: 'inherit',
          env: { ...process.env, CDP_TARGET_WS: fresh.webSocketDebuggerUrl },
        });
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
  log(`PORT_4173=${pvFree ? 'LIBRE' : 'OCCUPIÉ'} PORT_9224=${chFree ? 'LIBRE' : 'OCCUPIÉ'}`);
  const failed = results.filter((r) => r.code !== 0 && r.code !== '0');
  if (failed.length > 0) { log(`BILAN ORCHESTRATEUR: ${failed.length} échec(s)`); process.exit(1); }
  if (!pvFree || !chFree) { log('FAIL: port(s) de test non libéré(s) après teardown — inspectez les processus'); process.exit(2); }
  log(`BILAN ORCHESTRATEUR: ${results.length}/${results.length} harnesses OK`);
  process.exit(0);
})().catch((e) => {
  log('FATALE: ' + e.message);
  teardown();
  process.exit(2);
});
