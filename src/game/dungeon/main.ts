// Dungeon Assault — jeu #4 GameLoom v0.1 (FPS / donjon : 3 ennemis, piège, clé, porte, sortie)
// Séparation stricte (philosophie GameLoom):
//   - GLB (guardian/dungeon_mage/dungeon_key/dungeon_spikes/crate/ruins_column) =
//     IDENTITÉ + CAPACITÉS STATIQUES (collider, physique, Health.max). AUCUN comportement.
//   - RULES déclaratives: rt.on(tag, event, {if, do, fn}) → EVENT → ACTION
//   - CODE DE JEU: 3 machines à états d'ennemis, projectiles, piège (zone), clé (E),
//     porte verrouillée, zone de sortie, HUD, audio → TypeScript.
// Mouvement des ennemis (kinematic) côté jeu: rt.world.bodies + setTranslation/setRotation
// + verrouillage rt.raycast (pattern validé jeu #3, GAMELOOM.md §5).
// Projectiles: objets du monde possédés par le jeu (rigid body kinematic + ball + mesh),
// même pattern que la porte/grille (GAMELOOM.md §5/§9).
// Zones (piège / activation de la brute / sortie): inclusion AABB par position dans onTick
// (pattern validé jeux #2/#3 — polling spatial, pas de primitive de zone dans le core).

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { createRuntime, A, FIXED_DT } from '../../core';
import type { Runtime, Vec3 } from '../../core';

// ---------- DOM ----------
const $ = (id: string) => document.getElementById(id)!;
const canvas = $('game') as HTMLCanvasElement;
const elHP = $('hud-hp'), elHealthFill = $('health-fill'), elScore = $('hud-score');
const elKey = $('key-state'), elDoor = $('door-state');
const elEA = $('e-a-state'), elEB = $('e-b-state'), elEC = $('e-c-state');
const elTrap = $('trap-warn');
const overlay = $('overlay'), ovSub = $('ov-sub');
const winEl = $('win'), winDetail = $('win-detail');
const goEl = $('gameover'), goDetail = $('go-detail');

// ---------- layout du donjon (positions fixes, déterministe) ----------
// Intérieurs: START x[-8,0] z[-4,4] · COULOIR x[0,8] z[-1.5,1.5] · HALL x[8,20] z[-6,6]
// KEYROOM x[8,16] z[6,11] (ouverture x[11,14] dans le mur nord du hall) ·
// EXIT x[20,24] z[-2,2] (porte dans le mur est du hall, ouverture z[-1.5,1.5]).
// Joueur spawné à l'origine (core) = l'extrémité est de la salle de départ.
const WALL_H = 3;
// [demi-x, demi-z, x, z] — murs (cuboïdes statiques game-owned, y ∈ [0, WALL_H])
const WALLS: [number, number, number, number][] = [
  [4, 0.25, -4, 4.25],       // start nord
  [4, 0.25, 4, 1.75],        // couloir nord
  [1.5, 0.25, 9.5, 6.25],    // hall nord seg 1 (x [8,11])
  [3, 0.25, 17, 6.25],       // hall nord seg 2 (x [14,20]) — ouverture keyroom x [11,14]
  [3.5, 0.25, 12.5, 11.25],  // keyroom nord
  [0.25, 2.5, 16.25, 8.5],   // keyroom est
  [0.25, 2.5, 8.25, 8.5],    // keyroom ouest
  [4, 0.25, -4, -4.25],      // start sud
  [4, 0.25, 4, -1.75],       // couloir sud
  [6, 0.25, 14, -6.25],      // hall sud
  [2, 0.25, 22, -2.25],      // exit sud
  [2, 0.25, 22, 2.25],       // exit nord
  [0.25, 4, -8.25, 0],       // start ouest
  [0.25, 2.25, 7.75, -3.75], // hall ouest bas (z [-6,-1.5])
  [0.25, 2.25, 7.75, 3.75],  // hall ouest haut (z [1.5,6])
  [0.25, 1.25, -0.25, -2.75],// start est bas (z [-4,-1.5])
  [0.25, 1.25, -0.25, 2.75], // start est haut (z [1.5,4])
  [0.25, 2.25, 20.25, -3.75],// hall est bas (z [-6,-1.5])
  [0.25, 2.25, 20.25, 3.75], // hall est haut (z [1.5,6])
  [0.25, 2, 24.25, 0],       // exit est
];
const GROUND_HALF: Vec3 = [16.5, 0.25, 9];                    // sol x[-8.5,24.5] z[-6.5,11.5]
const DOOR = { half: [0.25, WALL_H / 2, 1.5] as Vec3, x: 20.25, z: 0 };
const TRAP = { x1: 12, x2: 15, zMax: 1.5, enterDmg: 10, tickDmg: 5, every: 12 };
const EXIT = { xMin: 20.6, xMax: 23.9, zMax: 1.9 };
const KEY_POS: Vec3 = [14.5, 0, 9.5];
const SPIKES_POS: Vec3 = [13.5, 0, 0];
const COLUMN_POS: Vec3[] = [[11, 0, -4.5], [18, 0, 4.5]];
const CRATE_POS: Vec3[] = [[9.5, 0, 4.5], [19, 0, 3.5]];
const INTERACT_DIST = 2.2;
const FIRE_DAMAGE = 25;
const FIRE_COOLDOWN_S = 0.25;

