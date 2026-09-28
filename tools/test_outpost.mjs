// Outpost Rescue — testeur headless v1 via CDP (port 9224), même pattern que test_headless/temple/ruins/dungeon.mjs
// 100% déterministe: pause()/step(n) pilotent le temps de jeu; le sleep ne sert qu'au boot/réseau.
// L'état du jeu est lu via GameLoom (JSON) + _debug.outpostState() — pas de vision pour la logique.
// FINGERPRINT: valeurs exactes des ticks clés, à comparer entre runs (déterminisme).
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CDP_HTTP = 'http://localhost:9224';
const URL_TARGET = process.env.URL_TARGET ?? 'http://localhost:4173/outpost.html';
const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HARNESS_DIR, '..');
const SHOT_PATH = join(HARNESS_DIR, 'outpost_screenshot.png');
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout ${method}`)); } }, 20000);
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
    state: () => cdp.eval('GameLoom._debug.outpostState()'),
  };
  const hp = (p) => Number(String(p.health).split('/')[0]);   // p = snapshot().player
  const firstTick = (evs, name, ent) => evs.filter((e) => e.event === name && (ent === undefined || e.entity === ent))[0]?.tick ?? null;
  const countEv = (evs, name, ent) => evs.filter((e) => e.event === name && (ent === undefined || e.entity === ent)).length;

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

  // ---------- T2: état initial: entités + survivants WAITING ----------
  const nSurv = await GL.entities({ tag: 'survivor' });
  const nA = await GL.entities({ tag: 'survivor_a' });
  const nB = await GL.entities({ tag: 'survivor_b' });
  const nC = await GL.entities({ tag: 'survivor_c' });
  const nEnemy = await GL.entities({ tag: 'enemy' });
  const nCrate = await GL.entities({ tag: 'crate' });
  const nCol = await GL.entities({ tag: 'ruins_column' });
  const st2 = await GL.state();
  const sA0 = st2.survivors.find((s) => s.kind === 'A');
  check('T2 entités: joueur + 3 survivants (A/B/C) + 2 ennemis + 3 caisses + 2 colonnes (11), tous WAITING',
    nSurv.length === 3 && nA.length === 1 && nB.length === 1 && nC.length === 1 && nEnemy.length === 2
    && nCrate.length === 3 && nCol.length === 2 && (await GL.stats()).entities === 11
    && st2.survivors.every((s) => s.state === 'WAITING'),
    { survivor: nSurv.length, enemy: nEnemy.length, entities: (await GL.stats()).entities, states: st2.survivors.map((s) => `${s.kind}:${s.state}` ) });
  const idA = nA[0].id, idB = nB[0].id, idC = nC[0].id;
  const idE1 = (await GL.entities({ tag: 'enemy_e1' }))[0].id;
  const idE2 = (await GL.entities({ tag: 'enemy_e2' }))[0].id;

  // ---------- T3: pause + step déterministes ----------
  const tA = (await GL.snap()).tick;
  await sleep(700);
  const tB = (await GL.snap()).tick;
  check('T3a pause: tick figé pendant 700ms de temps réel', Number.isInteger(tA) && tA === tB, { tA, tB });
  await GL.step(1);
  const tC = (await GL.snap()).tick;
  await GL.step(10);
  const tD = (await GL.snap()).tick;
  check('T3b step(1) puis step(10): +1 puis +10 ticks exacts', tC === tA + 1 && tD === tC + 10, { tA, tC, tD });

  // ---------- T4: déplacement joueur contrôlable (zone de départ, +X) ----------
  await GL.dbg(`GameLoom._debug.teleportPlayer(-8, 0.92, 3)`);
  await GL.step(5);
  await GL.dbg(`GameLoom._debug.setLook(-1.5708, 0)`);   // avant = +X
  await GL.dbg(`GameLoom._debug.input({ move: [1, 0] })`);
  await GL.step(30);                                      // 0.5 s ≈ 2.8 m tentés
  await GL.dbg(`GameLoom._debug.input({ move: [0, 0] })`);
  const p4 = (await GL.snap()).player;
  check('T4 déplacement: joueur avance de ~2.8 m vers +X (au sol)',
    p4.pos[0] > -5.8 && p4.pos[0] < -4.4 && Math.abs(p4.pos[2] - 3) < 0.5 && p4.grounded === true,
    { x: +p4.pos[0].toFixed(3), z: +p4.pos[2].toFixed(3), grounded: p4.grounded });
  const fpPlayerT4 = [ +p4.pos[0].toFixed(4), +p4.pos[2].toFixed(4) ];

  // ---------- T5: aucun événement survivant avant interaction ----------
  const ev5 = await GL.events(200);
  check('T5 état initial: aucun survivor.* / danger.* / rescue.completed émis',
    !ev5.some((e) => e.event.startsWith('survivor.') || e.event.startsWith('danger.') || e.event === 'rescue.completed'),
    { events: ev5.map((e) => e.event) });

  // ---------- T6: ennemi E1: CHASE + déplacement réel, puis arrêt à la portée d'attaque ----------
  await GL.dbg(`GameLoom._debug.teleportPlayer(0, 0.92, 1)`);
  await GL.step(15);
  const st6 = await GL.state();
  const ev6 = await GL.events(200);
  const e1AlertTick = firstTick(ev6, 'enemy.alert', idE1);
  const e1_0 = st6.enemies.find((e) => e.id === idE1).pos;
  await GL.step(20);
  const e1_1 = (await GL.state()).enemies.find((e) => e.id === idE1).pos;
  await GL.step(20);
  const e1_2 = (await GL.state()).enemies.find((e) => e.id === idE1).pos;
  await GL.step(120);   // E1 referme la distance puis s'arrête à portée d'attaque (1.5 m)
  const e1_3 = (await GL.state()).enemies.find((e) => e.id === idE1).pos;
  const p6a = (await GL.snap()).player;
  await GL.step(15);
  const e1_4 = (await GL.state()).enemies.find((e) => e.id === idE1).pos;
  const dAtk = dist2(e1_3, p6a.pos);
  check('T6 ennemi E1: CHASE + alert + déplacement réel (~2.5 m/s) puis arrêt immobile à la portée d’attaque',
    st6.enemies.find((e) => e.id === idE1).state === 'CHASE' && e1AlertTick !== null
    && dist2(e1_0, e1_1) >= 0.7 && dist2(e1_0, e1_1) <= 0.95
    && dist2(e1_1, e1_2) >= 0.7 && dist2(e1_1, e1_2) <= 0.95
    && dAtk >= 1.2 && dAtk <= 1.7 && dist2(e1_3, e1_4) < 0.01,
    { st: st6.enemies.find((e) => e.id === idE1).state, alertTick: e1AlertTick, d1: +dist2(e1_0, e1_1).toFixed(3), d2: +dist2(e1_1, e1_2).toFixed(3), dAtk: +dAtk.toFixed(3), dStop: +dist2(e1_3, e1_4).toFixed(4) });

  // ---------- T7: dégâts du joueur sur E1 (tir hitscan) ----------
  const e1Pos7 = (await GL.state()).enemies.find((e) => e.id === idE1).pos;
  await GL.dbg(`GameLoom._debug.aimAt(${e1Pos7[0]}, 1.0, ${e1Pos7[2]})`);
  await GL.dbg(`GameLoom._debug.gameFire()`);
  await GL.step(16);
  const st7 = await GL.state();
  const ev7 = await GL.events(200);
  const hitTick7 = ev7.filter((e) => e.event === 'damage' && e.entity === idE1 && e.other === 'player')[0]?.tick ?? null;
  check('T7 tir joueur: damage other=player sur E1 (100 → 70)',
    hitTick7 !== null && st7.enemies.find((e) => e.id === idE1).health === 70,
    { hp: st7.enemies.find((e) => e.id === idE1).health, hitTick: hitTick7 });

  // ---------- T8: mort de E1 (3 tirs restants → health.zero → destroy + enemy.killed) ----------
  // Les ennemis attaquent le joueur pendant les fenêtres de tir → reset HP (isolation de test)
  await GL.dbg(`GameLoom._debug.setPlayerHealth(100)`);
  for (let i = 0; i < 3; i++) {
    const e1Now = (await GL.state()).enemies.find((e) => e.id === idE1);
    if (!e1Now) break;
    await GL.dbg(`GameLoom._debug.aimAt(${e1Now.pos[0]}, 1.0, ${e1Now.pos[2]})`);
    await GL.dbg(`GameLoom._debug.gameFire()`);
    await GL.step(16);
  }
  const st8 = await GL.state();
  const ev8 = await GL.events(250);
  const e1ZeroTick = firstTick(ev8, 'health.zero', idE1);
  const e1KillTick = firstTick(ev8, 'enemy.killed', idE1);
  check('T8 mort E1: health.zero + enemy.killed + entité retirée (1 ennemi restant)',
    e1ZeroTick !== null && e1KillTick !== null && !st8.enemies.some((e) => e.id === idE1) && st8.enemies.length === 1,
    { e1ZeroTick, e1KillTick, enemies: st8.enemies.map((e) => e.kind) });

  // ---------- T9: mort de E2 (même mécanique, position lue à chaque tir) ----------
  await GL.dbg(`GameLoom._debug.setPlayerHealth(100)`);
  for (let i = 0; i < 4; i++) {
    const e2Now = (await GL.state()).enemies.find((e) => e.id === idE2);
    if (!e2Now) break;
    await GL.dbg(`GameLoom._debug.aimAt(${e2Now.pos[0]}, 1.0, ${e2Now.pos[2]})`);
    await GL.dbg(`GameLoom._debug.gameFire()`);
    await GL.step(16);
  }
  const st9 = await GL.state();
  const ev9 = await GL.events(300);
  const e2KillTick = firstTick(ev9, 'enemy.killed', idE2);
  check('T9 mort E2: enemy.killed + plus aucun ennemi',
    e2KillTick !== null && st9.enemies.length === 0 && (await GL.entities({ tag: 'enemy' })).length === 0,
    { e2KillTick, enemies: st9.enemies.length });

  // ---------- T10: zone feu — entrée (danger.enter + dégâts à l'entrée) ----------
  await GL.dbg(`GameLoom._debug.setPlayerHealth(100)`);
  await GL.dbg(`GameLoom._debug.teleportPlayer(3, 0.92, 0)`);   // dans le feu x[1,5] z[-2,2]
  await GL.step(5);
  const st10 = await GL.state();
  const ev10 = await GL.events(200);
  const fireEnterTick = firstTick(ev10, 'danger.enter', 'player');
  const hp10 = hp((await GL.snap()).player);
  check('T10 feu entrée: danger.enter(player) + dégâts à l’entrée (100 → 85)',
    st10.dangers.find((z) => z.id === 'fire').playerInside === true && fireEnterTick !== null && hp10 === 85,
    { hp: hp10, fireEnterTick, fire: st10.dangers.find((z) => z.id === 'fire') });

  // ---------- T11: feu — pas de spam enter + dégâts périodiques mesurables ----------
  await GL.step(72);
  const ev11 = await GL.events(300);
  const hp11 = hp((await GL.snap()).player);
  const fireEnters11 = countEv(ev11, 'danger.enter', 'player');
  const fireDmg11 = ev11.filter((e) => e.event === 'damage' && e.entity === 'player' && e.other === 'fire').length;
  check('T11 feu 72 ticks: exactly 1 danger.enter + dégâts périodiques (HP exact 61 = 85 - 6×4)',
    fireEnters11 === 1 && fireDmg11 === 7 && hp11 === 61,
    { hp: hp11, enterCount: fireEnters11, fireDamageEvents: fireDmg11 });
  const fpHPFire = hp11;

  // ---------- T12: feu — sortie (danger.exit, dégâts stoppés) ----------
  await GL.dbg(`GameLoom._debug.teleportPlayer(3, 0.92, -4)`);
  await GL.step(5);
  const ev12 = await GL.events(300);
  const fireExitTick = firstTick(ev12, 'danger.exit', 'player');
  await GL.step(12);
  const hp12 = hp((await GL.snap()).player);
  check('T12 feu sortie: danger.exit + HP stable',
    (await GL.state()).dangers.find((z) => z.id === 'fire').playerInside === false && fireExitTick !== null && hp12 === fpHPFire,
    { hp: hp12, fireExitTick });

  // ---------- T13: zone gaz — entrée (2e zone, dégâts à l'entrée 20) ----------
  await GL.dbg(`GameLoom._debug.setPlayerHealth(100)`);
  await GL.dbg(`GameLoom._debug.teleportPlayer(-3, 0.92, 6)`);  // dans le gaz x[-5,-1] z[4,8]
  await GL.step(5);
  const st13 = await GL.state();
  const ev13 = await GL.events(300);
  const gasEnterTick = firstTick(ev13, 'danger.enter', 'player');
  const hp13 = hp((await GL.snap()).player);
  check('T13 gaz entrée: danger.enter(gaz) + dégâts à l’entrée (100 → 80)',
    st13.dangers.find((z) => z.id === 'gas').playerInside === true && gasEnterTick !== null && hp13 === 80,
    { hp: hp13, gasEnterTick });

  // ---------- T14: interaction E recrute le survivant A (WAITING → FOLLOWING) ----------
  await GL.dbg(`GameLoom._debug.teleportPlayer(-9, 0.92, -5)`);
  await GL.step(2);
  await GL.dbg(`GameLoom._debug.gameInteract()`);
  await GL.step(5);
  const st14 = await GL.state();
  const ev14 = await GL.events(300);
  const aFollowedTick = firstTick(ev14, 'survivor.followed', idA);
  check('T14 recrutement A: event survivor.followed + état FOLLOWING',
    st14.survivors.find((s) => s.kind === 'A').state === 'FOLLOWING' && aFollowedTick !== null,
    { st: st14.survivors.find((s) => s.kind === 'A').state, aFollowedTick });

  // ---------- T15: A se déplace réellement sur plusieurs ticks (suit le joueur) ----------
  await GL.dbg(`GameLoom._debug.teleportPlayer(1, 0.92, -5)`);
  const aP0 = (await GL.state()).survivors.find((s) => s.kind === 'A').pos;
  await GL.step(30);
  const aP1 = (await GL.state()).survivors.find((s) => s.kind === 'A').pos;
  await GL.step(30);
  const aP2 = (await GL.state()).survivors.find((s) => s.kind === 'A').pos;
  check('T15 A mobile: déplacement réel ≥ 1.4 m / fenêtre de 30 ticks (~3.2 m/s) sur 2 fenêtres',
    dist2(aP0, aP1) >= 1.4 && dist2(aP1, aP2) >= 1.4,
    { d1: +dist2(aP0, aP1).toFixed(3), d2: +dist2(aP1, aP2).toFixed(3) });

  // ---------- T16: A suit le joueur (s'arrête à la distance cible, le reprend s'il s'éloigne) ----------
  await GL.dbg(`GameLoom._debug.teleportPlayer(5, 0.92, -5)`);
  await GL.step(300);
  const st16 = await GL.state();
  const aP3 = st16.survivors.find((s) => s.kind === 'A').pos;
  const p16 = (await GL.snap()).player;
  const gapA = dist2(aP3, p16.pos);
  check('T16 A suit: après 300 ticks, distance au joueur ∈ [1.5, 2.8] (bande cible) et A a avancé ≥ 2.5 m',
    gapA >= 1.5 && gapA <= 2.8 && dist2(aP2, aP3) >= 2.5,
    { gap: +gapA.toFixed(3), aMoved: +dist2(aP2, aP3).toFixed(3) });
  const fpGapA = +gapA.toFixed(4);

  // ---------- T17: joueur dans l'évacuation AVANT le rescue → PAS de victoire ----------
  await GL.dbg(`GameLoom._debug.teleportPlayer(13.5, 0.92, 0)`);
  await GL.step(5);
  const st17 = await GL.state();
  const ev17 = await GL.events(300);
  check('T17 entrée trop tôt: joueur dans la zone, 0 évacué → won=false, pas de player.extracted',
    st17.evac.playerInside === true && st17.won === false && st17.rescueComplete === false
    && !ev17.some((e) => e.event === 'player.extracted'),
    { won: st17.won, rescueComplete: st17.rescueComplete, playerInside: st17.evac.playerInside });

  // ---------- T18: A entre dans l'évacuation → EVACUATED (compteur 1/3, toujours pas de victoire) ----------
  await GL.step(240);
  const st18 = await GL.state();
  const ev18 = await GL.events(350);
  const aEvacTick = firstTick(ev18, 'survivor.evacuated', idA);
  check('T18 A évacué: état EVACUATED + event survivor.evacuated + compteur 1/3 + won=false',
    st18.survivors.find((s) => s.kind === 'A').state === 'EVACUATED' && aEvacTick !== null
    && st18.evacCount === 1 && st18.won === false,
    { st: st18.survivors.find((s) => s.kind === 'A').state, aEvacTick, evacCount: st18.evacCount, won: st18.won });

  // ---------- T19: recrutement de B puis C ----------
  await GL.dbg(`GameLoom._debug.teleportPlayer(-9, 0.92, 7)`);
  await GL.step(2);
  await GL.dbg(`GameLoom._debug.gameInteract()`);
  await GL.step(5);
  const stB = await GL.state();
  const evB = await GL.events(350);
  const bFollowedTick = firstTick(evB, 'survivor.followed', idB);
  check('T19a recrutement B: survivor.followed + état FOLLOWING (compteur toujours 1)',
    stB.survivors.find((s) => s.kind === 'B').state === 'FOLLOWING' && bFollowedTick !== null && stB.evacCount === 1,
    { st: stB.survivors.find((s) => s.kind === 'B').state, bFollowedTick });
  await GL.dbg(`GameLoom._debug.teleportPlayer(8, 0.92, -7)`);
  await GL.step(2);
  await GL.dbg(`GameLoom._debug.gameInteract()`);
  await GL.step(5);
  const stC = await GL.state();
  const evC = await GL.events(350);
  const cFollowedTick = firstTick(evC, 'survivor.followed', idC);
  check('T19b recrutement C: survivor.followed + état FOLLOWING (3 survivants suivent)',
    stC.survivors.find((s) => s.kind === 'C').state === 'FOLLOWING' && cFollowedTick !== null
    && stC.survivors.filter((s) => s.state === 'FOLLOWING').length === 2,
    { st: stC.survivors.find((s) => s.kind === 'C').state, cFollowedTick });

  // ---------- T20: B + C évacués → rescue.completed, puis joueur dans la zone → victoire ----------
  await GL.dbg(`GameLoom._debug.teleportPlayer(13.5, 0.92, 0)`);
  await GL.step(600);
  const st20 = await GL.state();
  const ev20 = await GL.events(500);
  const bEvacTick = firstTick(ev20, 'survivor.evacuated', idB);
  const cEvacTick = firstTick(ev20, 'survivor.evacuated', idC);
  const rescueTick = firstTick(ev20, 'rescue.completed');
  const extractedTick = firstTick(ev20, 'player.extracted', 'player');
  const winVisible = await cdp.eval(`document.getElementById('win').style.display === 'flex'`);
  check('T20 victoire: B+C EVACUATED, compteur 3/3, rescue.completed AVANT ou même tick que player.extracted, won=true, overlay',
    st20.survivors.find((s) => s.kind === 'B').state === 'EVACUATED'
    && st20.survivors.find((s) => s.kind === 'C').state === 'EVACUATED'
    && st20.evacCount === 3 && st20.rescueComplete === true && st20.won === true
    && bEvacTick !== null && cEvacTick !== null && rescueTick !== null && extractedTick !== null
    && extractedTick >= rescueTick && winVisible,
    { bEvacTick, cEvacTick, rescueTick, extractedTick, won: st20.won, winVisible });

  // ---------- T21: état final cohérent ----------
  const st21 = await GL.state();
  check('T21 état final: 3 survivants EVACUATED, 0 ennemi, score 200, joueur vivant, gameOver=victory',
    st21.survivors.every((s) => s.state === 'EVACUATED') && st21.enemies.length === 0
    && st21.score === 200 && (await GL.snap()).player.alive === true && st21.gameOver === 'victory'
    && st21.survivors.find((s) => s.kind === 'B').health === 80   // B a traversé le gaz (effet de zone réel)
    && st21.survivors.find((s) => s.kind === 'C').health === 100,
    { states: st21.survivors.map((s) => `${s.kind}:${s.state}:${s.health}`), enemies: st21.enemies.length, score: st21.score });

  // ---------- T22: pause()/step(n) restent déterministes en fin de partie ----------
  const t22a = (await GL.snap()).tick;
  await sleep(500);
  const t22b = (await GL.snap()).tick;
  await GL.step(10);
  const t22c = (await GL.snap()).tick;
  check('T22 déterminisme: pause fige le tick puis step(10) = +10 exact', t22a === t22b && t22c === t22a + 10, { t22a, t22b, t22c });

  // ---------- T23: mort du joueur (page 2, boot frais) ----------
  await cdp.send('Page.navigate', { url: URL_TARGET });
  ready = await waitReady(cdp);
  check('T23 boot page 2: GameLoom réexposé (scénario de mort isolé)', ready);
  if (ready) await sleep(800);
  await GL.pause();
  await GL.step(30);
  await GL.dbg(`GameLoom._debug.setPlayerHealth(5)`);
  await GL.dbg(`GameLoom._debug.teleportPlayer(3, 0.92, 0)`);
  await GL.step(90);
  const p23 = (await GL.snap()).player;
  const st23 = await GL.state();
  const ev23 = await GL.events(300);
  const diedTick = firstTick(ev23, 'player.died', 'player');
  check('T23 mort: 5 HP + feu → danger.enter + health.zero → player.died (tick 30), alive=false',
    p23.alive === false && st23.dead === true && diedTick === 30,
    { hp: p23.health, dead: st23.dead, diedTick });

  // ---------- T24: doctor / état cohérent ----------
  const doc = await GL.doctor();
  check('T24 doctor: ok, survivor.glb chargé avec méta, aucune entité sans méta',
    doc.ok === true && doc.assets.loaded.includes('assets/survivor.glb') && doc.assets.without_gameloom_meta.length === 0,
    { ok: doc?.ok, warnings: doc?.warnings, assets: doc?.assets.loaded });

  // ---------- T25: erreurs console (les 2 boots) ----------
  const realErrors = cdp.errors.filter((e) => !/WebGL|GL |audio|Audio/i.test(e));
  check('T25 console: zéro erreur inattendue', realErrors.length === 0, realErrors.slice(0, 3));

  // ---------- T26: régression asset — CLI glb sur survivor.glb ----------
  let validateOk = true, validateDetail = {};
  try {
    const out = execSync(`node tools/cli.mjs validate assets/survivor.glb`, { cwd: REPO_ROOT, encoding: 'utf8' });
    validateDetail['survivor'] = out.trim().replace(/\n/g, ' ');
    if (!out.includes('valide')) validateOk = false;
  } catch (e) { validateOk = false; validateDetail['survivor'] = e.message; }
  check('T26 asset: survivor.glb passe `glb validate`', validateOk, validateDetail);
  let doctorOk = true, doctorDetail = {};
  try {
    const out = execSync(`node tools/cli.mjs doctor assets/survivor.glb`, { cwd: REPO_ROOT, encoding: 'utf8' });
    const j = JSON.parse(out);
    doctorDetail['survivor'] = { ok: j.ok, warnings: j.checks.warnings };
    if (!j.ok) doctorOk = false;
  } catch (e) { doctorOk = false; doctorDetail['survivor'] = e.message; }
  check('T27 asset: `glb doctor` ok sans avertissement', doctorOk, doctorDetail);

  // ---------- T28: screenshot UNIQUE — validation visuelle finale ----------
  // Scénario: recruter C puis le voir DANS la zone verte (survivant + évac + HUD lisibles)
  await cdp.send('Page.navigate', { url: URL_TARGET });
  ready = await waitReady(cdp);
  if (ready) {
    await sleep(800);
    await GL.pause();
    await GL.step(30);
    await GL.dbg(`GameLoom._debug.teleportPlayer(8.6, 0.92, -7.4)`);   // à côté du survivant C (8,-7)
    await GL.step(2);
    await GL.dbg(`GameLoom._debug.gameInteract()`);                     // C → FOLLOWING
    await GL.step(5);
    await GL.dbg(`GameLoom._debug.teleportPlayer(14.6, 0.92, 1.6)`);     // dans la zone verte, côté joueur
    await GL.step(240);                                                 // C court jusqu'à son point d'évacuation
    await GL.dbg(`GameLoom._debug.setLook(0.73, -0.08)`);               // vue sur C (gilet jaune) dans la zone verte
    await GL.step(2);
    await cdp.eval(`document.getElementById('overlay').style.display = 'none'`);   // présentation: montrer la map
  }
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(SHOT_PATH, Buffer.from(shot.data, 'base64'));
  check('T28 screenshot final capturé (seule validation visuelle)', ready, 'tools/outpost_screenshot.png');

  // ---------- FINGERPRINT (déterminisme: identique entre runs) ----------
  console.log('FINGERPRINT', JSON.stringify({
    tickAfterT3: tD,
    playerT4: fpPlayerT4,
    e1AlertTick, e1KillTick, e2KillTick,
    fireEnterTick, fireExitTick, gasEnterTick,
    hpAfterFire: fpHPFire,
    aFollowedTick, aEvacTick, bFollowedTick, cFollowedTick, bEvacTick, cEvacTick,
    gapA16: fpGapA,
    rescueTick, extractedTick, diedTick,
    final: { won: st21.won, evacCount: st21.evacCount, enemies: st21.enemies.length, score: st21.score },
  }));

  // ---------- bilan ----------
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n=== BILAN: ${pass}/${results.length} tests passés ===`);
  console.log('état final:', JSON.stringify(await GL.stats()));
  console.log('état outpost:', JSON.stringify(await GL.state()));
  console.log('events récents:', JSON.stringify(await GL.events(10)));
  cdp.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error('FATALE:', e.message);
  process.exit(2);
});
