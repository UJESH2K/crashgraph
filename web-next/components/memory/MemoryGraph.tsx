"use client";

import {
  forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
} from "react";
import { Canvas, useFrame, type ThreeEvent } from "@react-three/fiber";
import { Line, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import {
  EXTENT, type MemoryGraph as Graph, nodePosition, nodeRadius, orderByBirth, risk, riskRGB,
} from "@/lib/memory";

/** What the stage asks of the scene without going through React state. */
export interface GraphHandle {
  /** One finished attempt: thicken what it used, recolour what it changed, light its path. */
  applyEpisode(path: number[], landed: boolean): void;
  resetView(): void;
}

const BG = "#05070b";
const DIM = new THREE.Color(BG);

/* An edge is drawn between the colour of its own survival rate and the background, so a
   transition taken three times is a whisper and one taken four hundred times is a line. */
function edgeColor(land: number, n: number, out: THREE.Color) {
  const [r, g, b] = riskRGB(1 - (land + 0.5) / (n + 1));
  out.setRGB(r, g, b);
  return out.lerp(DIM, 1 - Math.min(1, 0.22 + 0.78 * Math.sqrt(n / 90)));
}

interface SceneProps {
  g: Graph;
  /** show only what the memory held after this attempt */
  reveal: number;
  /** hide transitions taken fewer than this many times */
  minN: number;
  /** false while the viewer has scrubbed back in time */
  live: boolean;
  onHover: (i: number | null) => void;
  onPick: (i: number) => void;
  selected: number | null;
}

function Scene({
  g, reveal, minN, live, onHover, onPick, selected, handle,
}: SceneProps & { handle: React.MutableRefObject<GraphHandle | null> }) {
  const nodes = useRef<THREE.InstancedMesh>(null);
  const lines = useRef<THREE.LineSegments>(null);
  const controls = useRef<{ reset?: () => void } | null>(null);
  const [path, setPath] = useState<number[] | null>(null);
  const [spin, setSpin] = useState(true);

  const order = useMemo(() => orderByBirth(g, minN), [g, minN]);

  /* Everything that depends only on the graph is computed once: positions, the instance
     transforms in birth order, their colours, and the edge buffers in birth order too.
     Revealing the memory as it stood at attempt t is then a draw count, never a rebuild. */
  const built = useMemo(() => {
    const n = g.keys.length;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const p = nodePosition(g.b, i);
      pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2];
    }
    const maxVisits = g.visits.reduce((a, b) => Math.max(a, b), 1);

    const matrices = new Float32Array(n * 16);
    const colors = new Float32Array(n * 3);
    const m = new THREE.Matrix4();
    const v = new THREE.Vector3();
    order.nodes.forEach((idx, slot) => {
      const r = nodeRadius(g.visits[idx], maxVisits);
      m.makeScale(r, r, r).setPosition(v.set(pos[idx * 3], pos[idx * 3 + 1], pos[idx * 3 + 2]));
      m.toArray(matrices, slot * 16);
      const [cr, cg, cb] = riskRGB(risk(g.crashes[idx], g.visits[idx]));
      colors[slot * 3] = cr; colors[slot * 3 + 1] = cg; colors[slot * 3 + 2] = cb;
    });

    const me = order.edges.length;
    const epos = new Float32Array(me * 6);
    const ecol = new Float32Array(me * 6);
    const c = new THREE.Color();
    order.edges.forEach((e, slot) => {
      const s = g.edges[e * 4], t = g.edges[e * 4 + 1];
      epos.set([pos[s * 3], pos[s * 3 + 1], pos[s * 3 + 2]], slot * 6);
      epos.set([pos[t * 3], pos[t * 3 + 1], pos[t * 3 + 2]], slot * 6 + 3);
      edgeColor(g.edges[e * 4 + 3], g.edges[e * 4 + 2], c);
      ecol.set([c.r, c.g, c.b, c.r, c.g, c.b], slot * 6);
    });

    return {
      n, pos, matrices, colors, epos, ecol,
      // live counts, so a finished attempt changes the picture without refetching the graph
      visits: Int32Array.from(g.visits),
      crashes: Int32Array.from(g.crashes),
      lands: Int32Array.from(g.lands),
      edgeN: Int32Array.from({ length: me }, (_, s) => g.edges[order.edges[s] * 4 + 2]),
      edgeLand: Int32Array.from({ length: me }, (_, s) => g.edges[order.edges[s] * 4 + 3]),
      edgeSlot: new Map(order.edges.map((e, slot) =>
        [g.edges[e * 4] * 1e6 + g.edges[e * 4 + 1], slot] as const)),
      // birth attempt per draw slot: ascending, so the reveal count is a binary search
      nodeBorn: Int32Array.from(order.nodes, i => g.born[i]),
      edgeBorn: Int32Array.from(order.edges, e =>
        Math.max(g.born[g.edges[e * 4]], g.born[g.edges[e * 4 + 1]])),
    };
  }, [g, order]);

  const edgeGeometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(built.epos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(built.ecol, 3));
    return geo;
  }, [built]);

  useEffect(() => () => edgeGeometry.dispose(), [edgeGeometry]);

  /* instanceColor does not exist until something writes a colour, and setting 1,700 of them
     one call at a time is wasteful, so both instance buffers are installed directly. */
  useLayoutEffect(() => {
    const mesh = nodes.current;
    if (!mesh) return;
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(built.matrices, 16);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(built.colors, 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [built]);

  useImperativeHandle(handle, () => ({
    applyEpisode(visited: number[], landed: boolean) {
      const known = visited.filter(i => i >= 0 && i < built.n);
      const mesh = nodes.current;
      if (mesh?.instanceColor) {
        const col = mesh.instanceColor.array as Float32Array;
        for (const idx of known) {
          built.visits[idx] += 1;
          if (landed) built.lands[idx] += 1; else built.crashes[idx] += 1;
          const slot = order.rank[idx];
          const [r, gg, b] = riskRGB(risk(built.crashes[idx], built.visits[idx]));
          col[slot * 3] = r; col[slot * 3 + 1] = gg; col[slot * 3 + 2] = b;
        }
        mesh.instanceColor.needsUpdate = true;
      }

      const attr = edgeGeometry.getAttribute("color") as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      const c = new THREE.Color();
      for (let i = 0; i < known.length - 1; i++) {
        const slot = built.edgeSlot.get(known[i] * 1e6 + known[i + 1]);
        if (slot === undefined) continue;   // a transition this view has not loaded yet
        built.edgeN[slot] += 1;
        if (landed) built.edgeLand[slot] += 1;
        edgeColor(built.edgeLand[slot], built.edgeN[slot], c);
        arr.set([c.r, c.g, c.b, c.r, c.g, c.b], slot * 6);
      }
      attr.needsUpdate = true;

      setPath(known.length > 1 ? known : null);
    },
    resetView() { controls.current?.reset?.(); },
  }), [built, order, edgeGeometry]);

  /* Both buffers are in birth order, so "the memory as it stood at attempt t" is a prefix.
     One binary search a frame beats rebuilding 1,700 matrices while a slider is dragged. */
  useFrame(() => {
    const upTo = (arr: Int32Array) => {
      let lo = 0, hi = arr.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] <= reveal) lo = mid + 1; else hi = mid;
      }
      return lo;
    };
    if (nodes.current) nodes.current.count = upTo(built.nodeBorn);
    if (lines.current) lines.current.geometry.setDrawRange(0, upTo(built.edgeBorn) * 2);
  });

  const at = (i: number): [number, number, number] =>
    [built.pos[i * 3], built.pos[i * 3 + 1], built.pos[i * 3 + 2]];

  /* The last attempt's path is only drawn on the live view. Scrubbed back to attempt 400 it
     would thread through nodes that did not exist then, which is precisely the false claim
     this whole screen exists to avoid making. */
  const pathPoints = live && path && path.length > 1 ? path.map(at) : null;
  const sel = selected !== null && selected >= 0 && selected < built.n ? at(selected) : null;

  return (
    <>
      <color attach="background" args={[BG]} />
      {/* depth cue: the far side of the memory falls away into the background rather than
          tangling with the near side, which is what makes a lattice this dense readable */}
      <fogExp2 attach="fog" args={[BG, 0.012]} />
      <ambientLight intensity={2.1} />
      <directionalLight position={[14, 28, 20]} intensity={0.9} />
      <gridHelper args={[Math.ceil(EXTENT.x * 2.6), 13, "#1d2432", "#151b25"]} position={[0, -2.4, 0]} />

      <instancedMesh
        ref={nodes}
        args={[undefined, undefined, built.n]}
        frustumCulled={false}
        onPointerMove={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          onHover(e.instanceId === undefined ? null : order.nodes[e.instanceId]);
        }}
        onPointerOut={() => onHover(null)}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          if (e.instanceId !== undefined) onPick(order.nodes[e.instanceId]);
        }}
      >
        <sphereGeometry args={[1, 10, 8]} />
        {/* No `vertexColors` here, deliberately. three sets USE_COLOR from the flag alone, and
            a sphere geometry has no colour attribute, so the shader reads the default (0,0,0)
            and every node comes out black. An InstancedMesh with instanceColor set is already
            multiplied in through USE_INSTANCING_COLOR, which is what we want. */}
        <meshLambertMaterial toneMapped={false} fog />
      </instancedMesh>

      <lineSegments ref={lines} geometry={edgeGeometry} frustumCulled={false}>
        <lineBasicMaterial vertexColors transparent opacity={0.62} depthWrite={false} toneMapped={false} />
      </lineSegments>

      {pathPoints && (
        <Line points={pathPoints} color="#ffffff" lineWidth={2.8} transparent opacity={0.92} />
      )}

      {sel && (
        <mesh position={sel}>
          <sphereGeometry args={[1.15, 16, 12]} />
          <meshBasicMaterial color="#ffffff" wireframe transparent opacity={0.6} />
        </mesh>
      )}

      {/* It turns slowly on its own so the depth is obvious at a glance, and stops for good
          the moment anyone touches it — an exhibit that keeps moving under your hands is
          worse than one that never moved. */}
      <OrbitControls
        ref={controls as never}
        makeDefault
        enableDamping
        dampingFactor={0.08}
        target={[0, EXTENT.y / 2 - 1, 0]}
        minDistance={6}
        maxDistance={200}
        autoRotate={spin}
        autoRotateSpeed={0.35}
        onStart={() => setSpin(false)}
      />
    </>
  );
}

export const MemoryGraph = forwardRef<GraphHandle, SceneProps>(function MemoryGraph(props, ref) {
  const handle = useRef<GraphHandle | null>(null);
  useImperativeHandle(ref, () => ({
    applyEpisode: (p, l) => handle.current?.applyEpisode(p, l),
    resetView: () => handle.current?.resetView(),
  }), []);

  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ fov: 42, near: 0.5, far: 700, position: [27, EXTENT.y * 0.86, 46] }}
      gl={{ antialias: true }}
    >
      <Scene {...props} handle={handle} />
    </Canvas>
  );
});
