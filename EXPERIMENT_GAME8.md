# EXPERIMENT_GAME8 — Crystal Siege (black-box, GAMELOOM.md seul)

Mission : créer Game #8 (FPS arène : défense d'un cristal) en s'appuyant **uniquement**
sur GAMELOOM.md. Journal de frictions (évaluation du manuel). Aucun code de jeu existant
lu comme référence (seules exceptions documentées : `dungeon.html` comme gabarit de shell,
explicitement demandé par §5 ; `tools/test_headless.mjs` comme harness de référence,
explicitement désigné par §15 ; lecture ciblée de `src/core` pour vérifier des contrats,
autorisée par la mission).

État des assets (découverte `npm run glb -- inspect`, §3/§7) :
- Cristal : `assets/artifact.glb` (static, box 0.7×1.125×0.7, pas de Health → HP géré par le jeu).
- Ennemis : `assets/guardian.glb` (kinematic, `Health.max = 100` — pattern « entité mobile possédée par le jeu »).

## FRICTION 1

Contexte:
poser l'arène (sol + murs physiques) pour le jeu.

Question/problème:
le sol est-il fourni par le core ? Le minimal example (§5) ne crée aucun sol, et
« Le core fournit : joueur, physique, … » laissait supposer un monde complet.

GAMELOOM.md:
§5 « Objets du monde possédés par le jeu (sol, murs, porte — sans entité ECS) » documente
bien que le sol/murs sont à créer par le jeu (`RAPIER.ColliderDesc` + body fixed + mesh
`rt.scene.add`), mais le minimal example (extrait « réel » de `src/game/main.ts`) ne montre
pas cette partie, et la liste « Le core fournit » est lisible comme « tout le monde physique
est prêt ».

Action:
vérification ciblée de `src/core/runtime.ts` (contrat) : création du joueur à
`(0, 2, 0)`, aucune création de sol/plane dans le core → le jeu DOIT créer sol + murs.

Recours externe au manuel:
`src/core/runtime.ts` (grep « ground/floor/plane » + lecture zone de boot) — vérification
de contrat autorisée par la mission.

Résolution:
le jeu crée sol + 4 murs via `world.createRigidBody(RigidBodyDesc.fixed())` +
`ColliderDesc.cuboid` + meshes Three.js ajoutés à `rt.scene`.

Impact:
- MINOR

Cause probable:
- documentation ambiguë (le minimal example est incomplet ; « Le core fournit : … physique »
  est lisible de deux façons)

Suggestion documentaire:
ajouter au minimal example (§5) les 2-3 lignes de création d'un sol, OU préciser dans
« Le core fournit » : « joueur, physique (moteur), temps… — PAS de sol/parois : le jeu les
crée (§5) ».

## FRICTION 2

Contexte:
le cristal est à l'origine `[0,0,0]` ; le joueur doit pouvoir se positionner ailleurs.

Question/problème:
à quelle position le core spawn-il le joueur ? Est-il possible de la changer proprement ?

GAMELOOM.md:
rien ne documente la position initiale du joueur ni de `teleportPlayer` en dehors de
`_debug` (non stable). §8 donne les constantes du joueur mais pas son spawn.

Action:
vérification ciblée `src/core/runtime.ts` (contrat) : `playerBody.setTranslation({x:0,y:2,z:0})`
au boot, position non configurable par `createRuntime`. Seule voie documentée :
`GameLoom._debug.teleportPlayer(x, y, z)` (API non stable, pattern aussi utilisé par les
harnesses officiels).

Recours externe au manuel:
`src/core/runtime.ts` (contrat spawn joueur).

Résolution:
au boot, `window.GameLoom._debug.teleportPlayer(0, 0.92, 12)` AVANT le premier tick.

Impact:
- MINOR

Cause probable:
- information manquante (position initiale du joueur non documentée) + API peu intuitive
  (changer la position d'un objet « fourni par le core » passe par l'API de dev `_debug`)

Suggestion documentaire:
documenter la position initiale du joueur (0,2,0) et indiquer que `_debug.teleportPlayer`
est la voie de déplacement initiale (y≈0.92 = repos au sol).

## FRICTION 3

Contexte:
intégrer le harness du nouveau jeu dans « la suite officielle ».

Question/problème:
§5 dit « (3) optionnel : test:<nom> » ; rien ne dit qu'il faut le déclarer dans la liste
OFFICIAL de `run_harnesses.mjs` pour qu'il fasse partie de la suite officielle. Le checker
(`check:consistency`) exige l'alignement OFFICIAL ↔ fichier ↔ script npm, ce qui implique
l'édition de `run_harnesses.mjs` + `package.json`, mais la procédure n'est pas énoncée.

