// Barrel Blaster — jeu de test GameLoom v0.1
// Séparation stricte:
//   - RULES déclaratives: on(tag, event, {if, do})  → le "gameplay"
//   - CODE DE JEU: tir, vagues, munitions, HUD, audio, visuels → TypeScript

import * as THREE from 'three';
import { createRuntime, A, FIXED_DT } from '../core';
import type { Runtime, Vec3 } from '../core';

// ---------- DOM ----------
const $ = (id: string) => document.getElementById(id)!;
const canvas = $('game') as HTMLCanvasElement;
const elScore = $('hud-score'), elWave = $('hud-wave'), elHP = $('hud-hp');
const elAmmo = $('hud-ammo'), elHealthFill = $('health-fill');
const overlay = $('overlay'), ovSub = $('ov-sub'), gameoverEl = $('gameover');
const goTitle = $('go-title'), goDetail = $('go-detail'), statsBar = $('stats-bar');

// ---------- constantes de jeu (spécifique Barrel Blaster) ----------
const WAVE_MAX = 3;
const WAVE_SIZE: { barrels: number; targets: number }[] = [
  { barrels: 5, targets: 4 },
  { barrels: 7, targets: 5 },
  { barrels: 9, targets: 6 },
];
const FIRE_DAMAGE = 30;
const FIRE_COOLDOWN_S = 0.13;
const MAG_SIZE = 30;
const RELOAD_S = 1.2;
const WAVE_DELAY_S = 2.5;

// positions de spawn (arène 24x24) — y=0: convention "origine à la base", le collider (centré en local) repose au sol
const SPAWN_POINTS: Vec3[] = [
  [7, 0, -6], [-7, 0, 6], [6, 0, 7], [-6, 0, -7],
  [0, 0, -9], [9, 0, 0], [-9, 0, 0], [3, 0, 4],
  [-3, 0, -4], [8, 0, -3], [-8, 0, 3], [2, 0, 8],
];

// ---------- état de jeu ----------
let rt: Runtime;
let ammo = MAG_SIZE;
let reloadEnd = -Infinity;    // rt.time où le rechargement se termine
let lastFireAt = -Infinity;   // rt.time du dernier tir
let wave = 0, waveDelay = 0, gameOverState: 'none' | 'died' | 'victory' = 'none';
const keys = new Set<string>();

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
    if (name === 'shoot') {
      const o = c.createOscillator(); o.type = 'square';
      o.frequency.setValueAtTime(660, t); o.frequency.exponentialRampToValueAtTime(140, t + 0.09);
      const g = c.createGain(); g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.11);
      const n = c.createBufferSource(); n.buffer = noiseBuf(c, 0.08);
      const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 2000;
      const g2 = c.createGain(); g2.gain.setValueAtTime(0.18, t); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
      n.connect(f).connect(g2).connect(c.destination); n.start(t); n.stop(t + 0.08);
    } else if (name === 'explode') {
      const n = c.createBufferSource(); n.buffer = noiseBuf(c, 0.7);
      const f = c.createBiquadFilter(); f.type = 'lowpass';
      f.frequency.setValueAtTime(3000, t); f.frequency.exponentialRampToValueAtTime(120, t + 0.6);
      const g = c.createGain(); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
      n.connect(f).connect(g).connect(c.destination); n.start(t); n.stop(t + 0.7);
      const o = c.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(30, t + 0.5);
      const g2 = c.createGain(); g2.gain.setValueAtTime(0.5, t); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
      o.connect(g2).connect(c.destination); o.start(t); o.stop(t + 0.5);
    } else if (name === 'hit') {
      const o = c.createOscillator(); o.type = 'triangle';
      o.frequency.setValueAtTime(880, t); o.frequency.exponentialRampToValueAtTime(440, t + 0.06);
      const g = c.createGain(); g.gain.setValueAtTime(0.08, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.08);
    } else if (name === 'wave') {
      [440, 660].forEach((fr, i) => {
        const o = c.createOscillator(); o.type = 'triangle'; o.frequency.value = fr;
        const g = c.createGain(); g.gain.setValueAtTime(0.1, t + i * 0.12);
        g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.12 + 0.15);
        o.connect(g).connect(c.destination); o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.16);
      });
    } else if (name === 'reload') {
      const n = c.createBufferSource(); n.buffer = noiseBuf(c, 0.05);
      const g = c.createGain(); g.gain.setValueAtTime(0.1, t + 0.2); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      n.connect(g).connect(c.destination); n.start(t + 0.2); n.stop(t + 0.31);
    }
  } catch { /* audio optionnel */ }
}

