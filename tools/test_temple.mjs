// Temple Escape — testeur headless v1 via CDP (port 9224), même pattern que test_headless.mjs
// 100% déterministe: pause()/step(n) pilotent le temps de jeu; le sleep ne sert qu'au boot/réseau.
// L'état du jeu est lu via GameLoom (JSON) + _debug.templeState() — pas de vision pour la logique.
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CDP_HTTP = 'http://localhost:9224';
const URL_TARGET = process.env.URL_TARGET ?? 'http://localhost:4173/temple.html';
const SHOT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'temple_screenshot.png');
const T0 = Date.now();
const ts = () => `+${((Date.now() - T0) / 1000).toFixed(1)}s`;

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    this.id = 0; this.pending = new Map();
    this.consoleLogs = []; this.errors = [];
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
            this.errors.push(d.exception?.description ?? d.text ?? 'exception');
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
const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${ts()} ${cond ? '✓' : '✗'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`);
}

(async () => {
  // Target: transmise par l'orchestrateur (CDP_TARGET_WS) si présente, sinon 1er target
  // page du Chrome CDP (lancement solo) — erreur explicite s'il n'y a pas de page.
  let page;
  if (process.env.CDP_TARGET_WS) page = { webSocketDebuggerUrl: process.env.CDP_TARGET_WS };
  else {
    const list = await (await fetch(CDP_HTTP + '/json')).json();
    page = list.find((t) => t.type === 'page');
  }
  if (!page) { console.error('ERREUR: aucun target page CDP (lancer via run_harnesses.mjs ou ouvrir une page dans le Chrome CDP)'); process.exit(2); }
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

  // ---------- boot ----------
  await cdp.send('Page.navigate', { url: URL_TARGET });
  let ready = false;
  for (let i = 0; i < 90; i++) {
    await sleep(400);
    try { ready = await cdp.eval('typeof window.GameLoom === "object"'); if (ready) break; } catch { }
  }
  check('boot: window.GameLoom exposé', ready);
  if (!ready) {
    console.log('CONSOLE:', JSON.stringify(cdp.consoleLogs.slice(-15), null, 1));
    console.log('ERREURS:', JSON.stringify(cdp.errors.slice(-5), null, 1));
    process.exit(1);
  }
  await sleep(800); // réseau seulement (modules + GLB), pas du temps de jeu

  const GL = {
    stats: () => cdp.eval('GameLoom.stats()'),
    snap: () => cdp.eval('GameLoom.snapshot()'),
    entities: (f) => cdp.eval(`GameLoom.entities(${f ? JSON.stringify(f) : 'undefined'})`),
    inspect: (id) => cdp.eval(`GameLoom.inspect(${JSON.stringify(id)})`),
    events: (n) => cdp.eval(`GameLoom.events(${n ?? 60})`),
    doctor: () => cdp.eval('GameLoom.doctor()'),
    pause: () => cdp.eval('GameLoom.pause()'),
    step: (n) => cdp.eval(`GameLoom.step(${n})`),
    dbg: (expr) => cdp.eval(expr),
    state: () => cdp.eval('GameLoom._debug.templeState()'),
  };

  // ---------- PRE: le jeu est en pause au boot; on pilote tout par step() ----------
  await GL.pause();
  await GL.step(30);
  const s0 = await GL.stats();
  check('PRE: step(30) → tick=30 (temps de jeu déterministe)', s0.tick === 30, s0);

  // ---------- T1: état initial via API structurée ----------
  const st0 = await GL.state();
  const sw0 = await GL.entities({ tag: 'switch' });
  const cr0 = await GL.entities({ tag: 'crate' });
  const p0 = (await GL.snap()).player;
  check('T1 état initial: 3 interrupteurs + 4 caisses, joueur au sol, puzzle à zéro, porte fermée',
    sw0.length === 3 && cr0.length === 4 && p0.grounded === true && st0.doorOpen === false && st0.won === false
    && st0.switches.A === false && st0.switches.B === false && st0.switches.C === false,
    { switch: sw0.length, crate: cr0.length, st0, player: p0 });

  // ---------- T2: pause + step déterministes ----------
  const tA = (await GL.snap()).tick;
  await sleep(700);
  const tB = (await GL.snap()).tick;
  check('T2 pause: tick figé pendant 700ms de temps réel', Number.isInteger(tA) && tA === tB, { tA, tB });
  await GL.step(1);
  const tC = (await GL.snap()).tick;
  await GL.step(10);
  const tD = (await GL.snap()).tick;
  check('T2 step(1) puis step(10): +1 puis +10 ticks exacts', tC === tA + 1 && tD === tC + 10, { tA, tC, tD });

  // ---------- T3: mouvement + collisions (traverse la cloison, bloqué par le mur ouest) ----------
  // yaw = π/2 → avant = -x (ouest). 150 ticks = 2.5 s → ~14 m: le joueur traverse l'ouverture
  // de la cloison x=-5 (z∈[-1,1], il marche sur z=0) et doit s'arrêter au mur ouest (x≈-13.45).
  await GL.dbg(`GameLoom._debug.setLook(1.5708, 0)`);
  await GL.dbg(`GameLoom._debug.input({ move: [1, 0] })`);
  await GL.step(150);
  await GL.dbg(`GameLoom._debug.input({ move: [0, 0] })`);
  const p3 = (await GL.snap()).player;
  check('T3 mouvement W vers l\'ouest: traverse la cloison (x<-5) et le mur ouest l\'arrête (-13.8<x<-12)',
    p3.pos[0] < -12 && p3.pos[0] > -13.8 && p3.grounded === true, p3);

  // ---------- T4: interrupteur A (bon ordre) ----------
  await GL.dbg(`GameLoom._debug.teleportPlayer(0, 0.92, -2.5)`);
  await GL.step(5);
  await GL.dbg(`GameLoom._debug.gameInteract()`);
  await GL.step(5);
  const st4 = await GL.state();
  const ev4 = await GL.events(60);
  check('T4 switch A activé: event switch.activated + état A=true + score +25',
    st4.switches.A === true && st4.switches.B === false && st4.switches.C === false
    && ev4.some((e) => e.event === 'switch.activated') && (await GL.snap()).player.score >= 25,
    { st4, ev: ev4.filter((e) => e.event === 'switch.activated') });

  // ---------- T5: mauvais ordre (C alors que B est attendu) → reset ----------
  await GL.dbg(`GameLoom._debug.teleportPlayer(9, 0.92, -2.5)`);
  await GL.step(5);
  await GL.dbg(`GameLoom._debug.gameInteract()`);
  await GL.step(5);
  const st5 = await GL.state();
  const ev5 = await GL.events(60);
  check('T5 mauvais ordre (C avant B): puzzle.reset émis, tous les interrupteurs repassent à false',
    st5.switches.A === false && st5.switches.B === false && st5.switches.C === false
    && ev5.some((e) => e.event === 'puzzle.reset'),
    { st5, ev: ev5.filter((e) => e.event === 'puzzle.reset') });

  // ---------- T6: séquence complète A → B → C ----------
  const seq = async (slot, x, z) => {
    await GL.dbg(`GameLoom._debug.teleportPlayer(${x}, 0.92, ${z})`);
    await GL.step(5);
    await GL.dbg(`GameLoom._debug.gameInteract()`);
    await GL.step(5);
  };
  await seq('A', 0, -2.5);
  await seq('B', -9, 2.5);
  await seq('C', 9, -2.5);
  const st6 = await GL.state();
  const ev6 = await GL.events(120);
  check('T6 séquence A→B→C: puzzle.completed émis, porte ouverte, score ≥ 75',
    st6.switches.A === true && st6.switches.B === true && st6.switches.C === true
    && st6.doorOpen === true
    && ev6.some((e) => e.event === 'puzzle.completed') && (await GL.snap()).player.score >= 75,
    { st6, ev: ev6.filter((e) => e.event === 'puzzle.completed') });

  // ---------- T7: porte ouverte → le joueur franchit la sortie ----------
  await GL.dbg(`GameLoom._debug.teleportPlayer(13, 0.92, 0)`);
  await GL.step(5);
  await GL.dbg(`GameLoom._debug.setLook(-1.5708, 0)`);
  await GL.dbg(`GameLoom._debug.input({ move: [1, 0] })`);
  await GL.step(45);
  await GL.dbg(`GameLoom._debug.input({ move: [0, 0] })`);
  const st7 = await GL.state();
  const p7 = (await GL.snap()).player;
  const ev7 = await GL.events(120);
  const winVisible = await cdp.eval(`document.getElementById('win').style.display === 'flex'`);
  check('T7 sortie: player.exited émis, won=true, x>14.55, overlay de victoire affiché',
    st7.won === true && p7.pos[0] > 14.55 && Math.abs(p7.pos[2]) < 1.4
    && ev7.some((e) => e.event === 'player.exited') && winVisible,
    { st7, x: p7.pos[0], winVisible, ev: ev7.filter((e) => e.event === 'player.exited') });

  // ---------- T8: après la victoire, les interactions sont inertes ----------
  await GL.dbg(`GameLoom._debug.teleportPlayer(0, 0.92, -2.5)`);
  await GL.step(5);
  await GL.dbg(`GameLoom._debug.gameInteract()`);
  await GL.step(5);
  const st8 = await GL.state();
  check('T8 après victoire: interact() inerte (état inchangé)',
    st8.doorOpen === true && st8.won === true, st8);

  // ---------- T9: doctor ----------
  const doc = await GL.doctor();
  check('T9 doctor: exécutable, switch.glb chargé avec méta GameLoom',
    doc && doc.stats && Array.isArray(doc.assets.loaded) && doc.assets.loaded.includes('assets/switch.glb')
    && !doc.assets.without_gameloom_meta.includes('assets/switch.glb'),
    { ok: doc?.ok, warnings: doc?.warnings, assets: doc?.assets.loaded });

  // ---------- T10: console ----------
  const realErrors = cdp.errors.filter((e) => !/WebGL|GL |audio|Audio/i.test(e));
  check('T10 console: zéro erreur non-gérée (hors WebGL/audio headless)', realErrors.length === 0, realErrors.slice(0, 3));

  // ---------- T11: screenshot UNIQUE — validation visuelle ----------
  await GL.dbg(`GameLoom._debug.teleportPlayer(12, 0.92, 0)`);
  await GL.dbg(`GameLoom._debug.setLook(-1.5708, 0)`);
  await GL.step(1);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(SHOT_PATH, Buffer.from(shot.data, 'base64'));
  check('T11 screenshot final capturé (seule validation visuelle)', true, 'tools/temple_screenshot.png');

  // ---------- bilan ----------
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n=== BILAN: ${pass}/${results.length} tests passés ===`);
  console.log('état final:', JSON.stringify(await GL.stats()));
  console.log('état temple:', JSON.stringify(st8));
  console.log('events récents:', JSON.stringify(await GL.events(10)));
  cdp.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error('FATALE:', e.message);
  process.exit(2);
});
