/* Apartment tour viewer.
 *
 * Every pixel you see was path-traced in Blender; this file's only job is to
 * put those pixels back on screen unmodified and let you move between them.
 *
 * Two ideas carry the whole thing:
 *
 *  1. Colour is passed through untouched.  The WebP faces already contain
 *     Blender's AgX-tonemapped sRGB bytes, so three.js colour management is
 *     switched OFF and the renderer writes those bytes straight to the canvas.
 *     Any "correction" here would be a second tone map on top of the first.
 *
 *  2. A panorama is not a sphere, it is a *shell*.  Each viewpoint carries a
 *     ray-traced depth map, so its sphere is pushed out to where the walls
 *     actually are.  Standing still that is indistinguishable from a skybox,
 *     but while walking between two viewpoints the near walls slide past the
 *     far ones and it reads as real movement rather than a slideshow.
 */
import * as THREE from 'three';

THREE.ColorManagement.enabled = false;   // see note (1) above

const BUILD = 'b4fdb0a5';   // stamped by pipeline/version.py

const FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
const shortestAngle = (from, to) => {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};
const $ = id => document.getElementById(id);

/* Tip the view down a little: the circles you walk to sit on the floor, and at
   a dead-level default they fall just below the bottom of the screen. */
const DEFAULT_PITCH = -9 * (Math.PI / 180);
const REDUCED_MOTION = window.matchMedia
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------------ shaders */
const VERT = `
precision highp float;
uniform sampler2D uDepth;
uniform float uNear, uFar;
varying vec3 vDir;
varying float vDepth;
void main() {
  vec3 d = normalize(position);
  vDir = d;
  float u = 0.5 + atan(d.x, -d.z) / 6.2831853071795864;
  float v = acos(clamp(d.y, -1.0, 1.0)) / 3.1415926535897932;
  float dist = clamp(texture2D(uDepth, vec2(u, v)).r, uNear, uFar);
  vDepth = dist;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(d * dist, 1.0);
}`;

/* The faces are written in the GL cube-map convention already (see
   pipeline/common.py), and the cube's axes *are* the three.js world axes, so
   the direction is used as-is.  three's own cube shaders negate x here because
   they consume textures authored the other way round -- doing that too would
   mirror the flat. */
const FRAG = `
precision highp float;
uniform samplerCube uCube;
uniform float uOpacity;
uniform float uWarp;
varying vec3 vDir;
varying float vDepth;
void main() {
  vec3 c = textureCube(uCube, normalize(vDir)).rgb;

  // A triangle straddling a depth jump -- a door frame against the room
  // behind it -- gets stretched into a smear as soon as the camera leaves
  // this panorama's centre.  Screen-space rate of change of distance finds
  // exactly those fragments; drop them and the panorama being walked *into*
  // shows through the gap instead.  uWarp is 0 while standing still, so a
  // stationary view is never touched.
  float stretch = fwidth(vDepth) / max(vDepth, 0.30);
  float a = uOpacity * (1.0 - uWarp * smoothstep(0.12, 0.55, stretch));
  if (a < 0.004) discard;
  gl_FragColor = vec4(c, a);
}`;

/* --------------------------------------------------------------- walk mask */
/* Where a person may stand, as a bitmap, so movement can be continuous and
   still refuse to walk through the kitchen counter. */
const walk = { ready: false };

function initWalkMask(w) {
  if (!w) return;
  const raw = atob(w.bits);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  Object.assign(walk, w, { bytes, ready: true });
}

/** three.js x/z -> is that a standable cell? */
function standable(x, z) {
  if (!walk.ready) return true;
  const by = -z;                                  // three z is -blender y
  const i = Math.floor((x - walk.x0) / walk.step);
  const j = Math.floor((by - walk.y0) / walk.step);
  if (i < 0 || j < 0 || i >= walk.nx || j >= walk.ny) return false;
  const bit = j * walk.nx + i;
  return (walk.bytes[bit >> 3] >> (7 - (bit & 7))) & 1;
}

/** Slide along whatever wall was hit instead of stopping dead. */
function moveWithin(pos, dx, dz) {
  if (standable(pos.x + dx, pos.z + dz)) { pos.x += dx; pos.z += dz; return true; }
  if (standable(pos.x + dx, pos.z)) { pos.x += dx; return true; }
  if (standable(pos.x, pos.z + dz)) { pos.z += dz; return true; }
  return false;
}

/* -------------------------------------------------------------------- state */
const app = {
  tour: null,
  nodes: new Map(),
  current: null,
  shells: new Map(),     // id -> Mesh
  hiOrder: [],           // LRU of ids holding a high-res cube texture
  baseOrder: [],         // LRU of ids holding a base cube texture
  yaw: 0, pitch: DEFAULT_PITCH, fov: 72, zoom: 1,
  turnDir: 0,
  yawVel: 0, pitchVel: 0,
  dragging: false, moved: 0,
  pos: null,             // live camera position, not a node index
  glide: null,           // automated walk in progress
  fade: null,            // panorama cross-fade in progress
  moveDir: 0,            // -1 back, +1 forward, from held controls
  pending: null,
  guided: null,
  hotspots: [],
  hovered: null,
};

let renderer, scene, camera, sphereGeo, raycaster, ringTex;

/* ------------------------------------------------------------------ loading */
const cubeLoader = new THREE.CubeTextureLoader();

function loadCube(id, size) {
  return new Promise((resolve, reject) => {
    cubeLoader.setPath(`data/panos/${id}/${size}/`);
    cubeLoader.load(
      FACES.map(f => `${f}.webp`),
      tex => {
        tex.colorSpace = THREE.NoColorSpace;     // note (1): no decode
        // The base tier is only ever stretched up, never shrunk, so mip
        // levels for it would be 33% more video memory doing nothing.
        const mip = size > app.tour.tiers[0];
        tex.generateMipmaps = mip;
        tex.minFilter = mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.anisotropy = mip ? renderer.capabilities.getMaxAnisotropy() : 1;
        resolve(tex);
      },
      undefined,
      err => reject(err)
    );
  });
}

