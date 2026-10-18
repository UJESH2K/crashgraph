// 3D renderer for the Box2D lander. Physics stays 2D (x, y, angle); the scene adds depth, light and weather.
//
// Optional photoreal assets, dropped into web/assets/ (see README - they are not in the repo):
//   vikram.glb     ISRO Chandrayaan-3 Vikram lander, used in place of the built-in blocky lander
//   petavius.glb   lunar surface scan; its colour and normal maps are painted onto our own terrain
//                  mesh rather than its geometry being used, so the ground the lander touches stays
//                  exactly the Box2D profile the physics computed.
// Everything degrades cleanly: with no assets the scene renders its procedural lander and terrain.
import * as THREE from "three";
import { GLTFLoader } from "./vendor/GLTFLoader.js";
import { OrbitControls } from "./vendor/OrbitControls.js";

const ASSETS = {
  lander: "/static/assets/vikram.glb",
  moon: "/static/assets/petavius.glb",
  sky: "/static/assets/nebula.glb",
};

/* The skybox rides with the camera so it reads as infinitely far away. The starfield stays
   fixed in world space, so moving the camera slides the stars against the nebula and the
   depth of the sky comes out on its own. */
const SKY_R = 320;

/* The console should open on a real place, not an empty void: Gymnasium's lander flies in a
   20 x 13.33 world with the pad at y = H/4, so stand in a plausible version of that until the
   first attempt sends the terrain it actually generated. */
const DEFAULT_TERRAIN = {
  w: 20, h: 13.33,
  pad: [8.2, 11.8, 3.33],
  ground: [[0, 4.1], [2, 3.0], [4, 4.4], [6, 3.6], [8.2, 3.33], [11.8, 3.33],
           [14, 4.2], [16, 3.2], [18, 4.6], [20, 3.9]],
};

const THEMES = {
  luna:  { bg: 0x03050a, fog: 0x03050a, fogD: 0.006, ground: 0x8f9098, ground2: 0x5d5e66, sun: 0xffffff, sunI: 2.6, hemi: 0x263046, sky: "earth", dust: 0xb9b9c0, wind: 0 },
  ares:  { bg: 0x2a130c, fog: 0x5b2a17, fogD: 0.022, ground: 0xb3582f, ground2: 0x6e2f19, sun: 0xffe2c4, sunI: 2.0, hemi: 0x6a3a28, sky: "sun", dust: 0xc9734a, wind: 1 },
  titan: { bg: 0x2d2511, fog: 0x7a6230, fogD: 0.035, ground: 0x9a8248, ground2: 0x5e4d26, sun: 0xffe7b0, sunI: 1.3, hemi: 0x6e5b30, sky: "saturn", dust: 0xb8a067, wind: 0.6 },
};

function noise2(x, z) {   // cheap value-ish noise, deterministic
  return (Math.sin(x * 0.9 + z * 0.3) * 0.5 + Math.sin(x * 0.27 - z * 0.71) * 0.8 +
          Math.sin(x * 2.1 + z * 1.7) * 0.15 + Math.cos(z * 0.45 + x * 0.12) * 0.6);
}

