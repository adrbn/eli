// One of Eli's real faces (web/js/themes.js) on a canvas, plus a two-layer bloom. The wrapper blends in `screen`
// mode, so the screen's black lets whatever is behind it show through. Drawn at the render's pixel ratio
// (--scale=2 for 4K), so line faces stay sharp.
import React, { useLayoutEffect, useRef } from 'react';
import { useCurrentFrame } from 'remotion';
import { themeById } from '../../../web/js/themes.js';
import { seeded, withRandom } from '../lib/time.js';

export function FaceCanvas({ theme, w, h, f, glow = 1, crisp = false, style }) {
  const main = useRef(null), near = useRef(null), far = useRef(null), draws = useRef({});
  const frame = useCurrentFrame(), dpr = Math.min(2, window.devicePixelRatio || 1);
  useLayoutEffect(() => {
    const draw = (draws.current[theme] ||= themeById(theme).make());
    const ctx = main.current.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    withRandom(seeded(frame + 1), () => draw(ctx, w * dpr, h * dpr, f, 1 / 60));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const c of [near.current, far.current]) {
      if (!c) continue;
      const g = c.getContext('2d');
      g.clearRect(0, 0, c.width, c.height);
      g.drawImage(main.current, 0, 0, c.width, c.height);
    }
  });
  const fill = { position: 'absolute', inset: 0, width: '100%', height: '100%' };
  return (
    <div style={{ position: 'relative', width: w, height: h, mixBlendMode: 'screen', ...style }}>
      <canvas ref={main} width={w * dpr} height={h * dpr} style={{ ...fill, imageRendering: crisp ? 'pixelated' : 'auto' }} />
      {glow > 0 && <canvas ref={near} width={Math.ceil(w / 4)} height={Math.ceil(h / 4)} style={{ ...fill, filter: 'blur(3px)', opacity: 0.55 * glow, mixBlendMode: 'screen' }} />}
      {glow > 0 && <canvas ref={far} width={Math.ceil(w / 16)} height={Math.ceil(h / 16)} style={{ ...fill, filter: 'blur(5px)', opacity: 0.5 * glow, mixBlendMode: 'screen' }} />}
    </div>
  );
}
