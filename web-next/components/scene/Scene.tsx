"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { store } from "@/lib/store";
import { hudBus } from "@/lib/hudbus";
import type { Terrain as TerrainData } from "@/lib/types";
import { Terrain, groundAt } from "./Terrain";
import { useOptionalAsset } from "./optional";
import { Lander, type FlightRef } from "./Lander";

const DEFAULT_TERRAIN: TerrainData = {
  w: 20, h: 13.33, pad: [8.2, 11.8, 3.33],
  ground: [[0, 4.1], [2, 3.0], [4, 4.4], [6, 3.6], [8.2, 3.33], [11.8, 3.33],
           [14, 4.2], [16, 3.2], [18, 4.6], [20, 3.9]],
};

const THEME: Record<string, { fog: string; fogD: number; sun: string; sunI: number; hemi: string }> = {
  luna:  { fog: "#05070b", fogD: 0.018, sun: "#ffffff", sunI: 2.6, hemi: "#263046" },
  ares:  { fog: "#5b2a17", fogD: 0.030, sun: "#ffe2c4", sunI: 2.0, hemi: "#6a3a28" },
  titan: { fog: "#7a6230", fogD: 0.042, sun: "#ffe7b0", sunI: 1.3, hemi: "#6e5b30" },
};

/** Nebula sphere, unlit, riding with the camera so it reads as infinitely far away.
 *  Only mounted once the file is known to be there — see ./optional. */
function Skybox() {
  return useOptionalAsset("/assets/nebula.glb") ? <SkyboxModel /> : null;
}

function SkyboxModel() {
  const gltf = useGLTF("/assets/nebula.glb", true) as unknown as { scene: THREE.Group } | null;
  const ref = useRef<THREE.Mesh>(null);

  const built = useMemo(() => {
    let src: THREE.Mesh | null = null;
    gltf?.scene?.traverse(o => { if ((o as THREE.Mesh).isMesh && !src) src = o as THREE.Mesh; });
    if (!src) return null;
    const mesh = src as THREE.Mesh;
    const mat = ([] as THREE.Material[]).concat(mesh.material)[0] as THREE.MeshStandardMaterial;
    const tex = mat?.map ?? mat?.emissiveMap ?? null;
    if (tex) tex.colorSpace = THREE.SRGBColorSpace;
    // Scale from the geometry's own radius: the exporter puts a 0.01 scale on a parent, so the
    // world box and the local geometry differ by 100x and using the wrong one builds a sphere
    // far outside the camera's far plane, which then never draws.
    mesh.geometry.computeBoundingSphere();
    const r = mesh.geometry.boundingSphere?.radius || 1;
    return { geometry: mesh.geometry, tex, scale: 320 / r };
  }, [gltf]);

  useFrame(({ camera }) => { ref.current?.position.copy(camera.position); });
  if (!built) return null;
  return (
    <mesh ref={ref} geometry={built.geometry} scale={built.scale} renderOrder={-1} frustumCulled={false}>
      <meshBasicMaterial map={built.tex} side={THREE.BackSide} depthWrite={false} fog={false} toneMapped={false} />
    </mesh>
  );
}

function Stars() {
  const geo = useMemo(() => {
    const n = 2400;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(Math.random() * 0.9);
      const r = 180;
      pos.set([10 + r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) * 0.9 + 5,
               -Math.abs(r * Math.sin(ph) * Math.sin(th))], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return g;
  }, []);
  return (
    <points geometry={geo}>
      <pointsMaterial size={0.7} color="#ffffff" sizeAttenuation fog={false} />
    </points>
  );
}

/**
 * Camera. Left alone it frames the craft against the pad and banks into the drift, so a fast
 * fall reads in the frame. Drag or scroll and the viewer takes over, orbiting the same point.
 */