export class LanderScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400);
    this.camPos = new THREE.Vector3(10, 8, 18);
    this.camLook = new THREE.Vector3(10, 5, 0);
    this.clock = new THREE.Clock();
    this.shake = 0;
    this.action = 0;
    this.state = { x: 10, y: 13, a: 0 };
    this.target = { x: 10, y: 13, a: 0 };
    this.terrainGroup = new THREE.Group();
    this.scene.add(this.terrainGroup);
    this._lights();
    this._stars();
    this._lander();
    this._particles();
    this.setWorld("luna");
    this.setTerrain(DEFAULT_TERRAIN);
    addEventListener("resize", () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop(() => this._tick());
    this.onAssets = null;          // set by the UI to show loading progress
    this.onCamera = null;          // tells the UI whether the viewer has taken the camera
    this._orbit();
    this._loadAssets();
  }

  /* Two camera modes. By default the camera flies itself, framing the lander against the pad.
     Drag (or pinch) and you take over: the same orbit stays locked on the craft, so you can
     look at a landing from underneath, from behind, or from the pad itself. */
  _orbit() {
    this.controls = new OrbitControls(this.camera, this.canvas);
    Object.assign(this.controls, {
      enableDamping: true, dampingFactor: 0.08,
      enablePan: false, minDistance: 3, maxDistance: 90,
      maxPolarAngle: Math.PI * 0.52,       // stop just below the horizon
      rotateSpeed: 0.7, zoomSpeed: 0.8,
    });
    this.controls.enabled = false;
    this.freeLook = false;
    const take = () => this.setFreeLook(true);
    this.canvas.addEventListener("pointerdown", take);
    this.canvas.addEventListener("wheel", take, { passive: true });
  }

  /** Where the craft currently sits on screen, so the UI can pin a label to it. */
  screenPos() {
    const v = new THREE.Vector3(this.state.x, this.state.y + 0.6, 0).project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return {
      x: r.left + (v.x * 0.5 + 0.5) * r.width,
      y: r.top + (-v.y * 0.5 + 0.5) * r.height,
      visible: v.z < 1 && Math.abs(v.x) < 1.6 && Math.abs(v.y) < 1.6,
    };
  }

  setFreeLook(on) {
    if (this.freeLook === on) return;
    this.freeLook = on;
    this.controls.enabled = on;
    if (on) {
      this.controls.target.copy(this.camLook);
      this.camera.position.copy(this.camPos);
      this.controls.update();
    }
    this.onCamera?.(on);
  }

  // ------------------------------------------------------------- GLB assets
  async _loadAssets() {
    const loader = new GLTFLoader();
    const load = (url, label) => new Promise(res => {
      loader.load(url,
        g => res(g),
        e => this.onAssets?.({ label, loaded: e.loaded, total: e.total }),
        () => res(null));          // missing or broken file: keep the procedural look
    });

    const [sky, moon, lander] = await Promise.all([
      load(ASSETS.sky, "deep space"),
      load(ASSETS.moon, "lunar surface"),
      load(ASSETS.lander, "Vikram lander"),
    ]);
    if (sky) this._useSkybox(sky.scene);
    if (moon) {
      this.moonMaps = this._harvestMaps(moon.scene);
      if (this.terrainData) this.setTerrain(this.terrainData);
    }
    if (lander) this._useLanderModel(lander.scene);
    this.onAssets?.({ done: true, lander: !!lander, moon: !!moon, sky: !!sky });
  }

  /** Wrap the scene in the nebula sphere, lit by nothing and drawn behind everything. */
  _useSkybox(root) {
    let src = null;
    root.traverse(o => { if (o.isMesh && !src) src = o; });
    if (!src) return;
    const mat = [].concat(src.material)[0] || {};
    const tex = mat.map || mat.emissiveMap;
    if (tex) tex.colorSpace = THREE.SRGBColorSpace;

    // Scale from the geometry's own radius, not the world box: the exporter puts a 0.01 scale on
    // a parent, so the world box (166) and the local geometry (16595) differ by 100x. Using the
    // world figure here builds a sphere far outside the camera's far plane, and it never draws.
    src.geometry.computeBoundingSphere();
    const radius = src.geometry.boundingSphere?.radius || 1;
    const sky = new THREE.Mesh(src.geometry, new THREE.MeshBasicMaterial({
      map: tex, side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false,
    }));
    sky.scale.setScalar(SKY_R / radius);
    sky.renderOrder = -1;
    sky.frustumCulled = false;
    this.sky = sky;
    this.scene.add(sky);
    this.scene.background = null;          // the sphere is the background now
  }

  /** Take the surface's colour/normal/roughness maps; we paint them onto our own terrain. */
  _harvestMaps(root) {
    const maps = {};
    root.traverse(o => {
      if (!o.isMesh || !o.material) return;
      for (const m of [].concat(o.material)) {
        for (const slot of ["map", "normalMap", "roughnessMap", "aoMap"]) {
          if (m[slot] && !maps[slot]) {
            const tex = m[slot];
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            if (slot === "map") tex.colorSpace = THREE.SRGBColorSpace;
            maps[slot] = tex;
          }
        }
      }
    });
    return maps;
  }

  /** Swap the blocky stand-in for the real craft, keeping flames and thrusters attached. */
  _useLanderModel(model) {
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const scale = 2.2 / Math.max(size.x, size.z);     // match the built-in lander's leg span
    model.scale.setScalar(scale);

    const scaled = new THREE.Box3().setFromObject(model);
    const mid = scaled.getCenter(new THREE.Vector3());
    model.position.set(-mid.x, -scaled.min.y - 0.55, -mid.z);   // feet at y = -0.55, centred
    model.traverse(o => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        for (const m of [].concat(o.material)) {
          if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
          m.envMapIntensity = 0.8;
        }
      }
    });
    for (const m of this.procedural) this.lander.remove(m);     // keep flame + rcs children
    this.procedural = [];
    this.lander.add(model);
    this.landerModel = model;
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / Math.max(1, r.height);
    this.camera.updateProjectionMatrix();
  }

  _lights() {
    this.hemi = new THREE.HemisphereLight(0x334455, 0x111111, 0.6);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.5);
    this.sun.position.set(-14, 22, 12);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -18, right: 18, top: 14, bottom: -10, near: 1, far: 80 });
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.engineLight = new THREE.PointLight(0xffa64d, 0, 9, 1.6);
    this.scene.add(this.engineLight);
  }

  _stars() {
    const n = 2500, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const th = Math.random() * Math.PI * 2, ph = Math.acos(Math.random() * 0.9), r = 180;
      pos.set([10 + r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) * 0.9 + 5, -Math.abs(r * Math.sin(ph) * Math.sin(th))], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.7, color: 0xffffff, sizeAttenuation: true, fog: false }));
    this.scene.add(this.stars);
    this.skyObj = new THREE.Group();
    this.scene.add(this.skyObj);
  }

  _skyBody(kind) {
    this.skyObj.clear();
    if (kind === "earth") {
      const e = new THREE.Mesh(new THREE.SphereGeometry(7, 48, 32),
        new THREE.MeshStandardMaterial({ color: 0x3b6fb6, emissive: 0x0b2244, roughness: 0.6, fog: false }));
      const c = new THREE.Mesh(new THREE.SphereGeometry(7.15, 48, 32),
        new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, fog: false }));
      e.add(c); e.position.set(38, 42, -150); this.skyObj.add(e);
    } else if (kind === "sun") {
      const s = new THREE.Mesh(new THREE.SphereGeometry(3, 24, 16), new THREE.MeshBasicMaterial({ color: 0xfff0d8, fog: false }));
      s.position.set(-40, 30, -150); this.skyObj.add(s);
    } else if (kind === "saturn") {
      const p = new THREE.Mesh(new THREE.SphereGeometry(16, 48, 32),
        new THREE.MeshStandardMaterial({ color: 0xd9bf86, emissive: 0x2a2010, fog: false }));
      const ring = new THREE.Mesh(new THREE.RingGeometry(21, 33, 96),
        new THREE.MeshBasicMaterial({ color: 0xcdb27a, side: THREE.DoubleSide, transparent: true, opacity: 0.55, fog: false }));
      ring.rotation.x = 1.25; p.add(ring); p.position.set(55, 50, -190); p.rotation.z = 0.3;
      this.skyObj.add(p);
    }
  }

  _lander() {
    const L = new THREE.Group();
    const foil = new THREE.MeshStandardMaterial({ color: 0xd8b043, metalness: 0.55, roughness: 0.38, emissive: 0x2a1e05 });
    const grey = new THREE.MeshStandardMaterial({ color: 0xc8ccd2, metalness: 0.3, roughness: 0.55 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2b2f36, metalness: 0.6, roughness: 0.4 });
    const descent = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.6, 0.42, 8), foil);
    descent.position.y = -0.1; L.add(descent);
    const ascent = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.42, 0.56), grey);
    ascent.position.y = 0.32; L.add(ascent);
    const win = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.12), new THREE.MeshStandardMaterial({ color: 0x0d1626, emissive: 0x335577, emissiveIntensity: 0.6 }));
    win.position.set(-0.12, 0.38, 0.281); L.add(win);
    const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.02, 0.05, 16), grey);
    dish.position.set(0.22, 0.6, 0); dish.rotation.z = -0.6; L.add(dish);
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.2, 0.24, 20, 1, true), dark);
    nozzle.position.y = -0.42; L.add(nozzle);
    // four legs: two in the physics plane, two for depth
    const legMat = new THREE.MeshStandardMaterial({ color: 0xb0b4ba, metalness: 0.7, roughness: 0.35 });
    for (const [sx, sz] of [[1, 0.35], [-1, 0.35], [1, -0.35], [-1, -0.35]]) {
      const top = new THREE.Vector3(sx * 0.45, -0.05, sz * 0.8), foot = new THREE.Vector3(sx * 1.0, -0.5, sz * 1.2);
      const len = top.distanceTo(foot);
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, len, 6), legMat);
      strut.position.copy(top).add(foot).multiplyScalar(0.5);
      strut.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), foot.clone().sub(top).normalize());
      L.add(strut);
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.04, 12), legMat);
      pad.position.copy(foot); L.add(pad);
    }
    for (const sx of [-1, 1]) {   // RCS quads
      const q = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.1), dark);
      q.position.set(sx * 0.62, 0.3, 0); L.add(q);
    }
    L.traverse(o => { if (o.isMesh) { o.castShadow = true; } });
    this.procedural = [...L.children];   // the stand-in body, dropped if a real model loads
    // flames
    const flameMat = new THREE.MeshBasicMaterial({ color: 0xffb14a, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xcfe6ff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
    this.flame = new THREE.Group();
    const outer = new THREE.Mesh(new THREE.ConeGeometry(0.2, 1.4, 20, 1, true), flameMat);
    outer.rotation.x = Math.PI; outer.position.y = -0.7;
    const core = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.6, 16, 1, true), coreMat);
    core.rotation.x = Math.PI; core.position.y = -0.3;
    this.flame.add(outer, core); this.flame.position.y = -0.54; L.add(this.flame);
    this.rcs = [-1, 1].map(sx => {
      const p = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.45, 10, 1, true), coreMat.clone());
      p.rotation.z = sx * Math.PI / 2; p.position.set(sx * 0.88, 0.3, 0); L.add(p); return p;
    });
    this.lander = L;
    this.scene.add(L);
  }

  _particles() {
    const N = 900;
    this.pN = N;
    this.pPos = new Float32Array(N * 3);
    this.pVel = new Float32Array(N * 3);
    this.pLife = new Float32Array(N);
    this.pCol = new Float32Array(N * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pPos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(this.pCol, 3));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.12, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false }));
    this.scene.add(this.points);
    this.pNext = 0;
    // wind streaks
    const W = 160, wp = new Float32Array(W * 6);
    const wg = new THREE.BufferGeometry(); wg.setAttribute("position", new THREE.BufferAttribute(wp, 3));
    this.windLines = new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12 }));
    this.windSeed = Array.from({ length: W }, () => [Math.random() * 40 - 10, Math.random() * 14, Math.random() * -14 + 4, 0.5 + Math.random()]);
    this.scene.add(this.windLines);
  }

  _emit(x, y, z, vx, vy, vz, life, color) {
    const i = this.pNext; this.pNext = (i + 1) % this.pN;
    this.pPos.set([x, y, z], i * 3); this.pVel.set([vx, vy, vz], i * 3); this.pLife[i] = life;
    const c = new THREE.Color(color); this.pCol.set([c.r, c.g, c.b], i * 3);
  }

  setWorld(key) {
    this.world = key;
    const t = THEMES[key] || THEMES.luna;
    this.theme = t;
    this.scene.background = this.sky ? null : new THREE.Color(t.bg);
    this.scene.fog = new THREE.FogExp2(t.fog, t.fogD);
    this.sun.color.set(t.sun); this.sun.intensity = t.sunI;
    this.hemi.color.set(t.hemi);
    this.stars.visible = key === "luna";
    this._skyBody(t.sky);
    this.windLines.visible = t.wind > 0;
    if (this.terrainData) this.setTerrain(this.terrainData);
  }

  groundAt(x) {
    const g = this.terrainData?.ground;
    if (!g) return 3.33;
    if (x <= g[0][0]) return g[0][1];
    for (let i = 1; i < g.length; i++) if (x <= g[i][0]) {
      const [x0, y0] = g[i - 1], [x1, y1] = g[i];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
    return g[g.length - 1][1];
  }

  setTerrain(terrain) {
    this.terrainData = terrain;
    this.terrainGroup.clear();
    const t = this.theme;
    const [p1, p2, py] = terrain.pad;
    const nx = 220, nz = 90, x0 = -25, x1 = 45, z0 = -60, z1 = 8;
    const geo = new THREE.PlaneGeometry(x1 - x0, z1 - z0, nx, nz);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position, cols = new Float32Array(pos.count * 3);
    const cA = new THREE.Color(t.ground), cB = new THREE.Color(t.ground2), c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + (x0 + x1) / 2, z = pos.getZ(i) + (z0 + z1) / 2;
      const strip = this.groundAt(Math.min(Math.max(x, 0), terrain.w));
      const far = THREE.MathUtils.smoothstep(Math.abs(z), 1.2, 14);
      const hills = py + noise2(x * 0.35, z * 0.35) * 1.6 + Math.max(0, -z - 15) * 0.08 * (1 + noise2(x * 0.1, z * 0.1));
      let y = THREE.MathUtils.lerp(strip, hills, far);
      const crater = Math.sin(x * 1.3) * Math.sin(z * 1.1);
      y += (crater > 0.92 ? -(crater - 0.92) * 3 : 0) * far + noise2(x * 3, z * 3) * 0.04;
      pos.setY(i, y); pos.setX(i, x); pos.setZ(i, z);
      c.copy(cA).lerp(cB, 0.5 + 0.5 * noise2(x * 0.8, z * 0.8) * 0.5); cols.set([c.r, c.g, c.b], i * 3);
    }
    geo.translate(0, 0, 0);
    geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    geo.computeVertexNormals();
    // With the scanned surface available, paint it over this geometry: the silhouette stays the
    // Box2D profile the lander actually collides with, and only the surface detail comes from
    // the scan. Without it, fall back to vertex-coloured flat shading.
    const scanned = this.world === "luna" && this.moonMaps?.map;
    const mat = scanned
      ? new THREE.MeshStandardMaterial({
          map: this.moonMaps.map, normalMap: this.moonMaps.normalMap || null,
          roughnessMap: this.moonMaps.roughnessMap || null,
          roughness: 1.0, metalness: 0.0, normalScale: new THREE.Vector2(1.6, 1.6),
        })
      : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.terrainGroup.add(mesh);
    // landing pad
    const padW = p2 - p1;
    const pad = new THREE.Mesh(new THREE.BoxGeometry(padW + 0.6, 0.12, 3.2),
      new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 0.7, metalness: 0.2 }));
    pad.position.set((p1 + p2) / 2, py + 0.02, 0); pad.receiveShadow = true;
    this.terrainGroup.add(pad);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.75, 0.9, 48), new THREE.MeshBasicMaterial({ color: 0xe9eef4 }));
    ring.rotation.x = -Math.PI / 2; ring.position.set((p1 + p2) / 2, py + 0.09, 0);
    this.terrainGroup.add(ring);
    this.padLights = [];
    for (const px of [p1, p2]) for (const pz of [-1.4, 1.4]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.7, 6), new THREE.MeshStandardMaterial({ color: 0xcccccc }));
      pole.position.set(px, py + 0.35, pz);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffc04d }));
      bulb.position.set(px, py + 0.72, pz);
      this.terrainGroup.add(pole, bulb); this.padLights.push(bulb);
    }
    this.padState = "idle";
  }

  // --- live inputs
  setFrame(f) {   // [x, y, angle, legL, legR, action]
    this.target = { x: f[0], y: f[1], a: f[2] };
    this.action = f[5];
    this.legs = f[3] + f[4];
    if (!this.seen) { this.state = { ...this.target }; this.seen = true; }
  }
  snap() { this.seen = false; this.crashed = false; this.lander.visible = true; this.padState = "idle"; }

  outcome(kind) {
    const { x, y } = this.state;
    if (kind === "crashed" || kind === "flew_off") {
      this.crashed = true; this.lander.visible = false; this.shake = 0.6;
      for (let i = 0; i < 260; i++) {
        const a = Math.random() * Math.PI * 2, s = 1 + Math.random() * 6;
        this._emit(x, y, 0, Math.cos(a) * s, Math.abs(Math.sin(a)) * s * 0.9, (Math.random() - 0.5) * s,
          1 + Math.random() * 1.5, i % 3 ? 0xff9a3c : 0x777777);
      }
    } else if (kind?.startsWith("landed")) {
      this.padState = "landed";
    }
  }

  _tick() {
    const dt = Math.min(this.clock.getDelta(), 0.05), t = this.clock.elapsedTime;
    const s = this.state, g = this.target, k = 1 - Math.pow(0.0005, dt);
    s.x += (g.x - s.x) * k; s.y += (g.y - s.y) * k; s.a += (g.a - s.a) * k;
    this.lander.position.set(s.x, s.y, 0);
    this.lander.rotation.z = s.a;
    // engines
    const main = this.action === 2 && !this.crashed;
    this.flame.visible = main;
    if (main) this.flame.scale.set(1, 0.8 + Math.random() * 0.45, 1);
    this.rcs[0].visible = this.action === 1 && !this.crashed;
    this.rcs[1].visible = this.action === 3 && !this.crashed;
    this.engineLight.intensity = main ? 14 + Math.random() * 6 : 0;
    this.engineLight.position.set(s.x - Math.sin(s.a) * -0.9, s.y - Math.cos(s.a) * 0.9, 0.3);
    // dust kicked up by the main engine near the ground
    const ground = this.groundAt(s.x), alt = s.y - ground;
    if (main && alt < 4) {
      const n = Math.round((4 - alt) * 4);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 3;
        this._emit(s.x + Math.cos(a) * 0.3, ground + 0.05, Math.sin(a) * 0.3, Math.cos(a) * sp, 0.2 + Math.random() * 0.8, Math.sin(a) * sp, 0.8 + Math.random(), this.theme.dust);
      }
    }
    if (main) {   // exhaust
      const dx = Math.sin(s.a), dy = -Math.cos(s.a);
      for (let i = 0; i < 3; i++)
        this._emit(s.x + dx * 0.9, s.y + dy * 0.9, (Math.random() - .5) * .1, dx * 6 + (Math.random() - .5), dy * 6 + (Math.random() - .5), (Math.random() - .5), 0.25, 0xffc070);
    }
    for (let i = 0; i < this.pN; i++) {
      if (this.pLife[i] <= 0) { this.pPos[i * 3 + 1] = -999; continue; }
      this.pLife[i] -= dt;
      this.pVel[i * 3 + 1] -= 1.5 * dt;
      for (let j = 0; j < 3; j++) { this.pPos[i * 3 + j] += this.pVel[i * 3 + j] * dt; this.pVel[i * 3 + j] *= 1 - 1.2 * dt; }
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
    // wind
    if (this.windLines.visible) {
      const a = this.windLines.geometry.attributes.position;
      this.windSeed.forEach((w, i) => {
        w[0] += dt * 9 * w[3] * this.theme.wind; if (w[0] > 32) w[0] = -12;
        a.setXYZ(i * 2, w[0], w[1], w[2]); a.setXYZ(i * 2 + 1, w[0] + 0.9 * w[3], w[1], w[2]);
      });
      a.needsUpdate = true;
    }
    // pad lights
    if (this.padLights) this.padLights.forEach((b, i) => {
      b.material.color.set(this.padState === "landed" ? 0x4fe0b4 : ((Math.floor(t * 2) + i) % 2 ? 0xffc04d : 0x553311));
    });
    // camera: follow lander, pull back with altitude
    const padX = this.terrainData ? (this.terrainData.pad[0] + this.terrainData.pad[1]) / 2 : 10;
    const fx = THREE.MathUtils.lerp(s.x, padX, 0.25), fy = THREE.MathUtils.lerp(s.y, ground, 0.35);
    const dist = 7 + Math.min(10, Math.max(0, alt) * 0.9);
    this.camLook.lerp(new THREE.Vector3(fx, fy, 0), k);

    if (this.freeLook) {
      this.controls.target.lerp(this.camLook, k * 0.5);   // keep the craft centred while you orbit
      this.controls.update();
      this.camPos.copy(this.camera.position);
    } else {
      this.camPos.lerp(new THREE.Vector3(fx + 1.5, fy + 1.6 + dist * 0.18, dist + 2), k * 0.6);
      this.camera.position.copy(this.camPos);
      if (this.shake > 0) {
        this.camera.position.x += (Math.random() - .5) * this.shake;
        this.camera.position.y += (Math.random() - .5) * this.shake;
      }
      this.camera.lookAt(this.camLook);
      // Parallax: bank slightly into the drift and lean with the descent, so a fast fall is
      // something you feel in the frame rather than only read on the altimeter.
      const vx = (g.x - s.x), vy = (g.y - s.y);
      this.roll = THREE.MathUtils.lerp(this.roll || 0, THREE.MathUtils.clamp(-vx * 0.8 - s.a * 0.12, -0.14, 0.14), k * 0.35);
      this.lean = THREE.MathUtils.lerp(this.lean || 0, THREE.MathUtils.clamp(-vy * 0.5, -0.09, 0.09), k * 0.35);
      this.camera.rotateZ(this.roll);
      this.camera.rotateX(this.lean);
    }
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 0.9);
    if (this.sky) this.sky.position.copy(this.camera.position);
    this.sun.target.position.set(s.x, ground, 0);
    this.sun.position.set(s.x - 14, ground + 20, 12);
    this.renderer.render(this.scene, this.camera);
  }
}
