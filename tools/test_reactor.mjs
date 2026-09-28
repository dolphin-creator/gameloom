// GameLoom #6 « Reactor Defense » — harness déterministe (CDP 9224 → build 4173).
// Pattern officiel: CDP ws → Runtime.evaluate, check()/bilan, temps par pause()/step(n)
// (jamais sleep de jeu), URL_TARGET propre au jeu. Fingerprint de ticks imprimé en sortie.
import WebSocket from 'ws';

const URL_TARGET = process.env.URL_TARGET ?? 'http://localhost:4173/reactor.html';
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9224';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const fails = [];
function check(name, cond, info = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; fails.push(name); console.log(`  ✗ ${name}${info ? ' — ' + info : ''}`); }
}

let ws; let seq = 0;
const pending = new Map();
const consoleErrors = [];
const exceptions = [];
function cdp(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function ev(expression) {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error('eval: ' + String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? '').slice(0, 400));
  }
  return r.result?.value;
}
const gl = (e) => ev(`window.GameLoom.${e}`);
const dbg = (e) => ev(`window.GameLoom._debug.${e}`);
const step = (n) => ev(`window.GameLoom.step(${n})`);
const events = () => ev('window.GameLoom.events(500)');
const state = () => ev('window.GameLoom._debug.reactorState()');
const snap = () => ev('window.GameLoom.snapshot()');
// snapshot/entities rendent health au format "current/max"
const hpv = (h) => (typeof h === 'number' ? h : parseInt(String(h).split('/')[0], 10));

// position d'un gardien (entities().pos sinon inspect().position)
async function guardianPos(id) {
  const e = await ev(`window.GameLoom.entities({ tag: 'guardian' }).find((x) => x.id === ${JSON.stringify(id)})`);
  if (e?.pos) return e.pos;
  return ev(`window.GameLoom.inspect(${JSON.stringify(id)}).position`);
}

// ---------- calibration convention de visée (yaw/pitch → direction monde) ----------
async function calibrateLook() {
  const data = await ev(`(() => {
    const D = window.GameLoom._debug;
    const S = window.GameLoom.snapshot();
    const [px, py, pz] = S.player.pos;
    const eyeY = py + 1.55;
    const probes = [[10, 0, 0], [0, 0, 10], [0, 4, 3]];
    const got = probes.map((p) => {
      D.aimAt(px + p[0], eyeY + p[1], pz + p[2]);
      return { p, l: D.look() };
    });
    D.aimAt(px + 10, eyeY, pz);
    return { pos: [px, py, pz], got };
  })()`);
  const exps = [[1, 0, 0], [0, 0, 1], [0, 4 / Math.sqrt(25), 3 / Math.sqrt(25)]];
  const cands = {
    A: (y, p) => [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)],
    B: (y, p) => [-Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p)],
    C: (y, p) => [Math.sin(y) * Math.cos(p), -Math.sin(p), Math.cos(y) * Math.cos(p)],
    D: (y, p) => [-Math.sin(y) * Math.cos(p), -Math.sin(p), -Math.cos(y) * Math.cos(p)],
  };
  const scores = {};
  for (const [name, f] of Object.entries(cands)) {
    let s = 0;
    data.got.forEach((g, i) => {
      const d = f(g.l.yaw, g.l.pitch);
      s += Math.abs(d[0] - exps[i][0]) + Math.abs(d[1] - exps[i][1]) + Math.abs(d[2] - exps[i][2]);
    });
    scores[name] = +s.toFixed(4);
  }
  const winner = Object.entries(scores).sort((a, b) => a[1] - b[1])[0];
  console.log(`CALIBRATION visée: pos joueur ${JSON.stringify(data.pos)} · scores ${JSON.stringify(scores)} · gagnant ${winner[0]} (${winner[1]})`);
  if (winner[1] > 0.05) console.log('CALIBRATION: aucun candidat < 0.05 — formules testées contre aimAt/look; vérifier en fin de run (phase tir).');
  return winner[0];
}

