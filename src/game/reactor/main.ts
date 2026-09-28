import { createRuntime } from '../../core';
import type { Runtime } from '../../core';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

let rt: Runtime;

// ---------- réglages gameplay ----------
const SEQ_TICKS = 180;             // séquence de démarrage du réacteur (fixed ticks ≈ 3 s)
const ENEMY_SPEED = 3.2;           // m/s
const ENEMY_DETECT = 13;           // m
const ENEMY_ATTACK_RANGE = 2.0;    // m
const ENEMY_ATTACK_COOLDOWN = 1.0; // s (temps de jeu, jamais setTimeout)
const ENEMY_DAMAGE = 8;
const GUN_DAMAGE = 25;
const INTERACT_RANGE = 3.0;        // m
const REACTOR_ZONE: { min: [number, number]; max: [number, number] } = { min: [-4, -4], max: [4, 4] }; // bornes [X, Z] inclusives

// ---------- état de mission (ECS porte l'état par entité) ----------
type RelayLabel = 'A' | 'B' | 'C';
interface RelayState { id: string; label: RelayLabel; active: boolean; }
interface EnemyState { id: string; lastAttackTime: number; }

const relays: RelayState[] = [];
const enemies: EnemyState[] = [];
const initialEnemyIds: string[] = [];
const reinforcementIds: string[] = [];
const lastDamager = new Map<string, string>();

let reactorZone: { isInside: (eid: string) => boolean } | null = null;
let reactorProgress = 0;
let reactorStarted = false;
let reactorOnline = false;
let reinforcementsSpawned = false;
let victoryEmitted = false;
let playerDead = false;

// ---------- HUD ----------
const hudRelais = document.getElementById('hud-relais') as HTMLDivElement;
const hudReactor = document.getElementById('hud-reactor') as HTMLDivElement;
const hudHint = document.getElementById('hint') as HTMLDivElement;
const overlayEl = document.getElementById('overlay') as HTMLDivElement;
const overlayTitle = document.getElementById('overlay-title') as HTMLDivElement;
const overlaySub = document.getElementById('overlay-sub') as HTMLDivElement;

function updateHud() {
  const n = relays.filter((r) => r.active).length;
  hudRelais.textContent = `RELAIS ${n}/3`;
  const pct = Math.round((reactorProgress / SEQ_TICKS) * 100);
  hudReactor.textContent = `RÉACTEUR ${pct} %`;
  if (reactorOnline) hudHint.textContent = '';
  else if (reactorStarted) hudHint.textContent = 'Rester dans la zone du réacteur !';
  else {
    const p = rt.playerState();
    let near = false;
    for (const r of relays) {
      if (r.active) continue;
      const pos = rt.entityPosition(r.id);
      if (!pos) continue;
      const d = Math.hypot(p.pos[0] - pos[0], p.pos[2] - pos[2]);
      if (d <= INTERACT_RANGE) { near = true; break; }
    }
    hudHint.textContent = near ? 'E — Activer le relais' : '';
  }
}

function showOverlay(title: string, sub: string) {
  overlayTitle.textContent = title;
  overlaySub.textContent = sub;
  overlayEl.classList.remove('hidden');
}

// ---------- monde (objets sans entité ECS: sol, murs) ----------
function addWorldBox(cx: number, cy: number, cz: number, w: number, h: number, d: number, color: number) {
  const body = rt.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(cx, cy, cz));
  rt.world.createCollider(RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2), body);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color }));
  mesh.position.set(cx, cy, cz);
  rt.scene.add(mesh);
}

function buildMap() {
  rt.scene.background = new THREE.Color(0x7c93a8);
  const amb = new THREE.AmbientLight(0xffffff, 0.65);
  rt.scene.add(amb);
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(12, 24, 8);
  rt.scene.add(sun);

  addWorldBox(0, -0.25, 0, 48.4, 0.5, 48.4, 0x3d4a3f);            // sol (face haute y=0)
  addWorldBox(0, 1.5, -24.4, 49.2, 3, 0.8, 0x5a5f66);            // limite nord
  addWorldBox(0, 1.5, 24.4, 49.2, 3, 0.8, 0x5a5f66);             // limite sud
  addWorldBox(-24.4, 1.5, 0, 0.8, 3, 49.2, 0x5a5f66);            // limite ouest
  addWorldBox(24.4, 1.5, 0, 0.8, 3, 49.2, 0x5a5f66);             // limite est

  const reactor = rt.spawnAsset('assets/reactor.glb', [0, 0, 0]);
  if (!reactor) throw new Error('spawn réacteur échoué');

  const crates: [number, number, number][] = [[-13, 0, -9], [13, 0, -9], [3, 0, 13], [-3, 0, 13]];
  for (const c of crates) rt.spawnAsset('assets/crate.glb', c);
  const columns: [number, number, number][] = [[7, 0, 0], [-7, 0, 0], [0, 0, 7], [0, 0, -7]];
  for (const c of columns) rt.spawnAsset('assets/ruins_column.glb', c);
}

