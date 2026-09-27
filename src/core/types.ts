// GameLoom v0.1 — types & vocabulaire canonique
// Philosophie: GLB = IDENTITE + CAPACITES | SCENE = INSTANCES + REGLES
// ECS = ETAT RUNTIME | EVENT = CE QUI ARRIVE | ACTION = CONSEQUENCE | SYSTEM = EXECUTION

export const NS = 'com.gameloom.v0';

export type Vec3 = [number, number, number];

// ---------- Components (tous des plain objects JSON-sérialisables) ----------
export interface CmpHealth { current: number; max: number; zeroEmitted: boolean; deadTick?: number }
export interface CmpExplosive { radius: number; damage: number; impulse: number; exploded: boolean }
export interface CmpScored { points: number }
export interface CmpPhysics {
  body: 'static' | 'dynamic' | 'kinematic';
  mass: number;
  sleeping: boolean;
}
export interface CmpCollider { type: 'box' | 'sphere' | 'capsule' | 'convex'; size: number[]; center: Vec3 }
export interface CmpTags { tags: string[] }
export interface CmpId { id: string }
// L'asset source (nom de fichier GLB) — utile pour inspect
export interface CmpAsset { asset: string }

export type EntityT = {
  id?: string;
  tags?: string[];
  asset?: string;
  Health?: CmpHealth;
  Explosive?: CmpExplosive;
  Scored?: CmpScored;
  Physics?: CmpPhysics;
  Collider?: CmpCollider;
  [key: string]: unknown;
};

// ---------- Vocabulaire canonique v0.1 ----------
// Events (core): damage, health.zero, spawn, destroy, player.died
// Events (jeu):  wave.start, wave.clear, game.over, ammo.empty
export const EVENTS = [
  'damage', 'health.zero', 'spawn', 'destroy', 'player.died',
] as const;

// Actions (core) — registry extensible
export const ACTIONS = [
  'explode', 'destroy', 'damage', 'addScore', 'play', 'sound', 'spawn',
] as const;

export interface EventCtx {
  event: string;
  entity: string;      // id de l'entité source
  other?: string;      // entité ciblée (ex. source des dégâts)
  amount?: number;
  point?: Vec3;
  data?: Record<string, unknown>;
}

export interface ActionSpec {
  __action: string;
  args?: Record<string, unknown>;
}

export interface RuleBlock {
  if?: (ctx: EventCtx) => boolean;
  do?: ActionSpec[];
  fn?: (ctx: EventCtx) => void;   // code de jeu spécifique (hors core)
}

export interface Rule {
  target: string;      // tag
  event: string;
  cond?: (ctx: EventCtx) => boolean;
  actions?: ActionSpec[];
  fn?: (ctx: EventCtx) => void;
}

export interface EventRecord {
  t: number; tick: number; event: string; entity: string;
  other?: string; amount?: number;
}

// ---------- Métadonnées GLB (namespace com.gameloom.v0) ----------
export interface GlbMeta {
  collider?: { type: 'box' | 'sphere' | 'capsule' | 'convex'; size: number[]; center: Vec3 };
  physics?: { body: 'static' | 'dynamic' | 'kinematic'; mass: number };
  components?: Record<string, Record<string, number | string | boolean>>;
}