// ---------- ennemi A — PATROLLER (guardian.glb) ----------
const ENEMY_A = { detect: 4.5, lost: 7.0, attack: 1.5, patrol: 2.0, chase: 2.8, damage: 15, coolFirst: 30, coolMax: 45 };
const WAYPOINTS_A: Vec3[] = [[5, 0, 0.9], [7.4, 0, -0.8], [5, 0, -0.9]];

// ---------- ennemi B — CHASER (guardian.glb, zone d'activation = le hall) ----------
const ENEMY_B = { zoneX1: 8.3, zoneX2: 20, zoneZ: 5.8, wait: [17, 0, -4.5] as Vec3, chase: 3.0, attack: 1.3, damage: 12, coolMax: 30 };

// ---------- ennemi C — RANGED (dungeon_mage.glb, projectiles réels) ----------
const ENEMY_C = { detect: 8.0, lost: 9.0, keepDist: 4.5, retreat: 1.8, coolMax: 90, projSpeed: 7.0, projLife: 75, projR: 0.18, projHit: 0.65, damage: 8 };

// ---------- machines à états (code de jeu, PAS dans les GLB) ----------
type MobKind = 'A' | 'B' | 'C';
type MobState = 'PATROL' | 'ALERT' | 'ATTACK' | 'IDLE' | 'CHASE' | 'DETECTED';
interface Mob { kind: MobKind; state: MobState; waypoint: number; cooldown: number }
const mobs = new Map<string, Mob>();

// ---------- état de jeu ----------
let rt: Runtime;
let keyCollected = false;
let doorLocked = true;
let doorOpen = false;
let doorLiftT = -1;
let won = false;
let gameOver: 'none' | 'died' | 'victory' = 'none';
let trapInside = false;
let trapCountdown = 0;
let lastFireAt = -Infinity;
let doorBody: RAPIER.RigidBody;
let doorCollider: RAPIER.Collider;
let doorMesh: THREE.Mesh;

interface Proj { body: RAPIER.RigidBody; col: RAPIER.Collider; mesh: THREE.Mesh; dir: Vec3; ttl: number; from: string }
const projs: Proj[] = [];

// ---------- audio synth (Web Audio, aucun asset) ----------
let actx: AudioContext | null = null;
function ac(): AudioContext {
  if (!actx) actx = new AudioContext();
  if (actx.state === 'suspended') void actx.resume();
  return actx;
}
function sfx(name: string) {
  try {
    const c = ac();
    const t = c.currentTime;
    const tone = (type: OscillatorType, f0: number, f1: number, dur: number, gain = 0.1, at = 0) => {
      const o = c.createOscillator(); o.type = type;
      o.frequency.setValueAtTime(f0, t + at); o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + at + dur);
      const g = c.createGain(); g.gain.setValueAtTime(gain, t + at); g.gain.exponentialRampToValueAtTime(0.001, t + at + dur);
      o.connect(g).connect(c.destination); o.start(t + at); o.stop(t + at + dur + 0.02);
    };
    if (name === 'shoot') tone('square', 660, 140, 0.09);
    else if (name === 'kill') tone('triangle', 220, 60, 0.4, 0.25);
    else if (name === 'alert') tone('square', 190, 320, 0.15);
    else if (name === 'key') [523, 784, 1047].forEach((f, i) => tone('triangle', f, f, 0.15, 0.12, i * 0.09));
    else if (name === 'door') tone('sawtooth', 90, 40, 0.6, 0.2);
    else if (name === 'trap') tone('sawtooth', 300, 90, 0.25, 0.15);
    else if (name === 'win') [523, 659, 784, 1047].forEach((f, i) => tone('triangle', f, f, 0.2, 0.12, i * 0.13));
    else if (name === 'shot') tone('sine', 880, 220, 0.18, 0.08);
  } catch { /* audio optionnel */ }
}