function CameraRig({
  flight, terrain, free, onTakeOver,
}: {
  flight: React.MutableRefObject<FlightRef>;
  terrain: TerrainData | null;
  free: boolean;
  onTakeOver: () => void;
}) {
  const { camera, gl } = useThree();
  const look = useRef(new THREE.Vector3(10, 5, 0));
  const roll = useRef(0);
  const lean = useRef(0);
  const controls = useRef<any>(null);

  useEffect(() => {
    const take = () => onTakeOver();
    const el = gl.domElement;
    el.addEventListener("pointerdown", take);
    el.addEventListener("wheel", take, { passive: true });
    return () => { el.removeEventListener("pointerdown", take); el.removeEventListener("wheel", take); };
  }, [gl, onTakeOver]);

  useFrame((_, dt) => {
    const t = flight.current;
    const k = 1 - Math.pow(0.0005, Math.min(dt, 0.05));
    const ground = groundAt(terrain, t.x);
    const alt = t.y - ground;
    const padX = terrain ? (terrain.pad[0] + terrain.pad[1]) / 2 : 10;
    const fx = THREE.MathUtils.lerp(t.x, padX, 0.25);
    const fy = THREE.MathUtils.lerp(t.y, ground, 0.35);
    look.current.lerp(new THREE.Vector3(fx, fy, 0), k);

    if (free) {
      if (controls.current) {
        controls.current.target.lerp(look.current, k * 0.5);
        controls.current.update();
      }
      return;
    }

    const dist = 7 + Math.min(10, Math.max(0, alt) * 0.9);
    camera.position.lerp(
      new THREE.Vector3(fx + 1.5, fy + 1.6 + dist * 0.18, dist + 2), k * 0.6);
    camera.lookAt(look.current);

    const vx = t.x - camera.position.x + 1.5;
    roll.current = THREE.MathUtils.lerp(roll.current,
      THREE.MathUtils.clamp(-t.a * 0.14, -0.12, 0.12), k * 0.3);
    lean.current = THREE.MathUtils.lerp(lean.current,
      THREE.MathUtils.clamp((alt - 6) * 0.004, -0.06, 0.06), k * 0.3);
    void vx;
    camera.rotateZ(roll.current);
    camera.rotateX(lean.current);
  });

  // hand the craft's screen position to the overlay, outside React
  useFrame(({ camera: cam, size }) => {
    const t = flight.current;
    const v = new THREE.Vector3(t.x, t.y + 0.6, 0).project(cam);
    hudBus.screen.x = (v.x * 0.5 + 0.5) * size.width;
    hudBus.screen.y = (-v.y * 0.5 + 0.5) * size.height;
    hudBus.screen.w = size.width;
    hudBus.screen.h = size.height;
    hudBus.screen.visible = v.z < 1 && Math.abs(v.x) < 1.5 && Math.abs(v.y) < 1.5 && !t.crashed;
  });

  return (
    <OrbitControls
      ref={controls}
      enabled={free}
      enableDamping
      dampingFactor={0.08}
      enablePan={false}
      minDistance={3}
      maxDistance={90}
      /* stop just above the horizon so the ground's far edge never comes into view */
      maxPolarAngle={Math.PI * 0.49}
      rotateSpeed={0.7}
      zoomSpeed={0.8}
    />
  );
}

function Rig({ world }: { world: string }) {
  const { scene } = useThree();
  const theme = THEME[world] ?? THEME.luna;
  useEffect(() => {
    scene.fog = new THREE.FogExp2(new THREE.Color(theme.fog).getHex(), theme.fogD);
  }, [scene, theme]);
  return (
    <>
      <hemisphereLight color={theme.hemi} groundColor="#111111" intensity={0.6} />
      <directionalLight
        color={theme.sun}
        intensity={theme.sunI}
        position={[-14, 24, 12]}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-24}
        shadow-camera-right={24}
        shadow-camera-top={20}
        shadow-camera-bottom={-14}
        shadow-camera-near={1}
        shadow-camera-far={90}
      />
    </>
  );
}

export function Scene({ free, onTakeOver, paused }: {
  free: boolean; onTakeOver: () => void; paused?: boolean;
}) {
  const [terrain, setTerrain] = useState<TerrainData | null>(DEFAULT_TERRAIN);
  const [world, setWorld] = useState("luna");
  const flight = useRef<FlightRef>({ x: 10, y: 13, a: 0, action: 0, crashed: false });

  useEffect(() => store.onReset((t, n, w, exam) => {
    setTerrain(t);
    setWorld(w);
    flight.current.crashed = false;
    hudBus.tele.padY = t.pad[2];
    hudBus.tele.n = n;
    hudBus.tele.mode = exam ? "Exam" : "Live";
  }), []);

  useEffect(() => store.onFrame(f => {
    flight.current.x = f[0];
    flight.current.y = f[1];
    flight.current.a = f[2];
    flight.current.action = f[5];
  }), []);

  return (
    <Canvas
      shadows
      /* The flight stays mounted behind the memory and analysis stages so nothing is lost on
         the way back, but there is no reason to keep drawing it while it cannot be seen. */
      frameloop={paused ? "never" : "always"}
      dpr={[1, 2]}
      camera={{ fov: 42, near: 0.1, far: 500, position: [11, 9, 18] }}
      gl={{ antialias: true, preserveDrawingBuffer: true, toneMapping: THREE.ACESFilmicToneMapping }}
    >
      <color attach="background" args={["#05070b"]} />
      <Rig world={world} />
      <Suspense fallback={null}>
        <Skybox />
        <Terrain terrain={terrain} world={world} />
        <Lander flight={flight} />
      </Suspense>
      <Stars />
      <CameraRig flight={flight} terrain={terrain} free={free} onTakeOver={onTakeOver} />
    </Canvas>
  );
}