// ---------- visuels (présentation) ----------
const tracers: { line: THREE.Line; ttl: number }[] = [];
const flashes: { mesh: THREE.Mesh; ttl: number; max: number }[] = [];
function onFire(origin: Vec3, hit: Vec3 | null) {
  const end = hit ?? [origin[0], origin[1], origin[2]];
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...origin), new THREE.Vector3(...end)]);
  const mat = new THREE.LineBasicMaterial({ color: 0xffe9a0, transparent: true, opacity: 0.9 });
  const line = new THREE.Line(geo, mat);
  rt.scene.add(line);
  tracers.push({ line, ttl: 0.06 });
}
function onExplode(point: Vec3, radius: number) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffb35a, transparent: true, opacity: 0.85, depthWrite: false }),
  );
  mesh.position.set(...point);
  mesh.scale.setScalar(0.1);
  rt.scene.add(mesh);
  flashes.push({ mesh, ttl: 0.35, max: radius * 1.15 });
}
function presentTick(dt: number) {
  for (let i = tracers.length - 1; i >= 0; i--) {
    const tr = tracers[i];
    tr.ttl -= dt;
    (tr.line.material as THREE.LineBasicMaterial).opacity = Math.max(0, tr.ttl / 0.06) * 0.9;
    if (tr.ttl <= 0) { rt.scene.remove(tr.line); tr.line.geometry.dispose(); (tr.line.material as THREE.Material).dispose(); tracers.splice(i, 1); }
  }
  for (let i = flashes.length - 1; i >= 0; i--) {
    const fl = flashes[i];
    fl.ttl -= dt;
    const k = 1 - Math.max(0, fl.ttl) / 0.35;
    fl.mesh.scale.setScalar(0.1 + k * fl.max);
    (fl.mesh.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - k);
    if (fl.ttl <= 0) { rt.scene.remove(fl.mesh); fl.mesh.geometry.dispose(); (fl.mesh.material as THREE.Material).dispose(); flashes.splice(i, 1); }
  }
}

// ---------- HUD ----------
function updateHUD() {
  const p = rt.player;
  elScore.textContent = String(p.Scored?.points ?? 0);
  elWave.textContent = wave > 0 ? `${wave}/${WAVE_MAX}` : '-';
  const hp = p.Health!.current;
  elHP.textContent = String(Math.max(0, Math.ceil(hp)));
  elHealthFill.style.width = `${Math.max(0, (hp / p.Health!.max) * 100)}%`;
  elHealthFill.style.background = hp > 50 ? '#69d17a' : hp > 25 ? '#e8c15a' : '#e86a5a';
  elAmmo.textContent = (reloadEnd !== -Infinity && rt.time < reloadEnd) ? 'RELOAD…' : `${ammo}/${MAG_SIZE}`;
}

// ---------- vagues (code de jeu) ----------
function spawnWave(n: number) {
  wave = n;
  const sz = WAVE_SIZE[n - 1];
  const pts = [...SPAWN_POINTS].sort(() => Math.random() - 0.5);
  for (let i = 0; i < sz.barrels; i++) rt.spawnAsset('assets/barrel.glb', pts[i % pts.length]);
  for (let i = 0; i < sz.targets; i++) rt.spawnAsset('assets/target.glb', pts[(i + 6) % pts.length]);
  sfx('wave');
}

