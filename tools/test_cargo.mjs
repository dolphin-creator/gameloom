// Harness Game #7 — CARGO RUN (pattern §15 : CDP 9224, pause/step, URL_TARGET, BILAN)
// Vérifie la boucle complète VOIR→RAMASSER→TRANSPORTER→DÉPOSER→ALIMENTER→SORTIR,
// puis émet un FINGERPRINT de ticks pour la comparaison de déterminisme (5 runs).
// Préréquis : vite preview (4173) + Chrome headless CDP (9224) — ou lancer via
// `node tools/run_harnesses.mjs test_cargo [--repeat N]`.
import { createRequire } from 'node:module';
const require = createRequire('C:/Users/jonat/gameloom/package.json');
const WebSocket = require('ws');

const CDP = 'http://127.0.0.1:9224';
const URL_TARGET = process.env.URL_TARGET ?? 'http://localhost:4173/cargo.html';

let msgId = 0;
const consoleErrors = [];

function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

async function main() {
  let r = await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' });
  if (!r.ok) r = await fetch(`${CDP}/json/new?about:blank`);
  const target = await r.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++msgId;
    const onMsg = (data) => {
      const m = JSON.parse(data.toString());
      if (m.id !== id) return;
      ws.off('message', onMsg);
      if (m.error) reject(new Error(`${method}: ${m.error.message}`));
      else resolve(m.result);
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }).then((res) => {
    if (res.exceptionDetails) throw new Error('PAGE EXC: ' + JSON.stringify(res.exceptionDetails).slice(0, 600));
    return res.result.value;
  });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (data) => {
    const m = JSON.parse(data.toString());
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    if (m.method === 'Runtime.exceptionThrown')
      consoleErrors.push('EXC: ' + (m.params.exceptionDetails.exception?.description ?? JSON.stringify(m.params.exceptionDetails).slice(0, 300)));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable').catch(() => {});
  await send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {});

  const results = [];
  const check = (name, cond, extra = '') => {
    const ok = !!cond;
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  };
  const st = () => ev('window.GameLoom._debug.cargoState()');
  const hasEvent = (name) => ev(`window.GameLoom.events(2000).some(e => e.event === "${name}")`);
  const hud = (id) => ev(`document.getElementById("${id}").textContent`);
  const tck = (name) => ev(`(() => { const e = window.GameLoom.events(2000).find(e => e.event === "${name}"); return e ? e.tick : null; })()`);

  // ---------- chargement ----------
  await send('Page.navigate', { url: URL_TARGET });
  const t0 = Date.now();
  let booted = false;
  while (Date.now() - t0 < 90000) {
    if (await ev('typeof window.GameLoom') === 'object') { booted = true; break; }
    await new Promise((r2) => setTimeout(r2, 400));
  }
  check('T1 chargement: window.GameLoom', booted);
  if (!booted) { console.log('BILAN: 0/1 tests passés'); process.exit(1); }
  check('T1 chargement: version 0.2.0', await ev('window.GameLoom.version') === '0.2.0', String(await ev('window.GameLoom.version')));
  await ev('window.GameLoom.pause()');

  // ---------- état initial ----------
  let s = await st();
  check('T2 état initial: tick 0', s.tick === 0, `tick=${s.tick}`);
  check('T2 état initial: power 0', s.power === 0);
  check('T2 état initial: porte fermée', s.doorOpen === false);
  check('T2 état initial: pas de victoire', s.victory === false);
  check('T2 3 cellules au bon endroit', JSON.stringify(s.cells.A.pos) === '[-6.5,0,3.5]' && JSON.stringify(s.cells.B.pos) === '[2.5,0,-5.5]' && JSON.stringify(s.cells.C.pos) === '[6.5,0,4.5]');
  check('T3 HUD POWER 0/3', (await hud('hud-power')) === 'POWER: 0/3', await hud('hud-power'));
  check('T4 HUD CARGO NONE', (await hud('hud-cargo')) === 'CARGO: NONE', await hud('hud-cargo'));
  check('T4b HUD contrôles affichés', (await ev('document.getElementById("hud-controls").textContent')).includes('Q: abandonner'));
  check('T2b 3 sockets spawnés', await ev('window.GameLoom.entities({ tag: "socket" }).length') === 3);

  // ---------- pickup A ----------
  await ev('window.GameLoom._debug.teleportPlayer(-6.5, 0, 2.2); window.GameLoom._debug.cargoInteract()');
  s = await st();
  check('T5 pickup A: cargo A', s.cargo === 'A', JSON.stringify(s.cargo));
  check('T5 pickup A: état carried', s.cells.A.state === 'carried');
  check('T5 pickup A: event cargo.pickup', await hasEvent('cargo.pickup'));

  // ---------- une seule cellule à la fois ----------
  await ev('window.GameLoom._debug.teleportPlayer(2.5, 0, -4.0); window.GameLoom._debug.cargoInteract()');
  s = await st();
  check('T6 portant A: pickup B impossible', s.cargo === 'A' && s.cells.B.state === 'world', JSON.stringify({ cargo: s.cargo, B: s.cells.B.state }));

  // ---------- représentation de la cellule portée (distance calculée côté Node) ----------
  await ev('window.GameLoom.step(30)');
  const carry = await ev('({ p: window.GameLoom.snapshot().player.pos, look: window.GameLoom._debug.look(), a: window.GameLoom._debug.cargoState().cells.A.pos })');
  const carryD = Number.isFinite(carry.p?.[0]) && Number.isFinite(carry.p?.[2]) && Number.isFinite(carry.look?.yaw) && Number.isFinite(carry.a?.[0]) && Number.isFinite(carry.a?.[2])
    ? Math.hypot(carry.a[0] - (carry.p[0] + Math.sin(carry.look.yaw)), carry.a[2] - (carry.p[2] + Math.cos(carry.look.yaw)))
    : NaN;
  check('T7 A portée suit le joueur (d < 0.05, finie)', Number.isFinite(carryD) && carryD < 0.05, `d=${carryD ?? 'NaN'}`);
  check('T7 A portée à la hauteur portage (y ≈ 0.35)', Number.isFinite(carry.a?.[1]) && Math.abs(carry.a[1] - 0.35) < 0.02, `y=${carry.a?.[1]}`);

  // ---------- mauvais socket refuse ----------
  await ev('window.GameLoom._debug.teleportPlayer(0, 0, -5.6); window.GameLoom._debug.cargoInteract()');
  s = await st();
  check('T8 A→socketB: refusé (power 0)', s.power === 0);
  check('T8 A→socketB: event cargo.reject', await hasEvent('cargo.reject'));
  check('T9 A toujours portée après refus', s.cargo === 'A' && s.cells.A.state === 'carried');

  // ---------- drop libre ----------
  await ev('window.GameLoom._debug.cargoDrop()');
  s = await st();
  check('T10 drop libre A: cargo NONE', s.cargo === 'NONE');
  check('T10 drop libre A: event cargo.drop', await hasEvent('cargo.drop'));
  const pDrop = await ev('window.GameLoom.snapshot().player.pos');
  check('T11 A redevient disponible (world, au sol, proche)', s.cells.A.state === 'world' && s.cells.A.pos[1] < 0.15 && Math.hypot(s.cells.A.pos[0] - pDrop[0], s.cells.A.pos[2] - pDrop[2]) < 1.5, JSON.stringify(s.cells.A.pos));

  // ---------- re-pickup ----------
  await ev('window.GameLoom._debug.cargoInteract()');
  s = await st();
  check('T12 re-pickup A: cargo A carried', s.cargo === 'A' && s.cells.A.state === 'carried');

  // ---------- installation A ----------
  await ev('window.GameLoom._debug.teleportPlayer(-4, 0, -5.8); window.GameLoom._debug.cargoInteract()');
  s = await st();
  check('T13 installation A: event cargo.install', await hasEvent('cargo.install'));
  check('T13 installation A: état installed + socket alimenté', s.cells.A.state === 'installed' && s.sockets.A === true);
  check('T14 POWER 1/3 (état + HUD)', s.power === 1 && (await hud('hud-power')) === 'POWER: 1/3');

  // ---------- installation B ----------
  await ev('window.GameLoom._debug.teleportPlayer(2.5, 0, -4.0); window.GameLoom._debug.cargoInteract()');
  s = await st();
  check('T15 pickup B', s.cargo === 'B');
  await ev('window.GameLoom._debug.teleportPlayer(0, 0, -5.6); window.GameLoom._debug.cargoInteract()');
  s = await st();
  check('T16 installation B: POWER 2/3', s.power === 2 && s.sockets.B === true && s.cells.B.state === 'installed', `power=${s.power}`);
  check('T16b HUD POWER 2/3', (await hud('hud-power')) === 'POWER: 2/3');

  // ---------- porte fermée à 2/3 ----------
  check('T17 porte fermée à 2/3', s.doorOpen === false);
  await ev('window.GameLoom._debug.teleportPlayer(12, 0, 0); window.GameLoom.step(5)');
  s = await st();
  check('T17b zone de sortie seule ne suffit pas (pas de victoire)', s.victory === false);
  await ev('window.GameLoom._debug.setLook(-Math.PI/2, 0); window.GameLoom._debug.teleportPlayer(9.0, 0, 0); window.GameLoom._debug.input({ move: [1, 0] })');
  await ev('window.GameLoom.step(30)');
  const xBlocked = await ev('window.GameLoom.snapshot().player.pos[0]');
  await ev('window.GameLoom._debug.input({ move: [0, 0] })');
  check('T17c porte fermée bloque réellement (x < 10.2)', Number.isFinite(xBlocked) && xBlocked < 10.2, `x=${Number(xBlocked).toFixed(2)}`);

  // ---------- installation C ----------
  await ev('window.GameLoom._debug.teleportPlayer(6.5, 0, 3.0); window.GameLoom._debug.cargoInteract()');
  s = await st();
  check('T18 pickup C', s.cargo === 'C');
  await ev('window.GameLoom._debug.teleportPlayer(4, 0, -5.6); window.GameLoom._debug.cargoInteract()');
  s = await st();
  check('T19 installation C: POWER 3/3 (état + HUD)', s.power === 3 && s.sockets.C === true && (await hud('hud-power')) === 'POWER: 3/3', `power=${s.power}`);

  // ---------- alimentation complète ----------
  const tickPower = await tck('power.complete');
  check('T20 événement power.complete émis', Number.isFinite(tickPower), `tick=${tickPower}`);
  const tickDoor = await tck('door.opened');
  s = await st();
  check('T21 porte réellement ouverte (event + état)', Number.isFinite(tickDoor) && s.doorOpen === true, `tick=${tickDoor}`);

  // ---------- passage + sortie ----------
  await ev('window.GameLoom._debug.setLook(-Math.PI/2, 0); window.GameLoom._debug.teleportPlayer(9.0, 0, 0); window.GameLoom._debug.input({ move: [1, 0] })');
  await ev('window.GameLoom.step(30)');
  const xPass = await ev('window.GameLoom.snapshot().player.pos[0]');
  await ev('window.GameLoom._debug.input({ move: [0, 0] })');
  check('T22 passage par la porte possible (x > 10.5)', Number.isFinite(xPass) && xPass > 10.5, `x=${Number(xPass).toFixed(2)}`);
  await ev('window.GameLoom.step(10)');
  s = await st();
  const tickExit = await tck('zone.enter');
  check('T23 entrée dans la zone de sortie (zone.enter @exit)', Number.isFinite(tickExit), `tick=${tickExit}`);
  const tickVictory = await tck('game.victory');
  check('T24 victoire: état + event + overlay', s.victory === true && Number.isFinite(tickVictory) && (await ev('document.getElementById("overlay").style.display')) === 'flex', `tick=${tickVictory}`);
  check('T24b HUD final POWER 3/3 + CARGO NONE', (await hud('hud-power')) === 'POWER: 3/3' && (await hud('hud-cargo')) === 'CARGO: NONE');

  // ---------- état final cohérent ----------
  check('T25 état final: 3 cells installed + sockets true', s.cells.A.state === 'installed' && s.cells.B.state === 'installed' && s.cells.C.state === 'installed' && s.sockets.A && s.sockets.B && s.sockets.C);
  check('T25b état final: porte ouverte, power 3, cargo NONE', s.doorOpen === true && s.power === 3 && s.cargo === 'NONE');

  // ---------- console ----------
  check('T26 aucun console.error/exception inattendu', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  // ---------- fingerprint de ticks ----------
  const evts = await ev('window.GameLoom.events(2000)');
  const GAME_EVENTS = new Set(['cargo.pickup', 'cargo.drop', 'cargo.reject', 'cargo.install', 'socket.powered', 'power.complete', 'door.opened', 'zone.enter', 'game.victory']);
  const seq = evts
    .filter((e) => GAME_EVENTS.has(e.event) && (e.event !== 'zone.enter' || e.other === 'exit'))
    .map((e) => `${e.event}@${e.tick}`);
  const fin = await st();
  const pfin = await ev('window.GameLoom.snapshot().player.pos');
  const r2 = (v) => Math.round(v * 100) / 100;
  const fpInput = {
    seq,
    power: fin.power, cargo: fin.cargo, doorOpen: fin.doorOpen, victory: fin.victory,
    sockets: fin.sockets,
    cells: { A: fin.cells.A.state, B: fin.cells.B.state, C: fin.cells.C.state },
    pos: { A: fin.cells.A.pos.map(r2), B: fin.cells.B.pos.map(r2), C: fin.cells.C.pos.map(r2) },
    player: pfin.map(r2),
  };
  const fingerprint = djb2(JSON.stringify(fpInput));
  console.log(`FINGERPRINT: ${fingerprint}`);
  console.log(`FINGERPRINT_INPUT: ${JSON.stringify(fpInput)}`);

  const n = results.filter((r3) => r3.ok).length;
  console.log(`BILAN: ${n}/${results.length} tests passés`);
  ws.close();
  process.exit(n === results.length ? 0 : 1);
}
main().catch((e) => { console.error('FATALE:', e.message); process.exit(2); });
