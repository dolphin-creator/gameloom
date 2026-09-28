// GameLoom Asset Viewer v0.1 — outil d'inspection GLB (hors runtime).
// Charge un GLB par URI (?asset=/assets/foo.glb), lit l'extension com.gameloom.v0
// du chunk JSON (comme le core, mais sans le core), dessine les overlays
// (collider/skeleton/bbox — géométries Three.js, PAS Rapier), lit les clips GLTF
// via AnimationMixer, expose window.GameLoomViewer (JSON uniquement).
// Seuls imports: three. Aucun couplage core/gameplay/infrastructure réseau.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const NS = 'com.gameloom.v0';
const NEUTRAL = new THREE.MeshBasicMaterial({ color: 0x94a3b8 });

type AnimItem = { name: string; duration: number };
type BBox = { min: number[]; max: number[]; size: number[] };
type ViewerInfo = {
  uri: string;
  loaded: boolean;
  scenes: number;
  meshes: number;
  vertices: number;
  triangles: number;
  materials: number;
  textures: number;
  animations: AnimItem[];
  skinnedMeshes: number;
  bones: number;
  rigDetected: boolean;
  bbox: BBox | null;
  metadata: Record<string, unknown> | null;
};

// ---------- état ----------
const S = {
  assetUri: '',
  loaded: false,
  error: '',
  info: null as ViewerInfo | null,
  meshVisible: true,
  materialsVisible: true,
  wireframe: false,
  bboxVisible: false,
  colliderVisible: true,
  gridVisible: true,
  axesVisible: false,
  skeletonVisible: false,
  animations: [] as AnimItem[],
  currentAnim: '',
  playing: false,
  loop: true,
  speed: 1,
  metadata: null as Record<string, unknown> | null,
};

let root: THREE.Group | null = null;
let gltfScene: THREE.Group | null = null;
let bboxHelper: THREE.Box3Helper | null = null;
let colliderGroup: THREE.Group | null = null;
let skeletonGroup: THREE.Group | null = null;
let mixer: THREE.AnimationMixer | null = null;
let currentAction: THREE.AnimationAction | null = null;
let clips: THREE.AnimationClip[] = [];

// ---------- lecture GLB (JSON du chunk 0 — même convention que le core) ----------
function readGlbJson(buffer: ArrayBuffer): any | null {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 12) return null;
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== 0x46546c67) return null; // "glTF"
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const len = dv.getUint32(offset, true);
    const type = dv.getUint32(offset + 4, true);
    if (type === 0x4e4f534a) { // JSON
      try {
        return JSON.parse(new TextDecoder().decode(bytes.subarray(offset + 8, offset + 8 + len)));
      } catch {
        return null;
      }
    }
    offset += 8 + len;
    if (len <= 0) break;
  }
  return null;
}

function readGlbMeta(buffer: ArrayBuffer): Record<string, unknown> | null {
  const json = readGlbJson(buffer);
  const ext = json?.scenes?.[0]?.extensions?.[NS];
  return (ext && typeof ext === 'object') ? (ext as Record<string, unknown>) : null;
}

// ---------- scène ----------
const viewport = document.getElementById('viewport') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e13);
const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 500);
camera.position.set(3, 2, 3);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x39445a, 1.5));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.8);
dirLight.position.set(4, 8, 6);
scene.add(dirLight);

const grid = new THREE.GridHelper(20, 40, 0x2c3a52, 0x1b2434);
scene.add(grid);
const axes = new THREE.AxesHelper(3);
axes.visible = false;
scene.add(axes);

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (mixer) mixer.update(dt);
  controls.update();
  updateAnimTimeLabel();
  renderer.render(scene, camera);
});

// ---------- utilitaires UI ----------
function setStatus(msg: string, kind: '' | 'ok' | 'err' = '') {
  statusEl.textContent = msg;
  statusEl.className = kind;
}

