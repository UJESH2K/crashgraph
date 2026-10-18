"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import { useOptionalAsset } from "./optional";
import * as THREE from "three";
import { store } from "@/lib/store";

/** Target the physics is driving the craft toward, updated outside React. */
export interface FlightRef {
  x: number; y: number; a: number; action: number; crashed: boolean;
}

/**
 * The craft, in whichever form is available.
 *
 * `useGLTF` throws on a missing file rather than returning null, so the optional model cannot
 * simply be loaded and checked — the throw would take the whole scene down. The file is asked
 * about first, and the component that loads it is only mounted once it is known to be there.
 */
export function Lander({ flight }: { flight: React.MutableRefObject<FlightRef> }) {
  const present = useOptionalAsset("/assets/vikram.glb");
  // Nothing until the question is settled: rendering the built-in shape and then swapping it
  // would remount the craft and jolt its smoothed position.
  if (present === null) return null;
  return present ? <ModelledCraft flight={flight} /> : <Craft flight={flight} model={null} />;
}

/** Loads the glTF. Only ever mounted when the file exists. */
function ModelledCraft({ flight }: { flight: React.MutableRefObject<FlightRef> }) {
  const gltf = useGLTF("/assets/vikram.glb", true) as unknown as { scene: THREE.Group } | null;

  const model = useMemo(() => {
    if (!gltf?.scene) return null;
    const m = gltf.scene.clone(true);
    const size = new THREE.Box3().setFromObject(m).getSize(new THREE.Vector3());
    m.scale.setScalar(2.2 / Math.max(size.x, size.z));      // match the physics footprint
    const box = new THREE.Box3().setFromObject(m);
    const mid = box.getCenter(new THREE.Vector3());
    m.position.set(-mid.x, -box.min.y - 0.55, -mid.z);      // feet at y = -0.55, centred
    m.traverse(o => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    return m;
  }, [gltf]);

  return <Craft flight={flight} model={model} />;
}

/**
 * Everything that is the same either way. Position comes straight off the websocket through a
 * ref, never through React state: frames arrive ~50x a second and re-rendering the tree at
 * that rate would stall it.
 */
function Craft({
  flight, model,
}: { flight: React.MutableRefObject<FlightRef>; model: THREE.Group | null }) {
  const group = useRef<THREE.Group>(null);
  const flameRef = useRef<THREE.Group>(null);
  const rcsL = useRef<THREE.Mesh>(null);
  const rcsR = useRef<THREE.Mesh>(null);
  const engineLight = useRef<THREE.PointLight>(null);
  const shown = useRef({ x: 10, y: 13, a: 0 });

  useEffect(() => store.onOutcome(o => {
    flight.current.crashed = o === "crashed" || o === "flew_off";
  }), [flight]);

  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    const t = flight.current;
    const s = shown.current;
    const k = 1 - Math.pow(0.0005, Math.min(dt, 0.05));
    s.x += (t.x - s.x) * k;
    s.y += (t.y - s.y) * k;
    s.a += (t.a - s.a) * k;

    g.position.set(s.x, s.y, 0);
    g.rotation.z = s.a;
    g.visible = !t.crashed;

    const main = t.action === 2 && !t.crashed;
    if (flameRef.current) {
      flameRef.current.visible = main;
      if (main) flameRef.current.scale.set(1, 0.8 + Math.random() * 0.45, 1);
    }
    if (rcsL.current) rcsL.current.visible = t.action === 1 && !t.crashed;
    if (rcsR.current) rcsR.current.visible = t.action === 3 && !t.crashed;
    if (engineLight.current) {
      engineLight.current.intensity = main ? 14 + Math.random() * 6 : 0;
      engineLight.current.position.set(s.x, s.y - 0.9, 0.3);
    }
  });

  return (
    <>
      <pointLight ref={engineLight} color="#ffa64d" distance={9} decay={1.6} intensity={0} />
      <group ref={group}>
        {model ? <primitive object={model} /> : <FallbackBody />}

        <group ref={flameRef} position={[0, -0.54, 0]} visible={false}>
          <mesh rotation={[Math.PI, 0, 0]} position={[0, -0.7, 0]}>
            <coneGeometry args={[0.2, 1.4, 20, 1, true]} />
            <meshBasicMaterial color="#ffb14a" transparent opacity={0.85}
              blending={THREE.AdditiveBlending} depthWrite={false} />
          </mesh>
          <mesh rotation={[Math.PI, 0, 0]} position={[0, -0.3, 0]}>
            <coneGeometry args={[0.09, 0.6, 16, 1, true]} />
            <meshBasicMaterial color="#cfe6ff" transparent opacity={0.95}
              blending={THREE.AdditiveBlending} depthWrite={false} />
          </mesh>
        </group>

        <mesh ref={rcsL} position={[-0.88, 0.3, 0]} rotation={[0, 0, -Math.PI / 2]} visible={false}>
          <coneGeometry args={[0.06, 0.45, 10, 1, true]} />
          <meshBasicMaterial color="#cfe6ff" transparent opacity={0.9}
            blending={THREE.AdditiveBlending} depthWrite={false} />
        </mesh>
        <mesh ref={rcsR} position={[0.88, 0.3, 0]} rotation={[0, 0, Math.PI / 2]} visible={false}>
          <coneGeometry args={[0.06, 0.45, 10, 1, true]} />
          <meshBasicMaterial color="#cfe6ff" transparent opacity={0.9}
            blending={THREE.AdditiveBlending} depthWrite={false} />
        </mesh>
      </group>
    </>
  );
}

/** The built-in craft, used whenever the optional model is not installed. */
function FallbackBody() {
  return (
    <>
      <mesh position={[0, -0.1, 0]} castShadow>
        <cylinderGeometry args={[0.55, 0.6, 0.42, 8]} />
        <meshStandardMaterial color="#d8b043" metalness={0.55} roughness={0.38} />
      </mesh>
      <mesh position={[0, 0.32, 0]} castShadow>
        <boxGeometry args={[0.62, 0.42, 0.56]} />
        <meshStandardMaterial color="#c8ccd2" metalness={0.3} roughness={0.55} />
      </mesh>
      {[[1, 0.35], [-1, 0.35], [1, -0.35], [-1, -0.35]].map(([sx, sz], i) => (
        <mesh key={i} position={[sx * 0.75, -0.3, sz * 1]} rotation={[0, 0, sx * 0.5]} castShadow>
          <cylinderGeometry args={[0.025, 0.025, 0.9, 6]} />
          <meshStandardMaterial color="#b0b4ba" metalness={0.7} roughness={0.35} />
        </mesh>
      ))}
    </>
  );
}
