# GameLoom — Manuel opérationnel (v0.2)

> **Le seul document qu'un agent IA doit lire** pour comprendre et utiliser GameLoom : état
> ACTUEL (API, CLI, conventions, procédures), autonome. L'état dynamique du repository
> (liste des assets, des jeux, des versions) se **découvre** via les commandes documentées ici,
> ne se recopie pas. Historique, preuves, décisions : `EXPERIMENTS.md`.

## Politique documentaire (à lire d'abord)

- **`GAMELOOM.md` = le présent opérationnel.** Écrire ici quand une modification change
  l'API publique, le CLI, les métadonnées GLB, les composants, les events/actions core, la
  physique, la debug API, le workflow officiel, les commandes, les conventions, une
  limitation importante, une procédure d'usage. Une modification fonctionnelle n'est
  **pas terminée** tant que ce fichier ne reflète pas le comportement validé
  (implémenter → tests verts → mettre à jour) ; core inchangé → le fichier ne doit
  **presque pas** grossir. **Ne PAS y écrire** : récit, métriques, justifications longues,
  inventaires dynamiques (découvrables), hypothèses, idées futures.
- **`EXPERIMENTS.md` = mémoire d'ingénierie (passé + futur).** Écrire là après un nouveau
  slice, un bug architectural, une mesure de friction, une décision d'abstraction
  (preuves, § Candidate abstractions) — **obligatoirement** avant d'ajouter une abstraction.
  **`JOURNAL.md`** = archive du bootstrap — ne plus mettre à jour.
- **Quand lire quoi** : créer un jeu / CLI / déboguer → `GAMELOOM.md` seul ; modifier le
  core ou ajouter une abstraction → `GAMELOOM.md` **+** `EXPERIMENTS.md`. **Anti-gonflement** :
  avant un paragraphe : « Un agent a-t-il besoin de ceci pour la version ACTUELLE ? »
  Non → `EXPERIMENTS.md` ; règle remplacée → **remplacer**, ne pas empiler. Contradiction →
  `GAMELOOM.md` fait autorité sur le présent.
- **Jeux existants = fixtures de validation/régression, PAS référence normative.** Pour
  écrire du nouveau code, utiliser les contrats, primitives et workflows documentés dans ce
  manuel comme référence de l'API actuelle. Les jeux de `src/game/` ne doivent pas servir de
  référence normative (certains prédatent les abstractions actuelles) ; ne consulter leur
  code que pour une investigation ciblée ou si une mission le demande explicitement.

## 1. GameLoom en une minute

GameLoom est une **bibliothèque TypeScript** qui transforme des assets **GLB** (modèle 3D +
capacités) en jeu 3D jouable dans le navigateur : physique (Rapier), ECS (Miniplex), rendu
(Three.js), debug API structurée (JSON). Ce n'est **pas** un langage, DSL, éditeur ni
moteur graphique complet.

| Concept | Rôle |
|---|---|
| **GLB** | IDENTITÉ + CAPACITÉS STATIQUES (géométrie, collider, physique, `Health.max`, `Explosive`…) |
| **Game (TS)** | INSTANCES + COMPORTEMENT (spawns, règles « quand → faire quoi ») |
| **ECS** | ÉTAT RUNTIME (par entité : `Health.current`, position, tags…) |
| **EVENT** | CE QUI ARRIVE (`damage`, `health.zero`, `spawn`, `destroy`, `player.died`…) |
| **ACTION** | CONSÉQUENCE (`explode`, `destroy`, `addScore`, `sound`) |
| **SYSTEM** | MÉCANISME D'EXÉCUTION (`rt.on(target, event, block)`) |

Piliers : **Debug API** (`window.GameLoom`, tout JSON) et **fixed timestep** (1/60 s ;
`pause()` + `step(n)` pilotent les ticks, jamais le temps réel). **Frontière** : le GLB dit
« je suis un baril, `Health.max = 50`, je *peux* exploser » ; le TS dit « *quand* ta vie
arrive à zéro, tu exploses puis tu te détruis »
(`rt.on('barrel', 'health.zero', { do: [A.explode(), A.destroy()] })`).

