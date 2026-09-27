// GameLoom v0.1 — adapter ECS (Miniplex derrière une API stable)
// Les 3 interfaces stables: itération, requêtes, snapshot JSON.

import { World as MWorld } from 'miniplex';
import type { EntityT, CmpId, CmpTags } from './types';

export interface EcsApi {
  create(components: Record<string, unknown>): EntityT;
  remove(e: EntityT): void;
  set(e: EntityT, cmp: string, value: unknown): void;
  del(e: EntityT, cmp: string): void;
  get(e: EntityT, cmp: string): unknown;
  each(cmp: string, fn: (e: EntityT) => void): void;      // itération par composant
  all(fn: (e: EntityT) => void): void;                     // itération totale
  byTag(tag: string): EntityT[];                           // requête par tag (scan, monde petit)
  list(): EntityT[];
  count(): number;
  snapshot(): Record<string, unknown>[];                   // plain JSON
}

let seq = 0;

export function createEcs(): EcsApi {
  const w = new MWorld<EntityT>();
  return {
    create(components) {
      const e = w.add({ ...(components as object) }) as EntityT;
      if (!e.id) e.id = `e${(seq++).toString(36)}`;
      if (!e.tags) e.tags = [];
      return e;
    },
    remove(e) {
      // snapshot before removal (les règles 'destroy' ont besoin de l'entité)
      w.remove(e);
    },
    set(e, cmp, value) {
      if (value === undefined) { w.removeComponent(e, cmp as keyof EntityT); return; }
      w.update(e, cmp as keyof EntityT, value);
    },
    del(e, cmp) { w.removeComponent(e, cmp as keyof EntityT); },
    get(e, cmp): unknown { return (e as Record<string, unknown>)[cmp]; },
    each(cmp, fn) {
      for (const e of w.with(cmp as keyof EntityT) as unknown as Iterable<EntityT>) fn(e);
    },
    all(fn) { for (const e of w.entities) fn(e); },
    byTag(tag) {
      const out: EntityT[] = [];
      for (const e of w.entities) if (e.tags?.includes(tag)) out.push(e);
      return out;
    },
    list() { return [...w.entities]; },
    count() { return w.entities.length; },
    snapshot() {
      const out: Record<string, unknown>[] = [];
      for (const e of w.entities) {
        const r: Record<string, unknown> = { id: e.id, tags: e.tags };
        if (e.Health) r.Health = { current: e.Health.current, max: e.Health.max };
        if (e.Explosive) r.Explosive = { radius: e.Explosive.radius, damage: e.Explosive.damage, impulse: e.Explosive.impulse, exploded: e.Explosive.exploded };
        if (e.Scored) r.Scored = { points: e.Scored.points };
        if (e.Physics) r.Physics = { body: e.Physics.body, mass: e.Physics.mass, sleeping: e.Physics.sleeping };
        out.push(r);
      }
      return out;
    },
  };
}

// types utilitaires pour le reste du code
export type { EntityT, CmpId, CmpTags };
