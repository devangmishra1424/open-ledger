import React, { useEffect, useRef } from 'react';
import { Renderer, Triangle, Program, Mesh } from 'ogl';
import './Prism.css';

const Prism = ({
  height = 3.5,
  baseWidth = 5.5,
  animationType = 'rotate',
  glow = 0.4,
  offset = { x: 0, y: 0 },
  noise = 0.05,
  transparent = true,
  scale = 4.5,
  hueShift = 0.55,
  colorFrequency = 1,
  hoverStrength = 2,
  inertia = 0.05,
  bloom = 1,
  suspendWhenOffscreen = false,
  timeScale = 0.15,
  lightMode = false
}) => {
  const containerRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let renderer, gl, ro;
    let raf = 0;

    try {
      const H = Math.max(0.001, height);
      const BW = Math.max(0.001, baseWidth);
      const BASE_HALF = BW * 0.5;
      const GLOW = Math.max(0.0, glow);
      const NOISE = Math.max(0.0, noise);
      const offX = offset?.x ?? 0;
      const offY = offset?.y ?? 0;
      const SAT = transparent ? 1.5 : 1;
      const SCALE = Math.max(0.001, scale);
      const HUE = hueShift || 0;
      const CFREQ = Math.max(0.0, colorFrequency || 1);
      const BLOOM = Math.max(0.0, bloom || 1);
      const RSX = 1;
      const RSY = 1;
      const RSZ = 1;
      const TS = Math.max(0, timeScale || 1);
      const HOVSTR = Math.max(0, hoverStrength || 1);
      const INERT = Math.max(0, Math.min(1, inertia || 0.12));

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      renderer = new Renderer({
        dpr,
        alpha: transparent,
        antialias: false
      });
      gl = renderer.gl;
      if (!gl) return;

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.BLEND);

      Object.assign(gl.canvas.style, {
        position: 'absolute',
        inset: '0',
        width: '100%',
        height: '100%',
        display: 'block'
      });
      container.appendChild(gl.canvas);

      const vertex = /* glsl */ `
        attribute vec2 position;
        void main() {
          gl_Position = vec4(position, 0.0, 1.0);
        }
      `;

      const fragment = /* glsl */ `
        precision highp float;

        uniform vec2  iResolution;
        uniform float iTime;

        uniform float uHeight;
        uniform float uBaseHalf;
        uniform mat3  uRot;
        uniform int   uUseBaseWobble;
        uniform float uGlow;
        uniform vec2  uOffsetPx;
        uniform float uNoise;
        uniform float uSaturation;
        uniform float uScale;
        uniform float uHueShift;
        uniform float uColorFreq;
        uniform float uBloom;
        uniform float uCenterShift;
        uniform float uInvBaseHalf;
        uniform float uInvHeight;
        uniform float uMinAxis;
        uniform float uPxScale;
        uniform float uTimeScale;
        uniform float uLightMode;

        vec4 tanh4(vec4 x){
          vec4 e2x = exp(2.0*x);
          return (e2x - 1.0) / (e2x + 1.0);
        }

        float rand(vec2 co){
          return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453123);
        }

        float sdOctaAnisoInv(vec3 p){
          vec3 q = vec3(abs(p.x) * uInvBaseHalf, abs(p.y) * uInvHeight, abs(p.z) * uInvBaseHalf);
          float m = q.x + q.y + q.z - 1.0;
          return m * uMinAxis * 0.5773502691896258;
        }

        float sdPyramidUpInv(vec3 p){
          float oct = sdOctaAnisoInv(p);
          float halfSpace = -p.y;
          return max(oct, halfSpace);
        }

        mat3 hueRotation(float a){
          float c = cos(a), s = sin(a);
          mat3 W = mat3(
            0.299, 0.587, 0.114,
            0.299, 0.587, 0.114,
            0.299, 0.587, 0.114
          );
          mat3 U = mat3(
             0.701, -0.587, -0.114,
            -0.299,  0.413, -0.114,
            -0.300, -0.588,  0.886
          );
          mat3 V = mat3(
             0.168, -0.331,  0.500,
             0.328,  0.035, -0.500,
            -0.497,  0.296,  0.201
          );
          return W + U * c + V * s;
        }

        void main(){
          vec2 f = (gl_FragCoord.xy - 0.5 * iResolution.xy - uOffsetPx) * uPxScale;

          float z = 5.0;
          float d = 0.0;

          vec3 p;
          vec4 o = vec4(0.0);

          float centerShift = uCenterShift;
          float cf = uColorFreq;

          mat2 wob = mat2(1.0);
          if (uUseBaseWobble == 1) {
            float t = iTime * uTimeScale;
            float c0 = cos(t + 0.0);
            float c1 = cos(t + 33.0);
            float c2 = cos(t + 11.0);
            wob = mat2(c0, c1, c2, c0);
          }

          const int STEPS = 80;
          for (int i = 0; i < STEPS; i++) {
            p = vec3(f, z);
            p.xz = p.xz * wob;
            p = uRot * p;
            vec3 q = p;
            q.y += centerShift;
            d = 0.1 + 0.2 * abs(sdPyramidUpInv(q));
            z -= d;
            o += (sin((p.y + z) * cf + vec4(0.0, 1.0, 2.0, 3.0)) + 1.0) / d;
          }

          o = tanh4(o * o * (uGlow * uBloom) / 1e5);

          vec3 col = o.rgb;
          float n = rand(gl_FragCoord.xy + vec2(iTime));
          col += (n - 0.5) * uNoise;
          col = clamp(col, 0.0, 1.0);

          float L = dot(col, vec3(0.2126, 0.7152, 0.0722));
          col = clamp(mix(vec3(L), col, uSaturation), 0.0, 1.0);

          if(abs(uHueShift) > 0.0001){
            col = clamp(hueRotation(uHueShift) * col, 0.0, 1.0);
          }

          if (uLightMode > 0.5) {
            float peak = max(col.r, max(col.g, col.b));
            vec3 chroma = pow(clamp(col / max(peak, 0.0001), 0.0, 1.0), vec3(1.14));
            gl_FragColor = vec4(mix(vec3(1.0), chroma, o.a * 0.94), 1.0);
          } else {
            gl_FragColor = vec4(col, o.a);
          }
        }
      `;

      const geometry = new Triangle(gl);
      const iResBuf = new Float32Array(2);
      const offsetPxBuf = new Float32Array(2);

      const program = new Program(gl, {
        vertex,
        fragment,
        uniforms: {
          iResolution: { value: iResBuf },
          iTime: { value: 0 },
          uHeight: { value: H },
          uBaseHalf: { value: BASE_HALF },
          uUseBaseWobble: { value: 1 },
          uRot: { value: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) },
          uGlow: { value: GLOW },
          uOffsetPx: { value: offsetPxBuf },
          uNoise: { value: NOISE },
          uSaturation: { value: SAT },
          uScale: { value: SCALE },
          uHueShift: { value: HUE },
          uColorFreq: { value: CFREQ },
          uBloom: { value: BLOOM },
          uCenterShift: { value: H * 0.25 },
          uInvBaseHalf: { value: 1 / BASE_HALF },
          uInvHeight: { value: 1 / H },
          uMinAxis: { value: Math.min(BASE_HALF, H) },
          uPxScale: {
            value: 1 / ((gl.drawingBufferHeight || 1) * 0.1 * SCALE)
          },
          uTimeScale: { value: TS },
          uLightMode: { value: lightMode ? 1.0 : 0.0 }
        }
      });
      const mesh = new Mesh(gl, { geometry, program });

      const resize = () => {
        const w = container.clientWidth || 1;
        const h = container.clientHeight || 1;
        renderer.setSize(w, h);
        iResBuf[0] = gl.drawingBufferWidth;
        iResBuf[1] = gl.drawingBufferHeight;
        offsetPxBuf[0] = offX * dpr;
        offsetPxBuf[1] = offY * dpr;
        program.uniforms.uPxScale.value = 1 / ((gl.drawingBufferHeight || 1) * 0.1 * SCALE);
      };
      ro = new ResizeObserver(resize);
      ro.observe(container);
      resize();

      const rotBuf = new Float32Array(9);
      const setMat3FromEuler = (yawY, pitchX, rollZ, out) => {
        const cy = Math.cos(yawY), sy = Math.sin(yawY);
        const cx = Math.cos(pitchX), sx = Math.sin(pitchX);
        const cz = Math.cos(rollZ), sz = Math.sin(rollZ);
        out[0] = cy * cz + sy * sx * sz;
        out[1] = cx * sz;
        out[2] = -sy * cz + cy * sx * sz;
        out[3] = -cy * sz + sy * sx * cz;
        out[4] = cx * cz;
        out[5] = sy * sz + cy * sx * cz;
        out[6] = sy * cx;
        out[7] = -sx;
        out[8] = cy * cx;
        return out;
      };

      const startRAF = () => {
        if (raf) return;
        raf = requestAnimationFrame(render);
      };

      const t0 = performance.now();
      const render = (t) => {
        const time = (t - t0) * 0.001;
        program.uniforms.iTime.value = time;
        rotBuf[0] = 1; rotBuf[1] = 0; rotBuf[2] = 0;
        rotBuf[3] = 0; rotBuf[4] = 1; rotBuf[5] = 0;
        rotBuf[6] = 0; rotBuf[7] = 0; rotBuf[8] = 1;
        program.uniforms.uRot.value = rotBuf;
        renderer.render({ scene: mesh });
        raf = requestAnimationFrame(render);
      };

      startRAF();

    } catch (err) {
      console.warn("WebGL Prism backdrop disabled:", err);
    }

    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      if (gl && gl.canvas && gl.canvas.parentElement === container) {
        container.removeChild(gl.canvas);
      }
    };
  }, [
    height, baseWidth, animationType, glow, noise, offset?.x, offset?.y, 
    scale, transparent, hueShift, colorFrequency, timeScale, hoverStrength, 
    inertia, bloom, suspendWhenOffscreen, lightMode
  ]);

  return <div className="prism-container" ref={containerRef} />;
};

export default Prism;
