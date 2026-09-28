// Game #7 — CARGO RUN
// Dépôt industriel : ramasser 3 cellules d'énergie (E), les transporter (une seule à la
// fois), les installer dans le bon socket (E), alimenter la porte et sortir. Q = abandonner.
// Gameplay déterministe : état dans l'ECS / code jeu, temps en rt.time, déplacement par ticks.

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { createRuntime, FIXED_DT } from '../../core';
import type { Runtime } from '../../core';

declare global {
  interface Window {
    GameLoom: {
      stats(): { tick: number };
      _debug: Record<string, unknown> & { teleportPlayer(x: number, y: number, z: number): void };
    };
  }
}

// ---------- constantes de gameplay ----------
type CellKey = 'A' | 'B' | 'C';
const KEYS: CellKey[] = ['A', 'B', 'C'];

const START: [number, number, number] = [-8, 0, 0];
const CELL_DEFS: Record<CellKey, [number, number, number]> = {
  A: [-6.5, 0, 3.5],
  B: [2.5, 0, -5.5],
  C: [6.5, 0, 4.5],
};
const SOCKET_DEFS: Record<CellKey, [number, number, number]> = {
  A: [-4, 0, -7],
  B: [0, 0, -7],
  C: [4, 0, -7],
};
const SOCKET_TOP_Y = 0.56;      // plate supérieure du socket.glb
const CARRY_DIST = 1.0;         // distance XZ derrière le joueur (transport)
const CARRY_Y = 0.35;           // hauteur du portage
const DROP_Y = 0.05;            // hauteur du dépôt libre
const INTERACT_RANGE = 1.6;     // portée E (ramasser / installer)
const DOOR_ANIM_Y = 4.8;        // position finale du mesh porte (présentation)

// ---------- état ----------
type CellPhase = 'world' | 'carried' | 'installed';
interface CellRec { id: string; key: CellKey; phase: CellPhase; }

let rt: Runtime;
let cells: Record<CellKey, CellRec> = { A: null as never, B: null as never, C: null as never };
let socketIds: Record<CellKey, string> = { A: '', B: '', C: '' };
let cargo: CellKey | null = null;
let power = 0;
let doorOpen = false;
let victory = false;
let powered: Record<CellKey, boolean> = { A: false, B: false, C: false };

let msg = '';
let msgUntil = -1;
let doorBody: RAPIER.RigidBody | null = null;
let doorCol: RAPIER.Collider | null = null;
let doorMesh: THREE.Mesh | null = null;
const glows: Partial<Record<CellKey, THREE.Mesh>> = {};

// ---------- DOM ----------
const hudPower = document.getElementById('hud-power') as HTMLDivElement;
const hudCargo = document.getElementById('hud-cargo') as HTMLDivElement;
const hudMsg = document.getElementById('hud-msg') as HTMLDivElement;
const overlay = document.getElementById('overlay') as HTMLDivElement;

function updateHud() {
  hudPower.textContent = `POWER: ${power}/3`;
  hudCargo.textContent = `CARGO: ${cargo ? `CELL ${cargo}` : 'NONE'}`;
}
function hudMsgSet(text: string) {
  msg = text;
  msgUntil = rt.time + 2.5;
  hudMsg.textContent = msg;
}

// ---------- monde de jeu (sol / murs / porte — sans entité ECS) ----------
function staticBox(
  size: [number, number, number],
  center: [number, number, number],
  color: number,
  emissive = 0x000000,
): { body: RAPIER.RigidBody; mesh: THREE.Mesh } {
  const body = rt.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const col = RAPIER.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2);
  col.setTranslation(center[0], center[1], center[2]);
  rt.world.createCollider(col, body);
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(size[0], size[1], size[2]),
    new THREE.MeshStandardMaterial({ color, emissive }),
  );
  mesh.position.set(center[0], center[1], center[2]);
  rt.scene.add(mesh);
  return { body, mesh };
}
function decal(size: [number, number, number], center: [number, number, number], color: number) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), new THREE.MeshBasicMaterial({ color }));
  mesh.position.set(center[0], center[1], center[2]);
  rt.scene.add(mesh);
}

