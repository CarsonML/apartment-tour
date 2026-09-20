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

const BUILD = '1e3fca55';   // stamped by pipeline/version.py

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

/* -------------------------------------------------------------------- state */
const app = {
  tour: null,
  nodes: new Map(),
  current: null,
  shells: new Map(),     // id -> Mesh
  hiOrder: [],           // LRU of ids holding a high-res cube texture
  baseOrder: [],         // LRU of ids holding a base cube texture
  yaw: 0, pitch: DEFAULT_PITCH, fov: 72, zoom: 1,
  yawVel: 0, pitchVel: 0,
  dragging: false, moved: 0,
  transition: null,
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
      return n && here.distanceTo(new THREE.Vector3(...n.pos)) <= MAX_HOTSPOT_DIST;
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
function setRoomTag(node) {
  $('roomtag-text').textContent = node.label;
  $('roomblurb').textContent = node.blurb || '';
  document.title = `${node.label} — ${app.tour.title}`;
  // so a link can point at one spot: "look at the kitchen"
  try {
    history.replaceState(null, '', `#${node.id}`);
  } catch (e) { /* file:// has no history */ }
  for (const b of $('rooms').children) {
    b.classList.toggle('on', b.dataset.room === node.room);
  }
  updateMap();
}

async function goTo(id, { turn = false, instant = false } = {}) {
  if (id === app.current) return;
  if (app.transition) {
    // Taking a second click mid-walk and dropping it feels broken; hold it.
    app.pending = { id, opts: { turn, instant } };
    return;
  }
  const to = app.nodes.get(id);
  if (!to) return;

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

  const from = app.current ? app.nodes.get(app.current) : null;
  const shellB = makeShell(to);

  if (!from || instant) {
    camera.position.set(to.pos[0], to.pos[1], to.pos[2]);
    shellB.material.uniforms.uOpacity.value = 1;
    app.current = id;
    releaseShellsExcept(new Set([id]));
    setRoomTag(to);
    buildHotspots();
    upgrade(id);
    prefetchNeighbours(id);
    return;
  }

  const shellA = app.shells.get(from.id);
  for (const s of [shellA, shellB]) {
    s.material.transparent = true;
    s.material.depthTest = false;
    s.material.depthWrite = false;
  }
  shellA.renderOrder = 0;
  shellB.renderOrder = 1;
  shellB.material.uniforms.uOpacity.value = 0;

  for (const h of app.hotspots) h.visible = false;

  const a = new THREE.Vector3(...from.pos);
  const b = new THREE.Vector3(...to.pos);
  const dist = a.distanceTo(b);
  const dur = (REDUCED_MOTION ? 260 : clamp(560 + dist * 190, 620, 1500))
    * (app.durScale || 1);
  const yaw0 = app.yaw;
  const dYaw = turn ? shortestAngle(app.yaw, to.heading * DEG) : 0;
  const pitch0 = app.pitch;
  const dPitch = turn ? DEFAULT_PITCH - app.pitch : 0;

  app.current = id;
  setRoomTag(to);
  upgrade(id);

  app.transition = {
    t0: performance.now(), dur, a, b, shellA, shellB, yaw0, dYaw, pitch0, dPitch,
    done() {
      shellB.material.transparent = false;
      shellB.material.depthTest = true;
      shellB.material.depthWrite = true;
      shellB.material.uniforms.uOpacity.value = 1;
      shellB.material.uniforms.uWarp.value = 0;
      shellB.renderOrder = 0;
      releaseShellsExcept(new Set([id]));
      buildHotspots();
      prefetchNeighbours(id);
      app.transition = null;
      const q = app.pending;
      if (q) { app.pending = null; goTo(q.id, q.opts); }
    },
  };
}

function stepTransition(now) {
  const tr = app.transition;
  if (!tr) return;
  const raw = clamp((now - tr.t0) / tr.dur, 0, 1);
  const t = easeInOut(raw);
  camera.position.lerpVectors(tr.a, tr.b, t);
  tr.shellB.material.uniforms.uOpacity.value = smoothstep(0.12, 0.92, raw);
  // how far each panorama is being viewed from off its own centre
  const WARP_FULL = 0.9;
  tr.shellA.material.uniforms.uWarp.value =
    clamp(camera.position.distanceTo(tr.a) / WARP_FULL, 0, 1);
  tr.shellB.material.uniforms.uWarp.value =
    clamp(camera.position.distanceTo(tr.b) / WARP_FULL, 0, 1);
  if (tr.dYaw) app.yaw = tr.yaw0 + tr.dYaw * t;
  if (tr.dPitch) app.pitch = tr.pitch0 + tr.dPitch * t;
  if (raw >= 1) tr.done();
}

function prefetchNeighbours(id) {
  const n = app.nodes.get(id);
  if (!n) return;
  // whichever way they step next, the depth map is already here
  n.links.slice(0, 4).forEach(l => { ensureDepth(l).catch(() => {}); });
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
  if (!g || app.transition) return;
  if (now > g.spin) app.yaw += 0.16 * dt;
  if (now > g.wait) { g.wait = Infinity; advanceGuided(); }
}

/* ------------------------------------------------------------------ controls */
function dragScale() { return (app.fov * DEG) / renderer.domElement.clientHeight; }

function bindControls(el) {
  let last = null, pid = null;
  const pinch = { active: false, d0: 0, fov0: 0, ids: new Map() };

  el.addEventListener('pointerdown', ev => {
    pinch.ids.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pinch.ids.size === 2) {
      const [p, q] = [...pinch.ids.values()];
      pinch.active = true;
      pinch.d0 = Math.hypot(p.x - q.x, p.y - q.y);
      pinch.fov0 = app.zoom;
      app.dragging = false;
      return;
    }
    if (pinch.ids.size > 1) return;
    el.setPointerCapture(ev.pointerId);
    pid = ev.pointerId;
    app.dragging = true;
    app.moved = 0;
    last = { x: ev.clientX, y: ev.clientY };
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
      if (pinch.d0 > 0) {
        app.zoom = clamp(pinch.fov0 * (pinch.d0 / d), 0.45, 1.25);
        applyZoom();
      }
      return;
    }
    if (!app.dragging || ev.pointerId !== pid) {
      if (!app.transition) {
        const h = pickHotspot(ev);
        if (h !== app.hovered) {
          if (app.hovered) app.hovered.material.opacity = 0.85;
          app.hovered = h;
          if (h) h.material.opacity = 1;
          el.style.cursor = h ? 'pointer' : '';
        }
        const lab = $('spot-label');
        if (h) {
          const n = app.nodes.get(h.userData.nodeId);
          lab.textContent = `Walk to the ${n.label.toLowerCase()}`;
          lab.style.left = `${ev.clientX}px`;
          lab.style.top = `${ev.clientY - 46}px`;
          lab.classList.remove('hidden');
        } else {
          lab.classList.add('hidden');
        }
      }
      return;
    }
    const dx = ev.clientX - last.x, dy = ev.clientY - last.y;
    last = { x: ev.clientX, y: ev.clientY };
    app.moved += Math.abs(dx) + Math.abs(dy);
    const s = dragScale();
    app.yaw -= dx * s;
    app.pitch = clamp(app.pitch - dy * s, -85 * DEG, 85 * DEG);
    app.yawVel = -dx * s;
    app.pitchVel = -dy * s;
  });

  const end = ev => {
    pinch.ids.delete(ev.pointerId);
    if (pinch.ids.size < 2) pinch.active = false;
    if (ev.pointerId !== pid) return;
    pid = null;
    el.classList.remove('dragging');
    if (!app.dragging) return;
    app.dragging = false;
    if (app.moved < 8 && !app.transition) {
      const h = pickHotspot(ev);
      if (h) { $('spot-label').classList.add('hidden'); stopGuided(); goTo(h.userData.nodeId); }
    }
  };
  el.addEventListener('pointerleave', () => $('spot-label').classList.add('hidden'));
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  el.addEventListener('wheel', ev => {
    ev.preventDefault();
    app.zoom = clamp(app.zoom + Math.sign(ev.deltaY) * 0.06, 0.45, 1.25);
    applyZoom();
  }, { passive: false });

  window.addEventListener('keydown', ev => {
    const step = 6 * DEG;
    if (ev.key === 'ArrowLeft') app.yaw += step;
    else if (ev.key === 'ArrowRight') app.yaw -= step;
    else if (ev.key === 'ArrowUp') app.pitch = clamp(app.pitch + step, -85 * DEG, 85 * DEG);
    else if (ev.key === 'ArrowDown') app.pitch = clamp(app.pitch - step, -85 * DEG, 85 * DEG);
    else if (ev.key === 'Escape') { stopGuided(); $('help').classList.add('hidden'); }
    else return;
    ev.preventDefault();
    hideHint();
  });
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

