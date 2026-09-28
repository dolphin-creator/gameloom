# GameLoom — Manuel opérationnel (v0.2)

> Source de vérité **opérationnelle** : état ACTUEL de GameLoom (API, CLI, conventions,
> procédures) — **autonome** : un agent neuf crée, exécute, teste et débugue un jeu en n'en
> lisant que ce fichier. Historique, preuves, décisions : `EXPERIMENTS.md` (ne pas charger pour un jeu standard).

## Politique documentaire (à lire d'abord)

**`GAMELOOM.md` = le présent opérationnel.** Écrire ici quand une modification change :
l'API publique, le CLI, les métadonnées GLB, les composants, les events/actions core, la
physique, la debug API, le workflow officiel, les commandes, les conventions, une
limitation actuelle importante, une procédure d'usage. Une modification fonctionnelle n'est
**pas terminée** tant que ce fichier ne reflète pas le comportement validé (implémenter →
tests verts → mettre à jour) ; core inchangé → le fichier ne doit **presque pas** grossir.
**Ne PAS y écrire** : récit d'expérience, métriques historiques, résultats détaillés,
temps de développement, hypothèses, justifications longues, idées futures.

**`EXPERIMENTS.md` = mémoire d'ingénierie (passé + futur).** Écrire là après : nouveau
vertical slice, expérience architecturale, benchmark, bug architectural, mesure de
friction, comparaison, décision de NE PAS ajouter une abstraction, primitive candidate,
validation/invalidation d'une hypothèse. **`JOURNAL.md`** = archive brute du bootstrap (jeu #1) — ne plus mettre à jour.

**Quand lire quoi** : créer un jeu / CLI / déboguer → **`GAMELOOM.md` seul** ; modifier le
core → `GAMELOOM.md` **+** `EXPERIMENTS.md` avant de concevoir ; ajouter une abstraction →
`EXPERIMENTS.md` **obligatoirement** (preuves, § Candidate abstractions) ; nouveau slice
expérimental → `EXPERIMENTS.md` seulement si la mission porte explicitement sur
l'architecture. **Anti-gonflement** : ce n'est pas un journal — avant un paragraphe : « Un
agent a-t-il besoin de ceci pour la version ACTUELLE ? » Non → `EXPERIMENTS.md` ; règle
remplacée → **remplacer**, ne pas empiler. **Cohérence** : contradiction → `GAMELOOM.md`
fait autorité sur le présent, `EXPERIMENTS.md` sur l'historique.

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
`pause()` + `step(n)` pilotent les ticks de jeu, jamais le temps réel). **Frontière** : le
GLB dit « je suis un baril, `Health.max = 50`, je *peux* exploser » ; le TS dit « *quand*
ta vie arrive à zéro, tu exploses puis tu te détruis » (`rt.on('barrel', 'health.zero', { do: [A.explode(), A.destroy()] })`).

## 2. Stack

Versions installées (`package.json`) :

| Dépendance | Version | Rôle |
|---|---|---|
| TypeScript | 7.0.2 | Langage du code (`tsconfig` strict, `noEmit`, Vite bundle) |
| Vite | 8.3.1 | Build (Rolldown) + dev/preview, `base: './'`, ports 5173/4173 |
| Three.js | 0.186.1 | Rendu (présentation **uniquement** — le gameplay ne lit jamais le rendu) + `GLTFLoader` |
| Rapier `@dimforge/rapier3d-compat` | 0.21.0 | Physique WASM (monde, bodies, colliders, raycast, KCC) |
| Miniplex | 2.0.0 | ECS derrière un adapter à 3 interfaces stables (`ecs.ts`) |

Dev : `@types/three` 0.186.0, `@types/node` 26.6.3, `ws` 8.22.0 (harness CDP). **Blender**
4.2 LTS (headless) = pipeline général pour assets procéduraux plus complexes
(`tools/blender/*.py`) — hors npm ; **`tools/make_glb.mjs`** = alternative légère Node pour
assets low-poly simples (boîtes composées, GLB binaire valide, sans Blender). Pipeline
validé (asset `switch.glb`) :

