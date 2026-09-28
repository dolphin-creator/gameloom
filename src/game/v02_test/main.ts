// Page de test v0.2 — surface headless des primitives core (aucun gameplay)
// Expose via GameLoom._debug.v02: spawn (kinematic/static/dynamic, overrides),
// moveEntity/faceEntity/entityPosition, createZone (+ stayLog + capture des
// zoneEvents avec data), zones(), zoneInside/zoneDestroy.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { createRuntime } from '../../core';
import type { Runtime, Vec3, ZoneHandle } from '../../core';

let rt: Runtime;
const state: { stayLog: { zone: string; entity: string }[]; zoneEvents: { event: string; entity: string; other?: string; data?: Record<string, unknown> }[] } = { stayLog: [], zoneEvents: [] };
const handles = new Map<string, ZoneHandle>();

const canvas = document.getElementById('game') as HTMLCanvasElement;

async function boot() {
  rt = await createRuntime(canvas);
  await rt.preloadAssets(['assets/crate.glb', 'assets/guardian.glb', 'assets/survivor.glb']);

  // mur d'obstacle statique: x ∈ [4.5, 5.5], y ∈ [0, 3], z ∈ [-3, 3]
  const wall = RAPIER.ColliderDesc.cuboid(0.5, 1.5, 3);
  wall.setTranslation(5, 1.5, 0);
  rt.world.createCollider(wall, rt.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()));

  // capture des events de zone avec leur payload data (le bus log ne garde que other/amount)
  const capture = (ev: string) => rt.on('*', ev, {
    fn: (ctx) => { state.zoneEvents.push({ event: ev, entity: ctx.entity, other: ctx.other, data: ctx.data ? { ...ctx.data } : undefined }); },
  });
  capture('zone.enter');
  capture('zone.exit');

  rt.setPaused(true);
  rt.start();

  const meshOf = (id: string) => (rt.ecs.list().find((x) => x.id === id) as unknown as { __mesh?: THREE.Object3D } | undefined)?.__mesh;

  (window as any).GameLoom._debug.v02 = {
    spawn: (asset: string, x: number, y: number, z: number, tags: string[], body?: 'static' | 'dynamic', bigCollider?: boolean) => {
      const overrides: Record<string, unknown> = {};
      if (tags?.length) overrides.tags = tags;
      if (body) overrides.Physics = { body, mass: 1 };
      if (bigCollider) overrides.Collider = { type: 'box', size: [2.5, 1.6, 2.5], center: [0, 0.8, 0] };
      const e = rt.spawnAsset(asset, [x, y, z], overrides as Parameters<typeof rt.spawnAsset>[2]);
      return e?.id ?? null;
    },
    move: (id: string, tx: number, tz: number, speed: number, face?: boolean, avoid?: boolean) =>
      rt.moveEntity(id, [tx, 0, tz] as Vec3, speed, { face, avoidObstacles: avoid }),
    face: (id: string, tx: number, tz: number) => rt.faceEntity(id, [tx, 0, tz] as Vec3),
    pos: (id: string) => rt.entityPosition(id),
    yaw: (id: string) => {
      const m = meshOf(id);
      if (!m) return null;
      const q = m.quaternion;
      return 2 * Math.atan2(q.y, q.w);
    },
    zone: (id: string, minX: number, minZ: number, maxX: number, maxZ: number, tags: string[]) => {
      const h = rt.createZone({
        id,
        bounds: { min: [minX, minZ], max: [maxX, maxZ] },
        tags,
        onStay: (eid) => { state.stayLog.push({ zone: id, entity: eid }); },
      });
      handles.set(id, h);
      return h.id;
    },
    zoneDestroy: (id: string) => { handles.get(id)?.destroy(); },
    zoneInside: (id: string, eid: string) => handles.get(id)?.isInside(eid) ?? false,
    zones: () => (window as any).GameLoom.zones(),
    state: () => state,
    clearState: () => { state.stayLog = []; state.zoneEvents = []; },
  };
  console.log('[v0.2 test] prêt');
}
boot().catch((err) => {
  console.error('[v0.2 test] boot échec:', err);
});
