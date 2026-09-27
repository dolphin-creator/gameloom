// Temple Escape — jeu #2 GameLoom v0.1 (aventure/puzzle)
// Séparation stricte (philosophie GameLoom):
//   - RULES déclaratives: rt.on(tag, event, {if, do, fn})  → EVENT → ACTION
//   - CODE DE JEU: séquence du puzzle, porte, zone de sortie, HUD, audio → TypeScript
// Le GLB (switch) = identité + capacités statiques. Le "slot" A/B/C et la séquence
// sont du contexte de scène (tags), PAS des capacités d'asset.
// La porte est un objet du monde (mesh + collider gérés par le jeu sur rt.world/rt.scene,
// comme l'arène de Barrel Blaster) — elle n'est PAS une entité: l'ouverture = removeCollider.

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { createRuntime, A, FIXED_DT } from '../../core';
import type { Runtime, Vec3 } from '../../core';

// ---------- DOM ----------
const $ = (id: string) => document.getElementById(id)!;
const canvas = $('game') as HTMLCanvasElement;
const elSw = { A: $('sw-a'), B: $('sw-b'), C: $('sw-c') } as Record<Slot, HTMLElement>;
const elDoor = $('door-state'), elScore = $('hud-score');
const overlay = $('overlay'), ovSub = $('ov-sub');
const winEl = $('win'), winDetail = $('win-detail');

type Slot = 'A' | 'B' | 'C';

// ---------- le temple (layout monde) ----------
// Intérieur x ∈ [-14,14], z ∈ [-6,6]; cloisons x = ±5 (ouverture z ∈ [-1,1]);
// la porte scelle l'ouverture de sortie (mur est x = 14.25, z ∈ [-1,1]).
const WALL_H = 3;
// [demi-x, demi-y, demi-z, x, y, z] — cuboides statiques (game-owned, sans entité)
const WALLS: [number, number, number, number, number, number][] = [
  [0.25, WALL_H / 2, 6.25, -14.25, WALL_H / 2, 0],            // ouest (plein)
  [14.25, WALL_H / 2, 0.25, 0, WALL_H / 2, -6.25],            // nord
  [14.25, WALL_H / 2, 0.25, 0, WALL_H / 2, 6.25],             // sud
  [0.25, WALL_H / 2, 2.625, 14.25, WALL_H / 2, -3.625],       // est: segment z ∈ [-6.25,-1]
  [0.25, WALL_H / 2, 2.625, 14.25, WALL_H / 2, 3.625],        // est: segment z ∈ [1,6.25]
  [0.2, WALL_H / 2, 2.625, -5, WALL_H / 2, -3.625],           // cloison x=-5 (haut)
  [0.2, WALL_H / 2, 2.625, -5, WALL_H / 2, 3.625],            // cloison x=-5 (bas)
  [0.2, WALL_H / 2, 2.625, 5, WALL_H / 2, -3.625],            // cloison x=+5 (haut)
  [0.2, WALL_H / 2, 2.625, 5, WALL_H / 2, 3.625],             // cloison x=+5 (bas)
];
// Zone de sortie: DEHORS du mur est, au-delà de la porte. Le joueur gagne s'il y
// pénètre physiquement (impossible tant que le collider de la porte existe).
const EXIT_X = 14.55, EXIT_Z_MAX = 1.4;

// Slots (positions fixes — le spawn est déterministe, pas aléatoire)
const SWITCH_POS: Record<Slot, Vec3> = { A: [0, 0, -4], B: [-9, 0, 4], C: [9, 0, -4] };
const SEQ: Slot[] = ['A', 'B', 'C'];      // la séquence logique du puzzle
const SLOTS: Slot[] = ['A', 'B', 'C'];
const INTERACT_DIST = 2.2;

// ---------- état de jeu ----------
let rt: Runtime;
const sw: Record<Slot, boolean> = { A: false, B: false, C: false };
let doorOpen = false, won = false;
let doorLiftT = -1;               // présentation: compte à rebours (temps de jeu) de la montée de la porte
let doorBody: RAPIER.RigidBody;
let doorCollider: RAPIER.Collider;
let doorMesh: THREE.Mesh;
const markers = new Map<Slot, THREE.Mesh>();

