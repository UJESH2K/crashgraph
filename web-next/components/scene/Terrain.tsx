"use client";

import { useMemo } from "react";
import { useGLTF } from "@react-three/drei";
import { useOptionalAsset } from "./optional";
import * as THREE from "three";
import type { Terrain as TerrainData } from "@/lib/types";

/** Height of the Box2D ground profile at x, linearly interpolated between its chunks. */
export function groundAt(t: TerrainData | null, x: number) {
  const g = t?.ground;
  if (!g || !g.length) return 3.33;
  if (x <= g[0][0]) return g[0][1];
  for (let i = 1; i < g.length; i++) {
    if (x <= g[i][0]) {
      const [x0, y0] = g[i - 1];
      const [x1, y1] = g[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return g[g.length - 1][1];
}

function noise2(x: number, z: number) {
  return (
    Math.sin(x * 0.9 + z * 0.3) * 0.5 +
    Math.sin(x * 0.27 - z * 0.71) * 0.8 +
    Math.sin(x * 2.1 + z * 1.7) * 0.15 +
    Math.cos(z * 0.45 + x * 0.12) * 0.6
  );
}

/* The ground has to be wide enough that its edge never comes into view, but every unit of
   width spends texture: the 4096 scan laid over 200 units gave only ~20 texels per unit, which
   is why the surface looked soft where it matters. At 130 units with the full-resolution scan
   it is ~31 texels per unit near the pad, and the far edge is swallowed by fog instead of
   distance. */
const SPAN = 130;
const SEGS = 300;

/**
 * The ground. The lunar scan is optional, and `useGLTF` throws on a missing file rather than
 * returning null, so the file is asked about first and only then is the loader mounted. The
 * shape never comes from the scan either way — that is the Box2D profile — so without it the
 * terrain is identical and merely plainer.
 */
export function Terrain({ terrain, world }: { terrain: TerrainData | null; world: string }) {
  return useOptionalAsset("/assets/petavius.glb")
    ? <ScannedTerrain terrain={terrain} world={world} />
    : <TerrainMesh terrain={terrain} world={world} maps={{}} />;
}

/** Loads the scan and hands its texture maps down. Only mounted when the file exists. */
function ScannedTerrain({ terrain, world }: { terrain: TerrainData | null; world: string }) {
  const gltf = useGLTF("/assets/petavius.glb", true) as unknown as { scene: THREE.Group } | null;

  const maps = useMemo(() => {
    const found: Record<string, THREE.Texture> = {};
    gltf?.scene?.traverse((o: THREE.Object3D) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (!m) return;
      for (const slot of ["map", "normalMap", "roughnessMap"] as const) {
        const tex = m[slot] as THREE.Texture | null;
        if (tex && !found[slot]) {
          // The scan is a photograph of one specific crater, not a tiling material. Repeating it
          // streaks the ground, and mirroring it folds the crater's concentric terraces back on
          // themselves into rings. Laid down once there is no seam and no false symmetry; the
          // far edge never shows because fog closes in well before it.
          tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
          tex.repeat.set(1, 1);
          tex.anisotropy = 16;
          if (slot === "map") tex.colorSpace = THREE.SRGBColorSpace;
          found[slot] = tex;
        }
      }
    });
    return found;
  }, [gltf]);

  return <TerrainMesh terrain={terrain} world={world} maps={maps} />;
}

function TerrainMesh({
  terrain, world, maps,
}: {
  terrain: TerrainData | null;
  world: string;
  maps: Record<string, THREE.Texture>;
}) {
  const geometry = useMemo(() => {
    const geo = new THREE.PlaneGeometry(SPAN, SPAN, SEGS, SEGS);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const padY = terrain?.pad?.[2] ?? 3.33;
    const w = terrain?.w ?? 20;

    for (let i = 0; i < pos.count; i++) {
      // the plane is centred on the flight area, not on the origin
      const x = pos.getX(i) + w / 2;
      const z = pos.getZ(i);

      // Near the flight corridor the surface *is* the Box2D profile, so what the lander
      // touches is exactly what the physics computed. Further out it relaxes into hills.
      const strip = groundAt(terrain, Math.min(Math.max(x, 0), w));
      const far = THREE.MathUtils.smoothstep(Math.abs(z), 1.5, 16);
      const hills =
        padY + noise2(x * 0.35, z * 0.35) * 1.8 + Math.max(0, Math.abs(z) - 18) * 0.06;
      let y = THREE.MathUtils.lerp(strip, hills, far);
      y += noise2(x * 1.4, z * 1.4) * 0.03;   // gentle: high-frequency bumps smear the normals

      pos.setX(i, x);
      pos.setY(i, y);
      pos.setZ(i, z);
    }
    geo.computeVertexNormals();
    return geo;
  }, [terrain]);

  const pad = terrain?.pad ?? [8.2, 11.8, 3.33];
  const [p1, p2, py] = pad;
  const scanned = world === "luna" && maps.map;

  return (
    <group>
      <mesh geometry={geometry} receiveShadow>
        {scanned ? (
          <meshStandardMaterial
            map={maps.map}
            normalMap={maps.normalMap ?? null}
            roughnessMap={maps.roughnessMap ?? null}
            normalScale={new THREE.Vector2(0.7, 0.7)}
            roughness={1}
            metalness={0}
          />
        ) : (
          <meshStandardMaterial color="#8d8d94" roughness={0.96} flatShading />
        )}
      </mesh>

      {/* landing pad */}
      <mesh position={[(p1 + p2) / 2, py + 0.02, 0]} receiveShadow>
        <boxGeometry args={[p2 - p1 + 0.6, 0.12, 3.2]} />
        <meshStandardMaterial color="#2b303a" roughness={0.65} metalness={0.25} />
      </mesh>
      <mesh position={[(p1 + p2) / 2, py + 0.09, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.75, 0.9, 48]} />
        <meshBasicMaterial color="#e9eef4" />
      </mesh>

      {[p1, p2].map(px =>
        [-1.4, 1.4].map(pz => (
          <group key={`${px}:${pz}`} position={[px, py, pz]}>
            <mesh position={[0, 0.35, 0]}>
              <cylinderGeometry args={[0.03, 0.03, 0.7, 6]} />
              <meshStandardMaterial color="#b9bec6" />
            </mesh>
            <mesh position={[0, 0.72, 0]}>
              <sphereGeometry args={[0.07, 12, 8]} />
              <meshBasicMaterial color="#ffc04d" />
            </mesh>
          </group>
        )),
      )}
    </group>
  );
}