// ---------- primitives de mouvement (côté jeu, primitives core publiques) ----------
// Le core expose rt.world et pose body.userData = id au spawn → le jeu retrouve le rigid
// body sans API dédiée. Kinematic: setTranslation() déplace, le KCC du joueur traite le
// corps comme obstacle. Verrouillage des déplacements par rt.raycast (exclut le joueur).
function bodyOf(id: string): RAPIER.RigidBody | null {
  for (const b of rt.world.bodies.getAll()) if (b.userData === id) return b as RAPIER.RigidBody;
  return null;
}
function faceBody(b: RAPIER.RigidBody, dx: number, dz: number) {
  if (Math.hypot(dx, dz) < 1e-4) return;
  const yaw = Math.atan2(-dx, -dz);
  b.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
}
function moveBody(b: RAPIER.RigidBody, to: Vec3, maxStep: number) {
  const t = b.translation();
  const dx = to[0] - t.x, dz = to[2] - t.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-4) return;
  const s = Math.min(maxStep, d);
  b.setTranslation({ x: t.x + (dx / d) * s, y: t.y, z: t.z + (dz / d) * s }, true);
  faceBody(b, dx, dz);
}
function chaseBody(b: RAPIER.RigidBody, target: Vec3, maxStep: number) {
  const t = b.translation();
  const dx = target[0] - t.x, dz = target[2] - t.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-4) return;
  const ux = dx / d, uz = dz / d;
  let step = maxStep;
  const o: Vec3 = [t.x + ux * 0.9, t.y + 1.0, t.z + uz * 0.9];
  const hit = rt.raycast(o, [ux, 0, uz], d);
  if (hit) {
    const limit = hit.distance + 0.9 - 0.5;
    if (limit < step) step = limit;
  }
  if (step < 0.01) { faceBody(b, dx, dz); return; }
  b.setTranslation({ x: t.x + ux * step, y: t.y, z: t.z + uz * step }, true);
  faceBody(b, dx, dz);
}
const round1 = (n: number) => Math.round(n * 10) / 10;

