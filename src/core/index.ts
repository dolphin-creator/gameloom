// GameLoom v0.1 — surface publique minimale du core
export { createRuntime, FIXED_DT } from './runtime';
export type { Runtime, GameHooks } from './runtime';
export { A, listActions } from './actions';
export { NS, readGlbMeta, readGlbJson } from './glbs';
export type {
  EntityT, EventCtx, RuleBlock, GlbMeta, Vec3,
  CmpHealth, CmpExplosive, CmpScored, CmpPhysics, CmpCollider,
  MoveEntityOptions, ZoneBounds, ZoneOptions, ZoneHandle,
} from './types';
