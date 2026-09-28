// GameLoom v0.1 — Runtime déterministe
// - timestep fixe 1/60 (accumulateur Gaffer)
// - pause/resume/step(n) : le debug se fait par pas déterministe
// - Rapier: monde + KinematicCharacterController (joueur)
// - Three: rendu = présentation uniquement (le gameplay ne lit jamais le rendu)
// - Règles: on(tag, event, {if, do, fn})
// - Debug API window.GameLoom (JSON compact)

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { EntityT, EventCtx, RuleBlock, GlbMeta, Vec3, MoveEntityOptions, ZoneOptions, ZoneHandle } from './types';
import { createEcs, type EcsApi } from './ecs';
import { createEventBus, type EventBus } from './events';
import { runAction, listActions, registerAction } from './actions';
import { readGlbMeta } from './glbs';

export const FIXED_DT = 1 / 60;
const GRAVITY = -19.62;

// ---------- hooks de présentation (le jeu injecte) ----------
export interface GameHooks {
  onExplode?: (point: Vec3, radius: number) => void;
  onFire?: (origin: Vec3, hit: Vec3 | null) => void;
  onHit?: (entityId: string) => void;
  onPlayerHurt?: (amount: number) => void;
  onSound?: (name: string, gain?: number) => void;
  onPlayerLook?: (yaw: number, pitch: number) => void;
}

export interface Runtime {
  ecs: EcsApi;
  bus: EventBus;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  world: RAPIER.World;
  player: EntityT;
  hooks: GameHooks;
  tick: number;
  time: number;
  paused: boolean;
  on: (target: string, event: string, block: RuleBlock) => () => void;
  spawnAsset: (asset: string, at: Vec3, overrides?: Partial<EntityT>) => EntityT | null;
  preloadAssets: (assets: string[]) => Promise<void>;
  raycast: (origin: Vec3, dir: Vec3, maxDist: number) => { entity: EntityT | null; point: Vec3; distance: number } | null;
  explodeAt: (point: Vec3, radius: number, damage: number, impulse: number, source: string) => void;
  removeEntity: (id: string) => void;
  setPaused: (p: boolean) => void;
  step: (n?: number) => void;
  tickOnce: () => void;
  applyPlayerControl: (ctl: { move: [number, number]; look: [number, number]; jump: boolean }) => void;
  byId: (id: string) => EntityT | undefined;
  byTag: (tag: string) => EntityT[];
  /** v0.2 — translation brute (non arrondie) d'une entité. null si id inconnu/détruit. */
  entityPosition: (id: string) => Vec3 | null;
  /**
   * v0.2 — déplace une entité kinematic vers une destination absolue (XZ, y de l'entité
   * conservé), au plus speed*FIXED_DT par appel (speed en m/s). Kinematic uniquement,
   * jamais sur le player (no-op + console.error). avoidObstacles : verrou legacy prouvé
   * #3–#5 (raycast horizontal y+1,0, départ décalé 0,9 m, arrêt 0,5 m avant l'arête de
   * l'obstacle; step limité à 0,4 m quand le point de sonde est dans l'obstacle).
   * Aucun pathfinding, aucun stop dur. Exclut le joueur ET le body propre.
   * true si une translation a été appliquée, false sinon.
   */
  moveEntity: (id: string, target: Vec3, speed: number, options?: MoveEntityOptions) => boolean;
  /** v0.2 — oriente une entité kinematic vers le target (rotation Y seule), sans déplacer. */
  faceEntity: (id: string, target: Vec3) => void;
  /**
   * v0.2 — zone AABB XZ multi-entités (bornes inclusives, min/max normalisés).
   * tags = UNION, résolus dynamiquement à chaque fixed tick. Évaluée après la passe
   * onTick du jeu, avant l'incrément du tick. Events core: zone.enter / zone.exit
   * (entity = entité observée, other = id de la zone, data = { zone, x, z }).
   */
  createZone: (options: ZoneOptions) => ZoneHandle;
  /** Abonnement à la boucle déterministe (un seul tick après la physique). */
  onTick: (fn: () => void) => () => void;
  playerState: () => { pos: Vec3; yaw: number; pitch: number; grounded: boolean; vel: Vec3 };
  setLook: (yaw: number, pitch: number) => void;
  start: () => void;
  rules: { target: string; event: string; hasIf: boolean; nActions: number; hasFn: boolean }[];
}

interface GltfCache { scene: THREE.Group; meta: GlbMeta | null }

