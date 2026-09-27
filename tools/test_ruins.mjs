// Ruins Raid — testeur headless v1 via CDP (port 9224), même pattern que test_headless.mjs / test_temple.mjs
// 100% déterministe: pause()/step(n) pilotent le temps de jeu; le sleep ne sert qu'au boot/réseau.
// L'état du jeu est lu via GameLoom (JSON) + _debug.ruinsState() — pas de vision pour la logique.
// FINGERPRINT: valeurs exactes des ticks clés, à comparer entre runs (déterminisme).
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CDP_HTTP = 'http://localhost:9224';
const URL_TARGET = process.env.URL_TARGET ?? 'http://localhost:4173/ruins.html';
const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HARNESS_DIR, '..');
const SHOT_PATH = join(HARNESS_DIR, 'ruins_screenshot.png');
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
    state: () => cdp.eval('GameLoom._debug.ruinsState()'),
  };
  const hp = (p) => Number(String(p.health).split('/')[0]);   // p = snapshot().player
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

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

  // ---------- T1: entités essentielles présentes ----------
  const nGuard = await GL.entities({ tag: 'guardian' });
  const nArt = await GL.entities({ tag: 'artifact' });
  const nCol = await GL.entities({ tag: 'ruins_column' });
  const nCrate = await GL.entities({ tag: 'crate' });
  const s1 = await GL.stats();
  const gid = nGuard[0]?.id;
  check('T1 entités: joueur + 1 gardien + 1 artefact + 4 colonnes + 3 caisses (10 entités)',
    gid !== undefined && nArt.length === 1 && nCol.length === 4 && nCrate.length === 3 && s1.entities === 10,
    { guardian: gid, artifact: nArt.length, column: nCol.length, crate: nCrate.length, entities: s1.entities });

  // ---------- T2: pause + step déterministes ----------
  const tA = (await GL.snap()).tick;
  await sleep(700);
  const tB = (await GL.snap()).tick;
  check('T2 pause: tick figé pendant 700ms de temps réel', tA === tB, { tA, tB });
  await GL.step(1);
  const tC = (await GL.snap()).tick;
  await GL.step(10);
  const tD = (await GL.snap()).tick;
  check('T2 step(1) puis step(10): +1 puis +10 ticks exacts', tC === tA + 1 && tD === tC + 10, { tA, tC, tD });

  // ---------- T3: collisions joueur — bloqué par une colonne ----------
  // Colonne en (-4,-4): collider x ∈ [-4.575,-3.425]. Joueur approchant de l'OUEST
  // (depuis x=-7) est arrêté par la face ouest: x ≈ -4.575 - 0.45 (rayon KCC) = -5.03.
  await GL.dbg(`GameLoom._debug.teleportPlayer(-7, 0.92, -4)`);
  await GL.step(5);
  await GL.dbg(`GameLoom._debug.setLook(-1.5708, 0)`);   // avant = +X
  await GL.dbg(`GameLoom._debug.input({ move: [1, 0] })`);
  await GL.step(60);                                      // 1 s de jeu = 5.6 m tentés
  await GL.dbg(`GameLoom._debug.input({ move: [0, 0] })`);
  const p3 = (await GL.snap()).player;
  check('T3 collisions: impossible de traverser la colonne (x bloqué dans [-5.5,-4.7], au sol)',
    p3.pos[0] > -5.5 && p3.pos[0] < -4.7 && p3.grounded === true, p3);
  const fpPlayerT3 = p3.pos;                              // fin de T3 (joueur bloqué par la colonne)

  // ---------- T4: gardien en patrouille (déplacement réel + progression) ----------
  const gA = (await GL.inspect(gid)).position;             // fin de T3
  await GL.step(60);                                       // +60 ticks
  const gB = (await GL.inspect(gid)).position;
  await GL.step(60);                                       // +120 ticks
  const gC = (await GL.inspect(gid)).position;
  const st4 = await GL.state();
  check('T4 patrouille: le gardien se déplace ~2 m/s sur 2 fenêtres de 60 ticks',
    dist(gA, gB) >= 1.2 && dist(gA, gB) <= 2.35 && dist(gB, gC) >= 1.2 && dist(gB, gC) <= 2.35,
    { gA, gB, gC, d1: +dist(gA, gB).toFixed(3), d2: +dist(gB, gC).toFixed(3) });
  check('T4b état gardien: PATROL + index de waypoint observable via JSON',
    st4.guardian.state === 'PATROL' && Number.isInteger(st4.guardian.waypoint), st4.guardian);

  // ---------- T5: PATROL → ALERT (joueur placé dans le rayon de détection) ----------
  await GL.dbg(`GameLoom._debug.setPlayerHealth(100)`);
  await GL.dbg(`GameLoom._debug.teleportPlayer(10.5, 0.92, -7)`);
  await GL.step(15);
  const st5 = await GL.state();
  const ev5 = await GL.events(120);
  check('T5 détection: état ALERT + event guardian.alert émis',
    st5.guardian.state === 'ALERT' && ev5.some((e) => e.event === 'guardian.alert'),
    { st5: st5.guardian, ev: ev5.filter((e) => e.event === 'guardian.alert') });

  // ---------- T6: dégâts du gardien sur le joueur ----------
  await GL.step(120);
  const p6 = (await GL.snap()).player;
  const ev6 = await GL.events(250);
  const dmg6 = ev6.filter((e) => e.event === 'damage' && e.entity === 'player' && e.other === gid);
  check('T6 dégâts: le gardien blesse réellement le joueur (health < 100, damage other=guardien)',
    dmg6.length >= 1 && hp(p6) < 100 && p6.alive === true,
    { hp: hp(p6), hits: dmg6.length, ev: dmg6 });
  const fpHP6 = hp(p6);

  // ---------- T7: artefact avant interaction ----------
  const st7 = await GL.state();
  const ev7 = await GL.events(300);
  check('T7 artefact avant interaction: collected=false, aucun event artifact.collected',
    st7.artifact.collected === false && !ev7.some((e) => e.event === 'artifact.collected'),
    { st7: st7.artifact });

  // ---------- T9: extraction AVANT l'artefact → pas de victoire ----------
  await GL.dbg(`GameLoom._debug.teleportPlayer(17.7, 0.92, 0)`);   // dans la zone, grille encore fermée
  await GL.step(10);
  const st9 = await GL.state();
  const ev9 = await GL.events(300);
  check('T9 extraction avant artefact: inactive, pas de victoire, pas de player.extracted',
    st9.extraction.active === false && st9.won === false && !ev9.some((e) => e.event === 'player.extracted'),
    { st9: { extraction: st9.extraction, won: st9.won } });

  // ---------- T8: interaction artefact (E à proximité) ----------
  await GL.dbg(`GameLoom._debug.teleportPlayer(12, 0.92, -6)`);    // dist 2.0 m de l'artefact (12,-8)
  await GL.step(2);
  await GL.dbg(`GameLoom._debug.gameInteract()`);
  await GL.step(5);
  const st8 = await GL.state();
  const ev8 = await GL.events(300);
  check('T8 interaction: artifact.collected=true + event + grille ouverte + score ≥ 50',
    st8.artifact.collected === true && st8.gate.open === true
    && ev8.some((e) => e.event === 'artifact.collected')
    && (await GL.snap()).player.score >= 50,
    { st8: { artifact: st8.artifact, gate: st8.gate }, ev: ev8.filter((e) => e.event === 'artifact.collected') });

  // ---------- T10: extraction APRÈS l'artefact → marche vers la zone → victoire ----------
  await GL.dbg(`GameLoom._debug.setPlayerHealth(100)`);
  await GL.dbg(`GameLoom._debug.teleportPlayer(15.6, 0.92, 0)`);
  await GL.step(2);
  await GL.dbg(`GameLoom._debug.setLook(-1.5708, 0)`);
  await GL.dbg(`GameLoom._debug.input({ move: [1, 0] })`);
  await GL.step(30);
  await GL.dbg(`GameLoom._debug.input({ move: [0, 0] })`);
  const st10 = await GL.state();
  const p10 = (await GL.snap()).player;
  const ev10 = await GL.events(300);
  const winVisible = await cdp.eval(`document.getElementById('win').style.display === 'flex'`);
  const exitTick = ev10.find((e) => e.event === 'player.extracted')?.tick ?? null;
  check('T10 extraction après artefact: marche dans la zone → player.extracted + won=true (x>16.5)',
    st10.won === true && p10.pos[0] > 16.5 && Math.abs(p10.pos[2]) < 2.2
    && ev10.some((e) => e.event === 'player.extracted') && winVisible,
    { st10: { won: st10.won, extraction: st10.extraction }, x: p10.pos[0], exitTick, winVisible });

  // ---------- T11: mort du joueur (page 2, boot frais) ----------
  await cdp.send('Page.navigate', { url: URL_TARGET });
  ready = await waitReady(cdp);
  check('T11 boot page 2: GameLoom réexposé (scénario de mort isolé)', ready);
  if (ready) await sleep(800);
  await GL.pause();
  await GL.step(30);
  await GL.dbg(`GameLoom._debug.setPlayerHealth(20)`);
  await GL.dbg(`GameLoom._debug.teleportPlayer(10.5, 0.92, -7)`);   // à ~2.8 m du gardien (W0)
  await GL.step(180);
  const p11 = (await GL.snap()).player;
  const st11 = await GL.state();
  const ev11 = await GL.events(300);
  const diedTick = ev11.find((e) => e.event === 'player.died')?.tick ?? null;
  check('T11 mort: 20 HP + gardien → health.zero → player.died observable, alive=false',
    p11.alive === false && p11.health === '0/100' && st11.dead === true
    && ev11.some((e) => e.event === 'player.died'),
    { hp: p11.health, dead: st11.dead, diedTick, ev: ev11.filter((e) => e.event === 'player.died') });

  // ---------- T12: doctor / état cohérent ----------
  const doc = await GL.doctor();
  check('T12 doctor: ok, 3 GLB GameLoom chargés avec méta, aucune entité zombie',
    doc.ok === true
    && doc.assets.loaded.includes('assets/guardian.glb')
    && doc.assets.loaded.includes('assets/artifact.glb')
    && doc.assets.loaded.includes('assets/ruins_column.glb')
    && doc.assets.without_gameloom_meta.length === 0,
    { ok: doc?.ok, warnings: doc?.warnings, assets: doc?.assets.loaded });

  // ---------- T13: régression assets — CLI glb sur les 3 GLB ----------
  const glbs = ['guardian.glb', 'artifact.glb', 'ruins_column.glb'];
  let validateOk = true, validateDetail = {};
  for (const f of glbs) {
    try {
      const out = execSync(`node tools/cli.mjs validate assets/${f}`, { cwd: REPO_ROOT, encoding: 'utf8' });
      validateDetail[f] = out.trim().replace(/\n/g, ' ');
      if (!out.includes('valide')) validateOk = false;
    } catch (e) { validateOk = false; validateDetail[f] = e.message; }
  }
  check('T13a assets: les 3 GLB passent `glb validate`', validateOk, validateDetail);
  let doctorOk = true, doctorDetail = {};
  for (const f of glbs) {
    try {
      const out = execSync(`node tools/cli.mjs doctor assets/${f}`, { cwd: REPO_ROOT, encoding: 'utf8' });
      const j = JSON.parse(out);
      doctorDetail[f] = { ok: j.ok, warnings: j.checks.warnings };
      if (!j.ok) doctorOk = false;
    } catch (e) { doctorOk = false; doctorDetail[f] = e.message; }
  }
  check('T13b assets: `glb doctor` ok sans avertissement sur les 3 GLB', doctorOk, doctorDetail);

  // ---------- T14: erreurs console (les 3 boots) ----------
  const realErrors = cdp.errors.filter((e) => !/WebGL|GL |audio|Audio/i.test(e));
  check('T14 console: zéro erreur inattendue', realErrors.length === 0, realErrors.slice(0, 3));

  // ---------- T15: screenshot UNIQUE — validation visuelle finale ----------
  await cdp.send('Page.navigate', { url: URL_TARGET });
  ready = await waitReady(cdp);
  if (ready) {
    await sleep(800);
    await GL.pause();
    await GL.step(30);
    await GL.dbg(`GameLoom._debug.teleportPlayer(1, 0.92, 7)`);
    await GL.dbg(`GameLoom._debug.setLook(-0.63, -0.09)`);
    await GL.step(2);
  }
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(SHOT_PATH, Buffer.from(shot.data, 'base64'));
  check('T15 screenshot final capturé (seule validation visuelle)', ready, 'tools/ruins_screenshot.png');

  // ---------- FINGERPRINT (déterminisme: identique entre runs) ----------
  console.log('FINGERPRINT', JSON.stringify({
    tickAfterT2: tD,
    playerAfterT3: fpPlayerT3,
    guardianAfterT3: gA,
    guardianPlus60: gB,
    guardianPlus120: gC,
    guardianStateAfterT4: st4.guardian ? { state: st4.guardian.state, wp: st4.guardian.waypoint } : null,
    hpAfterT6: fpHP6,
    exitTick,
    diedTick,
  }));

  // ---------- bilan ----------
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n=== BILAN: ${pass}/${results.length} tests passés ===`);
  console.log('état final:', JSON.stringify(await GL.stats()));
  console.log('état ruins:', JSON.stringify(await GL.state()));
  console.log('events récents:', JSON.stringify(await GL.events(10)));
  cdp.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error('FATALE:', e.message);
  process.exit(2);
});