**Frontières** : `src/core/` (moteur — modifier seulement selon la politique documentaire) ·
`src/game/` (les jeux) · `src/viewer/` (outil d'inspection — zéro import core, §18) ·
infrastructure réseau (exposition, proxy, VPS) = affaire de l'utilisateur, **aucune** logique
réseau dans le repo.

## 2. Stack & pipeline asset

Versions installées : voir `package.json`. **Règle de découplage** : une dépendance ne doit
pas coupler l'API publique — Miniplex derrière l'adapter `ecs.ts`, Rapier dans le runtime,
Three.js = présentation **uniquement** (le gameplay ne lit jamais le rendu).

Assets : **Blender 4.2 headless** (`tools/blender/*.py`) pour le procédural complexe,
**`tools/make_glb.mjs`** pour les low-poly simples (boîtes composées, GLB binaire valide,
sans Blender). Pipeline validé :

```bash
node tools/make_glb.mjs <nom>                                        # → assets/<nom>.glb (recettes dans RECIPES)
npm run glb -- collider auto assets/<nom>.glb                        # collider box depuis la bbox
npm run glb -- physics set assets/<nom>.glb --body static            # ou dynamic/kinematic [--mass N]
npm run glb -- validate assets/<nom>.glb && npm run glb -- doctor assets/<nom>.glb
```

**Nouvelle recette** : `RECIPES[nom] = { name, prims: [{ geo, material }] }` ;
`geo = boxGeometry(hx, hy, hz, cx, cy, cz)` — **hx/hy/hz = DEMI-dimensions** (dimensions
totales = `2×hx`), `cx/cy/cz` = centre local (Y-up, base à y=0). **Diffère du `--size` du
CLI `glb collider`, qui prend des dimensions TOTALES** (§7).

**Asset externe (téléchargé/importé)** : le placer dans `assets/`, passer
`glb inspect / validate / doctor` (§7), le build le copie dans `dist/` (§4). Ajouter la
métadonnée GameLoom seulement si l'asset en a besoin (collider/physics/components).

## 3. Structure du dépôt

```
~/gameloom/
├── GAMELOOM.md · EXPERIMENTS.md (passé) · JOURNAL.md (archive, gelé)
├── *.html — 1 shell par jeu (canvas #game, HUD, overlays) + v02_test.html (page debug)
│   + viewer.html (Asset Viewer — outil, §18)
├── package.json — scripts : build, preview, viewer, glb, check:consistency, test,
│   test:<nom>, test:viewer
├── assets/ — LES GLB (découvrir : `ls assets/` + `npm run glb -- inspect assets/<nom>.glb`)
├── src/core/ — LE CORE (types, ecs, events, actions, glbs, runtime) — politique documentaire
├── src/game/ — les jeux existants (fixtures de validation/régression — cf. politique
│   documentaire) + v02_test/main.ts (page debug)
└── tools/ — cli.mjs (CLI glb) · run_harnesses.mjs (orchestrateur officiel, §15) ·
    check_consistency.mjs (checker, §4) · test_*.mjs (harnesses) · make_glb.mjs · blender/
```

`src/core/runtime.ts` = moteur (Rapier+KCC, tick, règles, actions core, zones, debug API) ;
`types.ts` = types + namespace `com.gameloom.v0`. L'état réel d'un asset (collider, physics,
components) se lit par `npm run glb -- inspect assets/<nom>.glb` — jamais par recopie.

## 4. Quick Start

Prérequis : Node 22, accès réseau npm. Commandes validées :

```bash
cd ~/gameloom && npm install                        # 1. install
npx tsc --noEmit                                     # 2. typecheck (pas de script dédié)
npm run check:consistency                           # 3. cohérence mécanique (lecture seule) — inclus dans npm test
npm run build && cp assets/*.glb dist/assets/        # 4. build prod + copie GLB (OBLIGATOIRE)
npm run preview                                      # 5. servir le build (http://localhost:4173) — /<nom>.html par jeu
node tools/run_harnesses.mjs --build                 # 6. tests OFFICIELS (build + preview + Chrome + harnesses, §15)
npm run glb -- inspect assets/barrel.glb             # 7. CLI glb (outillage asset)
npm run viewer -- --host 127.0.0.1 --port 5174      # 8. Asset Viewer (outil d'inspection — §18)
```

- `npm run build` = `tsc --noEmit && vite build` ; chaque jeu = une entrée HTML
  (`vite.config.ts`, `base: './'`).
- **Ne PAS tester sur `npm run dev`** (5173) : HMR = double-boot (2 runtimes) → toujours
  build production (4173).
- `npm run glb -- <args>` : le `--` sépare le script npm des arguments CLI.
- **`node tools/run_harnesses.mjs` est le mécanisme officiel des tests** (`npm test` =
  `check:consistency` + cet orchestrateur `--build`) : cycle de vie unique (build optionnel
  → preview 4173 → Chrome CDP 9224 → harnesses officiels → teardown garanti sur tous les
  chemins de sortie, ports 4173/9224 vérifiés libres — occupés au démarrage = refus, exit 2).
  Les scripts `test:<nom>` individuels supposent un Chrome CDP déjà lancé (§15).
- **`npm run check:consistency`** : checker de cohérence mécanique (Node pur, **lecture
  seule — ne réécrit jamais un fichier**) : versions (runtime / `package.json` / lock),
  entrées Vite ↔ pages HTML racine, liste `OFFICIAL` de l'orchestrateur ↔ fichiers/scripts
  npm, contenu de `assets/`, claims numériques stables de ce manuel ; exit 1 si
  incohérence.
- Chaque harness cible son jeu via `URL_TARGET` (défaut = la page du jeu sur 4173) —
  overridable par la variable `URL_TARGET`.

## 5. Créer un jeu

Un jeu = **une entrée HTML** (shell DOM : canvas `#game`, HUD, overlays) + **un `main.ts`**
qui appelle le core. (1) créer `<nom>.html` (copier `dungeon.html`) + `<nom>/main.ts` ;
(2) entrée dans `rollupOptions.input` ; (3) optionnel : `test:<nom>` (dupliquer un harness,
changer `URL_TARGET` + checks) ; (4) `npm run build` + `cp assets/*.glb dist/assets/` →
tester.

Exemple minimal **réel** (extrait de `src/game/main.ts`) :
```ts
import { createRuntime, A, FIXED_DT } from '../core';
import type { Runtime } from '../core';
let rt: Runtime;
async function boot() {
  rt = await createRuntime(document.getElementById('game') as HTMLCanvasElement, {
    onExplode: (p, r) => { /* effet visuel (présentation) */ },
    onFire: (o, h) => { /* tracer visuel */ },
  });
  await rt.preloadAssets(['assets/barrel.glb']);      // optionnel : charger les GLB avant spawn
  rt.spawnAsset('assets/crate.glb', [4, 0, -4]);      // y=0 : origine à la base (§6)
  rt.spawnAsset('assets/barrel.glb', [0, 0, -6]);
  rt.on('barrel', 'health.zero', { do: [A.explode(), A.destroy()] });  // EVENT→ACTION
  rt.onTick(() => { /* logique périodique, en temps de jeu (rt.time) */ });
  rt.setPaused(true);
  rt.start();
}
boot();
```

`createRuntime` : init Rapier WASM, crée le joueur `player`, le monde, la caméra, expose
`window.GameLoom`. **Le core fournit** : joueur, physique, temps déterministe, `raycast`,
actions `explode/destroy/addScore/sound`, système `damage → health.zero`. **Le jeu fournit** :
tir, vagues, munitions, audio, HUD, règles.

**Méthodes Runtime appelables du code jeu** (public, `interface Runtime`) :
`rt.spawnAsset(asset, at, overrides?)` → entité `{ id, … }` (**id = `string`**) ou `null`
· `rt.preloadAssets(assets[])` (chargement avant spawn — optionnel) ·
`rt.raycast(origin, dir, maxDist)` → `{ entity, point, distance } | null` (exclut la
capsule du joueur) · `rt.removeEntity(id)` (mesh + body + collider + entité, émet `destroy`)
· `rt.explodeAt(point, radius, damage, impulse, source)` (dégâts radiaux + impulsion, §8)
· `rt.playerState()` → `{ pos, yaw, pitch, grounded, vel }` · `rt.on`/`rt.onTick`
(règles, §11/§5) · `rt.world` (Rapier) / `rt.scene` (Three.js) / `rt.bus` (events) ·
`rt.applyPlayerControl({ move, look, jump })` (input — la **seule** voie, convention n°2 :
`move = [fwd, strafe]`) · `rt.setLook(yaw, pitch)` (visée — source unique, convention n°2)
· `rt.byId(id)` / `rt.byTag(tag)` (requêtes ECS → entités) · `rt.start()` (démarre la boucle)
· `rt.setPaused(p)` / `rt.tickOnce()` (temps déterministe, §12) · **v0.2** :
`rt.entityPosition(id)` → `[x, y, z] | null` (position Rapier d'une entité) ·
`rt.moveEntity(id, target, speed, options?)` → `boolean` (entités mobiles, ci-dessous) ·
`rt.faceEntity(id, target)` (orientation sans translation) ·
`rt.createZone(options)` → `ZoneHandle` (zones, ci-dessous).

**Tir hitscan** (code de jeu, pas du core) :

```ts
const o = eyePos();              // pos joueur + 1.55 (l'œil)
const d = lookDir();             // direction depuis yaw/pitch (vivent dans le core)
const hit = rt.raycast(o, d, 120);   // raycast Rapier — EXCLUT la capsule du joueur
if (hit?.entity && hit.entity.id !== 'player')
  rt.bus.emit('damage', hit.entity.id, { other: 'player', amount: 30, point: hit.point });
```

**Convention visée** (yaw/pitch → direction monde) : depuis `yaw`/`pitch` de
`playerState()`, `lookDir = (−sin(yaw)·cos(pitch), sin(pitch), −cos(yaw)·cos(pitch))`
(yaw 0 = −Z, pitch > 0 = lever). L'état de visée s'écrit par `rt.setLook`/`_debug.aimAt` et
se lit par `playerState()` — **jamais dupliqué dans le jeu** (convention n°2).

**Objets du monde possédés par le jeu** (sol, murs, porte — sans entité ECS) : `rt.world`
(Rapier) : `RAPIER.ColliderDesc` + `world.createRigidBody(RigidBodyDesc.fixed())` +
`world.createCollider(...)` ; mesh : `rt.scene.add(...)`. Fermer = `world.removeCollider(c,
true)` + `world.removeRigidBody(b)` (effet immédiat) + animation du mesh (présentation,
`onTick`). État ECS (health, tags, inspection) → `spawnAsset`.

**Entités mobiles possédées par le jeu** (v0.2) : spawner `physics.body = 'kinematic'` ; le
core pose `body.userData = <id>` au spawn et synchronise le mesh sur Rapier à chaque tick.
**`rt.moveEntity(id, target, speed, options?)` → boolean** : déplacement XZ de
`speed × FIXED_DT` (clamp à la destination, Y conservé), orientation vers le target
(`face: true` par défaut ; `face: false` = pas de rotation), `avoidObstacles: false` par
défaut (à `true` : le step est clampé avant les obstacles via raycast — exclut le joueur +
le body propre de l'entité — **pas de pathfinding**). **Refus** (`false` +
`console.error`, entité immobile) pour le joueur (KCC), les bodies static/dynamic et les
ids inconnus. `rt.faceEntity(id, target)` : orientation seule ; `rt.entityPosition(id)` :
position courante. **Pattern legacy (jeux #1–#4, toujours valide)** : déplacer le rigid
body directement dans `onTick` (`rt.world.bodies.getAll()`, `b.userData === id`,
`body.setTranslation({…}, true)`), verrouiller la traversée des murs par `rt.raycast`
(origine décalée le long de la direction) ; le KCC du joueur traite les corps kinematic
comme des **obstacles solides**.

**Zones / triggers (core v0.2 — `rt.createZone`)** : une zone = **AABB XZ multi-entités**
dont l'état inside/outside est **possédé par le core** (le jeu fournit les handlers) :

```ts
const h = rt.createZone({
  id: 'evac',                                    // unique (console.error sinon)
  bounds: { min: [12, -2], max: [15.5, 2] },      // [X, Z] — bornes INCLUSIVES, inversées normalisées
  tags: ['player', 'survivor'],                   // UNION : 1 tag suffit, dédupliqué par id
  onStay: (eid) => { /* 1× par fixed tick, par entité à l'intérieur — PAS un event */ },
});
h.isInside('player');                             // état courant (debug / logique de jeu)
h.destroy();                                      // retire la zone (pas de zone.exit émis)
```

Évaluation : **après la passe `onTick` du jeu, avant `rt.tick++`** (positions finales du
tick). Le core émet **`zone.enter` / `zone.exit`** sur arête uniquement — `entity` = entité
observée, `other` = id de la zone, `data = { zone, x, z }` — et appelle `onStay(eid)` chaque
tick suivant (jamais au tick d'enter). Entité détruite = **purge silencieuse** (pas de
`zone.exit` synthétique) ; `zone.destroy()` idem. Debug : `GameLoom.zones()` →
`{ id, x1, x2, z1, z2, inside: string[] }[]`. Pattern legacy (jeux #1–#4) : inclusion AABB
manuelle dans `onTick` + booléen `previousInside` pour les arêtes — n'émettre que sur la
transition.

**Tags de scène par override** : `rt.spawnAsset(asset, at, { tags: [...] })` remplace le
tag canonique (basename du GLB) ; le contexte de scène (ex. quel slot) est un tag, PAS une
capacité d'asset. **Événements personnalisés** : le bus accepte **tout** nom — le jeu émet
les siens (`rt.bus.emit('mon.event', id, {...})`) et s'y abonne via
`rt.on(tag, 'mon.event', {...})`.

## 6. GLB comme prefab + namespace metadata

Un **GLB = un prefab portable** : géométrie, matériaux, métadonnées dans l'extension glTF
**`com.gameloom.v0`** (namespace unique, versionné ; lu de la scène 0, chunk JSON —
`GLTFLoader` les ignore). Le GLB déclare les **capacités / valeurs initiales**, jamais le
comportement event→action. Structure (`GlbMeta`) : `collider?` (`{ type, size, center }`),
`physics?` (`{ body, mass }`), `components?` (plain objects). Exemple réel
(`assets/barrel.glb`) :
```json
{
  "collider":   { "type": "box", "size": [0.97, 0.9, 0.946], "center": [0, 0.45, 0] },
  "physics":    { "body": "dynamic", "mass": 30 },
  "components": { "Health": { "max": 50 }, "Explosive": { "radius": 8, "damage": 120, "impulse": 20 } }
}
```

Le **runtime** gère l'état, indépendant par instance : `Health.current` initialisé au spawn
(= `max`), `Explosive.exploded`, position, vélocité…

**⚠️ Règle critique — NE JAMAIS ALIASER** : ne JAMAIS partager les objets composants du
cache GLB entre entités. Chaque spawn obtient une **copie profonde** (`structuredClone`)
des plain objects JSON ; partager une référence « contamine » toutes les instances.

**Convention d'origine** : assets générés **origine à la base** (Blender `ORIGIN_CURSOR` à
`(0,0,0)`, `export_yup=true`) → base à **y = 0**, mesh vers +y ; **spawner à `y = 0`** pose
l'objet au sol.

## 7. CLI glb

Un seul CLI : **`glb`** (outillage asset), via `npm run glb -- <args>`, discovery par
`--help` (racine, commandes, sous-commandes). Inconnu → **exit 2** + suggestion ;
fichier absent → exit 1.

| Commande | Rôle |
|---|---|
| `glb inspect <f.glb> [--json]` | Contenu : `file`, `ns`, `meshes`, `vertices`, `boundingBox` (min/max/size/center), `gameloom` (méta ou `null`) |
| `glb validate <f.glb>` | `✓ valide` (exit 0) / `✗ INVALIDE` + problèmes (exit 1) ; avertissements `!` non bloquants |
| `glb doctor <f.glb>` | JSON : `checks.gltf` (magic, scenes, meshes, bin_chunk), `checks.bbox`, `checks.gameloom`, `checks.warnings`, `ok` |
| `glb collider auto\|set <f.glb> [--type box\|sphere\|capsule --size x,y,z --center x,y,z]` | `auto` : box depuis la bbox du mesh ; `set` : collider manuel ; écrit la méta |
| `glb physics set <f.glb> --body static\|dynamic\|kinematic [--mass N]` | Métadonnées physique (défaut dynamic mass 1) |
| `glb component add <f.glb> <Health\|Explosive\|Scored> --cle valeur …` | Ajoute un composant (champs stricts : `Health: max` · `Explosive: radius, damage, impulse` · `Scored: points`) |

`--size` : **box** = dimensions TOTALES (runtime divise par 2), **sphere** = `[rayon]`,
**capsule** = `[rayon, demi-hauteur]`. `validate` vérifie : mesh, `collider.type ∈
box|sphere|capsule` (box : 3 nombres > 0), `physics.body ∈ static|dynamic|kinematic`
(dynamic → masse > 0), `Health.max > 0`, champs `Explosive`. `doctor` avertit : collider
absent, box < bbox (tunneling), `Explosive` sans `Health`. **Réécriture du GLB** : le CLI
lit le GLB binaire (JSON + BIN) et réécrit un GLB valide (padding à 4, BIN préservé).

## 8. Colliders / physique

**Axes** : Blender **Z-up** → glTF/Three.js **Y-up** (`export_yup=true`) ; origine à la
base (y=0) — cf. §6. **Colliders** (espace **local**, via la méta `collider`) : `box` =
`size` **totales** (runtime → `cuboid(size/2)`) + `center` ; `sphere` = `[rayon]` →
`ball(rayon)` ; `capsule` = `[rayon, demi-hauteur]` → `capsule(halfHeight, radius)`
(**demi-hauteur d'abord**) ; `convex` = types seulement, **NON supporté** — ne pas
utiliser. `glb collider auto` calcule la bbox depuis les accessors `POSITION` (seuls les
VEC3 de `primitives[].attributes.POSITION` comptent — normales/couleurs à ignorer).

**Rigid body + masse** (méta `physics`) : `static` → `RigidBodyDesc.fixed()` (friction
1.0) ; `dynamic` → `RigidBodyDesc.dynamic()` + damping (linéaire 0.6, angulaire 0.9) +
`collider.setMass(mass)` — **masse sur le ColliderDesc, PAS le RigidBody** ; `kinematic` →
`RigidBodyDesc.kinematicPositionBased()` (joueur, entités manipulées).

**Constantes du monde (core, non configurables en v0.2)** : gravité `−19.62 m/s²` (2× g) ;
déplacement `5.6 m/s` ; joueur = capsule `capsule(demi-hauteur 0.55, rayon 0.45)` + KCC
(autostep 0.45/0.5, snapToGround 0.12, masse 80) ; œil à `+1.55` ; saut `v₀ = 8.2 m/s`
(apogée ≈ 2.04 m, repos à y ≈ 0.92).

**Conversion GLB → Rapier** (à chaque spawn) : méta (fallback `box 1×1×1` / `static`
1 kg) → `RigidBodyDesc` selon `physics.body` → `ColliderDesc` + `setTranslation(center)` +
`setMass` si dynamic → position = spawn (`setTranslation(..., wakeUp=true)`). **Scaling :
NON supporté** — pas d'application de `mesh.scale` au collider ; pré-échelle l'asset.

**Explosion** (`explodeAt`) : dégâts radiaux sur toute entité avec `Health` à portée
(falloff 100 %→35 % en `1 − 0.65·(d/radius)`) + impulsion sur les bodies **dynamiques**
(falloff `1 − 0.5·(d/radius)`, boost vertical) ; blesse aussi le joueur.

## 9. ECS

**8 composants** (`Cmp*`, `types.ts`) — tous des **plain objects JSON** :

| Component | Structure | Rôle |
|---|---|---|
| `CmpId` / `CmpTags` / `CmpAsset` | `{ id }` / `{ tags: string[] }` / `{ asset }` | Identité : id auto (`<tag>_<seq36>`, ex. `barrel_00d`), tags (basename GLB + overrides), GLB source |
| `CmpPhysics` | `{ body, mass, sleeping }` | Type de body + masse + sommeil Rapier (sync/tick) |
| `CmpCollider` | `{ type, size, center }` | Collider local (GLB ou fallback) |
| `CmpHealth` | `{ current, max, zeroEmitted, deadTick? }` | Vie ; `zeroEmitted` = `health.zero` déjà émis |
| `CmpExplosive` | `{ radius, damage, impulse, exploded }` | Capacité d'explosion + état par instance |
| `CmpScored` | `{ points }` | Score (cibles / joueur) |

**Joueur** (créé par le core) : `id="player"`, `tags=["player","actor"]`, `Health
{current:100, max:100}`, `Scored {points:0}`, `Physics {body:"kinematic", mass:80}`.

**Flux `Health.max` (GLB) → `Health.current` (ECS)** : le GLB déclare `max` **seul** → au
spawn, si `Health.current` est `undefined`, le core le pose à `= max` (sinon
`undefined − dégât = NaN` → `health.zero` jamais) → chaque `damage` décrémente `current` ;
à `≤ 0`, le core émet `health.zero` **une seule fois** (`zeroEmitted`) et pose `deadTick`.

**Adapter ECS** (Miniplex derrière `ecs.ts`) : 3 interfaces stables — itération (`each`,
`all`), requêtes (`byTag`, `list`, `count`), snapshot JSON ; Miniplex n'est jamais exposé.

## 10. Events

Payload : `EventCtx = { event, entity, other?, amount?, point?, data? }`. Log JSON
(`EventRecord = { t, tick, event, entity, other?, amount? }`), fenêtre glissante **max
500**. Bus **synchrone, déterministe, filtré par tag**, **depth guard > 8**, **aucune
liste blanche** (tout nom accepté).

| Event (core) | Quand | Consommé par |
|---|---|---|
| `spawn` / `destroy` | à chaque spawn (joueur au boot) / `removeEntity` | logging |
| `damage` | par le jeu (tir) ou `explodeAt` | **système santé core** (décrémente, émet `health.zero`) |
| `health.zero` | `Health.current ≤ 0` (1×) | règles du jeu |
| `collision.start` | à chaque contact Rapier | **aucune règle core** (émis + loggué) |
| `player.died` | joueur à `health.zero` | règle du jeu (game over) |
| `zone.enter` / `zone.exit` (v0.2) | arête inside/outside d'une zone `createZone` (multi-entités) | règles du jeu (§5) |

Les jeux émettent leurs **propres événements de gameplay** via `rt.bus.emit(...)` (§5).
⚠️ `types.ts` : constante `EVENTS` (7 noms core, `collision.start` absente) + commentaire
citant `wave.start, wave.clear, game.over, ammo.empty` — **jamais émis** (aspirationnels).

## 11. Actions + Rules

**Actions enregistrées : 4** (fabrique `A` ; `GameLoom.actions()` →
`["addScore","destroy","explode","sound"]`) :

| Action | Fabrique | Effet |
|---|---|---|
| `explode` | `A.explode(args?)` — `{ radius?, damage?, impulse? }` (fallback = `Explosive` de l'entité) | `exploded=true` + `explodeAt` ; no-op si déjà explosé / sans `Explosive` |
| `destroy` | `A.destroy()` | `removeEntity` (mesh + body + collider + entité, émet `destroy`) |
| `addScore` | `A.addScore(points)` | `player.Scored.points += points` |
| `sound` | `A.sound(name, gain?)` | hook `onSound` (SFX synthétisé par le jeu) |

⚠️ `types.ts` contient une constante `ACTIONS` à 7 noms — `damage`, `play`, `spawn` n'ont
**pas** de handler ni de fabrique (aspirationnel) : les 4 seulement.

**Règles** : `rt.on(target, event, block)` — `target` = tag (ou `*`),
`block = { if?, do?, fn? }` : `if` = `(ctx) => boolean`, `do` = `ActionSpec[]` (fabrique
`A`), `fn` = code de jeu `(ctx) => void` ; retourne une fonction unsubscribe. Quand
`event` est émis sur une entité tagguée `target` → `if` → chaque action de `do` → `fn`.
**EVENT → CONDITION → ACTION(S)**. La réaction en chaîne est 100 % composée (règle
`health.zero` → `explode` → dégâts → `health.zero` du voisin → …) ; ne pas créer une
Action pour ce qui se compose déjà.

## 12. Temps déterministe

Timestep fixe **`FIXED_DT = 1/60 s`** avec accumulateur. Temps réel (`resume()` +
`start()` + rAF) : max 8 ticks/frame (anti « spiral of death »). **Temps déterministe**
(`pause()` + `step(n)`) : `step(n)` exécute **exactement n ticks de jeu** (1/60 chacun),
indépendamment du temps réel — le mode des tests. Chaque tick = physique Rapier + KCC +
sync mesh/caméra + `onTick` + `tick++` + `time += 1/60`. API : `GameLoom.pause()`,
`step(n)`, `resume()`, `setPaused(p)`, `isPaused()`. Tout ce qui dépend du temps
(cooldowns, delays) s'écrit en **temps de jeu** (`rt.time`), **jamais**
`setTimeout`/`performance.now` ; les tests avancent par `step(n)`, **jamais** par
`sleep()` réel.

## 13. Debug API

### `window.GameLoom` — API publique **contractuelle** (stable)

| Méthode | Retour |
|---|---|
| `inspect(id)` | `id, tags, asset, position, health{current,max,dead}, explosive{…}, score, physics{…}, velocity` (ou `{ error }`) |
| `entities({ tag?, component? })` | Tableau : `id, tags, pos?, health?, exploded?, points?` |
| `events(limit = 30)` | Les `limit` derniers `EventRecord` |
| `stats()` | `{ tick, time, paused, fps, entities, events_total, actions[], depth }` |
| `snapshot()` | `{ tick, time, paused, player{ pos, health, score, alive, grounded }, entities }` |
| `doctor()` | `{ ok, warnings[], stats, assets{ loaded, without_gameloom_meta }, events_recent[] }` |
| `pause()` / `resume()` / `step(n = 1)` / `setPaused(p)` / `isPaused()` | contrôle du temps et état de pause (§12) |
| `rules()` / `actions()` | `{ target, event, hasIf, nActions, hasFn }[]` / actions du registry |
| `zones()` (v0.2) | `{ id, x1, x2, z1, z2, inside: string[] }[]` (les zones `createZone`, entités à l'intérieur) |
| `version` | `"0.2.0"` |

`health` dans `snapshot()`/`entities()` = chaîne `"current/max"` (ex. `"100/100"`),
**pas un nombre**.

### `GameLoom._debug` — API de dev/test **NON STABLE** ⚠️ (peut changer sans préavis ;
développer/tester, pas gameplay produit)

Visée/input : `setLook(yaw, pitch)` (pitch clampé ±1.45 rad), `look()` → `{ yaw, pitch }`,
`aimAt(x, y, z)` (calcule yaw/pitch), `input({ move?, jump? })` (move = `[fwd, strafe]`) ;
joueur : `teleportPlayer(x, y, z)` (KCC + résète la vélocité), `setPlayerHealth(h)`,
`addPlayerHealth(h)` ; entités : `spawn(asset, x, y, z)` (retourne l'id), `remove(id)`,
`clearTag(tag)` ; sonde : `fire(origin)` = **raycast sans dégâts** (portée 120) dans la
direction de visée courante (après `aimAt`/`setLook`) — `origin` = position de l'œil
(`snapshot().player.pos + [0, 1.55, 0]`) → `{ id, point, distance }` ou `null`.

**Pattern hooks de jeu** : chaque jeu ajoute ses hooks d'interaction/état à
`window.GameLoom._debug` au boot — ex. `gameFire()` (tir), `gameInteract()` (interagir à
portée), `<nom>State()` (JSON d'état du jeu : porte, clé, ennemis, victoire…),
`rayProbe(o, d, dist)` (sonde raycast arbitraire). Pas de `gameLook` : visée par
`aimAt`/`setLook`.

## 14. Workflow de debug recommandé

Escalade (du moins coûteux au plus coûteux) — ne monter que si le niveau précédent n'a pas
résolu :

1. `npx tsc --noEmit` — la majorité des bugs d'API (Rapier/Miniplex/Three) est **statique**.
2. `npm run build` — valide le bundle + copie des GLB.
3. **Harness déterministe** du jeu — premier outil de diagnostic.
4. Console (collectée par le harness) — erreurs non-gérées.
5. `GameLoom.stats()` — état global.
6. `GameLoom.entities({ tag })` — liste.
7. `GameLoom.inspect(id)` — détail d'une entité.
8. `GameLoom.events(n)` — piste d'audit (qui a émis quoi, à quel tick) — **l'outil principal**.
9. `GameLoom.doctor()` — diagnostics (joueur ? morts non détruites ? assets sans méta ?).
10. `pause()`/`step()` — rejouer tick par tick autour de l'événement suspect.
11. **Screenshot** — seulement si le problème est réellement visuel, jamais pour la logique.

**Principe** : observable structuré **d'abord**, vision en **dernier recours**.

## 15. Tests : orchestrateur + harness CDP

**Mécanisme officiel : `node tools/run_harnesses.mjs`** (`npm test` = `check:consistency` +
cet orchestrateur `--build`). Cycle de vie complet et garanti (portable
Windows/macOS/Linux, Node pur) : build (`--build`) → `vite preview` (4173) +
**Chrome headless CDP (9224)** lancés détachés (logs tmp, PID conservés) → chaque harness
(`tools/test_*.mjs`, **1 target page frais par harness** — isolation de la console ;
l'orchestrateur transmet l'identité de la target via `CDP_TARGET_WS` et vérifie qu'il reste
exactement 1 page) → teardown par arbre sur **tous** les chemins de sortie (normal, FAIL,
exception, timeout, Ctrl+C/SIGTERM) + ports 4173/9224 vérifiés libres. Ports occupés au
démarrage = **refus** (exit 2) — l'orchestrateur ne tue jamais un processus qu'il n'a pas
créé. Usage : `node tools/run_harnesses.mjs [test_xxx...] [--repeat N] [--build]`
(sans arg : les harnesses officiels — liste `OFFICIAL` dans `run_harnesses.mjs`) ·
exit 0 = tous verts, 1 = échec harness, 2 = infrastructure. Chrome : défaut par plateforme,
override `CHROME_PATH`.

`test_headless.mjs` = harness de référence ; les autres = **même pattern** (CDP `ws` →
`Runtime.evaluate`, `check()`/bilan, temps par `pause()`/`step(n)`, `URL_TARGET` propre au
jeu ; les slices comparent un **fingerprint de ticks** entre runs). Nouveau jeu : dupliquer
un harness, changer `URL_TARGET` + checks. Si un harness est lancé **seul**
(`npm run test:<nom>`), il cible le 1er target `page` d'un Chrome CDP déjà prêt : Chrome
headless (`--headless=new --use-gl=angle --use-angle=swiftshader
--enable-unsafe-swiftshader --remote-debugging-port=9224 --user-data-dir=<tmp>
--mute-audio about:blank` — flags exacts dans `run_harnesses.mjs`) + `vite preview` (4173),
lancement **détaché** (stdio vers log, PID conservé, arrêt par PID — jamais de handles
hérités). Pattern : naviguer sur `URL_TARGET` (build production) → attendre
`typeof window.GameLoom === "object"` → input/temps via `_debug` + `pause()`/`step(n)`
(jamais `sleep()`) → interroger `snapshot()`/`entities()`/`inspect()`/`events(n)`
(**l'outil principal** : la preuve de la séquence) → asserter les JSON (`BILAN: n/n tests
passés`, exit 0) → screenshot en dernier recours (`Page.captureScreenshot`, git-ignoré
`tools/*_screenshot.png`). Cache navigateur **désactivé**
(`Network.setCacheDisabled` — 404 HTML mis en cache sinon).

Le viewer a son propre harness autonome (`npm run test:viewer`, ports 4180/9225, cycle de
vie complet) — volontairement **hors** de la suite officielle des jeux.

## 16. Conventions & pièges

Violées = bugs réels (récits : `EXPERIMENTS.md`).

**Conventions** :
1. **Composants = plain objects JSON** — `structuredClone` pour dupliquer ; état
   indépendant par spawn (jamais d'aliasing des composants du GLB — §6).
2. **Input et yaw/pitch : une seule source de vérité** (le core) ; le jeu écrit l'input par
   événement clavier (ne ré-écrit PAS l'input chaque tick), la visée par
   `setLook`/`_debug.aimAt` — jamais de valeurs dupliquées dans le jeu.
3. **Vitesse en m/s × `FIXED_DT`** (sinon 5.6 m/**tick**) ; gameplay temporel en **temps de
   jeu** (`rt.time`), jamais `setTimeout`/`performance.now` ; tests par ticks
   (`pause()`/`step(n)`), jamais `sleep()`.
4. **Pas de comportement event→action dans le GLB** (capacités seulement) ; pas de mutation
   permanente du GLB pendant le gameplay (état dans l'ECS).
5. **IDs uniques** auto-générés (`<tag>_<seq36>`) ; tags canoniques = basename du GLB.
6. **Origine des assets à la base** — spawn à `y = 0` (§6).
7. **Tester sur le build production** (4173), jamais sur le dev (5173, HMR = double-boot) ;
   **copier les GLB dans `dist/assets/`** après chaque build.

**Pièges (à connaître avant de coder)** :
1. **`RAPIER.init()`** : `await RAPIER.init()` (appeler) — sans `()`, le WASM n'est jamais
   initialisé, **silencieux**.
2. **API Rapier 0.21** : `setMass()` sur le **ColliderDesc** ; `isDynamic()` ;
   `ColliderDesc.setTranslation(x,y,z)` (3 args) ; `capsule(halfHeight, radius)` ;
   `kinematicPositionBased()` ; `EventQueue(false)` ; `world.bodies.getAll()` /
   `world.colliders` (propriétés) ; `world.colliders.get(handle)`.
3. **`Health.current`** : sans init `current = max` → `NaN` → `health.zero` jamais émis.
4. **Raycast** : point d'impact = `origin + dir * toi` ; `rt.raycast` **exclut la capsule
   du joueur** (verrouiller/viser) ; depuis l'intérieur d'un collider (ex. son propre
   projectile) → TOI = 0 : caster depuis l'extérieur (`pos + dir × rayon`) ; `hit.entity`
   peut être `null` (projectile du jeu) — le traiter dans le tir.
5. **Blender/glTF axes** : Z-up→Y-up (`export_yup=true`) + origine à la base.
6. **Accessors `POSITION`** : normales/couleurs = `VEC3` — bbox = `POSITION` seul.
7. **Buffer Node poolé** : normaliser `(arrayBuffer, byteOffset, byteLength)` (CLI).
8. **Tag du chemin complet** : utiliser le **basename**.
9. **Scènes de test contrôlées** : positions fixes, pas d'aléatoire non seedé.
10. **Chemins relatifs au repo** dans les scripts (un absolu d'OS crashait le harness
    Windows malgré des checks passés).
11. **Processus persistants** (Chrome, `vite preview`, viewer) : lancement **détaché**
    (stdio vers log, PID conservé, arrêt par PID) — jamais de handles hérités vers l'outil
    shell.

## 17. Ce qui N'EXISTE PAS (ne pas supposer)

Non implémenté en v0.2 — ne pas inventer d'API :

- **Éditeur visuel / GUI** d'édition de scène.
- **DSL GameLoom** — pas de langage, parser ou compilateur dédié.
- **CLI `game`** — le seul CLI est `glb`.
- **Alias metadata / versions multiples** — un seul namespace `com.gameloom.v0`.
- **Audio dans le GLB** — audio synthétisé (Web Audio) dans le jeu.
- **Inventory**, **quests génériques**, **save/load**, **multiplayer/réseau**.
- **Animation / root-motion** — aucun asset animé ; le runtime n'anime pas les entités
  (l'Asset Viewer, §18, lit les clips GLTF si un asset en contient — lecture, pas gameplay).
- **Collider `convex`** — types seulement, non supporté au runtime.
- **Scaling d'instance appliqué au collider** (§8).
- **Events `wave.start / wave.clear / game.over / ammo.empty`** — cités dans `types.ts`,
  **jamais émis** ; **actions `damage / play / spawn`** — citées, **non enregistrées**.
- **`collision.start`** — émis/loggué, aucune règle ne s'y abonne.
- **Pathfinding / navigation mesh** — `avoidObstacles` ne fait que clamping le step avant
  les obstacles (raycast) ; pas d'évitement ni de replanification.

## 18. Asset Viewer (outil d'inspection GLB)

Le viewer est un **outil**, pas un jeu ni un éditeur : un agent charge un asset par URI et
donne à l'humain une URL pour l'inspecter visuellement — **mono-asset** (`?asset=`, GLB) ou
**HUMAN CHOICE** (`?choice=`, plusieurs GLB et/ou images en simultané sur UNE page, §18.1).
Hors runtime — **aucun** import du core ; le viewer lit le GLB + l'extension
`com.gameloom.v0` par lui-même, le collider est un overlay géométrique Three.js (PAS un
body Rapier).

```bash
npm run build && cp assets/*.glb dist/assets/        # 1. build (comme les jeux)
npm run viewer -- --host 127.0.0.1 --port 5174      # 2. viewer sur 127.0.0.1:5174
# → http://127.0.0.1:5174/viewer.html?asset=/assets/guardian.glb
# → http://127.0.0.1:5174/viewer.html?choice=/assets/a.glb,/assets/b.glb,/assets/c.glb
```

- **Host/port** : défauts `127.0.0.1:5174`, **overrideables**
  (`npm run viewer -- --host 0.0.0.0 --port 8080`, ou tout sous-ensemble) ; `vite preview`
  sert le build. GameLoom ne devine ni n'ouvre rien : exposition réseau (proxy inverse,
  VPS, Tailscale…) = infrastructure extérieure, aucune logique réseau dans le repo.
- **URI = contrat asset** : `?asset=/assets/foo.glb` (mono-asset) ou
  `?choice=/assets/a.glb,/assets/b.glb,…` (Choice Mode — liste séparée par des virgules,
  sans manifeste, sans liste codée en dur) ; relative à l'origine du serveur — compatible
  reverse proxy / chemin distant ; **aucun** état serveur.
- **GLB régénéré pendant que le viewer tourne** : pas de redémarrage du serveur —
  `vite preview` ressert le fichier depuis `dist/` à chaque requête (copier le GLB
  régénéré dans `dist/assets/` et recharger la page suffit). Si le navigateur garde
  l'ancienne ressource, cache-buster dans l'URI asset (`?asset=/assets/foo.glb?v=2`).
- **Options URL** (état réécrit via `history.replaceState` → une URL partagée décrit la
  vue) : `&animation=<nom>` (sélection + lecture) · `&skeleton=1` · `&collider=1` ·
  `&wireframe=1` · `&bbox=1` · `&grid=1` · `&axes=1` · `&mesh=0` · `&materials=0` ·
  `&speed=2` · `&loop=0`.
- **Affichage** : orbit/zoom/pan (OrbitControls) + auto-framing (bbox → centrage +
  distance caméra) ; toggles : mesh, matériaux/textures (OFF = matériau neutre temporaire,
  ON restaure les originaux), wireframe (réversible), bounding box, **collider GameLoom**
  (box/sphere/capsule de la méta, overlay visuel), skeleton (`SkeletonHelper`, auto-on si
  rig détecté), grille, axes.
- **Animations GLTF** : liste nom + durée, Play/Pause/Stop, loop, vitesse, timeline
  (`AnimationMixer` Three.js — aucune logique de gameplay nécessaire).
- **Panneau** : infos GLB (scènes/meshes/vertices/triangles/matériaux/textures/animations/
  skinned meshes/bones/bbox) + metadata `com.gameloom.v0` réelles (collider, physics,
  components — rien d'inventé).

### 18.1 Choice Mode (HUMAN CHOICE)

`?choice=` présente plusieurs candidats **simultanément sur UNE SEULE PAGE** pour que
l'humain compare et choisisse avant que l'agent agisse. **GLB** : viewport Three.js
indépendant par candidat (OrbitControls, auto-framing, matériaux/textures) + metadata
(meshes, triangles, matériaux, animations, rig OUI/NON, bbox, capacités). **Images
PNG/JPG/JPEG/WebP** : aperçu simultané + nom/URI/format/dimensions — **pas de Three.js**
pour une image. Mélange GLB + images autorisé ; type non supporté ou fichier invalide =
erreur **locale** sur cette carte (les autres candidats restent opérationnels).

Chaque carte : **INSPECT** (→ viewer mono-asset existant `?asset=<URI>`) et **CHOOSE**.
CHOOSE n'enregistre **que** la sélection humaine dans l'URL (`&selected=<URI>` — une URL
partagée conserve le choix ; stateless, sans backend) : il ne déplace/modifie AUCUN
fichier ni GLB, n'écrit aucune metadata, n'appelle aucun backend — l'agent reste
responsable de ce qu'il fait du choix ensuite. Le candidat sélectionné est visuellement
évident (surbrillance + badge).

**Contrat de choix (agent/humain)** — deux canaux complémentaires, sans aucun backend :
**Pull** : `window.GameLoomViewer.getChoice()` → `{ selected }` · **Push** :
`window.addEventListener("gameloom:choice", handler)` — émis à chaque sélection (bouton
CHOOSE ou `GameLoomViewer.selectChoice`), après la mise à jour de l'état/URL ;
`event.detail.selected` contient l'URI choisie (`detail` strictement JSON-sérialisable :
`selected`, `index`, `type`).

The viewer does not communicate with a specific agent framework. An external agent/browser
harness may observe the choice through the pull API, the browser event, polling, CDP, or
another external mechanism. For polling-based integrations, use a finite timeout; never
block indefinitely.

### `window.GameLoomViewer` — API JSON pour agent/debug

Tout retour est sérialisable en JSON (aucun objet Three.js exposé) ; les méthodes sont
sûres sans asset chargé (retour `{ ok: false, error }` ou `{ loaded: false }` — jamais
d'exception). L'API **`mode()`** dit quel contrat est actif ; les méthodes d'un mode ne
sont pas exposées dans l'autre :

| Méthode | Rôle |
|---|---|
| `mode()` | `{ mode: "single" \| "choice" }` |
| `info()` | (single) stats complètes : `uri, loaded, scenes, meshes, vertices, triangles, materials, textures, animations[{name,duration}], skinnedMeshes, bones, rigDetected, bbox{min,max,size}, metadata (ou null)` |
| `asset()` | (single) `{ uri, loaded, error }` |
| `animations()` | (single) `[{ name, duration, selected, playing, time }]` |
| `playAnimation(name?)` / `pauseAnimation()` / `stopAnimation()` | (single) lecture (nom absent = animation courante/première) |
| `setAnimationTime(s)` / `setAnimationSpeed(v)` | (single) timeline / vitesse |
| `setMeshVisible(b)` / `setMaterialsVisible(b)` / `setWireframe(b)` / `setColliderVisible(b)` / `setBoundingBoxVisible(b)` / `setSkeletonVisible(b)` / `setGridVisible(b)` / `setAxesVisible(b)` | (single) toggles (retour `{ ok, …état }`) |
| `getState()` | (single) état complet des toggles + animation (JSON) |
| `choices()` | (choice) `[{ uri, kind, name, loaded, error, … }]` — par candidat : GLB → `info` (stats ci-dessus) ; image → `format`, `width`, `height` |
| `getChoice()` | (choice) `{ selected }` — URI du choix humain, `null` avant tout choix |
| `selectChoice(uri)` | (choice) enregistre la sélection → `{ ok: true, selected }` + `&selected=<URI>` dans l'URL ; URI inconnue → `{ ok: false, error }` (aucune mutation de projet) |

**Frontière** : inspection + choix uniquement — l'édition reste le CLI `glb` + Blender
(collider, physics, components) ; le viewer ne modifie jamais un GLB ni le projet (Choice
Mode = affichage + mémorisation locale du choix dans l'URL). **Testé par
`npm run test:viewer`** (harness autonome, ports 4180/9225 — volontairement **hors** de
la suite officielle des jeux, §15).

---

*Version : GameLoom v0.2. Historique, preuves et décisions : `EXPERIMENTS.md`.*