function kvRow(k: string, v: string): string {
  return `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;
}

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const chk = (id: string) => (document.getElementById(id) as HTMLInputElement);

// ---------- chargement ----------
function clearAsset() {
  for (const g of [root, bboxHelper, colliderGroup, skeletonGroup]) {
    if (g) {
      scene.remove(g);
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          for (const mat of (Array.isArray(m.material) ? m.material : [m.material])) {
            if (mat && mat !== NEUTRAL) (mat as THREE.Material).dispose();
          }
        }
      });
    }
  }
  if (mixer) {
    mixer.stopAllAction();
    mixer.removeEventListener('finished', onAnimFinished);
    mixer = null;
  }
  currentAction = null;
  root = null; gltfScene = null; bboxHelper = null; colliderGroup = null; skeletonGroup = null;
  clips = [];
  S.loaded = false;
  S.error = '';
  S.info = null;
  S.animations = [];
  S.currentAnim = '';
  S.playing = false;
}

async function loadAsset(uri: string) {
  clearAsset();
  S.assetUri = uri;
  setStatus('Chargement…');
  try {
    const res = await fetch(uri);
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${uri}`);
    const buf = await res.arrayBuffer();
    const metadata = readGlbMeta(buf);

    const gltf = await new GLTFLoader().parseAsync(buf, '');
    gltfScene = gltf.scene;
    clips = gltf.animations;

    const box = new THREE.Box3().setFromObject(gltfScene);
    root = new THREE.Group();
    root.add(gltfScene);
    scene.add(root);

    S.metadata = metadata;
    S.loaded = true;
    S.info = computeInfo(uri, gltf, box);
    S.animations = S.info.animations;

    // overlays (espace local de l'asset — racine à l'origine, transforme identité)
    bboxHelper = new THREE.Box3Helper(box, 0x7fd4ff);
    bboxHelper.visible = S.bboxVisible;
    scene.add(bboxHelper);

    const col = metadata?.collider as { type?: string; size?: number[]; center?: number[] } | undefined;
    if (col && typeof col === 'object' && (col.type === 'box' || col.type === 'sphere' || col.type === 'capsule')) {
      colliderGroup = buildColliderOverlay(col.type, col.size ?? [], col.center ?? [0, 0, 0]);
      colliderGroup.visible = S.colliderVisible;
      scene.add(colliderGroup);
    } else {
      S.colliderVisible = false;
    }

    const skinned: THREE.SkinnedMesh[] = [];
    root.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(o as THREE.SkinnedMesh); });
    if (skinned.length) {
      skeletonGroup = new THREE.Group();
      for (const sm of skinned) skeletonGroup.add(new THREE.SkeletonHelper(sm));
      skeletonGroup.visible = S.skeletonVisible;
      scene.add(skeletonGroup);
      if (!urlParam('skeleton')) S.skeletonVisible = true; // auto-on si rig détecté
    }

    if (clips.length) {
      mixer = new THREE.AnimationMixer(root);
      mixer.addEventListener('finished', onAnimFinished);
      const want = urlParam('animation');
      if (want && clips.some((c) => c.name === want)) selectAnimation(want, true);
    }

    autoFrame(gltfScene, box);
    applyVisualState();
    renderPanels();
    setStatus(`Chargé: ${S.info.meshes} mesh · ${S.info.triangles} triangles · ${S.animations.length} animation(s)`, 'ok');
    syncUrl();
  } catch (e) {
    S.error = e instanceof Error ? e.message : String(e);
    setStatus(`Erreur: ${S.error}`, 'err');
    renderPanels();
  }
}