/* Warm the HTTP cache without spending any video memory: the bytes are then
   local, and the GPU texture gets built on first visit instead of for all
   seventeen viewpoints at once. */
function prefetchCubeFiles(id) {
  const size = app.tour.tiers[0];
  return Promise.all(FACES.map(f =>
    fetch(`data/panos/${id}/${size}/${f}.webp`, { cache: 'force-cache' })
  ));
}

async function loadDepth(id) {
  const { width, height } = app.tour.depth;
  const buf = await (await fetch(`data/panos/${id}/depth.bin`)).arrayBuffer();
  const mm = new Uint16Array(buf);
  const m = new Float32Array(width * height);
  for (let i = 0; i < m.length; i++) m[i] = mm[i] / 1000;
  const tex = new THREE.DataTexture(m, width, height, THREE.RedFormat, THREE.FloatType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

/* Loading is split in two because the two halves earn their bandwidth at
   different moments.  The small cube map is what makes *arriving* instant, so
   it is fetched for every viewpoint up front (~50 KB each).  The depth map is
   only needed once a viewpoint is actually drawn, and 17 of them is 2.4 MB --
   real money on a slow line -- so those are fetched on demand and for
   immediate neighbours. */
const BASE_CACHE = 8;

function touchBase(id) {
  app.baseOrder = app.baseOrder.filter(x => x !== id);
  app.baseOrder.push(id);
  while (app.baseOrder.length > BASE_CACHE) {
    const drop = app.baseOrder.shift();
    if (drop === app.current || app.shells.has(drop)) {
      app.baseOrder.push(drop);
      break;
    }
    const dn = app.nodes.get(drop);
    if (dn && dn.cubeBase) {
      dn.cubeBase.dispose();      // frees the GPU copy; the files stay cached
      dn.cubeBase = null;
      dn._cubeLoading = null;
    }
  }
}

function ensureCube(id) {
  const n = app.nodes.get(id);
  if (!n._cubeLoading) {
    n._cubeLoading = loadCube(id, app.tour.tiers[0]).then(tex => {
      n.cubeBase = tex;
      touchBase(id);
      return tex;
    });
  } else if (n.cubeBase) {
    touchBase(id);
  }
  return n._cubeLoading;
}

function ensureDepth(id) {
  const n = app.nodes.get(id);
  if (!n._depthLoading) {
    n._depthLoading = loadDepth(id).then(tex => {
      n.depthTex = tex;
      return tex;
    });
  }
  return n._depthLoading;
}

/** Everything a viewpoint needs before it can be drawn.
 *
 * This asks whether the textures are actually present rather than trusting a
 * "loaded once" flag: the base cache can evict a viewpoint you visited
 * earlier, and a stale flag would hand back a node whose cube map has been
 * disposed -- a black room, only after enough walking to trigger an eviction.
 */
async function ensureNode(id) {
  const n = app.nodes.get(id);
  if (n.cubeBase && n.depthTex) {
    touchBase(id);
    return n;
  }
  await Promise.all([ensureCube(id), ensureDepth(id)]);
  return n;
}

/* With continuous walking you can cross into a neighbouring panorama at any
   moment, so the ones you might reach need their textures built, not merely
   their files cached -- nearestNode() will not switch to one that is not
   ready. The base tier is ~65 kB each and BASE_CACHE bounds how many stay. */
function prefetchNeighbours(id) {
  const n = app.nodes.get(id);
  if (!n) return;
  const near = n.links
    .map(l => app.nodes.get(l))
    .filter(Boolean)
    .sort((a, b) =>
      Math.hypot(a.pos[0] - n.pos[0], a.pos[2] - n.pos[2]) -
      Math.hypot(b.pos[0] - n.pos[0], b.pos[2] - n.pos[2]))
    .slice(0, 5);
  for (const m of near) ensureNode(m.id).catch(() => {});
}

/** Walk a viewpoint up through the resolution tiers, sharpest last.
 *
 * The smallest tier is preloaded for every viewpoint and never thrown away --
 * it is what makes arriving somewhere feel instant.  Bigger tiers load only
 * for where you actually are, one step at a time, so a slow connection still
 * sharpens up gradually instead of stalling on one huge download.  Only a
 * handful of the big ones are kept in video memory.
 */
async function upgrade(id) {
  const n = app.nodes.get(id);
  const tiers = app.tour.tiers;
  if (n._upgrading) return;
  n._upgrading = true;
  try {
    for (let i = 1; i < tiers.length; i++) {
      const size = tiers[i];
      if (n.maxTier && size > n.maxTier) break;
      if (app.current !== id) break;          // they walked off before it landed
      if ((n.hiSize || 0) >= size) continue;

      $('loadbar').classList.remove('hidden');
      $('loadbar-fill').style.width = `${Math.round((i / tiers.length) * 80)}%`;

      if (n.failedTiers && n.failedTiers.has(size)) break;
      let tex;
      try {
        tex = await loadCube(id, size);
      } catch (e) {
        // Remember it, or every future visit re-requests the same 404.
        (n.failedTiers || (n.failedTiers = new Set())).add(size);
        console.warn(`tier ${size} unavailable for ${id}`);
        break;
      }
      if (app.current !== id && app.current !== undefined) {
        // arrived too late to matter -- do not hold the memory
        tex.dispose();
        break;
      }
      if (n.cubeHi) n.cubeHi.dispose();
      n.cubeHi = tex;
      n.hiSize = size;
      const shell = app.shells.get(id);
      if (shell) shell.material.uniforms.uCube.value = tex;

      app.hiOrder = app.hiOrder.filter(x => x !== id);
      app.hiOrder.push(id);
      trimHiCache();
    }
  } finally {
    n._upgrading = false;
    $('loadbar-fill').style.width = '100%';
    setTimeout(() => {
      $('loadbar').classList.add('hidden');
      $('loadbar-fill').style.width = '0';
    }, 350);
  }
}

/* A 2048px cube map is ~134 MB of video memory once mipped, and two of them
   are resident during a walk.  That is fine on a laptop and not fine on an
   ageing tablet, so the top tier is chosen from what the device admits to. */
function pickTiers(all) {
  const caps = renderer.capabilities;
  const mem = navigator.deviceMemory;            // undefined on Safari
  const cssMax = Math.max(screen.width, screen.height);
  const touch = (navigator.maxTouchPoints || 0) > 0;
  const reasons = [];
  let cap = 2048;
  if (caps.maxTextureSize < 4096) reasons.push(`maxTextureSize ${caps.maxTextureSize}`);
  if (mem !== undefined && mem < 4) reasons.push(`deviceMemory ${mem} GB`);
  // A phone reports plenty of texture size but will have the tab killed long
  // before it can hold two 2048 cube maps.
  if (touch && cssMax < 1024) reasons.push(`small touch screen (${cssMax}px)`);
  if (reasons.length) cap = 1024;
  const keep = all.filter(t => t <= cap);
  if (reasons.length) console.info('capped to', cap, 'because', reasons.join(', '));
  return keep.length ? keep : [all[0]];
}

const HI_CACHE = 2;
function trimHiCache() {
  while (app.hiOrder.length > HI_CACHE) {
    const drop = app.hiOrder.shift();
    if (drop === app.current) { app.hiOrder.push(drop); break; }
    const dn = app.nodes.get(drop);
    if (!dn || !dn.cubeHi) continue;
    const s = app.shells.get(drop);
    if (s) s.material.uniforms.uCube.value = dn.cubeBase;
    dn.cubeHi.dispose();
    dn.cubeHi = null;
    dn.hiSize = 0;
  }
}

/* --------------------------------------------------------------------- mesh */
function makeShell(node) {
  if (app.shells.has(node.id)) return app.shells.get(node.id);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uCube: { value: node.cubeHi || node.cubeBase },
      uDepth: { value: node.depthTex },
      uNear: { value: 0.15 },
      uFar: { value: app.tour.depth.far },
      uOpacity: { value: 1 },
      uWarp: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    depthWrite: true,
    depthTest: true,
    transparent: false,
  });
  const mesh = new THREE.Mesh(sphereGeo, mat);
  mesh.position.set(node.pos[0], node.pos[1], node.pos[2]);
  mesh.frustumCulled = false;
  mesh.renderOrder = 0;
  scene.add(mesh);
  app.shells.set(node.id, mesh);
  return mesh;
}

