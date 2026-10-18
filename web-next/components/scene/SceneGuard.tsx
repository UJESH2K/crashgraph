"use client";

import React from "react";
import s from "./SceneGuard.module.css";

/**
 * A blank page is the worst possible failure for a 3D app: nothing says whether the browser
 * refused WebGL, an asset 404'd, or the code threw. This catches all three and says which.
 */
export class SceneGuard extends React.Component<
  { children: React.ReactNode },
  { error: Error | null; webgl: boolean | null }
> {
  state: { error: Error | null; webgl: boolean | null } = { error: null, webgl: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidMount() {
    let ok = false;
    try {
      const c = document.createElement("canvas");
      ok = !!(c.getContext("webgl2") || c.getContext("webgl"));
    } catch {
      ok = false;
    }
    this.setState({ webgl: ok });
  }

  componentDidCatch(error: Error) {
    // eslint-disable-next-line no-console
    console.error("[crashgraph] 3D scene failed:", error);
  }

  render() {
    const { error, webgl } = this.state;

    if (webgl === false) {
      return (
        <div className={s.wrap}>
          <div className={s.card}>
            <h2>This browser will not give us a 3D context</h2>
            <p>
              The console needs WebGL. Everything else on the page — the graph memory, the
              explanations, the removal test — works without it.
            </p>
            <ul>
              <li>Chrome or Edge: check <code>chrome://gpu</code>, and turn on
                “Use graphics acceleration when available” in Settings → System.</li>
              <li>A remote desktop or virtual machine often has no GPU to hand through.</li>
            </ul>
          </div>
        </div>
      );
    }

    if (error) {
      return (
        <div className={s.wrap}>
          <div className={s.card}>
            <h2>The 3D view stopped</h2>
            <p className={s.mono}>{error.message}</p>
            <p>
              The rest of the console is unaffected. If this mentions a <code>.glb</code> file, the
              models in <code>web-next/public/assets/</code> are missing or unreadable — the scene
              falls back to simple shapes without them.
            </p>
            <button className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
          </div>
        </div>
      );
    }

    return <>{this.props.children}</>;
  }
}