function computeInfo(uri: string, gltf: GLTF, box: THREE.Box3): ViewerInfo {
  let meshes = 0, vertices = 0, triangles = 0, skinnedMeshes = 0;
  const mats = new Set<THREE.Material>();
  const texs = new Set<THREE.Texture>();
  const skinned: THREE.SkinnedMesh[] = [];
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      meshes++;
      const g = m.geometry as THREE.BufferGeometry;
      const pos = g.getAttribute('position');
      vertices += pos ? pos.count : 0;
      triangles += g.index ? g.index.count / 3 : (pos ? pos.count / 3 : 0);
      for (const mat of (Array.isArray(m.material) ? m.material : [m.material])) {
        if (!mat) continue;
        mats.add(mat);
        for (const v of Object.values(mat)) if (v instanceof THREE.Texture) texs.add(v);
      }
    }
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) { skinned.push(o as THREE.SkinnedMesh); skinnedMeshes++; }
  });
  const skeletons = new Set<THREE.Skeleton>();
  let bones = 0;
  for (const sm of skinned) if (!skeletons.has(sm.skeleton)) { skeletons.add(sm.skeleton); bones += sm.skeleton.bones.length; }
  const min = box.min.toArray().map((n) => +n.toFixed(4));
  const max = box.max.toArray().map((n) => +n.toFixed(4));
  return {
    uri,
    loaded: true,
    scenes: gltf.scenes.length,
    meshes,
    vertices,
    triangles: Math.round(triangles),
    materials: mats.size,
    textures: texs.size,
    animations: gltf.animations.map((c) => ({ name: c.name || '(sans nom)', duration: +c.duration.toFixed(3) })),
    skinnedMeshes,
    bones,
    rigDetected: skinnedMeshes > 0,
    bbox: { min, max, size: max.map((n, i) => +(n - min[i]).toFixed(4)) },
    metadata: S.metadata,
  };
}

// ---------- auto-framing ----------
function autoFrame(obj: THREE.Object3D, box: THREE.Box3) {
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const dist = (maxDim / (2 * Math.tan(fov / 2))) * 2.2;
  const dirv = new THREE.Vector3(1, 0.55, 1).normalize();
  camera.position.copy(center).addScaledVector(dirv, dist);
  controls.target.copy(center);
  controls.update();
}

// ---------- overlay collider (visuel — géométries Three.js, pas de Rapier) ----------
function buildColliderOverlay(type: string, size: number[], center: number[]): THREE.Group {
  const g = new THREE.Group();
  const fill = new THREE.MeshBasicMaterial({ color: 0x4fd1ff, transparent: true, opacity: 0.28, depthWrite: false });
  const edge = new THREE.LineBasicMaterial({ color: 0x9fe8ff });
  let mesh: THREE.Mesh | null = null;
  if (type === 'box') {
    mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0] ?? 1, size[1] ?? 1, size[2] ?? 1), fill);
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry as THREE.BufferGeometry), edge));
  } else if (type === 'sphere') {
    mesh = new THREE.Mesh(new THREE.SphereGeometry(size[0] ?? 0.5, 32, 20), fill);
  } else if (type === 'capsule') {
    mesh = new THREE.Mesh(new THREE.CapsuleGeometry(size[0] ?? 0.5, (size[1] ?? 0.5) * 2, 8, 24), fill);
  }
  if (mesh) {
    mesh.position.set(center[0] ?? 0, center[1] ?? 0, center[2] ?? 0);
    g.add(mesh);
  }
  return g;
}

// ---------- toggles visuels ----------
function applyWireframe(on: boolean) {
  if (!root) return;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.material) return;
    for (const mat of (Array.isArray(m.material) ? m.material : [m.material])) {
      if (mat && 'wireframe' in mat) (mat as { wireframe: boolean }).wireframe = on;
    }
  });
}

function applyMaterials(on: boolean) {
  if (!root) return;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.material) return;
    if (on) {
      const orig = m.userData.__glv_mats;
      if (orig) { m.material = orig; delete m.userData.__glv_mats; }
    } else if (!m.userData.__glv_mats) {
      m.userData.__glv_mats = m.material;
      m.material = NEUTRAL;
    }
  });
}

function applyVisualState() {
  grid.visible = S.gridVisible;
  axes.visible = S.axesVisible;
  if (root) root.visible = S.meshVisible;
  if (bboxHelper) bboxHelper.visible = S.bboxVisible;
  if (colliderGroup) colliderGroup.visible = S.colliderVisible;
  if (skeletonGroup) skeletonGroup.visible = S.skeletonVisible;
  applyWireframe(S.wireframe);
  applyMaterials(S.materialsVisible);
  syncCheckboxes();
}

