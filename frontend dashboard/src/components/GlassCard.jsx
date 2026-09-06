import React from 'react';

const GlassCard = ({ children, className = '', style = {}, onClick }) => {
  return (
    <div
      className={`glass-card ${className}`}
      style={style}
      onClick={onClick}
    >
      {children}
    </div>
  );
};

export default GlassCard;