async function main() {
  const globalTimer = setTimeout(() => { console.error('TIMEOUT HARNESS 150s'); process.exit(2); }, 150000);
  // Target: transmise par l'orchestrateur (CDP_TARGET_WS) si présente, sinon 1er target
  // page du Chrome CDP (lancement solo) — erreur explicite s'il n'y a pas de page.
  let page = process.env.CDP_TARGET_WS ? { webSocketDebuggerUrl: process.env.CDP_TARGET_WS } : null;
  if (!page) page = (await (await fetch(`${CDP}/json`)).json()).find((t) => t.type === 'page');
  if (!page) { console.error('ERREUR: aucun target page CDP'); process.exit(2); }
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.on('message', (data) => {
    const m = JSON.parse(data.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      exceptions.push(String(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '').slice(0, 300));
    }
  });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Network.enable');
  await cdp('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp('Page.navigate', { url: URL_TARGET });

  // ---------- chargement ----------
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 40000) {
    try {
      const s = await state();
      if (s && s.relays.length === 3 && s.enemies.length === 3) { ready = true; break; }
    } catch { }
    await sleep(400);
  }
  if (!ready) { console.error('ERREUR: jeu non prêt (reactorState) après 40s'); process.exit(2); }
  await gl('pause()');
  console.log('jeu chargé et prêt (3 relais, 3 gardiens)');

  // T1 — jeu chargé
  const ver = await ev('window.GameLoom.version');
  check('T1.1 GameLoom chargé (version 0.2.0)', ver === '0.2.0', `version=${ver}`);
  const st0 = await gl('stats()');
  check('T1.2 temps en pause (déterministe)', st0.paused === true, JSON.stringify(st0));
  check('T1.3 tick initial faible', st0.tick <= 2, `tick=${st0.tick}`);
  const snap0 = await snap();
  check('T1.4 joueur vivant et à 100 PV', snap0.player.alive === true && hpv(snap0.player.health) === 100, JSON.stringify(snap0.player));

  // T2 — état initial
  let s = await state();
  console.log('STATE_SAMPLE ' + JSON.stringify(s).slice(0, 1200));
  check('T2.1 3 relais présents (A/B/C)', s.relays.length === 3 && JSON.stringify(s.relays.map((r) => r.label).sort()) === JSON.stringify(['A', 'B', 'C']), JSON.stringify(s.relays));
  check('T2.2 réacteur: progress 0, pas démarré, pas online', s.reactor.progress === 0 && s.reactor.started === false && s.reactor.online === false, JSON.stringify(s.reactor));
  check('T2.3 renforts non spawnés', s.reinforcements.spawned === false && s.reinforcements.count === 0, JSON.stringify(s.reinforcements));
  check('T2.4 3 ennemis initiaux', s.enemies.length === 3, `n=${s.enemies.length}`);
  check('T2.5 pas de victoire, joueur vivant', s.victory === false && s.playerDead === false);

  // T3 — relais inactifs
  check('T3.1 3 relais inactifs', s.relayCount === 0 && s.relays.every((r) => r.active === false), JSON.stringify(s.relays));
  const relayOf = {};
  for (const r of s.relays) relayOf[r.label] = r.id;

  // T18 — un ennemi se déplace réellement (joueur placé à 4 m du gardien le plus proche → poursuite)
  await dbg(`teleportPlayer(0, 1, -20)`);
  await step(2);
  const sMove = await state();
  const gp = [];
  for (const e of sMove.enemies) gp.push({ id: e.id, p: e.pos ?? (await guardianPos(e.id)) });
  const player0 = (await snap()).player.pos;
  gp.sort((a, b) => (Math.hypot(a.p[0] - player0[0], a.p[2] - player0[2]) - Math.hypot(b.p[0] - player0[0], b.p[2] - player0[2])));
  const g3 = gp[0];
  await dbg(`teleportPlayer(${g3.p[0]}, 1, ${g3.p[2] - 4})`);
  await step(2);
  const before = {};
  for (const e of (await state()).enemies) before[e.id] = e.pos ?? (await guardianPos(e.id));
  await step(30);
  const after = {};
  for (const e of (await state()).enemies) after[e.id] = e.pos ?? (await guardianPos(e.id));
  const movers = Object.keys(after).filter((id) => {
    const a = before[id], b = after[id];
    return a && b && Math.hypot(b[0] - a[0], b[2] - a[2]) > 0.3;
  });
  check('T18.1 au moins 1 ennemi se déplace réellement (>0.3 m / 30 ticks)', movers.length >= 1, `movers=${JSON.stringify(movers)}`);

  // T19 + T21 — un ennemi attaque réellement, le joueur subit des dégâts
  const hpBefore = hpv((await snap()).player.health);
  const tgtPos = after[g3.id];
  await dbg(`teleportPlayer(${tgtPos[0] + 1.5}, 1, ${tgtPos[2]})`);
  await step(90);
  const hpAfter = hpv((await snap()).player.health);
  let evs = await events();
  check('T19.1 au moins 1 ennemi attaque (dégâts reçus par le joueur)', hpAfter < hpBefore, `hp ${hpBefore} → ${hpAfter}`);
  check('T19.2 event damage émis par le gardien sur le player', evs.some((e) => e.event === 'damage' && e.entity === 'player' && e.other === g3.id), JSON.stringify(evs.filter((e) => e.event === 'damage' && e.entity === 'player').slice(-5)));
  check('T21.1 le joueur peut subir des dégâts (PV < 100)', hpAfter < 100, `hp=${hpAfter}`);

  // T20 — les 3 ennemis initiaux sont tués par le joueur (4 tirs chacun, visée fraîche)
  await dbg('teleportPlayer(0, 1, -20)');
  await step(1);
  const initialIds = (await state()).enemies.map((e) => e.id);
  for (let i = 0; i < initialIds.length; i++) {
    const id = initialIds[i];
    let shots = 0;
    for (let k = 0; k < 8; k++) {
      const g = (await state()).enemies.find((e) => e.id === id);
      if (!g) break;
      const p = g.pos ?? (await guardianPos(id));
      if (!p) break;
      await dbg(`aimAt(${p[0]}, ${p[1] + 0.4}, ${p[2]})`);
      const r = await dbg('gameFire()');
      shots++;
      if (typeof r !== 'string' || !r.startsWith('hit:')) console.log(`    (tir ${shots}: ${r})`);
      await step(1);
    }
    await step(1);
    const gone = !(await state()).enemies.some((e) => e.id === id);
    check(`T20.${i + 1} ennemi initial #${i + 1} tué par le joueur (${shots} tirs)`, gone, `id=${id} shots=${shots}`);
  }
  evs = await events();
  const killed = evs.filter((e) => e.event === 'enemy.killed');
  check('T20.4 3 events enemy.killed émis', killed.length === 3, `n=${killed.length}`);
  check('T20.5 tirs qui ont touché (damage other=player sur gardiens)', evs.filter((e) => e.event === 'damage' && e.other === 'player' && e.entity !== 'player').length >= 12, `n=${evs.filter((e) => e.event === 'damage' && e.other === 'player' && e.entity !== 'player').length}`);

  // T4 — le réacteur ne démarre rien AVANT les 3 relais
  await dbg('teleportPlayer(3, 1, 0)');
  await step(30);
  evs = await events();
  check('T4.1 zone réacteur: zone.enter détecté', evs.some((e) => e.event === 'zone.enter' && e.other === 'reactor'), JSON.stringify(evs.filter((e) => e.event.startsWith('zone'))));
  s = await state();
  check('T4.2 aucune séquence avant les 3 relais', s.reactor.started === false && s.reactor.progress === 0 && s.reactor.online === false, JSON.stringify(s.reactor));
  check('T4.3 aucun event reactor.* avant les relais', !evs.some((e) => e.event.startsWith('reactor.')), '');
  await dbg('teleportPlayer(0, 1, -20)');
  await step(5);

  // T5/T6/T7 — activation des relais en ORDRE LIBRE: C → A → B
  await dbg('teleportPlayer(0, 1, 13.5)');
  await dbg('gameInteract()');
  await step(1);
  evs = await events(); s = await state();
  const actC = evs.filter((e) => e.event === 'relay.activated');
  check('T5.1 relais C activé (proxi + interaction)', actC.length === 1 && actC[0].entity === relayOf.C && s.relays.find((r) => r.label === 'C').active, JSON.stringify(actC));
  check('T5.2 compteur 1/3', s.relayCount === 1, `n=${s.relayCount}`);

  await dbg('teleportPlayer(-16, 1, -9.5)');
  await dbg('gameInteract()');
  await step(1);
  evs = await events(); s = await state();
  check('T6.1 relais A activé', evs.filter((e) => e.event === 'relay.activated').length === 2 && s.relays.find((r) => r.label === 'A').active, '');
  check('T6.2 compteur 2/3', s.relayCount === 2, `n=${s.relayCount}`);

  await dbg('teleportPlayer(16, 1, -9.5)');
  await dbg('gameInteract()');
  await step(1);
  evs = await events(); s = await state();
  check('T7.1 relais B activé', evs.filter((e) => e.event === 'relay.activated').length === 3 && s.relays.find((r) => r.label === 'B').active, '');

  // T8 — ordre libre réellement accepté (C avant A avant B)
  const order = evs.filter((e) => e.event === 'relay.activated').map((e) => s.relays.find((r) => r.id === e.entity)?.label);
  check('T8.1 ordre libre C→A→B accepté (pas de séquence imposée)', JSON.stringify(order) === JSON.stringify(['C', 'A', 'B']), JSON.stringify(order));
  // T9 — compteur 3/3
  check('T9.1 compteur 3/3 + relaysDone', s.relayCount === 3 && s.relaysDone === true, `n=${s.relayCount}`);
  await dbg('setPlayerHealth(100)');

  // T10 — entrée dans la zone → la séquence démarre
  await dbg('teleportPlayer(3, 1, 0)');
  await step(1);
  s = await state(); evs = await events();
  check('T10.1 entrée zone → séquence démarrée', s.reactor.started === true && s.reactor.inZone === true, JSON.stringify(s.reactor));
  const startEv = evs.find((e) => e.event === 'reactor.start');
  check('T10.2 event reactor.start émis', !!startEv, JSON.stringify(evs.filter((e) => e.event.startsWith('reactor'))));
  check('T10.3 progression 0 au démarrage', s.reactor.progress === 0, `progress=${s.reactor.progress}`);

  // T11 — les 2 renforts apparaissent exactement une fois
  await step(5);
  s = await state(); evs = await events();
  const reinEv = evs.filter((e) => e.event === 'reactor.reinforcements');
  check('T11.1 renforts spawnés (2 gardiens)', s.reinforcements.spawned === true && s.reinforcements.count === 2, JSON.stringify(s.reinforcements));
  check('T11.2 exactement 1 event reactor.reinforcements', reinEv.length === 1, `n=${reinEv.length}`);
  check('T11.3 2 gardiens vivants (3 initiaux tués)', s.enemies.length === 2, `n=${s.enemies.length}`);
  check('T11.4 progression = 5 (5 ticks de présence, pas au tick d\'enter)', s.reactor.progress === 5, `progress=${s.reactor.progress}`);

  // T12 — la progression augmente pendant la présence
  await step(60);
  s = await state();
  check('T12.1 progression = 65 après 60 ticks de présence (5 + 60)', s.reactor.progress === 65, `progress=${s.reactor.progress}`);

  // T13 — la sortie interrompt la progression
  await dbg('teleportPlayer(0, 1, -20)');
  await step(1);
  s = await state(); evs = await events();
  const intEv = evs.filter((e) => e.event === 'reactor.interrupt');
  check('T13.1 event reactor.interrupt à la sortie', intEv.length === 1, `n=${intEv.length}`);
  check('T13.2 progression conservée (65, non online)', s.reactor.progress === 65 && s.reactor.started === true && s.reactor.online === false, JSON.stringify(s.reactor));
  const fpInterruptProgress = s.reactor.progress;

  // T14 — la progression ne bouge plus hors zone
  const pFrozen = (await state()).reactor.progress;
  await step(30);
  s = await state();
  check('T14.1 progression immobile hors zone (30 ticks)', s.reactor.progress === pFrozen && pFrozen === 65, `progress=${s.reactor.progress}`);

  // T15 — le retour reprend depuis la valeur conservée
  await dbg('teleportPlayer(3, 1, 0)');
  await step(1);
  evs = await events();
  const resEv = evs.filter((e) => e.event === 'reactor.resume');
  check('T15.1 event reactor.resume au retour', resEv.length === 1, `n=${resEv.length}`);
  await step(30);
  s = await state();
  check('T15.2 reprise depuis la valeur conservée (65 + 30 = 95)', s.reactor.progress === 95, `progress=${s.reactor.progress}`);

  // T16 — la progression atteint 180 ticks
  await step(90);
  s = await state(); evs = await events();
  const onlineEv = evs.filter((e) => e.event === 'reactor.online');
  check('T16.1 progression = 180 ticks', s.reactor.progress === 180, `progress=${s.reactor.progress}`);
  check('T16.2 réacteur online (1 event reactor.online)', s.reactor.online === true && onlineEv.length === 1, `n=${onlineEv.length}`);

  // T17 — victoire
  const vicEv = evs.filter((e) => e.event === 'game.victory');
  check('T17.1 event game.victory émis (1×)', vicEv.length === 1, `n=${vicEv.length}`);
  check('T17.2 victoire: 3 relais, progress 180, joueur vivant', s.victory === true && s.reactor.online === true && s.reactor.progress === 180 && s.relayCount === 3 && s.playerDead === false, JSON.stringify({ v: s.victory, p: s.reactor.progress, r: s.relayCount }));
  const snapVic = await snap();
  check('T17.3 joueur vivant à la victoire', snapVic.player.alive === true, JSON.stringify(snapVic.player));
  const ov = await ev(`(() => ({ hidden: document.getElementById('overlay').classList.contains('hidden'), title: document.getElementById('overlay-title').textContent, sub: document.getElementById('overlay-sub').textContent }))()`);
  check('T17.4 overlay REACTOR ONLINE / MISSION COMPLETE', !ov.hidden && ov.title === 'REACTOR ONLINE' && ov.sub === 'MISSION COMPLETE', JSON.stringify(ov));

  // T22 — le joueur peut mourir (après la victoire) + état final cohérent
  await dbg('setPlayerHealth(1)');
  const fin = (await state()).enemies[0];
  const finPos = fin?.pos ?? (await guardianPos(fin.id));
  await dbg(`teleportPlayer(${finPos[0] + 1.5}, 1, ${finPos[2]})`);
  await step(90);
  evs = await events();
  const snapDead = await snap();
  check('T22.1 le joueur peut mourir (alive=false)', snapDead.player.alive === false, JSON.stringify(snapDead.player));
  check('T22.2 events player.died + game.over', evs.some((e) => e.event === 'player.died') && evs.some((e) => e.event === 'game.over'), '');
  s = await state();
  const counts = {};
  for (const e of evs) counts[e.event] = (counts[e.event] ?? 0) + 1;
  check('T23.1 état final cohérent (victoire acquise, séquences 1×, 3 kills)',
    s.victory === true && s.reactor.online === true && s.reactor.progress === 180 && s.relayCount === 3 &&
    s.playerDead === true && s.enemies.length === 2 &&
    counts['relay.activated'] === 3 && counts['reactor.start'] === 1 && counts['reactor.reinforcements'] === 1 &&
    counts['reactor.interrupt'] === 1 && counts['reactor.resume'] === 1 && counts['reactor.online'] === 1 &&
    counts['game.victory'] === 1 && counts['enemy.killed'] === 3,
    JSON.stringify({ counts, enemies: s.enemies.length, victory: s.victory }));
  check('T23.2 aucune exception JS', exceptions.length === 0, exceptions.join(' | '));
  check('T23.3 aucune console.error', consoleErrors.length === 0, consoleErrors.join(' | '));

  // ---------- fingerprint ----------
  const tickOf = (name) => evs.filter((e) => e.event === name).map((e) => e.tick);
  const labelOf = (id) => s.relays.find((r) => r.id === id)?.label ?? '?';
  const fp = {
    relays: evs.filter((e) => e.event === 'relay.activated').map((e) => `${labelOf(e.entity)}@${e.tick}`),
    reactorStartTick: tickOf('reactor.start')[0] ?? null,
    reinforcementsTick: tickOf('reactor.reinforcements')[0] ?? null,
    interruptProgress: fpInterruptProgress,
    resumeTick: tickOf('reactor.resume')[0] ?? null,
    reactorOnlineTick: tickOf('reactor.online')[0] ?? null,
    victoryTick: tickOf('game.victory')[0] ?? null,
    enemiesKilled: counts['enemy.killed'] ?? 0,
    playerDamageTaken: hpBefore - hpAfter,
    final: {
      relays: s.relayCount, progress: s.reactor.progress, victory: s.victory,
      playerDead: s.playerDead, guardiansAlive: s.enemies.length,
      playerHealth: hpv(snapDead.player.health), playerPos: snapDead.player.pos,
    },
  };
  console.log('FINGERPRINT ' + JSON.stringify(fp));

  console.log(`BILAN: ${passed}/${passed + failed} tests passés`);
  if (failed) console.log('ECHECS: ' + fails.join(' ; '));
  clearTimeout(globalTimer);
  ws.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FATALE: ' + e.message); process.exit(2); });
