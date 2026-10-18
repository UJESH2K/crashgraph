"use client";

/**
 * A plain mutable object shared between the 3D scene and the overlay.
 *
 * The scene projects the craft to screen space every frame and the pinned readout reads it back
 * on its own animation frame. Both run at display rate, so neither may touch React state - this
 * is the deliberate escape hatch that keeps the tree from re-rendering fifty times a second.
 */
export const hudBus = {
  /** the craft projected into the viewport, in that element's own pixels, with its size
   *  so the readout can work out which way to flip without asking the window */
  screen: { x: 0, y: 0, w: 0, h: 0, visible: false },
  tele: {
    n: 0,
    alt: null as number | null,
    vy: null as number | null,
    tilt: null as number | null,
    step: 0,
    sit: "Waiting for the first attempt",
    q: null as number[] | null,
    action: 0,
    mode: "Live" as string,
    padY: 3.33,
  },
};
