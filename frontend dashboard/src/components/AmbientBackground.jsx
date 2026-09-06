import React from 'react';
import Prism from './Prism';
import './AmbientBackground.css';

const AmbientBackground = () => {
  return (
    <div className="ambient-bg-container" data-testid="ambient-background">
      {/* Primary Spectrum CSS Radial Gradient Blobs */}
      <div className="ambient-blob blob-amber" />
      <div className="ambient-blob blob-teal" />
      <div className="ambient-blob blob-blue" />
      <div className="ambient-blob blob-gold" />

      {/* OGL Prism Spectrum Enhancement Layer */}
      <div className="prism-overlay">
        <Prism
          animationType="rotate"
          timeScale={0.15}
          scale={4.2}
          glow={0.85}
          noise={0.04}
          hueShift={0.65}
          colorFrequency={1.2}
          transparent={true}
        />
      </div>
    </div>
  );
};

export default AmbientBackground;
