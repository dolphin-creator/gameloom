// Ruins Raid — jeu #3 GameLoom v0.1 (exploration/action, entité mobile)
// Séparation stricte (philosophie GameLoom):
//   - GLB (guardian/artifact/ruins_column) = IDENTITÉ + CAPACITÉS STATIQUES
//     (collider, physique, Health.max du gardien). AUCUNE logique de comportement.
//   - RULES déclaratives: rt.on(tag, event, {if, do, fn})  → EVENT → ACTION
//   - CODE DE JEU: machine à états du gardien (PATROL/ALERT/ATTACK), patrouille,
//     interaction artefact, grille, zone d'extraction, HUD, audio → TypeScript.
// Mouvement du gardien (kinematic) réalisé CÔTÉ JEU avec les primitives publiques
// existantes: rt.world.bodies + setTranslation/setRotation + rt.raycast.
// Zone d'extraction: inclusion par position dans onTick (même pattern que Temple Escape).

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { createRuntime, A, FIXED_DT } from '../../core';
import type { Runtime, Vec3 } from '../../core';

// ---------- DOM ----------
const $ = (id: string) => document.getElementById(id)!;
const canvas = $('game') as HTMLCanvasElement;
const elHP = $('hud-hp'), elHealthFill = $('health-fill'), elScore = $('hud-score');
const elArt = $('art-state'), elGate = $('gate-state'), elGuard = $('guard-state');
const overlay = $('overlay'), ovSub = $('ov-sub');
const winEl = $('win'), winDetail = $('win-detail');
const goEl = $('gameover'), goDetail = $('go-detail');

// ---------- layout monde (positions fixes, déterministe) ----------
// Intérieur x ∈ [-16,16], z ∈ [-12,12]. Grille dans le mur est (z ∈ [-1.5,1.5]),
// extraction DEHORS du mur est. Joueur spawné au centre (spawn core à l'origine).
const WALL_H = 3;
// [demi-x, demi-y, demi-z, x, y, z] — cuboïdes statiques game-owned
const PERIM: [number, number, number, number, number, number][] = [
  [0.25, WALL_H / 2, 12.5, -16.25, WALL_H / 2, 0],    // ouest (plein)
  [0.25, WALL_H / 2, 5.25, 16.25, WALL_H / 2, -7],    // est segment nord (z ∈ [-12.5,-1.5])
  [0.25, WALL_H / 2, 5.25, 16.25, WALL_H / 2, 7],     // est segment sud  (z ∈ [1.5,12.5])
  [16.5, WALL_H / 2, 0.25, 0, WALL_H / 2, -12.25],    // nord
  [16.5, WALL_H / 2, 0.25, 0, WALL_H / 2, 12.25],     // sud
];
const STUMPS: [number, number, number, number, number, number][] = [
  [0.2, WALL_H / 2, 3.0, -8, WALL_H / 2, -6],         // vestige x=-8, z ∈ [-9,-3]
  [0.2, WALL_H / 2, 3.0, 8, WALL_H / 2, 6],           // vestige x=+8, z ∈ [3,9]
];
const GATE = { x: 16.25, half: [0.3, WALL_H / 2, 1.5] as Vec3 };   // la grille (fermée)
const GROUND = { half: [19, 0.25, 12.5] as Vec3 };                 // sol x ∈ [-19,19]
const EXTRACT_X = 16.5, EXTRACT_Z_MAX = 2.2;
const ART_POS: Vec3 = [12, 0, -8];                                   // artefact (angle NE)
const COLUMN_POS: Vec3[] = [[-4, 0, -4], [4, 0, -4], [-4, 0, 4], [4, 0, 4]];
const CRATE_POS: Vec3[] = [[2, 0, 6], [-10, 0, 8], [6, 0, 9]];