function buildMap() {
  rt.scene.background = new THREE.Color(0x11161d);
  rt.scene.fog = new THREE.Fog(0x11161d, 20, 48);
  const amb = new THREE.AmbientLight(0xbfd0e0, 0.6);
  rt.scene.add(amb);
  const dir = new THREE.DirectionalLight(0xfff2d8, 1.4);
  dir.position.set(8, 16, 6);
  rt.scene.add(dir);

  // sol (y=0 en surface) — couvre le dépôt + la cour extérieure
  staticBox([25, 0.5, 17], [2, -0.25, 0], 0x2a3038);
  // murs (hauteur 3)
  staticBox([0.5, 3, 17], [-10.25, 1.5, 0], 0x3d4854);    // ouest
  staticBox([25, 3, 0.5], [2, 1.5, -8.25], 0x3d4854);    // nord
  staticBox([25, 3, 0.5], [2, 1.5, 8.25], 0x3d4854);     // sud
  staticBox([0.5, 3, 6.5], [10.25, 1.5, -5.25], 0x3d4854); // est (segment nord, ouverture z −2..2)
  staticBox([0.5, 3, 6.5], [10.25, 1.5, 5.25], 0x3d4854);  // est (segment sud)
  staticBox([0.5, 0.8, 4], [10.25, 3.6, 0], 0x3d4854);     // linteau au-dessus de la porte (y 3.2..4)

  // zones marquées au sol (présentation)
  decal([3, 0.02, 3], [-8, 0.01, 0], 0x2e5a7a);          // zone de départ
  decal([3, 0.02, 6], [12.1, 0.01, 0], 0x1d4d33);        // zone de sortie

  // obstacles / couvertures / décor (assets existants)
  rt.spawnAsset('assets/crate.glb', [-3, 0, -3]);
  rt.spawnAsset('assets/crate.glb', [0.5, 0, 2.5]);
  rt.spawnAsset('assets/crate.glb', [5, 0, -3.5]);
  rt.spawnAsset('assets/crate.glb', [-6.5, 0, -4.5]);
  rt.spawnAsset('assets/crate.glb', [3, 0, 6]);
  rt.spawnAsset('assets/crate.glb', [-8.5, 0, 5.5]);
  rt.spawnAsset('assets/ruins_column.glb', [-9, 0, -6.5]);
  rt.spawnAsset('assets/ruins_column.glb', [-9, 0, 6.5]);
  rt.spawnAsset('assets/ruins_column.glb', [8.5, 0, -6.5]);

  // porte de sortie (collider réel — son état bloque réellement le passage)
  doorBody = rt.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const dcol = RAPIER.ColliderDesc.cuboid(0.25, 1.6, 2);
  dcol.setTranslation(10.25, 1.6, 0);
  doorCol = rt.world.createCollider(dcol, doorBody);
  doorMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 3.2, 4),
    new THREE.MeshStandardMaterial({ color: 0x77828f, metalness: 0.55, roughness: 0.4, emissive: 0x1a222c }),
  );
  doorMesh.position.set(10.25, 1.6, 0);
  rt.scene.add(doorMesh);
}

function spawnEntities() {
  for (const k of KEYS) {
    const c = rt.spawnAsset('assets/energy_cell.glb', CELL_DEFS[k], { tags: ['cell', `cell_${k.toLowerCase()}`] });
    if (!c) throw new Error(`spawn cell ${k} impossible`);
    const cid = c.id;
    if (typeof cid !== 'string' || !cid) throw new Error(`spawn cell ${k}: id manquant`);
    cells[k] = { id: cid, key: k, phase: 'world' };
    const s = rt.spawnAsset('assets/socket.glb', SOCKET_DEFS[k], { tags: ['socket', `socket_${k.toLowerCase()}`] });
    if (!s) throw new Error(`spawn socket ${k} impossible`);
    const sid = s.id;
    if (typeof sid !== 'string' || !sid) throw new Error(`spawn socket ${k}: id manquant`);
    socketIds[k] = sid;
    // barre de glow (présentation) — allumée quand le socket est alimenté
    const glow = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.07, 0.4),
      new THREE.MeshStandardMaterial({ color: 0x0e3320, emissive: 0x2eff6a, emissiveIntensity: 1.8 }),
    );
    glow.position.set(SOCKET_DEFS[k][0], SOCKET_TOP_Y + 0.01, SOCKET_DEFS[k][2]);
    glow.visible = false;
    rt.scene.add(glow);
    glows[k] = glow;
  }
}

// ---------- helpers ----------
function bodyOf(id: string): RAPIER.RigidBody | null {
  for (const b of rt.world.bodies.getAll()) if (b.userData === id) return b;
  return null;
}
function distXZ(px: number, pz: number, t: [number, number, number]): number {
  return Math.hypot(px - t[0], pz - t[2]);
}

