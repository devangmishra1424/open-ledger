import React, { useEffect, useRef } from 'react';
import { gsap } from 'gsap';

const GlobalSpotlight = ({ spotlightRadius = 350, glowColor = '99, 102, 241' }) => {
  const spotlightRef = useRef(null);

  useEffect(() => {
    // Check reduced motion preference
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }

    const spotlight = document.createElement('div');
    spotlight.className = 'global-spotlight';
    spotlightRef.current = spotlight;
    document.body.appendChild(spotlight);

    const handleMouseMove = (e) => {
      if (!spotlightRef.current) return;

      const mouseX = e.clientX;
      const mouseY = e.clientY;

      // Update position of spotlight layer
      gsap.to(spotlightRef.current, {
        left: mouseX,
        top: mouseY,
        opacity: 0.8,
        duration: 0.15,
        ease: 'power2.out'
      });

      // Update glow properties on all glass-card elements on page
      const cards = document.querySelectorAll('.glass-card, .magic-bento-card');
      cards.forEach((card) => {
        const rect = card.getBoundingClientRect();
        
        // Calculate relative coordinates in percentage
        const relativeX = ((mouseX - rect.left) / rect.width) * 100;
        const relativeY = ((mouseY - rect.top) / rect.height) * 100;

        // Proximity calculation
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const distance = Math.hypot(mouseX - centerX, mouseY - centerY);
        const maxDist = Math.max(rect.width, rect.height) / 2 + spotlightRadius;

        let intensity = 0;
        if (distance < maxDist) {
          intensity = Math.max(0, 1 - distance / maxDist);
        }

        card.style.setProperty('--glow-x', `${relativeX}%`);
        card.style.setProperty('--glow-y', `${relativeY}%`);
        card.style.setProperty('--glow-intensity', intensity.toFixed(2));
        card.style.setProperty('--glow-radius', `${spotlightRadius}px`);
      });
    };

    const handleMouseLeave = () => {
      if (spotlightRef.current) {
        gsap.to(spotlightRef.current, { opacity: 0, duration: 0.3 });
      }
      const cards = document.querySelectorAll('.glass-card, .magic-bento-card');
      cards.forEach((card) => {
        card.style.setProperty('--glow-intensity', '0');
      });
    };

    window.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseleave', handleMouseLeave);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseleave', handleMouseLeave);
      if (spotlightRef.current && spotlightRef.current.parentNode) {
        spotlightRef.current.parentNode.removeChild(spotlightRef.current);
      }
    };
  }, [spotlightRadius, glowColor]);

  return null;
};

export default GlobalSpotlight;
