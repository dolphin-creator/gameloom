// Barrel Blaster — testeur headless v2 via CDP (port 9224)
// 100% déterministe: le test pilote le temps de jeu via GameLoom.pause()/step(n),
// AUCUN délai réel ne pilote la logique (le sleep ne sert qu'au boot/réseau).
// Visée: GameLoom._debug.aimAt(x,y,z) — aucun calcul manuel yaw/pitch.
// Screenshot: UNIQUEMENT en validation visuelle finale.
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';

const CDP_HTTP = 'http://localhost:9224';
const URL_TARGET = process.env.URL_TARGET ?? 'http://localhost:4173/';
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
  const list = await (await fetch(CDP_HTTP + '/json')).json();
  const page = list.find((t) => t.type === 'page') ?? list[0];
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }); // pas de cache: les 404 HTML ne doivent pas polluer

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
  await sleep(800); // laisser Vite servir modules + GLB (réseau seulement, pas du temps de jeu)

  const GL = {
    stats: () => cdp.eval('GameLoom.stats()'),
    eye: () => cdp.eval('(() => { const p = GameLoom.snapshot().player.pos; return [p[0], p[1] + 1.55, p[2]]; })()'),
    probe: async (x, y, z) => {
      await cdp.eval(`GameLoom._debug.aimAt(${x}, ${y}, ${z})`);
      const eye = await cdp.eval('(() => { const p = GameLoom.snapshot().player.pos; return [p[0], p[1] + 1.55, p[2]]; })()');
      return cdp.eval(`GameLoom._debug.fire(${JSON.stringify(eye)})`);
    },
    snap: () => cdp.eval('GameLoom.snapshot()'),
    entities: (f) => cdp.eval(`GameLoom.entities(${f ? JSON.stringify(f) : 'undefined'})`),
    inspect: (id) => cdp.eval(`GameLoom.inspect(${JSON.stringify(id)})`),
    events: (n) => cdp.eval(`GameLoom.events(${n ?? 40})`),
    doctor: () => cdp.eval('GameLoom.doctor()'),
    pause: () => cdp.eval('GameLoom.pause()'),
    step: (n) => cdp.eval(`GameLoom.step(${n})`),
    dbg: (expr) => cdp.eval(expr),
  };

  // ---------- PRE: le jeu est en pause au boot; on pilote tout par step() ----------
  await GL.pause();
  await GL.step(90); // ~1.5 s de jeu: le joueur tombe et atterrit
  const s0 = await GL.stats();
  check('PRE: step(90) → tick=90 (temps de jeu déterministe)', s0.tick === 90, s0);

  // ---------- T1: état initial via API structurée ----------
  const snap0 = await GL.snap();
  check('T1 snapshot: joueur en vie 100/100, au sol', snap0.player.alive === true && snap0.player.health === '100/100' && snap0.player.grounded === true, snap0.player);
  const bars0 = await GL.entities({ tag: 'barrel' });
  const tars0 = await GL.entities({ tag: 'target' });
  check('T1 vague 1: 5 barils + 4 cibles (filtre par tag via API)', bars0.length === 5 && tars0.length === 4, { barils: bars0.length, cibles: tars0.length });
  const bar0i = await GL.inspect(bars0[0].id);
  check('T1 inspect baril: Health.max=50 + Explosive 8/120/20 (capacités lues du GLB au spawn)',
    bar0i.health?.max === 50 && bar0i.explosive?.radius === 8 && bar0i.explosive?.damage === 120 && bar0i.explosive?.impulse === 20, bar0i);

  // ---------- T2: pause + step déterministes ----------
  const tA = (await GL.snap()).tick;
  await sleep(700); // temps RÉEL s'écoule: rien ne doit avancer (pause)
  const tB = (await GL.snap()).tick;
  check('T2 pause: tick figé pendant 700ms de temps réel', tA === tB, { tA, tB });
  await GL.step(1);
  const tC = (await GL.snap()).tick;
  await GL.step(10);
  const tD = (await GL.snap()).tick;
  check('T2 step(1) puis step(10): +1 puis +10 ticks exacts', tC === tA + 1 && tD === tC + 10, { tA, tC, tD });

  // ---------- T3: mouvement FPS (KCC Rapier) ----------
  const pB = (await GL.snap()).player.pos;
  await GL.dbg(`GameLoom._debug.input({ move: [1, 0] })`); // W
  await GL.step(30); // 0.5 s de jeu
  await GL.dbg(`GameLoom._debug.input({ move: [0, 0] })`);
  const pA = (await GL.snap()).player;
  const moved = Math.hypot(pA.pos[0] - pB[0], pA.pos[2] - pB[2]);
  check('T3 mouvement W: avance ~2.8 m en 0.5 s de jeu (5.6 m/s)', moved > 1.5 && moved < 5, { avant: pB, apres: pA.pos, moved: +moved.toFixed(2) });
  check('T3 KCC: joueur au sol (grounded=true, y≈0.9)', pA.grounded === true && Math.abs(pA.pos[1] - 0.9) < 0.2, pA);
  // saut
  const pJ0 = (await GL.snap()).player.pos[1];
  await GL.dbg(`GameLoom._debug.input({ jump: true })`);
  await GL.step(10);
  const pJ1 = (await GL.snap()).player.pos[1];
  await GL.dbg(`GameLoom._debug.input({ jump: false })`);
  await GL.step(45);
  const pJ2 = (await GL.snap()).player.pos[1];
  check('T3 saut: y augmente puis retour au sol', pJ1 > pJ0 + 0.1 && Math.abs(pJ2 - 0.9) < 0.2, { depart: pJ0, apogee: pJ1, retour: pJ2 });

  // ---------- T4: tir hitscan → damage → health.zero → destruction (cible) ----------
  // Les spawns sont aléatoires: on choisit une cible VISIBLE (sonde _debug.fire = raycast sans dégâts)
  const tars = await GL.entities({ tag: 'target' });
  let t = null;
  for (const cand of tars) {
    const probe = await GL.probe(cand.pos[0], cand.pos[1] + 0.5, cand.pos[2]);
    if (probe && probe.id === cand.id) { t = cand; break; }
  }
  if (!t) throw new Error('T4: aucune cible visible (occlusion)');
  await GL.dbg(`GameLoom._debug.gameFire()`);
  await GL.step(6);
  const evT4 = await GL.events(10);
  const dmgEv = evT4.filter((e) => e.event === 'damage' && e.entity === t.id);
  const ti2 = await GL.inspect(t.id);
  check('T4 tir: event "damage" 30 émis sur la cible (API events JSON)', dmgEv.length >= 1 && dmgEv[0].amount === 30, dmgEv.slice(0, 2));
  check('T4 health.zero émis + cible détruite (règle déclarative target/health.zero)',
    evT4.some((e) => e.event === 'health.zero' && e.entity === t.id) && 'error' in ti2, { health: ti2.health, err: ti2.error });
  check('T4 score +100 (action addScore)', (await GL.snap()).player.score >= 100, (await GL.snap()).player);

  // ---------- T5: baril — 3 tirs (30 dmg × 3 = 90 > 50) → health.zero → explosion ----------
  // Scène 100% déterministe (comme T6): on vide, on téléporte le joueur, on spawn
  // UN SEUL baril ISOLÉ (pas de voisins → pas d'explosion en chaîne → le joueur survit).
  // Le baril de vague 1 aléatoire (et sa chaîne) contaminait l'état du joueur.
  await GL.dbg(`GameLoom._debug.clearTag('barrel')`);
  await GL.dbg(`GameLoom._debug.clearTag('target')`);
  await GL.dbg(`GameLoom._debug.teleportPlayer(8, 0.92, 8)`);
  await GL.step(3);
  const T5B = await GL.dbg(`GameLoom._debug.spawn('assets/barrel.glb', 8, 0, -2)`); // 10 m, isolé
  await GL.step(3);
  const t5p = (await GL.inspect(T5B)).position;
  await GL.dbg(`GameLoom._debug.aimAt(${t5p[0]}, ${t5p[1] + 0.45}, ${t5p[2]})`);
  const b = { id: T5B };
  for (let i = 0; i < 3; i++) { await GL.dbg(`GameLoom._debug.gameFire()`); await GL.step(12); }
  const bi2 = await GL.inspect(b.id);
  const evT5 = await GL.events(400);
  check('T5 baril: health.zero + destroy émis après 3 tirs (règle déclarative barrel/health.zero)',
    evT5.some((e) => e.event === 'health.zero' && e.entity === b.id) && evT5.some((e) => e.event === 'destroy' && e.entity === b.id),
    { health: bi2.health, err: bi2.error, explosive: bi2.explosive });

  // ---------- T6: réaction en chaîne (dégâts radiaux + impulsion Rapier) ----------
  // Scène 100% déterministe: joueur téléporté à une position fixe, scène vidée,
  // A et C à des positions fixes NON OCCLUES (filet x=8, loin des 4 crates) et
  // A à 10 m du joueur (HORS rayon d'explosion 8 m → le joueur survit).
  // La balle ne touche QUE A (raycast = hit le plus proche). C meurt par les
  // dégâts RADIAUX de l'explosion d'A (C est à 2.5 m d'A, < 8 m) — pas par la balle.
  await GL.dbg(`GameLoom._debug.clearTag('barrel')`);
  await GL.dbg(`GameLoom._debug.clearTag('target')`);
  await GL.dbg(`GameLoom._debug.teleportPlayer(8, 0.92, 8)`);
  await GL.step(3);
  const AX = 8, AZ = -2;      // baril A: 10 m devant le joueur (filet x=8)
  const CX = 8, CZ = -4.5;    // baril C: 2.5 m derrière A, colinéaire, < 8 m d'A
  const chainA = await GL.dbg(`GameLoom._debug.spawn('assets/barrel.glb', ${AX}, 0, ${AZ})`);
  const chainC = await GL.dbg(`GameLoom._debug.spawn('assets/barrel.glb', ${CX}, 0, ${CZ})`);
  await GL.step(3);
  const aP = (await GL.inspect(chainA)).position;
  await GL.dbg(`GameLoom._debug.aimAt(${aP[0]}, ${aP[1] + 0.45}, ${aP[2]})`);
  // 2 tirs suffisent (30×2=60 > 50): A explose au 2e tir, sa radial kill C.
  for (let i = 0; i < 3; i++) { await GL.dbg(`GameLoom._debug.gameFire()`); await GL.step(12); }
  await GL.step(12);
  const ai = await GL.inspect(chainA);
  const ci = await GL.inspect(chainC);
  const evT6 = await GL.events(400);
  const aZeroEv = evT6.find((e) => e.event === 'health.zero' && e.entity === chainA);
  const cZeroEv = evT6.find((e) => e.event === 'health.zero' && e.entity === chainC);
  const aZero = !!aZeroEv;
  const cZero = !!cZeroEv;
  // preuve stricte de chaîne: la health.zero de C arrive sur le MÊME tick que celle de A
  // (dégâts radiaux synchrones de l'explosion — pas un tir direct qui l'aurait touché plus tard)
  const chainSimultaneous = aZero && cZero && aZeroEv?.tick === cZeroEv?.tick;
  check('T6 chaîne: baril A détruit par balles directes', aZero && 'error' in ai, { a: ai.error ?? ai.health });
  check('T6 chaîne: baril C détruit par DEGÂTS RADIAUX (health.zero simultané, même tick que A)',
    chainSimultaneous && 'error' in ci, { a_tick: aZeroEv?.tick, c_tick: cZeroEv?.tick, c: ci.error ?? ci.health });

  // ---------- T7: doctor ----------
  const doc = await GL.doctor();
  check('T7 doctor: exécutable, liste les assets chargés avec méta GameLoom',
    doc && doc.stats && Array.isArray(doc.assets.loaded) && doc.assets.loaded.includes('assets/barrel.glb'),
    { ok: doc?.ok, warnings: doc?.warnings, assets: doc?.assets.loaded });

  // ---------- T8: console ----------
  const realErrors = cdp.errors.filter((e) => !/WebGL|GL |audio|Audio/i.test(e));
  check('T8 console: zéro erreur non-gérée (hors WebGL/audio headless)', realErrors.length === 0, realErrors.slice(0, 3));

  // ---------- T9: screenshot UNIQUE — validation visuelle ----------
  await GL.dbg(`GameLoom._debug.aimAt(0, 1, 0)`);
  await GL.step(1);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('/home/jbo/gameloom/tools/final_screenshot.png', Buffer.from(shot.data, 'base64'));
  check('T9 screenshot final capturé (seule validation visuelle)', true, 'tools/final_screenshot.png');

  // ---------- bilan ----------
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n=== BILAN: ${pass}/${results.length} tests passés ===`);
  console.log('état final:', JSON.stringify(await GL.stats()));
  console.log('events récents:', JSON.stringify(await GL.events(10)));
  cdp.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error('FATALE:', e.message);
  process.exit(2);
});