function syncCheckboxes() {
  chk('chk-mesh').checked = S.meshVisible;
  chk('chk-materials').checked = S.materialsVisible;
  chk('chk-wireframe').checked = S.wireframe;
  chk('chk-bbox').checked = S.bboxVisible;
  chk('chk-collider').checked = S.colliderVisible;
  chk('chk-grid').checked = S.gridVisible;
  chk('chk-axes').checked = S.axesVisible;
  chk('chk-skeleton').checked = S.skeletonVisible;
}

// ---------- animations ----------
function onAnimFinished(e: { action: THREE.AnimationAction }) {
  if (!S.loop && e.action === currentAction) {
    S.playing = false;
    updateAnimButtons();
  }
}

function selectAnimation(name: string, play: boolean) {
  const clip = clips.find((c) => c.name === name);
  if (!clip || !mixer) return;
  if (currentAction) currentAction.stop();
  const action = mixer.clipAction(clip);
  action.setLoop(S.loop ? THREE.LoopRepeat : THREE.LoopOnce, 1);
  action.setEffectiveTimeScale(S.speed);
  action.reset();
  currentAction = action;
  S.currentAnim = name;
  if (play) {
    action.play();
    S.playing = true;
  }
  updateAnimButtons();
  renderAnimPanel();
  syncUrl();
}

function pauseAnimation() {
  if (!currentAction) return false;
  currentAction.paused = true;
  S.playing = false;
  updateAnimButtons();
  return true;
}

function stopAnimation() {
  if (!currentAction) return false;
  currentAction.stop();
  currentAction.time = 0;
  S.playing = false;
  updateAnimButtons();
  updateAnimTimeLabel();
  return true;
}

function currentDuration(): number {
  const c = clips.find((x) => x.name === S.currentAnim);
  return c ? c.duration : 0;
}

function updateAnimButtons() {
  const play = $('btn-play') as HTMLButtonElement | null;
  const pause = $('btn-pause') as HTMLButtonElement | null;
  if (play) play.classList.toggle('on', S.playing);
  if (pause) pause.classList.toggle('on', !S.playing && S.currentAnim !== '');
}

function updateAnimTimeLabel() {
  if (!currentAction) return;
  const dur = currentDuration();
  const t = dur > 0 ? currentAction.time % dur : currentAction.time;
  const label = $('anim-time-label') as HTMLElement | null;
  if (label) label.textContent = `${t.toFixed(2)} s / ${dur.toFixed(2)} s`;
  const input = $('anim-time') as HTMLInputElement | null;
  if (input && !input.matches(':active') && dur > 0) {
    input.max = String(dur);
    input.value = t.toFixed(3);
  }
}

// ---------- URL state (URLSearchParams — pas de framework) ----------
function urlParam(k: string): string | null {
  return new URLSearchParams(location.search).get(k);
}

function boolParam(k: string, fallback: boolean): boolean {
  const v = urlParam(k);
  if (v === null) return fallback;
  return v === '1' || v === 'true';
}

function syncUrl() {
  const p = new URLSearchParams();
  if (S.assetUri) p.set('asset', S.assetUri);
  if (S.wireframe) p.set('wireframe', '1');
  if (S.bboxVisible) p.set('bbox', '1');
  if (S.colliderVisible && colliderGroup) p.set('collider', '1');
  if (S.skeletonVisible && skeletonGroup) p.set('skeleton', '1');
  if (!S.meshVisible) p.set('mesh', '0');
  if (!S.materialsVisible) p.set('materials', '0');
  if (!S.gridVisible) p.set('grid', '0');
  if (S.axesVisible) p.set('axes', '1');
  if (S.currentAnim) p.set('animation', S.currentAnim);
  if (S.speed !== 1) p.set('speed', String(S.speed));
  if (!S.loop) p.set('loop', '0');
  history.replaceState(null, '', '?' + p.toString());
}

