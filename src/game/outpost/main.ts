// Outpost Rescue — jeu #5 GameLoom v0.1 (FPS / rescue tactique low-poly)
// Séparation stricte (philosophie GameLoom):
//   - GLB (survivor/guardian/crate/ruins_column) = IDENTITÉ + CAPACITÉS STATIQUES
//     (collider, physique, Health.max). AUCUN comportement.
//   - RULES déclaratives: rt.on(tag, event, {if, do, fn}) → EVENT → ACTION
//   - CODE DE JEU: 3 survivants (WAITING/FOLLOWING/EVACUATED), 2 ennemis (détection +
//     poursuite + attaque), 2 zones dangereuses (feu/gaz, arêtes enter/exit + dégâts),
//     zone d'évacuation, tir hitscan, HUD, audio → TypeScript.
// Mouvement des entités (survivants/ennemis, kinematic) côté jeu: rt.world.bodies +
// setTranslation/setRotation + verrouillage rt.raycast (pattern validé jeux #3/#4).
// Zones (feu/gaz/évacuation): inclusion AABB dans onTick + booléen previousInside par
// (zone, entité) → événement uniquement sur transition enter/exit (pattern GAMELOOM.md §5).

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { createRuntime, A, FIXED_DT } from '../../core';
import type { Runtime, Vec3 } from '../../core';

// ---------- DOM ----------
const $ = (id: string) => document.getElementById(id)!;
const canvas = $('game') as HTMLCanvasElement;
const elHP = $('hud-hp'), elHealthFill = $('health-fill'), elScore = $('hud-score');
const elEvac = $('evac-count'), elFollowing = $('following-count'), elObjective = $('objective');
const elSA = $('s-a-state'), elSB = $('s-b-state'), elSC = $('s-c-state'), elEnemies = $('enemy-count');
const elDanger = $('danger-warn');
const overlay = $('overlay'), ovSub = $('ov-sub');
const winEl = $('win'), winDetail = $('win-detail');
const goEl = $('gameover'), goDetail = $('go-detail');

// ---------- layout de l'avant-poste (positions fixes, déterministe) ----------
// Extérieur borné: x ∈ [-12.5, 16.5], z ∈ [-10.5, 10.5]. Joueur spawné à l'origine (core).
// Cour centrale ouverte; survivants A (-9,-5), B (-9,7), C (8,-7); évacuation à l'est.
const WALL_H = 3;
// [demi-x, demi-z, x, z] — murs statiques game-owned (y ∈ [0, WALL_H])
const WALLS: [number, number, number, number][] = [
  [14.5, 0.25, 2, -10.5],      // nord
  [14.5, 0.25, 2, 10.5],       // sud
  [0.25, 10.75, -12.5, 0],     // ouest
  [0.25, 10.75, 16.5, 0],      // est
  [0.25, 2, 4, 7],             // couverture: x=4, z ∈ [5,9]
  [0.25, 2, -6, -2],           // couverture: x=-6, z ∈ [-4,0]
  [0.25, 2, 6, 6],             // couverture: x=6, z ∈ [4,8]
];
const GROUND_HALF: Vec3 = [14.25, 0.25, 10.25];          // sol x[-12.25,16.25] z[-10.25,10.25]
const GROUND_POS: Vec3 = [2, -0.25, 0];

// ---------- zones (inclusion AABB, arêtes enter/exit dans onTick) ----------
interface ZoneDef { id: string; x1: number; x2: number; z1: number; z2: number; enterDmg: number; tickDmg: number; every: number }
const DANGER_FIRE: ZoneDef = { id: 'fire', x1: 1, x2: 5, z1: -2, z2: 2, enterDmg: 15, tickDmg: 4, every: 12 };
const DANGER_GAS: ZoneDef = { id: 'gas', x1: -5, x2: -1, z1: 4, z2: 8, enterDmg: 20, tickDmg: 0, every: 0 };
const DANGERS: ZoneDef[] = [DANGER_FIRE, DANGER_GAS];
const EVAC = { x1: 12, x2: 15.5, z1: -2, z2: 2, cx: 13.5 };

