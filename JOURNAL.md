# Journal expérimental — GameLoom v0.1 / Barrel Blaster

**Période :** 2026-09-27 12:15:50 → 15:54:38 (218 min, dont 2 compressions de contexte)
**Verdict tests :** 19/19 × 8 runs consécutifs (build production, Chrome headless CDP 9224)

## Temps
| Phase | Durée | Note |
|---|---|---|
| Scaffolding + deps | ~15 min | npm/watchdog |
| Core GameLoom (888 LOC) | ~40 min | écrit, pas de doute |
| Mismatches API Rapier 0.21 (13) | ~90 min | **coût principal**, lecture .d.ts |
| Bugs gameplay (NaN health, aliasing, dt, input) | ~40 min | tous trouvés via JSON |
| Testeur CDP + déterminisme | ~30 min | HMR double-boot, layout aléatoire |
| Pipeline assets Blender→GLB→CLI | ~3 min/asset | après stabilisation du CLI |

## Itération mesurée
patch → tsc (2s) → vite build (0.5s) → test complet (~3s) = **cycle ~10-15 s**

## Bugs (14, tous corrigés, tous prouvés par exécution)
1. Buffer Node poolé (byteOffset) casse la lecture binaire GLB (CLI)
2. Blender Z-up vs glTF Y-up + origine à la base → bbox [0,0,0]
3. computeBbox lisait normales/couleurs comme positions (VEC3)
4. Tag dérivé du chemin complet `assets/barrel` au lieu de `barrel`
5. `await RAPIER.init` sans `()` → WASM jamais initialisé
6. 13 mismatches TS/API Rapier 0.21 (setMass sur ColliderDesc, isDynamic(), kinematicPositionBased, capsule(halfHeight,radius), EventQueue(false), castRayAndGetNormal, world.colliders.get)
7. Déplacement non mis à l'échelle par FIXED_DT (5.6 m/tick)
8. Jeu écrase l'input du testeur chaque tick (double source de vérité)
9. yaw/pitch dupliqués (game + core) → source unique dans le core
10. **Health.current undefined → NaN** (GLB ne déclare que `max`) → health.zero jamais émis
11. **Aliasing composants : toutes les instances d'un GLB partagent le même objet Health/Explosive** (bug le plus grave) → structuredClone au spawn
12. Point d'impact raycast = dir*toi (origine manquante) → origin + dir*toi
13. Vite HMR double boot en dev → 2 runtimes GameLoom en parallèle → tester sur build prod
14. Non-déterminisme de test (vague 1 aléatoire : occlusion + joueur mort) → scènes de test contrôlées

## Bugs trouvés SANS vision (JSON/CDP) : 10+ (tous les bugs réels)
Bugs ayant nécessité screenshot/vision : **0** (1 screenshot final de validation uniquement)

## Character controller
KCC Rapier natif (autostep 0.45/0.5, snapToGround 0.12, computedGrounded) :
- mouvement 5.6 m/s stable, grounded vrai, y repos 0.92
- saut : apogée 2.041 → retour 0.92 ✓
- pas de polish (pas de slide en pente) — non requis pour le slice

## Discipline
- Core : 888 LOC | 4 actions | 6 composants | 2 subscriptions système (damage, health.zero)
- Dépendances runtime : 4 (three, rapier3d-compat, miniplex, gltf-transform)
- Rien ajouté hors nécessité du slice (aucun DSL, aucun CLI game, aucun module)

## Dette technique
- `_debug` (aimAt/spawn/teleportPlayer/clearTag) = helpers de test, à formaliser ou retirer
- `deadTick` dans Health = ajout pour le doctor
- explosion blesse le joueur (kinematic) — choix de slice
- chunk 5 MB (import dynamique Rapier inefficace, déjà statique dans le core)
- GLB hors public/ → copie manuelle dans dist (à automatiser au build)
- pas d'animation/root-motion (aucun asset animé dans le slice)
- pas de save/load