// ---------- ennemi A: PATROL → ALERT → ATTACK ----------
function tickA(id: string, mob: Mob) {
  const b = bodyOf(id);
  if (!b) return;
  const t = b.translation();
  const p = rt.playerState();
  const dx = p.pos[0] - t.x, dz = p.pos[2] - t.z;
  const dist = Math.hypot(dx, dz);
  if (mob.state === 'PATROL' && dist <= ENEMY_A.detect) {
    mob.state = 'ALERT'; mob.cooldown = 0;
    rt.bus.emit('enemy.alert', id, { other: 'player', data: { state: 'ALERT', dist: round1(dist) } });
  } else if (mob.state === 'ALERT') {
    if (dist <= ENEMY_A.attack) {
      mob.state = 'ATTACK'; mob.cooldown = ENEMY_A.coolFirst;
      rt.bus.emit('enemy.attack', id, { other: 'player', data: { state: 'ATTACK', dist: round1(dist) } });
    } else if (dist > ENEMY_A.lost) {
      mob.state = 'PATROL'; mob.waypoint = nearestWaypoint(t);
      rt.bus.emit('enemy.lost', id, { other: 'player', data: { state: 'PATROL', waypoint: mob.waypoint } });
    }
  } else if (mob.state === 'ATTACK' && dist > ENEMY_A.attack + 0.5) {
    mob.state = 'ALERT'; mob.cooldown = 0;
    rt.bus.emit('enemy.alert', id, { other: 'player', data: { state: 'ALERT', dist: round1(dist) } });
  }
  if (mob.state === 'PATROL') {
    const wp = WAYPOINTS_A[mob.waypoint];
    moveBody(b, wp, ENEMY_A.patrol * FIXED_DT);
    const t2 = b.translation();
    if (Math.hypot(wp[0] - t2.x, wp[2] - t2.z) < 0.2) mob.waypoint = (mob.waypoint + 1) % WAYPOINTS_A.length;
  } else if (mob.state === 'ALERT') {
    chaseBody(b, [p.pos[0], t.y, p.pos[2]], ENEMY_A.chase * FIXED_DT);
  } else {
    faceBody(b, dx, dz);
    if (mob.cooldown > 0) mob.cooldown--;
    else if (dist <= ENEMY_A.attack) {
      mob.cooldown = ENEMY_A.coolMax;
      rt.bus.emit('damage', 'player', { other: id, amount: ENEMY_A.damage, point: [t.x, t.y + 1.2, t.z] });
    }
  }
}
function nearestWaypoint(pos: { x: number; y: number; z: number }): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i < WAYPOINTS_A.length; i++) {
    const d = Math.hypot(WAYPOINTS_A[i][0] - pos.x, WAYPOINTS_A[i][2] - pos.z);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// ---------- ennemi B: dormant → course (zone d'activation) ----------
function tickB(id: string, mob: Mob) {
  const b = bodyOf(id);
  if (!b) return;
  const t = b.translation();
  const p = rt.playerState();
  if (mob.state === 'IDLE') {
    if (p.pos[0] > ENEMY_B.zoneX1 && p.pos[0] < ENEMY_B.zoneX2 && Math.abs(p.pos[2]) < ENEMY_B.zoneZ) {
      mob.state = 'CHASE'; mob.cooldown = 0;
      rt.bus.emit('enemy.activated', id, { other: 'player', data: { state: 'CHASE', zone: 'hall' } });
    }
    return;
  }
  const dx = p.pos[0] - t.x, dz = p.pos[2] - t.z;
  const dist = Math.hypot(dx, dz);
  chaseBody(b, [p.pos[0], t.y, p.pos[2]], ENEMY_B.chase * FIXED_DT);
  if (mob.cooldown > 0) mob.cooldown--;
  else if (dist <= ENEMY_B.attack) {
    mob.cooldown = ENEMY_B.coolMax;
    rt.bus.emit('damage', 'player', { other: id, amount: ENEMY_B.damage, point: [t.x, t.y + 1.2, t.z] });
  }
}

// ---------- ennemi C: détection, distance, projectiles ----------
function spawnProj(from: string, origin: Vec3, dir: Vec3) {
  const body = rt.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
  const col = rt.world.createCollider(RAPIER.ColliderDesc.ball(ENEMY_C.projR), body);
  body.setTranslation({ x: origin[0], y: origin[1], z: origin[2] }, true);
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(ENEMY_C.projR, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0x66eaff }),
  );
  mesh.position.set(origin[0], origin[1], origin[2]);
  rt.scene.add(mesh);
  projs.push({ body, col, mesh, dir, ttl: ENEMY_C.projLife, from });
  rt.bus.emit('enemy.fired', from, { data: { speed: ENEMY_C.projSpeed, ttl: ENEMY_C.projLife } });
}
function killProj(pr: Proj, i: number) {
  rt.world.removeCollider(pr.col, true);
  rt.world.removeRigidBody(pr.body);
  rt.scene.remove(pr.mesh);
  pr.mesh.geometry.dispose();
  (pr.mesh.material as THREE.Material).dispose();
  projs.splice(i, 1);
}
function tickProjs() {
  const stepLen = ENEMY_C.projSpeed * FIXED_DT;
  for (let i = projs.length - 1; i >= 0; i--) {
    const pr = projs[i];
    pr.ttl--;
    if (pr.ttl <= 0) { killProj(pr, i); continue; }
    const t = pr.body.translation();
    const castPos: Vec3 = [t.x + pr.dir[0] * 0.19, t.y + pr.dir[1] * 0.19, t.z + pr.dir[2] * 0.19];
    const hit = rt.raycast(castPos, pr.dir, stepLen);
    if (hit && hit.distance < stepLen - 1e-3) { killProj(pr, i); continue; }
    const nx = t.x + pr.dir[0] * stepLen, ny = t.y + pr.dir[1] * stepLen, nz = t.z + pr.dir[2] * stepLen;
    pr.body.setTranslation({ x: nx, y: ny, z: nz }, true);
    pr.mesh.position.set(nx, ny, nz);
    const p = rt.playerState();
    if (Math.hypot(nx - p.pos[0], nz - p.pos[2]) < ENEMY_C.projHit) {
      rt.bus.emit('damage', 'player', { other: pr.from, amount: ENEMY_C.damage, point: [nx, ny, nz] });
      killProj(pr, i);
    }
  }
}
function tickC(id: string, mob: Mob) {
  const b = bodyOf(id);
  if (!b) return;
  const t = b.translation();
  const p = rt.playerState();
  const dx = p.pos[0] - t.x, dz = p.pos[2] - t.z;
  const dist = Math.hypot(dx, dz);
  if (mob.state === 'IDLE' && dist <= ENEMY_C.detect) {
    mob.state = 'DETECTED'; mob.cooldown = ENEMY_C.coolMax;
    rt.bus.emit('enemy.detected', id, { other: 'player', data: { state: 'DETECTED', dist: round1(dist) } });
  } else if (mob.state === 'DETECTED' && dist > ENEMY_C.lost) {
    mob.state = 'IDLE'; mob.cooldown = 0;
    rt.bus.emit('enemy.lost', id, { other: 'player', data: { state: 'IDLE', dist: round1(dist) } });
    return;
  }
  if (mob.state !== 'DETECTED' || dist < 1e-3) return;
  faceBody(b, dx, dz);
  if (dist < ENEMY_C.keepDist) {
    const ux = -dx / dist, uz = -dz / dist;
    chaseBody(b, [t.x + ux * 2, t.y, t.z + uz * 2], ENEMY_C.retreat * FIXED_DT);
  }
  if (mob.cooldown > 0) mob.cooldown--;
  else if (dist <= ENEMY_C.detect + 1) {
    mob.cooldown = ENEMY_C.coolMax;
    const ox = t.x, oy = t.y + 1.4, oz = t.z;
    const tx = p.pos[0], ty = p.pos[1] + 1.55, tz = p.pos[2];
    const fx = tx - ox, fy = ty - oy, fz = tz - oz;
    const L = Math.hypot(fx, fy, fz) || 1;
    spawnProj(id, [ox + (fx / L) * 0.9, oy + (fy / L) * 0.9, oz + (fz / L) * 0.9], [fx / L, fy / L, fz / L]);
  }
}