// ---------- survivants (3, tags de scène par override) ----------
type SKind = 'A' | 'B' | 'C';
type SState = 'WAITING' | 'FOLLOWING' | 'EVACUATED' | 'DEAD';
interface Survivor { kind: SKind; state: SState }
const survivors = new Map<string, Survivor>();
const SURVIVOR_POS: Record<SKind, Vec3> = { A: [-9, 0, -5], B: [-9, 0, 7], C: [8, 0, -7] };
// Point d'arrêt individuel dans la zone d'évacuation (déterministe, hors aléa)
const EVAC_OFFSET: Record<SKind, Vec3> = { A: [13.0, 0, -0.8], B: [14.0, 0, -0.5], C: [13.5, 0, 0.8] };
const FOLLOW_SPEED = 3.2;           // m/s
const FOLLOW_STOP = 2.2;            // distance cible au joueur (arrêt)
const EVAC_STOP = 0.35;             // arrêt sur le point d'évacuation
const INTERACT_DIST = 2.2;

// ---------- ennemis (2, guardian.glb réutilisé, tags de scène par override) ----------
type EKind = 'E1' | 'E2';
type EState = 'IDLE' | 'CHASE';
interface Mob { kind: EKind; state: EState; cooldown: number; inRange: boolean }
const mobs = new Map<string, Mob>();
const ENEMY = { detect: 8, lost: 10, chase: 2.5, attack: 1.5, damage: 12, coolFirst: 30, coolMax: 45 };
const ENEMY_POS: Record<EKind, Vec3> = { E1: [5, 0, 4], E2: [-4, 0, -5] };

// ---------- décor (réutilisation d'assets existants) ----------
const CRATE_POS: Vec3[] = [[1, 0, 6], [-2, 0, -6], [11, 0, -4]];
const COLUMN_POS: Vec3[] = [[-4, 0, 3], [11, 0, 5]];

// ---------- état de jeu ----------
let rt: Runtime;
let evacCount = 0;
let rescueComplete = false;
let won = false;
let gameOver: 'none' | 'died' | 'victory' = 'none';
let lastFireAt = -Infinity;
const FIRE_DAMAGE = 30;
const FIRE_COOLDOWN_S = 0.25;
const dangerPrev = new Map<string, boolean>();            // `${zone.id}:${entityId}` → inside précédent
const dangerTimers = new Map<string, number>();           // `${zone.id}:${entityId}` → compteurs dégâts périodiques

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
    else if (name === 'recruit') [440, 660, 880].forEach((f, i) => tone('triangle', f, f, 0.12, 0.1, i * 0.07));
    else if (name === 'evac') [523, 784, 1047].forEach((f, i) => tone('triangle', f, f, 0.14, 0.1, i * 0.08));
    else if (name === 'danger') tone('sawtooth', 260, 80, 0.3, 0.15);
    else if (name === 'alert') tone('square', 190, 320, 0.15);
    else if (name === 'win') [523, 659, 784, 1047].forEach((f, i) => tone('triangle', f, f, 0.2, 0.12, i * 0.13));
  } catch { /* audio optionnel */ }
}