// ---------- audio synth (Web Audio, aucun asset) ----------
let actx: AudioContext | null = null;
function ac(): AudioContext {
  if (!actx) actx = new AudioContext();
  if (actx.state === 'suspended') void actx.resume();
  return actx;
}
function noiseBuf(ctx: AudioContext, sec: number) {
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * sec), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
function sfx(name: string) {
  try {
    const c = ac();
    const t = c.currentTime;
    if (name === 'chime') {
      const o = c.createOscillator(); o.type = 'triangle';
      o.frequency.setValueAtTime(660, t); o.frequency.setValueAtTime(990, t + 0.07);
      const g = c.createGain(); g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.2);
    } else if (name === 'deny') {
      const o = c.createOscillator(); o.type = 'square';
      o.frequency.setValueAtTime(170, t); o.frequency.exponentialRampToValueAtTime(110, t + 0.15);
      const g = c.createGain(); g.gain.setValueAtTime(0.14, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.2);
    } else if (name === 'open') {
      const n = c.createBufferSource(); n.buffer = noiseBuf(c, 0.6);
      const f = c.createBiquadFilter(); f.type = 'lowpass';
      f.frequency.setValueAtTime(2500, t); f.frequency.exponentialRampToValueAtTime(150, t + 0.55);
      const g = c.createGain(); g.gain.setValueAtTime(0.4, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
      n.connect(f).connect(g).connect(c.destination); n.start(t); n.stop(t + 0.6);
      const o = c.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.5);
      const g2 = c.createGain(); g2.gain.setValueAtTime(0.4, t); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
      o.connect(g2).connect(c.destination); o.start(t); o.stop(t + 0.5);
    } else if (name === 'win') {
      [523, 659, 784, 1047].forEach((fr, i) => {
        const o = c.createOscillator(); o.type = 'triangle'; o.frequency.value = fr;
        const g = c.createGain(); g.gain.setValueAtTime(0.12, t + i * 0.13);
        g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.13 + 0.2);
        o.connect(g).connect(c.destination); o.start(t + i * 0.13); o.stop(t + i * 0.13 + 0.22);
      });
    }
  } catch { /* audio optionnel */ }
}

// ---------- présentation (marqueurs au-dessus des interrupteurs actifs) ----------
function setMarker(slot: Slot, on: boolean) {
  const m = markers.get(slot);
  if (on && !m) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0x63ff9a }),
    );
    const [x, , z] = SWITCH_POS[slot];
    mesh.position.set(x, 0.95, z);
    rt.scene.add(mesh);
    markers.set(slot, mesh);
  } else if (!on && m) {
    rt.scene.remove(m);
    m.geometry.dispose();
    (m.material as THREE.Material).dispose();
    markers.delete(slot);
  }
}
function presentTick(dt: number) {
  if (doorLiftT >= 0) {
    doorLiftT -= dt;
    const k = Math.min(1, 1 - Math.max(0, doorLiftT) / 0.5);
    doorMesh.position.y = WALL_H / 2 + k * (4.6 - WALL_H / 2);
    if (doorLiftT < 0) doorLiftT = -1;
  }
}

// ---------- HUD ----------
function updateHUD() {
  for (const s of SLOTS) {
    elSw[s].textContent = `${s}: ${sw[s] ? '✓' : '—'}`;
    elSw[s].classList.toggle('on', sw[s]);
  }
  elDoor.textContent = doorOpen ? 'OUVERTE' : 'VERROUILLÉE';
  elDoor.className = doorOpen ? 'open' : 'locked';
  elScore.textContent = String(rt.player.Scored?.points ?? 0);
}

// ---------- porte (objet du monde: le jeu possède le collider) ----------
function openDoor() {
  if (doorOpen) return;
  doorOpen = true;
  doorLiftT = 0.5;                                    // présentation: montée sur 0.5 s de jeu
  rt.world.removeCollider(doorCollider, true);        // gameplay: la voie s'ouvre immédiatement
  rt.world.removeRigidBody(doorBody);
}

// ---------- puzzle (code de jeu: séquence + état) ----------
function nextSlot(): Slot | null {
  for (const s of SEQ) if (!sw[s]) return s;
  return null;
}
function switchId(slot: Slot): string {
  const e = rt.byTag(`sw_${slot.toLowerCase()}`);
  if (!e.length) throw new Error(`interrupteur ${slot} introuvable (tag sw_${slot.toLowerCase()})`);
  return e[0].id!;
}
function interact() {
  if (won || doorOpen) return;                        // après ouverture: les interrupteurs sont inertes
  const p = rt.playerState();
  let best: Slot | null = null, bestD = INTERACT_DIST;
  for (const s of SLOTS) {
    const [sx, , sz] = SWITCH_POS[s];
    const d = Math.hypot(sx - p.pos[0], sz - p.pos[2]);
    if (d <= bestD) { bestD = d; best = s; }
  }
  if (!best) return;                                   // rien à portée
  const id = switchId(best);
  if (best === nextSlot()) {
    sw[best] = true;
    setMarker(best, true);
    rt.bus.emit('switch.activated', id, { other: 'player', data: { slot: best } });
    if (nextSlot() === null) rt.bus.emit('puzzle.completed', id, { other: 'player' });
  } else {
    for (const s of SLOTS) { sw[s] = false; setMarker(s, false); }
    rt.bus.emit('puzzle.reset', id, { other: 'player', data: { slot: best } });
  }
  updateHUD();
}

// ---------- sortie / victoire ----------
function checkExit() {
  if (won || !doorOpen) return;
  const p = rt.playerState();
  if (p.pos[0] > EXIT_X && Math.abs(p.pos[2]) < EXIT_Z_MAX) {
    won = true;
    rt.bus.emit('player.exited', 'player', { other: 'door' });
  }
}
function showWin() {
  winDetail.textContent = `Temps: ${rt.time.toFixed(1)} s · Score: ${rt.player.Scored?.points ?? 0}`;
  winEl.style.display = 'flex';
  overlay.style.display = 'none';
  document.exitPointerLock?.();
}

