// GameLoom v0.1 — bus d'événements (synchrones, déterministes, filtrés par tag)
import type { EventCtx, EventRecord } from './types';

const MAX_LOG = 500;

export interface EventBus {
  emit(event: string, entity: string, data?: Partial<Omit<EventCtx, 'event' | 'entity'>>): void;
  on(event: string, tag: string, handler: (ctx: EventCtx) => void): () => void;
  log: EventRecord[];
  tickRef: { tick: number };
  tRef: { t: number };
  /** Résolution des tags d'une entité (injectée par le runtime). '*' = tout. */
  entityTags: (id: string) => string[] | undefined;
  depth: () => number;
}

export function createEventBus(): EventBus {
  const subs = new Map<string, Array<{ tag: string; fn: (c: EventCtx) => void }>>();
  const log: EventRecord[] = [];
  let depth = 0;
  const bus: EventBus = {
    log,
    tickRef: { tick: 0 },
    tRef: { t: 0 },
    entityTags: () => undefined,
    depth: () => depth,
    emit(event, entity, data) {
      if (depth > 8) {
        console.warn(`[GameLoom] profondeur d'événement > 8 — ignoré: ${event}@${entity}`);
        return;
      }
      const ctx: EventCtx = { event, entity, ...data };
      const rec: EventRecord = {
        t: bus.tRef.t, tick: bus.tickRef.tick, event, entity,
        other: data?.other, amount: data?.amount,
      };
      log.push(rec);
      if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
      const list = subs.get(event);
      if (!list || list.length === 0) return;
      const tags = bus.entityTags(entity);
      depth++;
      try {
        for (const s of [...list]) {
          if (s.tag !== '*' && tags && !tags.includes(s.tag)) continue;
          s.fn(ctx);
        }
      } finally {
        depth--;
      }
    },
    on(event, tag, handler) {
      const list = subs.get(event) ?? [];
      list.push({ tag, fn: handler });
      subs.set(event, list);
      return () => {
        const l = subs.get(event);
        if (!l) return;
        const i = l.findIndex((x) => x.tag === tag && x.fn === handler);
        if (i >= 0) l.splice(i, 1);
      };
    },
  };
  return bus;
}