```bash
node tools/make_glb.mjs <nom>                                        # → assets/<nom>.glb (recettes dans RECIPES)
npm run glb -- collider auto assets/<nom>.glb                        # collider box depuis la bbox
npm run glb -- physics set assets/<nom>.glb --body static            # ou dynamic/kinematic [--mass N]
npm run glb -- validate assets/<nom>.glb && npm run glb -- doctor assets/<nom>.glb
```

**Chrome headless** (`--headless=new`, WebGL SwiftShader) pour les
tests. Règle : une dépendance ne doit pas coupler l'API publique (Miniplex derrière l'adapter, Rapier dans le runtime).

## 3. Structure du dépôt

```
~/gameloom/
├── GAMELOOM.md ← ce fichier · EXPERIMENTS.md ← mémoire d'ingénierie · JOURNAL.md ← archive
├── index/temple/ruins/dungeon/outpost/reactor/cargo.html ← shells des 7 jeux (canvas #game, HUD, overlays)
│   · v02_test.html ← page de test des primitives core v0.2 (pas un jeu)
├── package.json ← scripts : dev, build, preview, glb, test (orchestrateur),
│   test:v02/headless/temple/ruins/dungeon/outpost/reactor/cargo
├── tsconfig.json · vite.config.ts ← TS strict noEmit · multi-entry (8 HTML), base './'
├── assets/ ← 14 GLB : barrel, crate, target, switch, guardian, artifact, ruins_column,
│            dungeon_key, dungeon_mage, dungeon_spikes, survivor, reactor, socket, energy_cell
├── src/core/ ← LE CORE (types, ecs, events, actions, glbs, runtime, index) — modifier
│             seulement selon la politique documentaire + après EXPERIMENTS.md
├── src/game/ ← 7 jeux (références d'usage) : main.ts (#1 Barrel Blaster),
│              temple/main.ts (#2), ruins/main.ts (#3), dungeon/main.ts (#4),
│              outpost/main.ts (#5, zones + moveEntity core), reactor/main.ts (#6),
│              cargo/main.ts (#7) · v02_test/main.ts (page debug)
└── tools/    ← run_harnesses.mjs (ORCHESTRATEUR officiel, §15), cli.mjs (CLI `glb`),
                test_v02/headless/temple/ruins/dungeon/outpost/reactor/cargo.mjs (harness CDP 9224),
                make_glb.mjs, diag_*.mjs (one-shots), blender/ (make_assets.py, make_ruins_assets.py,
                make_dungeon_assets.py)
```

`src/core/runtime.ts` = moteur (Rapier+KCC, tick, règles, actions core, mouvement/zones v0.2, debug API) ;
`types.ts` = types + namespace `com.gameloom.v0`. Nouveau jeu : lire `src/game/cargo/main.ts`
(jeu le plus récent) ou `src/game/outpost/main.ts` (moveEntity + zones core) ou
`src/game/dungeon/main.ts` (dense).

**Inventaire des 14 GLB existants** (capacités = métadonnées `com.gameloom.v0`, vérifiable
par `npm run glb -- inspect assets/<nom>.glb`) :