// ---------- panneaux ----------
function metaLines(obj: unknown, prefix = '', out: string[] = []): string[] {
  if (obj === null || obj === undefined) { out.push(prefix + '(absent)'); return out; }
  if (typeof obj !== 'object' || Array.isArray(obj)) { out.push(prefix + String(JSON.stringify(obj))); return out; }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(`${prefix}${k} {`);
      metaLines(v, prefix + '  ', out);
      out.push(prefix + '}');
    } else {
      out.push(`${prefix}${k} = ${JSON.stringify(v)}`);
    }
  }
  return out;
}

function renderPanels() {
  const i = S.info;
  ($('v-uri') as HTMLElement).textContent = S.assetUri || '—';
  ($('v-state') as HTMLElement).textContent = S.loaded ? 'chargé' : (S.error ? `erreur: ${S.error}` : 'en attente');

  if (i) {
    ($('sec-glb') as HTMLElement).innerHTML = [
      kvRow('scènes', String(i.scenes)),
      kvRow('meshes', String(i.meshes)),
      kvRow('vertices', String(i.vertices)),
      kvRow('triangles', String(i.triangles)),
      kvRow('matériaux', String(i.materials)),
      kvRow('textures', String(i.textures)),
      kvRow('animations', String(i.animations.length)),
      kvRow('skinned meshes', String(i.skinnedMeshes)),
      kvRow('bones', String(i.bones)),
      kvRow('bbox', i.bbox ? `[${i.bbox.size.map((n) => n.toFixed(2)).join(' × ')}] m` : '—'),
    ].join('');
  } else {
    ($('sec-glb') as HTMLElement).innerHTML = '<span class="muted">—</span>';
  }

  const metaEl = $('sec-meta') as HTMLElement;
  if (S.loaded) {
    metaEl.textContent = S.metadata ? metaLines(S.metadata).join('\n') : 'aucune metadata GameLoom (extension com.gameloom.v0 absente)';
  } else {
    metaEl.textContent = '—';
  }

  const rig = $('sec-rig') as HTMLElement;
  if (i) {
    rig.innerHTML = [
      kvRow('Rig détecté', i.rigDetected ? 'OUI' : 'NON'),
      kvRow('Skinned meshes', String(i.skinnedMeshes)),
      kvRow('Bones', String(i.bones)),
    ].join('');
  } else {
    rig.innerHTML = '<span class="muted">—</span>';
  }

  renderAnimPanel();
}

function renderAnimPanel() {
  const el = $('sec-anim') as HTMLElement;
  if (!S.loaded) { el.innerHTML = '<span class="muted">—</span>'; return; }
  if (!clips.length) {
    el.innerHTML = '<span class="muted">aucune animation dans ce GLB</span>';
    return;
  }
  const options = clips.map((c) => {
    const nm = c.name || '(sans nom)';
    return `<option value="${nm}"${nm === S.currentAnim ? ' selected' : ''}>${nm} — ${c.duration.toFixed(2)} s</option>`;
  }).join('');
  el.innerHTML = `
    <select id="anim-select">${options}</select>
    <div class="row">
      <button id="btn-play">Play</button>
      <button id="btn-pause">Pause</button>
      <button id="btn-stop">Stop</button>
    </div>
    <label class="chk" style="margin-top:8px"><input type="checkbox" id="anim-loop"${S.loop ? ' checked' : ''}>Loop</label>
    <div class="rowlabel"><span>Vitesse</span><span id="anim-speed-label">${S.speed.toFixed(1)}×</span></div>
    <input type="range" id="anim-speed" min="0.1" max="3" step="0.1" value="${S.speed}">
    <div class="rowlabel"><span>Timeline</span><span id="anim-time-label">0.00 s / 0.00 s</span></div>
    <input type="range" id="anim-time" min="0" max="1" step="0.001" value="0">
  `;
  (el.querySelector('#anim-select') as HTMLSelectElement).addEventListener('change', (e) => {
    selectAnimation((e.target as HTMLSelectElement).value, true);
  });
  (el.querySelector('#btn-play') as HTMLButtonElement).addEventListener('click', () => {
    if (S.currentAnim && currentAction) { currentAction.play(); currentAction.paused = false; S.playing = true; updateAnimButtons(); }
  });
  (el.querySelector('#btn-pause') as HTMLButtonElement).addEventListener('click', () => { pauseAnimation(); });
  (el.querySelector('#btn-stop') as HTMLButtonElement).addEventListener('click', () => { stopAnimation(); });
  (el.querySelector('#anim-loop') as HTMLInputElement).addEventListener('change', (e) => {
    S.loop = (e.target as HTMLInputElement).checked;
    if (currentAction) currentAction.setLoop(S.loop ? THREE.LoopRepeat : THREE.LoopOnce, 1);
    syncUrl();
  });
  (el.querySelector('#anim-speed') as HTMLInputElement).addEventListener('input', (e) => {
    S.speed = Math.min(10, Math.max(0.1, parseFloat((e.target as HTMLInputElement).value) || 1));
    if (currentAction) currentAction.setEffectiveTimeScale(S.speed);
    const lab = $('anim-speed-label') as HTMLElement | null;
    if (lab) lab.textContent = `${S.speed.toFixed(1)}×`;
    syncUrl();
  });
  (el.querySelector('#anim-time') as HTMLInputElement).addEventListener('input', (e) => {
    if (currentAction) {
      currentAction.time = Math.max(0, parseFloat((e.target as HTMLInputElement).value) || 0);
      const dur = currentDuration();
      const lab = $('anim-time-label') as HTMLElement | null;
      if (lab) lab.textContent = `${currentAction.time.toFixed(2)} s / ${dur.toFixed(2)} s`;
    }
  });
  updateAnimButtons();
}

