import React, { useEffect, useState } from 'react';
import { Composition, continueRender, delayRender, staticFile } from 'remotion';
import { Trailer } from './Trailer.jsx';
import { FPS } from './lib/time.js';
import score from './data/score.json';

function WithFonts() {
  const [handle] = useState(() => delayRender('fonts'));
  useEffect(() => {
    const face = new FontFace('Departure', `url(${staticFile('DepartureMono-Regular.woff2')})`);
    face.load().then((f) => { document.fonts.add(f); return document.fonts.ready }).then(() => continueRender(handle), () => continueRender(handle));
  }, [handle]);
  return <Trailer />;
}

export const Root = () => (
  <Composition id="Trailer" component={WithFonts} durationInFrames={Math.round(score.bands.LEN * FPS)} fps={FPS} width={1920} height={1080} />
);
