# GameLoom — Source de vérité

> ## 🛑 RÈGLE DE MAINTENANCE (à lire d'abord)
> **Toute modification validée de l'API GameLoom, du CLI `glb`, des métadonnées GLB,
> des conventions ou du workflow de test qui change la manière d'utiliser GameLoom
> DOIT mettre à jour ce fichier dans le même changement.**
>
> Cette règle s'applique à l'agent comme à l'humain. Quand tu implémentes une nouvelle
> capacité GameLoom ou une commande `glb` :
> 1. implémenter ;
> 2. tester réellement ;
> 3. obtenir les tests verts (`npm run test:headless` → `BILAN: 19/19`,
>    `npm run test:temple` → `BILAN: 14/14`, `npm run test:ruins` → `BILAN: 21/21`) ;
> 4. **mettre à jour GAMELOOM.md** ;
> 5. seulement ensuite considérer la fonctionnalité terminée.
>
> - Une fonctionnalité **non validée** ne doit PAS être documentée comme disponible.
> - Une fonctionnalité **validée** qui change l'utilisation publique n'est PAS terminée
>   tant que GAMELOOM.md n'est pas à jour.
>
> Ce fichier est la source de vérité publique et portable. Un agent arrivant avec
> uniquement ce dépôt (ni historique de conversation, ni skills internes) doit pouvoir
> lire ce fichier et utiliser GameLoom. Les skills internes ne doivent JAMAIS être
> nécessaires pour comprendre GameLoom : ce dépôt est autonome.