function spawnRelays() {
  const spots: [RelayLabel, [number, number, number]][] = [
    ['A', [-16, 0, -12]],
    ['B', [16, 0, -12]],
    ['C', [0, 0, 16]],
  ];
  for (const [label, pos] of spots) {
    const e = rt.spawnAsset('assets/switch.glb', pos, { tags: ['relay'] });
    if (e) {
      const id = (e as unknown as { id: string }).id;
      relays.push({ id, label, active: false });
    }
  }
}

function spawnGuardians(at: [number, number, number][], initial: boolean) {
  for (const p of at) {
    const e = rt.spawnAsset('assets/guardian.glb', p);
    if (!e) continue;
    const id = (e as unknown as { id: string }).id;
    enemies.push({ id, lastAttackTime: -1 });
    if (initial) initialEnemyIds.push(id);
  }
}

// ---------- réacteur ----------
function onReactorEnter() {
  if (reactorOnline || !relays.every((r) => r.active)) return;
  if (!reactorStarted) {
    reactorStarted = true;
    rt.bus.emit('reactor.start', 'player', { data: { progress: 0 } });
    spawnReinforcements();
  } else {
    rt.bus.emit('reactor.resume', 'player', { data: { progress: reactorProgress } });
  }
}

function onReactorExit() {
  if (reactorStarted && !reactorOnline && reactorProgress > 0) {
    rt.bus.emit('reactor.interrupt', 'player', { data: { progress: reactorProgress } });
  }
}

function onReactorStay(eid: string) {
  if (eid !== 'player') return;
  if (playerDead || reactorOnline || !reactorStarted || !relays.every((r) => r.active)) return;
  reactorProgress = Math.min(SEQ_TICKS, reactorProgress + 1);
  if (reactorProgress >= SEQ_TICKS) {
    reactorOnline = true;
    rt.bus.emit('reactor.online', 'player', { data: { progress: reactorProgress } });
    if (!victoryEmitted && !playerDead) {
      victoryEmitted = true;
      rt.bus.emit('game.victory', 'player', { data: { relays: 3, progress: reactorProgress } });
      showOverlay('REACTOR ONLINE', 'MISSION COMPLETE');
    }
  }
  updateHud();
}

function spawnReinforcements() {
  reinforcementsSpawned = true;
  const spots: [number, number, number][] = [[8, 0, 4], [-8, 0, -4]];
  for (const p of spots) {
    const e = rt.spawnAsset('assets/guardian.glb', p);
    if (!e) continue;
    const id = (e as unknown as { id: string }).id;
    enemies.push({ id, lastAttackTime: -1 });
    reinforcementIds.push(id);
  }
  rt.bus.emit('reactor.reinforcements', 'player', { data: { count: 2 } });
}

// ---------- ennemis (comportement simple déterministe: détecter → courir → attaquer) ----------
function enemyAi() {
  if (playerDead) return;
  const ps = rt.playerState();
  const now = rt.time;
  for (const e of [...enemies]) {
    const pos = rt.entityPosition(e.id);
    if (!pos) continue;
    const dx = ps.pos[0] - pos[0];
    const dz = ps.pos[2] - pos[2];
    const dist = Math.hypot(dx, dz);
    if (dist > ENEMY_DETECT) continue;
    rt.moveEntity(e.id, [ps.pos[0], pos[1], ps.pos[2]], ENEMY_SPEED, { avoidObstacles: true });
    if (dist <= ENEMY_ATTACK_RANGE && now - e.lastAttackTime >= ENEMY_ATTACK_COOLDOWN) {
      e.lastAttackTime = now;
      rt.bus.emit('damage', 'player', { other: e.id, amount: ENEMY_DAMAGE, point: ps.pos });
    }
  }
}

// ---------- règles event → action ----------
function rules() {
  rt.on('guardian', 'damage', {
    fn: (ctx) => {
      if (ctx.other) lastDamager.set(ctx.entity, ctx.other);
    },
  });
  rt.on('guardian', 'health.zero', {
    fn: (ctx) => {
      const i = enemies.findIndex((e) => e.id === ctx.entity);
      if (i >= 0) enemies.splice(i, 1);
      const by = lastDamager.get(ctx.entity) ?? 'inconnu';
      rt.bus.emit('enemy.killed', ctx.entity, { data: { by } });
      rt.removeEntity(ctx.entity);
    },
  });
  rt.on('player', 'player.died', {
    fn: () => {
      playerDead = true;
      rt.bus.emit('game.over', 'player', {});
      showOverlay('GAME OVER', 'MISSION ÉCHOUÉE');
    },
  });
  rt.on('player', 'zone.enter', {
    fn: (ctx) => {
      if (ctx.other !== 'reactor') return;
      onReactorEnter();
    },
  });
  rt.on('player', 'zone.exit', {
    fn: (ctx) => {
      if (ctx.other !== 'reactor') return;
      onReactorExit();
    },
  });
}

// ---------- combat + interaction ----------
// Convention visée (yaw/pitch core → direction monde) : à calibrer par le harness (aimAt/look).
function lookDir(yaw: number, pitch: number): [number, number, number] {
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}