// ---------- gardien: machine à états (code de jeu, PAS dans le GLB) ----------
type GState = 'PATROL' | 'ALERT' | 'ATTACK';
interface GuardianState { state: GState; target: number; cooldown: number }
const G = {
  detect: 5.0,          // portée de détection (m)
  lost: 7.0,            // perte de cible → retour patrouille (m)
  attack: 1.5,          // portée d'attaque (m)
  attackRelease: 2.0,   // ATT→ALERT si dist > attack + 0.5
  patrolSpeed: 2.0,     // m/s
  chaseSpeed: 2.8,      // m/s
  damage: 15,           // dégâts par coup
  coolFirst: 30,        // ticks avant le 1er coup (0.5 s)
  coolMax: 45,          // ticks entre deux coups (0.75 s)
};
// Points de patrouille fixes (boucle W0→W1→W2→W0) autour de l'artefact
const WAYPOINTS: Vec3[] = [[12, 0, -4.5], [15, 0, -8], [12, 0, -11]];
const INTERACT_DIST = 2.2;

// ---------- état de jeu ----------
let rt: Runtime;
let artifactCollected = false;
let gateOpen = false;
let won = false;
let gameOver: 'none' | 'died' | 'victory' = 'none';
let gateLiftT = -1;                     // présentation: montée de la grille (temps de jeu)
let gateBody: RAPIER.RigidBody;
let gateCollider: RAPIER.Collider;
let gateMesh: THREE.Mesh;

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
    if (name === 'artifact') {
      [523, 784, 1047].forEach((fr, i) => {
        const o = c.createOscillator(); o.type = 'triangle'; o.frequency.value = fr;
        const g = c.createGain(); g.gain.setValueAtTime(0.12, t + i * 0.09);
        g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.09 + 0.18);
        o.connect(g).connect(c.destination); o.start(t + i * 0.09); o.stop(t + i * 0.09 + 0.2);
      });
    } else if (name === 'win') {
      [523, 659, 784, 1047].forEach((fr, i) => {
        const o = c.createOscillator(); o.type = 'triangle'; o.frequency.value = fr;
        const g = c.createGain(); g.gain.setValueAtTime(0.12, t + i * 0.13);
        g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.13 + 0.2);
        o.connect(g).connect(c.destination); o.start(t + i * 0.13); o.stop(t + i * 0.13 + 0.22);
      });
    } else if (name === 'alert') {
      const o = c.createOscillator(); o.type = 'square';
      o.frequency.setValueAtTime(190, t); o.frequency.exponentialRampToValueAtTime(320, t + 0.12);
      const g = c.createGain(); g.gain.setValueAtTime(0.1, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.17);
    }
  } catch { /* audio optionnel */ }
}

// ---------- primitives de mouvement (côté jeu, primitives core publiques) ----------
// Le core expose rt.world (Rapier) et pose body.userData = id au spawn →
// le jeu retrouve le rigid body sans API dédiée. Le gardien est kinematic:
// setTranslation() le déplace, le KCC du joueur le traite comme obstacle.
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
// Course vers le joueur avec verrouillage par raycast (le gardien ne traverse
// pas murs/colonnes): rt.raycast exclut déjà la capsule du joueur.
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
    const limit = hit.distance + 0.9 - 0.5; // obstacle à (0.9 + hit.distance) du gardien, on s'arrête 0.5 m avant
    if (limit < step) step = limit;
  }
  if (step < 0.01) { faceBody(b, dx, dz); return; }
  b.setTranslation({ x: t.x + ux * step, y: t.y, z: t.z + uz * step }, true);
  faceBody(b, dx, dz);
}