| Asset | Body | Capacités (`components`) |
|---|---|---|
| `barrel.glb` | dynamic (30 kg) | `Health.max=50` · `Explosive{radius:8, damage:120, impulse:20}` |
| `crate.glb` | static | — (décor/couvert 1,5 m) |
| `target.glb` | static | `Health.max=30` · `Scored{points:100}` |
| `switch.glb` | static | — (généré par `make_glb.mjs`) |
| `guardian.glb` | kinematic | `Health.max=100` (entité mobile, §5) |
| `artifact.glb` | static | — |
| `ruins_column.glb` | static | — (colonne 3,4 m) |
| `dungeon_key.glb` | static | — |
| `dungeon_mage.glb` | kinematic | `Health.max=80` (entité mobile, §5) |
| `dungeon_spikes.glb` | static | — (plateforme 3×3 m de pointes) |
| `survivor.glb` | kinematic | `Health.max=100` (entité mobile v0.2, §5) |
| `reactor.glb` | static | — (réacteur #6) |
| `socket.glb` | static | — (socket #7) |
| `energy_cell.glb` | static | — (cellule d'énergie #7) |

## 4. Quick Start

Prérequis : Node 22, accès réseau npm. Commandes validées (copier/coller) :

```bash
cd ~/gameloom && npm install                        # 1. install
npx tsc --noEmit                                     # 2. typecheck (pas de script dédié)
npm run build && cp assets/*.glb dist/assets/        # 3. build prod + copie GLB (OBLIGATOIRE)
npm run preview                                      # 4. servir le build (http://localhost:4173)
#    → #1: / · #2: /temple.html · #3: /ruins.html · #4: /dungeon.html · #5: /outpost.html
#    · #6: /reactor.html · #7: /cargo.html
#    · page debug v0.2: /v02_test.html
node tools/run_harnesses.mjs --build                 # 5. tests OFFICIELS (build + preview + Chrome + 8 harnesses, §15)
npm run glb -- inspect assets/barrel.glb             # 6. CLI glb (outillage asset)
```

- `npm run build` = `tsc --noEmit && vite build` ; chaque jeu = une entrée HTML dans `rollupOptions.input` (`vite.config.ts`, 6 entrées).
- **Ne PAS tester sur `npm run dev`** (5173) : HMR = double-boot (2 runtimes) → toujours
  build production (4173).
- `npm run glb -- <args>` : le `--` sépare le script npm des arguments CLI.
- **`node tools/run_harnesses.mjs` (= `npm test`) est le mécanisme officiel** : un seul
  cycle de vie (build optionnel → preview 4173 → Chrome CDP 9224 → 8 harnesses officiels →
  teardown garanti sur tous les chemins de sortie, ports 4173/9224 vérifiés libres —
  s'ils sont occupés au démarrage, l'orchestrateur refuse de démarrer, exit 2). Les scripts
  `test:<nom>` individuels supposent un Chrome CDP déjà lancé (§15).
- Chaque harness cible son jeu via `URL_TARGET` (défauts `http://localhost:4173/`,
  `/temple.html`, `/ruins.html`, `/dungeon.html`, `/outpost.html`, `/reactor.html`,
  `/cargo.html`, `/v02_test.html`) — overridable par la variable `URL_TARGET`.

## 5. Créer un jeu

Un jeu = **une entrée HTML** (shell DOM : canvas `#game`, HUD, overlays) + **un
`main.ts`** qui appelle le core. (1) créer `<nom>.html` (copier `dungeon.html`) + `<nom>/main.ts` ;
(2) entrée dans `rollupOptions.input` ; (3) optionnel : `test:<nom>` (dupliquer un harness, changer `URL_TARGET` + checks) ; (4) `npm run build` + `cp assets/*.glb dist/assets/` → tester.

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
actions `explode/destroy/addScore/sound`, système `damage → health.zero`. **Le jeu fournit** : tir,
vagues, munitions, audio, HUD, règles.

**Méthodes Runtime appelables du code jeu** (public, `interface Runtime`) :
`rt.spawnAsset(asset, at, overrides?)` → entité `{ id, … }` (**id = `string`**) ou `null`
· `rt.preloadAssets(assets[])`
(charge les GLB avant spawn — optionnel) · `rt.raycast(origin, dir, maxDist)` →
`{ entity, point, distance } | null` (exclut la capsule du joueur) · `rt.removeEntity(id)`
(mesh + body + collider + entité, émet `destroy`) · `rt.explodeAt(point, radius, damage,
impulse, source)` (dégâts radiaux + impulsion, cf. §8) · `rt.playerState()` →
`{ pos, yaw, pitch, grounded, vel }` · `rt.on`/`rt.onTick` (règles, §11/§5) · `rt.world`
(Rapier) / `rt.scene` (Three.js) / `rt.bus` (events) · `rt.applyPlayerControl({ move,
look, jump })` (input — la **seule** voie, convention n°3 : `move = [fwd, strafe]`) ·
`rt.setLook(yaw, pitch)` (visée — source unique, convention n°4) · `rt.byId(id)` /
`rt.byTag(tag)` (requêtes ECS → entités) · `rt.start()` (démarre la boucle) ·
`rt.setPaused(p)` / `rt.tickOnce()` (temps déterministe, §12) · **v0.2** :
`rt.entityPosition(id)` → `[x, y, z] | null` (position Rapier d'une entité) ·
`rt.moveEntity(id, target, speed, options?)` → `boolean` (§5, entités mobiles) ·
`rt.faceEntity(id, target)` (orientation sans translation) ·
`rt.createZone(options)` → `ZoneHandle` (§5, zones).

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
(yaw 0 = −Z, pitch > 0 = lever) — validée fin de bout en bout (calibration `aimAt`/`look`
+ tirs réels, Game #6). L'état de visée s'écrit par `rt.setLook`/`_debug.aimAt` et se lit
par `playerState()` (convention n°4 — ne jamais dupliquer yaw/pitch dans le jeu).

**Objets du monde possédés par le jeu** (sol, murs, porte, grille — sans entité ECS) :
`rt.world` (Rapier) + `rt.scene` (Three.js) : `RAPIER.ColliderDesc` +
`world.createRigidBody(RigidBodyDesc.fixed())` + `world.createCollider(...)` + mesh
`rt.scene.add(...)`. L'ouvrir = `world.removeCollider(c, true)` + `world.removeRigidBody(b)`
(effet immédiat) + animation du mesh (présentation, `onTick`). État ECS (health, tags,
inspection) → `spawnAsset`.

**Entités mobiles possédées par le jeu** (v0.2, `src/game/outpost/main.ts`) : spawner
`physics.body = 'kinematic'` ; le core pose `body.userData = <id>` au spawn et synchronise le
mesh sur la position Rapier à chaque tick. Le jeu déplace l'entité avec **`rt.moveEntity(id,
target, speed, options?)`** : déplacement XZ de `speed × FIXED_DT` (clamp à la destination,
Y conservé), orientation vers le target (`face: true` par défaut ; `face: false` = pas de
rotation), `avoidObstacles: false` par défaut (à `true` : le step est clampé avant les
obstacles via raycast — exclut le joueur + le body propre de l'entité — **pas de pathfinding**).
Retourne `true` si déplacé, `false` sinon ; **refus** (`false` + `console.error`, entité
immobile) pour le joueur (KCC), les bodies static/dynamic et les ids inconnus.
`rt.faceEntity(id, target)` : orientation seule. `rt.entityPosition(id)` : position courante.
**Pattern legacy (jeux #1–#4, toujours valide)** : retrouver le rigid body
(`rt.world.bodies.getAll()`, `b.userData === id`) et le déplacer dans `onTick` :
`body.setTranslation({...}, true)` + `body.setRotation({...}, true)` ; verrouiller le
déplacement avec `rt.raycast` (origine décalée le long de la direction) pour empêcher la
traversée des murs. Le KCC du joueur traite les corps kinematic comme des **obstacles solides**.

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
`{ id, x1, x2, z1, z2, inside: string[] }[]`. **Pattern legacy (jeux #1–#4)** : inclusion
AABB manuelle dans `onTick` + booléen `previousInside` pour les arêtes enter/exit —
n'émettre que sur la transition.

**Tags de scène par override** : `rt.spawnAsset(asset, at, { tags: [...] })` remplace le
tag canonique (basename du GLB) ; le contexte de scène (ex. quel slot) est un tag, PAS une
capacité d'asset. **Événements personnalisés** : le bus accepte **tout** nom — le jeu émet
les siens (`rt.bus.emit('mon.event', id, {...})`) et s'y abonne via `rt.on(tag, 'mon.event', {...})`.

## 6. GLB comme prefab + namespace metadata

Un **GLB = un prefab portable** : géométrie, matériaux, métadonnées dans l'extension glTF
**`com.gameloom.v0`** (namespace unique, versionné ; lu de la scène 0, chunk JSON —
`GLTFLoader` les ignore). Le GLB déclare les **capacités / valeurs initiales**, jamais le
comportement event→action. Structure (`GlbMeta`) : `collider?` (`{ type, size, center }`),
`physics?` (`{ body, mass }`), `components?` (plain objects). Exemple réel (`assets/barrel.glb`) :
```json
{
  "collider":   { "type": "box", "size": [0.97, 0.9, 0.946], "center": [0, 0.45, 0] },
  "physics":    { "body": "dynamic", "mass": 30 },
  "components": { "Health": { "max": 50 }, "Explosive": { "radius": 8, "damage": 120, "impulse": 20 } }
}
```

Le **runtime** gère l'état, indépendant par instance : `Health.current` initialisé au spawn (= `max`), `Explosive.exploded`, position, vélocité…

**⚠️ Règle critique — NE JAMAIS ALIASER** : ne JAMAIS partager les objets composants du
cache GLB entre entités. Chaque spawn obtient une **copie profonde** (`structuredClone`)
des plain objects JSON ; partager une référence « contamine » toutes les instances.

**Convention d'origine** : assets générés **origine à la base** (Blender `ORIGIN_CURSOR` à
`(0,0,0)`, `export_yup=true`) → base à **y = 0**, mesh vers +y ; **spawner à `y = 0`** pose l'objet au sol.

## 7. CLI glb

Un seul CLI : **`glb`** (outillage asset), via `npm run glb -- <args>`, discovery par
`--help` (racine, commandes, sous-commandes). Inconnu → **exit 2** + suggestion ; fichier absent → exit 1.

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
absent, box < bbox (tunneling), `Explosive` sans `Health`. **Réécriture du GLB** : le CLI lit le
GLB binaire (JSON + BIN) et réécrit un GLB valide (padding à 4, BIN préservé) — sans `@gltf-transform`.

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
`collider.setMass(mass)` — **masse sur le ColliderDesc, PAS le RigidBody** ; `kinematic` → `RigidBodyDesc.kinematicPositionBased()` (joueur, entités manipulées).

**Constantes du monde (core, non configurables en v0.2)** : gravité `−19.62 m/s²` (2× g) ;
déplacement `5.6 m/s` ; joueur = capsule `capsule(demi-hauteur 0.55, rayon 0.45)` + KCC (autostep 0.45/0.5,
snapToGround 0.12, masse 80) ; œil à `+1.55` ; saut `v₀ = 8.2 m/s` (apogée ≈ 2.04 m, repos à y ≈ 0.92).

**Conversion GLB → Rapier** (à chaque spawn) : méta (fallback `box 1×1×1` / `static`
1 kg) → `RigidBodyDesc` selon `physics.body` → `ColliderDesc` + `setTranslation(center)` +
`setMass` si dynamic → position = spawn (`setTranslation(..., wakeUp=true)`). **Scaling :
NON supporté** — pas d'application de `mesh.scale` au collider ; pré-échelle l'asset.

**Explosion** (`explodeAt`) : dégâts radiaux sur toute entité avec `Health` à portée
(falloff 100 %→35 % en `1 − 0.65·(d/radius)`) + impulsion sur les bodies **dynamiques** (falloff `1 − 0.5·(d/radius)`, boost vertical) ; blesse aussi le joueur.

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

**Joueur** (créé par le core) : `id="player"`, `tags=["player","actor"]`, `Health {current:100, max:100}`, `Scored {points:0}`, `Physics {body:"kinematic", mass:80}`.

**Flux `Health.max` (GLB) → `Health.current` (ECS)** : le GLB déclare `max` **seul** →
au spawn, si `Health.current` est `undefined`, le core le pose à `= max` (sinon
`undefined − dégât = NaN` → `health.zero` jamais) → chaque `damage` décrémente `current` ; à `≤ 0`, le core émet `health.zero` **une seule fois** (`zeroEmitted`) et pose `deadTick`.

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
⚠️ `types.ts` : constante `EVENTS` (7 noms core dont `zone.enter`/`zone.exit`, `collision.start` absent)
+ commentaire citant `wave.start, wave.clear, game.over, ammo.empty` — **jamais émis** (aspirationnels).

## 11. Actions + Rules

**Actions enregistrées : 4** (fabrique `A` ; `GameLoom.actions()` → `["addScore","destroy","explode","sound"]`) :

| Action | Fabrique | Effet |
|---|---|---|
| `explode` | `A.explode(args?)` — `{ radius?, damage?, impulse? }` (fallback = `Explosive` de l'entité) | `exploded=true` + `explodeAt` ; no-op si déjà explosé / sans `Explosive` |
| `destroy` | `A.destroy()` | `removeEntity` (mesh + body + collider + entité, émet `destroy`) |
| `addScore` | `A.addScore(points)` | `player.Scored.points += points` |
| `sound` | `A.sound(name, gain?)` | hook `onSound` (SFX synthétisé par le jeu) |

⚠️ `types.ts` contient une constante `ACTIONS` à 7 noms — `damage`, `play`, `spawn` n'ont **pas** de handler ni de fabrique (aspirationnel) : les 4 seulement.

**Règles** : `rt.on(target, event, block)` — `target` = tag (ou `*`), `block = { if?,
do?, fn? }` : `if` = `(ctx) => boolean`, `do` = `ActionSpec[]` (fabrique `A`),
`fn` = code de jeu `(ctx) => void` ; retourne une fonction unsubscribe. Quand `event`
est émis sur une entité tagguée `target` → `if` → chaque action de `do` → `fn`.
**EVENT → CONDITION → ACTION(S)**. La réaction en chaîne est 100 % composée (règle
`health.zero` → `explode` → dégâts → `health.zero` du voisin → …) ; ne pas créer une Action pour ce qui se compose déjà.

## 12. Temps déterministe

Timestep fixe **`FIXED_DT = 1/60 s`** avec accumulateur. Temps réel (`resume()` + `start()`
+ rAF) : max 8 ticks/frame (anti « spiral of death »). **Temps déterministe**
(`pause()` + `step(n)`) : `step(n)` exécute **exactement n ticks de jeu** (1/60 chacun),
indépendamment du temps réel — le mode des tests. Chaque tick = physique Rapier + KCC +
sync mesh/caméra + `onTick` + `tick++` + `time += 1/60`. API : `GameLoom.pause()`, `step(n)`, `resume()`,
`setPaused(p)`, `isPaused()`. Tout ce qui dépend du temps (cooldowns, delays) s'écrit en
**temps de jeu** (`rt.time`), **jamais** `setTimeout`/`performance.now` ; les tests avancent par `step(n)`, **jamais** par `sleep()` réel.

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

**14 méthodes + `version` + `_debug`.** `health` dans `snapshot()`/`entities()` = chaîne
`"current/max"` (ex. `"100/100"`), **pas un nombre**.

### `GameLoom._debug` — API de dev/test **NON STABLE** ⚠️ (peut changer sans préavis ; développer/tester, pas gameplay produit)

Visée/input : `setLook(yaw, pitch)` (pitch clampé ±1.45 rad), `look()` → `{ yaw, pitch }`,
`aimAt(x, y, z)` (calcule yaw/pitch), `input({ move?, jump? })` (move = `[fwd, strafe]`) ;
joueur : `teleportPlayer(x, y, z)` (KCC + résète la vélocité), `setPlayerHealth(h)`, `addPlayerHealth(h)` ;
entités : `spawn(asset, x, y, z)` (retourne l'id), `remove(id)`, `clearTag(tag)` ; sonde : `fire(origin)` = **raycast sans dégâts** (portée 120) dans la
direction de visée courante (après `aimAt`/`setLook`) — `origin` = position de l'œil
(`snapshot().player.pos + [0, 1.55, 0]`) → `{ id, point, distance }` ou `null`.

**Pattern hooks de jeu** : chaque jeu ajoute ses hooks d'interaction/état à
`window.GameLoom._debug` au boot — ex. `gameFire()` (tir), `gameInteract()` (interagir à
portée), `<nom>State()` (JSON d'état du jeu : porte, clé, ennemis, victoire…), `rayProbe(o, d, dist)` (sonde raycast arbitraire). Pas de `gameLook` : visée par `aimAt`/`setLook`.

## 14. Workflow de debug recommandé

Escalade (du moins coûteux au plus coûteux) — ne monter que si le niveau précédent n'a pas résolu :

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

## 15. CDP / harness déterministe

**Mécanisme officiel : `node tools/run_harnesses.mjs`** (= `npm test`). Cycle de vie complet
et garanti (portable Windows/macOS/Linux, Node pur) : build (`--build`) → `vite preview`
(4173) + **Chrome headless CDP (9224)** lancés détachés (logs tmp, PID conservés) → chaque
harness (`tools/test_*.mjs`, **1 target page frais par harness** — isolation de la console ;
l'orchestrateur transmet l'identité de la target via `CDP_TARGET_WS` et vérifie qu'il
reste exactement 1 page) → teardown par arbre sur **tous** les chemins de sortie (normal,
FAIL, exception, timeout, Ctrl+C/SIGTERM) + vérification que 4173/9224 sont libres.
Ports 4173/9224 **libres au démarrage** : s'ils sont occupés, l'orchestrateur **refuse
de démarrer** (exit 2) — il ne tue jamais un processus qu'il n'a pas créé. Usage :
`node tools/run_harnesses.mjs [test_xxx...] [--repeat N] [--build]` (sans arg : les 8
harnesses officiels — `test_v02` + `test_headless` #1, `test_temple` #2, `test_ruins` #3,
`test_dungeon` #4, `test_outpost` #5, `test_reactor` #6, `test_cargo` #7) · exit 0 = tous
verts, 1 = échec harness, 2 = infrastructure. Chrome : défaut par plateforme, override
`CHROME_PATH`.

`test_headless.mjs` = harness de référence ; les autres = **même pattern** (CDP `ws` →
`Runtime.evaluate`, `check()`/bilan, temps par `pause()`/`step(n)`, `URL_TARGET` propre au
jeu ; #3–#7 comparent un **fingerprint de ticks** entre runs). Nouveau jeu : dupliquer
un harness, changer `URL_TARGET` + checks. Si un harness est lancé **seul**
(`npm run test:<nom>`), il suppose la préparation manuelle ci-dessous (sans
`CDP_TARGET_WS`, il cible le 1er target `page` du Chrome CDP) :

1. **Chrome headless déjà lancé** (port CDP **9224**, WebGL SwiftShader, sans GPU) :
    - Linux : `google-chrome-stable --headless=new --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --remote-debugging-port=9224 --user-data-dir=/tmp/chrome_gl --window-size=1280,720 --mute-audio about:blank`
    - Windows : `Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" -ArgumentList "--headless=new","--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--remote-debugging-port=9224","--user-data-dir=$env:TEMP\chrome_gl_cdp","--window-size=1280,720","--mute-audio","about:blank"`
    + `vite preview` (4173). Vérifier : `curl -s localhost:9224/json/version` →
    `"Browser": "Chrome/…"`. Processus persistants Windows (Chrome, `npm run preview`) :
    lancement **détaché** (stdio vers log, PID conservé, arrêt par PID) — jamais de
    handles hérités.
2. **Ouvrir** : `Page.navigate` sur `URL_TARGET` (build production) ; attendre
   `typeof window.GameLoom === "object"`.
3. **Input/temps** : `_debug.input({ move, jump })`, `aimAt`, `gameFire()`, `teleportPlayer` ; `pause()` + `step(n)` — jamais `sleep()`.
4. **Interroger** : `snapshot()`, `entities()`, `inspect()`, `stats()` ; **événements** : `GameLoom.events(n)` — la preuve de la séquence.
5. **Asserter** les JSON ; bilan `BILAN: n/n tests passés`, exit 0.
6. **Screenshot** en dernier recours : `Page.captureScreenshot` (chemin relatif, git-ignoré `tools/*_screenshot.png`).

Cache navigateur **désactivé** (`Network.setCacheDisabled`) ; visée via `_debug.aimAt`, sonde raycast via `_debug.fire`.

## 16. Conventions obligatoires

Violées = bugs réels (historique : `EXPERIMENTS.md`) :

1. **Composants = plain objects JSON** — `structuredClone` pour dupliquer.
2. **État indépendant par spawn** — chaque entité a sa copie des composants du GLB (jamais d'aliasing) — §6.
3. **Input : une seule source de vérité** (le core) ; le jeu écrit par événement clavier, ne ré-écrit PAS l'input chaque tick.
4. **yaw/pitch : une seule source de vérité** (le core, `setLook`/`aimAt`) ; pas de valeurs dupliquées dans le jeu.
5. **Vitesse en m/s × `FIXED_DT`** — déplacement = `vitesse * FIXED_DT` (sinon 5.6 m/**tick**).
6. **Gameplay temporel en temps de jeu** (`rt.time`), jamais `setTimeout`/`performance.now`.
7. **Temps testé par ticks** (`pause()`/`step(n)`), jamais `sleep()`.
8. **Pas de comportement event→action dans le GLB** — capacités seulement.
9. **Pas de mutation permanente du GLB** pendant le gameplay (état dans l'ECS).
10. **IDs uniques** auto-générés (`<tag>_<seq36>`).
11. **Tags canoniques** = basename du GLB sans extension.
12. **Origine des assets à la base** — spawn à `y = 0` — §6.
13. **Tester sur le build production** (4173), pas le dev server (5173, HMR = double-boot).
14. **Copier les GLB dans `dist/assets/`** après chaque build.

## 17. Pièges connus (actuels)

À connaître avant de coder (récits complets : `EXPERIMENTS.md`) :

1. **`RAPIER.init()`** : `await RAPIER.init()` (appeler) — sans `()`, le WASM n'est jamais initialisé, **silencieux**.
2. **API Rapier 0.21** : `setMass()` sur le **ColliderDesc** ; `isDynamic()` ; `ColliderDesc.setTranslation(x,y,z)` (3 args) ;
   `capsule(halfHeight, radius)` ; `kinematicPositionBased()` ; `EventQueue(false)` ; `world.bodies.getAll()` / `world.colliders` (propriétés) ; `world.colliders.get(handle)`.
3. **`Health.current`** : sans init `current = max` → `NaN` → `health.zero` jamais émis.
4. **Aliasing des composants GLB** — `structuredClone` au spawn (§6).
5. **Raycast** : point d'impact = `origin + dir * toi` ; `rt.raycast` **exclut la capsule du joueur** (verrouiller/viser).
6. **Raycast depuis l'intérieur d'un collider** (ex. son propre projectile) → TOI = 0 : caster depuis l'extérieur (`pos + dir × rayon`).
7. **Colliders sans entité** : `hit.entity` peut être `null` (projectile du jeu) — le traiter dans le tir.
8. **HMR / double-boot** : dev server Vite → 2 runtimes parallèles ; build production.
9. **Assets Vite** : `assets/` PAS servi par `vite build` → `cp assets/*.glb dist/assets/`.
10. **Cache navigateur** : 404 HTML mis en cache → `Network.setCacheDisabled`.
11. **Blender/glTF axes** : Z-up→Y-up (`export_yup=true`) + origine à la base.
12. **Accessors `POSITION`** : normales/couleurs = `VEC3` — bbox = `POSITION` seul.
13. **Buffer Node poolé** : normaliser `(arrayBuffer, byteOffset, byteLength)` (CLI).
14. **Tag du chemin complet** : utiliser le **basename**.
15. **Mouvement non échelé** : `dx = … * speed * FIXED_DT` (sinon 5.6 m/tick).
16. **Double source de vérité** (input, yaw/pitch) : le jeu n'écrase pas le core.
17. **Scènes de test contrôlées** : positions fixes, pas d'aléatoire non seedé.
18. **Chemins relatifs au repo** dans les scripts (un absolu d'OS crashait le harness Windows malgré des checks passés).

## 18. Ce qui N'EXISTE PAS (ne pas supposer)

Non implémenté en v0.2 — ne pas inventer d'API :

- **Éditeur visuel / GUI** d'édition de scène.
- **DSL GameLoom** — pas de langage, parser ou compilateur dédié.
- **CLI `game`** — le seul CLI est `glb`.
- **Alias metadata / versions multiples** — un seul namespace `com.gameloom.v0`.
- **Audio dans le GLB** — audio synthétisé (Web Audio) dans le jeu.
- **Inventory**, **quests génériques**, **save/load**, **multiplayer/réseau**.
- **Animation / root-motion** — aucun asset animé ; pas de `AnimationMixer`.
- **Collider `convex`** — types seulement, non supporté au runtime.
- **Scaling d'instance appliqué au collider** (§8).
- **Events `wave.start / wave.clear / game.over / ammo.empty`** — cités dans `types.ts`, **jamais émis** ;
  **actions `damage / play / spawn`** — citées, **non enregistrées**.
- **`collision.start`** — émis/loggué, aucune règle ne s'y abonne.
- **Pathfinding / navigation mesh** — `avoidObstacles` ne fait que clamping le step avant
  les obstacles (raycast) ; pas d'évitement ni de replanification.

---

*Version : GameLoom v0.2 — 7 vertical slices validées (Barrel Blaster, Temple Escape, Ruins Raid, Dungeon Assault, Outpost Rescue, Reactor Defense, Cargo Run). Historique, preuves et décisions : `EXPERIMENTS.md`.*
