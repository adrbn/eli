// One of Eli's real faces (web/js/themes.js) on a canvas, plus a two-layer bloom. The wrapper blends in `screen`
// mode, so the screen's black lets whatever is behind it show through.
import React, { useLayoutEffect, useRef } from 'react';
import { useCurrentFrame } from 'remotion';
import { themeById } from '../../../web/js/themes.js';
import { seeded, withRandom } from '../lib/time.js';

const VECTOR = /^(trait|chaton|oscillo)/;

export function FaceCanvas({ theme, w, h, f, glow = 1, crisp = false, style }) {
  const main = useRef(null), near = useRef(null), far = useRef(null), draws = useRef({});
  const frame = useCurrentFrame();
  useLayoutEffect(() => {
    const draw = (draws.current[theme] ||= themeById(theme).make());
    const ctx = main.current.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    withRandom(seeded(frame + 1), () => draw(ctx, w, h, f, 1 / 60));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (VECTOR.test(theme)) { // line faces paint the app's page grey (5,6,5): take it back to pure black
      ctx.globalCompositeOperation = 'difference';
      ctx.fillStyle = 'rgb(5,6,5)';
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
    }
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
      <canvas ref={main} width={w} height={h} style={{ ...fill, imageRendering: crisp ? 'pixelated' : 'auto' }} />
      {glow > 0 && <canvas ref={near} width={Math.ceil(w / 4)} height={Math.ceil(h / 4)} style={{ ...fill, filter: 'blur(3px)', opacity: 0.55 * glow, mixBlendMode: 'screen' }} />}
      {glow > 0 && <canvas ref={far} width={Math.ceil(w / 16)} height={Math.ceil(h / 16)} style={{ ...fill, filter: 'blur(5px)', opacity: 0.5 * glow, mixBlendMode: 'screen', transform: 'scale(1.15)' }} />}
    </div>
  );
}