// ---------- piège (zone spatiale: trap.enter / trap.exit + dégâts) ----------
function tickTrap() {
  const p = rt.playerState();
  const inside = p.pos[0] >= TRAP.x1 && p.pos[0] <= TRAP.x2 && Math.abs(p.pos[2]) <= TRAP.zMax;
  if (inside && !trapInside) {
    trapInside = true; trapCountdown = 0;
    rt.bus.emit('trap.enter', 'player', { data: { x: round1(p.pos[0]), z: round1(p.pos[2]), damage: TRAP.enterDmg } });
    rt.bus.emit('damage', 'player', { other: 'trap', amount: TRAP.enterDmg, point: [p.pos[0], p.pos[1], p.pos[2]] });
  } else if (!inside && trapInside) {
    trapInside = false;
    rt.bus.emit('trap.exit', 'player', { data: { x: round1(p.pos[0]), z: round1(p.pos[2]) } });
  } else if (inside) {
    trapCountdown++;
    if (trapCountdown >= TRAP.every) {
      trapCountdown = 0;
      rt.bus.emit('damage', 'player', { other: 'trap', amount: TRAP.tickDmg, point: [p.pos[0], p.pos[1], p.pos[2]] });
    }
  }
}

// ---------- clé (E à proximité) ----------
function interact() {
  if (gameOver !== 'none' || keyCollected) return;
  const p = rt.playerState();
  const d = Math.hypot(KEY_POS[0] - p.pos[0], KEY_POS[2] - p.pos[2]);
  if (d > INTERACT_DIST) return;
  keyCollected = true;
  const k = rt.byTag('dungeon_key')[0];
  rt.bus.emit('key.collected', k ? k.id! : 'dungeon_key', { other: 'player', data: { dist: round1(d) } });
}

// ---------- porte (objet du monde possédé par le jeu, pattern grille jeu #3) ----------
function unlockDoor() {
  if (!doorLocked) return;
  doorLocked = false; doorOpen = true; doorLiftT = 0.6;
  rt.world.removeCollider(doorCollider, true);
  rt.world.removeRigidBody(doorBody);
  rt.bus.emit('door.unlocked', 'player', { data: { door: true } });
}

// ---------- zone de sortie: victoire si clé + porte + joueur dans la zone ----------
function checkExit() {
  if (gameOver !== 'none') return;
  const p = rt.playerState();
  if (keyCollected && doorOpen && p.pos[0] > EXIT.xMin && p.pos[0] < EXIT.xMax && Math.abs(p.pos[2]) < EXIT.zMax) {
    won = true;
    gameOver = 'victory';
    rt.bus.emit('player.exited', 'player', { other: 'door', data: { time: round1(rt.time) } });
  }
}