function releaseShellsExcept(keep) {
  for (const [id, mesh] of [...app.shells]) {
    if (keep.has(id)) continue;
    scene.remove(mesh);
    mesh.material.dispose();
    app.shells.delete(id);
  }
}

/* ----------------------------------------------------------------- hotspots */
function makeRingTexture() {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  const cx = S / 2;
  g.strokeStyle = 'rgba(255,255,255,0.95)';
  g.lineWidth = 9;
  g.beginPath(); g.arc(cx, cx, S * 0.33, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = 'rgba(60,40,25,0.35)';
  g.lineWidth = 3;
  g.beginPath(); g.arc(cx, cx, S * 0.33 + 6, 0, Math.PI * 2); g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.20)';
  g.beginPath(); g.arc(cx, cx, S * 0.28, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/* Links are ordered nearest-first by gen_tour.  With 17 viewpoints a busy
   spot can see a dozen others, and a dozen circles on the floor reads as
   clutter rather than choice, so only the nearest few that are actually
   within walking distance get drawn.  Everything stays reachable from the
   floor plan and the room buttons. */
const MAX_HOTSPOTS = 6;
const MAX_HOTSPOT_DIST = 4.6;

function buildHotspots() {
  for (const h of app.hotspots) {
    scene.remove(h);
    h.geometry.dispose();
    h.material.dispose();
  }
  app.hotspots = [];
  const cur = app.nodes.get(app.current);
  if (!cur) return;
  const here = new THREE.Vector3(...cur.pos);
  const shown = cur.links
    .filter(id => {
      const n = app.nodes.get(id);
      return n && !n.walk
        && here.distanceTo(new THREE.Vector3(...n.pos)) <= MAX_HOTSPOT_DIST;
    })
    .slice(0, MAX_HOTSPOTS);
  for (const id of shown) {
    const n = app.nodes.get(id);
    if (!n) continue;
    const mat = new THREE.MeshBasicMaterial({
      map: ringTex, transparent: true, depthTest: false, depthWrite: false,
      opacity: 0.85, toneMapped: false,
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.62), mat);
    m.position.set(n.pos[0], 0.02, n.pos[2]);
    m.rotation.x = -Math.PI / 2;
    m.renderOrder = 10;
    m.userData.nodeId = id;
    m.frustumCulled = false;
    scene.add(m);
    app.hotspots.push(m);
  }
}

function pickHotspot(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  const p = new THREE.Vector2(
    ((ev.clientX - r.left) / r.width) * 2 - 1,
    -((ev.clientY - r.top) / r.height) * 2 + 1
  );
  raycaster.setFromCamera(p, camera);
  const hits = raycaster.intersectObjects(app.hotspots, false);
  return hits.length ? hits[0].object : null;
}

/* ---------------------------------------------------------------- navigation */
/* The camera has a real position and moves continuously through the flat.
 * Whichever panorama is nearest is the one being drawn, warped by its depth
 * map to your actual position -- so between two viewpoints you get real
 * parallax, not a slideshow. Crossing the halfway point swaps panoramas
 * behind a short cross-fade.
 *
 * Candidates for "nearest" are limited to the current panorama and the ones
 * it can see. Plain Euclidean distance would happily snap you to a viewpoint
 * on the far side of the bedroom wall.
 */
const WALK_SPEED = 1.15;          // metres/second
const SWAP_FADE = 280;            // ms to cross-fade between panoramas
const SWAP_HYSTERESIS = 0.12;     // m the rival must beat the incumbent by

function setRoomTag(node) {
  $('roomtag-text').textContent = node.label;
  $('roomblurb').textContent = node.blurb || '';
  document.title = `${node.label} — ${app.tour.title}`;
  if (!node.walk) {
    try {
      history.replaceState(null, '', `#${node.id}`);
    } catch (e) { /* file:// has no history */ }
  }
  for (const b of $('rooms').children) {
    b.classList.toggle('on', b.dataset.room === node.room);
  }
  updateMap();
}

function nodeVec(n) { return new THREE.Vector3(n.pos[0], n.pos[1], n.pos[2]); }

/** Nearest loaded panorama to `pos`, searching only what the current one sees. */
function nearestNode(pos) {
  const cur = app.nodes.get(app.current);
  if (!cur) return null;
  const pool = [cur.id, ...cur.links];
  let best = app.current;
  let bestD = Math.hypot(pos.x - cur.pos[0], pos.z - cur.pos[2]) - SWAP_HYSTERESIS;
  for (const id of pool) {
    const n = app.nodes.get(id);
    if (!n) continue;
    const d = Math.hypot(pos.x - n.pos[0], pos.z - n.pos[2]);
    if (d >= bestD) continue;
    if (!n.cubeBase || !n.depthTex) {
      // walking towards something not built yet: start it, keep what we have
      ensureNode(id).catch(() => {});
      continue;
    }
    bestD = d; best = id;
  }
  return best;
}

/** Make `id` the panorama being drawn, cross-fading from the current one. */
function activate(id, { fade = true } = {}) {
  if (id === app.current && app.shells.has(id)) return;
  const node = app.nodes.get(id);
  if (!node || !node.cubeBase || !node.depthTex) return;
  const fromId = app.current;
  const shellB = makeShell(node);

  if (!fade || !fromId || !app.shells.has(fromId)) {
    shellB.material.uniforms.uOpacity.value = 1;
    shellB.material.uniforms.uWarp.value = 0;
    shellB.material.transparent = false;
    shellB.renderOrder = 0;
    app.current = id;
    releaseShellsExcept(new Set([id]));
    setRoomTag(node);
    buildHotspots();
    upgrade(id);
    prefetchNeighbours(id);
    return;
  }

  const shellA = app.shells.get(fromId);
  // The outgoing panorama is the backdrop, so it must never punch holes;
  // the incoming one may, and what shows through is the backdrop.
  shellA.material.transparent = false;
  shellA.material.depthTest = false;
  shellA.material.depthWrite = false;
  shellA.material.uniforms.uOpacity.value = 1;
  shellA.material.uniforms.uWarp.value = 0;
  shellA.renderOrder = 0;
  shellB.material.transparent = true;
  shellB.material.depthTest = false;
  shellB.material.depthWrite = false;
  shellB.material.uniforms.uOpacity.value = 0;
  shellB.renderOrder = 1;

  app.current = id;
  setRoomTag(node);
  upgrade(id);
  prefetchNeighbours(id);
  buildHotspots();
  app.fade = { fromId, toId: id, t0: performance.now(),
               dur: REDUCED_MOTION ? 80 : SWAP_FADE };
}

function stepFade(now) {
  const f = app.fade;
  if (!f) return;
  const shellB = app.shells.get(f.toId);
  if (!shellB) { app.fade = null; return; }
  const t = clamp((now - f.t0) / f.dur, 0, 1);
  shellB.material.uniforms.uOpacity.value = t;
  if (t >= 1) {
    shellB.material.transparent = false;
    shellB.material.depthTest = true;
    shellB.material.depthWrite = true;
    shellB.renderOrder = 0;
    releaseShellsExcept(new Set([f.toId]));
    app.fade = null;
  }
}

/** Walk to a position, steering and easing the view as we go. */
function glideTo(target, { turn = null, dur = null } = {}) {
  const from = app.pos.clone();
  const dist = Math.hypot(target.x - from.x, target.z - from.z);
  const d = dur != null ? dur
    : (REDUCED_MOTION ? 240 : clamp(320 + dist * 420, 380, 1500));
  app.glide = {
    from, to: target.clone(), t0: performance.now(), dur: d * (app.durScale || 1),
    yaw0: app.yaw, dYaw: turn == null ? 0 : shortestAngle(app.yaw, turn),
    pitch0: app.pitch, dPitch: turn == null ? 0 : DEFAULT_PITCH - app.pitch,
  };
}

function stepGlide(now) {
  const g = app.glide;
  if (!g) return;
  const raw = clamp((now - g.t0) / g.dur, 0, 1);
  const t = easeInOut(raw);
  app.pos.x = lerp(g.from.x, g.to.x, t);
  app.pos.z = lerp(g.from.z, g.to.z, t);
  if (g.dYaw) app.yaw = g.yaw0 + g.dYaw * t;
  if (g.dPitch) app.pitch = g.pitch0 + g.dPitch * t;
  if (raw >= 1) {
    app.glide = null;
    const q = app.pending;
    if (q) { app.pending = null; goTo(q.id, q.opts); }
  }
}

/** Public: walk to a named viewpoint. */
async function goTo(id, { turn = false, instant = false } = {}) {
  const to = app.nodes.get(id);
  if (!to) return;
  if (app.glide && !instant) { app.pending = { id, opts: { turn, instant } }; return; }

  $('loadbar').classList.remove('hidden');
  $('loadbar-fill').style.width = '20%';
  try {
    await ensureNode(id);
  } catch (e) {
    console.error('could not load viewpoint', id, e);
    $('loadbar').classList.add('hidden');
    const tag = $('roomtag-text');
    const was = tag.textContent;
    tag.textContent = 'That room would not load — try another';
    setTimeout(() => { if (tag.textContent.startsWith('That room')) tag.textContent = was; }, 4000);
    stopGuided();
    return;
  }
  $('loadbar-fill').style.width = '100%';
  setTimeout(() => {
    $('loadbar').classList.add('hidden');
    $('loadbar-fill').style.width = '0';
  }, 300);

  if (instant || !app.current) {
    app.pos.set(to.pos[0], to.pos[1], to.pos[2]);
    app.glide = null;
    activate(id, { fade: false });
    return;
  }
  glideTo(nodeVec(to), { turn: turn ? to.heading * DEG : null });
}

/** Called every frame: move, then make sure the right panorama is showing. */
function stepMovement(now, dt) {
  if (app.glide) { stepGlide(now); }
  else if (app.moveDir) {
    const v = WALK_SPEED * dt * app.moveDir;
    moveWithin(app.pos, -Math.sin(app.yaw) * v, -Math.cos(app.yaw) * v);
  }
  const want = nearestNode(app.pos);
  if (want && want !== app.current) activate(want);
  camera.position.copy(app.pos);

  // how far off its own centre each visible panorama is being viewed from
  const WARP_FULL = 0.85;
  for (const [id, mesh] of app.shells) {
    if (app.fade && id === app.fade.fromId) continue;   // backdrop: no holes
    const n = app.nodes.get(id);
    const d = Math.hypot(app.pos.x - n.pos[0], app.pos.z - n.pos[2]);
    mesh.material.uniforms.uWarp.value =
      app.shells.size > 1 ? clamp(d / WARP_FULL, 0, 1) : 0;
  }
  stepFade(now);
}

/* -------------------------------------------------------------- guided tour */
function startGuided() {
  if (app.guided) return stopGuided();
  app.guided = { i: app.tour.route.indexOf(app.current), wait: 0, spin: 0 };
  $('tour-btn').classList.add('on');
  $('tour-label').textContent = 'Stop the tour';
  advanceGuided();
}

function stopGuided() {
  app.guided = null;
  $('tour-btn').classList.remove('on');
  $('tour-label').textContent = 'Show me around';
}

async function advanceGuided() {
  if (!app.guided) return;
  app.guided.i = (app.guided.i + 1) % app.tour.route.length;
  const id = app.tour.route[app.guided.i];
  await goTo(id, { turn: true });
  if (!app.guided) return;
  app.guided.spin = performance.now() + 900;      // drift the view a little
  app.guided.wait = performance.now() + 5200;
}

function stepGuided(now, dt) {
  const g = app.guided;
  if (!g || app.glide) return;
  if (now > g.spin) app.yaw += 0.16 * dt;
  if (now > g.wait) { g.wait = Infinity; advanceGuided(); }
}

/* ------------------------------------------------------------------ controls */

/* A strict 1:1 drag -- where the pixel you grabbed stays under the cursor --
   is the "correct" mapping and is horrible to use: turning right round took
   2000 px of dragging, so you physically could not look behind you without
   letting go and starting again.  A gain of 2 puts a half turn inside one
   screen width. */
const DRAG_GAIN = 2.0;
const TURN_SPEED = 80 * DEG;      // radians/second for the arrows and keys
const TURN_NUDGE = 32 * DEG;      // a plain click on an arrow
const GLIDE_HALFLIFE = 70;        // ms for a flick to lose half its speed
/* Total coast after release is roughly vel * HALFLIFE / ln2, so this cap is
   what keeps a hard flick from spinning the room: 0.006 rad/ms works out to
   about 35 degrees of glide, which reads as momentum rather than a loss of
   control. */
const VEL_CLAMP = 0.006;
const PITCH_LIMIT = 85 * DEG;
const WALK_RADIUS = 2.6;          // how near a floor click must land

function dragScale() {
  return DRAG_GAIN * (app.fov * DEG) / renderer.domElement.clientHeight;
}

/* Where a click on the floor points, so the whole floor is a target rather
   than just the rings.  Rings show where you *can* go; this makes hitting
   them forgiving. */
const FLOOR = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

function pickFloorTarget(ev) {
  const cur = app.nodes.get(app.current);
  if (!cur) return null;
  const r = renderer.domElement.getBoundingClientRect();
  const p = new THREE.Vector2(
    ((ev.clientX - r.left) / r.width) * 2 - 1,
    -((ev.clientY - r.top) / r.height) * 2 + 1
  );
  raycaster.setFromCamera(p, camera);
  if (raycaster.ray.direction.y > -0.02) return null;   // aimed at or above the horizon
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(FLOOR, hit)) return null;
  let best = null, bestD = WALK_RADIUS;
  for (const id of cur.links) {
    const n = app.nodes.get(id);
    if (!n) continue;
    const d = Math.hypot(n.pos[0] - hit.x, n.pos[2] - hit.z);
    if (d < bestD) { bestD = d; best = id; }
  }
  return best;
}

function bindControls(el) {
  let pid = null, last = null, lastT = 0;
  const pinch = { active: false, d0: 0, zoom0: 1, ids: new Map() };

  const showLabel = (id, x, y) => {
    const lab = $('spot-label');
    if (!id) { lab.classList.add('hidden'); return; }
    lab.textContent = `Walk to the ${app.nodes.get(id).label.toLowerCase()}`;
    lab.style.left = `${x}px`;
    lab.style.top = `${y - 46}px`;
    lab.classList.remove('hidden');
  };

  el.addEventListener('pointerdown', ev => {
    pinch.ids.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pinch.ids.size === 2) {
      const [p, q] = [...pinch.ids.values()];
      pinch.active = true;
      pinch.d0 = Math.hypot(p.x - q.x, p.y - q.y);
      pinch.zoom0 = app.zoom;
      app.dragging = false;
      return;
    }
    if (pinch.ids.size > 1) return;
    // Capture keeps the drag alive if the cursor leaves the canvas. It can
    // throw for a pointer the browser no longer considers active, which must
    // not take the whole drag down with it.
    try { el.setPointerCapture(ev.pointerId); } catch (e) { /* non-fatal */ }
    pid = ev.pointerId;
    app.dragging = true;
    app.moved = 0;
    last = { x: ev.clientX, y: ev.clientY };
    lastT = performance.now();
    app.yawVel = app.pitchVel = 0;
    el.classList.add('dragging');
    hideHint();
    if (app.guided) stopGuided();
  });

  el.addEventListener('pointermove', ev => {
    if (pinch.ids.has(ev.pointerId)) {
      pinch.ids.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    }
    if (pinch.active && pinch.ids.size >= 2) {
      const [p, q] = [...pinch.ids.values()];
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (pinch.d0 > 0 && d > 0) {
        app.zoom = clamp(pinch.zoom0 * (pinch.d0 / d), 0.45, 1.25);
        applyZoom();
      }
      return;
    }

    if (!app.dragging || ev.pointerId !== pid) {
      if (app.glide) return;
      const h = pickHotspot(ev);
      if (h !== app.hovered) {
        if (app.hovered) app.hovered.material.opacity = 0.85;
        app.hovered = h;
        if (h) h.material.opacity = 1;
      }
      const target = h ? h.userData.nodeId : pickFloorTarget(ev);
      el.style.cursor = target ? 'pointer' : '';
      showLabel(target, ev.clientX, ev.clientY);
      return;
    }

    const now = performance.now();
    const dt = Math.max(1, now - lastT);
    const dx = ev.clientX - last.x, dy = ev.clientY - last.y;
    last = { x: ev.clientX, y: ev.clientY };
    lastT = now;
    app.moved += Math.abs(dx) + Math.abs(dy);
    const s = dragScale();
    app.yaw -= dx * s;
    app.pitch = clamp(app.pitch - dy * s, -PITCH_LIMIT, PITCH_LIMIT);
    // Radians per millisecond, so a flick feels the same at any frame rate.
    // Smoothed, because a single pointermove is noisy and the last one before
    // release would otherwise decide the whole glide.
    const vy = clamp(-dx * s / dt, -VEL_CLAMP, VEL_CLAMP);
    const vp = clamp(-dy * s / dt, -VEL_CLAMP, VEL_CLAMP);
    app.yawVel = app.yawVel * 0.6 + vy * 0.4;
    app.pitchVel = app.pitchVel * 0.6 + vp * 0.4;
  });

  const end = ev => {
    pinch.ids.delete(ev.pointerId);
    if (pinch.ids.size < 2) pinch.active = false;
    if (ev.pointerId !== pid) return;
    pid = null;
    el.classList.remove('dragging');
    if (!app.dragging) return;
    app.dragging = false;
    // a long pause before releasing is a park, not a flick
    if (performance.now() - lastT > 120) app.yawVel = app.pitchVel = 0;
    if (app.moved < 8 && !app.glide) {
      const h = pickHotspot(ev);
      const target = h ? h.userData.nodeId : pickFloorTarget(ev);
      if (target) {
        $('spot-label').classList.add('hidden');
        stopGuided();
        goTo(target);
      }
    }
  };
  el.addEventListener('pointerleave', () => $('spot-label').classList.add('hidden'));
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  /* One trackpad flick is a dozen wheel events; stepping the zoom per event
     slammed it to the limit in a single gesture.  Scale by the distance
     scrolled instead, gently. */
  el.addEventListener('wheel', ev => {
    ev.preventDefault();
    const d = clamp(ev.deltaY, -60, 60);
    app.zoom = clamp(app.zoom * Math.exp(d * 0.0016), 0.45, 1.25);
    applyZoom();
    hideHint();
  }, { passive: false });

  /* ---- turn arrows: hold to keep turning, or just click for a nudge ---- */
  const holdArrow = (btn, dir) => {
    let held = false, moved = false, t0 = 0;
    const start = ev => {
      ev.preventDefault();
      held = true; moved = false; t0 = performance.now();
      app.turnDir = dir;
      app.yawVel = 0;
      hideHint();
      if (app.guided) stopGuided();
      btn.setPointerCapture?.(ev.pointerId);
    };
    const stop = () => {
      if (!held) return;
      held = false;
      app.turnDir = 0;
      // a tap should still do something visible
      if (performance.now() - t0 < 180 && !moved) app.yaw -= dir * TURN_NUDGE;
    };
    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('pointerleave', stop);
    btn.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); app.yaw -= dir * TURN_NUDGE; }
    });
  };
  holdArrow($('turn-left'), -1);
  holdArrow($('turn-right'), 1);

  const walkBtn = $('walk');
  const walkStart = ev => {
    ev.preventDefault();
    app.walkBtn = true;
    app.moveDir = 1;
    app.glide = null;               // a held walk overrides an automated one
    hideHint();
    if (app.guided) stopGuided();
    walkBtn.setPointerCapture?.(ev.pointerId);
  };
  const walkStop = () => { app.walkBtn = false; app.moveDir = 0; };
  walkBtn.addEventListener('pointerdown', walkStart);
  walkBtn.addEventListener('pointerup', walkStop);
  walkBtn.addEventListener('pointercancel', walkStop);
  walkBtn.addEventListener('pointerleave', walkStop);
  walkBtn.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); app.walkBtn = true; app.moveDir = 1; }
  });
  walkBtn.addEventListener('keyup', walkStop);

  /* ---- keyboard: hold to keep turning rather than stepping ---- */
  const keys = new Set();
  window.addEventListener('keydown', ev => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key === 'Escape') { stopGuided(); $('help').classList.add('hidden'); return; }
    if (ev.key === 'Enter' || ev.key === ' ') {
      // walk to whichever reachable viewpoint is most nearly straight ahead
      const cur = app.nodes.get(app.current);
      if (!cur || app.glide) return;
      const fx = -Math.sin(app.yaw), fz = -Math.cos(app.yaw);
      let best = null, bestDot = 0.55;
      for (const id of cur.links) {
        const n = app.nodes.get(id);
        const dx = n.pos[0] - cur.pos[0], dz = n.pos[2] - cur.pos[2];
        const len = Math.hypot(dx, dz) || 1;
        const dot = (dx / len) * fx + (dz / len) * fz;
        if (dot > bestDot) { bestDot = dot; best = id; }
      }
      if (best) { ev.preventDefault(); stopGuided(); goTo(best); }
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(ev.key)) return;
    ev.preventDefault();
    keys.add(ev.key);
    // up/down walk rather than tilt: far more useful in a tour, and it is
    // what people expect from Street View. Pitch stays on drag.
    if (ev.key === 'ArrowUp') app.moveDir = 1;
    if (ev.key === 'ArrowDown') app.moveDir = -1;
    hideHint();
  });
  window.addEventListener('keyup', ev => {
    keys.delete(ev.key);
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      if (!keys.has('ArrowUp') && !keys.has('ArrowDown') && !app.walkBtn) app.moveDir = 0;
    }
  });
  window.addEventListener('blur', () => {
    keys.clear(); app.turnDir = 0; app.moveDir = 0; app.walkBtn = false;
  });
  app._keys = keys;
}