GameLoom v0.1 — slices validés : **Barrel Blaster** (micro-FPS à vagues, hitscan,
explosions en chaîne) — tests **19/19** ; **Temple Escape** (aventure/puzzle :
séquence de 3 interrupteurs, porte, sortie) — tests **14/14** ; **Ruins Raid**
(exploration/action : artefact à récupérer, gardien mobile PATROL/ALERT/ATTACK,
grille, zone d'extraction, 3 assets générés par Blender headless) — tests **21/21**.
Sur build production, navigateur headless (CDP), 100 % déterministe — Barrel
Blaster : **8 runs (Linux, Chrome 154) + 3 runs (Windows, Chrome 153.0.8010.53)** ;
Temple Escape : **3 runs (Windows, Chrome 153.0.8010.53)** ; Ruins Raid : **5 runs
(Windows, Chrome 153.0.8010.53)** avec fingerprint de ticks identique.

---

## 1. GameLoom en une minute

GameLoom est une **bibliothèque TypeScript** qui transforme des assets **GLB**
(modèle 3D + capacités) en un jeu 3D jouable dans le navigateur, avec une physique
(Rapier), un ECS (Miniplex), du rendu (Three.js) et une API de debug structurée.

Le moteur de création repose sur 6 concepts :

| Concept | Rôle |
|---|---|
| **GLB** | = IDENTITÉ + CAPACITÉS STATIQUES (géométrie, collider, physique, `Health.max`, `Explosive…`) |
| **Scene / Game (TypeScript)** | = INSTANCES + COMPORTEMENT (où spawn, quelles règles « quand ça arrive → faire quoi ») |
| **ECS** | = ÉTAT RUNTIME (chaque entité a son propre `Health.current`, position, tags…) |
| **EVENT** | = CE QUI ARRIVE (`damage`, `health.zero`, `spawn`, `destroy`, `collision.start`, `player.died`) |
| **ACTION** | = CONSÉQUENCE (`explode`, `destroy`, `addScore`, `sound`) |
| **SYSTEM** | = MÉCANISME D'EXÉCUTION (le moteur de règles `rt.on(target, event, block)`) |

Plus deux piliers transverses :

- **Debug API** (`window.GameLoom`) = observabilité structurée : `inspect()`, `entities()`,
  `events()`, `stats()`, `snapshot()`, `doctor()`. Tout est JSON.
- **Fixed timestep** (1/60 s) = temps déterministe : `pause()` + `step(n)` pilotent les
  **ticks de jeu**, jamais le temps réel. C'est ce qui rend les tests reproductibles.

**Frontière fondamentale** (à retenir) :
- Le **GLB** dit : « je suis un baril, j'ai `Health.max = 50`, je *peux* exploser
  (`Explosive` 8/120/20). »
- Le **TypeScript** dit : « *quand* ta vie arrive à zéro, tu exploses puis tu te détruis. »
  (`rt.on('barrel', 'health.zero', { do: [A.explode(), A.destroy()] })`)

GameLoom est une API TypeScript. **Ce n'est pas un langage, un DSL, un éditeur ou un moteur
graphique complet.** Le gameplay lisible est l'objectif, la syntaxe exacte peut évoluer.

---

## 2. Stack

Versions **réellement installées** (lues depuis `node_modules`, 2026-09-27) :

| Dépendance | Version | Rôle |
|---|---|---|
| **TypeScript** | 7.0.2 | Langage de tout le code (`tsconfig` strict, `noEmit` — Vite bundle). |
| **Vite** | 8.3.1 | Build (Rolldown) + dev server + preview. `base: './'`, ports 5173 (dev) / 4173 (preview). |
| **Three.js** | 0.186.1 | Rendu 3D (présentation **uniquement** — le gameplay ne lit jamais le rendu) + `GLTFLoader`. |
| **Rapier** (`@dimforge/rapier3d-compat`) | 0.21.0 | Physique WASM : monde, rigid bodies, colliders, raycast, `KinematicCharacterController`. |
| **Miniplex** | 2.0.0 | ECS (monde d'entités) derrière un adapter à 3 interfaces stables. |
| **glTF / GLB** | — | Format d'asset. Les métadonnées GameLoom vivent dans l'extension `com.gameloom.v0`. |
| **glTF-Transform** (`@gltf-transform/core`) | 4.5.0 | Déclaré en dépendance **mais JAMAIS importé** dans le code livré (le CLI `glb` a son propre re-encodeur GLB). À considérer comme inutilisé pour l'instant. |

Dev : `@types/three` 0.186.0, `@types/node` 26.6.3, `ws` 8.22.0 (testeur CDP).

**Blender** (outillage assets, hors npm) : **4.2 LTS** (4.2.23 installé sur la machine
Windows, 2026-09-27), mode headless (script de génération : `tools/blender/make_assets.py` ;
le chemin d'installation dépend de la machine).
**Alternative sans Blender (validé, jeu #2)** : `tools/make_glb.mjs` — générateur de GLB
low-poly **pure Node** (boîtes composées, normales planes, GLB binaire valide + chunk BIN).
Pipeline asset complet : `node tools/make_glb.mjs <nom>` puis `glb collider auto` +
`glb physics set` (utilisé pour `assets/switch.glb`).
**Chrome** (test headless) : **153/154** en mode `--headless=new`, WebGL par SwiftShader
(validé sur 154 Linux et 153.0.8010.53 Windows).

Règle : la dépendance ne doit **pas** coupler l'API publique — Miniplex est derrière un
adapter (`ecs.ts`), Rapier est encapsulé dans le runtime. Les 3 interfaces stables de
l'adapter ECS : itération, requêtes par tag, snapshot JSON.

---

## 3. Architecture du dépôt

Arborescence **réellement obtenue** (hors `node_modules/` et `dist/`) :

```
~/gameloom/
├── GAMELOOM.md                  ← CE FICHIER (source de vérité)
├── JOURNAL.md                   ← journal expérimental Barrel Blaster
├── JOURNAL_START.txt            ← horodatage de départ
├── index.html                   ← shell DOM jeu #1 (canvas #game, HUD, overlay)
├── temple.html                  ← shell DOM jeu #2 (canvas #game, HUD, overlay)
├── ruins.html                   ← shell DOM jeu #3 (canvas #game, HUD, overlay)
├── package.json                 ← scripts + dépendances
├── tsconfig.json                ← TS strict, noEmit, bundler, ES2022
├── vite.config.ts               ← ports 5173/4173, base './', multi-entry (index + temple + ruins)
├── assets/
│   ├── barrel.glb               ← 652 sommets · Health.max=50 · Explosive 8/120/20 · dynamic 30 kg
│   ├── crate.glb                ← 96 sommets  · static · décor/couvert (réutilisé par les 3 jeux)
│   ├── target.glb               ← 1 mesh · Health.max=30 · Scored · static
│   ├── switch.glb               ← 72 sommets · static · interrupteur (jeu #2, généré par make_glb.mjs)
│   ├── guardian.glb             ← 88 sommets  · kinematic · Health.max=100 (jeu #3, Blender headless)
│   ├── artifact.glb             ← 166 sommets · static · cristal sur socle (jeu #3, Blender headless)
│   └── ruins_column.glb         ← 120 sommets · static · colonne brisée (jeu #3, Blender headless)
├── src/
│   ├── core/                    ← LE CORE GameLoom (888 LOC, 7 fichiers — non modifié par les jeux #2 et #3)
│   │   ├── types.ts   (86)      ← types + namespace + vocabulaire canonique
│   │   ├── ecs.ts     (69)      ← adapter Miniplex → API stable (3 interfaces)
│   │   ├── events.ts  (65)      ← bus d'événements (log 500, depth guard, filtre tag)
│   │   ├── actions.ts(41)       ← registry d'actions + fabrique A (4 actions)
│   │   ├── glbs.ts    (40)      ← lecture GLB (chunk JSON) + métadonnées com.gameloom.v0
│   │   ├── runtime.ts(578)      ← moteur déterministe : Rapier+KCC, tick, règles, actions core, debug API
│   │   └── index.ts   (9)       ← surface publique exportée
│   └── game/
│       ├── main.ts      (355)   ← Barrel Blaster : tir, vagues, munitions, HUD, audio, règles, arène
│       ├── temple/
│       │   └── main.ts  (328)   ← Temple Escape : séquence d'interrupteurs, porte, sortie, HUD, audio
│       └── ruins/
│           └── main.ts  (438)   ← Ruins Raid : gardien mobile (PATROL/ALERT/ATTACK), artefact, grille, extraction
└── tools/
    ├── cli.mjs              (495) ← CLI `glb` (inspect/validate/doctor/collider/physics/component)
    ├── test_headless.mjs    (260) ← testeur CDP déterministe Barrel Blaster (19 checks, port 9224)
    ├── test_temple.mjs      (241) ← testeur CDP déterministe Temple Escape (14 checks, port 9224)
    ├── test_ruins.mjs       (332) ← testeur CDP déterministe Ruins Raid (21 checks, port 9224)
    ├── make_glb.mjs         (145) ← générateur de GLB low-poly pure Node (sans Blender)
    ├── diag_aim.mjs, diag_chain.mjs, diag_t6.mjs  ← scripts de diagnostic ad hoc
    ├── final_screenshot.png  ← capture finale Barrel Blaster (git-ignoré)
    ├── temple_screenshot.png ← capture finale Temple Escape (git-ignoré)
    ├── ruins_screenshot.png  ← capture finale Ruins Raid (git-ignoré)
    └── blender/
        ├── make_assets.py       (90)  ← 3 GLB du jeu #1 (Blender headless)
        └── make_ruins_assets.py (193) ← 3 GLB du jeu #3 : guardian, artifact, ruins_column (Blender headless)
```

Fichiers importants :
- **`src/core/runtime.ts`** : le cœur. `createRuntime()` (async, init Rapier), timestep fixe,
  KCC, moteur de règles `on()`, actions core, `raycast`, `explodeAt`, `removeEntity`, et l'objet
  `window.GameLoom` (API publique + `_debug`). **Non modifié par les jeux #2 et #3.**
- **`src/game/main.ts`** : le jeu #1 (Barrel Blaster). Montre comment on **utilise** le core :
  boot, arène, tir hitscan, vagues, `rt.on(...)` (règles), `rt.onTick(...)`, input.
- **`src/game/temple/main.ts`** : le jeu #2 (Temple Escape). Montre un **autre usage** du core :
  2e entrée HTML (multi-entry Vite), puzzle à séquence (état TS + règles EVENT→ACTION),
  **objet du monde possédé par le jeu** (la porte : `rt.world`/`rt.scene` + `removeCollider`),
  zone de sortie par inclusion dans `onTick`, hooks `_debug` de jeu (`gameInteract`, `templeState`).
- **`src/game/ruins/main.ts`** : le jeu #3 (Ruins Raid). Montre un **troisième usage** du core :
  **entité mobile possédée par le jeu** (le gardien : rigid body **kinematic** déplacé par
  `rt.world.bodies` + `setTranslation`/`setRotation`, **sans toucher au core**), machine à états
  PATROL/ALERT/ATTACK, verrouillage anti-traversée via `rt.raycast`, 3e entrée HTML (multi-entry),
  hooks `_debug` de jeu (`gameInteract`, `ruinsState`).
- **`tools/cli.mjs`** : l'outillage asset (lecture/réécriture GLB + métadonnées).
- **`tools/test_headless.mjs` / `tools/test_temple.mjs` / `tools/test_ruins.mjs`** : les harness de
  test — **même pattern CDP réutilisé** pour chaque jeu (on référence le pattern, on ne recopie pas
  aveuglément). Le harness #3 ajoute un **fingerprint de ticks** (valeurs exactes aux ticks clés)
  pour comparer la détermination entre runs.

---

## 4. Quick Start

Commandes **réellement validées** (copier/coller). Prérequis : Node 22, accès réseau npm.

```bash
cd ~/gameloom

# 1. Install
npm install

# 2. Typecheck (tsc strict, noEmit) — PAS de script dédié, la commande est :
npx tsc --noEmit

# 3. Build production (tsc + vite build → dist/) — multi-entry : index.html (jeu #1)
#    + temple.html (jeu #2) + ruins.html (jeu #3), vite.config.ts (rollupOptions.input)
npm run build

# 4. Copy des GLB dans dist (Vite ne copie PAS assets/ → public/) — OBLIGATOIRE avant de servir :
cp assets/*.glb dist/assets/

# 5. Servir le build (preview sur http://localhost:4173)
npm run preview
#    → jeu #1 : http://localhost:4173/  ·  jeu #2 : http://localhost:4173/temple.html
#    → jeu #3 : http://localhost:4173/ruins.html

# 6. Tests headless déterministes (nécessite Chrome headless + le serveur, voir §17)
npm run test:headless          # Barrel Blaster → "BILAN: 19/19 tests passés"
npm run test:temple            # Temple Escape → "BILAN: 14/14 tests passés"
npm run test:ruins             # Ruins Raid      → "BILAN: 21/21 tests passés"

# 7. CLI glb (outillage asset)
npm run glb -- --help
npm run glb -- inspect assets/barrel.glb
npm run glb -- validate assets/barrel.glb
```

Notes :
- **`npm run build`** = `tsc --noEmit && vite build` (validé, ~0.7 s). Chaque jeu = une entrée
  HTML à ajouter dans `rollupOptions.input` de `vite.config.ts` (validé avec 3 entrées).
- **`npm run dev`** (Vite dev, port 5173) existe mais **n'est PAS à utiliser pour tester** :
  le HMR provoque un **double-boot** (2 runtimes GameLoom en parallèle). Toujours tester sur le
  **build production** (`npm run build` + `npm run preview`, port 4173).
- **`npm run glb -- <args>`** : le `--` sépare le script npm des arguments CLI.
- Chaque harness pointe sur son jeu par défaut via `URL_TARGET` : `test_headless.mjs` →
  `http://localhost:4173/`, `test_temple.mjs` → `http://localhost:4173/temple.html`,
  `test_ruins.mjs` → `http://localhost:4173/ruins.html`
  (overridable par la variable d'environnement `URL_TARGET`).

---

## 5. Créer un jeu

Un jeu GameLoom = **une entrée HTML** (`index.html`, `temple.html`, `ruins.html`, …) + **un
`main.ts`** qui appelle le core. Trois jeux coexistent déjà (multi-entry Vite, §4).
Exemple minimal **réel**
(extrait de `src/game/main.ts`, API actuelle) :

```ts
import { createRuntime, A, FIXED_DT } from '../core';
import type { Runtime, Vec3 } from '../core';

let rt: Runtime;

async function boot() {
  // 1) Créer le runtime (init Rapier WASM à l'intérieur, crée le joueur "player",
  //    le monde, la caméra, expose window.GameLoom).
  rt = await createRuntime(document.getElementById('game') as HTMLCanvasElement, {
    onExplode: (p, r) => { /* effet visuel (présentation) */ },
    onFire: (origin, hit) => { /* tracer visuel */ },
  });

  // 2) (Optionnel) charger les assets AVANT de les spawner :
  await rt.preloadAssets(['assets/barrel.glb', 'assets/target.glb']);

  // 3) Spawner des instances (GLB = prefab) :
  rt.spawnAsset('assets/crate.glb', [4, 0, -4]);   // y=0 : convention "origine à la base"
  rt.spawnAsset('assets/barrel.glb', [0, 0, -6]);

  // 4) Déclarer les règles gameplay (EVENT → ACTION) :
  rt.on('barrel', 'health.zero', { do: [A.explode(), A.destroy()] });
  rt.on('target', 'health.zero', { do: [A.addScore(100), A.sound('hit'), A.destroy()] });

  // 5) Logique périodique du jeu (après la physique, même pas de temps déterministe) :
  rt.onTick(() => { /* vagues, HUD, cooldowns… (tous en temps de jeu: rt.time) */ });

  // 6) Démarrer la boucle + mettre en pause (le test reprend via step()) :
  rt.setPaused(true);
  rt.start();
}
boot();
```

Le **tir hitscan** (spécifique au jeu, pas au core) :
```ts
function fire() {
  const o = eyePos();                    // position de l'œil (pos joueur + 1.55)
  const d = lookDir();                   // direction depuis yaw/pitch (vivent dans le core)
  const hit = rt.raycast(o, d, 120);     // raycast physique Rapier (exclut la capsule du joueur)
  if (hit?.entity && hit.entity.id !== 'player') {
    rt.bus.emit('damage', hit.entity.id, { other: 'player', amount: 30, point: hit.point });
  }
}
```

Le **core fournit** : le joueur, la physique, le temps déterministe, le raycast, les actions
`explode/destroy/addScore/sound`, et le système `damage → health.zero`. **Le jeu fournit** :
le tir, les vagues, les munitions, l'audio, le HUD, et la décision de *quand* chaque entité
fait quoi (les règles).

**Objets du monde possédés par le jeu** (pattern validé par les 3 jeux) : le `Runtime` expose
`rt.world` (Rapier) et `rt.scene` (Three.js). Un objet du monde **sans entité ECS** (sol, murs,
**la porte** de Temple Escape, **la grille** de Ruins Raid) est créé par le jeu :
`RAPIER.ColliderDesc` + `world.createRigidBody(fixed())` + `world.createCollider(...)`, et un
mesh `rt.scene.add(...)`. Ouvrir la porte/grille = `world.removeCollider(c, true)` +
`world.removeRigidBody(body)` (gameplay immédiat) + animation du mesh (présentation). Ce
pattern est identique à l'arène de Barrel Blaster. Les entités spawnées via `spawnAsset` restent
la voie de fait pour tout ce qui a besoin d'un état ECS (health, tags, inspection).

**Entités mobiles possédées par le jeu (validation jeu #3 — gardien kinematic)** : une entité
spawnée via `spawnAsset` avec `physics.body = 'kinematic'` peut être **déplacée par le jeu sans
aucune extension du core** : le `Runtime` expose `rt.world` et pose `body.userData = <id>` au
spawn, donc le jeu retrouve le rigid body (`rt.world.bodies.getAll()` + `b.userData === id`) et
l'avance par `body.setTranslation({...}, true)` + `body.setRotation({...}, true)` (orientation),
dans `onTick`. Le core synchronise le mesh sur la position Rapier à chaque tick (pattern de
sync mesh ↔ physique existant), et le KCC du joueur traite le corps kinematic comme un obstacle
solide. Pour empêcher l'entité de traverser les murs, le jeu verrouille le déplacement avec
`rt.raycast` (origine décalée le long de la direction, la capsule du joueur est exclue
automatiquement). **Aucune API de mouvement n'a été ajoutée au core pour le jeu #3** — la
machine à états PATROL/ALERT/ATTACK, les waypoints et le verrouillage sont du code de jeu
(cf. `src/game/ruins/main.ts`). Si un futur jeu multi-entités mobiles montre la même
duplication, une primitive de déplacement pourrait alors être envisagée (règle des trois).

**Tags de scène par override** : `rt.spawnAsset(asset, at, { tags: [...] })` remplace le tag
canonique (basename du GLB). Validé avec le jeu #2 : `switch.glb` spawné 3 fois avec
`tags: ['switch', 'sw_a']` / `['switch', 'sw_b']` / `['switch', 'sw_c']` — le **contexte de
scène** (quel slot) n'est donc PAS une capacité d'asset, conformément à la frontière GLB/TS.

**Événements personnalisés du jeu** : le bus accepte **tout** nom d'événement. Le jeu émet ses
propres événements via `rt.bus.emit('puzzle.completed', id, {...})` et s'y abonne via
`rt.on('switch', 'puzzle.completed', {...})`. Validé avec le jeu #2 : `switch.activated`,
`puzzle.reset`, `puzzle.completed`, `player.exited` (4 événements de jeu) ; et avec le jeu #3 :
`artifact.collected`, `guardian.alert`, `guardian.attack`, `guardian.lost`, `guardian.reached`,
`player.extracted` (6 événements de jeu) — tous émis/loggués et consommés par les règles (voir
§11).

---

## 6. GLB comme prefab

**Un GLB = un prefab portable.** Il contient :
- géométrie (mesh, sommets), matériaux, (animations si présentes — v0.1 n'en utilise pas) ;
- **métadonnées GameLoom** dans l'extension glTF `com.gameloom.v0` : collider, physique,
  composants statiques (capacités).

Ce que le GLB déclare = **valeurs initiales / capacités** :
```
barrel.glb:  Health.max = 50   ← capacité (max vie), PAS l'état
             Explosive { radius: 8, damage: 120, impulse: 20 }   ← "je peux exploser ainsi"
             physics { body: dynamic, mass: 30 }
             collider { type: box, size: [0.97,0.9,0.946], center: [0,0.45,0] }
```

Ce que le **runtime** gère = **l'état, indépendant par instance** :
- `Health.current` est initialisé au spawn (= `max` si non déclaré), puis évolue dans l'ECS.
- `Explosive.exploded`, position, vélocité, etc. sont par entité.

### ⚠️ Règle critique (découverte sur Barrel Blaster) — NE JAMAIS ALIASER
**Ne JAMAIS partager les objets composants provenant du cache GLB entre plusieurs entités.**
Chaque spawn doit obtenir **sa propre copie profonde** des plain objects JSON.

Le bug réel : `spawnFromCache` faisait `e.Health = meta.components.Health` (référence).
Toutes les instances d'un même GLB **partageaient le même objet** `Health`/`Explosive` :
un baril qui mourait (`current=0`, `zeroEmitted=true`) « contaminait » tous les autres, et la
réaction en chaîne était masquée. **Correction** (dans `runtime.ts`, `spawnFromCache`) :
```ts
for (const [k, v] of Object.entries(meta.components)) {
  const clone = structuredClone(v);           // copie profonde par entité
  const existing = (e as Record<string, unknown>)[k];
  if (existing && typeof existing === 'object') Object.assign(existing, clone);
  else (e as Record<string, unknown>)[k] = clone;
}
```
Les composants sont des **plain objects JSON-sérialisables** — `structuredClone` est l'outil.
**C'est une règle d'architecture, pas un détail d'implémentation.**

### Convention d'origine / base des assets
Les assets sont générés avec **l'origine à la base de l'objet** (Blender `ORIGIN_CURSOR` à
`(0,0,0)`, export `export_yup=true`). Dans l'espace glTF/Three.js (Y-up), la base de l'objet
est à **y = 0** et le mesh s'étend vers **+y**. Conséquence : **spawner à `y = 0`** pose
l'objet au sol (le collider, centré en local, repose correctement). Exemple validé : baril de
0.9 m de haut → bbox `center=[0,0.45,0]`, spawn `y=0` → le baril repose sur le plan.

> Le GLB déclare les **capacités** ; il ne déclare **jamais** le comportement event→action
> (pas de `health.zero → explode` dans le GLB). C'est la règle du jeu (TypeScript).

---

## 7. Namespace metadata

Namespace unique et versionné : **`com.gameloom.v0`** (constant `NS`, dans `types.ts` et `glbs.ts`).
Pas d'alias, pas de version multiple en v0.1. Les métadonnées sont lues de la **scène 0** du
glTF, champ `extensions["com.gameloom.v0"]` (le `GLTFLoader` les ignore — GameLoom les lit
directement du chunk JSON du GLB).

Structure réelle (`GlbMeta`, `types.ts`) :
```ts
{
  collider?: { type: 'box'|'sphere'|'capsule'|'convex'; size: number[]; center: [x,y,z] }
  physics?:  { body: 'static'|'dynamic'|'kinematic'; mass: number }
  components?: Record<string, Record<string, number|string|boolean>>   // ex: { Health: { max: 50 } }
}
```

**Exemple réel extrait d'un asset validé** (`npm run glb -- inspect assets/barrel.glb`),
métadonnées `com.gameloom.v0` :
```json
{
  "collider": { "type": "box", "size": [0.97, 0.9, 0.946], "center": [0, 0.45, 0] },
  "physics":  { "body": "dynamic", "mass": 30 },
  "components": {
    "Health":    { "max": 50 },
    "Explosive": { "radius": 8, "damage": 120, "impulse": 20 }
  }
}
```
`target.glb` : `Health { max: 30 }` + `Scored { points: … }`, `physics { body: static, mass: 1 }`.

---

## 8. CLI GLB

Un seul CLI : **`glb`** (outillage asset). Discovery progressive par `--help`. Exécuté via
`npm run glb -- <args>`. Validation réelle faite ce jour.

```
glb --help
```
```
glb — outil d'assets GameLoom v0.1 (namespace com.gameloom.v0)
Usage: glb <commande> <fichier.glb> [options]
Commandes:
  inspect    affiche le contenu (méta + géométrie)  — --json pour JSON brut
  validate   vérifie la structure et les métadonnées
  doctor     diagnostic complet (erreurs + avertissements)
  collider   sous-commandes: auto | set
  physics    sous-commandes: set
  component  sous-commandes: add (Health | Explosive | Scored)
Chaque commande accepte --help pour la documentation détaillée.
```

Commandes inconnues / options inconnues → **exit 2** avec **suggestion** (`Did you mean …?`,
distance de Levenshtein ≤ 2). Fichier absent → exit 1.

Validé : `--help` fonctionne sur la racine, les 6 commandes et les sous-commandes
(`collider auto|set`, `physics set`, `component add`) → exit 0. Les chemins d'accès sont
portables (aucun chemin absolu d'OS dans `cli.mjs`).

### `glb inspect <file.glb> [--json]`
- **Syntaxe** : `glb inspect assets/barrel.glb` ; `--json` (flag, sans valeur) pour le JSON brut.
- **Résultat** : `file`, `ns`, `meshes`, `vertices` (sommets VEC3), `boundingBox`
  (`min/max/size/center`), `gameloom` (métadonnées `com.gameloom.v0` ou `null` si brut).
- **Exemple validé** : `barrel.glb` → `meshes: 1 · sommets VEC3: 652 · bbox size=[0.97,0.9,0.946] center=[0,0.45,0]` + méta.
- **Erreur** : fichier introuvable → `✗ …` exit 1.

### `glb validate <file.glb>`
- **Syntaxe** : `glb validate assets/barrel.glb`.
- **Résultat** : `✓ <file> valide` (exit 0) ou `✗ <file> INVALIDE:` + liste des problèmes
  (exit 1). Avertissements (`!`) non bloquants.
- **Vérifie** : présence mesh ; `collider.type ∈ box|sphere|capsule`, `size` tableau de
  nombres > 0, box → 3 nombres ; `physics.body ∈ static|dynamic|kinematic`, dynamic → masse > 0 ;
  `Health.max` nombre > 0 ; `Explosive.{radius,damage,impulse}` nombres ; composants canoniques.
- **Validé** : `crate.glb`, `barrel.glb`, `target.glb` → `✓ … valide`.

### `glb doctor <file.glb>`
- **Syntaxe** : `glb doctor assets/barrel.glb`.
- **Résultat** : JSON complet : `checks.gltf` (magic, scenes, meshes, bin_chunk), `checks.bbox`,
  `checks.gameloom` (présence collider/physics/components), `checks.warnings`, `ok`.
- **Avertissements typiques** : « pas de collider — `glb collider auto` recommandé »,
  « collider box plus petit que la bbox (possible tunneling) »,
  « Explosive sans Health : l'explosion ne se déclenchera jamais ».

### `glb collider` (sous-commandes `auto` | `set`)
```
glb collider auto <file.glb>
glb collider set <file.glb> --type box|sphere|capsule --size x,y,z --center x,y,z
```
- **`auto`** : calcule un collider `box` depuis la **bounding box du mesh** (accessors
  `POSITION`) et écrit la méta. Valide : `auto` → `box size=[0.97,0.9,0.946] center=[0,0.45,0]` pour le baril.
- **`set`** : collider manuel. **`size` = dimensions TOTALES** pour box (le runtime divise par
  2 pour le cuboid Rapier), `[rayon]` pour sphere, `[rayon, demi-hauteur]` pour capsule.
- **`--help`** imbriqué disponible (`glb collider --help`).
- **Erreurs** : sous-commande inconnue → exit 1 (+ suggestion) ; `--size` mal formé pour le type → exit 1.

### `glb physics` (sous-commande `set`)
```
glb physics set <file.glb> --body static|dynamic|kinematic [--mass N]
```
- Défaut `--body dynamic`, `--mass 1` (un `dynamic` **sans** `--mass` passe donc en 1 kg,
  validé exit 0). `dynamic` avec `--mass` explicite `≤ 0` → exit 1.
- **Exemple** : `glb physics set assets/barrel.glb --body dynamic --mass 30` → `✓ physique: dynamic mass=30kg`.
- **`--help`** imbriqué disponible.

### `glb component` (sous-commande `add`)
```
glb component add <file.glb> <Health|Explosive|Scored> --cle valeur [--cle2 valeur2 …]
```
- Champs connus (validation stricte, suggestion sinon) : `Health: max` · `Explosive: radius, damage, impulse` · `Scored: points`.
- **Exemple** : `glb component add assets/barrel.glb Health --max 50` → `✓ Health: {"max":50}`.
- **`--help`** imbriqué disponible.
- Les valeurs numériques sont converties en `number` si possible, sinon conservées en `string`.

**Réécriture du GLB** : le CLI **lit le GLB binaire** (chunk JSON + chunk BIN) et **réécrit un
GLB valide** (header + chunk JSON + chunk BIN, padding à 4) — le BIN est préservé. Si le GLB
n'a pas de chunk BIN, il est réécrit en JSON seul. `@gltf-transform` n'est PAS utilisé ici.

---

## 9. Colliders / physique

**Conventions Blender/glTF (réelles)** : Blender est **Z-up**, glTF/Three.js **Y-up**. L'export
Blender utilise `export_yup=true`. Les assets sont **Z-up → convertis en Y-up** à l'export,
**origine à la base** (y=0 au sol).

**Colliders** (définis dans l'**espace local** de l'asset, via la méta `collider`) :
- `box` : `size = [lx, ly, lz]` dimensions **totales** (le runtime fait `cuboid(size/2)`),
  `center = [x,y,z]`. C'est le type le plus utilisé et celui que `glb collider auto` produit.
- `sphere` : `size = [rayon]` → `ball(rayon)`.
- `capsule` : `size = [rayon, demi-hauteur]` → `capsule(halfHeight, radius)`
  (**ordre : demi-hauteur d'abord**, puis rayon — cf. piège n°2).
- `convex` : **déclaré dans les types mais NON supporté** par le runtime (le `switch` le traite
  comme `box`). Ne pas l'utiliser en v0.1.

**Génération auto** : `glb collider auto` calcule la bbox depuis les accessors `POSITION`
(seuls les VEC3 référencés par `primitives[].attributes.POSITION` comptent — normales et
couleurs partagent le type VEC3, il faut les ignorer) et écrit `collider { type: box, size, center }`.

**Rigid body + masse** (méta `physics`) :
- `static` → `RigidBodyDesc.fixed()` (sol, murs, caisses, cibles). Friction 1.0.
- `dynamic` → `RigidBodyDesc.dynamic()` + damping (linéaire 0.6, angulaire 0.9) +
  **`collider.setMass(mass)`** (la masse se met sur le **ColliderDesc**, PAS sur le RigidBody).
- `kinematic` → `RigidBodyDesc.kinematicPositionBased()` (le joueur, et toute entité
  téléportée/manipulée).

**Constantes du monde (core, non configurables en v0.1)** : gravité `−19.62 m/s²`
(2× la gravité terrestre — choix gameplay : sauts vifs), vitesse de déplacement `5.6 m/s`,
joueur = capsule `capsule(demi-hauteur 0.55, rayon 0.45)` + KCC (autostep 0.45/0.5,
snapToGround 0.12, masse 80), œil à `+1.55` au-dessus de la base du body, saut `v₀ = 8.2 m/s`
(apogée ≈ 2.04 m et repos à y ≈ 0.92 — validé par le check T3).

**Conversion GLB → Rapier** (à chaque spawn, `spawnFromCache`) :
1. lecture méta `collider`/`physics` (fallback : `box 1×1×1` au centre / `static` 1 kg) ;
2. `RigidBodyDesc` selon `physics.body` ;
3. `ColliderDesc` selon `collider.type` + `setTranslation(center)` + `setMass` si dynamic ;
4. position = coordonnées de spawn (`body.setTranslation(..., wakeUp=true)`).

**Scaling** : **NON supporté** en v0.1. Le mesh est cloné tel quel, le collider est créé aux
dimensions locales ; il n'y a pas d'application de `mesh.scale` au collider Rapier. Si un
asset doit être mis à l'échelle, il faut le pré-échelle dans le GLB (Blender). Ne pas supposer
que `spawnAsset` échelle le collider.

**Objet du monde statique possédé par le jeu** (pattern arène/porte/grille, validé sur les 3
jeux) : un objet **sans entité ECS** (sol, murs, porte, grille) est créé directement sur
`rt.world` + `rt.scene` avec `RAPIER.ColliderDesc.cuboid(...)` + `RigidBodyDesc.fixed()` — voir
§5. L'ouverture d'un tel objet (la porte, la grille) = `world.removeCollider(c, true)` +
`world.removeRigidBody(body)` ; le gameplay prend effet **immédiatement**, l'animation du mesh
est de la présentation (temps de jeu via `onTick`).

**Explosion** (`explodeAt`) : dégâts radiaux (falloff 100 %→35 % en `1 - 0.65·(d/radius)`) sur
toute entité avec `Health` à portée, **et** impulsion sur les rigid bodies **dynamiques** à
portée (falloff `1 - 0.5·(d/radius)`, boost vertical). L'explosion blesse aussi le joueur
(choix de slice).

---

## 10. ECS

**8 composants réels** (types `Cmp*`, `types.ts`). Tous des **plain objects JSON** :

| Component | Structure réelle | Rôle | Exemple |
|---|---|---|---|
| `CmpId` | `{ id: string }` | Identifiant unique, auto-assigné au spawn (`barrel_00d`). | `barrel_00d` |
| `CmpTags` | `{ tags: string[] }` | Tags canoniques (basename du GLB sans extension) + overrides. | `["barrel"]` |
| `CmpAsset` | `{ asset: string }` | Nom du fichier GLB source. | `assets/barrel.glb` |
| `CmpPhysics` | `{ body, mass, sleeping }` | Type de rigid body + masse + état de sommeil Rapier (sync à chaque tick). | `{ body:"dynamic", mass:30, sleeping:false }` |
| `CmpCollider` | `{ type, size, center }` | Collider local (du GLB ou fallback). | `{ type:"box", size:[…], center:[…] }` |
| `CmpHealth` | `{ current, max, zeroEmitted, deadTick? }` | Vie. `current` initialisé au spawn, `zeroEmitted` = `health.zero` déjà émis, `deadTick` = tick de la mort. | `{ current:50, max:50, zeroEmitted:false }` |
| `CmpExplosive` | `{ radius, damage, impulse, exploded }` | Capacité d'explosion (du GLB) + `exploded` (état par instance). | `{ radius:8, damage:120, impulse:20, exploded:false }` |
| `CmpScored` | `{ points: number }` | Score (cibles) / score joueur. | `{ points: 100 }` |

**Le joueur** est créé par le core : `id="player"`, `tags=["player","actor"]`,
`Health { current:100, max:100 }`, `Scored { points:0 }`, `Physics { body:"kinematic", mass:80 }`.

### Flux `Health.max` (GLB) → `Health.current` (ECS)
1. **GLB** déclare `components.Health.max = 50` (capacité, **pas** `current`).
2. **Spawn** : le core clone la méta → `e.Health = { max: 50 }` (pas de `current`).
3. **Normalisation core** : si `Health.current` est `undefined`, il est posé à `= max`
   (→ 50). *C'est ce qui évite le bug `NaN` — sans cela `undefined - 30 = NaN` et
   `health.zero` ne se déclencherait jamais.*
4. **Runtime** : chaque `damage` décrémente `current` ; à `≤ 0` le core émet `health.zero`
   (une seule fois, via `zeroEmitted`) et pose `deadTick`.

**Adapter ECS** (Miniplex derrière `ecs.ts`) — 3 interfaces stables : itération
(`each(cmp)`, `all`), requêtes (`byTag`, `list`, `count`), snapshot JSON (`snapshot()`).
`Miniplex` n'est **jamais** exposé dans l'API publique.

---

## 11. Events

Événements **réellement émis** dans le code validé. Payload : `EventCtx` =
`{ event, entity, other?, amount?, point?, data? }`. Log JSON : `EventRecord` =
`{ t (temps de jeu), tick, event, entity, other?, amount? }` (fenêtre glissante, **max 500**).
Le bus est **synchrones, déterministes, filtrés par tag**, avec un **depth guard > 8**
(anti-boucle d'événements en cascade).

| Event | Émis par | Payload clé | Consommé par |
|---|---|---|---|
| `spawn` | core, à chaque spawn (et joueur au boot) | `data.asset` | (logging) |
| `damage` | jeu (`fire`) + explosions (`explodeAt`) | `other` (source), `amount`, `point` | **système santé core** (décrémente, émet `health.zero`) |
| `health.zero` | core, quand `Health.current ≤ 0` (1×) | `other`, `amount:0` | règles `barrel`/`target`/`player` |
| `destroy` | core `removeEntity` | `data.asset` | (logging) |
| `collision.start` | core, à chaque contact Rapier (drain de l'event queue) | `other` | **aucune règle en v0.1** (émis + loggué) |
| `player.died` | core, quand le joueur passe à `health.zero` | — | règle `player` → game over |
| `switch.activated` | **jeu #2**, interrupteur activé dans le bon ordre | `data.slot` | règle `switch` → `sound`+`addScore` |
| `puzzle.reset` | **jeu #2**, mauvaise séquence (tous les switches repassent inactifs) | `data.slot` | règle `switch` → `sound` |
| `puzzle.completed` | **jeu #2**, séquence complète | — | règle `switch` → `openDoor` + `sound` |
| `player.exited` | **jeu #2**, joueur dans la zone de sortie (porte ouverte) | `other: 'door'` | règle `player` → victoire + `sound` |
| `artifact.collected` | **jeu #3**, artefact récupéré (E à proximité) | `other: 'player'`, `data.dist` | règle `artifact` → `addScore`+`sound` + `openGate` (fn) |
| `guardian.alert` | **jeu #3**, le gardien détecte le joueur (PATROL→ALERT / ATTACK→ALERT) | `other: 'player'`, `data.state`, `data.dist` | règle `guardian` → `sound` |
| `guardian.attack` | **jeu #3**, le gardien entre en attaque (ALERT→ATTACK) | `other: 'player'`, `data.state`, `data.dist` | (logging) |
| `guardian.lost` | **jeu #3**, le gardien perd le joueur et repart en patrouille (ALERT→PATROL) | `other: 'player'`, `data.state`, `data.waypoint` | (logging) |
| `guardian.reached` | **jeu #3**, le gardien atteint un point de patrouille | `data.waypoint` (index suivant) | (logging) |
| `player.extracted` | **jeu #3**, joueur dans la zone d'extraction (artefact en poche) | `other: 'extraction'` | règle `player` → victoire + `sound` |

**⚠️ Divergence à connaître** : le fichier `types.ts` contient une constante `EVENTS` (5 noms,
`collision.start` absent) et un commentaire citant `wave.start, wave.clear, game.over,
ammo.empty` — **ces 4 derniers ne sont émis NULLE PART** dans le code actuel. Ils sont
aspirationnels. Ne pas les supposer existants. Les 6 événements de la table ci-dessus sont
ceux qui comptent **dans le core** — en plus, chaque jeu émet ses propres événements de
gameplay via `rt.bus.emit(...)` (jeu #2 : 4, jeu #3 : 6, tous validés ci-dessus). Le bus n'a
**aucune liste blanche** d'événements.

---

## 12. Actions

Actions **réellement enregistrées** dans le registry (`actions.ts` + `runtime.ts`) : **4**.
La fabrique `A` n'expose que ces 4. Retour de `GameLoom.actions()` (validé) :
`["addScore","destroy","explode","sound"]`.

| Action | Fabrique | Signature réelle | Effet |
|---|---|---|---|
| `explode` | `A.explode(args?)` | `args: { radius?, damage?, impulse? }` (fallback = valeurs `Explosive` de l'entité) | Met `exploded=true`, appelle `explodeAt` (dégâts radiaux + impulsion). No-op si déjà explosé / sans `Explosive`. |
| `destroy` | `A.destroy()` | — | `removeEntity` (retire mesh + rigid body + collider + entité ECS, émet `destroy`). |
| `addScore` | `A.addScore(points)` | `points: number` | `player.Scored.points += points`. |
| `sound` | `A.sound(name, gain?)` | `name: string, gain?: number` | Appelle le hook `onSound` (le jeu joue le SFX synthétisé). |

**⚠️ Divergence** : `types.ts` contient une constante `ACTIONS` avec 7 noms
(`explode, destroy, damage, addScore, play, sound, spawn`). **Seuls les 4 de la table sont
enregistrés et exposés.** `damage`, `play`, `spawn` n'ont **pas** de handler dans le registry
ni de fabrique `A` — code mort/aspirationnel. Utiliser uniquement les 4.

**Principe** : on ne crée pas une Action juste pour qu'une ligne soit plus jolie si elle peut
se composer. La réaction en chaîne est **100 % composée** (règle `health.zero` → `explode` →
dégâts radiaux → `health.zero` du voisin → `explode` …).

---

## 13. Rules / gameplay

API actuelle : **`rt.on(target, event, block)`** où `target` est un **tag** (ou `*`), `event`
un événement, et `block = { if?, do?, fn? }` :
- `if?` : condition `(ctx) => boolean` (optionnelle) ;
- `do?` : `ActionSpec[]` — les actions à exécuter (fabrique `A`) ;
- `fn?` : code de jeu spécifique (hors core), `(ctx) => void`.

Retour : une fonction unsubscribe.

**Exemple réel** (règles de Barrel Blaster, `main.ts`) :
```ts
// Baril: à 0 vie → explose puis se détruit
rt.on('barrel', 'health.zero', { do: [A.explode(), A.destroy()] });

// Cible: à 0 vie → score + son + destruction
rt.on('target', 'health.zero', { do: [A.addScore(100), A.sound('hit'), A.destroy()] });

// Joueur: à la mort → game over (fn = code de jeu, pas d'action core)
rt.on('player', 'player.died', { fn: () => { if (gameOverState === 'none') { gameOverState = 'died'; showGameOver('died'); } } });
```

Semantique : quand `event` est émis sur une entité **tagguée `target`**, le moteur vérifie
`if`, exécute chaque action de `do`, puis `fn`. C'est **EVENT → CONDITION → ACTION(S)**.

**Frontière GLB / Gameplay** (règle d'or) :
- **GLB** = ce que l'objet **est** / peut faire (capacités statiques).
- **Gameplay TS** = **quand** et **pourquoi** il le fait (règles).
- Le GLB ne contient **jamais** de comportement event→action en v0.1.

---

## 14. Temps déterministe

GameLoom tourne en **timestep fixe `FIXED_DT = 1/60 s`** avec un accumulateur. Deux modes :

- **Temps réel** (`resume()` + `start()` + `requestAnimationFrame`) : l'accumulateur consomme
  le temps réel en ticks de 1/60 (garde anti « spiral of death » : max 8 ticks/frame).
- **Temps déterministe** (`pause()` + `step(n)`) : **`step(n)` exécute exactement `n` ticks de
  jeu**, indépendamment du temps réel. C'est le mode des tests.

API temps :
```js
GameLoom.pause()        // fige la simulation
GameLoom.resume()       // reprend en temps réel (rAF)
GameLoom.step(n = 1)    // exécute exactement n ticks de jeu (1/60 chacun), en pause
GameLoom.setPaused(p)   // pause/reprise booléenne
GameLoom.isPaused()     // état
```

**`step(n)` utilise les ticks GameLoom, PAS le temps réel.** Chaque tick = physique Rapier +
KCC + sync mesh/caméra + `onTick` (logique du jeu) + `tick++` + `time += 1/60`. Tout ce qui
dépend du temps (cooldowns, rechargement, delays de vagues) doit être écrit en **temps de
jeu** (`rt.time`), jamais en `setTimeout`/`performance.now`.

**Exemple d'usage (extrait du testeur, validé)** :
```js
GameLoom.pause();
GameLoom.step(90);                       // ~1.5 s de jeu: tick passe à 90 exact
const s0 = GameLoom.snapshot();          // inspecter
GameLoom.step(1);                        // +1 tick
GameLoom.step(10);                       // +10 ticks
// tick = 101, time = 1.6833… — exact et reproductible
```

**Pourquoi PAS de `sleep()`** pour simuler le temps de jeu : un `sleep` de délai réel n'a
aucune corrélation avec les ticks — la physique Rapier est déterministe **seulement** si on
pilote les ticks. `sleep()` n'est utilisé **que** pour le boot/réseau (attendre que Vite
serve les modules + GLB) et pour prouver que la `pause` tient (le tick doit rester figé pendant
un `sleep` réel). **Le gameplay testé par ticks, jamais par délais réels.**

---

## 15. Debug API

### `window.GameLoom` — API publique **contractuelle** (stable, à documenter)
| Méthode | Signature | Retour |
|---|---|---|
| `inspect(id)` | `inspect(string)` | Objet JSON : `id, tags, asset, position, health{current,max,dead}, explosive{…}, score, physics{…}, velocity` ; ou `{ error }` si inconnu. |
| `entities(filter?)` | `filter?: { tag?, component? }` | Tableau JSON compact : `id, tags, pos?, health?, exploded?, points?`. |
| `events(limit?)` | `limit = 30` | Les `limit` derniers `EventRecord` (log JSON). |
| `stats()` | — | `{ tick, time, paused, fps, entities, events_total, actions[], depth }`. |
| `snapshot()` | — | `{ tick, time, paused, player{ pos, health, score, alive, grounded }, entities }`. |
| `doctor()` | — | `{ ok, warnings[], stats, assets{ loaded, without_gameloom_meta }, events_recent[] }`. |
| `pause()` | — | fige. |
| `resume()` | — | reprend (temps réel). |
| `step(n?)` | `n = 1` | exécute `n` ticks de jeu. |
| `setPaused(p)` / `isPaused()` | — | contrôle lecture/écriture de la pause. |
| `rules()` | — | liste des règles (`target, event, hasIf, nActions, hasFn`). |
| `actions()` | — | liste des actions du registry. |
| `version` | (prop) | `"0.1.0"`. |

**Total : 13 méthodes + `version` + `_debug`.** (Le rapport précédent disait 11 — corrigé.)

### `GameLoom._debug` — API de développement / test **NON STABLE** ⚠️
> **Statut** : c'est une API de **debug/harness**, pas contractuelle. Elle peut changer sans
> préavis. Un agent doit savoir que `_debug` est pour développer et tester, **pas** pour le
> gameplay produit.

Méthodes **core** (11, sur 10 lignes — `setPlayerHealth`/`addPlayerHealth` comptent pour 2) :
| Méthode | Rôle |
|---|---|
| `setLook(yaw, pitch)` | pose la visée (pitch clampé ±1.45 rad). |
| `look()` | lit `{ yaw, pitch }`. |
| `teleportPlayer(x,y,z)` | téléporte le joueur (KCC) + résète la vélocité. |
| `setPlayerHealth(h)` / `addPlayerHealth(h)` | manipule la vie du joueur. |
| `input({ move?, jump? })` | écrit l'input (move = `[fwd, strafe]`). |
| `spawn(asset, x, y, z)` | spawne un GLB, retourne l'id. |
| `fire(origin)` | **raycast sans dégâts** (sonde de visée, portée 120) — `origin` = position de l'œil (`snapshot().player.pos + [0, 1.55, 0]`) ; retourne `{ id, point, distance }` ou `null`. |
| `aimAt(x, y, z)` | vise un point (calcule yaw/pitch automatiquement). |
| `remove(id)` | détruit une entité. |
| `clearTag(tag)` | détruit toutes les entités d'un tag. |

Méthodes **ajoutées par les jeux** (pattern validé sur les 3 jeux) : le jeu ajoute ses hooks
d'interaction propre au `window.GameLoom._debug` au boot (comme le fait le core pour
`gameFire` en #1). **Barrel Blaster** : `gameFire()` (1). **Temple Escape** :
`gameInteract()` (actionner l'interrupteur à portée, la logique de proximité étant du code de
jeu) + `templeState()` (état du puzzle : `{ switches, doorOpen, won, seq }`) — 2. **Ruins Raid** :
`gameInteract()` (récupérer l'artefact à portée) + `ruinsState()` (état du raid :
`{ artifact{pos,collected}, gate{open}, extraction{active,x,zMax}, won, dead, gameOver,
guardian{id,state,waypoint,health,cooldown}, waypoints }`) — 2.
**Il n'y a pas de `gameLook`** — la visée passe par `aimAt`/`setLook`.
**Total `_debug` au runtime : 12 + 1 (jeu #1) + 2 (jeu #2) + 2 (jeu #3)** selon le jeu chargé.

**Quelle API est stable** : `inspect/entities/events/stats/snapshot/doctor/pause/resume/step/
setPaused/isPaused/rules/actions` = contractuel. `_debug` = non stable.

---

## 16. Workflow de debug recommandé pour un agent

Ordre d'escalade (du moins coûteux au plus coûteux). **Ne passer au niveau suivant que si le
précédent n'a pas résolu.**

1. **`tsc`** : `npx tsc --noEmit` — la majorité des bugs d'API (Rapier/Miniplex/Three) sont
   **statiques** et capturés ici. Toujours vert avant de tester.
2. **build** : `npm run build` — valide le bundle + `cp assets/*.glb dist/assets/`.
3. **tests déterministes** : `npm run test:headless` (jeu #1, 19/19) / `npm run test:temple`
   (jeu #2, 14/14) — reproductibles. Le premier outil de diagnostic.
4. **console** : `cdp.consoleLogs` / `cdp.errors` (le testeur les collecte) — erreurs non-gérées.
5. **`GameLoom.stats()`** : état global (tick, paused, entities, actions, depth).
6. **`GameLoom.entities({ tag })`** : liste des entités + health/exploded/pos.
7. **`GameLoom.inspect(id)`** : détail d'une entité (health, explosive, physics, velocity).
8. **`GameLoom.events(n)`** : la piste d'audit — qui a émis quoi, à quel tick. **C'est l'outil
   principal pour comprendre le flux.**
9. **`GameLoom.doctor()`** : diagnostic (joueur présent ? entités mortes non détruites ? assets
   sans méta ?).
10. **`pause()`/`step()`** : rejouer tick par tick autour d'un événement suspect.
11. **screenshot** : **uniquement si le problème est réellement visuel** (rendu, placement).
    Jamais pour déboguer la logique (tout est observable en JSON).

**Principe** : observable structuré **d'abord**, vision en **dernier recours**. Sur Barrel
Blaster **et** Temple Escape : **0 bug** a nécessité un screenshot (les checks JSON et les
événements suffisent — y compris pour prouver la géométrie : « le joueur s'arrête à x≈-13.5 »
se lit dans `snapshot().player.pos`).

---

## 17. CDP / harness

Le harness de référence est **`tools/test_headless.mjs`** (260 lignes, 19 checks, port CDP
**9224**). **`tools/test_temple.mjs`** (241 lignes, 14 checks) et **`tools/test_ruins.mjs`**
(332 lignes, 21 checks) en sont la **seconde et troisième instance, même pattern** : même
classe CDP (`ws` → `Runtime.evaluate`), même `check()`/bilan, même contrôle du temps par
`pause()`/`step(n)`, `URL_TARGET` propre au jeu. Le harness #3 ajoute un **fingerprint de
ticks** (positions/jauge aux ticks clés) pour comparer la détermination entre runs successifs
(5/5 runs verts, fingerprint identique). **Référence le pattern plutôt que de recopier à
l'aveugle** ; pour un nouveau jeu, dupliquer le fichier et changer `URL_TARGET` + les checks.
Portable Windows/Linux (aucun chemin absolu d'OS ; validé sur les deux).

Workflow réellement validé :
1. **Lancer Chrome headless** (prérequis, hors npm) :

   Linux :
   ```bash
   google-chrome-stable --headless=new --no-sandbox \
     --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader \
     --remote-debugging-port=9224 --user-data-dir=/tmp/chrome_gl \
     --window-size=1280,720 --mute-audio about:blank
   ```
   Windows (PowerShell — profil isolé obligatoire si une session Chrome tourne déjà) :
   ```powershell
   Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" -ArgumentList `
     "--headless=new","--no-sandbox","--use-gl=angle","--use-angle=swiftshader",`
     "--enable-unsafe-swiftshader","--remote-debugging-port=9224",`
     "--user-data-dir=$env:TEMP\chrome_gl_cdp","--window-size=1280,720","--mute-audio","about:blank"
   ```

   (WebGL par **SwiftShader** — pas de GPU. Vérifier : `curl -s localhost:9224/json/version`
   → `"Browser": "Chrome/…"` + `webSocketDebuggerUrl`.)
2. **Ouvrir le jeu** : `Page.navigate` sur `URL_TARGET` (défauts : `http://localhost:4173/`
   pour `test_headless.mjs`, `http://localhost:4173/temple.html` pour `test_temple.mjs` —
   build production) ; attendre `typeof window.GameLoom === "object"`.
3. **Injecter l'input** : `GameLoom._debug.input({ move, jump })`, `aimAt(x,y,z)`,
   `gameFire()`, `teleportPlayer(...)`.
4. **Contrôler le temps** : `GameLoom.pause()` + `GameLoom.step(n)` — **jamais de `sleep()`
   pour le gameplay**.
5. **Interroger GameLoom** : `snapshot()`, `entities()`, `inspect()`, `stats()`.
6. **Récupérer les événements** : `GameLoom.events(n)` (JSON) — la preuve de la séquence.
7. **Tester** : assertions sur les JSON (`health`, `destroy`, tick de `health.zero` simultané…).
8. **Screenshot en dernier recours** : `Page.captureScreenshot` (validation visuelle finale).

Détails d'implémentation utiles :
- Le testeur ouvre une connexion **`ws`** à `page.webSocketDebuggerUrl` et évalue du JS via
  `Runtime.evaluate` (`returnByValue`).
- **Cache navigateur désactivé** (`Network.setCacheDisabled`) : les réponses `404` HTML ne
  doivent pas polluer le cache (piège n°8).
- Les checks sont numérotés T1–T9 + PRE, bilan `BILAN: n/19 tests passés`, exit code 0 si tout
  passe.
- La visée utilise **`_debug.aimAt`** (pas de calcul manuel yaw/pitch) et **`_debug.fire`**
  comme sonde raycast pour choisir une cible visible.
- Le screenshot final est écrit dans **`tools/final_screenshot.png`** (chemin relatif au
  harness, via `fileURLToPath(import.meta.url)` — portable Windows/Linux, git-ignoré).

---

## 18. Conventions obligatoires

Règles découvertes et fixées pendant Barrel Blaster (violées = bugs réels) :

1. **Composants = plain objects JSON** (sérialisables). `structuredClone` pour dupliquer.
2. **État indépendant par spawn** : chaque entité a **sa propre** copie des composants du GLB
   (**jamais** d'aliasing de référence depuis le cache) — cf. §6.
3. **Une seule source de vérité pour l'input** : l'input vit dans le **core**
   (`applyPlayerControl` / `_debug.input`). Le jeu écrit par événement clavier ; **le jeu ne
   doit pas ré-écrire l'input chaque tick** (ça écrase celui du test).
4. **Une seule source de vérité yaw/pitch** : la visée vit dans le **core** (`setLook`/`aimAt`).
   Pas de `yaw`/`pitch` dupliqués dans le jeu.
5. **Vitesse en m/s, appliquée avec `FIXED_DT`** : le déplacement est `vitesse * FIXED_DT`
   (pas `vitesse` seul — sinon 5.6 m/tick).
6. **Gameplay temporel en temps de jeu** : cooldowns, rechargement, delays de vagues en `rt.time`
   (temps de jeu), **jamais** `setTimeout`/`performance.now`.
7. **Temps testé par ticks** : `pause()`/`step(n)`, jamais de `sleep()` pour le gameplay.
8. **Pas de comportement event→action dans le GLB** en v0.1 (le GLB = capacités seulement).
9. **Pas de mutation permanente du GLB pendant le gameplay** : l'état runtime est dans l'ECS,
   le GLB (source) n'est jamais réécrit à l'exécution.
10. **IDs uniques** : auto-générés au spawn (`<tag>_<seq36>`), ex. `barrel_00d`.
11. **Tags canoniques** : le tag par défaut = **basename du GLB sans extension**
    (`assets/barrel.glb` → `barrel`), pas le chemin complet.
12. **Origine des assets à la base** : spawn à `y = 0` (base du mesh au sol), cf. §6.
13. **Tester sur le build production** (4173), **pas** sur le dev server (5173, HMR = double-boot).
14. **Copier les GLB dans `dist/assets/`** après chaque build (Vite ne copie pas `assets/`).

---

## 19. Pièges connus

Leçons **réellement rencontrées** (l'objectif : empêcher le prochain agent de les refaire).
Le `tsc` + le harness CDP ont capturé la quasi-totalité des bugs — la vision n'a servi à
rien.

1. **`RAPIER.init()`** : il faut **`await RAPIER.init()`** (appeler la fonction). `await RAPIER.init`
   (sans `()`) attend une fonction, jamais la Promise → le WASM n'est **jamais** initialisé,
   silencieux. (Dans `createRuntime` **et** `main.ts`.)
2. **API Rapier 0.21 — 13 mismatches** (tous capturés par `tsc` avant runtime) :
   - masse : `collider.setMass()` sur le **ColliderDesc**, **pas** sur le RigidBody ;
   - `body.isDynamic()` (méthode booléenne), **pas** `body.type()` ;
   - `ColliderDesc.setTranslation(x, y, z)` (3 args), **pas** un objet ;
   - `capsule(halfHeight, radius)` — **demi-hauteur d'abord**, pas rayon ;
   - `RigidBodyDesc.kinematicPositionBased()` (factory) ;
   - `new RAPIER.EventQueue(false)` (1 arg autoDrain) ;
   - `world.castRayAndGetNormal(ray, maxToi, solid, filterFlags?, filterGroups?, excludeCollider?)`
     ; `world.bodies.getAll()` / `world.colliders` (propriétés, pas méthodes) ;
   - `world.colliders.get(handle)` pour remonter du handle au collider.
3. **`Health.current`** : le GLB déclare `max` **seul**. Sans initialisation `current = max`,
   `undefined - dégât = NaN` → `NaN <= 0` = false → `health.zero` **ne se déclenche jamais**.
4. **Aliasing des composants GLB** : partager l'objet `meta.components.X` entre instances
   = bug (un baril mort « contamine » tous les autres). **`structuredClone` au spawn.**
5. **Raycast : `origine + dir × toi`** : le point d'impact = `origin + dir * timeOfImpact`,
   **pas** `dir * toi` (qui omet l'origine → point faux, relatif à l'origine monde).
6. **HMR / double-boot** : le dev server Vite fait du HMR pendant les tests → **2 runtimes
   GameLoom en parallèle** (état partagé/incohérent). **Tester sur le build production.**
7. **Emplacement des assets Vite** : `assets/` n'est **pas** servi par `vite build` (seul
   `public/` l'est). **`cp assets/*.glb dist/assets/`** après build (ou déplacer dans `public/`).
8. **Cache navigateur dans les tests** : une réponse `404` HTML peut être mise en cache et
   servie à la place du GLB. **Désactiver le cache CDP** (`Network.setCacheDisabled`).
9. **Blender/glTF axes + origine** : Blender **Z-up** vs glTF **Y-up** (`export_yup=true`) ;
   mettre **l'origine à la base** (`ORIGIN_CURSOR`) sinon la bbox est `[0,0,0]` et le spawn au
   sol est faux.
10. **Accessors `POSITION` vs autres VEC3** : normales et couleurs partagent le type `VEC3` —
    pour la bbox, **ne compter que** les accessors référencés par
    `primitives[].attributes.POSITION` (sinon le bbox inclut des normales/couleurs).
11. **Buffer Node poolé** : `ArrayBuffer.isView` / `byteOffset` non nul — normaliser toujours
    sur `(arrayBuffer, byteOffset, byteLength)` avant de lire le GLB binaire (sinon décalage).
12. **Tag dérivé du chemin complet** : `assets/barrel` au lieu de `barrel` → utiliser le
    **basename** (`asset.split('/').pop().replace(/\.glb$/, '')`).
13. **Mouvement non mis à l'échelle** : `dx = … * speed` (sans `* FIXED_DT`) → 5.6 m/tick.
14. **Double source de vérité** (input, yaw/pitch) : le jeu écrase l'état du core chaque tick.
15. **Layout aléatoire de test** : les spawns de vague sont aléatoires → occlusions + joueur
   mort → faux négatifs. **Scènes de test contrôlées** (`clearTag` + `teleportPlayer` +
   `spawn` à positions fixes) pour T5/T6.
16. **Chemin absolu d'OS dans le code** : le harness écrivait son screenshot dans
   `/home/jbo/gameloom/...` (Linux) → `ENOENT` (`C:\home\jbo\...`) sous Windows, crash
   `FATALE` exit 2 **malgré 18/19 checks passés**. **Chemins relatifs au repo**
   (ici : `fileURLToPath(import.meta.url)`), jamais de chemin absolu d'utilisateur/d'OS.

---

## 20. Ce qui N'EXISTE PAS (ne pas supposer)

Pour éviter les hallucinations d'un agent : les éléments suivants **n'ont PAS été implémentés**
en v0.1 et **ne doivent PAS être supposés** présents. Si un futur agent en a besoin, c'est un
nouveau développement (à valider + documenter avant).

- **Éditeur visuel / éditeur de scène graphique** — aucune GUI d'édition.
- **DSL GameLoom** — pas de langage/domaine spécifique, pas de parser, pas de compilateur.
- **CLI `game`** — le seul CLI est `glb` (assets). Il n'y a **pas** de CLI `game`.
- **Alias metadata / versions multiples** — un seul namespace `com.gameloom.v0`.
- **Audio embarqué dans le GLB** — l'audio est **synthétisé** (Web Audio) dans le jeu, pas
  stocké dans les GLB.
- **Inventory / inventaire** — aucun.
- **Quest / quêtes** — aucun système de quêtes générique dans le core. Les « vagues » (jeu #1)
  et la séquence de puzzle (jeu #2) sont du **code de jeu** — c'est la frontière normale.
- **Save / load / persistance** — aucune sauvegarde d'état.
- **Multiplayer / réseau** — aucune.
- **Animation / root motion** — **absent**. Aucun asset animé n'est utilisé ; le core ne lit
  ni ne joue d'animations (pas de `AnimationMixer`, pas de root motion). Les cibles/barils sont
  des meshes statiques. (À ajouter quand un asset animé sera réellement nécessaire.)
- **Collider `convex`** — déclaré dans les types mais **non supporté** par le runtime.
- **Scaling d'instance appliqué au collider** — non supporté (§9).
- **Events `wave.start / wave.clear / game.over / ammo.empty`** — cités dans un commentaire de
  `types.ts` mais **jamais émis** (§11).
- **Actions `damage / play / spawn`** — citées dans `types.ts` mais **non enregistrées**
  dans le registry (§12).
- **Subscriptions de `collision.start`** — l'événement est émis/loggué mais **aucune règle**
  ne s'y abonne en v0.1.

---

*Ce document est la source de vérité. Toute capacité ajoutée doit y être validée et documentée
avant d'être considérée terminée. Version : GameLoom v0.1 — slices Barrel Blaster + Temple
Escape + Ruins Raid (2026-09-27), validés Linux (Chrome 154) et Windows (Chrome
153.0.8010.53). Core : 888 LOC, non modifié entre les trois jeux.*