// ---------- tir joueur (hitscan, spécifique au jeu) ----------
function eyePos(): Vec3 {
  const s = rt.playerState();
  return [s.pos[0], s.pos[1] + 1.55, s.pos[2]];
}
function lookDir(): Vec3 {
  const s = rt.playerState();
  const e = new THREE.Euler(s.pitch, s.yaw, 0, 'YXZ');
  const v = new THREE.Vector3(0, 0, -1).applyEuler(e);
  return [v.x, v.y, v.z];
}
const tracers: { line: THREE.Line; ttl: number }[] = [];
function onFire(origin: Vec3, hit: Vec3 | null) {
  const end = hit ?? [origin[0], origin[1], origin[2]];
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...origin), new THREE.Vector3(...end)]);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffe9a0, transparent: true, opacity: 0.9 }));
  rt.scene.add(line);
  tracers.push({ line, ttl: 0.06 });
}
function fire() {
  if (gameOver !== 'none') return;
  if (rt.time - lastFireAt < FIRE_COOLDOWN_S) return;
  lastFireAt = rt.time;
  const o = eyePos(), d = lookDir();
  // Raycast qui SAUTE les projectiles ennemis (transitoires, pas des cibles:
  // l'arme du joueur vise l'ennemi, pas ses balles). Re-raycast juste au-delà
  // de la sphère du projectile jusqu'à un hit réel (entité ou mur).
  let origin: Vec3 = o;
  let hit = rt.raycast(origin, d, 120);
  for (let n = 0; n < 4 && hit && !hit.entity; n++) {
    const [hx, hy, hz] = hit.point;
    const isProj = projs.some((pr) => {
      const t = pr.body.translation();
      return Math.hypot(t.x - hx, t.y - hy, t.z - hz) <= ENEMY_C.projR + 0.06;
    });
    if (!isProj) break;
    const stepPast = hit.distance + 2 * ENEMY_C.projR + 0.05;
    origin = [origin[0] + d[0] * stepPast, origin[1] + d[1] * stepPast, origin[2] + d[2] * stepPast];
    hit = rt.raycast(origin, d, 120);
  }
  onFire(o, hit?.point ?? null);
  sfx('shoot');
  if (hit?.entity && hit.entity.id !== 'player') {
    rt.bus.emit('damage', hit.entity.id!, { other: 'player', amount: FIRE_DAMAGE, point: hit.point });
  }
}
function presentTick(dt: number) {
  if (doorLiftT >= 0) {
    doorLiftT -= dt;
    const k = Math.min(1, 1 - Math.max(0, doorLiftT) / 0.6);
    doorMesh.position.y = WALL_H / 2 + k * (4.5 - WALL_H / 2);
    if (doorLiftT < 0) doorLiftT = -1;
  }
  for (let i = tracers.length - 1; i >= 0; i--) {
    const tr = tracers[i];
    tr.ttl -= dt;
    (tr.line.material as THREE.LineBasicMaterial).opacity = Math.max(0, tr.ttl / 0.06) * 0.9;
    if (tr.ttl <= 0) { rt.scene.remove(tr.line); tr.line.geometry.dispose(); (tr.line.material as THREE.Material).dispose(); tracers.splice(i, 1); }
  }
}

// ---------- HUD / overlays ----------
function mobOf(kind: MobKind): Mob | undefined {
  for (const m of mobs.values()) if (m.kind === kind) return m;
  return undefined;
}
function updateHUD() {
  const hp = rt.player.Health!.current;
  elHP.textContent = String(Math.max(0, Math.ceil(hp)));
  elHealthFill.style.width = `${Math.max(0, (hp / rt.player.Health!.max) * 100)}%`;
  elHealthFill.style.background = hp > 50 ? '#69d17a' : hp > 25 ? '#e8c15a' : '#e86a5a';
  elScore.textContent = String(rt.player.Scored?.points ?? 0);
  elKey.textContent = keyCollected ? '✓ RÉCUPÉRÉE' : '— absente';
  elKey.className = keyCollected ? 'state ok' : 'state warn';
  elDoor.textContent = doorLocked ? 'VERROUILLÉE' : 'OUVERTE';
  elDoor.className = doorLocked ? 'locked' : 'open';
  const sa = mobOf('A')?.state, sb = mobOf('B')?.state, sc = mobOf('C')?.state;
  elEA.textContent = sa ?? '—';
  elEA.className = sa === 'ATTACK' ? 'state bad' : sa === 'ALERT' ? 'state warn' : 'state ok';
  elEB.textContent = sb === 'IDLE' ? 'DORMANT' : sb ?? '—';
  elEB.className = sb === 'CHASE' ? 'state bad' : 'state ok';
  elEC.textContent = sc ?? '—';
  elEC.className = sc === 'DETECTED' ? 'state warn' : 'state ok';
  elTrap.style.display = trapInside ? 'block' : 'none';
}
function showWin() {
  winDetail.textContent = `Temps: ${rt.time.toFixed(1)} s · Score: ${rt.player.Scored?.points ?? 0}`;
  winEl.style.display = 'flex';
  overlay.style.display = 'none';
  document.exitPointerLock?.();
}
function showGameOver() {
  goDetail.textContent = `Tu es tombé dans le donjon · Score: ${rt.player.Scored?.points ?? 0}`;
  goEl.style.display = 'flex';
  overlay.style.display = 'none';
  document.exitPointerLock?.();
}