let hintTimer = null;
function hideHint() {
  clearTimeout(hintTimer);
  $('hint').classList.add('hidden');
}

/* ----------------------------------------------------------------- floorplan */
function planXY(node) {
  const p = app.tour.plan;
  const bx = node.pos[0], by = -node.pos[2];
  return {
    x: ((bx - p.x0) / (p.x1 - p.x0)) * 100,
    y: ((p.y1 - by) / (p.y1 - p.y0)) * 100,
  };
}

function buildMap() {
  const img = $('map-img');
  img.src = app.tour.plan.image;
  const svg = $('map-svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.innerHTML = '';
  const ns = 'http://www.w3.org/2000/svg';

  const cone = document.createElementNS(ns, 'path');
  cone.setAttribute('id', 'map-cone');
  cone.setAttribute('fill', 'rgba(154,91,44,.32)');
  svg.appendChild(cone);

  for (const n of app.tour.nodes) {
    if (n.walk) continue;   // not a destination
    const { x, y } = planXY(n);
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('class', 'mapdot');
    g.dataset.id = n.id;
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', x); c.setAttribute('cy', y);
    c.setAttribute('r', 1.7);
    c.setAttribute('vector-effect', 'non-scaling-stroke');
    c.setAttribute('fill', 'rgba(255,255,255,.9)');
    c.setAttribute('stroke', '#9a5b2c');
    c.setAttribute('stroke-width', '2');
    const hit = document.createElementNS(ns, 'circle');
    hit.setAttribute('cx', x); hit.setAttribute('cy', y);
    hit.setAttribute('r', 4); hit.setAttribute('fill', 'transparent');
    g.appendChild(c); g.appendChild(hit);
    const jump = () => { stopGuided(); goTo(n.id, { turn: true }); };
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', `Go to ${n.label}`);
    g.addEventListener('click', jump);
    g.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(); }
    });
    const title = document.createElementNS(ns, 'title');
    title.textContent = n.label;
    g.appendChild(title);
    svg.appendChild(g);
  }
}

