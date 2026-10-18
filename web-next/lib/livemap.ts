/**
 * The force layout behind the live memory map.
 *
 * Kept out of the component because it is plain arithmetic on plain arrays and has nothing to
 * do with React: it is stepped from an animation frame, never from a render.
 *
 * It lays out the *working set* — the situations the lander actually keeps meeting — rather
 * than all seventeen hundred. Two reasons. A map you can read at 320 pixels across is one with
 * a couple of hundred nodes in it, and the whole graph at that size is a grey smudge. And a
 * layout that small is cheap enough to relax every frame, so when the lander reaches somewhere
 * it has never been, the node appears and the graph visibly makes room for it. That movement
 * is the point: it is the memory growing while you watch, not a picture of it afterwards.
 */

export interface MapNode {
  key: string;
  x: number; y: number;
  vx: number; vy: number;
  visits: number;
  crashes: number;
  lands: number;
  /** ms timestamp it entered the map, for the arrival flash */
  born: number;
  /** ms timestamp the craft was last standing on it */
  lit: number;
  label: string;
}

export interface MapEdge { a: number; b: number; n: number; lit: number }

export class LiveMap {
  nodes: MapNode[] = [];
  edges: MapEdge[] = [];
  index = new Map<string, number>();
  private edgeIndex = new Map<string, number>();
  /** rises when something changes so the layout loosens, then cools back down */
  heat = 1;

  /** Where new nodes are born: at the centre, so they visibly push outward. */
  private spawn(key: string, label: string, visits: number, crashes: number, lands: number) {
    const a = Math.random() * Math.PI * 2;
    const i = this.nodes.length;
    this.nodes.push({
      key, label, visits, crashes, lands,
      x: Math.cos(a) * 6, y: Math.sin(a) * 6, vx: 0, vy: 0,
      born: performance.now(), lit: 0,
    });
    this.index.set(key, i);
    this.heat = Math.max(this.heat, 0.85);
    return i;
  }

  node(key: string, label = "") {
    const got = this.index.get(key);
    return got !== undefined ? got : this.spawn(key, label, 0, 0, 0);
  }

  seed(key: string, label: string, visits: number, crashes: number, lands: number) {
    const i = this.node(key, label);
    const n = this.nodes[i];
    n.label = label || n.label;
    n.visits = visits; n.crashes = crashes; n.lands = lands;
    n.born = 0;                                   // seeded, not discovered: no arrival flash
    return i;
  }

  link(a: number, b: number, n = 1) {
    if (a === b) return;
    const k = a < b ? `${a}:${b}` : `${b}:${a}`;
    const got = this.edgeIndex.get(k);
    if (got !== undefined) { this.edges[got].n += n; return got; }
    this.edgeIndex.set(k, this.edges.length);
    this.edges.push({ a, b, n, lit: 0 });
    return this.edges.length - 1;
  }

  /** Mark the situation the craft is standing on right now. */
  visit(key: string, label: string, prev: number | null, t: number) {
    const i = this.node(key, label);
    this.nodes[i].lit = t;
    if (prev !== null && prev !== i) {
      const e = this.link(prev, i);
      if (e !== undefined) this.edges[e].lit = t;
    }
    return i;
  }

  /** A finished attempt: everything on its path is one visit older and one outcome wiser. */
  settle(path: number[], landed: boolean) {
    for (const i of path) {
      const n = this.nodes[i];
      if (!n) continue;
      n.visits += 1;
      if (landed) n.lands += 1; else n.crashes += 1;
    }
    this.heat = Math.max(this.heat, 0.5);
  }

  /** Drop the least-used nodes once the map is fuller than it can show legibly. */
  prune(limit: number, keep: Set<number>) {
    if (this.nodes.length <= limit) return;
    const order = this.nodes.map((n, i) => i)
      .sort((a, b) => this.nodes[b].visits - this.nodes[a].visits);
    const survivors = new Set(order.slice(0, limit));
    keep.forEach(i => survivors.add(i));
    if (survivors.size >= this.nodes.length) return;

    const remap = new Map<number, number>();
    const nodes: MapNode[] = [];
    this.nodes.forEach((n, i) => {
      if (!survivors.has(i)) return;
      remap.set(i, nodes.length);
      nodes.push(n);
    });
    const edges: MapEdge[] = [];
    const edgeIndex = new Map<string, number>();
    for (const e of this.edges) {
      const a = remap.get(e.a), b = remap.get(e.b);
      if (a === undefined || b === undefined) continue;
      const k = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (edgeIndex.has(k)) continue;
      edgeIndex.set(k, edges.length);
      edges.push({ ...e, a, b });
    }
    this.nodes = nodes;
    this.edges = edges;
    this.edgeIndex = edgeIndex;
    this.index = new Map(nodes.map((n, i) => [n.key, i]));
    return remap;
  }

  /**
   * One relaxation step. Fruchterman-Reingold with a floor under the temperature, so the map
   * is never quite still — a frozen graph looks like an image, and this one is not one.
   */
  step(radius: number) {
    const n = this.nodes.length;
    if (!n) return;
    const k = Math.sqrt((radius * radius * 1.5) / n);   // ideal edge length for this area
    // Repulsion is cut off past a few ideal lengths. Without that every node pushes every
    // other one however far away it is, the whole set inflates until the boundary stops it,
    // and the result is an even ring with a hole in the middle instead of the clusters the
    // graph actually has.
    const cut = k * 3.4, cut2 = cut * cut;
    const maxVisits = this.nodes.reduce((m, x) => Math.max(m, x.visits), 1);

    for (let i = 0; i < n; i++) {
      const a = this.nodes[i];
      let fx = 0, fy = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const b = this.nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 > cut2) continue;
        if (d2 < 0.01) { dx = (Math.random() - 0.5) * 0.4; dy = (Math.random() - 0.5) * 0.4; d2 = 0.16; }
        const f = (k * k) / d2;
        fx += dx * f; fy += dy * f;
      }
      // Gravity toward the middle, stronger on the situations the craft passes through most,
      // so the busy part of the memory ends up in the centre of the picture where it belongs
      // and the rarely-touched edge cases ring the outside.
      const r = Math.hypot(a.x, a.y) || 1e-3;
      const weight = 0.5 + 1.6 * Math.sqrt(a.visits / maxVisits);
      const wall = 1 + Math.max(0, r / radius - 1) * 26;      // hard stop at the frame
      fx -= (a.x / r) * 0.055 * r * weight * wall;
      fy -= (a.y / r) * 0.055 * r * weight * wall;

      a.vx = (a.vx + fx) * 0.8;
      a.vy = (a.vy + fy) * 0.8;
    }

    for (const e of this.edges) {
      const a = this.nodes[e.a], b = this.nodes[e.b];
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1e-3;
      // heavier transitions hold their two ends closer together
      const f = ((d * d) / k) * (0.5 + 0.5 * Math.min(1, e.n / 25)) * 0.05;
      const ux = (dx / d) * f, uy = (dy / d) * f;
      a.vx += ux; a.vy += uy;
      b.vx -= ux; b.vy -= uy;
    }

    const cap = 1.1 + 9 * this.heat;
    for (const a of this.nodes) {
      const v = Math.hypot(a.vx, a.vy);
      if (v > cap) { a.vx = (a.vx / v) * cap; a.vy = (a.vy / v) * cap; }
      a.x += a.vx; a.y += a.vy;
    }
    this.heat = Math.max(0.03, this.heat * 0.976);
  }
}