// ---------- entrées (le core possède l'état d'input/visée — conventions n°3/4) ----------
function bindInput() {
  const keys = new Set<string>();
  function pushInput() {
    const fwd = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    const strafe = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    rt.applyPlayerControl({ move: [fwd, strafe], look: [0, 0], jump: keys.has('Space') });
  }
  document.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    keys.add(e.code);
    pushInput();
    if (e.code === 'KeyE' && document.pointerLockElement === canvas && gameOver === 'none') interact();
  });
  document.addEventListener('keyup', (e) => { keys.delete(e.code); pushInput(); });
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (document.pointerLockElement !== canvas || gameOver !== 'none') return;
    fire();
  });
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas) return;
    const s = rt.playerState();
    rt.setLook(s.yaw - e.movementX * 0.0022, s.pitch - e.movementY * 0.0022);
  });
  overlay.addEventListener('click', () => { canvas.requestPointerLock(); ac(); });
  winEl.addEventListener('click', () => location.reload());
  goEl.addEventListener('click', () => location.reload());
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement === canvas) {
      overlay.style.display = 'none';
      rt.setPaused(false);
    } else if (gameOver === 'none') {
      rt.setPaused(true);
      overlay.style.display = 'flex';
      ovSub.textContent = 'clique pour reprendre';
    }
  });
}