// v0.2 — état interne d'une zone AABB XZ (bornes normalisées x1≤x2, z1≤z2)
interface ZoneState {
  id: string;
  x1: number; x2: number; z1: number; z2: number;
  tags: string[];
  onStay?: (entityId: string) => void;
  inside: Set<string>;
}

let idSeq = 0;
function nextId(prefix: string) { return `${prefix}_${(idSeq++).toString(36).padStart(3, '0')}`; }
function round(n: number) { return Math.round(n * 1000) / 1000; }

export async function createRuntime(canvas: HTMLCanvasElement, hooks: GameHooks = {}): Promise<Runtime> {
  await RAPIER.init(); // CALL — await sur la fonction seule n'exécute jamais le wasm

  // ---------- Three (présentation) ----------
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0e13);
  scene.fog = new THREE.Fog(0x0b0e13, 30, 95);
  const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 200);
  const hemi = new THREE.HemisphereLight(0x9db4d6, 0x2a2320, 1.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2df, 1.7);
  sun.position.set(8, 14, 6);
  scene.add(sun);

  const ecs = createEcs();
  const bus = createEventBus();

  // ---------- Rapier ----------
  const world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
  world.timestep = FIXED_DT;
  const eventQueue = new RAPIER.EventQueue(false);
  const kcc = new RAPIER.KinematicCharacterController(
    0.02, world.integrationParameters, world.broadPhase, world.narrowPhase,
    world.bodies, world.colliders,
  );
  kcc.enableAutostep(0.45, 0.5, false);
  kcc.enableSnapToGround(0.12);
  kcc.setCharacterMass(80);

  // ---------- registres ----------
  const byIdMap = new Map<string, EntityT>();
  const bodyById = new Map<string, RAPIER.RigidBody>();
  const collToEntity = new Map<RAPIER.Collider, string>();
  const gltfCache = new Map<string, GltfCache>();
  const destroyed = new Set<string>();
  const rules: Runtime['rules'] = [];
  const tickFns: Array<() => void> = [];
  const zones = new Map<string, ZoneState>();
  function onTick(fn: () => void) {
    tickFns.push(fn);
    return () => { const i = tickFns.indexOf(fn); if (i >= 0) tickFns.splice(i, 1); };
  }
  const vY = { v: 0 };
  const input = { move: [0, 0] as [number, number], look: [0, 0] as [number, number], jump: false };
  let yaw = 0, pitch = 0;
  const EYE = 1.55;

  const rt: Runtime = {
    ecs, bus, scene, camera, renderer, world, hooks,
    player: null as unknown as EntityT,
    tick: 0, time: 0, paused: false,
    on, spawnAsset, preloadAssets, raycast, explodeAt, removeEntity,
    entityPosition, moveEntity, faceEntity, createZone,
    setPaused: (p) => { rt.paused = p; },
    step: (n = 1) => { rt.paused = true; for (let i = 0; i < n; i++) tickOnce(); renderer.render(scene, camera); },
    tickOnce, applyPlayerControl, byId, byTag, onTick,
    playerState, setLook, start, rules,
  };
  bus.entityTags = (id) => byId(id)?.tags;

  function byId(id: string) { return byIdMap.get(id); }
  function byTag(tag: string) { return ecs.byTag(tag); }

  // ---------- GLB: chargement + collider Rapier ----------
  const loader = new GLTFLoader();
  async function loadGltf(asset: string): Promise<GltfCache> {
    const c = gltfCache.get(asset);
    if (c) return c;
    const buf = await fetch(asset).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status} ${asset}`); return r.arrayBuffer(); });
    const meta = readGlbMeta(buf);
    const gltf = await loader.parseAsync(buf, '');
    const root = new THREE.Group();
    root.add(gltf.scene);
    const cache: GltfCache = { scene: root, meta };
    gltfCache.set(asset, cache);
    return cache;
  }

  function colliderDesc(col: { type: string; size: number[]; center: Vec3 }, st: boolean): RAPIER.ColliderDesc {
    let d: RAPIER.ColliderDesc;
    switch (col.type) {
      case 'sphere': d = RAPIER.ColliderDesc.ball(col.size[0]); break;
      case 'capsule': d = RAPIER.ColliderDesc.capsule(col.size[1] ?? 0, col.size[0]); break; // (halfHeight, radius)
      default: d = RAPIER.ColliderDesc.cuboid(col.size[0] / 2, col.size[1] / 2, col.size[2] / 2); break;
    }
    d.setTranslation(col.center[0], col.center[1], col.center[2]);
    if (st) d.setFriction(1.0);
    return d;
  }

  function spawnFromCache(asset: string, cache: GltfCache, at: Vec3, overrides?: Partial<EntityT>): EntityT {
    const tag = (asset.split('/').pop() ?? asset).replace(/\.glb$/, '');
    const e = ecs.create({
      id: nextId(tag),
      tags: overrides?.tags ?? [tag],
      asset,
      ...(overrides ?? {}),
    } as unknown as Record<string, unknown>) as EntityT;
    byIdMap.set(e.id!, e);

    // CAPACITÉS STATIQUES du GLB (méta) — fusionnée avec les overrides de scène.
    // CLONAGE PROFOND par entité: sinon toutes les instances d'un même GLB partagent
    // le MÊME objet Health/Explosive (aliasing de référence) — un baril qui meurt
    // "contaminerait" tous les autres (health.current=0 et zeroEmitted=true partagés).
    const meta = cache.meta;
    if (meta?.components) {
      for (const [k, v] of Object.entries(meta.components)) {
        const clone = structuredClone(v);
        const existing = (e as Record<string, unknown>)[k];
        if (existing && typeof existing === 'object') Object.assign(existing, clone);
        else (e as Record<string, unknown>)[k] = clone;
      }
    }
    // normalisation core: un Health déclaré sans "current" démarre plein (sinon NaN)
    if (e.Health && (e.Health.current === undefined || e.Health.current === null)) {
      e.Health.current = e.Health.max;
    }
    const phys = (e.Physics ?? meta?.physics ?? { body: 'static' as const, mass: 1 }) as { body: 'static' | 'dynamic' | 'kinematic'; mass: number };
    const col = (e.Collider ?? meta?.collider ?? { type: 'box' as const, size: [1, 1, 1], center: [0, 0, 0] as Vec3 }) as { type: string; size: number[]; center: Vec3 };

    const desc = phys.body === 'static' ? RAPIER.RigidBodyDesc.fixed()
      : phys.body === 'kinematic' ? RAPIER.RigidBodyDesc.kinematicPositionBased()
      : RAPIER.RigidBodyDesc.dynamic().setLinearDamping(0.6).setAngularDamping(0.9);
    const body = world.createRigidBody(desc);
    body.setTranslation({ x: at[0], y: at[1], z: at[2] }, true);
    const collider = world.createCollider(colliderDesc(col, phys.body === 'static'), body);
    if (phys.body === 'dynamic') collider.setMass(phys.mass);
    collToEntity.set(collider, e.id!);
    body.userData = e.id;
    bodyById.set(e.id!, body);
    e.Physics = { body: phys.body, mass: phys.mass, sleeping: false };

    const mesh = cache.scene.clone(true);
    mesh.position.set(at[0], at[1], at[2]);
    scene.add(mesh);
    (e as Record<string, unknown>)['__mesh'] = mesh;

    bus.emit('spawn', e.id!, { data: { asset } });
    return e;
  }

  function spawnAsset(asset: string, at: Vec3, overrides?: Partial<EntityT>): EntityT | null {
    const cache = gltfCache.get(asset);
    if (!cache) {
      void loadGltf(asset).then((c) => spawnAsset(asset, at, overrides)).catch((err) =>
        console.error(`[GameLoom] spawn échec (asset non chargé): ${asset}`, err));
      return null;
    }
    return spawnFromCache(asset, cache, at, overrides);
  }

  async function preloadAssets(assets: string[]) {
    for (const a of assets) {
      try { await loadGltf(a); }
      catch (err) { console.error(`[GameLoom] preload échec: ${a}`, err); }
    }
  }

  // ---------- raycast physique ----------
  function raycast(origin: Vec3, dir: Vec3, maxDist: number) {
    const d = new THREE.Vector3(...dir).normalize();
    const hit = world.castRayAndGetNormal(
      new RAPIER.Ray({ x: origin[0], y: origin[1], z: origin[2] }, { x: d.x, y: d.y, z: d.z }),
      maxDist, true,
      undefined, undefined, playerCollider, // exclure la capsule du joueur (origine du rayon)
    );
    if (!hit) return null;
    const eid = collToEntity.get(hit.collider);
    const toi = hit.timeOfImpact;
    // point d'impact = origine + dir*toi (le dir seul donnerait un point faux, relatif à l'origine monde)
    const p = { x: origin[0] + d.x * toi, y: origin[1] + d.y * toi, z: origin[2] + d.z * toi };
    return { entity: eid ? byId(eid) ?? null : null, point: [p.x, p.y, p.z] as Vec3, distance: toi };
  }

  // ---------- v0.2: mouvement générique des entités kinematic ----------
  // Le core possède bodyById (posé au spawn); le jeu ne voit jamais RAPIER.
  // Convention (validée games #3–#5): raycast de verrou horizontal y+1,0, départ décalé
  // 0,9 m, arrêt 0,5 m avant l'obstacle, eps 1e-4, yaw = atan2(-dx,-dz).
  function movableEntity(id: string): { e: EntityT; b: RAPIER.RigidBody } | null {
    if (id === 'player') {
      console.error('[GameLoom] moveEntity/faceEntity: le player est contrôlé par le KCC (utilisez applyPlayerControl)');
      return null;
    }
    const e = byIdMap.get(id);
    if (!e) { console.error(`[GameLoom] moveEntity/faceEntity: entité inconnue: ${id}`); return null; }
    const b = bodyById.get(id);
    if (!b) { console.error(`[GameLoom] moveEntity/faceEntity: pas de body pour ${id}`); return null; }
    if (e.Physics?.body !== 'kinematic') {
      console.error(`[GameLoom] moveEntity/faceEntity: ${id} n'est pas kinematic (${e.Physics?.body})`);
      return null;
    }
    return { e, b };
  }

  function entityPosition(id: string): Vec3 | null {
    const b = bodyById.get(id);
    if (!b) return null;
    const t = b.translation();
    return [t.x, t.y, t.z];
  }

  function faceYaw(b: RAPIER.RigidBody, dx: number, dz: number) {
    if (Math.hypot(dx, dz) < 1e-4) return;
    const yaw = Math.atan2(-dx, -dz);
    b.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
  }

  function faceEntity(id: string, target: Vec3): void {
    const mv = movableEntity(id);
    if (!mv) return;
    const t = mv.b.translation();
    faceYaw(mv.b, target[0] - t.x, target[2] - t.z);
  }

  function moveEntity(id: string, target: Vec3, speed: number, options?: MoveEntityOptions): boolean {
    const mv = movableEntity(id);
    if (!mv) return false;
    const t = mv.b.translation();
    const dx = target[0] - t.x, dz = target[2] - t.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-4) return false;
    const ux = dx / d, uz = dz / d;
    let step = Math.min(speed * FIXED_DT, d);
    if (options?.avoidObstacles) {
      const hit = world.castRayAndGetNormal(
        new RAPIER.Ray({ x: t.x + ux * 0.9, y: t.y + 1.0, z: t.z + uz * 0.9 }, { x: ux, y: 0, z: uz }),
        step, true,
        undefined, undefined, playerCollider, mv.b, // exclure le joueur ET le body propre (pas de TOI=0 sur soi)
      );
      if (hit) {
        // Formule prouvée #3–#5 (port fidèle du verrou legacy): l'obstacle est à
        // 0,9 + toi de l'entité, on s'arrête 0,5 m avant son arête. Quand le point de
        // sonde est DANS l'obstacle (toi ≈ 0), le step est limité à 0,4 m — c'est le
        // comportement réel observé dans les jeux (pas de stop dur, pas de pathfinding).
        const limit = hit.timeOfImpact + 0.9 - 0.5;
        if (limit < step) step = limit;
      }
    }
    if (step < 0.01) {
      if (options?.face !== false) faceYaw(mv.b, dx, dz);
      return false;
    }
    mv.b.setTranslation({ x: t.x + ux * step, y: t.y, z: t.z + uz * step }, true);
    if (options?.face !== false) faceYaw(mv.b, dx, dz);
    return true;
  }

  // ---------- v0.2: zones AABB XZ multi-entités ----------
  function createZone(options: ZoneOptions): ZoneHandle {
    if (zones.has(options.id)) console.error(`[GameLoom] createZone: id en double: ${options.id}`);
    const [minX, minZ] = options.bounds.min;
    const [maxX, maxZ] = options.bounds.max;
    const zn: ZoneState = {
      id: options.id,
      x1: Math.min(minX, maxX), x2: Math.max(minX, maxX),
      z1: Math.min(minZ, maxZ), z2: Math.max(minZ, maxZ),
      tags: [...options.tags],
      onStay: options.onStay,
      inside: new Set(),
    };
    zones.set(zn.id, zn);
    return {
      id: zn.id,
      isInside(entityId: string) { return zn.inside.has(entityId); },
      destroy() { zones.delete(zn.id); },
    };
  }

  function tickZones() {
    const alive = new Set<string>();
    for (const e of ecs.list()) if (e.id) alive.add(e.id);
    for (const zn of zones.values()) {
      // purge silencieuse des entités détruites (aucun zone.exit synthétique)
      for (const eid of [...zn.inside]) if (!alive.has(eid)) zn.inside.delete(eid);
      // résolution dynamique des tags (UNION), dédupliquée par id
      const seen = new Map<string, EntityT>();
      for (const tag of zn.tags) {
        for (const e of ecs.byTag(tag)) {
          if (e.id && !seen.has(e.id)) seen.set(e.id, e);
        }
      }
      for (const eid of seen.keys()) {
        const b = bodyById.get(eid);
        const t = b ? b.translation() : null;
        const inside = !!t && t.x >= zn.x1 && t.x <= zn.x2 && t.z >= zn.z1 && t.z <= zn.z2;
        const was = zn.inside.has(eid);
        if (inside && !was) {
          zn.inside.add(eid);
          bus.emit('zone.enter', eid, { other: zn.id, data: { zone: zn.id, x: t!.x, z: t!.z } });
        } else if (!inside && was) {
          zn.inside.delete(eid);
          bus.emit('zone.exit', eid, { other: zn.id, data: { zone: zn.id, x: t?.x ?? 0, z: t?.z ?? 0 } });
        } else if (inside && was) {
          zn.onStay?.(eid);
        }
      }
    }
  }

  // ---------- explosion radiale ----------
  function explodeAt(point: Vec3, radius: number, damage: number, impulse: number, source: string) {
    const r2 = radius * radius;
    // dégâts radiaux (falloff 100% → 35%)
    for (const e of ecs.list()) {
      if (!e.Health) continue;
      const mesh = (e as Record<string, unknown>)['__mesh'] as THREE.Object3D | undefined;
      if (!mesh) continue;
      const dx = mesh.position.x - point[0], dy = mesh.position.y - point[1], dz = mesh.position.z - point[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2);
      bus.emit('damage', e.id!, { other: source, amount: Math.round(damage * (1 - 0.65 * (d / radius))), point });
    }
    // impulsion sur les bodies dynamiques
    for (const b of world.bodies.getAll()) {
      if (!b.isDynamic()) continue;
      const t = b.translation();
      const dx = t.x - point[0], dy = t.y - point[1], dz = t.z - point[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const d = Math.max(Math.sqrt(d2), 0.001);
      const m = b.mass() ?? 1;
      const scale = impulse * (1 - 0.5 * (d / radius));
      b.applyImpulse({ x: (dx / d) * scale * m, y: (0.3 + Math.abs(dy / d) * 0.5) * scale * m, z: (dz / d) * scale * m }, true);
    }
    hooks.onExplode?.(point, radius);
  }

  // ---------- destruction ----------
  function removeEntity(id: string) {
    if (destroyed.has(id)) return;
    destroyed.add(id);
    const e = byIdMap.get(id);
    if (!e) return;
    bus.emit('destroy', id, { data: { asset: e.asset } });
    const mesh = (e as Record<string, unknown>)['__mesh'] as THREE.Object3D | undefined;
    if (mesh) scene.remove(mesh);
    const body = bodyById.get(id);
    if (body) {
      const cols: RAPIER.Collider[] = [];
      for (const c of world.colliders.getAll()) if (c.parent() === body) cols.push(c);
      for (const c of cols) { collToEntity.delete(c); world.removeCollider(c, true); }
      world.removeRigidBody(body);
      bodyById.delete(id);
    }
    ecs.remove(e);
    byIdMap.delete(id);
    // v0.2: purge silencieuse de l'état des zones (aucun zone.exit synthétique)
    for (const zn of zones.values()) zn.inside.delete(id);
  }

  // ---------- règles ----------
  function on(target: string, event: string, block: RuleBlock) {
    rules.push({ target, event, hasIf: !!block.if, nActions: block.do?.length ?? 0, hasFn: !!block.fn });
    return bus.on(event, target, (ctx: EventCtx) => {
      const e = ctx.entity ? byId(ctx.entity) : undefined;
      if (target !== '*' && e && !e.tags?.includes(target)) return;
      if (block.if && !block.if(ctx)) return;
      for (const spec of block.do ?? []) runAction(spec, ctx, rt);
      if (block.fn) {
        try { block.fn(ctx); } catch (err) { console.error(`[GameLoom] règle ${target}/${event}:`, err); }
      }
    });
  }

  // ---------- actions core (v0.1: 4 actions — explode, destroy, addScore, sound) ----------
  registerAction('explode', (args, ctx) => {
    const e = ctx.entity ? byId(ctx.entity) : undefined;
    if (!e || !e.id || e.Explosive?.exploded) return;
    e.Explosive!.exploded = true;
    const mesh = (e as Record<string, unknown>)['__mesh'] as THREE.Object3D | undefined;
    if (!mesh) return;
    const pos: Vec3 = [mesh.position.x, mesh.position.y, mesh.position.z];
    explodeAt(pos, Number(args.radius ?? e.Explosive!.radius), Number(args.damage ?? e.Explosive!.damage), Number(args.impulse ?? e.Explosive!.impulse), e.id);
  });
  registerAction('destroy', (_a, ctx) => { if (ctx.entity) removeEntity(ctx.entity); });
  registerAction('addScore', (a, ctx) => {
    void ctx;
    if (rt.player?.Scored) rt.player.Scored.points += Number(a.points ?? 0);
  });
  registerAction('sound', (a) => { hooks.onSound?.(String(a.name), a.gain as number | undefined); });

  // ---------- système santé (core) ----------
  bus.on('damage', '*', (ctx) => {
    const e = ctx.entity ? byId(ctx.entity) : undefined;
    if (!e?.Health) return;
    e.Health.current -= ctx.amount ?? 0;
    if (ctx.entity === rt.player.id) hooks.onPlayerHurt?.(ctx.amount ?? 0);
    if (e.Health.current <= 0) {
      e.Health.current = 0;
      if (!e.Health.zeroEmitted) {
        e.Health.zeroEmitted = true;
        e.Health.deadTick = rt.tick;
        bus.emit('health.zero', e.id!, { other: ctx.other, amount: 0 });
      }
    }
  });
  bus.on('health.zero', 'player', () => { bus.emit('player.died', rt.player.id!, {}); });

  // ---------- contrôles ----------
  function applyPlayerControl(ctl: { move: [number, number]; look: [number, number]; jump: boolean }) {
    input.move = ctl.move;
    input.look = ctl.look;
    input.jump = ctl.jump;
  }

  // ---------- tick physique ----------
  const playerBody = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
  playerBody.setTranslation({ x: 0, y: 2, z: 0 }, true);
  const pcd = RAPIER.ColliderDesc.capsule(0.55, 0.45); // (halfHeight, radius)
  pcd.setTranslation(0, 0.1, 0);
  const playerCollider = world.createCollider(pcd, playerBody);

  const playerE = ecs.create({
    id: 'player',
    tags: ['player', 'actor'],
    asset: 'player',
    Health: { current: 100, max: 100, zeroEmitted: false, deadTick: undefined },
    Scored: { points: 0 },
    Physics: { body: 'kinematic', mass: 80, sleeping: false },
  } as unknown as Record<string, unknown>) as EntityT;
  byIdMap.set('player', playerE);
  bodyById.set('player', playerBody);
  rt.player = playerE;

  const playerMesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.4, 1.0, 6, 12),
    new THREE.MeshStandardMaterial({ color: 0x5a7d9a, roughness: 0.7 }),
  );
  scene.add(playerMesh);
  (playerE as Record<string, unknown>)['__mesh'] = playerMesh;
  bus.emit('spawn', 'player', {});

  function tickOnce() {
    // --- KCC: grounded vient du compute de l'étape précédente (pattern officiel) ---
    const speed = 5.6;
    const fwd = input.move[0];    // W → +1 → avant (vers -z quand yaw=0)
    const strafe = input.move[1]; // D → +1 → droite
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    const dx = (-sin * fwd + cos * strafe) * speed * FIXED_DT;
    const dz = (-cos * fwd - sin * strafe) * speed * FIXED_DT;
    vY.v += GRAVITY * FIXED_DT;
    if (input.jump && kcc.computedGrounded()) vY.v = 8.2;
    if (kcc.computedGrounded() && vY.v < 0) vY.v = 0;
    kcc.computeColliderMovement(playerCollider, { x: dx, y: vY.v * FIXED_DT, z: dz });
    const mv = kcc.computedMovement();
    const t = playerBody.translation();
    playerBody.setTranslation({ x: t.x + mv.x, y: t.y + mv.y, z: t.z + mv.z }, true);

    world.step(eventQueue);
    eventQueue.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const e1 = collToEntity.get(world.colliders.get(h1)!);
      const e2 = collToEntity.get(world.colliders.get(h2)!);
      if (!e1 || !e2) return;
      bus.emit('collision.start', e1, { other: e2 });
      bus.emit('collision.start', e2, { other: e1 });
    });

    ecs.each('Physics', (e) => {
      const b = bodyById.get(e.id!);
      if (b) e.Physics!.sleeping = b.isSleeping();
    });
    // sync mesh ↔ physique
    for (const e of ecs.list()) {
      const mesh = (e as Record<string, unknown>)['__mesh'] as THREE.Object3D | undefined;
      const b = bodyById.get(e.id!);
      if (mesh && b) {
        const t = b.translation();
        mesh.position.set(t.x, t.y, t.z);
        const r = b.rotation();
        mesh.quaternion.set(r.x, r.y, r.z, r.w);
      }
    }
    // caméra FPS
    const pt = playerBody.translation();
    camera.position.set(pt.x, pt.y + EYE, pt.z);
    camera.rotation.set(0, 0, 0);
    camera.rotateY(yaw);
    camera.rotateX(pitch);
    hooks.onPlayerLook?.(yaw, pitch);

    // logique périodique du jeu (après physique, même pas de temps)
    for (const fn of [...tickFns]) fn();

    // v0.2: zones — positions finales du tick (après le jeu), avant l'incrément
    tickZones();

    rt.tick++;
    rt.time += FIXED_DT;
    bus.tickRef.tick = rt.tick;
    bus.tRef.t = rt.time;
  }

  // ---------- boucle ----------
  let acc = 0, last = 0, running = false;
  let fT = 0, fN = 0;
  const fps = { value: 0 };

  function loop(now: number) {
    if (!running) return;
    const dt = Math.min((now - last) / 1000, 0.25);
    last = now;
    fN++;
    if (now - fT > 500) { fps.value = Math.round((fN * 1000) / (now - fT)); fT = now; fN = 0; }
    if (!rt.paused) {
      acc += dt;
      let guard = 0;
      while (acc >= FIXED_DT && guard < 8) { tickOnce(); acc -= FIXED_DT; guard++; }
      if (guard === 8) acc = 0; // spiral of death: on lâche le retard
    }
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }

  function start() {
    if (running) return;
    running = true;
    last = performance.now();
    fT = last;
    requestAnimationFrame(loop);
  }

  function playerState() {
    const t = playerBody.translation();
    const v = playerBody.linvel();
    return { pos: [round(t.x), round(t.y), round(t.z)] as Vec3, yaw: round(yaw), pitch: round(pitch), grounded: kcc.computedGrounded(), vel: [round(v.x), round(v.y), round(v.z)] as Vec3 };
  }

  function setLook(y: number, p: number) {
    yaw = y;
    pitch = Math.max(-1.45, Math.min(1.45, p));
  }

  // ---------- resize ----------
  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  // ---------- DEBUG API (JSON compact) ----------
  (window as any).GameLoom = {
    version: '0.2.0',
    inspect(id: string) {
      const e = byId(id);
      if (!e) return { error: `entité inconnue: ${id}` };
      const mesh = (e as Record<string, unknown>)['__mesh'] as THREE.Object3D | undefined;
      const body = bodyById.get(id);
      const out: Record<string, unknown> = { id: e.id, tags: e.tags, asset: e.asset };
      if (mesh) out.position = [round(mesh.position.x), round(mesh.position.y), round(mesh.position.z)];
      if (e.Health) out.health = { current: e.Health.current, max: e.Health.max, dead: e.Health.current <= 0 };
      if (e.Explosive) out.explosive = { radius: e.Explosive.radius, damage: e.Explosive.damage, impulse: e.Explosive.impulse, exploded: e.Explosive.exploded };
      if (e.Scored) out.score = e.Scored.points;
      if (e.Physics) out.physics = { body: e.Physics.body, mass: e.Physics.mass, sleeping: e.Physics.sleeping };
      if (body) out.velocity = [round(body.linvel().x), round(body.linvel().y), round(body.linvel().z)];
      return out;
    },
    entities(filter?: { tag?: string; component?: string }) {
      let list = ecs.list();
      if (filter?.tag) list = list.filter((e) => e.tags?.includes(filter.tag!));
      if (filter?.component) list = list.filter((e) => e[filter.component!] !== undefined);
      return list.map((e) => {
        const mesh = (e as Record<string, unknown>)['__mesh'] as THREE.Object3D | undefined;
        const o: Record<string, unknown> = { id: e.id, tags: e.tags };
        if (mesh) o.pos = [round(mesh.position.x), round(mesh.position.y), round(mesh.position.z)];
        if (e.Health) o.health = `${e.Health.current}/${e.Health.max}`;
        if (e.Explosive) o.exploded = e.Explosive.exploded;
        if (e.Scored) o.points = e.Scored.points;
        return o;
      });
    },
    events(limit = 30) { return bus.log.slice(-limit); },
    stats() {
      return { tick: rt.tick, time: round(rt.time), paused: rt.paused, fps: fps.value, entities: ecs.count(), events_total: bus.log.length, actions: listActions(), depth: bus.depth() };
    },
    snapshot() {
      const p = rt.player;
      const s = playerState();
      return { tick: rt.tick, time: round(rt.time), paused: rt.paused, player: { pos: s.pos, health: `${p.Health!.current}/${p.Health!.max}`, score: p.Scored?.points ?? 0, alive: p.Health!.current > 0, grounded: s.grounded }, entities: ecs.count() };
    },
    doctor() {
      const warnings: string[] = [];
      const ents = ecs.list();
      if (!ents.some((e) => e.tags?.includes('player'))) warnings.push('aucune entité "player"');
      // le joueur est conçu pour NE PAS être détruit à la mort (game over, pas destroy)
      const dead = ents.filter((e) => e.Health && e.Health.current <= 0 && e.Health.zeroEmitted && !e.tags?.includes('player') && (rt.tick - (e.Health.deadTick ?? rt.tick)) > 30);
      if (dead.length) warnings.push(`${dead.length} entités mortes depuis >30 ticks sans destruction — règle health.zero/destroy manquante?`);
      const noMeta: string[] = [];
      for (const a of gltfCache.keys()) if (!gltfCache.get(a)!.meta) noMeta.push(a);
      return {
        ok: warnings.length === 0,
        warnings,
        stats: (window as any).GameLoom.stats(),
        assets: { loaded: [...gltfCache.keys()], without_gameloom_meta: noMeta },
        events_recent: bus.log.slice(-20),
      };
    },
    pause() { rt.paused = true; },
    resume() { rt.paused = false; },
    step(n = 1) { rt.step(n); },
    setPaused(p: boolean) { rt.paused = p; },
    isPaused() { return rt.paused; },
    rules: () => [...rules],
    actions: () => listActions(),
    zones: () => {
      const out: { id: string; x1: number; x2: number; z1: number; z2: number; inside: string[] }[] = [];
      for (const zn of zones.values()) out.push({ id: zn.id, x1: zn.x1, x2: zn.x2, z1: zn.z1, z2: zn.z2, inside: [...zn.inside] });
      return out;
    },
    _debug: {
      setLook(y: number, p: number) { yaw = y; pitch = Math.max(-1.45, Math.min(1.45, p)); },
      look() { return { yaw: round(yaw), pitch: round(pitch) }; },
      teleportPlayer(x: number, y: number, z: number) { playerBody.setTranslation({ x, y, z }, true); vY.v = 0; },
      setPlayerHealth(h: number) { rt.player.Health!.current = h; },
      addPlayerHealth(h: number) { rt.player.Health!.current = Math.min(rt.player.Health!.max, rt.player.Health!.current + h); },
      input(keys: { move?: [number, number]; jump?: boolean }) { if (keys.move) input.move = keys.move; if (keys.jump !== undefined) input.jump = keys.jump; },
      spawn(asset: string, x: number, y: number, z: number) {
        const e = spawnAsset(asset, [x, y, z]);
        return e ? e.id : null;
      },
      fire(origin: Vec3) {
        const dir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
        const hit = raycast(origin, [dir.x, dir.y, dir.z], 120);
        hooks.onFire?.(origin, hit ? hit.point : [origin[0] + dir.x * 120, origin[1] + dir.y * 120, origin[2] + dir.z * 120]);
        return hit ? { id: hit.entity?.id ?? null, point: hit.point, distance: round(hit.distance) } : null;
      },
      aimAt(x: number, y: number, z: number) {
        const t = playerBody.translation();
        const ex = t.x, ey = t.y + EYE, ez = t.z;
        const dx = x - ex, dy = y - ey, dz = z - ez;
        const horiz = Math.hypot(dx, dz) || 1e-6;
        yaw = Math.atan2(-dx, -dz);
        pitch = Math.max(-1.45, Math.min(1.45, Math.atan2(dy, horiz)));
      },
      remove(id: string) { removeEntity(id); },
      clearTag(tag: string) { for (const e of [...ecs.list()]) if (e.tags?.includes(tag)) removeEntity(e.id!); },
    },
  };

  return rt;
}
