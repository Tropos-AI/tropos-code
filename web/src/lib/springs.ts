// web/src/lib/springs.ts — motion presets shared by the Interior components (ddoemonn/interior on 21st.dev),
// copied from the Tropos Labs site so every micro-interaction moves with the same physics.

/** Selection, presses and indicators — fast, no overshoot. */
export const CELL = { type: "spring", stiffness: 520, damping: 34, mass: 0.45 } as const;

/** Label and state crossfades. */
export const CROSSFADE = { type: "spring", stiffness: 260, damping: 34, mass: 0.8 } as const;

/** Panels that slide in or out (drawer, hiding header). */
export const DISCLOSE = { type: "spring", stiffness: 150, damping: 27, mass: 1 } as const;

/** Interior's ease-out curve for one-shot tweens. */
export const EASE = [0.23, 1, 0.32, 1] as const;

/** Reduced motion: jump straight to the end state. */
export const INSTANT = { duration: 0 } as const;