// ---------- primitives de mouvement (côté jeu, primitives core publiques) ----------
// Le core pose body.userData = id au spawn → le jeu retrouve le rigid body.
// Kinematic: setTranslation() déplace; le KCC du joueur traite le corps comme obstacle.
function bodyOf(id: string): RAPIER.RigidBody | null {
  for (const b of rt.world.bodies.getAll()) if (b.userData === id) return b as RAPIER.RigidBody;
  return null;
}
function faceBody(b: RAPIER.RigidBody, dx: number, dz: number) {
  if (Math.hypot(dx, dz) < 1e-4) return;
  const yaw = Math.atan2(-dx, -dz);
  b.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
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

// ---------- zones: inclusion AABB ----------
const inZone = (z: { x1: number; x2: number; z1: number; z2: number }, pos: { x: number; z: number }) =>
  pos.x >= z.x1 && pos.x <= z.x2 && pos.z >= z.z1 && pos.z <= z.z2;

// ---------- zones dangereuses (feu/gaz): arêtes enter/exit + dégâts ----------
// Cibles: joueur + survivants vivants. Événement uniquement sur transition (jamais par tick).
function tickDangers() {
  const p = rt.playerState();
  const targets: { id: string; pos: { x: number; z: number } }[] = [{ id: 'player', pos: { x: p.pos[0], z: p.pos[2] } }];
  for (const [id, s] of survivors) {
    if (s.state === 'EVACUATED' || s.state === 'DEAD') continue;
    const b = bodyOf(id);
    if (!b) continue;
    const t = b.translation();
    targets.push({ id, pos: { x: t.x, z: t.z } });
  }
  let playerInDanger = false;
  for (const z of DANGERS) {
    for (const tgt of targets) {
      const inside = inZone(z, tgt.pos);
      const key = `${z.id}:${tgt.id}`;
      const prev = dangerPrev.get(key) ?? false;
      if (inside && !prev) {
        rt.bus.emit('danger.enter', tgt.id, { other: z.id, data: { zone: z.id, x: round1(tgt.pos.x), z: round1(tgt.pos.z), damage: z.enterDmg } });
        if (tgt.id === 'player') playerInDanger = true;
        if (z.enterDmg > 0) rt.bus.emit('damage', tgt.id, { other: z.id, amount: z.enterDmg, point: [tgt.pos.x, 0, tgt.pos.z] });
      } else if (!inside && prev) {
        rt.bus.emit('danger.exit', tgt.id, { other: z.id, data: { zone: z.id } });
        dangerTimers.delete(key);
      } else if (inside && z.tickDmg > 0) {
        const c = (dangerTimers.get(key) ?? 0) + 1;
        if (c >= z.every) { dangerTimers.set(key, 0); rt.bus.emit('damage', tgt.id, { other: z.id, amount: z.tickDmg, point: [tgt.pos.x, 0, tgt.pos.z] }); }
        else dangerTimers.set(key, c);
      }
      dangerPrev.set(key, inside);
    }
  }
  elDanger.style.display = playerInDanger ? 'block' : 'none';
}

// ---------- survivants: E → FOLLOWING, suivi du joueur, zone d'évacuation → EVACUATED ----------
function interact() {
  if (gameOver !== 'none') return;
  const p = rt.playerState();
  let bestId: string | null = null, bestD = INTERACT_DIST;
  for (const [id, s] of survivors) {
    if (s.state !== 'WAITING') continue;
    const b = bodyOf(id);
    if (!b) continue;
    const t = b.translation();
    const d = Math.hypot(t.x - p.pos[0], t.z - p.pos[2]);
    if (d <= bestD) { bestD = d; bestId = id; }
  }
  if (!bestId) return;
  const s = survivors.get(bestId)!;
  s.state = 'FOLLOWING';
  rt.bus.emit('survivor.followed', bestId, { other: 'player', data: { survivor: s.kind, dist: round1(bestD) } });
}
function tickSurvivors() {
  const p = rt.playerState();
  const playerInEvac = inZone(EVAC, { x: p.pos[0], z: p.pos[2] });
  for (const [id, s] of [...survivors]) {
    if (s.state !== 'FOLLOWING') continue;
    const b = bodyOf(id);
    if (!b) continue;
    const t = b.translation();
    const target = playerInEvac ? EVAC_OFFSET[s.kind] : [p.pos[0], t.y, p.pos[2]] as Vec3;
    const d = Math.hypot(target[0] - t.x, target[2] - t.z);
    const stop = playerInEvac ? EVAC_STOP : FOLLOW_STOP;
    if (d > stop) chaseBody(b, target, FOLLOW_SPEED * FIXED_DT);
    // zone d'évacuation: FOLLOWING → EVACUATED (une seule fois, arête implicite par état)
    if (s.state === 'FOLLOWING' && inZone(EVAC, { x: b.translation().x, z: b.translation().z })) {
      s.state = 'EVACUATED';
      evacCount++;
      rt.bus.emit('survivor.evacuated', id, { other: 'evac_zone', data: { survivor: s.kind, count: evacCount } });
      if (evacCount >= 3 && !rescueComplete) {
        rescueComplete = true;
        rt.bus.emit('rescue.completed', 'player', { data: { time: round1(rt.time) } });
      }
    }
  }
}

// ---------- ennemis: détection → poursuite → attaque (kinematic, code de jeu) ----------
function tickEnemies() {
  const p = rt.playerState();
  for (const [id, m] of [...mobs]) {
    const b = bodyOf(id);
    if (!b) { mobs.delete(id); continue; }
    const t = b.translation();
    const dx = p.pos[0] - t.x, dz = p.pos[2] - t.z;
    const dist = Math.hypot(dx, dz);
    if (m.state === 'IDLE' && dist <= ENEMY.detect) {
      m.state = 'CHASE'; m.cooldown = 0;
      rt.bus.emit('enemy.alert', id, { other: 'player', data: { enemy: m.kind, dist: round1(dist) } });
    } else if (m.state === 'CHASE' && dist > ENEMY.lost) {
      m.state = 'IDLE'; m.cooldown = 0;
      rt.bus.emit('enemy.lost', id, { other: 'player', data: { enemy: m.kind } });
      continue;
    }
    if (m.state === 'CHASE') {
      if (dist <= ENEMY.attack) {
        if (!m.inRange) { m.inRange = true; m.cooldown = Math.max(m.cooldown, ENEMY.coolFirst); }
        faceBody(b, dx, dz);
      } else {
        m.inRange = false;
        chaseBody(b, [p.pos[0], t.y, p.pos[2]], ENEMY.chase * FIXED_DT);
      }
      if (m.cooldown > 0) m.cooldown--;
      else if (dist <= ENEMY.attack) {
        m.cooldown = ENEMY.coolMax;
        rt.bus.emit('damage', 'player', { other: id, amount: ENEMY.damage, point: [t.x, t.y + 1.2, t.z] });
      }
    }
  }
}

// ---------- zone d'évacuation: victoire si rescue.completed + joueur dans la zone ----------
function checkEvacWin() {
  if (gameOver !== 'none' || won) return;
  const p = rt.playerState();
  if (rescueComplete && inZone(EVAC, { x: p.pos[0], z: p.pos[2] })) {
    won = true;
    gameOver = 'victory';
    rt.bus.emit('player.extracted', 'player', { other: 'evac_zone', data: { time: round1(rt.time) } });
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
  const hit = rt.raycast(o, d, 120);
  onFire(o, hit?.point ?? null);
  sfx('shoot');
  if (hit?.entity && hit.entity.id !== 'player') {
    rt.bus.emit('damage', hit.entity.id!, { other: 'player', amount: FIRE_DAMAGE, point: hit.point });
  }
}
function presentTick(dt: number) {
  for (let i = tracers.length - 1; i >= 0; i--) {
    const tr = tracers[i];
    tr.ttl -= dt;
    (tr.line.material as THREE.LineBasicMaterial).opacity = Math.max(0, tr.ttl / 0.06) * 0.9;
    if (tr.ttl <= 0) { rt.scene.remove(tr.line); tr.line.geometry.dispose(); (tr.line.material as THREE.Material).dispose(); tracers.splice(i, 1); }
  }
}

// ---------- HUD / overlays ----------
function sStateEl(kind: SKind) { return kind === 'A' ? elSA : kind === 'B' ? elSB : elSC; }
function updateHUD() {
  const hp = rt.player.Health!.current;
  elHP.textContent = String(Math.max(0, Math.ceil(hp)));
  elHealthFill.style.width = `${Math.max(0, (hp / rt.player.Health!.max) * 100)}%`;
  elHealthFill.style.background = hp > 50 ? '#69d17a' : hp > 25 ? '#e8c15a' : '#e86a5a';
  elScore.textContent = String(rt.player.Scored?.points ?? 0);
  elEvac.textContent = `${evacCount} / 3`;
  elEvac.className = evacCount >= 3 ? 'state ok' : 'state warn';
  elFollowing.textContent = String([...survivors.values()].filter((s) => s.state === 'FOLLOWING').length);
  const following = [...survivors.entries()].filter(([, s]) => s.state === 'FOLLOWING').map(([id]) => survivors.get(id)!.kind);
  elObjective.textContent = won
    ? 'OBJECTIF ACCOMPLI — EXTRACTION TERMINÉE'
    : rescueComplete
      ? 'EXTRACTION PRÊTE — ENTRE DANS LA ZONE VERTE'
      : following.length > 0
        ? `ESCORTE ${following.sort().join(', ')} VERS LA ZONE VERTE`
        : 'OBJECTIF: RECRUTE LES 3 SURVIVANTS (E)';
  for (const [id, s] of survivors) {
    const el = sStateEl(s.kind);
    el.textContent = s.state;
    el.className = s.state === 'FOLLOWING' ? 'state ok' : s.state === 'EVACUATED' ? 'state ok' : s.state === 'DEAD' ? 'state bad' : 'state warn';
  }
  elEnemies.textContent = String([...mobs.values()].length);
  elEnemies.className = [...mobs.values()].length > 0 ? 'state bad' : 'state ok';
}
function showWin() {
  winDetail.textContent = `Temps: ${rt.time.toFixed(1)} s · Score: ${rt.player.Scored?.points ?? 0} · Survivants: 3/3`;
  winEl.style.display = 'flex';
  overlay.style.display = 'none';
  document.exitPointerLock?.();
}
function showGameOver() {
  goDetail.textContent = `L'avant-poste t'a eu · Score: ${rt.player.Scored?.points ?? 0}`;
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
    'assets/survivor.glb', 'assets/guardian.glb', 'assets/crate.glb', 'assets/ruins_column.glb',
  ]);

  // sol (présentation + collider statique)
  const ground = new THREE.Mesh(
    new THREE.BoxGeometry(GROUND_HALF[0] * 2, GROUND_HALF[1] * 2, GROUND_HALF[2] * 2),
    new THREE.MeshStandardMaterial({ color: 0x4a4a42, roughness: 0.95 }),
  );
  ground.position.set(...GROUND_POS);
  rt.scene.add(ground);
  const gDesc = RAPIER.ColliderDesc.cuboid(GROUND_HALF[0], GROUND_HALF[1], GROUND_HALF[2]);
  gDesc.setTranslation(GROUND_POS[0], GROUND_POS[1], GROUND_POS[2]);
  rt.world.createCollider(gDesc, rt.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()));

  // murs (présentation + colliders statiques)
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x57534a, roughness: 0.9 });
  for (const [hx, hz, x, z] of WALLS) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, WALL_H, hz * 2), wallMat);
    m.position.set(x, WALL_H / 2, z);
    rt.scene.add(m);
    const cd = RAPIER.ColliderDesc.cuboid(hx, WALL_H / 2, hz);
    cd.setTranslation(x, WALL_H / 2, z);
    rt.world.createCollider(cd, rt.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()));
  }

  // zone d'évacuation (présentation: dalle verte + portail)
  const pad = new THREE.Mesh(new THREE.BoxGeometry(EVAC.x2 - EVAC.x1, 0.06, EVAC.z2 - EVAC.z1), new THREE.MeshBasicMaterial({ color: 0x59ffa0 }));
  pad.position.set(EVAC.cx, 0.03, 0);
  rt.scene.add(pad);
  const portal = new THREE.Mesh(new THREE.BoxGeometry(0.15, 2.6, EVAC.z2 - EVAC.z1), new THREE.MeshBasicMaterial({ color: 0x59ffa0, transparent: true, opacity: 0.55 }));
  portal.position.set(EVAC.x2 + 0.4, 1.3, 0);
  rt.scene.add(portal);

  // zones dangereuses (présentation: dalles translucides, logique dans tickDangers)
  const firePad = new THREE.Mesh(new THREE.BoxGeometry(DANGER_FIRE.x2 - DANGER_FIRE.x1, 0.05, DANGER_FIRE.z2 - DANGER_FIRE.z1), new THREE.MeshBasicMaterial({ color: 0xff6a2a, transparent: true, opacity: 0.6 }));
  firePad.position.set((DANGER_FIRE.x1 + DANGER_FIRE.x2) / 2, 0.025, 0);
  rt.scene.add(firePad);
  const gasPad = new THREE.Mesh(new THREE.BoxGeometry(DANGER_GAS.x2 - DANGER_GAS.x1, 0.5, DANGER_GAS.z2 - DANGER_GAS.z1), new THREE.MeshBasicMaterial({ color: 0x7aff5a, transparent: true, opacity: 0.22 }));
  gasPad.position.set((DANGER_GAS.x1 + DANGER_GAS.x2) / 2, 0.25, (DANGER_GAS.z1 + DANGER_GAS.z2) / 2);
  rt.scene.add(gasPad);

  // décor (réutilisation d'assets existants)
  for (const c of CRATE_POS) rt.spawnAsset('assets/crate.glb', c);
  for (const c of COLUMN_POS) rt.spawnAsset('assets/ruins_column.glb', c);

  // survivants (tags de scène par override: contexte, pas capacité d'asset)
  const mustSpawn = (asset: string, at: Vec3, tags: string[]) => {
    const e = rt.spawnAsset(asset, at, { tags });
    if (!e) throw new Error(`spawn échec: ${asset}`);
    return e;
  };
  (['A', 'B', 'C'] as SKind[]).forEach((kind) => {
    const e = mustSpawn('assets/survivor.glb', SURVIVOR_POS[kind], ['survivor', `survivor_${kind.toLowerCase()}`]);
    survivors.set(e.id!, { kind, state: 'WAITING' });
  });
  // ennemis (guardian.glb réutilisé: kinematic + Health.max=100)
  (['E1', 'E2'] as EKind[]).forEach((kind) => {
    const e = mustSpawn('assets/guardian.glb', ENEMY_POS[kind], ['enemy', `enemy_${kind.toLowerCase()}`]);
    mobs.set(e.id!, { kind, state: 'IDLE', cooldown: 0, inRange: false });
  });

  // ================= RULES (gameplay déclaratif) =================
  // Ennemi à 0 vie: score + son + destruction + événement de jeu
  rt.on('enemy', 'health.zero', {
    do: [A.addScore(100), A.sound('kill'), A.destroy()],
    fn: (ctx) => { rt.bus.emit('enemy.killed', ctx.entity, { other: 'player', data: { score: 100 } }); },
  });
  // Survivant à 0 vie (zones dangereuses): marqué DEAD + destruction
  rt.on('survivor', 'health.zero', {
    fn: (ctx) => {
      const ent = survivors.get(ctx.entity);
      if (ent && ent.state !== 'DEAD') {
        ent.state = 'DEAD';
        rt.bus.emit('survivor.died', ctx.entity, { data: { survivor: ent.kind } });
      }
    },
    do: [A.destroy()],
  });
  // Sons des événements de jeu
  rt.on('survivor', 'survivor.followed', { do: [A.sound('recruit')] });
  rt.on('survivor', 'survivor.evacuated', { do: [A.sound('evac')] });
  rt.on('player', 'danger.enter', { do: [A.sound('danger')] });
  rt.on('enemy', 'enemy.alert', { do: [A.sound('alert')] });
  rt.on('player', 'rescue.completed', { do: [A.sound('evac')] });
  // Victoire: joueur dans la zone après rescue.completed
  rt.on('player', 'player.extracted', { do: [A.sound('win')], fn: showWin });
  // Joueur mort → game over (le core émet player.died via health.zero)
  rt.on('player', 'player.died', { fn: () => { if (gameOver === 'none') { gameOver = 'died'; showGameOver(); } } });

  // ================= BOUCLE DE JEU =================
  rt.onTick(() => {
    if (gameOver === 'none') {
      tickDangers();
      tickSurvivors();
      tickEnemies();
      checkEvacWin();
    }
    presentTick(FIXED_DT);
    updateHUD();
  });

  bindInput();
  rt.setLook(-Math.PI / 2, 0);
  rt.setPaused(true);
  rt.start();
  updateHUD();

  // HOOKS AGENT (test headless, pas de pointer lock) — pattern validé jeux #1–#4
  const dbg = (window as any).GameLoom._debug;
  dbg.gameFire = () => { fire(); };
  dbg.gameInteract = () => { interact(); };
  dbg.rayProbe = (o: Vec3, d: Vec3, dist: number) => {
    const h = rt.raycast(o, d, dist);
    return h ? { id: h.entity?.id ?? null, point: h.point, distance: h.distance } : null;
  };
  dbg.outpostState = () => {
    const p = rt.playerState();
    const sList: unknown[] = [];
    for (const [id, s] of survivors) {
      const b = bodyOf(id);
      const ent = rt.byTag('survivor').find((e) => e.id === id);
      const t = b ? b.translation() : null;
      sList.push({
        id, kind: s.kind, state: s.state,
        health: ent?.Health ? ent.Health.current : null,
        pos: t ? [t.x, t.y, t.z] : null,
      });
    }
    const eList: unknown[] = [];
    for (const [id, m] of mobs) {
      const b = bodyOf(id);
      if (!b) continue;
      const ent = rt.byTag('enemy').find((e) => e.id === id);
      const t = b.translation();
      eList.push({ id, kind: m.kind, state: m.state, cooldown: m.cooldown, health: ent?.Health ? ent.Health.current : null, pos: [t.x, t.y, t.z] });
    }
    return {
      survivors: sList,
      enemies: eList,
      evac: {
        x1: EVAC.x1, x2: EVAC.x2, z1: EVAC.z1, z2: EVAC.z2,
        playerInside: inZone(EVAC, { x: p.pos[0], z: p.pos[2] }),
        survivorInside: [...survivors.entries()].filter(([id, s]) => {
          const b = bodyOf(id);
          return b ? inZone(EVAC, { x: b.translation().x, z: b.translation().z }) : false;
        }).map(([id]) => survivors.get(id)!.kind),
      },
      dangers: DANGERS.map((z) => ({
        id: z.id, x1: z.x1, x2: z.x2, z1: z.z1, z2: z.z2,
        playerInside: inZone(z, { x: p.pos[0], z: p.pos[2] }),
        inside: [...dangerPrev.entries()].filter(([k, v]) => k.startsWith(`${z.id}:`) && v).map(([k]) => k.split(':')[1]),
      })),
      evacCount, rescueComplete, won, dead: gameOver === 'died', gameOver,
      score: rt.player.Scored?.points ?? 0,
    };
  };
  console.log('[Outpost Rescue] prêt — clique pour jouer');
}
boot().catch((err) => {
  console.error('[Outpost Rescue] boot échec:', err);
  ovSub.textContent = 'ERREUR AU BOOT — voir console';
});
