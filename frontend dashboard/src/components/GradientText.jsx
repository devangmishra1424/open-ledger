import React from 'react';
import './GradientText.css';

export default function GradientText({
  children,
  className = '',
  colors = ['#60A5FA', '#C084FC', '#3B82F6', '#8B5CF6'],
  animationSpeed = 7,
  showBorder = false,
  direction = 'horizontal'
}) {
  const gradientAngle = direction === 'horizontal' ? 'to right' : 'to bottom';
  const gradientColors = [...colors, colors[0]].join(', ');

  const gradientStyle = {
    backgroundImage: `linear-gradient(${gradientAngle}, ${gradientColors})`,
    '--gradient-speed': `${animationSpeed}s`
  };

  return (
    <div className={`animated-gradient-text ${className}`}>
      <span className="text-content" style={gradientStyle}>
        {children}
      </span>
    </div>
  );
}
