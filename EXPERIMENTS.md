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

Méthode de travail validée sur les 4 slices :

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

## Cross-game observations

Synthèse des 4 slices :

- **Core stable** : le core (7 fichiers, ~890 LOC) a été **créé sur le jeu #1 et n'a pas
  été modifié pour les jeux #2, #3 et #4** (CORE_ACCESS_REQUIRED = 0 sur #4). Tous les
  jeux n'utilisent que la surface publique + `rt.world` / `rt.scene` / `rt.bus`.
- **Déterminisme 100 % sur les 4 jeux** : timestep fixe + scènes contrôlées + pas de
  `Math.random` non seedé. Répartition des runs : #1 = 8 (Linux) + 3 (Windows) ;
  #2 = 3 (Windows) ; #3 = 5 (Windows) ; #4 = 5 (Windows) — tous avec fingerprint de
  ticks identique quand le harness en produit un (#3, #4).
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
  **détaché** (Python `subprocess.Popen` avec `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`,
  stdio vers fichiers log), PID conservé pour l'arrêt explicatif (`taskkill /F /T`),
  vérification du service par HTTP/port — jamais de launch avec handles hérités.
- **Régressions** : chaque slice a relancé les harness des slices précédentes (restés
  verts) : #4 a validé #1 (19/19) + #2 (14/14) + #3 (21/21) avant de figer.

---

## Candidate abstractions

> **Ces primitives N'EXISTENT PAS dans le code.** Elles sont des **candidates** issues de
> mesures. Tant qu'elles ne sont pas implémentées + validées + documentées, elles ne
> doivent **jamais** être présentées comme API GameLoom (`GAMELOOM.md` ne les mentionne
> que pour dire qu'elles n'existent pas).

### `moveEntity(id, target, maxStep, { face })`
- **Problème observé** : déplacer une entité kinematic sans traverser les murs ni le
  joueur demande la recherche du body (`userData`), un quaternion manuel, un raycast
  verrou avec la sémantique « exclut le joueur » et un `setTranslation` clampé.
- **Jeux concernés** : #3 (1 entité mobile), #4 (2 entités mobiles + 1 projectile) —
  2 des 4 slices.
- **Duplication** : 35 LOC/jeu (`bodyOf`/`faceBody`/`moveBody`/`chaseBody`) recopiées.
- **Bénéfice attendu** : encapsuler la recherche du body, l'orientation, le verrou
  raycast et le pas clampé ; la sémantique « exclure le joueur » et
  « kinematic = obstacle KCC » devient du savoir du core.
- **Risques** : contrat de mouvement à designer (verrou, face, maxStep) ; l'API doit
  rester déterministe (pas de `setLinearVelocity` implicite).
- **Statut actuel** : **candidate, non implémentée**. Ré-évaluer si une 3e slice
  nécessite ≥ 2 entités mobiles (règle des trois).

### `zone(min, max, { onEnter, onExit, tick? })`
- **Problème observé** : une zone spatiale (piège, sortie, activation) = test d'inclusion
  AABB recopié + états d'arête (entrée/sortie) maintenus à la main + comportement
  périodique.
- **Jeux concernés** : #2 (sortie), #3 (extraction), #4 (piège + sortie + activation =
  5 zones au total).
- **Duplication** : 31 LOC/jeu, AABB écrite 3× sur #4.
- **Bénéfice attendu** : fournir l'inclusion AABB + les arêtes enter/exit ; le
  comportement spécifique (dégâts périodiques, victoire à condition multiple) reste côté
  jeu (frontière normale).
- **Risques** : faibles (géométrie pure + arêtes) ; éviter de transformer l'API en
  « trigger system » complet.
- **Statut actuel** : **candidate, non implémentée**. Priorité basse.

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
- Copie manuelle des GLB dans `dist/assets/` après build (Vite ne copie pas `assets/`) —
  à automatiser éventuellement (plugin/étape de build).
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

### D009 — Processus persistants Windows : lancement détaché + PID + log
Status: en vigueur (règle machine, tous projets Windows).
Evidence: les harness nécessitent Chrome CDP (9224) + Vite preview (4173) qui survivent
aux appels d'outils.
Decision: `Popen` détaché (`DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`), stdio vers
fichiers log, PID conservé, arrêt explicite par PID + vérification du port.
Reason: un processus avec handles hérités bloque la boucle d'outils jusqu'au timeout.

---

## Open questions

- **`moveEntity` / `zone`** : re-tester sur le jeu #5 si une slice future contient ≥ 2
  entités mobiles ou ≥ 3 zones ; une 3e reproduction de la friction déclenche la décision
  (D002).
- **Recherche d'entité** : le jeu fait un scan O(n) de `rt.world.bodies` à chaque tick
  (`bodyOf`). Faut-il une API core « body par id » ? (Friction faible mais récurrente.)
- **`_debug`** : formaliser en API de test contractuelle ou le retirer ? (Utilité
  prouvée sur les 4 harness ; statut actuel : non stable.)
- **Polish KCC** : slide en pente, accélération/décélération — si un jeu futur en a
  besoin (les 4 slices : non requis).
- **Animation / root-motion** : quand le 1er asset animé est réellement nécessaire
  (aucun à ce jour).
- **Copie GLB automatisée** au build (plugin Vite ou étape npm) pour supprimer le piège
  de la copie manuelle.

---

## Next experiments

Ce que le **jeu #5** (ou les prochaines expériences) devrait mettre sous pression :

1. **`moveEntity`/`zone` sous pression** (si le design le justifie) : ≥ 2 ennemis
   mobiles + ≥ 3 zones → mesurer si la friction se reproduit (3e occurrence = décision
   D002).
2. **Asset animé** (root motion) : valider l'absence actuelle et le coût d'ajout
   (`AnimationMixer` côté core ou côté jeu ?).
3. **10+ entités mobiles** : performance (coût WASM Rapier, sync mesh, raycast
   verrouillage) — les 4 slices n'ont jamais dépassé 3 entités mobiles.
4. **Objet interactif avec état de proximité** (pattern « clé » du #4) : vérifier si le
   pattern interact + règle EVENT→ACTION est réutilisable sans friction nouvelle.
5. **Spawn d'entités par le jeu** (hors `spawnAsset` standard) : valider la voie
   `rt.world` + entité ECS manuelle si un jeu doit créer des entités à la volée.
6. **Déterminisme cross-machine** : un même fingerprint entre Linux et Windows
   (aujourd'hui validé par machine, pas entre machines).
