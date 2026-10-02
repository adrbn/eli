// The three homes: a Mac, an iPhone, and the ESP32 board it is heading for. Drawn in CSS, faces from the app.
import React from 'react';
import { FaceCanvas } from './FaceCanvas.jsx';
import { MONO } from './Type.jsx';

const edge = 'rgba(255,255,255,.14)';

export function MacBook({ f }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ width: 820, height: 520, borderRadius: 26, padding: 16, background: 'linear-gradient(#1b1e1b,#0c0e0c)', boxShadow: `inset 0 0 0 1.5px ${edge}, 0 40px 120px rgba(0,0,0,.7)` }}>
        <div style={{ position: 'relative', width: '100%', height: '100%', borderRadius: 12, background: '#000', overflow: 'hidden', display: 'grid', placeItems: 'center' }}>
          <div style={{ position: 'absolute', top: 0, left: '50%', width: 130, height: 22, marginLeft: -65, background: '#0c0e0c', borderRadius: '0 0 10px 10px' }} />
          <FaceCanvas theme="pixel" w={740} h={370} f={f} crisp />
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(115deg, rgba(255,255,255,.06), transparent 40%)' }} />
        </div>
      </div>
      <div style={{ width: 960, height: 24, marginTop: -2, borderRadius: '4px 4px 22px 22px', background: 'linear-gradient(#3a3e3a,#151715)', boxShadow: `inset 0 1px 0 ${edge}` }}>
        <div style={{ width: 150, height: 8, margin: '0 auto', borderRadius: '0 0 8px 8px', background: '#101210' }} />
      </div>
    </div>
  );
}

export function IPhone({ f }) {
  return (
    <div style={{ width: 250, height: 520, borderRadius: 48, padding: 9, background: 'linear-gradient(135deg,#2a2d2a,#0e100e)', boxShadow: `inset 0 0 0 1.5px ${edge}, 0 40px 100px rgba(0,0,0,.7)` }}>
      <div style={{ position: 'relative', width: '100%', height: '100%', borderRadius: 40, background: '#000', overflow: 'hidden', display: 'grid', placeItems: 'center' }}>
        <div style={{ position: 'absolute', top: 12, left: '50%', width: 76, height: 22, marginLeft: -38, borderRadius: 12, background: '#000' }} />
        <FaceCanvas theme="trait-doux" w={220} h={220} f={f} />
      </div>
    </div>
  );
}

export function Esp32({ f }) {
  const pins = Array.from({ length: 15 });
  return (
    <div style={{ position: 'relative', width: 320, height: 210, borderRadius: 14, background: 'linear-gradient(160deg,#13264f,#0a1631)', boxShadow: `inset 0 0 0 1.5px rgba(150,180,255,.18), 0 40px 100px rgba(0,0,0,.7)` }}>
      {[[14, 14], [290, 14], [14, 180], [290, 180]].map(([x, y], i) => (
        <div key={i} style={{ position: 'absolute', left: x, top: y, width: 16, height: 16, borderRadius: 8, background: '#000', boxShadow: '0 0 0 4px #b8963f' }} />
      ))}
      {[18, 192].map((y) => (
        <div key={y} style={{ position: 'absolute', left: 52, top: y - 6, display: 'flex', gap: 6 }}>
          {pins.map((_, i) => <div key={i} style={{ width: 9, height: 9, borderRadius: 5, background: '#0a0a0a', boxShadow: '0 0 0 2.5px #c9a64a' }} />)}
        </div>
      ))}
      <div style={{ position: 'absolute', left: 40, top: 40, width: 240, height: 128, borderRadius: 6, background: '#000', boxShadow: 'inset 0 0 0 2px #1d1f24', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
        <FaceCanvas theme="pixel" w={256} h={128} f={f} crisp glow={0.8} style={{ transform: 'scale(.86)' }} />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(120deg, rgba(160,190,255,.09), transparent 45%)' }} />
      </div>
      <div style={{ position: 'absolute', right: 16, bottom: 36, fontFamily: MONO, fontSize: 11, color: 'rgba(255,255,255,.55)' }}>ESP32-S3 · SSD1306</div>
    </div>
  );
}
