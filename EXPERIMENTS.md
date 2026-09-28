# GameLoom Engineering Experiments

> ## Purpose
> Ce fichier est la **mémoire d'ingénierie et de recherche** de GameLoom. Il contient
> l'historique des vertical slices, les preuves, les mesures, les observations, les
> décisions architecturales et les expériences — ce qui a fonctionné, ce qui a échoué,
> quelles frictions reviennent, quelles abstractions sont candidates.
>
> **Il n'est PAS requis pour utiliser GameLoom.** Pour créer un jeu, utiliser le CLI ou
> déboguer, lire `GAMELOOM.md` uniquement. Ce fichier est à lire :
> - pour comprendre **pourquoi** l'architecture actuelle existe ;
> - **avant de modifier le core** ;
> - **avant d'ajouter une nouvelle abstraction** (vérifier les preuves accumulées).
>
> `JOURNAL.md` reste comme **archive brute** du bootstrap (Game #1) — ne pas le mettre à
> jour ; les faits structurés vivent ici.
>
> **Règle de cohérence** : en cas de contradiction, `GAMELOOM.md` fait autorité sur le
> **comportement actuel** du logiciel ; ce fichier fait autorité sur l'**historique
> expérimental**.

---

## Experimental methodology

Méthode de travail validée sur les 5 slices :

- **Vertical slices** : un jeu complet et jouable (boot → gameplay → victoire/mort →
  harness) plutôt qu'une fonctionnalité isolée. Chaque slice valide une ou plusieurs
  capacités du moteur dans un contexte réel.
- **Tests déterministes** : timestep fixe (`FIXED_DT = 1/60`), `pause()` + `step(n)`,
  scènes de test contrôlées (spawns/positions fixes, pas d'aléatoire non seedé), build
  production + Chrome headless (CDP port 9224, WebGL SwiftShader).
- **JSON-first** : tout est observable via `snapshot()` / `entities()` / `events()` /
  `stats()` / `doctor()`. La vision (screenshot) est le **dernier recours**.
- **Mesure de friction** : avant d'ajouter une primitive au core, mesurer ce que le jeu
  doit écrire à la main (lignes, connaissances du core requises, duplication) sur au
  moins 2 slices.
- **Régressions** : chaque nouveau jeu relance les harness des jeux précédents (doivent
  rester verts) + son propre harness + N runs consécutifs avec **fingerprint de ticks**
  identique (valeurs exactes aux ticks clés).
- **Règle de non-abstraction prématurée** : une primitive n'entre dans le core que si la
  même friction est reproduite sur ≥ 2 slices (règle des trois, comptant la 1re
  occurrence du pattern). Les candidates restent documentées ici, **jamais** présentées
  comme API GameLoom dans `GAMELOOM.md`.

**Environnements validés** : Linux (Chrome 154) et Windows (Chrome 153.0.8010.53),
Node 22, Blender 4.2 LTS (4.2.23 sur la machine Windows) pour la génération d'assets.

---

## Game #1 — Barrel Blaster (micro-FPS à vagues, hitscan, explosions en chaîne)

**Objectif** : slice n°1 = créer le core GameLoom (moteur complet) + un jeu FPS minimal
(arène, tir hitscan, vagues de barils explosifs, cibles, munitions).

**Architecture testée** : le core entier — `createRuntime` (Rapier WASM + KCC), timestep
fixe, bus d'événements, moteur de règles `rt.on`, registry d'actions (4), ECS (adapter
Miniplex), pipeline GLB (`com.gameloom.v0`), CLI `glb`, debug API (`window.GameLoom` +
`_debug`), audio synthétisé.

**Bugs importants (14, tous corrigés, tous prouvés par exécution)** :
1. Buffer Node poolé (`byteOffset`) casse la lecture binaire GLB (CLI).
2. Blender Z-up vs glTF Y-up + origine à la base → bbox `[0,0,0]`.
3. `computeBbox` lisait normales/couleurs comme positions (type VEC3 partagé).
4. Tag dérivé du chemin complet `assets/barrel` au lieu de `barrel`.
5. `await RAPIER.init` sans `()` → WASM jamais initialisé, silencieux.
6. 13 mismatches TS/API Rapier 0.21 (`setMass` sur le ColliderDesc, `isDynamic()`,
   `kinematicPositionBased`, `capsule(halfHeight, radius)`, `EventQueue(false)`,
   `castRayAndGetNormal`, `world.colliders.get`, …).
7. Déplacement non mis à l'échelle par `FIXED_DT` (5.6 m/tick).
8. Jeu écrase l'input du testeur chaque tick (double source de vérité).
9. yaw/pitch dupliqués (jeu + core) → source unique dans le core.
10. **`Health.current` undefined → NaN** (le GLB ne déclare que `max`) → `health.zero`
    jamais émis.
11. **Aliasing des composants : toutes les instances d'un GLB partagent le même objet
    Health/Explosive** (bug le plus grave) → `structuredClone` au spawn.
12. Point d'impact raycast = `dir * toi` (origine manquante) → `origin + dir * toi`.
13. Vite HMR double-boot en dev → 2 runtimes en parallèle → tester sur le build prod.
14. Non-déterminisme de test (vague 1 aléatoire : occlusion + joueur mort) → scènes de
    test contrôlées.

**Résultats** : harness 19/19 — **8 runs consécutifs (Linux, Chrome 154) + 3 runs
(Windows, Chrome 153.0.8010.53)**, déterminisme exact.

**Mesures** :
- Durée totale : **218 min** (2026-09-27 12:15 → 15:54), dont ~90 min sur les 13
  mismatches API Rapier 0.21 (**coût principal** — lecture des `.d.ts`), ~40 min core,
  ~40 min bugs gameplay, ~30 min testeur CDP, ~15 min scaffolding.
- Cycle d'itération : patch → `tsc` (2 s) → `vite build` (0,5 s) → test complet (~3 s)
  = **~10–15 s**.
- KCC mesuré : mouvement 5.6 m/s stable, `grounded` vrai, repos à y ≈ 0.92 ; saut :
  apogée 2.041 → retour 0.92 ; pas de polish (pas de slide en pente) — non requis.
- Bugs trouvés **sans vision** (JSON/CDP) : 10+. Bugs ayant nécessité un screenshot :
  **0** (1 seul screenshot final de validation).

**Enseignements** :
- L'anti-aliasing (`structuredClone`) est une règle d'architecture, pas un détail.
- Le déterminisme exige de piloter les **ticks** (`step(n)`), jamais le temps réel
  (`sleep()`), et des scènes de test contrôlées.
- Le `tsc` strict + le harness CDP capturent la quasi-totalité des bugs ; la vision ne
  sert à rien pour la logique.
- Le pipeline assets Blender → GLB → CLI `glb` tourne en ~3 min/asset après
  stabilisation du CLI.

**Dette observée** (au moment de la slice) : `_debug` non formel (helpers de test) ;
`deadTick` ajouté pour le `doctor()` ; l'explosion blesse le joueur (kinematic) — choix
de slice ; chunk Rapier ~5 MB (import dynamique inefficace, déjà statique) ; GLB hors
`public/` → copie manuelle dans `dist` ; pas d'animation/root-motion ; pas de save/load.

**Décisions** : namespace `com.gameloom.v0` unique ; 4 actions seulement (`explode`,
`destroy`, `addScore`, `sound`) ; composants = plain objects JSON ; API publique
contractuelle vs `_debug` non stable.

---

## Game #2 — Temple Escape (aventure/puzzle : 3 interrupteurs, porte, sortie)

**Objectif** : slice n°2 = valider un **autre usage du core** sans le modifier :
2e entrée HTML (multi-entry Vite), puzzle à séquence, **objet du monde possédé par le
jeu** (la porte), zone de sortie par inclusion, et un **pipeline d'asset sans Blender**.

**Architecture testée** :
- État du puzzle en TypeScript (slot A/B/C) + règles EVENT→ACTION
  (`switch.activated`, `puzzle.reset`, `puzzle.completed` → `openDoor`).
- Porte = objet **sans entité ECS** : `rt.world` (Rapier) + `rt.scene` (Three.js),
  ouverture = `world.removeCollider(c, true)` + `world.removeRigidBody(body)` (effet
  gameplay immédiat) + animation du mesh (présentation).
- Zone de sortie : inclusion dans `onTick` (joueur dans la zone + porte ouverte →
  `player.exited` → victoire).
- Assets : `switch.glb` généré par **`tools/make_glb.mjs`** (générateur GLB low-poly
  **pure Node**, sans Blender) + `glb collider auto` + `glb physics set`.
- Hooks `_debug` de jeu : `gameInteract()` + `templeState()`
  (`{ switches, doorOpen, won, seq }`).

**Résultats** : harness 14/14 — **3 runs (Windows, Chrome 153.0.8010.53)**, déterminisme
exact.

**Événements de jeu émis** (4) : `switch.activated`, `puzzle.reset`, `puzzle.completed`,
`player.exited`.

**Enseignements** :
- Le **contexte de scène** (quel slot d'interrupteur) est porté par des **tags override**
  (`tags: ['switch', 'sw_a']`) et PAS par une capacité d'asset — la frontière
  GLB (capacités) / TS (contexte + comportement) tient.
- Le bus accepte **tout** nom d'événement : les événements de jeu ne nécessitent aucune
  extension du core.
- Le pattern « objet du monde possédé par le jeu » (porte) fonctionne sans toucher au
  core : `rt.world` + `rt.scene` suffisent.
- Le pipeline asset **sans Blender** est validé (`make_glb.mjs` + CLI `glb`).

---

## Game #3 — Ruins Raid (exploration/action : gardien mobile, artefact, grille, extraction)

**Objectif** : slice n°3 = valider une **entité mobile possédée par le jeu** (gardien)
sans extension du core, + 3e entrée HTML + **premier fingerprint de ticks** dans un
harness.

**Architecture testée** :
- Gardien = entité spawnée `physics.body = 'kinematic'`, déplacée par le jeu :
  recherche du rigid body (`rt.world.bodies.getAll()` + `b.userData === id`),
  `setTranslation`/`setRotation` dans `onTick`, **machine à états PATROL/ALERT/ATTACK**
  avec waypoints.
- Le core synchronise le mesh sur la position Rapier à chaque tick ; le **KCC du joueur
  traite le corps kinematic comme un obstacle solide** (pas de traversée du gardien).
- **Verrouillage anti-traversée des murs** via `rt.raycast` (origine décalée le long de
  la direction ; la capsule du joueur est exclue automatiquement).
- Grille (objet du monde possédé par le jeu, pattern du jeu #2) + zone d'extraction par
  inclusion.
- Assets : `guardian.glb`, `artifact.glb`, `ruins_column.glb` (Blender headless 4.2.23,
  `tools/blender/make_ruins_assets.py`).
- Hooks `_debug` de jeu : `gameInteract()` + `ruinsState()`
  (`{ artifact{pos,collected}, gate{open}, extraction{active,x,zMax}, won, dead,
  gameOver, guardian{id,state,waypoint,health,cooldown}, waypoints }`).

**Résultats** : harness 21/21 — **5 runs (Windows, Chrome 153.0.8010.53) avec
fingerprint de ticks identique** (positions/jauge aux ticks clés).

**Événements de jeu émis** (6) : `artifact.collected`, `guardian.alert`,
`guardian.attack`, `guardian.lost`, `guardian.reached`, `player.extracted`.

**Enseignements** :
- Une entité mobile **kinematic** est complète sans aucune API de mouvement dans le
  core — mais le jeu doit écrire à la main la recherche du body (`userData`),
  l'orientation (quaternion), le déplacement clampé et le verrou raycast : **première
  observation de la friction « entité mobile »** (règle des trois déclenchée, cf.
  §Candidate abstractions).
- Le verrou raycast repose sur une sémantique interne du core (« le raycast exclut la
  capsule du joueur ») que le jeu doit connaître : **fuite de connaissance** du core
  vers le jeu.

---

## Game #4 — Dungeon Assault (FPS/donjon : 3 ennemis distincts, piège, clé, porte, sortie)

**Objectif** : slice n°4 = (a) 3 comportements d'ennemis **distincts** (gardien mobile
PATROL/ALERT/ATTACK, brute dormante activée par zone, mage à distance à projectiles),
zone de piège à pointes, clé (interact), porte verrouillée, zone de sortie ; (b)
**expérience d'architecture** : mesurer honnêtement la friction `moveEntity(...)` /
`zone(...)` sans les implémenter.

**CORE_ACCESS_REQUIRED = 0** : aucune lecture ni modification de `src/core/**` pendant
toute la slice.

**Architecture testée** :
- 3 machines à états d'ennemis distinctes ; les 2 mobiles utilisent le pattern kinematic
  du jeu #3 (`bodyOf`/`faceBody`/`moveBody`/`chaseBody` recopiés).
- **Projectiles possédés par le jeu** : rigid body kinematic + collider ball
  (r = 0.18), déplacement verrouillé par `rt.raycast` (tick par tick), hit sur le joueur
  par proximité (< 0.65 m), TTL 75 ticks.
- **Zone de piège** (AABB x∈[12,15], |z|≤1.5) : états entrée/sortie **manuels**
  (`trapInside`), dégâts à l'entrée (10) puis périodiques (5 / 12 ticks).
- **Clé** : interact E à 2.2 m → `key.collected` → score + destruction + `unlockDoor`.
- **Porte verrouillée** : objet du monde possédé par le jeu (pattern #2/#3) ; le
  collider est retiré au déverrouillage.
- **Zone de sortie** : AABB + condition (clé + porte) → `player.exited` → victoire.
- **Tir hitscan joueur** : raycast depuis l'œil, dégâts 25, cooldown 0.25 s — avec le
  comportement « sauter les projectiles ennemis » (cf. bugs ci-dessous).
- Assets : `dungeon_key.glb`, `dungeon_mage.glb`, `dungeon_spikes.glb` (Blender
  headless, `tools/blender/make_dungeon_assets.py`).
- Hooks `_debug` de jeu : `gameFire()`, `gameInteract()`, `dungeonState()`
  (`{ key, door, trap, exit, won, dead, gameOver, enemies[], projectiles, score }`),
  `rayProbe(o, d, dist)`.

**Bugs rencontrés (2, tous issus de la friction entités/zones)** :
1. **Projectile auto-détruit par son propre raycast** : le check « mur » était lancé
   depuis le centre du projectile, c'est-à-dire **à l'intérieur de son propre collider
   ball** → time-of-impact = 0 → destruction au tick suivant. Fix : lancer le raycast
   depuis `pos + dir × 0.19` (juste en dehors de la sphère).
2. **Crossfire joueur/mage** : le projectile du mage (collider **sans entité**) croisait
   la ligne de tir du joueur ; le raycast hitscan du joueur frappait le projectile avant
   le mage (`hit.entity = null`, ~1.14 m) → shot gaspillé. Fix : `fire()` re-raycaste
   juste au-delà d'un hit sans entité quand ce hit correspond à un projectile du jeu.

**Résultats** : harness 34/34 — **5 runs (Windows, Chrome 153.0.8010.53), fingerprint
unique** sur les 5 runs :
```json
{"tickAfterT3":41,"playerT4":[-3.2,0],"patrolA":[[7.013,-0.526],[5.564,-0.85],[5.05,0.69]],
"alertTick":196,"attackTick":242,"activatedTick":331,"detectedTick":376,"firedTick":466,
"projMoveDist":1.1667,"projHitTick":492,"cKillTick":579,"trapEnterTick":595,
"trapExitTick":612,"keyTick":691,"doorTick":691,"exitTick":713,"diedTick":42,"hpT18":85}
```

**Événements de jeu émis** (10 nouveaux + réutilisation de `player.exited`) :
`enemy.alert`, `enemy.attack`, `enemy.lost`, `enemy.activated`, `enemy.detected`,
`enemy.fired`, `key.collected`, `door.unlocked`, `trap.enter`, `trap.exit`.

**Mesure de friction (l'expérience d'architecture)** — lignes de code **hors
commentaires/blancs** que le jeu a dû écrire à la main :

| Primitive | Fonction | Lignes |
|---|---|---|
| `bodyOf(id)` | recherche du rigid body via `userData` | 4 |
| `faceBody(b, dx, dz)` | orientation (quaternion yaw demi-angle) | 5 |
| `moveBody(b, to, maxStep)` | déplacement simple clampé | 9 |
| `chaseBody(b, target, maxStep)` | déplacement verrouillé (`rt.raycast`) | 17 |
| **MOBILE_ENTITY_FRICTION** | | **35 LOC/jeu** |
| `tickTrap()` | zone AABB + états entrée/sortie + dégâts périodiques | 17 |
| `checkExit()` | zone AABB + condition multiple (clé + porte) | 9 |
| zone d'activation de la brute (en ligne dans `tickB`) | AABB recopié | 5 |
| **ZONE_FRICTION** | | **31 LOC/jeu** |

**Les 3 frictions réelles** (au-delà du nombre de lignes) :
1. **Fuite de connaissance du core vers le jeu** : `bodyOf` pioche dans
   `rt.world.bodies` + `userData` (comptabilité interne au spawn), `chaseBody` repose
   sur `rt.raycast` **qui exclut la capsule du joueur** (sémantique interne),
   l'orientation est un quaternion calculé à la main.
2. **Subtilité / pièges physiques** : les 2 bugs ci-dessus viennent directement de cette
   friction — le jeu doit raisonner sur la physique des collisions qu'il ne possède pas
   (collider sans entité, TOI nul sur soi-même).
3. **Duplication** : le test d'inclusion AABB est écrit **3 fois** (`tickTrap`,
   `checkExit`, activation de la brute), et l'état d'entrée/sortie (booléen
   `trapInside`) est maintenu à la main.

**Verdict honnête** :
- `moveEntity(id, target, maxStep, { face })` — **mériterait d'entrer dans le core,
  priorité moyenne** (35 LOC de physique subtile par jeu, besoin dans 2 des 4 jeux).
- `zone(min, max, { onEnter, onExit, tick? })` — **mériterait d'entrer dans le core,
  priorité basse** (31 LOC/jeu + duplication AABB ×3 + états d'arête manuels).
- **Non implémentés** en v0.1 — input pour une décision future, pas une capacité.

---

## Game #5 — Outpost Rescue (FPS/rescue : 3 survivants escortés, 2 ennemis, 2 zones dangereuses, évacuation)

**Objectif** : (a) 5e vertical slice jouable sous pression sur **deux axes volontaires** —
déplacement runtime de **plusieurs entités** (3 survivants + 2 ennemis = 5 kinematic) et
**plusieurs zones/triggers** (feu + gaz + évacuation = 3 zones, multi-entités) ; (b)
**test d'autonomie de `GAMELOOM.md`** : un agent neuf construit le jeu en n'en lisant que
ce fichier (EXPERIMENTS/JOURNAL interdits), note les `DOC_GAP` et mesure la friction
**sans modifier le core**.

**CORE_ACCESS** : **1 lecture** (`interface Runtime`, `src/core/runtime.ts` L31–61) —
après `DOC_GAP` explicite (cf. ci-dessous) ; **0 modification**.

**Architecture testée** :
- **3 survivants** (`survivor.glb` kinematic + `Health.max=100`, tags `survivor_a/b/c`) :
  `WAITING → FOLLOWING` (interact E, 2,2 m) → `EVACUATED` (zone d'évacuation). `FOLLOWING`
  = suivi à distance cible 2,2 m via `chaseBody` (kinematic possédé par le jeu) ; quand le
  joueur entre dans la zone d'évacuation, chaque survivant part vers un **offset individuel
  fixe** (déterministe) et s'arrête ; dans la zone → `EVACUATED` (1×) → compteur 1/3 → 3/3.
- **2 ennemis** (`guardian.glb` réutilisé, kinematic + `Health.max=100`, tags `enemy_e1/e2`) :
  `IDLE → CHASE` (détection 8 m) → attaque à ≤ 1,5 m (dégâts 12, cooldown 45 ticks,
  `coolFirst` 30 sur la 1re attaque en portée).
- **2 zones dangereuses** (feu x[1,5] z[-2,2] ; gaz x[-5,-1] z[4,8]) : inclusion AABB dans
  `onTick`, **état d'arête par (zone, entité)** (`Map` clé `${zone}:${entity}`) →
  `danger.enter`/`danger.exit` **uniquement sur transition** (pas de spam par tick) ;
  feu = dégâts à l'entrée 15 + périodiques 4/12 ticks, gaz = dégâts à l'entrée 20.
  **Cibles : joueur + survivants vivants** (première zone **multi-entités** des 5 slices).
- **Zone d'évacuation** (x[12,15.5] z[-2,2]) : survivant `FOLLOWING` dans la zone →
  `EVACUATED` ; 3/3 → `rescue.completed` ; joueur dans la zone **après** `rescue.completed`
  → `player.extracted` → victoire (entrée trop tôt = pas de victoire).
- **Tir hitscan joueur** (raycast depuis l'œil, dégâts 30, cooldown 0,25 s), score 100/ennemi.
- **Map** : extérieur borné x[-12,5] z[-10,5], cour centrale, 3 murs/couvertures, réutilisation
  de `crate` ×3 + `ruins_column` ×2.
- **Assets** : `survivor.glb` **nouveau** (`make_glb.mjs` + `glb collider auto` +
  `physics set kinematic` + `Health.max=100` ; `validate` + `doctor` OK, 0 avertissement).
  Réutilisés : `guardian`, `crate`, `ruins_column`.
- **Hooks `_debug`** : `gameFire()`, `gameInteract()`, `outpostState()`
  (`{ survivors[], enemies[], evac{}, dangers[], evacCount, rescueComplete, won, dead,
  gameOver, score }`), `rayProbe(o,d,dist)`.

**Résultats** : harness **32/32** — **5 runs (Windows, Chrome 153), fingerprint unique** sur
les 5 runs :
```json
{"tickAfterT3":41,"playerT4":[-5.2,3],"e1AlertTick":0,"e1KillTick":314,"e2KillTick":378,
"fireEnterTick":394,"fireExitTick":471,"gasEnterTick":394,"hpAfterFire":61,
"aFollowedTick":495,"aEvacTick":1045,"bFollowedTick":1107,"cFollowedTick":1114,
"bEvacTick":1526,"cEvacTick":1249,"gapA16":2.16,"rescueTick":1526,"extractedTick":1526,
"diedTick":30,"final":{"won":true,"evacCount":3,"enemies":0,"score":200}}
```
**Régressions** (1× chacune, toutes vertes) : #1 (19/19) + #2 (14/14) + #3 (21/21) + #4 (34/34).

**Événements de jeu émis** (8 nouveaux + réutilisation de `player.extracted`/`enemy.alert`) :
`survivor.followed`, `survivor.evacuated`, `survivor.died`, `danger.enter`, `danger.exit`,
`enemy.killed`, `rescue.completed`.

**DOC_GAP (test d'autonomie `GAMELOOM.md`)** : **1** — la liste §5 « Méthodes Runtime
appelables du code jeu » était **incomplète** (omis : `applyPlayerControl`, `setLook`,
`byTag`/`byId`, `start`, `setPaused`/`tickOnce`). Résolu par lecture du jeu de référence
(`dungeon/main.ts`, autorisé) **+** lecture core minimale (`interface Runtime`) **après**
marquage du gap. `GAMELOOM.md` §5 complété. Au-delà, un agent neuf peut construire le jeu
à partir de `GAMELOOM.md` seul + le jeu de référence autorisé (pattern entité mobile).
**`GAMELOOM.md` jugé autonome = OUI** (à la seule réserve de la complétion §5 ci-dessus).

**Bugs rencontrés (3, tous issus de la friction zones/entités — aucun core)** :
1. **Ennemi qui s'arrête à la portée d'attaque** : l'ennemi cesse de bouger à ≤ 1,5 m pour
   attaquer (comportement correct) ; la 1re version du harness mesurait une fenêtre de
   déplacement de 30 ticks qui **enjambe l'arrêt** → faux négatif. Fix : harness (mesurer
   la phase de poursuite pure, puis vérifier l'arrêt immobile en portée). Code jeu correct.
2. **Zones dangereuses multi-entités** : le pattern #2/#3/#4 (un booléen par zone) ne
   s'étend pas à des zones qui suivent **joueur + 3 survivants** simultanément. Fix : état
   d'arête **par (zone, entité)** (`Map` `${zone}:${entity}`), `enter`/`exit` uniquement sur
   transition. C'est la **première zone multi-entités** — nouvelle dimension qui justifie
   la candidate `zone(...)` avec support multi-entités.
3. **Joueur mort en phase de combat** : les 2 ennemis blesse le joueur pendant les fenêtres
   de tir (T6–T9) → joueur mort à T9 → `gameOver='died'` bloque `fire`/`interact` → toute la
   suite. Fix : (a) jeu — `coolFirst` (30 ticks) sur la 1re attaque en portée (pattern #3/#4) ;
   (b) harness — reset HP avant la phase de tir (isolation de test).

**Mesure de friction** (lignes de code **hors commentaires/blancs** écrites à la main) :

| Primitive | Fonction | Lignes |
|---|---|---|
| `bodyOf(id)` | recherche du rigid body via `userData` | 4 |
| `faceBody(b, dx, dz)` | orientation (quaternion yaw demi-angle) | 5 |
| `chaseBody(b, target, maxStep)` | déplacement verrouillé (`rt.raycast`) | 17 |
| **MOBILE_ENTITY_FRICTION** | (5 entités mobiles : 3 survivants + 2 ennemis) | **26 LOC/jeu** |
| `inZone(z, pos)` | inclusion AABB (un helper unique) | 2 |
| `tickDangers()` | 2 zones × multi-entités + arêtes enter/exit + dégâts périodiques | ~30 |
| `tickSurvivors()` (évac) + `checkEvacWin()` | zone d'évacuation + condition multiple | ~14 |
| **ZONE_FRICTION** | (3 zones : feu, gaz, évacuation ; multi-entités) | **~46 LOC/jeu** |

**Les 3 frictions réelles (reproduites sur une 3e slice)** :
1. **Fuite de connaissance du core vers le jeu** : `bodyOf` pioche dans `rt.world.bodies` +
   `userData` (comptabilité interne au spawn), `chaseBody` repose sur `rt.raycast` **qui
   exclut la capsule du joueur** (sémantique interne), orientation = quaternion manuel.
   *(La lecture du core a confirmé que `runtime.ts` maintient déjà une `Map bodyById`
   interne non exposée — une `bodyOf` core serait triviale.)*
2. **Zones multi-entités (nouvelle en #5)** : l'état d'arête par (zone, entité) est une
   comptabilité manuelle (`Map` + `dangerTimers`) qu'une primitive `zone(...)` avec support
   multi-entités absorberait.
3. **Duplication** : les 26 LOC d'entité mobile recopiées **telles quelles** de #3/#4 ;
   l'état d'arête de zone + dégâts périodiques écrits à la main.

**Verdict honnête** :
- `moveEntity(id, target, maxStep, { face })` — **3e reproduction** (#3 : 3 mobiles, #4 : 3,
  #5 : 5) → **règle des trois (D002) atteinte**. La promotion au core est **justifiée**.
- `zone(min, max, { entities, onEnter, onExit, tick? })` — **4e occurrence** (#2, #3, #4, #5)
  + **nouvelle dimension multi-entités** (#5) → **règle des trois dépassée**. La promotion au
  core est **justifiée** et doit inclure le multi-entités.
- **Non implémentées en v0.1** — cette slice ne fait que **mesurer** la friction (politique
  de la mission : core intact, mesurer plutôt que modifier prématurément). La décision de
  promotion est maintenant **possible**.

---

## v0.2 — Promotion core `moveEntity` + zones (migration Game #5)

**Objectif** : implémenter les deux candidates promues (seuil D002 atteint sur #5),
migrer Game #5 sur les primitives core **sans changer le comportement** (fingerprint
préservé), laisser Games #1–#4 **intacts**, et officialiser `tools/run_harnesses.mjs`
comme mécanisme unique de bout en bout.

**Ajouts core** (`src/core/types.ts` + `runtime.ts`, `version` → `0.2.0`) :

| API | Forme | Comportement |
|---|---|---|
| `rt.entityPosition(id)` | `Vec3 \| null` | position Rapier via la `Map bodyById` interne (PAS de `bodyOf` publique, aucune fuite Rapier) |
| `rt.moveEntity(id, target, speed, { face?, avoidObstacles? })` | `boolean` | déplacement XZ `speed × FIXED_DT`, clamp à la destination, Y conservé, orientation `face` (défaut `true`) ; refus `false` + `console.error` : player (KCC), static/dynamic, id inconnu |
| `rt.faceEntity(id, target)` | `void` | orientation sans translation |
| `rt.createZone({ id, bounds: { min: [x,z], max: [x,z] }, tags, onStay? })` | `ZoneHandle { id, isInside(eid), destroy() }` | zone AABB XZ **multi-entités**, état possédé par le core |
| `GameLoom.zones()` (publique) | `{ id, x1, x2, z1, z2, inside: string[] }[]` | debug contractuel |
| events `zone.enter` / `zone.exit` | `entity` = entité observée, `other` = id zone, `data = { zone, x, z }` | émis par le core sur arête |

**Divergences de design candidate → implémenté** :
- `moveEntity(id, target, maxStep, { face })` → **`speed` en m/s** (convention 5, cohérent
  avec les jeux) + **`avoidObstacles`** (défaut `false`) = le verrou obstacle legacy #3–#5.
- `zone(min, max, { entities, onEnter, onExit, tick? })` → `createZone` déclaratif +
  **events core** `zone.enter`/`zone.exit` sur le bus (pas de callbacks par zone) +
  **`onStay`** (pas `tick`) : le jeu s'abonne via `rt.on(tag, 'zone.enter', { if, do, fn })`
  comme à tout autre event. `tags` = **UNION** des tags observés (résolution dynamique à
  chaque tick, dédupliquée par id).

**Décisions architecturales figées** (toutes prouvées par `test_v02`, M1–M13 + Z14–Z28) :
1. **Pas de hard-stop supplémentaire** dans `moveEntity` : la **formule legacy du verrou
   obstacle est conservée telle quelle** (port fidèle #3–#5) — raycast depuis 0,9 m devant
   (hauteur +1,0), `limit = toi + 0.9 − 0.5` ; si le point de sonde est DANS l'obstacle
   (toi ≈ 0), le step est plafonné à 0,4 m (l'entité **rampe dans** l'obstacle) — pas de
   stop dur, pas de pathfinding. Observation M12b (100 m/s) : 1er point clampé à 4,0
   (à 0,5 m de l'arête du mur) puis rampe 0,4 m/pas.
2. Zones évaluées **après la passe `onTick` du jeu, avant `rt.tick++`** (positions
   finales du tick).
3. `onStay` **n'est pas appelé au tick d'enter** (Z17 : exactement 5 appels sur 5 ticks
   inside).
4. **Pas de `zone.exit` lors d'un destroy** entité ou zone — purge silencieuse (Z23, Z24).
5. Le raycast obstacle **exclut le joueur ET le body propre** de l'entité (pas de
   TOI = 0 sur soi — M13).
6. `tags` = **UNION** (Z19) + déduplication entité multi-tags (Z20) ; **bornes
   inclusives** (Z26) ; bornes inversées normalisées (Z25).
7. `face: true` et `avoidObstacles: false` **par défaut** (M6–M11) ; clamp à la
   destination puis `false` si déjà sur place (M4) ; Y conservé (M5) ; refus
   statique/dynamique/player signalés par `console.error` (M9/M10).
8. **Pas de `bodyOf` public** : `entityPosition` (position seule) — **aucune fuite Rapier
   dans l'API gameplay** (le jeu ne touche plus de rigid body pour mouvement/zones).
9. `createZone` avec id en double = `console.error` (non bloquant).
10. Entité spawnée **après** `createZone` détectée (enter au 1er tick — Z22) ;
    player observable par un tag (Z21).

**Migration Game #5** (`src/game/outpost/main.ts`) :
- `bodyOf`/`faceBody`/`chaseBody` → `rt.moveEntity` / `rt.faceEntity` /
  `rt.entityPosition` (survivants FOLLOWING + offsets d'évacuation, ennemis CHASE,
  verrou obstacle `avoidObstacles: true` conservé sur la poursuite).
- `inZone`/`tickDangers` + `dangerPrev` par (zone, entité) → **3 × `createZone`**
  (fire, gas, evac — `tags: ['player','survivor']`) + règles core `zone.enter`/
  `zone.exit` (`rt.on('survivor', 'zone.enter', { if: c => c.other === 'fire', ... })`)
  + `onStay` (dégâts périodiques feu).
- Dernier bloc migré = le **hook `dbg.outpostState`** (références mortes `bodyOf`/
  `inZone`/`dangerPrev`) — forme de l'objet **strictement préservée** (le harness en
  dépend) : `dangers[].inside` = `['player', ...survivors].filter(isInside)` car l'ancien
  `dangerPrev` suivait joueur + survivants ; `evac.playerInside`/`survivorInside` et
  `dangers[].playerInside` via `isInside` des `ZoneHandle`.

**Fingerprint avant/après** (test_outpost) : **IDENTIQUE, bit à bit** — le fingerprint
figé du Game #5 v0.1 (cf. section ci-dessus) est reproduit à l'identique après migration :
`e1KillTick:314 · e2KillTick:378 · fireEnterTick:394 · fireExitTick:471 ·
gasEnterTick:394 · hpAfterFire:61 · aFollowedTick:495 · aEvacTick:1045 ·
bFollowedTick:1107 · bEvacTick:1526 · cEvacTick:1249 · gapA16:2.16 · rescueTick:1526 ·
extractedTick:1526 · diedTick:30 · final {won:true, evacCount:3, enemies:0, score:200}`.
Migration = **zéro changement de comportement**.

**Validation** :
- `node tools/run_harnesses.mjs test_v02 --build` : **30/30** (M1–M13 mouvement,
  Z14–Z28 zones).
- Suite complète `node tools/run_harnesses.mjs --build` : **6/6 harnesses** — v02 30/30 ·
  #1 19/19 · #2 14/14 · #3 21/21 · #4 34/34 · #5 32/32. Games #1–#4 : **fichiers intacts,
  zéro régression**.
- **5 runs consécutifs** `test_outpost` (`--repeat 5`) : fingerprint identique à chaque
  run ; ports 4173/9224 libres, aucun processus Vite/Chrome CDP orphelin.

**Observations expérimentales (v0.2)** :
1. **Leak de console inter-harnesses (bug orchestrateur, découvert v0.2)** : les harness
   choisissent le **1er target `page`** du Chrome partagé ; en réutilisant la page du
   harness précédent (`v02_test`, qui émet volontairement les `console.error` de refus
   `moveEntity`), les 3 erreurs ont fui dans le check console T8 de `test_headless`
   (18/19 au 1er run de la suite). Fix : **1 target page frais par harness** (créer le
   nouveau **avant** de fermer l'ancien — `--headless=new` quitte quand le dernier onglet
   ferme). Leçon : l'unité d'isolation d'une assertion console est le **target page**,
   pas l'URL.
2. La **surface debug v0.2** (`v02_test.html` + `_debug.v02`) permet de tester les
   primitives core **sans jeu** : 30 assertions en ~2 s, scènes triviales (1 mur, 1
   entité).
3. `GameLoom.zones()` (debug) + `ZoneHandle.isInside` couvrent l'observabilité test ET
   logique de jeu sans exposer l'état interne (`Set` de `inside`).
4. La convention **`speed × FIXED_DT`** (convention n°5) est reprise telle quelle par la
   primitive core : `moveEntity` reçoit des m/s, jamais un step par appel.
5. Le port du verrou obstacle legacy (décision 1) a rendu la migration transparente :
   aucun ajustement de gameplay n'a été nécessaire pour que le fingerprint tienne.

**Dette (v0.2)** : `onStay` n'est pas un event (API documentée) ; zones **XZ uniquement**
(pas de dimension Y) ; `avoidObstacles` = verrou de step, **pas** d'évitement ; id de
zone en double = avertissement, non bloquant.

---

## Game #6 — Reactor Defense (test black-box v0.2 : 3 relais en ordre libre, 5 ennemis, séquence réacteur interruption/reprise)

**Objectif** : (a) 6e vertical slice jouable ; (b) **test black-box de GameLoom v0.2** :
un agent neuf construit le jeu en ne lisant que `GAMELOOM.md` (EXPERIMENTS/JOURNAL,
`src/core/**`, sources + harnesses des Games #1–5 **interdits**), note
`DOC_GAP` / `CORE_FRICTION` / `GAME_FRICTION` / `BUG` et **ne modifie pas le core**.

**CORE_ACCESS** : **0 lecture core, 0 modification**. Seuls « détecteurs » utilisés :
`tsc --noEmit` (workflow documenté, a révélé les types exacts de `spawnAsset`,
`applyPlayerControl`, `ZoneBounds`, payload d'event) et une sonde runtime éphémère
(shape de l'entité retournée par `spawnAsset`).

**Architecture testée** :
- **Map** : installation extérieure bornée 48×48 m ; réacteur central (asset **nouveau**
  `reactor.glb` : `make_glb.mjs` + `glb collider auto` + `physics set static` + `validate`
  + `doctor` OK) ; 4 piliers `ruins_column` flanquant le réacteur (4 routes diagonales),
  4 crates couvertures ; sol + 4 murs limites = objets du monde sans entité ECS
  (`rt.world` + `rt.scene`, pattern §5).
- **3 relais** (`switch.glb` réutilisé, tag override `relay`) : A(-16,-12) B(16,-12)
  C(0,16) ; interaction proximité 3 m + touche E (ou `gameInteract`), **ordre libre**
  (aucune séquence imposée), activation 1× → event `relay.activated` ; HUD `RELAIS n/3`.
- **5 ennemis** (`guardian.glb` réutilisé, kinematic, `Health.max=100`) : 3 initiaux
  (±9,±9) et (0,-9) + **2 renforts spawnés exactement une fois** au 1er démarrage du
  réacteur ((8,4) et (-8,-4)). Comportement : détection ≤ 13 m →
  `moveEntity(..., 3.2 m/s, { avoidObstacles: true })` → attaque ≤ 2.0 m (8 dégâts,
  cooldown 1 s en temps de jeu). Un seul `onTick` (ordre stable = ordre de spawn).
- **Réacteur** : zone `createZone({ id: 'reactor', bounds: [-4,-4]/[4,4], tags: ['player'] })` ;
  avant 3 relais, l'entrée ne démarre rien ; après 3 relais, `zone.enter` →
  `reactor.start` (1re fois) ou `reactor.resume` (reprise) ; `onStay` = +1 tick
  (180 ticks = 100 %), `zone.exit` → `reactor.interrupt` (**progression conservée,
  pas de reset**) ; `reactor.online` + `game.victory` à 180 (overlay
  `REACTOR ONLINE / MISSION COMPLETE`).
- **Combat** : tir hitscan joueur (œil +1.55, `rt.raycast`, 25 dégâts, sans munitions) ;
  ennemi `health.zero` → `enemy.killed` + destruction ; ennemi → `damage` joueur ;
  `player.died` → `game.over` (overlay `GAME OVER`).
- **Événements de jeu émis** (8) : `relay.activated`, `reactor.start`,
  `reactor.reinforcements`, `reactor.interrupt`, `reactor.resume`, `reactor.online`,
  `game.victory`, `enemy.killed` (+ réutilisation core `player.died`, `game.over`,
  `damage`, `zone.enter`/`zone.exit`).
- **Hooks `_debug`** : `gameFire()`, `gameInteract()`, `reactorState()` (JSON : relays,
  `reactor{ seqTicks, progress, started, online, inZone }`, reinforcements, enemies via
  `entities({ tag: 'guardian' })`, player, victory, playerDead).
- **Visée** : convention calibrée fin de run (cf. DOC_GAP 1) :
  `dir = (−sin(yaw)·cos(pitch), sin(pitch), −cos(yaw)·cos(pitch))` (yaw 0 = −Z,
  pitch > 0 = lever).

**Résultats** : harness **53/53** (les 22 exigences de la mission + sous-checks) —
**5 runs (`--repeat 5`), fingerprint identique** :
```json
{"relays":["C@175","A@176","B@177"],"reactorStartTick":178,"reinforcementsTick":178,
 "interruptProgress":65,"resumeTick":275,"reactorOnlineTick":390,"victoryTick":390,
 "enemiesKilled":3,"playerDamageTaken":16,
 "final":{"relays":3,"progress":180,"victory":true,"playerDead":true,"guardiansAlive":2,
 "playerHealth":0,"playerPos":[2.935,0.92,-2.862]}}
```
**Régressions** (orchestrateur officiel, toutes vertes) : v0.2 30/30 · #1 19/19 ·
#2 14/14 · #3 21/21 · #4 34/34 · #5 32/32 — **Games #1–5 : fichiers intacts,
zéro régression**.

**DOC_GAP (3)** :
1. **Convention de visée** — §5 montre le hitscan avec `lookDir()` sans donner la
   convention yaw/pitch → vecteur. Calibration empirique (`aimAt` + `look`) + validation
   fin de bout en bout (12 tirs / 3 kills) :
   `dir = (−sin(yaw)·cos(pitch), sin(pitch), −cos(yaw)·cos(pitch))`, yaw 0 = −Z.
   → `GAMELOOM.md` §5 complété (une ligne).
2. **Format `health` en debug** — `snapshot().player.health` et `entities()[].health`
   renvoient la chaîne `"current/max"` (ex. `"100/100"`), **pas un nombre** → les
   assertions numériques échouent au premier contact. → `GAMELOOM.md` §13 précisé.
3. **Type retour de `spawnAsset`** — retourne un **objet entité** (`EntityT`, avec
   `id: string`) et non l'id : `→ entité ou null`. L'extraction de `.id` est
   indispensable (les ids circulent partout : bus, `entityPosition`, `byId`).
   → `GAMELOOM.md` §5 précisé.

**CORE_FRICTION** : **AUCUNE**. La surface v0.2 (`moveEntity` / `faceEntity` /
`entityPosition` / `createZone` + events `zone.*` / `rt.bus` / `rt.raycast` / debug API)
couvre tout le besoin sans aucun contournement : pas de `bodyOf`/`userData`, pas d'AABB
manuel, pas de verrou raycast legacy, pas d'état d'arête enter/exit manuel (zones
possédées par le core). **Premier slice construit directement sur v0.2** (#5 était v0.1
+ migration) : les 26 LOC/jeu de « mobile entity » et ~46 LOC/jeu de « zones » mesurées
en #3–#5 ont **disparu**.

**GAME_FRICTION** (complexité propre à ce gameplay, ne doit PAS entrer dans GameLoom) :
1. cooldown d'attaque par ennemi (`lastAttackTime` en temps de jeu `rt.time`) — même
   famille que #3/#4/#5.
2. Chorégraphie du harness : tuer les 3 ennemis initiaux **avant** la séquence finale de
   180 ticks pour que le joueur ne meure pas sous les renforts (+ `setPlayerHealth(100)`
   pour l'isolation de test) — orchestration de test, pas d'API.
3. Preuve d'**ordre libre** : activer C→A→B dans le harness pour démontrer qu'aucune
   séquence A→B→C n'est imposée (design de test, pas d'API).

**Bugs** : **0** (core et jeu). 1er run du harness (45/52) : les 7 échecs étaient tous
côté **harness** (health chaîne vs nombre ; erreur de calcul progression — le `step(5)`
du check T11 s'effectue DANS la zone : 5+60 = 65, pas 60). Le code jeu était correct
dès le 1er run.

**Observations** :
1. **Validation black-box v0.2 = RÉUSSIE** : `GAMELOOM.md` seul + outillage documenté
   (tsc, CLI glb, orchestrateur) suffit pour un jeu jouable et gagnable ; les seules
   découvertes d'API viennent des outils documentés (erreurs tsc, sonde runtime).
2. **0 lecture core / 0 lecture de jeu / 0 lecture de harness** — l'agent #5 avait
   nécessité 1 lecture core post-DOC_GAP : le manuel v0.2 + tsc est strictement moins
   exigeant que le v0.1.
3. **Patterns récurrents (6e occurrence)** : fingerprint de ticks déterministe ;
   0 screenshot nécessaire (JSON-first, D004) ; famille ennemi
   « détecter → `moveEntity` → attaquer à portée » ; hooks `_debug` par jeu ; harness CDP
   dupliqué du pattern avec `URL_TARGET` propre.
4. **Physique du joueur mort** : le corps du joueur mort est déplacé par
   dé-pénétration KCC contre les colliders kinematic des ennemis en poursuite
   (`playerPos` final ≠ position de téléportation) — déterministe et sans effet
   gameplay (victoire déjà acquise) ; à retenir si un futur jeu gère les cadavres.
5. **`onStay` comme progression** : exact et déterministe (+1/tick, jamais au tick
   d'enter) — parfaitement adapté à une séquence de démarrage avec
   interruption/reprise sans reset.
6. **Objet interactif avec état de proximité** (open question « next experiments » #3,
   pattern « clé » du #4) : validé sans friction nouvelle (proximité + E + event 1× +
   hint HUD) — le pattern interact + règle EVENT→ACTION est réutilisable tel quel.
7. **`game.victory` puis mort du joueur après victoire** : la voie `player.died` →
   `game.over` reste disponible post-victoire (check T22) sans contredire la victoire
   déjà acquise (flag `victoryEmitted`).

**Comparaison avec les expériences précédentes** :
- **#5 (même type de test black-box)** : 1 DOC_GAP (liste §5 incomplète, depuis corrigée)
  + 3 bugs de friction + 26 LOC/jeu (entité mobile) + ~46 LOC/jeu (zones multi-entités)
  de contournement. **#6** : **0 LOC de contournement** sur ces deux axes (primitives
  core v0.2), 3 DOC_GAP de **précision documentaire** (convention visée, format health,
  type retour `spawnAsset`), 0 bug de code. **Les promotions v0.2 (D010/D011) ont
  livré** : la friction mesurée sur #3/#4/#5 n'existe plus côté jeu.
- **Déterminisme** : 6e slice consécutive à 100 % (fingerprint identique sur 5 runs,
  Windows, Chrome headless SwiftShader).
- **Processus Windows** (D009/D012) : orchestrateur uniquement, 0 processus orphelin,
  ports 4173/9224 vérifiés libres après chaque run.

**Nouvelles candidates** : **AUCUNE** — aucune friction nouvelle à absorber ; aucune
demande de modification du core issue de ce slice.

---

## Game #7 — Cargo Run (productivité + nouvelle famille mécanique : ramassage / transport / dépôt / alimentation)

**Objectif** : (a) **mesurer le temps d'un agent neuf jusqu'au premier jeu jouable**
(T0 → FIRST_PLAYABLE) ; (b) explorer une **nouvelle famille de mécaniques** — interaction
/ ramassage / transport / dépôt / état d'objets — après que #5/#6 ont suffi à valider
`moveEntity` et `createZone`. Black-box : seul `GAMELOOM.md` lu avant construction
(+ outillage explicitement référencé : `make_glb.mjs`, `vite.config.ts`, `package.json`,
`run_harnesses.mjs`) ; EXPERIMENTS/JOURNAL, sources + harnesses #1–#6, `src/core/**`
**interdits** pendant la construction ; **core inchangé, aucune primitive nouvelle**.

**Mesures de productivité** : T0 = 2026-09-28 10:35:34 · FIRST_PLAYABLE =
**11:06:17** (durée **30 min 43 s**) · validé (harness vert + 5 runs + régressions) =
11:08:26 (durée totale **32 min 52 s**) — le QA complet a coûté **~2 min** au-delà du
premier jouable.

**CORE_ACCESS** : **0 lecture core, 0 lecture de jeu, 0 lecture de harness**. Détecteurs
utilisés : `tsc --noEmit` (workflow §14 — a révélé d'un coup le payload d'event, le
struct complet de `applyPlayerControl`, le type de retour de `spawnAsset`) et le
pipeline documenté `make_glb.mjs` + CLI `glb`.

**Architecture** :
- **Assets nouveaux** (2) : `energy_cell.glb` (0.34×0.56 m, static) + `socket.glb`
  (0.56³ m, static) — `make_glb.mjs` (2 recettes + 4 matériaux) + `glb collider auto` +
  `physics set static` + `validate`/`doctor` OK, 0 avertissement. Réutilisés : `crate`
  (couvertures ×6), `ruins_column` (décor ×3).
- **Map** : dépôt industriel borné 25×17 m (sol + 4 murs + linteau = objets du monde
  sans entité ECS, pattern §5) ; zone de départ, 3 cellules (A(-6.5,3.5) B(2.5,-5.5)
  C(6.5,4.5)), 3 sockets (A(-4,-7) B(0,-7) C(4,-7)), 6 couvertures, porte de sortie
  (collider box 0.5×3.2×4 + mesh) au mur est (x=10.25), zone de sortie derrière
  (x[10.6,13.6] z[-3,3]).
- **Cellules** : `spawnAsset` + tags override `cell`/`cell_a…c` ; machine d'état
  `world → carried → installed` par cellule ; **capacité 1 slot** (`cargo`), portée
  E = 1.6 m (distance XZ sur `entityPosition`).
- **Transport** : la cellule portée est repositionnée à chaque tick dans `onTick`
  (1.0 m derrière le joueur d'après le `yaw` de `playerState`, y=0.35) via
  `bodyOf` (scan `userData`, pattern legacy §5) + `setTranslation` — exact et
  déterministe ; `moveEntity` inadapté (Y à contrôler + attachement précis).
- **Dépôt** : E près du socket le plus proche → matching par clé ; bonne cellule =
  install (position socket top, glow visuel, `socket.powered` + `cargo.install`) ;
  mauvaise = **refus** (`cargo.reject`, état inchangé, message HUD). **Drop libre Q** :
  reposition derrière le joueur clampé par `rt.raycast` (exclut la capsule joueur,
  §8.5) → état `world` → re-ramassable.
- **Porte** : état `doorOpen` **détermine réellement le passage** — fermée = collider
  actif (preuve : le joueur s'arrête à x≈9.53 en avançant vers +X) ; à 3/3,
  `power.complete` → `door.opened` → `removeCollider(true)` + `removeRigidBody`
  (pattern §5) + animation du mesh (présentation, `onTick`).
- **Victoire** : zone `createZone({ id:'exit', tags:['player'] })` — `onStay` ne
  déclenche `game.victory` que si `doorOpen` (preuve négative : téléporté dans la zone
  avec porte fermée → pas de victoire). Overlay `CARGO COMPLETE / EXIT REACHED`.
- **Événements de jeu émis** (8) : `cargo.pickup`, `cargo.reject`, `cargo.drop`,
  `cargo.install`, `socket.powered`, `power.complete`, `door.opened`, `game.victory`
  (+ réutilisation core `spawn`, `zone.enter`).
- **Hooks `_debug`** : `cargoState()` (power, cargo, doorOpen, victory, cells avec
  état+position, sockets), `cargoInteract()`, `cargoDrop()`.
- **HUD** : `POWER: n/3` · `CARGO: NONE|CELL X` · message transitoire (temps de jeu,
  jamais `setTimeout`) · contrôles (E ramasser/installer, Q abandonner).

**Résultats** : harness **44/44** (26 exigences mission + sous-checks, dont les négatifs
: porte fermée bloque physiquement, zone seule ne suffit pas, mauvais socket refuse,
1 seul slot) — **5 runs (`--repeat 5`), fingerprint identique `2f079a9b`** :
```json
{"seq":["cargo.pickup@0","cargo.reject@30","cargo.drop@30","cargo.pickup@30",
 "socket.powered@30","cargo.install@30","cargo.pickup@30","socket.powered@30",
 "cargo.install@30","zone.enter@30","cargo.pickup@65","socket.powered@65",
 "cargo.install@65","power.complete@65","door.opened@65","zone.enter@82",
 "game.victory@83"],
 "final":{"power":3,"cargo":"NONE","doorOpen":true,"victory":true,
 "sockets":{"A":true,"B":true,"C":true},"cells":{"A":"installed","B":"installed","C":"installed"},
 "pos":{"A":[-4,0.56,-7],"B":[0,0.56,-7],"C":[4,0.56,-7]},"player":[11.8,0.92,0]}}
```
**Régressions** (orchestrateur officiel `--build`, toutes vertes) : v0.2 · #1 19/19 ·
#2 14/14 · #3 21/21 · #4 34/34 · #5 32/32 · #6 (reactor) · #7 44/44 — **Games #1–6 :
fichiers intacts, zéro régression**.

**DOC_GAP** : **0** — aucune lecture ciblée n'a été nécessaire ; `GAMELOOM.md` + `tsc`
+ outillage documenté ont suffi pour une **nouvelle famille mécanique** (les 3
DOC_GAP de précision de #6 — convention visée, format health, type `spawnAsset` —
sont corrigés dans le manuel et n'ont pas resurgi). Observations de **précision**
(hors mission DOC_GAP, aucune lecture n'a été rendue nécessaire) : (1) le payload
custom de `bus.emit` passe sous le champ `data` de l'`EventCtx` (§10) — l'exemple §5
`emit('mon.event', id, {...})` ne l'explicite pas, `tsc` l'a fait en 1 passe ;
(2) `EntityT.id` est typé `string | undefined` alors que la runtime garantit une
chaîne (§5 « id = string ») — garde `typeof` ajoutée préventivement.

**CORE_FRICTION** : **AUCUNE**. Aucune mécanique générique n'a dû être reproduite que
le moteur devrait posséder : chaque besoin s'est résolu par une primitive v0.2
(`entityPosition`, `createZone`/`zone.enter`, `rt.raycast`, `bus` custom events) ou par
un pattern **explicitement documenté** dans §5 (objets du monde « sol, murs, **porte** »
+ `removeCollider`/`removeRigidBody` + animation mesh ; `bodyOf`/`setTranslation`
« pattern legacy, toujours valide »). Zéro LOC de contournement, zéro itération sur
les patterns.

**GAME_FRICTION** (mesure par famille, lignes hors commentaires ; complexité propre à
Cargo Run, ne doit PAS entrer dans GameLoom) :

| Famille | État manuel | Connaissances GameLoom requises | Duplication | Workaround | LOC approx. |
|---|---|---|---|---|---|
| **PICKUP** (portée E, 1 slot) | `phase`, `cargo` | `entityPosition`, `playerState`, `bus.emit(data)` | 0 | aucun | ~22 |
| **DROP** (libre Q, re-ramassable) | `phase`, `cargo=null` | `rt.raycast` (excl. capsule), `yaw` via `playerState` (conv. 3) | 0 | aucun | ~15 |
| **CARRIED_OBJECT** (suivi/tick) | `phase=carried` | `bodyOf` scan `userData` (§5 legacy) + `setTranslation` | `bodyOf` 4e occurrence (#3/#4/#5/#7) | `moveEntity` inadapté (Y + attachement) | ~14 |
| **SOCKET** (matching 3×3, refus) | `powered`, `phase=installed` | tags override, `bus.emit`, présentation DOM/mesh | 0 | aucun | ~30 |
| **DOOR** (blocage réel → ouverture) | `doorOpen` + refs Rapier/mesh | §5 objets du monde + `removeCollider(true)` | 3e porte (#2/#4/#7) mais recette documentée, 0 itération | aucun | ~25 (+helper partagé) |

**Bugs** : **0** (core et jeu). 1 bug **côté outillage de l'agent** (harness, non
livré tel quel) : la boucle d'attente de boot comparait le booléen
`typeof window.GameLoom === "object"` à la chaîne `'object'` → 2 faux « FAIL boot »
(~5 min) avant correction à `typeof window.GameLoom === 'object'`. 1 autre temps perdu
agent (~3 min) : lecture initiale de `boxGeometry(hx,hy,hz)` de `make_glb.mjs` comme
dimensions totales alors que l'en-tête du tool documente « Demi-dimensions » — assets
régénérés.

**Observations** :
1. **Nouvelle famille mécanique = zéro friction core** : ramassage/transport/dépôt/
   alimentation/porte saturent la surface v0.2 + patterns documentés sans aucune
   découverte d'API bloquante — le manuel est suffisant pour une famille **nouvelle**,
   pas seulement une recomposition de mécaniques connues (contrairement au profil #6
   qui retestait des primitives récentes).
2. **Événements custom + `data`** comme véhicule de l'état de gameplay (8 events,
   payload `{ cell, socket, power }`) — la frontière EVENT→ACTION se compose avec les
   hooks `_debug` et le harness sans extension du core.
3. **Condition de victoire composée** (`doorOpen` ∧ `onStay(exit)`) : idem #6
   (3 relais ∧ entrée réacteur) — la garde de condition multiple reste côté jeu, la
   zone côté core.
4. **Déterminisme : 7e slice consécutive à 100 %** (fingerprint identique sur 5 runs,
   Windows, Chrome headless SwiftShader) ; le déplacement KCC du joueur pendant le
   passage porte (5.6 m/s × ticks) n'introduit aucune dérive.
5. **Discipline agent** : les 2 temps perdus (predicate de boot, demi-dimensions GLB)
   sont des erreurs de lecture d'agent, pas des gaps du manuel — vérifier le prédicat
   d'attente avant de lancer une attente de 90 s, et relire l'en-tête d'un tool avant
   d'en inférer l'API.
6. **Dérive baseline (à noter, non causée par #7)** : le baseline contient un 6e jeu
   `reactor` (html + harness + asset + script npm) non documenté dans `GAMELOOM.md`
   (structure §3, assets §3, orchestrator §15 citent 5 jeux + v02_test et 11 GLB) ;
   l'orchestrateur officiel liste 6 harnesses sans `test_reactor` — celui-ci est lancé
   explicitement pour rester vert.

**Comparaison historique** :
- **#5 (black-box v0.1)** : 1 DOC_GAP + 3 bugs de friction + 26 LOC/jeu (entité
  mobile) + ~46 LOC/jeu (zones).
- **#6 (black-box v0.2)** : 3 DOC_GAP de précision, 0 CORE_FRICTION, 0 bug, 0 LOC de
  contournement — les promotions v0.2 ont livré.
- **#7 (black-box v0.2, famille mécanique nouvelle)** : **0 DOC_GAP, 0 CORE_FRICTION,
  0 bug, 0 LOC de contournement** ; 100 % du gameplay est composé de primitives v0.2 +
  patterns documentés. La courbe de friction est plate : le coût marginal d'une famille
  de mécaniques **nouvelle** est désormais le coût du gameplay lui-même (~110 LOC de
  règles : slots, matching, état d'objets), pas l'adaptation au moteur.

**Nouvelles candidates** : **AUCUNE proposée** (D002). Considérées et **rejetées** :
(1) `setEntityPosition(id, pos)` / attachement « carried object » — 1 occurrence,
couvert par le pattern legacy documenté (`bodyOf` + `setTranslation`), et D010
interdit la fuite Rapier dans l'API gameplay ; (2) primitif « porte » — 3e occurrence
(#2/#4/#7) mais **zéro friction mesurée** et recette explicite dans §5 : promouvoir
sans friction mesurée violerait D002.

---

## Cross-game observations

Synthèse des 7 slices :

- **Core stable #1→#5, première extension en v0.2** : le core (7 fichiers, ~890 LOC) a
  été **créé sur le jeu #1 et n'a pas été modifié pour les jeux #2, #3, #4 et #5**
  (CORE_ACCESS_REQUIRED = 0 sur #4 ; #5 = **1 lecture post-DOC_GAP, 0 modification**).
  **v0.2** a ensuite étendu le core **seulement** avec les 2 primitives promues par
  D002 (`moveEntity`/`faceEntity`/`entityPosition` + zones/`createZone` +
  `zone.enter`/`zone.exit` + `GameLoom.zones()`, `version` 0.2.0) — cf. § v0.2. Tous les
  jeux n'utilisent que la surface publique (+ `rt.world`/`rt.scene`/`rt.bus` pour les
  objets du monde).
- **Déterminisme 100 % sur les 7 jeux** : timestep fixe + scènes contrôlées + pas de
  `Math.random` non seedé. Répartition des runs : #1 = 8 (Linux) + 3 (Windows) ;
  #2 = 3 (Windows) ; #3 = 5 (Windows) ; #4 = 5 (Windows) ; **#5 = 5 (Windows)** ;
  #6 = 5 (Windows) ; **#7 = 5 (Windows)** — tous avec fingerprint de ticks identique
  quand le harness en produit un (#3, #4, #5, #6, #7).
- **JSON-first** : sur les 4 jeux, **0 bug** a nécessité un screenshot pour être trouvé
  ou prouvé (la géométrie se lit dans `snapshot()`, ex. « le joueur s'arrête à
  x≈-13.5 »). La vision est réservée à la validation visuelle finale (1 screenshot/jeu).
- **Patterns récurrents (candidats au statut « convention »)** :
  1. objet du monde possédé par le jeu (porte #2, grille #3, porte + sortie #4) ;
  2. entité mobile kinematic (gardien #3, gardien + mage + projectiles #4) ;
  3. événements de jeu émis par le bus sans extension du core (4 + 6 + 10) ;
  4. hooks `_debug` par jeu (1 + 2 + 2 + 4) ;
  5. harness CDP dupliqué du pattern, `URL_TARGET` propre au jeu.
- **Frictions récurrentes** : fuite de connaissance du core vers le jeu (`userData`,
  exclusion du joueur dans le raycast, quaternion) ; duplication du test AABB ; états
  d'entrée/sortie manuels.
- **Processus Windows persistants** (Chrome CDP 9224, Vite preview 4173) : lancés en
  **détaché** (stdio vers fichiers log, flags de détachement, PID conservé, `taskkill /F /T`
  pour l'arrêt, vérification du service par HTTP/port) — jamais de launch avec handles
  hérités. **Découverte #5 (bug OpenCode #32504)** : même avec un détachement correct
  (`DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`, stdio → fichiers, sans shell intermédiaire
  — `npm.cmd`/`shell:true` **et** `node.exe` direct reproduisent le blocage), le tool call
  qui lance un serveur persistant peut laisser **la boucle d'outils OpenCode bloquée** après
  le retour. C'est un bug d'OpenCode, pas une fuite de handle au lancement. **Workaround
  fiable (devenu la procédure)** : un **orchestrateur à cycle de vie complet**
  (`tools/run_harnesses.mjs`) — une commande qui démarre vite preview + Chrome headless
  (détachés, stdio → logs), attend le ready (polling court), exécute le(s) harness, tue
  l'arbre par PID, vérifie les ports libres et sort. **Aucun processus persistant ne survit
  au tool call.**
- **Régressions** : chaque slice a relancé les harness des slices précédentes (restés
  verts) : #4 a validé #1 (19/19) + #2 (14/14) + #3 (21/21) ; #5 a validé #1 + #2 + #3 + #4
  (19/19, 14/14, 21/21, 34/34) avant de figer ; #7 a validé v0.2 + #1–#5 + #6 (reactor)
  + #7 (44/44) via l'orchestrateur officiel `--build`.

---

## Candidate abstractions → promotions v0.2

> Les deux candidates v0.1 ont été **promues au core en v0.2** — preuves ci-dessous,
> implémentation + validation + divergences de design : § v0.2. Aucune autre candidate
> en cours. La règle D002 (règle des trois) s'est appliquée **à l'arrivée** : aucune
> promotion n'a été faite avant le seuil, aucune n'a été retardée après.

### `moveEntity(id, target, speed, { face, avoidObstacles })` — PROMUE (v0.2)
- **Preuve (3 reproductions — seuil D002 atteint sur #5)** : #3 (1 entité mobile),
  #4 (2 mobiles + 1 projectile, 35 LOC/jeu), #5 (5 mobiles : 3 survivants + 2 ennemis,
  26 LOC/jeu) — `bodyOf`/`faceBody`/`chaseBody` recopiées telles quelles, avec la fuite
  de connaissance du core (`userData`, exclusion du joueur dans le raycast, quaternion
  manuel).
- **Promotion** : `rt.moveEntity` + `rt.faceEntity` + `rt.entityPosition` (le core
  maintient déjà la `Map bodyById` — `bodyOf` core n'a jamais été exposée, `entityPosition`
  seulement). Divergence validée : `maxStep` candidate → **`speed` en m/s** (convention 5).

### `zone(min, max, { entities, onEnter, onExit, tick? })` — PROMUE (v0.2) sous forme
`createZone` + events `zone.enter`/`zone.exit` + `onStay`
- **Preuve (4 occurrences — seuil D002 dépassé)** : #2 (sortie), #3 (extraction),
  #4 (piège + sortie + activation = 5 zones, 31 LOC/jeu, AABB écrit 3×), #5 (feu + gaz +
  évacuation = 3 zones, ~46 LOC/jeu, **première zone multi-entités** — état d'arête par
  (zone, entité) manuelle).
- **Promotion** : `rt.createZone` (AABB XZ multi-entités, `tags` = UNION, bornes
  inclusives) + **events core** sur le bus (au lieu de callbacks par zone — la frontière
  event→action est conservée) + `onStay` (au lieu de `tick`). Multi-entités inclus (preuve
  #5). Le comportement spécifique (dégâts périodiques, victoire à condition multiple)
  reste côté jeu, comme prévu par la candidate.

---

## Technical debt

**Moteur** (observé sur la slice #1, toujours d'actualité sauf mention) :
- `_debug` = API non stable (helpers de test) : à formaliser (contrat) ou retirer.
- `Health.deadTick` : ajout utilitaire pour le `doctor()`.
- L'explosion blesse le joueur (kinematic) — choix de slice, pas un comportement
  générique documenté.
- Chunk Rapier ~5 MB (l'import dynamique ne réduit pas le bundle : déjà statique dans le
  core).
- Pas d'animation / root-motion (aucun asset animé utilisé).
- Pas de save/load.
- `@gltf-transform/core` déclaré en dépendance mais **jamais importé** dans le code livré
  (le CLI `glb` a son propre re-encodeur GLB).

**Outillage / workflow** :
- Copie des GLB dans `dist/assets/` après build (Vite ne copie pas `assets/`) —
  **automatisée par `run_harnesses.mjs --build`** ; un build manuel reste à copier
  (`cp assets/*.glb dist/assets/`).
- `npm run dev` (HMR) = double-boot GameLoom → tests uniquement sur le build production.
- Les chemins dans les harness doivent rester **relatifs au repo** (un chemin absolu
  d'OS avait crashé le harness sous Windows malgré 18/19 checks passés).
- La doc portait l'historique et l'opérationnel dans un seul fichier → **dette
  documentaire réglée par cette restructuration** (GAMELOOM.md / EXPERIMENTS.md).

---

## Decisions

### D001 — Core figé entre les slices
Status: en vigueur.
Evidence: le core (~890 LOC, 7 fichiers) n'a pas été modifié entre #2, #3 et #4
(CORE_ACCESS_REQUIRED = 0 sur #4).
Decision: les jeux n'utilisent que la surface publique + `rt.world`/`rt.scene`/`rt.bus` ;
toute extension du core est une décision explicite et documentée.
Reason: stabilité, régressions vertes, surface d'API petite et compréhensible.

### D002 — Pas d'abstraction prématurée (règle des trois)
Status: en vigueur.
Evidence: pattern « entité mobile » sur #3, friction mesurée (35/31 LOC) sur #4,
2 des 4 slices concernés.
Decision: les primitives `moveEntity`/`zone` restent des **candidates** (ci-dessus) ;
elles n'entrent dans le core qu'après reproduction de la friction sur une 3e slice (ou
décision explicite argumentée).
Reason: éviter de geler une API de mouvement/zone sur 2 observations.

### D003 — Temps déterministe = ticks, jamais délais réels
Status: en vigueur.
Evidence: les 4 harness pilotent `pause()`/`step(n)` ; `sleep()` réservé au boot.
Decision: tout gameplay temporel (cooldowns, delays) en temps de jeu (`rt.time`) ; les
tests avancent par ticks.
Reason: la physique Rapier est déterministe uniquement si les ticks sont pilotés.

### D004 — Debug JSON-first, vision en dernier recours
Status: en vigueur.
Evidence: 10+ bugs (#1) et tous les bugs (#3, #4) trouvés/prouvés en JSON/CDP ; 0 bug
nécessitant un screenshot sur les 4 slices.
Decision: escalade de debug structurée (tsc → build → harness → console → stats →
entities → inspect → events → doctor → step → screenshot).
Reason: l'observabilité JSON est exhaustive pour la logique ; la vision est lente et
faible résolution.

### D005 — GLB = capacités uniquement ; contexte = tags override ; origine à la base
Status: en vigueur.
Evidence: la frontière GLB/TS validée sur les 4 jeux ; le contexte de scène (slots
d'interrupteurs #2) porté par `tags` ; assets Z-up→Y-up (`export_yup=true`), base à y=0.
Decision: le GLB déclare capacités/capacités statiques (collider, physique,
`Health.max`…), jamais de comportement event→action ; le spawn se fait à `y = 0`.
Reason: préfab portable + comportement lisible en TypeScript.

### D006 — `structuredClone` des composants par spawn (anti-aliasing)
Status: en vigueur.
Evidence: bug #11 de la slice #1 (instances partageant un objet Health/Explosive).
Decision: chaque spawn obtient une copie profonde des plain objects JSON du GLB.
Reason: indépendance d'état par instance (règle d'architecture).

### D007 — Tester sur le build production, jamais sur le dev server
Status: en vigueur.
Evidence: HMR double-boot (#1) → 2 runtimes en parallèle.
Decision: `npm run build` + `npm run preview` (4173) pour les tests.
Reason: cohérence d'état et représentativité du bundle réel.

### D008 — Séparation documentaire GAMELOOM.md (présent) / EXPERIMENTS.md (passé + futur)
Status: en vigueur (cette restructuration, 2026-09-27).
Evidence: GAMELOOM.md mélangait opérationnel et expérimentation (1095 lignes) après 4
slices ; un agent neuf n'a besoin que de l'opérationnel.
Decision: `GAMELOOM.md` = manuel opérationnel autonome (≤ ~450 lignes) ;
`EXPERIMENTS.md` = mémoire d'ingénierie ; `JOURNAL.md` = archive brute du bootstrap.
Reason: compacité pour les agents, préservation de la mémoire d'ingénierie, règle
anti-gonflement.

### D009 — Processus persistants Windows : cycle de vie complet, aucun survivant au tool call
Status: en vigueur (règle machine, tous projets Windows). **Amendé sur #5.**
Evidence: les harness nécessitent Chrome CDP (9224) + Vite preview (4173) qui survivent
aux appels d'outils. **Découverte #5 (bug OpenCode #32504)** : même un lancement
détaché parfaitement propre (flags de détachement, stdio → fichiers, sans shell) peut
laisser la boucle d'outils OpenCode bloquée après le retour — bug d'OpenCode, pas de
fuite de handle au lancement. `npm.cmd`/`shell:true` et `node.exe` direct reproduisent
tous deux le problème.
Decision: **privilégier l'orchestrateur à cycle de vie complet** (`tools/run_harnesses.mjs`) :
une commande démarre les serveurs (détachés, stdio → logs), attend le ready (polling
court), exécute le(s) harness, tue l'arbre par PID, vérifie les ports libres et sort —
**aucun processus persistant ne survit au tool call**. À défaut d'orchestrateur :
lancement détaché (`DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`, stdio → fichiers log,
PID conservé, arrêt explicite par PID + vérification du port) — mais ce mode est
susceptible de bloquer la boucle d'outils (bug #32504).
Reason: un processus avec handles hérités bloque la boucle d'outils ; et, plus
fondamentalement, sous OpenCode/Windows même un détachement correct peut bloquer la
boucle → la seule approche fiable est que le tool call possède tout le cycle de vie.

### D010 — Promotion `moveEntity`/`faceEntity`/`entityPosition` au core (v0.2)
Status: en vigueur (v0.2).
Evidence: 3 reproductions de la friction entité mobile (#3, #4, #5 — cf. § v0.2 et
Candidate abstractions) ; seuil D002 atteint.
Decision: primitives core déterministes (`speed × FIXED_DT`, clamp, refus non-kinematic
et player) ; **pas de hard-stop supplémentaire** — la formule legacy du verrou obstacle
(#3–#5) est portée telle quelle sous `avoidObstacles: false` par défaut ; **pas de
`bodyOf` public** (position seule via `entityPosition`), aucune fuite Rapier dans l'API
gameplay.
Reason: friction mesurée sur 3 slices + fuite de connaissance du core encapsulée sans
changer le comportement prouvé des jeux existants.

### D011 — Promotion des zones au core (v0.2) : `createZone` + events `zone.enter`/`zone.exit`
Status: en vigueur (v0.2).
Evidence: 4 occurrences (#2–#5) dont la 1re zone **multi-entités** (#5) ; seuil D002
dépassé.
Decision: zones AABB XZ multi-entités, `tags` = **UNION**, bornes **inclusives**, état
inside/outside **possédé par le core**, évalué **après `onTick` jeu, avant `tick++`** ;
`zone.enter`/`zone.exit` = **events bus** (pas de callbacks par zone — conservation de la
frontière event→action) ; `onStay` non appelé au tick d'enter ; **pas de `zone.exit`
synthétique** sur destroy (purge silencieuse).
Reason: la dimension multi-entités rend le booléen par zone insuffisant ; les events bus
composent avec les règles déclaratives (`rt.on`) déjà validées sur les 5 jeux.

### D012 — Orchestrateur `run_harnesses.mjs` = mécanisme officiel unique + 1 target page frais par harness
Status: en vigueur (v0.2). **Amendé (audit infra de test, 2026-09-28).**
Evidence: bug OpenCode #32504 (D009) + **leak console inter-harnesses** découvert v0.2 :
les harnesses partagent le Chrome CDP et choisissent le 1er target `page` — réutiliser
la page du harness précédent a fait fuiter les `console.error` volontaires de `test_v02`
dans le check T8 de `test_headless` (18/19).
Decision: `node tools/run_harnesses.mjs` (= `npm test`) est la procédure officielle de
tests (build → preview 4173 → Chrome 9224 → harnesses → teardown + ports vérifiés) ;
**chaque harness reçoit un target page neuf** (créé avant de fermer l'ancien).
**Amendement** : la suite officielle = **8 harnesses** (`test_v02` + #1–#7 — liste explicite
dans l'orchestrateur ; `test_reactor`/`test_cargo` en étaient absents, gap documenté §#7) ;
l'orchestrateur transmet l'**identité** de la target fraîche via `CDP_TARGET_WS` (les
harnesses ne choisissent plus le 1er target de la liste, plus de fallback `list[0]`,
invariant « exactement 1 page » vérifié après création) ; teardown **portable** (win32 :
`taskkill /F /T` · POSIX : SIGKILL du groupe de processus) + **SIGINT/SIGTERM** → plus
d'orphelins sur Ctrl+C ; **port occupé au démarrage = refus net (exit 2)** au lieu de
tuer l'écouteur inconnu — l'orchestrateur ne manipule que les processus qu'il a créés.
Reason: cycle de vie garanti par le tool call + isolation stricte des assertions console
par target + sécurité des processus extérieurs + portabilité sans dépendance.

---

## Open questions

- **`_debug`** : formaliser en API de test contractuelle ou le retirer ? (Utilité
  prouvée sur les 6 harnesses ; statut actuel : non stable.)
- **Polish KCC** : slide en pente, accélération/décélération — si un jeu futur en a
  besoin (les 5 slices : non requis).
- **Animation / root-motion** : quand le 1er asset animé est réellement nécessaire
  (aucun à ce jour).
- **Déterminisme cross-machine** : un même fingerprint entre Linux et Windows
  (aujourd'hui validé par machine, pas entre machines).
- **Zones 3D (dimension Y)** / `onStay` comme event : seulement si un jeu réel les exige
  (dette v0.2 documentée).

**Résolues par v0.2** : `moveEntity`/`zone` (promues, D010/D011) ; orchestrateur standard
(officialisé + target frais, D012) ; recherche d'entité par id (`entityPosition`, pas de
`bodyOf` exposée — D010) ; copie GLB au build (automatisée par `run_harnesses.mjs --build`).

---

## Next experiments

Ce que les **prochaines expériences** devraient mettre sous pression :

1. **10+ entités mobiles** : performance (coût WASM Rapier, sync mesh, raycast
   verrouillage) — les 5 slices n'ont jamais dépassé 5 entités mobiles.
2. **Asset animé** (root motion) : valider l'absence actuelle et le coût d'ajout
   (`AnimationMixer` côté core ou côté jeu ?).
3. **Objet interactif avec état de proximité** (pattern « clé » du #4) : vérifier si le
   pattern interact + règle EVENT→ACTION est réutilisable sans friction nouvelle.
4. **Spawn d'entités par le jeu** (hors `spawnAsset` standard) : valider la voie
   `rt.world` + entité ECS manuelle si un jeu doit créer des entités à la volée.
5. **Déterminisme cross-machine** : un même fingerprint entre Linux et Windows
   (aujourd'hui validé par machine, pas entre machines).
6. **Zones sous pression** : zones sur plusieurs tags avec entrées/sorties simultanées
   (joueur + 5+ entités mobiles dans 3+ zones) — vérifier le coût de la résolution
   dynamique des tags par tick.