// ---------- API publique (JSON uniquement — aucun objet Three.js exposé) ----------
type R = Record<string, unknown>;

const api = {
  version: '0.1.0',

  info(): R {
    if (!S.loaded || !S.info) return { loaded: false, uri: S.assetUri || null, error: S.error || null };
    return { ...S.info };
  },

  asset(): R {
    return { uri: S.assetUri || null, loaded: S.loaded, error: S.error || null };
  },

  animations(): R[] {
    if (!S.loaded) return [];
    return S.animations.map((a) => ({
      name: a.name,
      duration: a.duration,
      selected: a.name === S.currentAnim,
      playing: a.name === S.currentAnim && S.playing,
      time: a.name === S.currentAnim && currentAction ? +((currentAction.time % a.duration)).toFixed(3) : 0,
    }));
  },

  getState(): R {
    return {
      mesh: S.meshVisible, materials: S.materialsVisible, wireframe: S.wireframe,
      bbox: S.bboxVisible, collider: S.colliderVisible, grid: S.gridVisible,
      axes: S.axesVisible, skeleton: S.skeletonVisible,
      animation: S.currentAnim || null, playing: S.playing, loop: S.loop, speed: S.speed,
    };
  },

  playAnimation(name?: string): R {
    if (!S.loaded) return { ok: false, error: 'asset non chargé' };
    if (!mixer || !clips.length) return { ok: false, error: 'aucune animation dans ce GLB' };
    const chosen = name && clips.some((c) => c.name === name)
      ? name
      : (S.currentAnim && clips.some((c) => c.name === S.currentAnim) ? S.currentAnim : clips[0].name);
    selectAnimation(chosen, true);
    return { ok: true, name: chosen };
  },

  pauseAnimation(): R {
    if (!currentAction) return { ok: false, error: 'aucune animation sélectionnée' };
    return { ok: pauseAnimation(), playing: S.playing };
  },

  stopAnimation(): R {
    if (!currentAction) return { ok: false, error: 'aucune animation sélectionnée' };
    return { ok: stopAnimation(), time: 0 };
  },

  setAnimationTime(seconds: number): R {
    if (!currentAction || !Number.isFinite(seconds)) return { ok: false, error: 'aucune animation sélectionnée' };
    currentAction.time = Math.max(0, seconds);
    updateAnimTimeLabel();
    return { ok: true, time: +currentAction.time.toFixed(3) };
  },

  setAnimationSpeed(speed: number): R {
    if (!Number.isFinite(speed) || speed <= 0) return { ok: false, error: 'vitesse invalide' };
    S.speed = Math.min(10, speed);
    if (currentAction) currentAction.setEffectiveTimeScale(S.speed);
    const lab = $('anim-speed-label') as HTMLElement | null;
    if (lab) lab.textContent = `${S.speed.toFixed(1)}×`;
    const input = $('anim-speed') as HTMLInputElement | null;
    if (input) input.value = String(S.speed);
    syncUrl();
    return { ok: true, speed: S.speed };
  },

  setMeshVisible(v: boolean): R { S.meshVisible = !!v; applyVisualState(); syncUrl(); return { ok: true, visible: S.meshVisible }; },
  setMaterialsVisible(v: boolean): R { S.materialsVisible = !!v; applyMaterials(S.materialsVisible); syncUrl(); return { ok: true, visible: S.materialsVisible }; },
  setWireframe(v: boolean): R { S.wireframe = !!v; applyWireframe(S.wireframe); syncUrl(); return { ok: true, wireframe: S.wireframe }; },
  setColliderVisible(v: boolean): R { S.colliderVisible = !!v; applyVisualState(); syncUrl(); return { ok: true, visible: S.colliderVisible }; },
  setBoundingBoxVisible(v: boolean): R { S.bboxVisible = !!v; applyVisualState(); syncUrl(); return { ok: true, visible: S.bboxVisible }; },
  setSkeletonVisible(v: boolean): R { S.skeletonVisible = !!v; applyVisualState(); syncUrl(); return { ok: true, visible: S.skeletonVisible }; },
  setGridVisible(v: boolean): R { S.gridVisible = !!v; applyVisualState(); syncUrl(); return { ok: true, visible: S.gridVisible }; },
  setAxesVisible(v: boolean): R { S.axesVisible = !!v; applyVisualState(); syncUrl(); return { ok: true, visible: S.axesVisible }; },
};