function checkWave() {
  if (gameOverState !== 'none') return;
  if (wave === 0) return;
  const barrels = rt.byTag('barrel').length, targets = rt.byTag('target').length;
  if (barrels === 0 && targets === 0) {
    if (wave >= WAVE_MAX) {
      gameOverState = 'victory';
      showGameOver('victory');
    } else {
      waveDelay = WAVE_DELAY_S;
      elWave.textContent = `${wave}/${WAVE_MAX} ✓`;
    }
  }
}

function showGameOver(kind: 'died' | 'victory') {
  goTitle.textContent = kind === 'victory' ? 'VICTOIRE' : 'GAME OVER';
  goTitle.style.color = kind === 'victory' ? '#7fe0a0' : '#ff7a6a';
  goDetail.textContent = `Score final: ${rt.player.Scored?.points ?? 0} · vagues: ${wave}/${WAVE_MAX}`;
  gameoverEl.style.display = 'block';
  overlay.style.display = 'none';
  document.exitPointerLock?.();
}

// ---------- tir (code de jeu — le hitscan est spécifique) ----------
function eyePos(): Vec3 {
  const s = rt.playerState();
  return [s.pos[0], s.pos[1] + 1.55, s.pos[2]];
}
function lookDir(): Vec3 {
  const s = rt.playerState(); // yaw/pitch vivent dans le core (aimAt/setLook)
  const e = new THREE.Euler(s.pitch, s.yaw, 0, 'YXZ');
  const v = new THREE.Vector3(0, 0, -1).applyEuler(e);
  return [v.x, v.y, v.z];
}
function fire() {
  if (gameOverState !== 'none') return;
  if (reloadEnd !== -Infinity && rt.time < reloadEnd) return;            // rechargement en cours
  if (rt.time - lastFireAt < FIRE_COOLDOWN_S) return;                    // cooldown (temps de jeu)
  if (ammo <= 0) { sfx('reload'); reloadEnd = rt.time + RELOAD_S; lastFireAt = rt.time; return; }
  lastFireAt = rt.time;
  ammo--;
  const o = eyePos(), d = lookDir();
  const hit = rt.raycast(o, d, 120);
  onFire(o, hit?.point ?? null);
  sfx('shoot');
  if (hit?.entity && hit.entity.id !== 'player') {
    rt.bus.emit('damage', hit.entity.id!, { other: 'player', amount: FIRE_DAMAGE, point: hit.point });
  }
}

// ---------- entrées ----------
function bindInput() {
  function pushInput() {
    const fwd = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    const strafe = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    rt.applyPlayerControl({ move: [fwd, strafe], look: [0, 0], jump: keys.has('Space') });
  }
  document.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    keys.add(e.code);
    pushInput();
    if (e.code === 'KeyR' && gameOverState === 'none' && ammo < MAG_SIZE && (reloadEnd === -Infinity || rt.time >= reloadEnd)) {
      reloadEnd = rt.time + RELOAD_S;
      sfx('reload');
    }
  });
  document.addEventListener('keyup', (e) => { keys.delete(e.code); pushInput(); });
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (gameOverState !== 'none') return;
    if (document.pointerLockElement !== canvas) return;
    fire();
  });
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas) return;
    const s = rt.playerState();
    rt.setLook(s.yaw - e.movementX * 0.0022, s.pitch - e.movementY * 0.0022);
  });
  overlay.addEventListener('click', () => {
    if (gameOverState !== 'none') { location.reload(); return; }
    canvas.requestPointerLock();
    ac(); // unlock audio
  });
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement === canvas) {
      overlay.style.display = 'none';
      rt.setPaused(false);
    } else if (gameOverState === 'none') {
      rt.setPaused(true);
      overlay.style.display = 'flex';
      ovSub.textContent = 'clique pour reprendre';
    }
  });
}

// ---------- arène (sol + murs: présentation) ----------
// Les colliders statiques sont ajoutés dans boot() après createRuntime.

// ---------- boot ----------
let RAPIER: typeof import('@dimforge/rapier3d-compat') | null = null;