function nearestNamed() {
  const cur = app.nodes.get(app.current);
  if (!cur) return null;
  if (!cur.walk) return cur.id;
  let best = null, bestD = Infinity;
  for (const n of app.tour.nodes) {
    if (n.walk) continue;
    const d = Math.hypot(cur.pos[0] - n.pos[0], cur.pos[2] - n.pos[2]);
    if (d < bestD) { bestD = d; best = n.id; }
  }
  return best;
}

function updateMap() {
  const svg = $('map-svg');
  if (!svg) return;
  const here = nearestNamed();
  for (const g of svg.querySelectorAll('.mapdot')) {
    const on = g.dataset.id === here;
    const c = g.querySelector('circle');
    c.setAttribute('r', on ? 2.8 : 1.7);
    c.setAttribute('fill', on ? '#9a5b2c' : 'rgba(255,255,255,.9)');
  }
}

function updateCone() {
  const cone = document.getElementById('map-cone');
  if (!cone || !app.pos) return;
  const { x, y } = planXY({ pos: [app.pos.x, app.pos.y, app.pos.z] });
  // yaw 0 looks down -Z (three) == +y in blender == up on the plan
  const half = (app.fov * DEG) / 2;
  const R = 11;
  const pt = ang => `${x + Math.sin(ang) * R * 0.62},${y - Math.cos(ang) * R}`;
  cone.setAttribute('d', `M${x},${y} L${pt(app.yaw - half)} A${R} ${R} 0 0 1 ${pt(app.yaw + half)} Z`);
}