GAMELOOM.md:
§3/§15 : la liste OFFICIAL vit dans `run_harnesses.mjs` ; §5 : « dupliquer un harness,
changer URL_TARGET + checks ». La suite « officielle » = la liste OFFICIAL, donc ajouter
son harness y est la seule façon d'être testé par `npm test` — mais ce n'est jamais dit
explicitement pour un nouveau jeu.

Action:
lecture de `tools/check_consistency.mjs` + `tools/run_harnesses.mjs` (outillage, pas du code
jeu) pour comprendre le contrat d'enregistrement (OFFICIAL + script npm `test:<nom>`).

Recours externe au manuel:
`tools/check_consistency.mjs`, `tools/run_harnesses.mjs` (outillage documenté par §3/§15).

Résolution:
`test_siege` ajouté à OFFICIAL + script npm `test:siege` + fichier `tools/test_siege.mjs`
(les 3 alignés, exigence du checker).

Impact:
- MINOR

Cause probable:
- information manquante (étape d'enregistrement de l'harness dans OFFICIAL non énoncée)

Suggestion documentaire:
dans §5, remplacer « (3) optionnel : test:<nom> » par la procédure complète : créer
`tools/test_<nom>.mjs`, ajouter le script npm `test:<nom>`, ajouter `test_<nom>` à la liste
OFFICIAL de `run_harnesses.mjs` (le checker en vérifie l'alignement).

## FRICTION 4

Contexte:
coder le tir hitscan + les règles de zone dans `main.ts` (strict mode).

Question/problème:
les signatures types du core obligent à du narrowing systématique :
- `rt.raycast(...).entity.id`, `rt.byTag(...)[i].id`, `ctx.entity` sont
  `string | undefined` dans les types (mais toujours présents au runtime) ;
- `window.GameLoom` n'a AUCUNE déclaration de type globale (le core lui-même l'attache via
  `(window as any)`), donc l'accès à `_debug` depuis le jeu exige un cast manuel.

GAMELOOM.md:
§5 documente `rt.raycast` → `{ entity, point, distance } | null` et `spawnAsset` → « id =
string » ; §13 documente le pattern de hooks `_debug` mais ne montre pas le wiring TS
(comment y accéder proprement depuis un `main.ts` strict).

Action:
`npx tsc --noEmit` (escalade n°1) → 3 erreurs TS2345 → guards explicites
(`if (!hit?.entity) return; const hitId = hit.entity.id; …`, `if (e.id) …`,
`if (!ctx.entity) return;`) + cast local `(window as { GameLoom?: … }).GameLoom?._debug`.

Recours externe au manuel:
NONE (résolu par la lecture des types via tsc).

Résolution:
guards de narrowing + cast local ; tsc vert.

Impact:
- MINOR

Cause probable:
- API peu intuitive (types optionnels là où la valeur est toujours présente au runtime ;
  pas de déclaration `declare global` pour `window.GameLoom`)

Suggestion documentaire:
montrer dans §5 un extrait de wiring des hooks `_debug` depuis `main.ts` (cast) et indiquer
que `id`/`ctx.entity` requièrent un guard `undefined` en TS strict.

## FRICTION 5

Contexte:
concevoir le test « ennemi atteint la zone du cristal » (T5 du harness).

Question/problème:
si une entité est SPAWNÉE directement à l'intérieur d'une zone `createZone`, le core émet-il
`zone.enter` au tick suivant (transition inside/outside) ? Le test devait choisir entre
« spawner dans la zone » et « spawner dehors et marcher ».

GAMELOOM.md:
§5 dit « le core émet zone.enter / zone.exit sur arête uniquement » — le cas « spawn déjà
dans la zone » (première évaluation = inside, aucune sortie antérieure) n'est pas tranché
explicitement.

Action:
lecture ciblée du core (contrat, autorisée) : `tickZones()` émet `zone.enter` dès que
`inside && !was`, y compris pour une entité née dans la zone. Choix de conception : le
harness téléporte l'ennemi à 2.2 m (hors zone ±1.5) et le laisse marcher dans la zone —
test plus réaliste et indifférent à ce cas limite.

Recours externe au manuel:
`src/core/runtime.ts` (`tickZones` — vérification de contrat).

Résolution:
test par traversée réelle de l'arête (T5) ; le cas spawn-inside documenté ici pour la suite.

Impact:
- NONE (détourné par choix de test)

Cause probable:
- documentation ambiguë (comportement spawn-inside non tranché)

Suggestion documentaire:
préciser dans §5 : « une entité spawnée à l'intérieur d'une zone émet `zone.enter` au
premier tick d'évaluation ».

## Résumé du déroulement

1. Lecture intégrale GAMELOOM.md ; `git status` (SHA initial `823c82e`, `cars/`+`roads/`
   untracked préexistants — non touchés).
