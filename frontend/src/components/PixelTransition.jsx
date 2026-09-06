import React, { useState, useRef, useEffect } from 'react';
import gsap from 'gsap';
import './PixelTransition.css';

const PixelTransition = ({
  firstContent,
  secondContent,
  gridSize = 8,
  pixelColor = '#4F6BFF',
  animationStepDuration = 0.4,
  className = '',
  style = {}
}) => {
  const [activeContent, setActiveContent] = useState(1); // 1 = firstContent, 2 = secondContent
  const [isHovered, setIsHovered] = useState(false);
  const containerRef = useRef(null);
  const pixelsRef = useRef([]);
  const isAnimatingRef = useRef(false);

  const totalPixels = gridSize * gridSize;

  const handleToggle = () => {
    if (isAnimatingRef.current) return;
    isAnimatingRef.current = true;

    const pixels = pixelsRef.current.filter(Boolean);

    // Timeline for pixel dissolve transition
    const tl = gsap.timeline({
      onComplete: () => {
        isAnimatingRef.current = false;
      }
    });

    // Step 1: Pixel blocks expand to fill the screen
    tl.to(pixels, {
      scale: 1,
      opacity: 1,
      duration: animationStepDuration,
      ease: 'power2.inOut',
      stagger: {
        grid: [gridSize, gridSize],
        from: 'random',
        amount: animationStepDuration * 0.75
      },
      onComplete: () => {
        setActiveContent(prev => (prev === 1 ? 2 : 1));
      }
    });

    // Step 2: Pixel blocks dissolve away revealing new content
    tl.to(pixels, {
      scale: 0,
      opacity: 0,
      duration: animationStepDuration,
      ease: 'power2.inOut',
      stagger: {
        grid: [gridSize, gridSize],
        from: 'random',
        amount: animationStepDuration * 0.75
      }
    });
  };

  const handleMouseEnter = () => {
    setIsHovered(true);
    if (activeContent === 1) {
      handleToggle();
    }
  };

  const handleMouseLeave = () => {
    setIsHovered(false);
    if (activeContent === 2) {
      handleToggle();
    }
  };

  return (
    <div
      ref={containerRef}
      className={`pixel-transition-wrapper ${className}`}
      style={style}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleToggle}
    >
      {/* Active Content Display */}
      <div className="pixel-content-layer">
        {activeContent === 1 ? firstContent : secondContent}
      </div>

      {/* Pixel Grid Overlay */}
      <div
        className="pixel-grid-overlay"
        style={{
          gridTemplateColumns: `repeat(${gridSize}, 1fr)`,
          gridTemplateRows: `repeat(${gridSize}, 1fr)`
        }}
      >
        {Array.from({ length: totalPixels }).map((_, idx) => (
          <div
            key={idx}
            ref={el => (pixelsRef.current[idx] = el)}
            className="pixel-block"
            style={{
              backgroundColor: pixelColor
            }}
          />
        ))}
      </div>
    </div>
  );
};

export default PixelTransition;