/* ------------------------------------------------------------------ bootstrap */
function buildRoomButtons() {
  const host = $('rooms');
  host.innerHTML = '';
  for (const r of app.tour.rooms) {
    const b = document.createElement('button');
    b.className = 'big-btn';
    b.textContent = r.name;
    b.dataset.room = r.name;
    b.addEventListener('click', () => {
      stopGuided();
      const cur = app.nodes.get(app.current);
      // tapping the room you are already in cycles through its viewpoints
      let target = r.primary;
      if (cur && cur.room === r.name && r.nodes.length > 1) {
        target = r.nodes[(r.nodes.indexOf(app.current) + 1) % r.nodes.length];
      }
      goTo(target, { turn: true });
    });
    host.appendChild(b);
  }
}

/* three.js takes a *vertical* fov, but what a room should feel like is set by
   how much of it you see side to side.  Aim for a fixed horizontal field and
   derive the vertical one, clamped so a tall phone does not turn into a
   fisheye. */
const HFOV = 85 * DEG, VFOV_MIN = 52 * DEG, VFOV_MAX = 100 * DEG;

function baseFov(aspect) {
  const v = 2 * Math.atan(Math.tan(HFOV / 2) / aspect);
  return clamp(v, VFOV_MIN, VFOV_MAX) / DEG;
}