async function boot() {
  RAPIER = await import('@dimforge/rapier3d-compat');
  await RAPIER.init(); // CALL — await sur la fonction seule n'exécute jamais le wasm

  rt = await createRuntime(canvas, {
    onExplode: (p, r) => { onExplode(p, r); sfx('explode'); },
    onFire,
    onPlayerHurt: () => {
      const v = document.createElement('div');
      v.style.cssText = 'position:fixed;inset:0;background:radial-gradient(ellipse at center,transparent 40%,rgba(200,40,30,.45));pointer-events:none;';
      document.body.appendChild(v);
      setTimeout(() => v.remove(), 180);
    },
  });

  // arène visuelle
  const ground = new THREE.Mesh(
    new THREE.BoxGeometry(26, 0.5, 26),
    new THREE.MeshStandardMaterial({ color: 0x3d4451, roughness: 0.95 }),
  );
  ground.position.y = -0.25;
  rt.scene.add(ground);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x55606e, roughness: 0.85 });
  const WALLS: [number, number, number, number, number, number][] = [
    [26, 3, 0.5, 0, 1.5, -13], [26, 3, 0.5, 0, 1.5, 13],
    [0.5, 3, 26, -13, 1.5, 0], [0.5, 3, 26, 13, 1.5, 0],
  ];
  for (const [sx, sy, sz, x, y, z] of WALLS) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), wallMat);
    m.position.set(x, y, z);
    rt.scene.add(m);
  }

  await rt.preloadAssets(['assets/crate.glb', 'assets/barrel.glb', 'assets/target.glb']);

  // colliders statiques de l'arène (sol + 4 murs)
  const gDesc = RAPIER.ColliderDesc.cuboid(13, 0.25, 13);
  gDesc.setTranslation(0, -0.25, 0);
  rt.world.createCollider(gDesc, rt.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()));
  for (const [sx, sy, sz, x, y, z] of WALLS) {
    const cd = RAPIER.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2);
    cd.setTranslation(x, y, z);
    rt.world.createCollider(cd, rt.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()));
  }
  // caisses décoratives + couverts
  rt.spawnAsset('assets/crate.glb', [4, 0, -4]);
  rt.spawnAsset('assets/crate.glb', [-5, 0, 3]);
  rt.spawnAsset('assets/crate.glb', [0, 0, 6]);
  rt.spawnAsset('assets/crate.glb', [-4, 0, -5]);

  // ================= RULES (gameplay déclaratif) =================
  // Baril: à 0 vie → explose puis se détruit
  rt.on('barrel', 'health.zero', {
    do: [A.explode(), A.destroy()],
  });
  // Cible: à 0 vie → score + son + destruction
  rt.on('target', 'health.zero', {
    do: [A.addScore(100), A.sound('hit'), A.destroy()],
  });
  // Explosion: on notifie le HUD (pas d'action: présentation)
  rt.on('player', 'player.died', {
    fn: () => { if (gameOverState === 'none') { gameOverState = 'died'; showGameOver('died'); } },
  });

  // ================= BOUCLE DE JEU =================
  rt.onTick(() => {
    if (reloadEnd !== -Infinity && rt.time >= reloadEnd) { ammo = MAG_SIZE; reloadEnd = -Infinity; }
    // (input + visée: le core possède l'état — clavier écrit par évènement, _debug.aimAt pour l'agent)
    // vagues
    if (gameOverState === 'none' && waveDelay > 0) {
      waveDelay -= FIXED_DT;
      if (waveDelay <= 0) spawnWave(wave + 1);
    }
    checkWave();
    presentTick(FIXED_DT);
    updateHUD();
  });

  bindInput();
  rt.setPaused(true);
  rt.start();
  spawnWave(1); // première vague immédiate (visible derrière l'overlay)
  // HOOKS AGENT (test headless, pas de pointer lock): tir + visée directs
  const dbg = (window as any).GameLoom._debug;
  dbg.gameFire = () => { fire(); };
  console.log('[Barrel Blaster] prêt — clique pour jouer');
}

boot().catch((err) => {
  console.error('[Barrel Blaster] boot échec:', err);
  ovSub.textContent = 'ERREUR AU BOOT — voir console';
});
