import React, { useRef, useEffect, useState } from 'react';
import './ScrollStack.css';

export const ScrollStackItem = ({ children, className = '', style = {} }) => {
  return (
    <div className={`scroll-stack-item-wrapper ${className}`} style={style}>
      {children}
    </div>
  );
};

const ScrollStack = ({
  children,
  itemDistance = 140,
  itemScale = 0.03,
  itemStackDistance = 28,
  baseScale = 0.92,
  blurAmount = 2,
  useWindowScroll = false,
  className = '',
  style = {}
}) => {
  const containerRef = useRef(null);
  const [itemStyles, setItemStyles] = useState([]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateCardTransforms = () => {
      const items = Array.from(container.children);
      const scrollTop = container.scrollTop;

      const styles = items.map((item, index) => {
        const itemInitialTop = item.offsetTop;
        const distFromTop = itemInitialTop - scrollTop;
        const stickyThreshold = index * itemStackDistance;

        // When item reaches its sticky stacked position
        if (distFromTop <= stickyThreshold) {
          const depthInStack = Math.max(0, (stickyThreshold - distFromTop) / 110);
          const excessDepth = Math.max(0, depthInStack - 2.8);
          
          // Translate upward as new cards push from below to prevent stack from growing downwards indefinitely
          const translateY = (index * itemStackDistance) - (excessDepth * 28);
          const scale = Math.max(1 - depthInStack * itemScale, baseScale);
          
          // Smooth opacity fade: cards 0..3 stay visible, cards > 3 fade out completely to 0 opacity
          const opacity = Math.max(0, 1 - (depthInStack / 3.2));
          const blur = blurAmount > 0 ? Math.min(depthInStack * blurAmount, 5) : 0;

          return {
            transform: `translateY(${translateY}px) scale(${scale})`,
            opacity: opacity,
            filter: blur > 0 ? `blur(${blur}px)` : 'none',
            zIndex: 100 - index
          };
        }

        // Unstacked normal scrolling state
        return {
          transform: 'none',
          opacity: 1,
          filter: 'none',
          zIndex: 10 + index
        };
      });

      setItemStyles(styles);
    };

    container.addEventListener('scroll', updateCardTransforms, { passive: true });
    updateCardTransforms();

    return () => container.removeEventListener('scroll', updateCardTransforms);
  }, [itemDistance, itemScale, itemStackDistance, baseScale, blurAmount]);

  return (
    <div
      ref={containerRef}
      className={`scroll-stack-container ${className}`}
      style={{
        height: useWindowScroll ? 'auto' : 'calc(100vh - 280px)',
        ...style
      }}
    >
      {React.Children.map(children, (child, idx) => {
        if (!React.isValidElement(child)) return child;
        const styleState = itemStyles[idx] || {};
        return (
          <div
            className="scroll-stack-item-wrapper"
            style={{
              transform: styleState.transform || 'none',
              opacity: styleState.opacity !== undefined ? styleState.opacity : 1,
              filter: styleState.filter || 'none',
              zIndex: styleState.zIndex || (10 + idx)
            }}
          >
            {child}
          </div>
        );
      })}
    </div>
  );
};

export default ScrollStack;