function applyZoom() {
  const aspect = window.innerWidth / Math.max(1, window.innerHeight);
  app.fov = clamp(baseFov(aspect) * app.zoom, 30, 100);
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  applyZoom();
  camera.updateProjectionMatrix();
  syncBarHeight();
}

/* Keep the floor plan clear of the button bar at every size. */
function syncBarHeight() {
  const bar = $('bar');
  if (bar) {
    document.documentElement.style.setProperty('--bar-h', `${Math.ceil(bar.offsetHeight)}px`);
  }
}

let lastFrame = performance.now();
let running = true;

/* Stop drawing when the tab is not on screen.  Costs nothing to add and keeps
   a forgotten background tab from sitting on the GPU (and the battery). */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    running = false;
  } else if (!running) {
    running = true;
    lastFrame = performance.now();
    requestAnimationFrame(frame);
  }
});

/* The body of a frame, separated from the scheduling so it can be stepped
   deterministically -- browsers stop requestAnimationFrame for a hidden tab,
   which otherwise makes anything time-driven impossible to test. */
function tick(now, dt) {
  if (!app.dragging && !app.glide) {
    const dtMs = dt * 1000;
    const keys = app._keys;
    let turn = app.turnDir;
    const tilt = 0;
    if (keys) {
      if (keys.has('ArrowLeft')) turn -= 1;
      if (keys.has('ArrowRight')) turn += 1;

    }
    if (turn) {
      app.yaw -= turn * TURN_SPEED * dt;
      app.yawVel = 0;
    }
    if (!turn && !tilt) {
      // velocities are radians per millisecond, so the glide is the same
      // length in seconds whatever the frame rate
      app.yaw += app.yawVel * dtMs;
      app.pitch = clamp(app.pitch + app.pitchVel * dtMs, -PITCH_LIMIT, PITCH_LIMIT);
      const decay = Math.pow(0.5, dtMs / GLIDE_HALFLIFE);
      app.yawVel *= decay;
      app.pitchVel *= decay;
      if (Math.abs(app.yawVel) < 1e-6) app.yawVel = 0;
      if (Math.abs(app.pitchVel) < 1e-6) app.pitchVel = 0;
    }
  }

  stepMovement(now, dt);
  stepGuided(now, dt);

  camera.rotation.set(app.pitch, app.yaw, 0, 'YXZ');
  if (Math.abs(camera.fov - app.fov) > 0.01) {
    camera.fov = app.fov;
    camera.updateProjectionMatrix();
  }
  updateCone();
  renderer.render(scene, camera);
}