// ---------- règles de gameplay ----------
function pickUp(k: CellKey) {
  if (cargo) { hudMsgSet('DEJA EN PORTEE — une seule cellule a la fois'); return; }
  cells[k].phase = 'carried';
  cargo = k;
  rt.bus.emit('cargo.pickup', cells[k].id, { data: { cell: k } });
  hudMsgSet(`CARGO : CELL ${k} — porte-la jusqu'a son socket`);
  updateHud();
}

function install(k: CellKey) {
  const c = cells[k];
  const s = SOCKET_DEFS[k];
  const b = bodyOf(c.id);
  if (b) b.setTranslation({ x: s[0], y: SOCKET_TOP_Y, z: s[2] }, true);
  c.phase = 'installed';
  powered[k] = true;
  cargo = null;
  power += 1;
  if (glows[k]) glows[k].visible = true;
  rt.bus.emit('socket.powered', socketIds[k], { data: { socket: k, power } });
  rt.bus.emit('cargo.install', c.id, { other: socketIds[k], data: { cell: k, socket: k, power } });
  hudMsgSet(`CELL ${k} INSTALLEE — POWER ${power}/3`);
  if (power === 3) {
    rt.bus.emit('power.complete', 'player', { data: { power: 3 } });
    openDoor();
  }
  updateHud();
}

function openDoor() {
  if (doorOpen) return;
  doorOpen = true;
  if (doorCol) rt.world.removeCollider(doorCol, true);
  if (doorBody) rt.world.removeRigidBody(doorBody);
  doorCol = null;
  doorBody = null;
  rt.bus.emit('door.opened', 'player', { data: { power: 3 } });
  hudMsgSet('ALIMENTATION COMPLETE — PORTE DEVERROUEE');
}

function interact() {
  const ps = rt.playerState();
  const px = ps.pos[0], pz = ps.pos[2];

  if (cargo) {
    // tentative d'installation sur le socket le plus proche à portée
    let best: CellKey | null = null;
    let bd = INTERACT_RANGE;
    for (const k of KEYS) {
      const d = distXZ(px, pz, SOCKET_DEFS[k]);
      if (d <= bd) { bd = d; best = k; }
    }
    if (!best) { hudMsgSet('AUCUN SOCKET A PORTEE'); return; }
    if (powered[best]) { hudMsgSet(`SOCKET ${best} DEJA ALIMENTE`); return; }
    if (best !== cargo) {
      rt.bus.emit('cargo.reject', cells[cargo].id, { other: socketIds[best], data: { cell: cargo, socket: best } });
      hudMsgSet(`DEPOT REFUSE : CELL ${cargo} != SOCKET ${best}`);
      return;
    }
    install(cargo);
    return;
  }

  // ramassage de la cellule la plus proche (état world uniquement)
  let best: CellKey | null = null;
  let bd = INTERACT_RANGE;
  for (const k of KEYS) {
    const c = cells[k];
    if (c.phase !== 'world') continue;
    const p = rt.entityPosition(c.id);
    if (!p) continue;
    const d = Math.hypot(px - p[0], pz - p[2]);
    if (d <= bd) { bd = d; best = k; }
  }
  if (!best) { hudMsgSet('RIEN A RAMASSER A PORTEE'); return; }
  pickUp(best);
}

function dropCargo() {
  if (!cargo) { hudMsgSet('RIEN A ABANDONNER'); return; }
  const k = cargo;
  const ps = rt.playerState();
  const px = ps.pos[0], pz = ps.pos[2];
  const dx = Math.sin(ps.yaw), dz = Math.cos(ps.yaw); // direction « derrière » le joueur
  const hit = rt.raycast([px, 0.9, pz], [dx, 0, dz], CARRY_DIST);
  const d = hit ? Math.max(0.4, hit.distance - 0.3) : CARRY_DIST;
  const b = bodyOf(cells[k].id);
  if (b) b.setTranslation({ x: px + dx * d, y: DROP_Y, z: pz + dz * d }, true);
  cells[k].phase = 'world';
  cargo = null;
  rt.bus.emit('cargo.drop', cells[k].id, { data: { cell: k } });
  hudMsgSet(`CELL ${k} ABANDONNEE (disponible) — Q rejoue`);
  updateHud();
}

function win() {
  if (victory) return;
  victory = true;
  rt.bus.emit('game.victory', 'player', { data: { power: 3, doorOpen: true } });
  overlay.style.display = 'flex';
  hudMsgSet('CARGO COMPLETE — EXIT REACHED');
}