function fire(): string {
  if (playerDead) return 'dead';
  const st = rt.playerState();
  const eye: [number, number, number] = [st.pos[0], st.pos[1] + 1.55, st.pos[2]];
  const hit = rt.raycast(eye, lookDir(st.yaw, st.pitch), 120);
  const hitId = hit?.entity?.id;
  if (hit && hitId && hitId !== 'player') {
    rt.bus.emit('damage', hitId, { other: 'player', amount: GUN_DAMAGE, point: hit.point });
    return 'hit:' + hitId;
  }
  return 'miss';
}

function tryInteract(): RelayLabel | null {
  if (playerDead) return null;
  const p = rt.playerState();
  for (const r of relays) {
    if (r.active) continue;
    const pos = rt.entityPosition(r.id);
    if (!pos) continue;
    const d = Math.hypot(p.pos[0] - pos[0], p.pos[2] - pos[2]);
    if (d <= INTERACT_RANGE) {
      r.active = true;
      rt.bus.emit('relay.activated', r.id, { data: { relay: r.label, count: relays.filter((x) => x.active).length } });
      updateHud();
      return r.label;
    }
  }
  return null;
}

// ---------- input (le core est la source unique: écriture par événement clavier) ----------
function input() {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const keys = { fwd: 0, strafe: 0 };
  const pushMove = (look: [number, number] = [0, 0], jump = false) =>
    rt.applyPlayerControl({ move: [keys.fwd, keys.strafe], look, jump });
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.code === 'KeyW') { keys.fwd = 1; pushMove(); }
    else if (e.code === 'KeyS') { keys.fwd = -1; pushMove(); }
    else if (e.code === 'KeyA') { keys.strafe = -1; pushMove(); }
    else if (e.code === 'KeyD') { keys.strafe = 1; pushMove(); }
    else if (e.code === 'Space') { pushMove([0, 0], true); }
    else if (e.code === 'KeyE') { tryInteract(); }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'KeyW' && keys.fwd === 1) { keys.fwd = 0; pushMove(); }
    else if (e.code === 'KeyS' && keys.fwd === -1) { keys.fwd = 0; pushMove(); }
    else if (e.code === 'KeyA' && keys.strafe === -1) { keys.strafe = 0; pushMove(); }
    else if (e.code === 'KeyD' && keys.strafe === 1) { keys.strafe = 0; pushMove(); }
  });
  canvas.addEventListener('click', () => {
    if (document.pointerLockElement !== canvas) { canvas.requestPointerLock?.(); return; }
    fire();
  });
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas) return;
    const st = rt.playerState();
    rt.setLook(st.yaw - e.movementX * 0.0022, st.pitch - e.movementY * 0.0022);
  });
}

// ---------- hooks de jeu (pattern _debug documenté) ----------
function debugHooks() {
  const D = (window as any).GameLoom?._debug;
  if (!D) return;
  D.gameFire = () => fire();
  D.gameInteract = () => tryInteract();
  D.reactorState = () => {
    const gl = (window as any).GameLoom;
    const snap = gl.snapshot();
    return {
      tick: gl.stats().tick,
      relays: relays.map((r) => ({ label: r.label, id: r.id, active: r.active })),
      relayCount: relays.filter((r) => r.active).length,
      relaysDone: relays.length === 3 && relays.every((r) => r.active),
      reactor: {
        seqTicks: SEQ_TICKS,
        progress: reactorProgress,
        started: reactorStarted,
        online: reactorOnline,
        inZone: reactorZone ? reactorZone.isInside('player') : false,
      },
      reinforcements: {
        spawned: reinforcementsSpawned,
        count: reinforcementIds.filter((id) => enemies.some((e) => e.id === id)).length,
      },
      enemies: gl.entities({ tag: 'guardian' }),
      player: { alive: snap.player.alive, health: snap.player.health, pos: snap.player.pos },
      victory: victoryEmitted,
      playerDead,
    };
  };
}

// ---------- boot ----------
async function boot() {
  rt = await createRuntime(document.getElementById('game') as HTMLCanvasElement, {
    onExplode: () => { },
    onFire: () => { },
  });
  await rt.preloadAssets([
    'assets/reactor.glb', 'assets/switch.glb', 'assets/guardian.glb',
    'assets/crate.glb', 'assets/ruins_column.glb',
  ]);
  buildMap();
  spawnRelays();
  spawnGuardians([[-9, 0, 9], [9, 0, 9], [0, 0, -9]], true);
  reactorZone = rt.createZone({
    id: 'reactor',
    bounds: REACTOR_ZONE,
    tags: ['player'],
    onStay: onReactorStay,
  });
  rules();
  input();
  updateHud();
  debugHooks();
  (window as any).GameLoom?._debug?.teleportPlayer(0, 1, -20); // point d'arrivée du joueur
  rt.onTick(() => { enemyAi(); updateHud(); });
  rt.setPaused(true);
  rt.start();
}

boot();
