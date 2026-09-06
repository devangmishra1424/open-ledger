import React, { useEffect, useRef, useState } from 'react';
import './AsciiArt.css';

const DENSITY = ' .:-=+*#%@';

const AsciiArt = ({
  src = 'https://meme-arsenal.com/create/template/11325500',
  resolution = 60,
  color = '#94a3b8',
  animationStyle = 'fade',
  animationDuration = 1.5,
  className = '',
  style = {}
}) => {
  const [asciiText, setAsciiText] = useState('');
  const [isLoaded, setIsLoaded] = useState(false);
  const canvasRef = useRef(null);

  useEffect(() => {
    let isMounted = true;
    const img = new Image();
    img.crossOrigin = 'Anonymous';

    const generateProceduralFallback = () => {
      // High-tech Open Ledger financial matrix pattern
      const rows = Math.floor(resolution * 0.45);
      const cols = resolution;
      const chars = ['$', '€', '£', '¥', '0', '1', 'Ξ', '₿', '░', '▒', '▓', '#', '*', '+', '-', '.'];
      let output = '';

      for (let r = 0; r < rows; r++) {
        let line = '';
        for (let c = 0; c < cols; c++) {
          // Circular pattern + wave math to create a stunning ASCII portrait/sphere
          const dx = (c - cols / 2) / (cols / 2);
          const dy = (r - rows / 2) / (rows / 2);
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < 0.85) {
            const val = Math.floor((1 - dist) * (chars.length - 1) + (Math.sin(c * 0.2 + r * 0.3) * 2));
            const charIdx = Math.max(0, Math.min(chars.length - 1, val));
            line += chars[charIdx];
          } else {
            line += ' ';
          }
        }
        output += line + '\n';
      }

      if (isMounted) {
        setAsciiText(output);
        setIsLoaded(true);
      }
    };

    img.onload = () => {
      try {
        const canvas = canvasRef.current || document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const width = resolution;
        const height = Math.floor(resolution * (img.height / img.width) * 0.5);
        canvas.width = width;
        canvas.height = height;

        ctx.drawImage(img, 0, 0, width, height);
        const imgData = ctx.getImageData(0, 0, width, height).data;

        let result = '';
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            const r = imgData[idx];
            const g = imgData[idx + 1];
            const b = imgData[idx + 2];
            const avg = (r + g + b) / 3;
            const charIndex = Math.floor((avg / 255) * (DENSITY.length - 1));
            result += DENSITY[charIndex] || ' ';
          }
          result += '\n';
        }

        if (isMounted && result.trim().length > 0) {
          setAsciiText(result);
          setIsLoaded(true);
        } else {
          generateProceduralFallback();
        }
      } catch (err) {
        generateProceduralFallback();
      }
    };

    img.onerror = () => {
      generateProceduralFallback();
    };

    img.src = src;

    return () => {
      isMounted = false;
    };
  }, [src, resolution]);

  return (
    <div
      className={`ascii-art-container ${animationStyle === 'fade' ? 'ascii-fade-in' : ''} ${className}`}
      style={{
        '--ascii-color': color,
        '--ascii-duration': `${animationDuration}s`,
        ...style
      }}
    >
      <canvas ref={canvasRef} style={{ display: 'none' }} />
      <pre className="ascii-art-pre" style={{ color: color }}>
        {asciiText}
      </pre>
    </div>
  );
};

export default AsciiArt;