function updateMap() {
  const svg = $('map-svg');
  if (!svg) return;
  for (const g of svg.querySelectorAll('.mapdot')) {
    const on = g.dataset.id === app.current;
    const c = g.querySelector('circle');
    c.setAttribute('r', on ? 2.8 : 1.7);
    c.setAttribute('fill', on ? '#9a5b2c' : 'rgba(255,255,255,.9)');
  }
}

function updateCone() {
  const cone = document.getElementById('map-cone');
  const cur = app.nodes.get(app.current);
  if (!cone || !cur) return;
  const { x, y } = planXY(cur);
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

function frame(now) {
  if (!running) return;
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  if (!app.dragging && !app.transition) {
    app.yaw += app.yawVel;
    app.pitch = clamp(app.pitch + app.pitchVel, -85 * DEG, 85 * DEG);
    app.yawVel *= 0.90;
    app.pitchVel *= 0.90;
    if (Math.abs(app.yawVel) < 1e-5) app.yawVel = 0;
    if (Math.abs(app.pitchVel) < 1e-5) app.pitchVel = 0;
  }

  stepTransition(now);
  stepGuided(now, dt);

  camera.rotation.set(app.pitch, app.yaw, 0, 'YXZ');
  if (Math.abs(camera.fov - app.fov) > 0.01) {
    camera.fov = app.fov;
    camera.updateProjectionMatrix();
  }
  updateCone();
  renderer.render(scene, camera);
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
  ringTex = makeRingTexture();

  window.__tour = app;   // debug handle: __tour.yaw / .fov / .goTo(id) / .durScale
  app.goTo = goTo;
  app._three = { get camera() { return camera; }, get renderer() { return renderer; },
                 get scene() { return scene; } };

  app.tour = await (await fetch(`data/tour.json?v=${BUILD}`)).json();
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
