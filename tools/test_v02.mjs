// GameLoom v0.2 — tests ciblés des primitives core (movement + zones) via CDP (port 9224)
// Même pattern que les harness #1–#5: page v02_test.html, pause()/step(n) déterministes.
// 28 checks: M1–M13 (movement), Z14–Z28 (zones). BILAN n/n + exit code.
import WebSocket from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const CDP_HTTP = 'http://localhost:9224';
const URL_TARGET = process.env.URL_TARGET ?? 'http://localhost:4173/v02_test.html';
const T0 = Date.now();
const ts = () => `+${((Date.now() - T0) / 1000).toFixed(1)}s`;
void dirname(fileURLToPath(import.meta.url));

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
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

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

  const V = {
    spawn: (asset, x, y, z, tags, body, big) => {
      const args = [JSON.stringify(asset), String(x), String(y), String(z), JSON.stringify(tags)];
      if (body !== undefined) args.push(JSON.stringify(body));
      else if (big) args.push('undefined');
      if (big) args.push('true');
      return cdp.eval(`GameLoom._debug.v02.spawn(${args.join(', ')})`);
    },
    move: (id, tx, tz, speed, face, avoid) => cdp.eval(`GameLoom._debug.v02.move(${JSON.stringify(id)}, ${tx}, ${tz}, ${speed}${face !== undefined ? `, ${face}` : ''}${avoid !== undefined ? `, ${avoid}` : ''})`),
    face: (id, tx, tz) => cdp.eval(`GameLoom._debug.v02.face(${JSON.stringify(id)}, ${tx}, ${tz})`),
    pos: (id) => cdp.eval(`GameLoom._debug.v02.pos(${JSON.stringify(id)})`),
    yaw: (id) => cdp.eval(`GameLoom._debug.v02.yaw(${JSON.stringify(id)})`),
    zone: (id, minX, minZ, maxX, maxZ, tags) => cdp.eval(`GameLoom._debug.v02.zone(${JSON.stringify(id)}, ${minX}, ${minZ}, ${maxX}, ${maxZ}, ${JSON.stringify(tags)})`),
    zoneDestroy: (id) => cdp.eval(`GameLoom._debug.v02.zoneDestroy(${JSON.stringify(id)})`),
    zoneInside: (id, eid) => cdp.eval(`GameLoom._debug.v02.zoneInside(${JSON.stringify(id)}, ${JSON.stringify(eid)})`),
    zones: () => cdp.eval('GameLoom._debug.v02.zones()'),
    state: () => cdp.eval('GameLoom._debug.v02.state()'),
    events: (n) => cdp.eval(`GameLoom.events(${n ?? 300})`),
    stats: () => cdp.eval('GameLoom.stats()'),
    pause: () => cdp.eval('GameLoom.pause()'),
    step: (n) => cdp.eval(`GameLoom.step(${n})`),
    teleportPlayer: (x, y, z) => cdp.eval(`GameLoom._debug.teleportPlayer(${x}, ${y}, ${z})`),
    remove: (id) => cdp.eval(`GameLoom._debug.remove(${JSON.stringify(id)})`),
  };
  const zoneEv = (zone, ev) => (s) => s.zoneEvents.filter((e) => e.event === (ev ?? 'zone.enter') && e.other === zone);
  const stayEv = (zone, eid) => (s) => s.stayLog.filter((e) => e.zone === zone && e.entity === eid).length;

  await cdp.send('Page.navigate', { url: URL_TARGET });
  let ready = false;
  for (let i = 0; i < 90 && !ready; i++) {
    await sleep(400);
    try { ready = await cdp.eval('typeof window.GameLoom === "object"'); } catch { }
  }
  check('boot: page v02_test exposée (GameLoom + _debug.v02)', ready && (await cdp.eval('typeof GameLoom._debug.v02 === "object"')));
  if (!ready) { console.log('CONSOLE:', JSON.stringify(cdp.consoleLogs.slice(-15), null, 1)); process.exit(1); }
  await sleep(800); // réseau seulement

  await V.pause();
  await V.step(1); // un tick de référence (tick=1)

  // ================= MOVEMENT =================
  const m1 = await V.spawn('assets/guardian.glb', 0, 0, 0, ['m1']);
  const p1 = await V.pos(m1);
  check('M1 entityPosition: position exacte au spawn', p1 && near(p1[0], 0) && near(p1[1], 0) && near(p1[2], 0), p1);
  const pNone = await V.pos('nexiste_pas');
  check('M2 entityPosition: id inconnu → null', pNone === null, pNone);

  const r3 = await V.move(m1, 10, 0, 3);
  const p3 = await V.pos(m1);
  check('M3 déplacement = speed*FIXED_DT (3/60 = 0.05 m, 1 appel)', r3 === true && near(p3[0], 3 / 60, 1e-9) && near(p3[2], 0, 1e-9), { r3, x: p3?.[0] });

  const m4 = await V.spawn('assets/guardian.glb', 0, 0, 0, ['m4']);
  const r4a = await V.move(m4, 0.03, 0, 3);
  const p4 = await V.pos(m4);
  const r4b = await V.move(m4, 0.03, 0, 3);
  check('M4 clamp à la destination (0.03 m < pas 0.05) puis false si déjà sur place', r4a === true && near(p4[0], 0.03, 1e-9) && r4b === false, { r4a, x: p4?.[0], r4b });

  const m5 = await V.spawn('assets/guardian.glb', 0, 0.7, 0, ['m5']);
  await V.move(m5, 1, 0, 3);
  const p5 = await V.pos(m5);
  check('M5 Y conservé (0.7, tolérance f32 Rapier)', near(p5[1], 0.7, 1e-6), p5);

  const m6 = await V.spawn('assets/survivor.glb', 0, 0, 0, ['m6']);
  await V.move(m6, 1, 0, 3);
  await V.step(1); // sync mesh
  const y6 = await V.yaw(m6);
  check('M6 face default true: yaw ≈ -π/2 après déplacement +X', y6 !== null && near(y6, -Math.PI / 2, 1e-6), y6);

  const m7 = await V.spawn('assets/survivor.glb', 0, 0, 20, ['m7']);
  await V.move(m7, 1, 20, 3, false);
  await V.step(1);
  const y7 = await V.yaw(m7);
  const p7 = await V.pos(m7);
  check('M7 face:false: déplacement sans rotation (yaw ≈ 0, x déplacé)', y7 !== null && near(y7, 0, 1e-6) && p7[0] > 0.04, { y7, x: p7?.[0] });

  const m8 = await V.spawn('assets/survivor.glb', 0, 0, 0, ['m8']);
  const p8a = await V.pos(m8);
  await V.face(m8, 0, 1);
  await V.step(1);
  const y8 = await V.yaw(m8);
  const p8b = await V.pos(m8);
  check('M8 faceEntity: rotation vers +Z (cos(yaw) ≈ -1, yaw ±π équivalents) sans translation', y8 !== null && near(Math.cos(y8), -1, 1e-6) && near(p8b[0], p8a[0]) && near(p8b[2], p8a[2]), { y8, pos: p8b });

  const m9s = await V.spawn('assets/crate.glb', 0, 0, -30, ['m9'], 'static');
  const m9d = await V.spawn('assets/crate.glb', 0, 0, -40, ['m9'], 'dynamic');
  const r9s = await V.move(m9s, 5, -30, 3);
  const r9d = await V.move(m9d, 5, -40, 3);
  const p9s = await V.pos(m9s);
  check('M9 body non kinematic (static + dynamic) → refus (false, immobile)', r9s === false && r9d === false && near(p9s[0], 0), { r9s, r9d });

  const pP0 = await cdp.eval(`JSON.parse(JSON.stringify(GameLoom.snapshot().player.pos))`);
  const r10 = await V.move('player', 10, 0, 3);
  const pP1 = await cdp.eval(`JSON.parse(JSON.stringify(GameLoom.snapshot().player.pos))`);
  check('M10 player → refus (false, joueur non déplaçable: position inchangée)', r10 === false && near(pP1[0], pP0[0]) && near(pP1[2], pP0[2]), { r10, p0: pP0, p1: pP1 });

  const m11 = await V.spawn('assets/guardian.glb', 0, 0, 0, ['m11']);
  for (let i = 0; i < 300; i++) await V.move(m11, 10, 0, 3);
  const p11 = await V.pos(m11);
  const r11b = await V.move(m11, 10, 0, 3);
  check('M11 avoidObstacles:false: traverse le mur (x ≈ 10 après 300 pas)', near(p11[0], 10, 1e-9) && r11b === false, { x: p11?.[0] });

  const m12a = await V.spawn('assets/guardian.glb', 0, 0, -2.5, ['m12a']);
  for (let i = 0; i < 300; i++) await V.move(m12a, 10, -2.5, 3, true, true);
  const p12a = await V.pos(m12a);
  check('M12a avoidObstacles @ 3 m/s: verrou inactif à vitesse normale (port fidèle #3–#5, trajet normal jusqu’au target)', near(p12a[0], 10, 1e-9), { x: p12a?.[0] });

  const m12b = await V.spawn('assets/guardian.glb', 0, 0, 2.5, ['m12b']);
  const seq12 = [];
  for (let i = 0; i < 9; i++) { await V.move(m12b, 10, 2.5, 100, true, true); seq12.push((await V.pos(m12b))[0]); }
  check('M12b avoidObstacles @ 100 m/s: clamp — 1er point ≥ 3,9 = 4,0 (à 0,5 m de l’arête du mur) puis rampe 0,4 m/pas dans l’obstacle',
    near(seq12[2], 4.0, 1e-6) && near(seq12[3], 4.4, 1e-6) && near(seq12[4], 4.8, 1e-6) && near(seq12[8], 10, 1e-9),
    seq12.map((x) => +x.toFixed(4)));

  const m13 = await V.spawn('assets/survivor.glb', 0, 0, 10, ['m13'], undefined, true);
  for (let i = 0; i < 300; i++) await V.move(m13, 10, 10, 3, true, true);
  const p13 = await V.pos(m13);
  check('M13 collider propre exclu (pas de TOI=0 sur soi): parcourt 10 m malgré son gros collider', p13[0] > 9.9, { x: +p13[0].toFixed(4) });

  const moveErrs = cdp.errors.filter((e) => e.includes('moveEntity/faceEntity')).length;
  check('M9/M10: erreurs signalées via console.error (≥ 3: static, dynamic, player)', moveErrs >= 3, moveErrs);

  // ================= ZONES =================
  // Z14–Z18: zone z14 (feu-like) + entité z14e
  await V.zone('z14', 1, -2, 5, 2, ['z14e']);
  const z14 = await V.spawn('assets/survivor.glb', 0, 0, 0, ['z14e']);
  await V.step(1);
  const s14 = await V.state();
  check('Z14 outside → aucune transition', zoneEv('z14')({ zoneEvents: s14.zoneEvents }).length === 0 && (await V.zoneInside('z14', z14)) === false);

  await V.move(z14, 3, 0, 100);
  await V.move(z14, 3, 0, 100);
  await V.step(1);
  const s15a = await V.state();
  const e15 = zoneEv('z14')({ zoneEvents: s15a.zoneEvents }).length;
  await V.step(5);
  const s15b = await V.state();
  const e15b = zoneEv('z14')({ zoneEvents: s15b.zoneEvents }).length;
  check('Z15 enter exactement une fois (et pas de spam sur 5 ticks de stay)', e15 === 1 && e15b === 1, { e15, e15b });
  const stay17 = stayEv('z14', z14)({ stayLog: s15b.stayLog });
  check('Z17 onStay: exactement 5 appels sur 5 ticks inside (pas sur le tick d’enter)', stay17 === 5, stay17);

  await V.move(z14, 6, 0, 100);
  await V.move(z14, 6, 0, 100);
  await V.step(1);
  const s18a = await V.state();
  const x18 = s18a.zoneEvents.filter((e) => e.event === 'zone.exit' && e.other === 'z14').length;
  await V.step(3);
  const s18b = await V.state();
  const x18b = s18b.zoneEvents.filter((e) => e.event === 'zone.exit' && e.other === 'z14').length;
  check('Z18 exit exactement une fois, puis stable (inside vidé)', x18 === 1 && x18b === 1 && (await V.zoneInside('z14', z14)) === false, { x18, x18b });

  // Z19–Z20: UNION + déduplication (zone z19, deux entités)
  await V.zone('z19', 0, 0, 2, 2, ['z19a', 'z19b']);
  const z19a = await V.spawn('assets/survivor.glb', 1, 0, 1, ['z19b']);
  const z19b = await V.spawn('assets/survivor.glb', 1.2, 0, 1.2, ['z19a', 'z19b']);
  await V.step(1);
  const s19 = await V.state();
  const evA = s19.zoneEvents.filter((e) => e.event === 'zone.enter' && e.other === 'z19' && e.entity === z19a).length;
  const evB = s19.zoneEvents.filter((e) => e.event === 'zone.enter' && e.other === 'z19' && e.entity === z19b).length;
  check('Z19 UNION: entité taggée z19b observée (1 enter)', evA === 1, evA);
  check('Z20 déduplication: entité avec les 2 tags → 1 enter unique (pas 2)', evB === 1, evB);

  // Z21: player observable via tag 'player'
  await V.zone('z21', 1, -2, 5, 2, ['player']);
  await V.teleportPlayer(3, 0.92, 0);
  await V.step(1);
  const s21 = await V.state();
  const ev21 = s21.zoneEvents.filter((e) => e.event === 'zone.enter' && e.other === 'z21' && e.entity === 'player').length;
  check('Z21 player observable (tag player) → zone.enter entity=player', ev21 === 1, ev21);
  await V.teleportPlayer(0, 0.92, 0);
  await V.step(1);

  // Z22–Z24: spawn après zone, destruction, destroy()
  await V.zone('z22', 8, 8, 12, 12, ['z22']);
  const z22 = await V.spawn('assets/survivor.glb', 10, 0, 10, ['z22']);
  await V.step(1);
  const s22 = await V.state();
  check('Z22 entité spawnée APRÈS createZone détectée (enter au 1er tick)', s22.zoneEvents.some((e) => e.event === 'zone.enter' && e.other === 'z22' && e.entity === z22));

  const xBefore23 = s22.zoneEvents.filter((e) => e.event === 'zone.exit' && e.other === 'z22').length;
  await V.remove(z22);
  await V.step(2);
  const s23 = await V.state();
  const xAfter23 = s23.zoneEvents.filter((e) => e.event === 'zone.exit' && e.other === 'z22').length;
  const z22inside = (await V.zones()).find((z) => z.id === 'z22')?.inside ?? 'ABSENT';
  check('Z23 entité détruite purgée SILENCIEUSEMENT (pas de zone.exit synthétique, inside vidé)',
    xBefore23 === 0 && xAfter23 === 0 && (Array.isArray(z22inside) ? z22inside.length === 0 : z22inside === 'ABSENT'), { xAfter23, z22inside });

  await V.zone('z24', 1, -2, 5, 2, ['z24']);
  const z24 = await V.spawn('assets/survivor.glb', 3, 0, 0, ['z24']);
  await V.step(1);
  const s24a = await V.state();
  const in24a = (await V.zoneInside('z24', z24));
  await V.zoneDestroy('z24');
  await V.move(z24, 8, 0, 100);
  await V.step(1);
  await V.move(z24, 3, 0, 100);
  await V.move(z24, 3, 0, 100);
  await V.step(2);
  const s24b = await V.state();
  const ev24b = s24b.zoneEvents.filter((e) => e.other === 'z24').length;
  const z24list = (await V.zones()).some((z) => z.id === 'z24');
  check('Z24 destroy(): zone inactive + purge (0 event après, plus listée)', in24a === true && ev24b === 1 && z24list === false, { in24a, ev24b, z24list });

  // Z25: min/max inversés → normalisés
  await V.zone('z25', 5, 2, 1, -2, ['z25']);
  const z25list = (await V.zones()).find((z) => z.id === 'z25');
  const z25e = await V.spawn('assets/survivor.glb', 3, 0, 0, ['z25']);
  await V.step(1);
  const s25 = await V.state();
  check('Z25 bornes inversées normalisées (x1=1,x2=5,z1=-2,z2=2) + enter',
    z25list && near(z25list.x1, 1) && near(z25list.x2, 5) && near(z25list.z1, -2) && near(z25list.z2, 2)
    && s25.zoneEvents.some((e) => e.event === 'zone.enter' && e.other === 'z25' && e.entity === z25e),
    z25list);

  // Z26: isInside + bornes INCLUSIVES (spawn exactement sur la borne)
  await V.zone('z26', 1, -2, 5, 2, ['z26']);
  const z26in = await V.spawn('assets/survivor.glb', 1, 0, 0, ['z26']);
  const z26out = await V.spawn('assets/survivor.glb', 0.5, 0, 0, ['z26']);
  await V.step(1);
  const inIn = await V.zoneInside('z26', z26in);
  const inOut = await V.zoneInside('z26', z26out);
  check('Z26 isInside: borne inclusive (x=1.0 dedans) + x=0.5 dehors', inIn === true && inOut === false, { inIn, inOut });

  // Z27: payload des events (entity/other/data)
  const s27 = await V.state();
  const ev27 = s27.zoneEvents.find((e) => e.event === 'zone.enter' && e.entity === z26in);
  check('Z27 payload: entity=id entité, other=id zone, data={zone,x,z} exacts',
    !!ev27 && ev27.other === 'z26' && ev27.data && ev27.data.zone === 'z26' && near(ev27.data.x, 1, 1e-9) && near(ev27.data.z, 0, 1e-9),
    ev27);

  // Z28: déterminisme pause/step (tick exact du enter)
  await V.zone('z28', 6, 6, 8, 8, ['z28']);
  const z28 = await V.spawn('assets/survivor.glb', 0, 0, -20, ['z28']);
  const t28a = (await V.stats()).tick;
  await V.step(5);
  for (let i = 0; i < 30; i++) await V.move(z28, 7, 7, 100);
  const t28b = (await V.stats()).tick;
  await V.step(1);
  const ev28 = (await V.events(500)).find((e) => e.event === 'zone.enter' && e.entity === z28 && e.other === 'z28');
  check('Z28 déterminisme: enter au tick exact (convention bus: tick pré-incrément), pilote par step() seul', ev28 && ev28.tick === t28b && t28b === t28a + 5, { t28a, t28b, enterTick: ev28?.tick });

  // ---------- bilan ----------
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n=== BILAN: ${pass}/${results.length} tests passés ===`);
  cdp.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error('FATALE:', e.message);
  process.exit(2);
});
