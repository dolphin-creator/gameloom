// GameLoom v0.1 — Actions: fabrique (syntaxe) + registry (exécution)
// Principe: une action existe dans le registry SI ET SEULEMENT si elle est
// nécessaire au slice. Sinon → composition ou code de jeu (block.fn).
// La fabrique A n'expose QUE les actions enregistrées — pas de code mort.

import type { ActionSpec, EventCtx } from './types';
import type { Runtime } from './runtime';

export type ActionHandler = (args: Record<string, unknown>, ctx: EventCtx, rt: Runtime) => void;

const registry = new Map<string, ActionHandler>();

export function registerAction(name: string, handler: ActionHandler): void {
  if (registry.has(name)) console.warn(`[GameLoom] action "${name}" déjà enregistrée — surchargée`);
  registry.set(name, handler);
}

export function runAction(spec: ActionSpec, ctx: EventCtx, rt: Runtime): void {
  const h = registry.get(spec.__action);
  if (!h) {
    console.error(`[GameLoom] action inconnue: "${spec.__action}" (ctx: ${ctx.event}@${ctx.entity})`);
    return;
  }
  try {
    h(spec.args ?? {}, ctx, rt);
  } catch (err) {
    console.error(`[GameLoom] action "${spec.__action}" a levé une erreur:`, err);
  }
}

export function listActions(): string[] {
  return [...registry.keys()].sort();
}

// ---------- Fabrique (syntaxe déclarative) — reflète le registry v0.1 ----------
export const A = {
  explode: (args?: Record<string, unknown>) => ({ __action: 'explode', args }) as ActionSpec,
  destroy: () => ({ __action: 'destroy' }) as ActionSpec,
  addScore: (points: number) => ({ __action: 'addScore', args: { points } }) as ActionSpec,
  sound: (name: string, gain?: number) => ({ __action: 'sound', args: { name, gain } }) as ActionSpec,
};