// ---------- input (écriture par événement clavier, convention 3) ----------
const canvas = document.getElementById('game') as HTMLCanvasElement;
const heldKeys = new Set<string>();
function moveVec(): [number, number] {
  let fwd = 0, strafe = 0;
  if (heldKeys.has('KeyW') || heldKeys.has('ArrowUp')) fwd += 1;
  if (heldKeys.has('KeyS') || heldKeys.has('ArrowDown')) fwd -= 1;
  if (heldKeys.has('KeyA') || heldKeys.has('ArrowLeft')) strafe -= 1;
  if (heldKeys.has('KeyD') || heldKeys.has('ArrowRight')) strafe += 1;
  return [fwd, strafe];
}

function setupInput() {
  const writeControl = (jump: boolean) => rt.applyPlayerControl({ move: moveVec(), look: [0, 0], jump });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyE') { if (!e.repeat) interact(); return; }
    if (e.code === 'KeyQ') { if (!e.repeat) dropCargo(); return; }
    if (e.code === 'Space') { writeControl(true); e.preventDefault(); return; }
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') e.preventDefault();
    heldKeys.add(e.code);
    writeControl(false);
  });
  window.addEventListener('keyup', (e) => {
    heldKeys.delete(e.code);
    writeControl(false);
  });
  canvas.addEventListener('click', () => { canvas.requestPointerLock?.(); });
  window.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas) return;
    const ps = rt.playerState();
    const yaw = ps.yaw - e.movementX * 0.0022;
    const pitch = Math.max(-1.45, Math.min(1.45, ps.pitch + e.movementY * 0.0022));
    rt.setLook(yaw, pitch);
  });
}

// ---------- boucle de jeu ----------
function setupTick() {
  rt.onTick(() => {
    // la cellule portée suit le joueur (représentation du transport)
    if (cargo) {
      const ps = rt.playerState();
      const b = bodyOf(cells[cargo].id);
      if (b) {
        b.setTranslation({
          x: ps.pos[0] + Math.sin(ps.yaw) * CARRY_DIST,
          y: CARRY_Y,
          z: ps.pos[2] + Math.cos(ps.yaw) * CARRY_DIST,
        }, true);
      }
    }
    // animation de la porte (présentation — le collider est déjà retiré)
    if (doorOpen && doorMesh) {
      doorMesh.position.y = Math.min(DOOR_ANIM_Y, doorMesh.position.y + 1.6 * FIXED_DT);
      if (doorMesh.position.y >= DOOR_ANIM_Y - 0.001) doorMesh.visible = false;
    }
    // message HUD transitoire (temps de jeu, jamais setTimeout)
    if (msg && rt.time >= msgUntil) {
      msg = '';
      hudMsg.textContent = '';
    }
  });
}

// ---------- zone de sortie (victoire) ----------
function setupExitZone() {
  rt.createZone({
    id: 'exit',
    bounds: { min: [10.6, -3], max: [13.6, 3] },
    tags: ['player'],
    onStay: (eid) => {
      if (eid !== 'player') return;
      if (doorOpen && !victory) win();
    },
  });
}

// ---------- hooks debug (pattern §13) ----------
function setupDebugHooks() {
  const dbg = window.GameLoom._debug;
  dbg.cargoState = () => ({
    tick: window.GameLoom.stats().tick,
    power,
    cargo: cargo ?? 'NONE',
    doorOpen,
    victory,
    cells: {
      A: { state: cells.A.phase, pos: rt.entityPosition(cells.A.id) },
      B: { state: cells.B.phase, pos: rt.entityPosition(cells.B.id) },
      C: { state: cells.C.phase, pos: rt.entityPosition(cells.C.id) },
    },
    sockets: { A: powered.A, B: powered.B, C: powered.C },
  });
  dbg.cargoInteract = () => { interact(); };
  dbg.cargoDrop = () => { dropCargo(); };
}

// ---------- boot ----------
async function boot() {
  rt = await createRuntime(canvas, { onExplode: () => { }, onFire: () => { } });
  await rt.preloadAssets(['assets/energy_cell.glb', 'assets/socket.glb', 'assets/crate.glb', 'assets/ruins_column.glb']);
  buildMap();
  spawnEntities();
  setupExitZone();
  setupInput();
  setupTick();
  setupDebugHooks();
  window.GameLoom._debug.teleportPlayer(START[0], 0, START[2]);
  updateHud();
  rt.setPaused(true);
  rt.start();
}
boot();
