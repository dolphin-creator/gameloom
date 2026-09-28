// Crystal Siege (Game #8) — testeur headless via CDP (port 9224)
// 100% déterministe: le test pilote le temps de jeu via GameLoom.pause()/step(n),
// AUCUN délai réel ne pilote la logique (le sleep ne sert qu'au boot/réseau).
// Visée: GameLoom._debug.aimAt(x,y,z) — aucun calcul manuel yaw/pitch.
import WebSocket from 'ws';
import { fileURLToPath } from 'node:url';

const CDP_HTTP = 'http://localhost:9224';
const URL_TARGET = process.env.URL_TARGET ?? 'http://localhost:4173/siege.html';
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

  const bootPage = async () => {
    await cdp.send('Page.navigate', { url: URL_TARGET });
    let ready = false;
    for (let i = 0; i < 90; i++) {
      await sleep(400);
      try { ready = await cdp.eval('typeof window.GameLoom === "object"'); if (ready) break; } catch { }
    }
    if (!ready) {
      console.log('CONSOLE:', JSON.stringify(cdp.consoleLogs.slice(-15), null, 1));
      console.log('ERREURS:', JSON.stringify(cdp.errors.slice(-5), null, 1));
      throw new Error('boot: window.GameLoom non exposé');
    }
    await sleep(800); // laisser Vite servir modules + GLB (réseau seulement, pas du temps de jeu)
  };

  const GL = {
    stats: () => cdp.eval('GameLoom.stats()'),
    snap: () => cdp.eval('GameLoom.snapshot()'),
    entities: (f) => cdp.eval(`GameLoom.entities(${f ? JSON.stringify(f) : 'undefined'})`),
    inspect: (id) => cdp.eval(`GameLoom.inspect(${JSON.stringify(id)})`),
    events: (n) => cdp.eval(`GameLoom.events(${n ?? 40})`),
    doctor: () => cdp.eval('GameLoom.doctor()'),
    pause: () => cdp.eval('GameLoom.pause()'),
    step: (n) => cdp.eval(`GameLoom.step(${n})`),
    aim: (x, y, z) => cdp.eval(`GameLoom._debug.aimAt(${x}, ${y}, ${z})`),
    fire: () => cdp.eval(`GameLoom._debug.gameFire()`),
    siege: () => cdp.eval('GameLoom._debug.siegeState()'),
    teleport: (i, x, z) => cdp.eval(`GameLoom._debug.siegeTeleportEnemy(${i}, ${x}, ${z})`),
  };
  const distToCrystal = (p) => Math.hypot(p[0], p[2]);
  // viser l'ennemi à sa position courante + 0.9 (thorax) puis tirer
  const shootEnemy = async (id) => {
    const e = (await GL.entities({ tag: 'guardian' })).find((x) => x.id === id);
    if (!e) throw new Error('shootEnemy: ' + id + ' introuvable');
    await GL.aim(e.pos[0], e.pos[1] + 0.9, e.pos[2]);
    await GL.fire();
    await GL.step(2);
  };

  // ---------- boot ----------
  await bootPage();
  check('boot: window.GameLoom exposé', true);

  // ---------- PRE: pause + step déterministes ----------
  await GL.pause();
  const tA = (await GL.snap()).tick;
  await sleep(700); // temps RÉEL s'écoule: rien ne doit avancer (pause)
  const tB = (await GL.snap()).tick;
  check('PRE: tick figé pendant 700ms de temps réel (pause)', tA === tB, { tA, tB });
  await GL.step(1);
  const tC = (await GL.snap()).tick;
  await GL.step(10);
  const tD = (await GL.snap()).tick;
  check('PRE: step(1) puis step(10): +1 puis +10 ticks exacts', tC === tA + 1 && tD === tC + 10, { tA, tC, tD });

  // ---------- T1: état initial via API structurée ----------
  const st1 = await GL.siege();
  check('T1 siegeState: crystal 100, 5 ennemis, état playing',
    st1.state === 'playing' && st1.crystalHp === 100 && st1.totalSpawned === 5 && st1.remaining === 5, st1);
  const snap1 = await GL.snap();
  check('T1 snapshot: joueur en vie 100/100', snap1.player.alive === true && snap1.player.health === '100/100', snap1.player);
  const g0 = await GL.entities({ tag: 'guardian' });
  check('T1: 5 ennemis présents (filtre tag "guardian")', g0.length === 5, { n: g0.length });
  const art = await GL.entities({ tag: 'artifact' });
  check('T1: cristal présent (tag "artifact", à l\'origine)', art.length === 1 && distToCrystal(art[0].pos) < 0.5, art);
  const gi0 = await GL.inspect(g0[0].id);
  check('T1 inspect ennemi: Health.max=100 (capacité lue du GLB au spawn)', gi0.health?.max === 100 && gi0.health?.current === 100, gi0.health);

  // ---------- T2: mouvement réel d'un ennemi vers le cristal ----------
  const pBefore = g0[0].pos;
  await GL.step(60); // 1.0 s de jeu
  const pAfter = (await GL.entities({ tag: 'guardian' })).find((x) => x.id === g0[0].id).pos;
  const dBefore = distToCrystal(pBefore), dAfter = distToCrystal(pAfter);
  const moved = dBefore - dAfter;
  check('T2: ennemi se déplace vers le cristal (~1.0 m en 60 ticks, 1.0 m/s)',
    moved > 0.7 && moved < 1.3 && dAfter < dBefore, { avant: dBefore.toFixed(2), apres: dAfter.toFixed(2), moved: +moved.toFixed(2) });

  // ---------- T3: tir → event damage → vie décrémentée ----------
  const e1 = (await GL.entities({ tag: 'guardian' })).find((x) => x.id === g0[0].id);
  await GL.aim(e1.pos[0], e1.pos[1] + 0.9, e1.pos[2]);
  await GL.fire();
  await GL.step(1);
  const evT3 = await GL.events(20);
  const dmgEv = evT3.filter((e) => e.event === 'damage' && e.entity === g0[0].id);
  const inspT3 = await GL.inspect(g0[0].id);
  check('T3 tir: event "damage" 30 émis sur l\'ennemi (API events JSON)',
    dmgEv.length >= 1 && dmgEv[0].amount === 30, dmgEv.slice(0, 2));
  check('T3: vie ennemi 100→70 (Health.current décrémenté)', inspT3.health?.current === 70, inspT3.health);

  // ---------- T4: destruction d'un ennemi (3 tirs restants: 30×4=120 ≥ 100) ----------
  for (let i = 0; i < 3; i++) await shootEnemy(g0[0].id);
  const evT4 = await GL.events(60);
  const gAfterT4 = await GL.entities({ tag: 'guardian' });
  const inspT4 = await GL.inspect(g0[0].id);
  check('T4: health.zero + destroy émis sur l\'ennemi (règle déclarative guardian/health.zero)',
    evT4.some((e) => e.event === 'health.zero' && e.entity === g0[0].id)
    && evT4.some((e) => e.event === 'destroy' && e.entity === g0[0].id), inspT4.error ?? inspT4.health);
  check('T4: ennemi retiré de la scène (4 restants)', gAfterT4.length === 4 && !gAfterT4.some((x) => x.id === g0[0].id), { restants: gAfterT4.length });

  // ---------- T5: ennemi atteint la zone du cristal → dégâts au cristal + retrait ----------
  const t5id = (await GL.entities({ tag: 'guardian' }))[0].id;
  await GL.teleport(0, 2.2, 0); // hors zone (zone ±1.5), face au cristal
  await GL.step(50); // il marche vers le cristal et traverse la zone
  const st5 = await GL.siege();
  const evT5 = await GL.events(60);
  const zoneEv = evT5.filter((e) => e.event === 'zone.enter' && e.entity === t5id);
  check('T5: zone.enter émis pour la zone "crystal_zone" (core v0.2)',
    zoneEv.length === 1 && zoneEv[0].other === 'crystal_zone', zoneEv.slice(0, 2));
  check('T5: dégâts réellement appliqués au cristal (100→75)', st5.crystalHp === 75, st5);
  check('T5: l\'ennemi ayant atteint le cristal est retiré', !(await GL.entities({ tag: 'guardian' })).some((x) => x.id === t5id));

  // ---------- T6: victoire (tous les ennemis éliminés) ----------
  const restT6 = (await GL.entities({ tag: 'guardian' })).map((x) => x.id);
  for (const id of restT6) for (let i = 0; i < 4; i++) await shootEnemy(id);
  await GL.step(2);
  const st6 = await GL.siege();
  check('T6: victoire — état "victory" quand plus aucun ennemi', st6.state === 'victory' && st6.remaining === 0, st6);
  check('T6: cristal survivant au score final (75/100)', st6.crystalHp === 75, st6);

  // ---------- T7: console + doctor ----------
  const realErrors = cdp.errors.filter((e) => !/WebGL|GL |audio|Audio/i.test(e));
  check('T7 console: zéro erreur non-gérée (hors WebGL/audio headless)', realErrors.length === 0, realErrors.slice(0, 3));
  const doc = await GL.doctor();
  check('T7 doctor: exécutable, liste les assets chargés avec méta GameLoom',
    doc && doc.stats && Array.isArray(doc.assets.loaded) && doc.assets.loaded.includes('assets/guardian.glb'),
    { ok: doc?.ok, warnings: doc?.warnings, assets: doc?.assets.loaded });

  // ---------- T8: défaite (page fraîche: le cristal prend 4 × 25 → 0) ----------
  cdp.errors.length = 0;
  await bootPage();
  await GL.pause();
  const stA = await GL.siege();
  check('T8 boot frais: cristal 100, 5 ennemis, playing', stA.state === 'playing' && stA.crystalHp === 100 && stA.remaining === 5, stA);
  await GL.teleport(0, 0.9, 0.9); await GL.step(2);
  await GL.teleport(0, 0.9, -0.9); await GL.step(2);
  await GL.teleport(0, -0.9, 0.9); await GL.step(2);
  await GL.teleport(0, -0.9, -0.9); await GL.step(2);
  const stB = await GL.siege();
  check('T8: défaite — cristal à 0 (4 ennemis × 25), état "defeat"', stB.state === 'defeat' && stB.crystalHp === 0, stB);
  const zoneEvT8 = (await GL.events(80)).filter((e) => e.event === 'zone.enter' && e.other === 'crystal_zone');
  check('T8: 4 zone.enter "crystal_zone" (preuve des dégâts au cristal)', zoneEvT8.length === 4, zoneEvT8.length);

  // ---------- T9: détermination — fingerprint de ticks identique entre 2 runs ----------
  const runScenario = async () => {
    await bootPage();
    await GL.pause();
    await GL.step(60);
    const id = (await GL.entities({ tag: 'guardian' }))[0].id;
    for (let i = 0; i < 4; i++) await shootEnemy(id);
    await GL.step(60);
    return (await GL.events(300)).map((e) => [e.tick, e.event, e.entity]);
  };
  const fp1 = await runScenario();
  const fp2 = await runScenario();
  check('T9 détermination: fingerprint de ticks identique sur 2 runs complets',
    JSON.stringify(fp1) === JSON.stringify(fp2), { nEvents: fp1.length, nEvents2: fp2.length });

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