// ---------- gardien: machine à états + patrouille ----------
function guardianTick() {
  if (gameOver !== 'none') return;
  const list = rt.byTag('guardian');
  const g = list[0];
  if (!g) return;
  const gs = (g as Record<string, unknown>).Guardian as GuardianState;
  const b = bodyOf(g.id!);
  if (!b) return;
  const t = b.translation();
  const p = rt.playerState();
  const dx = p.pos[0] - t.x, dz = p.pos[2] - t.z;
  const dist = Math.hypot(dx, dz);

  // transitions d'état (déterministes, sans aléa)
  if (gs.state === 'PATROL' && dist <= G.detect) {
    gs.state = 'ALERT'; gs.cooldown = 0;
    rt.bus.emit('guardian.alert', g.id!, { other: 'player', data: { state: 'ALERT', dist: round1(dist) } });
  } else if (gs.state === 'ALERT') {
    if (dist <= G.attack) {
      gs.state = 'ATTACK'; gs.cooldown = G.coolFirst;
      rt.bus.emit('guardian.attack', g.id!, { other: 'player', data: { state: 'ATTACK', dist: round1(dist) } });
    } else if (dist > G.lost) {
      gs.state = 'PATROL';
      gs.target = nearestWaypoint(t);
      rt.bus.emit('guardian.lost', g.id!, { other: 'player', data: { state: 'PATROL', waypoint: gs.target } });
    }
  } else if (gs.state === 'ATTACK' && dist > G.attack + 0.5) {
    gs.state = 'ALERT'; gs.cooldown = 0;
    rt.bus.emit('guardian.alert', g.id!, { other: 'player', data: { state: 'ALERT', dist: round1(dist) } });
  }

  // déplacement / action
  if (gs.state === 'PATROL') {
    const wp = WAYPOINTS[gs.target];
    moveBody(b, wp, G.patrolSpeed * FIXED_DT);
    const t2 = b.translation();
    if (Math.hypot(wp[0] - t2.x, wp[2] - t2.z) < 0.2) {
      gs.target = (gs.target + 1) % WAYPOINTS.length;
      rt.bus.emit('guardian.reached', g.id!, { data: { waypoint: gs.target } });
    }
  } else if (gs.state === 'ALERT') {
    chaseBody(b, [p.pos[0], t.y, p.pos[2]], G.chaseSpeed * FIXED_DT);
  } else {
    faceBody(b, dx, dz); // attaque: fixe le joueur
    if (gs.cooldown > 0) gs.cooldown--;
    else if (dist <= G.attack) {
      gs.cooldown = G.coolMax;
      rt.bus.emit('damage', 'player', { other: g.id!, amount: G.damage, point: [t.x, t.y + 1.2, t.z] });
    }
  }
}
function nearestWaypoint(pos: { x: number; y: number; z: number }): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i < WAYPOINTS.length; i++) {
    const d = Math.hypot(WAYPOINTS[i][0] - pos.x, WAYPOINTS[i][2] - pos.z);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
const round1 = (n: number) => Math.round(n * 10) / 10;

// ---------- artefact: interaction (E à proximité) ----------
function interact() {
  if (gameOver !== 'none' || artifactCollected) return;
  const p = rt.playerState();
  const d = Math.hypot(ART_POS[0] - p.pos[0], ART_POS[2] - p.pos[2]);
  if (d > INTERACT_DIST) return;
  artifactCollected = true;
  const a = rt.byTag('artifact')[0];
  rt.bus.emit('artifact.collected', a ? a.id! : 'artifact', { other: 'player', data: { dist: round1(d) } });
}

// ---------- grille (objet du monde possédé par le jeu, pattern porte Temple Escape) ----------
function openGate() {
  if (gateOpen) return;
  gateOpen = true;
  gateLiftT = 0.5;
  rt.world.removeCollider(gateCollider, true);
  rt.world.removeRigidBody(gateBody);
}

// ---------- extraction: victoire SI (et seulement si) l'artefact est récupéré ----------
function checkExtraction() {
  if (gameOver !== 'none' || !artifactCollected) return;
  const p = rt.playerState();
  if (p.pos[0] > EXTRACT_X && Math.abs(p.pos[2]) < EXTRACT_Z_MAX) {
    won = true;
    gameOver = 'victory';
    rt.bus.emit('player.extracted', 'player', { other: 'extraction' });
  }
}

// ---------- HUD / overlays ----------
function updateHUD() {
  const hp = rt.player.Health!.current;
  elHP.textContent = String(Math.max(0, Math.ceil(hp)));
  elHealthFill.style.width = `${Math.max(0, (hp / rt.player.Health!.max) * 100)}%`;
  elHealthFill.style.background = hp > 50 ? '#69d17a' : hp > 25 ? '#e8c15a' : '#e86a5a';
  elScore.textContent = String(rt.player.Scored?.points ?? 0);
  elArt.textContent = artifactCollected ? '✓ RÉCUPÉRÉ' : '— absent';
  elArt.className = artifactCollected ? 'state ok' : 'state warn';
  elGate.textContent = gateOpen ? 'OUVERTE' : 'FERMÉE';
  elGate.className = gateOpen ? 'open' : 'closed';
  const g = rt.byTag('guardian')[0];
  const gs = g ? (g as Record<string, unknown>).Guardian as GuardianState : null;
  const st = gs?.state ?? 'PATROL';
  elGuard.textContent = st;
  elGuard.className = st === 'ATTACK' ? 'state bad' : st === 'ALERT' ? 'state warn' : 'state ok';
}
function showWin() {
  winDetail.textContent = `Temps: ${rt.time.toFixed(1)} s · Score: ${rt.player.Scored?.points ?? 0}`;
  winEl.style.display = 'flex';
  overlay.style.display = 'none';
  document.exitPointerLock?.();
}
function showGameOver() {
  goDetail.textContent = `Le gardien t'a abattu · Score: ${rt.player.Scored?.points ?? 0}`;
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

// ---------- présentation (montée de la grille) ----------
function presentTick(dt: number) {
  if (gateLiftT >= 0) {
    gateLiftT -= dt;
    const k = Math.min(1, 1 - Math.max(0, gateLiftT) / 0.5);
    gateMesh.position.y = WALL_H / 2 + k * (4.8 - WALL_H / 2);
    if (gateLiftT < 0) gateLiftT = -1;
  }
}

// ---------- boot ----------
async function boot() {
  rt = await createRuntime(canvas, {
    onSound: (n) => sfx(n),
    onPlayerHurt: () => {
      const v = document.createElement('div');
      v.style.cssText = 'position:fixed;inset:0;background:radial-gradient(ellipse at center,transparent 40%,rgba(200,40,30,.45));pointer-events:none;';
      document.body.appendChild(v);
      setTimeout(() => v.remove(), 180);
    },
  });
  await rt.preloadAssets(['assets/guardian.glb', 'assets/artifact.glb', 'assets/ruins_column.glb', 'assets/crate.glb']);

  // sol (présentation + collider) — s'étend au-delà du mur est (zone d'extraction)
  const ground = new THREE.Mesh(
    new THREE.BoxGeometry(GROUND.half[0] * 2, 0.5, GROUND.half[2] * 2),
    new THREE.MeshStandardMaterial({ color: 0x4a4640, roughness: 0.95 }),
  );
  ground.position.y = -0.25;
  rt.scene.add(ground);
  const gDesc = RAPIER.ColliderDesc.cuboid(GROUND.half[0], GROUND.half[1], GROUND.half[2]);
  gDesc.setTranslation(0, -0.25, 0);
  rt.world.createCollider(gDesc, rt.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()));

  // murs + vestiges de ruines (présentation + colliders statiques)
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x6b6458, roughness: 0.9 });
  for (const [hx, hy, hz, x, y, z] of [...PERIM, ...STUMPS]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), wallMat);
    m.position.set(x, y, z);
    rt.scene.add(m);
    const cd = RAPIER.ColliderDesc.cuboid(hx, hy, hz);
    cd.setTranslation(x, y, z);
    rt.world.createCollider(cd, rt.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()));
  }

  // grille (le jeu possède body + collider: l'ouverture = les retirer)
  gateMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, WALL_H, 3.0),
    new THREE.MeshStandardMaterial({ color: 0x3a3f4a, roughness: 0.5, metalness: 0.6 }),
  );
  gateMesh.position.set(GATE.x, WALL_H / 2, 0);
  rt.scene.add(gateMesh);
  gateBody = rt.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const dDesc = RAPIER.ColliderDesc.cuboid(GATE.half[0], GATE.half[1], GATE.half[2]);
  dDesc.setTranslation(GATE.x, WALL_H / 2, 0);
  gateCollider = rt.world.createCollider(dDesc, gateBody);

  // zone d'extraction (présentation: dalle + portail lumineux, DEHORS du mur est)
  const pad = new THREE.Mesh(
    new THREE.BoxGeometry(2.4, 0.06, 4.4),
    new THREE.MeshBasicMaterial({ color: 0x59ffa0 }),
  );
  pad.position.set(17.7, 0.03, 0);
  rt.scene.add(pad);
  const portal = new THREE.Mesh(
    new THREE.BoxGeometry(0.15, 2.6, 4.0),
    new THREE.MeshBasicMaterial({ color: 0x59ffa0, transparent: true, opacity: 0.55 }),
  );
  portal.position.set(18.8, 1.3, 0);
  rt.scene.add(portal);

  // colonnes de ruines (GLB = identité + capacités statiques)
  for (const c of COLUMN_POS) rt.spawnAsset('assets/ruins_column.glb', c);
  // caisses obstacles (réutilisation de l'asset du jeu #1)
  for (const c of CRATE_POS) rt.spawnAsset('assets/crate.glb', c);
  // artefact
  rt.spawnAsset('assets/artifact.glb', ART_POS);
  // gardien (GLB = collider + kinematic + Health.max; le comportement est CI-DESSOUS)
  const guardian = rt.spawnAsset('assets/guardian.glb', WAYPOINTS[0]);
  (guardian as Record<string, unknown>).Guardian = { state: 'PATROL', target: 0, cooldown: 0 };

  // ================= RULES (gameplay déclaratif) =================
  // Artefact collecté: score + son + la grille s'ouvre (l'extraction devient active)
  rt.on('artifact', 'artifact.collected', { do: [A.addScore(50), A.sound('artifact')], fn: openGate });
  // Le gardien détecte le joueur
  rt.on('guardian', 'guardian.alert', { do: [A.sound('alert')] });
  // Le joueur atteint l'extraction (artefact en poche) → victoire
  rt.on('player', 'player.extracted', { do: [A.sound('win')], fn: showWin });
  // Le joueur meurt → game over (le core émet player.died via health.zero)
  rt.on('player', 'player.died', { fn: () => { if (gameOver === 'none') { gameOver = 'died'; showGameOver(); } } });

  // ================= BOUCLE DE JEU =================
  rt.onTick(() => {
    guardianTick();
    checkExtraction();
    presentTick(FIXED_DT);
    updateHUD();
  });

  bindInput();
  rt.setPaused(true);
  rt.start();
  updateHUD();

  // HOOKS AGENT (test headless, pas de pointer lock) — pattern validé jeux #1/#2
  const dbg = (window as any).GameLoom._debug;
  dbg.gameInteract = () => { interact(); };
  dbg.ruinsState = () => {
    const g = rt.byTag('guardian')[0];
    const gs = g ? (g as Record<string, unknown>).Guardian as GuardianState : null;
    return {
      artifact: { pos: ART_POS, collected: artifactCollected },
      gate: { open: gateOpen },
      extraction: { active: artifactCollected, x: EXTRACT_X, zMax: EXTRACT_Z_MAX },
      won, dead: gameOver === 'died', gameOver,
      guardian: g && gs
        ? { id: g.id, state: gs.state, waypoint: gs.target, health: g.Health?.current ?? null, cooldown: gs.cooldown }
        : null,
      waypoints: WAYPOINTS,
    };
  };
  console.log('[Ruins Raid] prêt — clique pour jouer');
}
boot().catch((err) => {
  console.error('[Ruins Raid] boot échec:', err);
  ovSub.textContent = 'ERREUR AU BOOT — voir console';
});