function frame(now) {
  if (!running) return;
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;
  tick(now, dt);
}

async function boot() {
  const canvas = $('view');
  try {
    renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: false, powerPreference: 'high-performance',
    });
  } catch (e) {
    $('splash').classList.add('hidden');
    $('nomap').classList.remove('hidden');
    return;
  }
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;  // note (1): passthrough
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x14120f, 1);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(app.fov, 1, 0.05, 120);
  camera.rotation.order = 'YXZ';
  raycaster = new THREE.Raycaster();
  app.pos = new THREE.Vector3(0, app.tourEye || 1.55, 0);
  ringTex = makeRingTexture();

  window.__tour = app;   // debug handle: __tour.yaw / .fov / .goTo(id) / .durScale
  app.goTo = goTo;
  app._tick = tick;        // step a frame by hand (testing)
  app._three = { get camera() { return camera; }, get renderer() { return renderer; },
                 get scene() { return scene; } };

  app.tour = await (await fetch(`data/tour.json?v=${BUILD}`)).json();
  app.pos.y = app.tour.eye;
  initWalkMask(app.tour.walk);
  for (const n of app.tour.nodes) app.nodes.set(n.id, n);
  $('splash-title').textContent = app.tour.title;
  document.title = app.tour.title;

  const d = app.tour.depth;
  sphereGeo = new THREE.SphereGeometry(1, d.width, d.height);

  app.tour.tiers = pickTiers(app.tour.tiers);
  console.info('panorama tiers:', app.tour.tiers.join(' -> '));

  buildRoomButtons();
  buildMap();
  resize();
  window.addEventListener('resize', resize);
  bindControls(canvas);

  // Enough to open the door: the first viewpoint. The rest streams in behind.
  // tolerate anything appended to the fragment
  const linked = decodeURIComponent(
    (location.hash || '').replace(/^#/, '').split(/[&?]/)[0]
  );
  const first = (app.nodes.has(linked) && linked)
    || app.tour.start || app.tour.route[0] || app.tour.nodes[0].id;
  $('splash-status').textContent = 'Loading the first room…';
  await ensureNode(first);
  $('splash-bar').style.width = '100%';
  $('splash-status').textContent = 'Ready.';
  const startBtn = $('start');
  startBtn.disabled = false;

  requestAnimationFrame(frame);

  let loaded = 1;
  const rest = app.tour.nodes.map(n => n.id).filter(id => id !== first);
  Promise.all(rest.map(id => prefetchCubeFiles(id).then(() => {
    loaded++;
    $('splash-status').textContent =
      `Ready. (${loaded} of ${app.tour.nodes.length} viewpoints loaded)`;
  }).catch(() => {})));

  startBtn.addEventListener('click', async () => {
    $('splash').classList.add('hidden');
    const n = app.nodes.get(first);
    app.yaw = n.heading * DEG;
    app.pitch = DEFAULT_PITCH;
    await goTo(first, { instant: true });
    $('hint').classList.remove('hidden');
    hintTimer = setTimeout(hideHint, 6000);
  });

  $('help-open').addEventListener('click', () => $('help').classList.remove('hidden'));
  $('help-close').addEventListener('click', () => $('help').classList.add('hidden'));
  $('tour-btn').addEventListener('click', startGuided);
  $('map-toggle').addEventListener('click', () => $('map').classList.toggle('collapsed'));

  const fs = $('fs');
  if (!document.documentElement.requestFullscreen) {
    fs.style.display = 'none';
  } else {
    fs.addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    });
  }
}

boot().catch(err => {
  console.error(err);
  // The likely cause by a mile: the folder was opened by double-clicking
  // index.html.  Browsers refuse to fetch the tour data over file://, and the
  // error they give is useless, so name the actual problem.
  const offline = location.protocol === 'file:';
  $('splash-status').innerHTML = offline
    ? 'This page has to be opened from a web address, not from a file on the '
      + 'computer. Use the link you were sent.'
    : 'Something went wrong loading the tour. Refreshing the page usually fixes it.';
  $('splash-status').style.color = '#8a3b1f';
  $('start').disabled = true;
});
