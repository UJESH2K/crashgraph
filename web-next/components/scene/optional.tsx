"use client";

import { useEffect, useState } from "react";

/**
 * Is an optional asset actually there?
 *
 * The three `.glb` files are documented as optional — the scene is supposed to fall back to
 * its own shapes without them — but `useGLTF` does not return null for a missing file, it
 * throws. The throw escapes Suspense, the error boundary catches it, and the entire 3D view
 * is replaced by a failure card. So "optional" held only on a machine that had the files.
 *
 * That is the normal case for anyone cloning the repo (the models are not redistributed) and
 * for any container built from a clean checkout, so it has to work. Asking first is the
 * simplest fix that keeps the fallback a real code path rather than an error handler: the
 * component that loads the model is only mounted once the file is known to exist.
 *
 * Returns null while the question is open, so a caller can avoid rendering the fallback for
 * one frame and then swapping it out.
 */
export function useOptionalAsset(url: string): boolean | null {
  const [present, setPresent] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    fetch(url, { method: "HEAD" })
      .then(r => { if (live) setPresent(r.ok); })
      .catch(() => { if (live) setPresent(false); });
    return () => { live = false; };
  }, [url]);

  return present;
}