2. Découverte des assets via `ls assets/` + `npm run glb -- inspect --json` (aucun présupposé)
   → cristal = `artifact.glb` (static, sans Health → HP géré par le jeu), ennemis =
   `guardian.glb` (kinematic + `Health.max=100` = pattern « entité mobile possédée par le jeu »).
3. Vérifications de contrats core ciblées (autorisées) : pas de sol dans le core, joueur
   spawné à (0,2,0), lumières dans le core, `tickZones()`/`createZone`, exports `src/core`.
4. Implémentation : `src/game/siege/main.ts` (arène 40×40 fermée, 5 guardians, zone cristal
   ±1.5, tir hitscan 30 dégâts, règle `health.zero→destroy`, zone→dégâts 25+retrait,
   victoire/défaite, HUD, hooks `_debug`) + `siege.html` (shell, gabarit `dungeon.html`
   conformément à §5).
5. Enregistrement : entrée `vite.config.ts`, script `test:siege`, `OFFICIAL` dans
   `run_harnesses.mjs`.
6. `tsc --noEmit` → 3 guards (F4) → vert. `check:consistency` → PASS (9 harnesses alignés).
7. `npm run build` + `cp assets/*.glb dist/assets/` ; `node tools/run_harnesses.mjs test_siege`
   → **24/24** au premier run complet.
8. `npm test` (consistency + 9 harnesses officiels, build inclus) → **9/9 OK, zéro régression**.
9. Aucun screenshot nécessaire (aucun problème visuel ; logique validée 100 % par API
   structurée + ticks déterministes).

Notes génériques (hors GameLoom) : le build Vite émet un avertissement chunk > 500 kB sur
stderr que PowerShell affiche comme erreur native (faux positif, build OK) ; rien d'autre à
signaler (TypeScript strict : 3 guards, voir F4).

## BLACK-BOX VERDICT

GAME_CREATED:
YES

GAME_PLAYABLE:
YES (FPS arène fermée 40×40 : 5 gardiens convergent vers le cristal, tir hitscan,
victoire = tous ennemis morts, défaite = cristal à 0 ; HUD vie cristal / ennemis restants /
état ; overlays victoire/défaite avec rejouabilité)

GAME_TESTED:
YES (harness déterministe `tools/test_siege.mjs` — 24/24 checks : boot, console, ennemis
présents, mouvement réel vers l'objectif, tir/dégâts, destruction, zone.enter cristal,
dégâts cristal 100→75 puis →0, victoire, défaite, fingerprint de ticks identique entre 2
runs ; intégré à la suite officielle : `npm test` → 9/9 OK)

EXISTING_GAMES_READ_AS_REFERENCE:
NO — exceptions encadrées, toutes explicitement demandées par GAMELOOM.md :
- `dungeon.html` lu **uniquement** comme gabarit de shell HTML (§5 : « créer <nom>.html
  (copier dungeon.html) ») ;
- `tools/test_headless.mjs` lu **uniquement** comme harness de référence (§15 :
  « test_headless.mjs = harness de référence ; les autres = même pattern ; nouveau jeu :
  dupliquer un harness, changer URL_TARGET + checks »).
Aucun `src/game/*/main.ts` lu. `src/core` lu uniquement pour vérifier des contrats précis
(position spawn du joueur, absence de sol, sémantique `tickZones`) — usage autorisé par la
mission et sans effet sur la découverte de l'API (toutes les API utilisées y étaient
déjà documentées).

CORE_MODIFIED:
NO (aucune modification de `src/core/**` ; aucun bug core bloquant rencontré)

GAMELOOM_MODIFIED:
NO

TOTAL_FRICTIONS:
5

BLOCKING:
0

MODERATE:
0

MINOR:
5 (F1 sol pas dans le minimal example · F2 position initiale joueur + repositionnement
via `_debug` · F3 procédure d'enregistrement de l'harness OFFICIAL non énoncée · F4
narrowing TS `string | undefined` + `window.GameLoom` non typé · F5 sémantique
`zone.enter` au spawn-inside non tranchée)

DOCUMENTATION_GAPS:
3 (F2 position initiale du joueur · F3 enregistrement OFFICIAL · F4 wiring TS des hooks
`_debug`/casts)

API_GAPS:
2 (F2 : pas de moyen public (hors `_debug`) de placer le joueur initialement ailleurs que
(0,2,0) · F4 : `window.GameLoom` sans déclaration de type globale + `id`/`ctx.entity`
`string | undefined` dans les types)

BUGS_FOUND:
0

### Réponses au questionnaire

1. **Un agent neuf peut-il créer Game #8 avec GAMELOOM.md seul ?**
   OUI. Cycle complet (découverte assets → implémentation → typecheck vert → build →
   harness 24/24 au premier run → suite officielle 9/9) sans lire un seul `main.ts`
   existant. Toutes les frictions sont MINOR, aucun blocage, aucun bug core.

