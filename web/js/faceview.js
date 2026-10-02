// web/js/faceview.js
// The glue between .eliface faces and the displays of themes.js: the grids ask "is this cell lit?", the vector
// display draws the shapes. No DOM at module level, so the tests can import it.

// A display samples the face at (x, y) of its own space: 'wide' (x ∈ [0, 2], y ∈ [0, 1]) for the OLED and LED grids,
// 'square' (u, v ∈ [-1, 1]) for the round matrix. The frame is evaluated once per state object.
export function formatLit(face, display = 'wide') {
  const map = display === face.space ? null
    : display === 'wide' ? (x, y) => [(x - 1) * 2, y * 2 - 1]
      : (u, v) => [1 + u / 2, (v + 1) / 2];
  let state = null, minH = 0, frame = null;
  return (f, x, y, mh) => {
    if (f !== state || mh !== minH) [state, minH, frame] = [f, mh, face.frame(f, mh)];
    if (!map) return frame.on(x, y);
    const [a, b] = map(x, y);
    return frame.on(a, b);
  };
}

export const formatAnchors = (face, fallback) => (f) => face.anchors(f) ?? fallback(f);