// Exposé AVANT tout chargement: l'agent/le test détectent le boot immédiatement,
// puis `asset().loaded` devient true une fois le GLB parsé.
(window as unknown as { GameLoomViewer: typeof api }).GameLoomViewer = api;

// ---------- wiring UI ----------
const bindChk = (id: string, apply: (v: boolean) => void) => {
  chk(id).addEventListener('change', (e) => {
    apply((e.target as HTMLInputElement).checked);
  });
};
bindChk('chk-mesh', (v) => { S.meshVisible = v; applyVisualState(); syncUrl(); });
bindChk('chk-materials', (v) => { S.materialsVisible = v; applyMaterials(v); syncUrl(); });
bindChk('chk-wireframe', (v) => { S.wireframe = v; applyWireframe(v); syncUrl(); });
bindChk('chk-bbox', (v) => { S.bboxVisible = v; applyVisualState(); syncUrl(); });
bindChk('chk-collider', (v) => { S.colliderVisible = v; applyVisualState(); syncUrl(); });
bindChk('chk-grid', (v) => { S.gridVisible = v; applyVisualState(); syncUrl(); });
bindChk('chk-axes', (v) => { S.axesVisible = v; applyVisualState(); syncUrl(); });
bindChk('chk-skeleton', (v) => { S.skeletonVisible = v; applyVisualState(); syncUrl(); });

// ---------- boot ----------
S.meshVisible = boolParam('mesh', true);
S.materialsVisible = boolParam('materials', true);
S.wireframe = boolParam('wireframe', false);
S.bboxVisible = boolParam('bbox', false);
S.colliderVisible = boolParam('collider', true);
S.gridVisible = boolParam('grid', true);
S.axesVisible = boolParam('axes', false);
S.loop = boolParam('loop', true);
const speedParam = parseFloat(urlParam('speed') ?? '1');
S.speed = Number.isFinite(speedParam) && speedParam > 0 ? Math.min(10, speedParam) : 1;
syncCheckboxes();
renderPanels();

const initial = urlParam('asset');
if (initial) void loadAsset(initial);
else setStatus('Aucun asset — ouvrir ?asset=/assets/mon_asset.glb');
