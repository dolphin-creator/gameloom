// Dungeon Assault — testeur headless v1 via CDP (port 9224), même pattern que test_headless.mjs / test_temple.mjs / test_ruins.mjs
// 100% déterministe: pause()/step(n) pilotent le temps de jeu; le sleep ne sert qu'au boot/réseau.
// L'état du jeu est lu via GameLoom (JSON) + _debug.dungeonState() — pas de vision pour la logique.
// FINGERPRINT: valeurs exactes des ticks clés, à comparer entre runs (déterminisme).
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CDP_HTTP = 'http://localhost:9224';
const URL_TARGET = process.env.URL_TARGET ?? 'http://localhost:4173/dungeon.html';
const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HARNESS_DIR, '..');
const SHOT_PATH = join(HARNESS_DIR, 'dungeon_screenshot.png');
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
async function waitReady(cdp) {
  let ready = false;
  for (let i = 0; i < 90; i++) {
    await sleep(400);
    try { ready = await cdp.eval('typeof window.GameLoom === "object"'); if (ready) break; } catch { }
  }
  return ready;
}
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

(async () => {
  const list = await (await fetch(CDP_HTTP + '/json')).json();
  const page = list.find((t) => t.type === 'page') ?? list[0];
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

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
    state: () => cdp.eval('GameLoom._debug.dungeonState()'),
  };
  const hp = (p) => Number(String(p.health).split('/')[0]);   // p = snapshot().player
  const firstTick = (evs, name, ent) => evs.filter((e) => e.event === name && (ent === undefined || e.entity === ent))[0]?.tick ?? null;

  // ---------- boot ----------
  await cdp.send('Page.navigate', { url: URL_TARGET });
  let ready = await waitReady(cdp);
  check('T1 boot: window.GameLoom exposé (page 1)', ready);
  if (!ready) {
    console.log('CONSOLE:', JSON.stringify(cdp.consoleLogs.slice(-15), null, 1));
    console.log('ERREURS:', JSON.stringify(cdp.errors.slice(-5), null, 1));
    process.exit(1);
  }
  await sleep(800); // réseau seulement (modules + GLB), pas du temps de jeu

  // ---------- PRE: le jeu est en pause au boot; on pilote tout par step() ----------
  await GL.pause();
  await GL.step(30);
  const s0 = await GL.stats();
  check('PRE: step(30) → tick=30 (temps de jeu déterministe)', s0.tick === 30, s0);

  // ---------- T2: entités essentielles présentes ----------
  const nEnemy = await GL.entities({ tag: 'enemy' });
  const nA = await GL.entities({ tag: 'enemy_a' });
  const nB = await GL.entities({ tag: 'enemy_b' });
  const nC = await GL.entities({ tag: 'enemy_c' });
  const nKey = await GL.entities({ tag: 'dungeon_key' });
  const nSpikes = await GL.entities({ tag: 'dungeon_spikes' });
  const nCol = await GL.entities({ tag: 'ruins_column' });
  const nCrate = await GL.entities({ tag: 'crate' });
  const s1 = await GL.stats();
  const idA = nA[0]?.id, idB = nB[0]?.id, idC = nC[0]?.id;
  check('T2 entités: joueur + 3 ennemis (A/B/C) + clé + pointes + 2 colonnes + 2 caisses (10)',
    idA && idB && idC && nEnemy.length === 3 && nKey.length === 1 && nSpikes.length === 1 && nCol.length === 2 && nCrate.length === 2 && s1.entities === 10,
    { a: idA, b: idB, c: idC, enemy: nEnemy.length, key: nKey.length, spikes: nSpikes.length, column: nCol.length, crate: nCrate.length, entities: s1.entities });

  // ---------- T3: pause + step déterministes ----------
  const tA = (await GL.snap()).tick;
  await sleep(700);
  const tB = (await GL.snap()).tick;
  check('T3a pause: tick figé pendant 700ms de temps réel', tA === tB, { tA, tB });
  await GL.step(1);
  const tC = (await GL.snap()).tick;
  await GL.step(10);
  const tD = (await GL.snap()).tick;
  check('T3b step(1) puis step(10): +1 puis +10 ticks exacts', tC === tA + 1 && tD === tC + 10, { tA, tC, tD });

  // ---------- T4: déplacement joueur (salle de départ, +X) ----------
  await GL.dbg(`GameLoom._debug.teleportPlayer(-6, 0.92, 0)`);
  await GL.step(5);
  await GL.dbg(`GameLoom._debug.setLook(-1.5708, 0)`);   // avant = +X
  await GL.dbg(`GameLoom._debug.input({ move: [1, 0] })`);
  await GL.step(30);                                      // 0.5 s = 2.8 m tentés
  await GL.dbg(`GameLoom._debug.input({ move: [0, 0] })`);
  const p4 = (await GL.snap()).player;
  check('T4 déplacement: joueur avance de ~2.8 m vers +X (au sol)',
    p4.pos[0] > -4.0 && p4.pos[0] < -2.5 && Math.abs(p4.pos[2]) < 0.5 && p4.grounded === true,
    { x: +p4.pos[0].toFixed(3), z: +p4.pos[2].toFixed(3), grounded: p4.grounded });
  const fpPlayerT4 = p4.pos;

  // ---------- T5: ennemi A en patrouille (déplacement réel + état) ----------
  const aA = (await GL.inspect(idA)).position;
  await GL.step(60);
  const aB = (await GL.inspect(idA)).position;
  await GL.step(60);
  const aC = (await GL.inspect(idA)).position;
  const st5 = await GL.state();
  const eA = st5.enemies.find((e) => e.kind === 'A');
  check('T5a patrouille A: ~2 m/s sur 2 fenêtres de 60 ticks',
    dist2(aA, aB) >= 1.15 && dist2(aA, aB) <= 2.35 && dist2(aB, aC) >= 1.15 && dist2(aB, aC) <= 2.35,
    { d1: +dist2(aA, aB).toFixed(3), d2: +dist2(aB, aC).toFixed(3) });
  check('T5b état A: PATROL + waypoint observable via JSON',
    eA.state === 'PATROL' && Number.isInteger(eA.waypoint), eA);

  // ---------- T6: ennemi B dormant tant que le joueur est hors du hall ----------
  const st6 = await GL.state();
  const ev6 = await GL.events(200);
  check('T6 brute B inactive hors du hall: state IDLE, aucun event enemy.activated',
    st6.enemies.find((e) => e.kind === 'B').state === 'IDLE' && !ev6.some((e) => e.event === 'enemy.activated'),
    { st: st6.enemies.find((e) => e.kind === 'B').state });

  // ---------- T7: ennemi A PATROL → ALERT ----------
  await GL.dbg(`GameLoom._debug.setPlayerHealth(100)`);
  await GL.dbg(`GameLoom._debug.teleportPlayer(1.5, 0.92, 0)`);
  await GL.step(15);
  const st7 = await GL.state();
  const ev7 = await GL.events(200);
  const alertTick = firstTick(ev7, 'enemy.alert', idA);
  check('T7 détection A: état ALERT + event enemy.alert',
    st7.enemies.find((e) => e.kind === 'A').state === 'ALERT' && alertTick !== null,
    { st: st7.enemies.find((e) => e.kind === 'A').state, alertTick });

  // ---------- T8: ennemi A ALERT → ATTACK (poursuite + contact) ----------
  await GL.step(120);
  const st8 = await GL.state();
  const ev8 = await GL.events(200);
  const attackTick = firstTick(ev8, 'enemy.attack', idA);
  check('T8 attaque A: état ATTACK + event enemy.attack',
    st8.enemies.find((e) => e.kind === 'A').state === 'ATTACK' && attackTick !== null,
    { st: st8.enemies.find((e) => e.kind === 'A').state, attackTick });

  // ---------- T9: ennemi B activé par la zone (joueur dans le hall) ----------
  await GL.dbg(`GameLoom._debug.teleportPlayer(9.5, 0.92, 0)`);
  await GL.step(15);
  const st9 = await GL.state();
  const ev9 = await GL.events(200);
  const activatedTick = firstTick(ev9, 'enemy.activated', idB);
  check('T9 activation B: zone hall → state CHASE + event enemy.activated',
    st9.enemies.find((e) => e.kind === 'B').state === 'CHASE' && activatedTick !== null,
    { st: st9.enemies.find((e) => e.kind === 'B').state, activatedTick });

  // ---------- T10: ennemi B poursuit le joueur ----------
  const b0 = st9.enemies.find((e) => e.kind === 'B').pos;
  await GL.step(30);
  const st10 = await GL.state();
  const p10 = (await GL.snap()).player;
  const b1 = st10.enemies.find((e) => e.kind === 'B').pos;
  const gain = dist2(b0, p10.pos) - dist2(b1, p10.pos);
  check('T10 poursuite B: la brute raccourcit la distance au joueur (≥1.2 m / 30 ticks)',
    gain >= 1.2, { gain: +gain.toFixed(3), b0, b1 });

  // ---------- T11: ennemi C détecte le joueur (salle de la clé) ----------
  await GL.dbg(`GameLoom._debug.teleportPlayer(14, 0.92, 7.5)`);
  await GL.step(15);
  const st11 = await GL.state();
  const ev11 = await GL.events(200);
  const detectedTick = firstTick(ev11, 'enemy.detected', idC);
  check('T11 détection C: state DETECTED + event enemy.detected',
    st11.enemies.find((e) => e.kind === 'C').state === 'DETECTED' && detectedTick !== null,
    { st: st11.enemies.find((e) => e.kind === 'C').state, detectedTick });

  // ---------- T12: ennemi C tire — création d'un projectile (entité du monde) ----------
  await GL.step(90);
  const st12 = await GL.state();
  const ev12 = await GL.events(200);
  const firedTick = firstTick(ev12, 'enemy.fired', idC);
  check('T12 projectile C: ≥1 projectile dans le monde + event enemy.fired',
    st12.projectiles.length >= 1 && firedTick !== null,
    { n: st12.projectiles.length, firedTick, p0: st12.projectiles[0] });

  // ---------- T13: le projectile se déplace dans le temps ----------
  const q0 = st12.projectiles[0];
  await GL.step(10);
  const q1 = (await GL.state()).projectiles[0];
  const qd = q1 ? dist3(q0, q1) : 0;
  check('T13 projectile mobile: ~7 m/s × 10 ticks = 1.17 m (±)', qd > 0.95 && qd < 1.4, { q0, q1, d: +qd.toFixed(3) });

  // ---------- T14: le projectile touche le joueur (dégâts) ----------
  await GL.step(40);
  const p14 = (await GL.snap()).player;
  const ev14 = await GL.events(200);
  const projHitTick = ev14.filter((e) => e.event === 'damage' && e.entity === 'player' && e.other === idC)[0]?.tick ?? null;
  const hp14 = hp(p14);
  check('T14 projectile → joueur: damage other=mage + vie du joueur réduite',
    projHitTick !== null && hp14 < 100, { hp: hp14, projHitTick });

  // ---------- T15: le joueur tire sur l'ennemi C (hitscan) ----------
  await GL.dbg(`GameLoom._debug.setPlayerHealth(100)`);
  const cPos15 = (await GL.state()).enemies.find((e) => e.kind === 'C').pos;
  await GL.dbg(`GameLoom._debug.aimAt(${cPos15[0]}, 1.1, ${cPos15[2]})`);
  await GL.dbg(`GameLoom._debug.gameFire()`);
  await GL.step(16);
  const ev15 = await GL.events(200);
  const cHp15 = (await GL.state()).enemies.find((e) => e.kind === 'C')?.health;
  const hitPlayerTick = ev15.filter((e) => e.event === 'damage' && e.entity === idC && e.other === 'player')[0]?.tick ?? null;
  check('T15 tir joueur: damage other=player sur le mage (80 → 55)',
    hitPlayerTick !== null && cHp15 === 55, { cHp: cHp15, hitPlayerTick });

  // ---------- T16: mort du mage (damage → health.zero → destroy) ----------
  for (let i = 0; i < 3; i++) {
    const cNow = (await GL.state()).enemies.find((e) => e.kind === 'C');
    if (!cNow) break;
    await GL.dbg(`GameLoom._debug.aimAt(${cNow.pos[0]}, 1.1, ${cNow.pos[2]})`);
    await GL.dbg(`GameLoom._debug.gameFire()`);
    await GL.step(16);
  }
  const st16 = await GL.state();
  const ev16 = await GL.events(250);
  const cZeroTick = firstTick(ev16, 'health.zero', idC);
  const cDestroyTick = firstTick(ev16, 'destroy', idC);
  check('T16 mort du mage: health.zero + destroy + entité retirée du monde',
    cZeroTick !== null && cDestroyTick !== null && !st16.enemies.some((e) => e.kind === 'C')
    && (await GL.entities({ tag: 'enemy' })).length === 2,
    { cZeroTick, cDestroyTick, enemies: st16.enemies.map((e) => e.kind) });

  // ---------- T17: piège — entrée (trap.enter + dégâts immédiats) ----------
  await GL.dbg(`GameLoom._debug.setPlayerHealth(100)`);
  await GL.dbg(`GameLoom._debug.teleportPlayer(13.5, 0.92, 0)`);
  await GL.step(5);
  const st17 = await GL.state();
  const ev17 = await GL.events(200);
  const trapEnterTick = firstTick(ev17, 'trap.enter', 'player');
  const hp17 = hp((await GL.snap()).player);
  check('T17 piège entrée: event trap.enter + dégâts à l’entrée (100 → 90)',
    st17.trap.inside === true && trapEnterTick !== null && hp17 === 90, { hp: hp17, trapEnterTick });

  // ---------- T18: piège — dégâts persistants ----------
  await GL.step(12);
  const ev18 = await GL.events(200);
  const hp18 = hp((await GL.snap()).player);
  const trapDmg = ev18.filter((e) => e.event === 'damage' && e.entity === 'player' && e.other === 'trap');
  check('T18 piège dégâts: 5 par palier de 12 ticks (90 → 85)',
    hp18 === 85 && trapDmg.length >= 2, { hp: hp18, n: trapDmg.length });
  const fpHP18 = hp18;

  // ---------- T19: piège — sortie (trap.exit, dégâts stoppés) ----------
  await GL.dbg(`GameLoom._debug.teleportPlayer(13.5, 0.92, -3)`);
  await GL.step(5);
  const ev19 = await GL.events(200);
  const trapExitTick = firstTick(ev19, 'trap.exit', 'player');
  await GL.step(12);
  const hp19 = hp((await GL.snap()).player);
  check('T19 piège sortie: trap.exit émis + plus de dégâts (HP stable)',
    (await GL.state()).trap.inside === false && trapExitTick !== null && hp19 === fpHP18,
    { hp: hp19, trapExitTick });

  // ---------- T20: porte verrouillée avant la clé ----------
  await GL.dbg(`GameLoom._debug.setPlayerHealth(100)`);
  await GL.dbg(`GameLoom._debug.teleportPlayer(19.5, 0.92, 0)`);
  await GL.step(5);
  await GL.dbg(`GameLoom._debug.setLook(-1.5708, 0)`);   // avant = +X
  await GL.dbg(`GameLoom._debug.input({ move: [1, 0] })`);
  await GL.step(45);
  await GL.dbg(`GameLoom._debug.input({ move: [0, 0] })`);
  const p20 = (await GL.snap()).player;
  const st20 = await GL.state();
  const ev20 = await GL.events(200);
  check('T20 porte verrouillée: le joueur est bloqué par la collision réelle (x < 19.9)',
    st20.door.locked === true && p20.pos[0] > 19.3 && p20.pos[0] < 19.9 && !ev20.some((e) => e.event === 'player.exited'),
    { x: +p20.pos[0].toFixed(3), door: st20.door });

  // ---------- T21: zone de sortie AVANT la clé → pas de victoire ----------
  await GL.dbg(`GameLoom._debug.teleportPlayer(22, 0.92, 0)`);
  await GL.step(10);
  const st21 = await GL.state();
  const ev21 = await GL.events(200);
  check('T21 sortie avant clé: dans la zone mais inactive, pas de victoire',
    st21.won === false && st21.exit.active === false && !ev21.some((e) => e.event === 'player.exited'),
    { won: st21.won, exit: st21.exit });

  // ---------- T22: clé récupérée (E) + porte déverrouillée ----------
  await GL.dbg(`GameLoom._debug.teleportPlayer(14, 0.92, 9)`);
  await GL.step(2);
  await GL.dbg(`GameLoom._debug.gameInteract()`);
  await GL.step(5);
  const st22 = await GL.state();
  const ev22 = await GL.events(200);
  const keyTick = firstTick(ev22, 'key.collected');
  const doorTick = firstTick(ev22, 'door.unlocked', 'player');
  check('T22 clé: key.collected + door.unlocked + clé détruite + score ≥ 100',
    st22.key.collected === true && st22.door.open === true && keyTick !== null && doorTick !== null
    && (await GL.entities({ tag: 'dungeon_key' })).length === 0 && st22.score >= 100,
    { keyTick, doorTick, score: st22.score, door: st22.door });

  // ---------- T23: passage de la porte (dégagée) ----------
  await GL.dbg(`GameLoom._debug.teleportPlayer(19.2, 0.92, 0)`);
  await GL.step(2);
  await GL.dbg(`GameLoom._debug.setLook(-1.5708, 0)`);
  await GL.dbg(`GameLoom._debug.input({ move: [1, 0] })`);
  await GL.step(45);
  await GL.dbg(`GameLoom._debug.input({ move: [0, 0] })`);
  const p23 = (await GL.snap()).player;
  check('T23 passage porte: le joueur traverse la porte dégagée (x > 20.6)',
    p23.pos[0] > 20.6 && p23.grounded === true, { x: +p23.pos[0].toFixed(3) });

  // ---------- T24: victoire (clé + porte + zone de sortie → player.exited) ----------
  const st24 = await GL.state();
  const ev24 = await GL.events(250);
  const exitTick = firstTick(ev24, 'player.exited', 'player');
  const winVisible = await cdp.eval(`document.getElementById('win').style.display === 'flex'`);
  check('T24 victoire: player.exited + won=true + overlay victoire',
    st24.won === true && st24.gameOver === 'victory' && exitTick !== null && winVisible,
    { won: st24.won, exitTick, winVisible, score: st24.score });

  // ---------- T25: mort du joueur (page 2, boot frais — piège) ----------
  await cdp.send('Page.navigate', { url: URL_TARGET });
  ready = await waitReady(cdp);
  check('T25 boot page 2: GameLoom réexposé (scénario de mort isolé)', ready);
  if (ready) await sleep(800);
  await GL.pause();
  await GL.step(30);
  await GL.dbg(`GameLoom._debug.setPlayerHealth(15)`);
  await GL.dbg(`GameLoom._debug.teleportPlayer(13.5, 0.92, 0)`);
  await GL.step(90);
  const p25 = (await GL.snap()).player;
  const st25 = await GL.state();
  const ev25 = await GL.events(300);
  const diedTick = firstTick(ev25, 'player.died', 'player');
  check('T25 mort: 15 HP + piège → health.zero → player.died (tick 42), alive=false',
    p25.alive === false && st25.dead === true && diedTick === 42,
    { hp: p25.health, dead: st25.dead, diedTick });

  // ---------- T26: doctor / état cohérent ----------
  const doc = await GL.doctor();
  check('T26 doctor: ok, 3 GLB dungeon chargés avec méta, aucune entité zombie',
    doc.ok === true
    && doc.assets.loaded.includes('assets/dungeon_mage.glb')
    && doc.assets.loaded.includes('assets/dungeon_key.glb')
    && doc.assets.loaded.includes('assets/dungeon_spikes.glb')
    && doc.assets.without_gameloom_meta.length === 0,
    { ok: doc?.ok, warnings: doc?.warnings, assets: doc?.assets.loaded });

  // ---------- T27: régression assets — CLI glb sur les 3 GLB nouveaux ----------
  const glbs = ['dungeon_key.glb', 'dungeon_mage.glb', 'dungeon_spikes.glb'];
  let validateOk = true, validateDetail = {};
  for (const f of glbs) {
    try {
      const out = execSync(`node tools/cli.mjs validate assets/${f}`, { cwd: REPO_ROOT, encoding: 'utf8' });
      validateDetail[f] = out.trim().replace(/\n/g, ' ');
      if (!out.includes('valide')) validateOk = false;
    } catch (e) { validateOk = false; validateDetail[f] = e.message; }
  }
  check('T27 assets: les 3 GLB passent `glb validate`', validateOk, validateDetail);
  let doctorOk = true, doctorDetail = {};
  for (const f of glbs) {
    try {
      const out = execSync(`node tools/cli.mjs doctor assets/${f}`, { cwd: REPO_ROOT, encoding: 'utf8' });
      const j = JSON.parse(out);
      doctorDetail[f] = { ok: j.ok, warnings: j.checks.warnings };
      if (!j.ok) doctorOk = false;
    } catch (e) { doctorOk = false; doctorDetail[f] = e.message; }
  }
  check('T28 assets: `glb doctor` ok sans avertissement sur les 3 GLB', doctorOk, doctorDetail);

  // ---------- T29: erreurs console (les 2 boots) ----------
  const realErrors = cdp.errors.filter((e) => !/WebGL|GL |audio|Audio/i.test(e));
  check('T29 console: zéro erreur inattendue', realErrors.length === 0, realErrors.slice(0, 3));

  // ---------- T30: screenshot UNIQUE — validation visuelle finale ----------
  await cdp.send('Page.navigate', { url: URL_TARGET });
  ready = await waitReady(cdp);
  if (ready) {
    await sleep(800);
    await GL.pause();
    await GL.step(30);
    await GL.dbg(`GameLoom._debug.teleportPlayer(2.5, 0.92, 0)`);
    await GL.dbg(`GameLoom._debug.setLook(-1.5708, -0.06)`);
    await GL.step(2);
  }
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(SHOT_PATH, Buffer.from(shot.data, 'base64'));
  check('T30 screenshot final capturé (seule validation visuelle)', ready, 'tools/dungeon_screenshot.png');

  // ---------- FINGERPRINT (déterminisme: identique entre runs) ----------
  console.log('FINGERPRINT', JSON.stringify({
    tickAfterT3: tD,
    playerT4: [ +fpPlayerT4[0].toFixed(4), +fpPlayerT4[2].toFixed(4) ],
    patrolA: [ [ +aA[0].toFixed(4), +aA[2].toFixed(4) ], [ +aB[0].toFixed(4), +aB[2].toFixed(4) ], [ +aC[0].toFixed(4), +aC[2].toFixed(4) ] ],
    alertTick, attackTick, activatedTick, detectedTick, firedTick,
    projMoveDist: +qd.toFixed(4), projHitTick, cKillTick: cZeroTick,
    trapEnterTick, trapExitTick, keyTick, doorTick, exitTick, diedTick,
    hpT18: fpHP18,
  }));

  // ---------- bilan ----------
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n=== BILAN: ${pass}/${results.length} tests passés ===`);
  console.log('état final:', JSON.stringify(await GL.stats()));
  console.log('état dungeon:', JSON.stringify(await GL.state()));
  console.log('events récents:', JSON.stringify(await GL.events(10)));
  cdp.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error('FATALE:', e.message);
  process.exit(2);
});
