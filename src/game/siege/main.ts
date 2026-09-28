import { createRuntime, A } from '../../core';
import type { Runtime } from '../../core';
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

// ---------- configuration (scène contrôlée: positions fixes, déterministe) ----------
const CRYSTAL_GLB = 'assets/artifact.glb';
const ENEMY_GLB = 'assets/guardian.glb';
const CRYSTAL_POS: [number, number, number] = [0, 0, 0];
const CRYSTAL_HP = 100;
const ENEMY_SPEED = 1.0; // m/s (step = vitesse × FIXED_DT — convention n°3)
const ENEMY_DMG = 25; // dégâts infligés au cristal quand un ennemi atteint la zone
const BULLET_DMG = 30; // dégâts par tir (guardian: 100 HP → 4 tirs)
const ZONE_R = 1.5; // rayon (AABB) de la zone du cristal
const ARENA_HALF = 20;
const PLAYER_SPAWN: [number, number, number] = [0, 0.92, 12];
const ENEMY_SPAWNS: [number, number, number][] = [
  [15, 0, 0],
  [-15, 0, 0],
  [0, 0, 15],
  [0, 0, -15],
  [10.6, 0, -10.6],
];

type GameState = 'playing' | 'victory' | 'defeat';
let rt: Runtime;
let crystalHp = CRYSTAL_HP;
let totalSpawned = 0;
let state: GameState = 'playing';
let lastHudSig = '';

const $ = (id: string) => document.getElementById(id) as HTMLElement;

function updateHud() {
  const enemies = rt.byTag('guardian').length;
  const sig = `${crystalHp}|${enemies}|${state}`;
  if (sig === lastHudSig) return;
  lastHudSig = sig;
  $('hud-crystal').textContent = String(crystalHp);
  $('crystal-fill').style.width = `${(crystalHp / CRYSTAL_HP) * 100}%`;
  $('hud-enemies').textContent = String(enemies);
  const st = $('hud-state');
  st.textContent = state === 'playing' ? 'COMBAT' : state === 'victory' ? 'VICTOIRE' : 'DÉFAITE';
  st.className = 'state ' + (state === 'victory' ? 'ok' : state === 'defeat' ? 'bad' : 'warn');
}

function showEnd() {
  if (state === 'victory') {
    $('win').style.display = 'flex';
    $('win-detail').textContent = `Cristal intact : ${crystalHp}/${CRYSTAL_HP}`;
  } else {
    $('gameover').style.display = 'flex';
    $('go-detail').textContent = 'Le cristal a été détruit.';
  }
}

// ---------- objets du monde possédés par le jeu (sol + murs, sans entité ECS) ----------
function staticBox(w: number, h: number, d: number, x: number, y: number, z: number, color: number) {
  const body = rt.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  body.setTranslation({ x, y, z }, true);
  rt.world.createCollider(RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2), body);
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, roughness: 0.95 }),
  );
  mesh.position.set(x, y, z);
  rt.scene.add(mesh);
}

function buildArena() {
  const s = ARENA_HALF;
  staticBox(2 * s + 1, 0.5, 2 * s + 1, 0, -0.25, 0, 0x1a212c); // sol (surface à y=0)
  staticBox(2 * s + 1, 4, 1, 0, 2, -s, 0x27313f); // mur nord
  staticBox(2 * s + 1, 4, 1, 0, 2, s, 0x27313f); // mur sud
  staticBox(1, 4, 2 * s + 1, -s, 2, 0, 0x27313f); // mur ouest
  staticBox(1, 4, 2 * s + 1, s, 2, 0, 0x27313f); // mur est
}

// ---------- tir hitscan (code de jeu — §5) ----------
function fire() {
  if (state !== 'playing' || !rt) return;
  const s = rt.playerState();
  const origin: [number, number, number] = [s.pos[0], s.pos[1] + 1.55, s.pos[2]];
  const dir: [number, number, number] = [
    -Math.sin(s.yaw) * Math.cos(s.pitch),
    Math.sin(s.pitch),
    -Math.cos(s.yaw) * Math.cos(s.pitch),
  ];
  const hit = rt.raycast(origin, dir, 120);
  if (!hit?.entity) return;
  const hitId = hit.entity.id;
  if (!hitId || hitId === 'player') return;
  rt.bus.emit('damage', hitId, { other: 'player', amount: BULLET_DMG, point: hit.point });
}

async function boot() {
  rt = await createRuntime(document.getElementById('game') as HTMLCanvasElement);
  await rt.preloadAssets([CRYSTAL_GLB, ENEMY_GLB]);
  buildArena();

  rt.spawnAsset(CRYSTAL_GLB, CRYSTAL_POS);
  for (const at of ENEMY_SPAWNS) {
    rt.spawnAsset(ENEMY_GLB, at);
    totalSpawned++;
  }

  rt.createZone({
    id: 'crystal_zone',
    bounds: { min: [-ZONE_R, -ZONE_R], max: [ZONE_R, ZONE_R] },
    tags: ['guardian'],
  });

  // ennemi à 0 HP → destruction
  rt.on('guardian', 'health.zero', { do: [A.destroy()] });

  // ennemi atteint la zone du cristal → dégâts au cristal + retrait de l'ennemi
  rt.on('guardian', 'zone.enter', {
    if: (ctx) => ctx.other === 'crystal_zone',
    fn: (ctx) => {
      if (!ctx.entity || state !== 'playing') return;
      crystalHp = Math.max(0, crystalHp - ENEMY_DMG);
      rt.removeEntity(ctx.entity);
      if (crystalHp <= 0) {
        state = 'defeat';
        showEnd();
      }
      updateHud();
    },
  });

  // chaque tick : les ennemis progressent vers le cristal + condition de victoire
  rt.onTick(() => {
    if (state !== 'playing') return;
    for (const e of rt.byTag('guardian')) {
      if (e.id) rt.moveEntity(e.id, CRYSTAL_POS, ENEMY_SPEED);
    }
    if (totalSpawned > 0 && rt.byTag('guardian').length === 0) {
      state = 'victory';
      showEnd();
    }
    updateHud();
  });

  // input par événement (convention n°2)
  window.addEventListener('mousedown', (ev) => {
    if (ev.button === 0) fire();
  });

  // hooks de jeu (pattern §13)
  const dbg = (window as { GameLoom?: { _debug?: Record<string, unknown> } }).GameLoom?._debug;
  if (dbg) {
    dbg.gameFire = () => fire();
    dbg.siegeState = () => ({ state, crystalHp, totalSpawned, remaining: rt.byTag('guardian').length });
    dbg.siegeTeleportEnemy = (index: number, x: number, z: number) => {
      const list = rt.byTag('guardian');
      const e = list[index];
      if (!e) return null;
      const body = rt.world.bodies.getAll().find((b) => b.userData === e.id);
      if (!body) return null;
      body.setTranslation({ x, y: 0, z }, true);
      return e.id;
    };
  }

  // le core spawn le joueur à (0,2,0) — on le déplace avant le premier tick
  (window as { GameLoom?: { _debug?: { teleportPlayer: (x: number, y: number, z: number) => void } } })
    .GameLoom?._debug?.teleportPlayer(PLAYER_SPAWN[0], PLAYER_SPAWN[1], PLAYER_SPAWN[2]);
  updateHud();
  rt.setPaused(true);
  rt.start();
}

boot();