// ---------- boot ----------
async function boot() {
  rt = await createRuntime(canvas, {
    onSound: (n) => sfx(n),
    onFire,
    onPlayerHurt: () => {
      const v = document.createElement('div');
      v.style.cssText = 'position:fixed;inset:0;background:radial-gradient(ellipse at center,transparent 40%,rgba(200,40,30,.45));pointer-events:none;';
      document.body.appendChild(v);
      setTimeout(() => v.remove(), 180);
    },
  });
  await rt.preloadAssets([
    'assets/guardian.glb', 'assets/dungeon_mage.glb', 'assets/dungeon_key.glb',
    'assets/dungeon_spikes.glb', 'assets/ruins_column.glb', 'assets/crate.glb',
  ]);

  // sol (présentation + collider statique)
  const ground = new THREE.Mesh(
    new THREE.BoxGeometry(GROUND_HALF[0] * 2, GROUND_HALF[1] * 2, GROUND_HALF[2] * 2),
    new THREE.MeshStandardMaterial({ color: 0x454038, roughness: 0.95 }),
  );
  ground.position.set(8, -0.25, 2.5);
  rt.scene.add(ground);
  const gDesc = RAPIER.ColliderDesc.cuboid(GROUND_HALF[0], GROUND_HALF[1], GROUND_HALF[2]);
  gDesc.setTranslation(8, -0.25, 2.5);
  rt.world.createCollider(gDesc, rt.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()));

  // murs (présentation + colliders statiques)
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x5d5648, roughness: 0.9 });
  for (const [hx, hz, x, z] of WALLS) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, WALL_H, hz * 2), wallMat);
    m.position.set(x, WALL_H / 2, z);
    rt.scene.add(m);
    const cd = RAPIER.ColliderDesc.cuboid(hx, WALL_H / 2, hz);
    cd.setTranslation(x, WALL_H / 2, z);
    rt.world.createCollider(cd, rt.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()));
  }

  // porte verrouillée (le jeu possède body + collider: déverrouillage = les retirer)
  doorMesh = new THREE.Mesh(
    new THREE.BoxGeometry(DOOR.half[0] * 2, WALL_H, DOOR.half[2] * 2),
    new THREE.MeshStandardMaterial({ color: 0x6a4a2a, roughness: 0.6, metalness: 0.4 }),
  );
  doorMesh.position.set(DOOR.x, WALL_H / 2, DOOR.z);
  rt.scene.add(doorMesh);
  doorBody = rt.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const dDesc = RAPIER.ColliderDesc.cuboid(DOOR.half[0], DOOR.half[1], DOOR.half[2]);
  dDesc.setTranslation(DOOR.x, WALL_H / 2, DOOR.z);
  doorCollider = rt.world.createCollider(dDesc, doorBody);

  // zone de sortie (présentation: dalle + portail, DEHORS du mur est)
  const pad = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.06, 3.4), new THREE.MeshBasicMaterial({ color: 0x59ffa0 }));
  pad.position.set(22.2, 0.03, 0);
  rt.scene.add(pad);
  const portal = new THREE.Mesh(new THREE.BoxGeometry(0.15, 2.6, 3.2), new THREE.MeshBasicMaterial({ color: 0x59ffa0, transparent: true, opacity: 0.55 }));
  portal.position.set(23.5, 1.3, 0);
  rt.scene.add(portal);

  // décor (réutilisation d'assets existants)
  for (const c of COLUMN_POS) rt.spawnAsset('assets/ruins_column.glb', c);
  for (const c of CRATE_POS) rt.spawnAsset('assets/crate.glb', c);

  // piège (présentation GLB + zone logique ci-dessus)
  rt.spawnAsset('assets/dungeon_spikes.glb', SPIKES_POS);
  // clé
  rt.spawnAsset('assets/dungeon_key.glb', KEY_POS);
  // ennemis (tags de scène par override: contexte, pas capacité d'asset)
  const mustSpawn = (asset: string, at: Vec3, tags: string[]) => {
    const e = rt.spawnAsset(asset, at, { tags });
    if (!e) throw new Error(`spawn échec: ${asset}`);
    return e;
  };
  const aEnt = mustSpawn('assets/guardian.glb', WAYPOINTS_A[0], ['enemy', 'enemy_a']);
  mobs.set(aEnt.id!, { kind: 'A', state: 'PATROL', waypoint: 0, cooldown: 0 });
  const bEnt = mustSpawn('assets/guardian.glb', ENEMY_B.wait, ['enemy', 'enemy_b']);
  mobs.set(bEnt.id!, { kind: 'B', state: 'IDLE', waypoint: 0, cooldown: 0 });
  const cEnt = mustSpawn('assets/dungeon_mage.glb', [10.5, 0, 9], ['enemy', 'enemy_c']);
  mobs.set(cEnt.id!, { kind: 'C', state: 'IDLE', waypoint: 0, cooldown: 0 });

  // ================= RULES (gameplay déclaratif) =================
  // Tout ennemi: à 0 vie → score + son + destruction (damage → health.zero → destroy)
  rt.on('enemy', 'health.zero', { do: [A.addScore(50), A.sound('kill'), A.destroy()] });
  // Clé collectée: score + son + destruction de la clé + la porte se déverrouille
  rt.on('dungeon_key', 'key.collected', { do: [A.addScore(100), A.sound('key'), A.destroy()], fn: unlockDoor });
  // Sons des événements d'ennemis / piège / porte
  rt.on('enemy', 'enemy.alert', { do: [A.sound('alert')] });
  rt.on('enemy', 'enemy.fired', { do: [A.sound('shot')] });
  rt.on('player', 'trap.enter', { do: [A.sound('trap')] });
  rt.on('player', 'door.unlocked', { do: [A.sound('door')] });
  // Joueur dans la zone de sortie (clé + porte) → victoire
  rt.on('player', 'player.exited', { do: [A.sound('win')], fn: showWin });
  // Joueur mort → game over (le core émet player.died via health.zero)
  rt.on('player', 'player.died', { fn: () => { if (gameOver === 'none') { gameOver = 'died'; showGameOver(); } } });

  // ================= BOUCLE DE JEU =================
  rt.onTick(() => {
    if (gameOver === 'none') {
      tickTrap();
      const alive = rt.byTag('enemy');
      for (const [id, mob] of [...mobs]) {
        if (!alive.some((e) => e.id === id)) { mobs.delete(id); continue; }
        if (mob.kind === 'A') tickA(id, mob);
        else if (mob.kind === 'B') tickB(id, mob);
        else tickC(id, mob);
      }
      tickProjs();
      checkExit();
    }
    presentTick(FIXED_DT);
    updateHUD();
  });

  bindInput();
  rt.setLook(-Math.PI / 2, 0);
  rt.setPaused(true);
  rt.start();
  updateHUD();

  // HOOKS AGENT (test headless, pas de pointer lock) — pattern validé jeux #1/#2/#3
  const dbg = (window as any).GameLoom._debug;
  dbg.gameFire = () => { fire(); };
  dbg.gameInteract = () => { interact(); };
  dbg.rayProbe = (o: Vec3, d: Vec3, dist: number) => {
    const h = rt.raycast(o, d, dist);
    return h ? { id: h.entity?.id ?? null, point: h.point, distance: h.distance } : null;
  };
  dbg.dungeonState = () => {
    const enemyList: unknown[] = [];
    for (const [id, mob] of mobs) {
      const b = bodyOf(id);
      if (!b) continue;
      const ent = rt.byTag('enemy').find((e) => e.id === id);
      const t = b.translation();
      enemyList.push({
        id, kind: mob.kind, state: mob.state, waypoint: mob.waypoint, cooldown: mob.cooldown,
        health: ent?.Health ? ent.Health.current : null,
        pos: [t.x, t.y, t.z],
      });
    }
    return {
      key: { pos: KEY_POS, collected: keyCollected },
      door: { locked: doorLocked, open: doorOpen },
      trap: { x1: TRAP.x1, x2: TRAP.x2, zMax: TRAP.zMax, inside: trapInside },
      exit: { xMin: EXIT.xMin, xMax: EXIT.xMax, zMax: EXIT.zMax, active: keyCollected && doorOpen },
      won, dead: gameOver === 'died', gameOver,
      enemies: enemyList,
      projectiles: projs.map((pr) => { const t = pr.body.translation(); return [t.x, t.y, t.z]; }),
      score: rt.player.Scored?.points ?? 0,
    };
  };
  console.log('[Dungeon Assault] prêt — clique pour jouer');
}
boot().catch((err) => {
  console.error('[Dungeon Assault] boot échec:', err);
  ovSub.textContent = 'ERREUR AU BOOT — voir console';
});