2. **Quelle information réellement nécessaire manquait dans GAMELOOM.md ?**
   - La position initiale du joueur (core : (0,2,0), non configurable via `createRuntime`)
     et le fait que `_debug.teleportPlayer` est la voie de repositionnement (y≈0.92 = repos).
   - La procédure d'enregistrement d'un harness dans la suite OFFICIAL (`run_harnesses.mjs`
     + script npm + alignement checker).
   - Le wiring TypeScript des hooks `_debug` depuis un `main.ts` strict (`window.GameLoom`
     non typé → cast).

3. **Quelles parties étaient ambiguës ?**
   - « Le core fournit : joueur, physique, … » (§5) : « physique » peut lire « le monde est
     prêt » alors que sol/murs sont à créer par le jeu (le minimal example ne le montre pas).
   - `zone.enter` « sur arête uniquement » (§5) : comportement d'une entité spawnée
     directement dans la zone (réponse core : `zone.enter` au premier tick — à documenter).

4. **Quelles informations étaient présentes mais difficiles à trouver ?**
   - La section « Objets du monde possédés par le jeu (sol, murs…) » du §5 : essentielle,
     mais noyée après le minimal example qui, lui, n'en a pas besoin.
   - Le pattern des hooks `_debug` (§13) : enterré après la table de l'API publique stable,
     alors que c'est la voie de test de tout gameplay.
   - L'emplacement de la liste OFFICIAL (réparti entre §3, §15 et `run_harnesses.mjs`).

5. **As-tu dû lire du code source pour découvrir une API ou un comportement qui aurait dû
   être documenté ?**
   Oui, de façon limitée et ciblée (contrats core, autorisés) : position de spawn du joueur
   et absence de sol (→ F1/F2), sémantique `tickZones` au spawn-inside (→ F5). Aucune API
   utilisée n'était absente de GAMELOOM.md : tout ce que j'ai appelé y était documenté.

6. **As-tu dû regarder un ancien jeu pour progresser ?**
   Non — uniquement les deux consultations explicitement mandatées par le manuel
   (`dungeon.html` = gabarit shell §5 ; `test_headless.mjs` = harness de référence §15).

7. **Quelles lignes/sections de GAMELOOM.md t'ont été les plus utiles ?**
   §5 (méthodes Runtime, tir hitscan, objets du monde, entités mobiles, zones, events
   personnalisés), §13 (Debug API + `_debug` + pattern hooks), §15 (orchestrateur + pattern
   harness), §10/§11 (table des events/actions + syntaxe des règles), §12 (temps
   déterministe), §6 (GLB comme prefab + `Health.max`), §7 (`glb inspect` = découverte
   assets), §16 (conventions n°2/3/9/7 — notamment vitesse × FIXED_DT, scènes contrôlées,
   build production), §14 (escalade de debug : tsc d'abord).

8. **Quelles informations de GAMELOOM.md étaient inutiles pour cette mission ?**
   §18 entier (Asset Viewer + Choice Mode), la partie génération de recettes GLB/Blender de
   §2 (assets réutilisés, aucun asset créé), le CLI `glb collider/physics/component` (§7),
   les détails d'explosion falloff/impulsion (§8, `A.explode` non utilisé), la règle
   d'aliasing des composants (§6 — aucun composant manipulé directement), et la majeure
   partie de §17 (confirmations de non-existences sans action).

9. **Quelle modification MINIMALE de GAMELOOM.md améliorerait le plus les performances d'un
   prochain agent ?**
   Ajouter dans §5 une boîte « Nouveau jeu — checklist » d'une quinzaine de lignes :
   (a) sol/murs : 2-3 lignes d'exemple `staticBox` (RigidBodyDesc.fixed + cuboid + mesh) ;
   (b) « le core spawn le joueur à (0,2,0) ; pour le repositionner :
   `GameLoom._debug.teleportPlayer(x, 0.92, z)` avant le 1er tick » ;
   (c) harness complet : créer `tools/test_<nom>.mjs` + script npm `test:<nom>` + entrée
   dans la liste `OFFICIAL` de `run_harnesses.mjs` (le checker vérifie l'alignement) ;
   (d) 3 lignes de wiring des hooks `_debug` avec le cast `window`.

10. **GAMELOOM.md peut-il réellement être considéré comme une documentation opérationnelle
    black-box suffisante ?**
    OUI, à réserver près : un agent neuf peut créer, tester et déboguer un nouveau jeu sans
    lire les jeux existants ni toucher au core. Les mécanismes de découverte (CLI `glb
    inspect`, liste OFFICIAL, checker de cohérence, Debug API) fonctionnent comme annoncé,
    et les 5 frictions observées sont MINOR, sans impact bloquant. Les 3 gaps documentaires
    identifiés (position initiale du joueur, enregistrement OFFICIAL, wiring TS) méritent la
    checklist minimale proposée en 9.