// ---------- entrées (le core possède l'état d'input/visée — convention n°3/4) ----------
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
    if (e.code === 'KeyE' && document.pointerLockElement === canvas && !won) interact();
  });
  document.addEventListener('keyup', (e) => { keys.delete(e.code); pushInput(); });
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas) return;
    const s = rt.playerState();
    rt.setLook(s.yaw - e.movementX * 0.0022, s.pitch - e.movementY * 0.0022);
  });
  overlay.addEventListener('click', () => { canvas.requestPointerLock(); ac(); });
  winEl.addEventListener('click', () => location.reload());
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement === canvas) {
      overlay.style.display = 'none';
      rt.setPaused(false);
    } else if (!won) {
      rt.setPaused(true);
      overlay.style.display = 'flex';
      ovSub.textContent = 'clique pour reprendre';
    }
  });
}

// ---------- boot ----------
async function boot() {
  rt = await createRuntime(canvas, { onSound: (n) => sfx(n) });
  await rt.preloadAssets(['assets/switch.glb', 'assets/crate.glb']);

  // sol (présentation + collider)
  const ground = new THREE.Mesh(
    new THREE.BoxGeometry(32, 0.5, 16),
    new THREE.MeshStandardMaterial({ color: 0x4a4640, roughness: 0.95 }),
  );
  ground.position.y = -0.25;
  rt.scene.add(ground);
  const gDesc = RAPIER.ColliderDesc.cuboid(16, 0.25, 8);
  gDesc.setTranslation(0, -0.25, 0);
  rt.world.createCollider(gDesc, rt.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()));

  // murs (présentation + colliders)
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x6b6458, roughness: 0.9 });
  for (const [hx, hy, hz, x, y, z] of WALLS) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), wallMat);
    m.position.set(x, y, z);
    rt.scene.add(m);
    const cd = RAPIER.ColliderDesc.cuboid(hx, hy, hz);
    cd.setTranslation(x, y, z);
    rt.world.createCollider(cd, rt.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()));
  }

  // porte (le jeu possède body + collider: ouvrir = les retirer)
  doorMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, WALL_H, 2.2),
    new THREE.MeshStandardMaterial({ color: 0x8a6a3a, roughness: 0.7 }),
  );
  doorMesh.position.set(14.25, WALL_H / 2, 0);
  rt.scene.add(doorMesh);
  doorBody = rt.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const dDesc = RAPIER.ColliderDesc.cuboid(0.3, WALL_H / 2, 1.1);
  dDesc.setTranslation(14.25, WALL_H / 2, 0);
  doorCollider = rt.world.createCollider(dDesc, doorBody);

  // portail de sortie (présentation, dehors du mur est)
  const portal = new THREE.Mesh(
    new THREE.BoxGeometry(0.15, 2.4, 2.0),
    new THREE.MeshBasicMaterial({ color: 0x59ffa0 }),
  );
  portal.position.set(15.6, 1.4, 0);
  rt.scene.add(portal);

  // interrupteurs (GLB = identité + capacités; le slot est un tag de scène)
  for (const s of SLOTS) {
    rt.spawnAsset('assets/switch.glb', SWITCH_POS[s], { tags: ['switch', `sw_${s.toLowerCase()}`] });
  }
  // caisses décoratives (réutilisation de l'asset du jeu #1)
  rt.spawnAsset('assets/crate.glb', [-3, 0, 2]);
  rt.spawnAsset('assets/crate.glb', [3, 0, -2]);
  rt.spawnAsset('assets/crate.glb', [-11, 0, -3]);
  rt.spawnAsset('assets/crate.glb', [11, 0, 3]);

  // ================= RULES (gameplay déclaratif) =================
  // Activation correcte: son + score
  rt.on('switch', 'switch.activated', { do: [A.sound('chime'), A.addScore(25)] });
  // Mauvaise séquence: reset + son
  rt.on('switch', 'puzzle.reset', { do: [A.sound('deny')] });
  // Puzzle terminé: la porte s'ouvre (action sound + code de jeu)
  rt.on('switch', 'puzzle.completed', { do: [A.sound('open')], fn: openDoor });
  // Le joueur franchit la sortie
  rt.on('player', 'player.exited', { do: [A.sound('win')], fn: showWin });

  // ================= BOUCLE DE JEU =================
  rt.onTick(() => {
    checkExit();
    presentTick(FIXED_DT);
    updateHUD();
  });

  bindInput();
  rt.setPaused(true);
  rt.start();
  updateHUD();

  // HOOKS AGENT (test headless, pas de pointer lock)
  const dbg = (window as any).GameLoom._debug;
  dbg.gameInteract = () => { interact(); };
  dbg.templeState = () => ({ switches: { ...sw }, doorOpen, won, seq: SEQ.join('>') });
  console.log('[Temple Escape] prêt — clique pour jouer');
}
boot().catch((err) => {
  console.error('[Temple Escape] boot échec:', err);
  ovSub.textContent = 'ERREUR AU BOOT — voir console';
});
