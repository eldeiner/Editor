/**
 * VidForge Pro — Professional Web Video Editor v2.0
 * Motor: FFmpeg WASM + Konva.js + Web Audio API + WebGL
 * Arquitectura: Modular, Event-driven, con Event Bus y sistema de plugins
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 0: EVENT BUS (arquitectura desacoplada)
════════════════════════════════════════════════════════════════ */
const EventBus = (() => {
  const listeners = {};
  return {
    on(event, cb)  { (listeners[event] = listeners[event] || []).push(cb); },
    off(event, cb) { if (listeners[event]) listeners[event] = listeners[event].filter(f => f !== cb); },
    emit(event, data) { (listeners[event] || []).forEach(cb => cb(data)); },
  };
})();

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 1: ESTADO GLOBAL
════════════════════════════════════════════════════════════════ */
const AppState = {
  // Video
  videoFile: null,
  videoDuration: 0,
  videoWidth: 0,
  videoHeight: 0,
  videoFps: 30,

  // Reproducción
  isPlaying: false,
  isLooping: false,
  isMuted: false,
  playbackSpeed: 1,
  renderProgress: 0,

  // Filtros de color
  filters: {
    brightness: 0, contrast: 0, saturation: 0, hue: 0,
    temperature: 0, exposure: 0, highlights: 0, shadows: 0,
    vignette: 0, blur: 0, filmGrain: 0, preset: 'none',
  },

  // Audio
  audio: {
    masterVolume: 100, fadeIn: 0, fadeOut: 0, pan: 0, pitch: 0,
    reverb: 0, compress: 0,
    eq: { 60: 0, 150: 0, 400: 0, 1000: 0, 2400: 0, 6000: 0, 16000: 0 },
    tracks: { a1: { vol: 100, muted: false, solo: false }, a2: { vol: 80, muted: false, solo: false } },
  },

  // Overlays (Konva)
  overlays: [],
  selectedOverlay: null,

  // Timeline
  clips: [],
  timelineZoom: 1,
  currentTime: 0,
  snapEnabled: true,
  snapToClips: true,
  markIn: 0,
  markOut: 0,
  tracks: {
    v1: { locked: false, visible: true },
    v2: { locked: false, visible: true },
    v3: { locked: false, visible: true },
    a1: { muted: false, solo: false },
    a2: { muted: false, solo: false },
    text: { locked: false, visible: true },
  },

  // Keyframes
  keyframes: [],       // { id, prop, time, value, interp }
  kfInterpolation: 'linear',

  // Transiciones
  activeTransition: 'cut',
  transitionDuration: 0.5,

  // GPU Effects
  gpuEffect: null,
  gpuIntensity: 50,

  // Historial undo/redo
  history: [],
  historyIndex: -1,

  // FFmpeg
  ffmpegLoaded: false,
  isRendering: false,

  // Herramientas
  activeTool: 'select',

  // Música
  musicFile: null,
  musicVolume: 50,

  // Aspect ratio
  aspectRatio: '16:9',

  // Modo cinema
  cinemaMode: false,

  // Grids/Safe areas
  showSafeArea: false,
  showGrid: false,

  // Proyecto
  projectName: 'Proyecto sin título',
  autoSaveInterval: null,
};

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 2: REFERENCIAS DOM
════════════════════════════════════════════════════════════════ */
const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

const DOM = {
  splash:          $('splash'),
  splashFill:      $('splashFill'),
  splashStatus:    $('splashStatus'),
  app:             $('app'),
  video:           $('videoPlayer'),
  konvaContainer:  $('konvaContainer'),
  vignetteOverlay: $('vignetteOverlay'),
  dropOverlay:     $('dropOverlay'),
  uploadZone:      $('uploadZone'),
  fileInput:       $('fileInput'),
  musicInput:      $('musicInput'),
  currentTime:     $('currentTime'),
  totalTime:       $('totalTime'),
  btnPlayPause:    $('btnPlayPause'),
  playhead:        $('playhead'),
  tracksContainer: $('tracksContainer'),
  tlRuler:         $('tlRuler'),
  histogramCanvas: $('histogramCanvas'),
  vectorscopeCanvas: $('vectorscopeCanvas'),
  fpsBadge:        $('fpsBadge'),
  layersPanel:     $('layersPanel'),
  historyPanel:    $('historyPanel'),
  toastContainer:  $('toastContainer'),
  modalRender:     $('modalRender'),
  modalBar:        $('modalBar'),
  modalPct:        $('modalPct'),
  modalStatus:     $('modalRenderStatus'),
  videoInfo:       $('videoInfo'),
  cinemaBars:      $('cinemaBars'),
  grainCanvas:     $('grainCanvas'),
  glCanvas:        $('glCanvas'),
  kfTrack:         $('kfTrack'),
  kfList:          $('kfList'),
  safeAreaOverlay: $('safeAreaOverlay'),
  gridOverlay:     $('gridOverlay'),
};

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 3: MOTOR FFmpeg WASM
════════════════════════════════════════════════════════════════ */
const FFmpegEngine = (() => {
  let ffmpeg = null;

  async function init() {
    try {
      updateSplash(10, 'Cargando FFmpeg WASM…');
      markModule('mod-ffmpeg', false);

      // Verificar que la clase FFmpeg esté disponible (importada como ESM o UMD)
      const FFmpegClass = (typeof FFmpeg !== 'undefined' && FFmpeg.FFmpeg)
        ? FFmpeg.FFmpeg
        : (typeof FFmpegWASM !== 'undefined' && FFmpegWASM.FFmpeg)
          ? FFmpegWASM.FFmpeg
          : null;

      if (!FFmpegClass) {
        console.warn('FFmpeg WASM no disponible — exportación deshabilitada');
        AppState.ffmpegLoaded = false;
        markModule('mod-ffmpeg', false);
        updateSplash(80, 'FFmpeg no disponible — exportación deshabilitada');
        showExportError('FFmpeg no pudo cargarse. La exportación real no está disponible.');
        return false;
      }

      ffmpeg = new FFmpegClass();
      ffmpeg.on('progress', ({ progress }) => {
        const pct = Math.round(progress * 100);
        updateRenderProgress(pct);
        EventBus.emit('renderProgress', pct);
      });
      ffmpeg.on('log', ({ message }) => console.log('[FFmpeg]', message));

      await ffmpeg.load({
        coreURL:  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js',
        wasmURL:  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm',
      });

      AppState.ffmpegLoaded = true;
      markModule('mod-ffmpeg', true);
      updateSplash(80, 'Motor de video listo');
      return true;
    } catch (e) {
      console.error('FFmpeg init error:', e);
      AppState.ffmpegLoaded = false;
      markModule('mod-ffmpeg', false);
      updateSplash(80, 'FFmpeg no disponible — exportación deshabilitada');
      showExportError('FFmpeg no pudo inicializarse: ' + e.message);
      return false;
    }
  }

  function showExportError(msg) {
    // Mostrar error persistente en el panel de exportación al abrirlo
    AppState._ffmpegError = msg;
  }

  async function applyFiltersAndExport(file, filters, opts = {}) {
    if (!AppState.ffmpegLoaded) {
      throw new Error(AppState._ffmpegError || 'FFmpeg no está inicializado. No se puede exportar el video real.');
    }

    const { FFmpegUtil } = window;
    const ext  = file.name.split('.').pop();
    const fmt  = opts.format || 'mp4';
    const inN  = 'input.' + ext;
    const outN = 'output.' + fmt;
    const data = await FFmpegUtil.fetchFile(file);
    await ffmpeg.writeFile(inN, data);

    const vfParts = [];

    // EQ de color
    const eq = buildEqFilter(filters);
    if (eq) vfParts.push(eq);
    if (filters.hue !== 0) vfParts.push(`hue=h=${filters.hue}`);
    if (filters.temperature !== 0) {
      const r = filters.temperature > 0 ? 1 + filters.temperature * 0.005 : 1;
      const b = filters.temperature < 0 ? 1 + Math.abs(filters.temperature) * 0.005 : 1;
      vfParts.push(`colorchannelmixer=rr=${r.toFixed(3)}:bb=${b.toFixed(3)}`);
    }
    if (filters.blur > 0) vfParts.push(`boxblur=${filters.blur}:${filters.blur}`);
    if (filters.vignette > 0) {
      const angle = (filters.vignette / 100 * 1.5).toFixed(2);
      vfParts.push(`vignette=angle=${angle}`);
    }
    const presetF = getPresetFilter(filters.preset);
    if (presetF) vfParts.push(presetF);
    if (AppState.playbackSpeed !== 1) {
      const pts = (1 / AppState.playbackSpeed).toFixed(4);
      vfParts.push(`setpts=${pts}*PTS`);
    }
    const scaleF = getScaleFilter(opts.quality);
    if (scaleF) vfParts.push(scaleF);

    const vf = vfParts.length ? ['-vf', vfParts.join(',')] : [];

    // Audio filters
    const afParts = [];
    const vol = (AppState.audio.masterVolume / 100).toFixed(2);
    afParts.push(`volume=${vol}`);
    if (AppState.audio.fadeIn > 0)  afParts.push(`afade=t=in:ss=0:d=${AppState.audio.fadeIn}`);
    if (AppState.audio.fadeOut > 0) {
      const fo = Math.max(0, AppState.videoDuration - AppState.audio.fadeOut);
      afParts.push(`afade=t=out:st=${fo.toFixed(2)}:d=${AppState.audio.fadeOut}`);
    }
    const af = afParts.length ? ['-af', afParts.join(',')] : [];

    const videoCodec = fmt === 'webm' ? ['-c:v', 'libvpx-vp9'] : ['-c:v', 'libx264', '-preset', 'medium'];
    const crf = opts.quality === 'high' ? '18' : opts.quality === 'medium' ? '23' : opts.quality === 'low' ? '28' : '32';
    const fps = ['-r', String(opts.fps || 30)];
    const ssTrim = opts.startSec != null ? ['-ss', String(opts.startSec)] : [];
    const tTrim  = (opts.startSec != null && opts.endSec != null) ? ['-t', String(opts.endSec - opts.startSec)] : [];

    const args = [...ssTrim, '-i', inN, ...tTrim, ...vf, ...af,
      ...videoCodec, '-crf', crf, '-b:v', opts.bitrate || '4000k',
      '-c:a', 'aac', '-b:a', '192k', ...fps, outN];

    updateRenderProgress(5);
    await ffmpeg.exec(args);
    const result = await ffmpeg.readFile(outN);
    return new Uint8Array(result.buffer);
  }

  function buildEqFilter(f) {
    if (f.brightness === 0 && f.contrast === 0 && f.saturation === 0 && f.exposure === 0) return null;
    const b = (f.brightness / 100 * 0.5).toFixed(3);
    const c = (1 + f.contrast / 100).toFixed(3);
    const s = (1 + f.saturation / 100).toFixed(3);
    const e = (f.exposure / 100 * 0.5).toFixed(3);
    return `eq=brightness=${b}:contrast=${c}:saturation=${s}:gamma=${(1 - parseFloat(e)).toFixed(3)}`;
  }

  function getPresetFilter(preset) {
    const map = {
      vivid:      'eq=saturation=1.6:contrast=1.1,hue=h=5',
      cinematic:  'eq=contrast=1.2:saturation=0.7:brightness=-0.05,colorchannelmixer=rr=0.95:bb=1.1',
      teal_orange:'eq=contrast=1.15:saturation=1.1,colorchannelmixer=rr=1.05:gg=1.0:bb=0.8',
      vintage:    'eq=saturation=0.5:contrast=1.1:brightness=0.05,colorchannelmixer=rr=1.1:gg=0.95:bb=0.85',
      bw:         'colorchannelmixer=.3:.4:.3:0:.3:.4:.3:0:.3:.4:.3',
      summer:     'eq=saturation=1.4:brightness=0.06,colorchannelmixer=rr=1.1:gg=1.0:bb=0.85',
      cool:       'eq=saturation=1.1,colorchannelmixer=rr=0.9:bb=1.15',
      drama:      'eq=contrast=1.4:saturation=0.6:brightness=-0.1,vignette=angle=1.2',
      cyberpunk:  'eq=saturation=2.0:contrast=1.2,hue=h=270',
      golden:     'eq=saturation=1.3:brightness=0.04,colorchannelmixer=rr=1.15:gg=0.98:bb=0.75',
    };
    return map[preset] || null;
  }

  function getScaleFilter(quality) {
    const map = { '4k': 2160, high: 1080, medium: 720, low: 480, social: 360 };
    const h = map[quality];
    return h ? `scale=-2:${h}` : null;
  }

  async function simulateRender(label, ms) {
    const steps = 20;
    for (let i = 0; i <= steps; i++) {
      await delay(ms / steps);
      updateRenderProgress(Math.round((i / steps) * 100));
    }
    return new Uint8Array(0);
  }

  function updateRenderProgress(pct) {
    if (DOM.modalBar)  DOM.modalBar.style.width  = pct + '%';
    if (DOM.modalPct)  DOM.modalPct.textContent   = pct + '%';
    AppState.renderProgress = pct;

    // ETA estimado
    if (pct > 0 && pct < 100) {
      const eta = $('renderETA');
      if (eta) eta.textContent = `ETA: ~${Math.round((100 - pct) / pct * 3)}s`;
    }
  }

  return { init, applyFiltersAndExport, updateRenderProgress };
})();

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 4: MOTOR WEBGL (GPU Effects)
════════════════════════════════════════════════════════════════ */
const GPUEngine = (() => {
  let gl = null;
  let program = null;
  let activeEffect = null;

  const vertexSrc = `
    attribute vec2 a_position;
    attribute vec2 a_texCoord;
    varying vec2 v_texCoord;
    void main() {
      gl_Position = vec4(a_position, 0, 1);
      v_texCoord  = a_texCoord;
    }
  `;

  const fragmentShaders = {
    bloom: `
      precision mediump float;
      uniform sampler2D u_texture;
      uniform float u_intensity;
      varying vec2 v_texCoord;
      void main() {
        vec4 color = texture2D(u_texture, v_texCoord);
        vec4 blur = vec4(0.0);
        float spread = 0.006 * u_intensity;
        for(int x=-2;x<=2;x++) for(int y=-2;y<=2;y++) {
          blur += texture2D(u_texture, v_texCoord + vec2(float(x)*spread, float(y)*spread));
        }
        blur /= 25.0;
        gl_FragColor = color + blur * u_intensity * 0.5;
      }
    `,
    chromatic: `
      precision mediump float;
      uniform sampler2D u_texture;
      uniform float u_intensity;
      varying vec2 v_texCoord;
      void main() {
        float shift = u_intensity * 0.008;
        float r = texture2D(u_texture, v_texCoord + vec2(shift, 0.0)).r;
        float g = texture2D(u_texture, v_texCoord).g;
        float b = texture2D(u_texture, v_texCoord - vec2(shift, 0.0)).b;
        gl_FragColor = vec4(r, g, b, 1.0);
      }
    `,
    glitch: `
      precision mediump float;
      uniform sampler2D u_texture;
      uniform float u_intensity;
      uniform float u_time;
      varying vec2 v_texCoord;
      float rand(vec2 co){ return fract(sin(dot(co, vec2(12.9898,78.233)))*43758.5453); }
      void main() {
        vec2 uv = v_texCoord;
        float glitchAmt = u_intensity * 0.02;
        float stripe = floor(uv.y * 20.0);
        float r = rand(vec2(stripe, u_time));
        if(r > 0.92) uv.x += glitchAmt * (rand(vec2(stripe*2.0, u_time))*2.0 - 1.0);
        vec4 color = texture2D(u_texture, uv);
        float scanline = sin(uv.y * 400.0) * 0.04 * u_intensity;
        gl_FragColor = vec4(color.rgb - scanline, 1.0);
      }
    `,
    vhs: `
      precision mediump float;
      uniform sampler2D u_texture;
      uniform float u_intensity;
      uniform float u_time;
      varying vec2 v_texCoord;
      float rand(float n){ return fract(sin(n)*43758.5453); }
      void main() {
        vec2 uv = v_texCoord;
        uv.x += sin(uv.y * 50.0 + u_time * 2.0) * 0.002 * u_intensity;
        vec4 color = texture2D(u_texture, uv);
        float noise = rand(uv.y + u_time) * 0.05 * u_intensity;
        float scanline = sin(uv.y * 300.0) * 0.03 * u_intensity;
        vec3 vhsColor = mix(color.rgb, vec3(0.0,0.7,0.0), 0.05 * u_intensity);
        gl_FragColor = vec4(vhsColor - scanline + noise, 1.0);
      }
    `,
    neon: `
      precision mediump float;
      uniform sampler2D u_texture;
      uniform float u_intensity;
      varying vec2 v_texCoord;
      void main() {
        vec4 color = texture2D(u_texture, v_texCoord);
        float lum = dot(color.rgb, vec3(0.299, 0.587, 0.114));
        vec3 neon = color.rgb + vec3(0.0, 0.0, 0.2) * lum * u_intensity;
        neon += vec3(0.1, 0.0, 0.2) * (1.0 - lum) * u_intensity * 0.5;
        gl_FragColor = vec4(neon, 1.0);
      }
    `,
    duotone: `
      precision mediump float;
      uniform sampler2D u_texture;
      uniform float u_intensity;
      varying vec2 v_texCoord;
      void main() {
        vec4 color = texture2D(u_texture, v_texCoord);
        float lum = dot(color.rgb, vec3(0.299, 0.587, 0.114));
        vec3 dark  = vec3(0.07, 0.0, 0.17);
        vec3 light = vec3(1.0, 0.87, 0.0);
        vec3 duotone = mix(dark, light, lum);
        gl_FragColor = vec4(mix(color.rgb, duotone, u_intensity), 1.0);
      }
    `,
  };

  function init(canvas, video) {
    if (!canvas) return false;
    try {
      gl = canvas.getContext('webgl', { premultipliedAlpha: false });
      if (!gl) return false;
      markModule('mod-webgl', true);
      return true;
    } catch(e) {
      console.warn('WebGL no disponible:', e);
      return false;
    }
  }

  function compileShader(type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Shader error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  function buildProgram(fragSrc) {
    const vert = compileShader(gl.VERTEX_SHADER, vertexSrc);
    const frag = compileShader(gl.FRAGMENT_SHADER, fragSrc);
    if (!vert || !frag) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);
    return gl.getProgramParameter(prog, gl.LINK_STATUS) ? prog : null;
  }

  function applyEffect(effectName, video, intensity, time = 0) {
    if (!gl || !video || !effectName || !fragmentShaders[effectName]) {
      activeEffect = null;
      return;
    }
    if (activeEffect !== effectName) {
      activeEffect = effectName;
      program = buildProgram(fragmentShaders[effectName]);
    }
    if (!program) return;

    const canvas = DOM.glCanvas;
    const vw = video.videoWidth  || 640;
    const vh = video.videoHeight || 360;
    const rect = video.getBoundingClientRect();
    canvas.width  = rect.width;
    canvas.height = rect.height;
    canvas.style.width  = rect.width  + 'px';
    canvas.style.height = rect.height + 'px';

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(program);

    const positions = new Float32Array([-1,-1, 1,-1, -1,1, 1,1]);
    const texCoords = new Float32Array([0,1, 1,1, 0,0, 1,0]);

    const posLoc = gl.getAttribLocation(program, 'a_position');
    const texLoc = gl.getAttribLocation(program, 'a_texCoord');

    const posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const texBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, texBuf);
    gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(texLoc);
    gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video); }
    catch(e) { return; }

    gl.uniform1i(gl.getUniformLocation(program, 'u_texture'), 0);
    gl.uniform1f(gl.getUniformLocation(program, 'u_intensity'), intensity / 100);
    const timeLoc = gl.getUniformLocation(program, 'u_time');
    if (timeLoc) gl.uniform1f(timeLoc, time);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.deleteTexture(texture);
    gl.deleteBuffer(posBuf);
    gl.deleteBuffer(texBuf);
  }

  function clear() {
    if (!gl) return;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    activeEffect = null;
  }

  return { init, applyEffect, clear };
})();

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 5: MOTOR KONVA (Canvas Overlay)
════════════════════════════════════════════════════════════════ */
const KonvaEngine = (() => {
  let stage = null;
  let overlayLayer = null;
  let tr = null;

  function init(w, h) {
    if (stage) { stage.destroy(); stage = null; }
    DOM.konvaContainer.style.width  = w + 'px';
    DOM.konvaContainer.style.height = h + 'px';

    stage = new Konva.Stage({ container: 'konvaContainer', width: w, height: h });
    overlayLayer = new Konva.Layer();
    stage.add(overlayLayer);

    tr = new Konva.Transformer({
      rotateEnabled: true,
      enabledAnchors: ['top-left','top-right','bottom-left','bottom-right',
        'middle-left','middle-right','top-center','bottom-center'],
      borderStroke: '#f59e0b', borderStrokeWidth: 1.5,
      anchorFill: '#f59e0b', anchorStroke: '#000',
      anchorStrokeWidth: 1, anchorSize: 8, borderDash: [4,4],
    });
    overlayLayer.add(tr);

    stage.on('click tap', (e) => {
      if (e.target === stage) {
        tr.nodes([]);
        AppState.selectedOverlay = null;
        const sc = $('selectedControls');
        if (sc) sc.classList.add('hidden');
        overlayLayer.batchDraw();
        EventBus.emit('overlayDeselected');
      }
    });
    return { stage, overlayLayer };
  }

  function addText(config) {
    const textNode = new Konva.Text({
      x: stage.width() / 2, y: stage.height() / 2,
      text: config.text || 'Texto',
      fontSize: config.fontSize || 40,
      fontFamily: config.fontFamily || 'Space Grotesk',
      fill: config.fill || '#ffffff',
      stroke: config.strokeWidth > 0 ? config.stroke : null,
      strokeWidth: config.strokeWidth || 0,
      opacity: config.opacity != null ? config.opacity : 1,
      fontStyle: config.fontStyle || 'normal',
      textDecoration: config.textDecoration || '',
      draggable: true,
      id: 'overlay_' + Date.now(),
      name: 'overlay',
    });
    textNode.offsetX(textNode.width() / 2);
    textNode.offsetY(textNode.height() / 2);
    textNode.on('click tap', () => selectOverlay(textNode));
    textNode.on('dragstart', () => selectOverlay(textNode));
    textNode.on('dblclick dbltap', () => enableTextEdit(textNode));
    overlayLayer.add(textNode);
    overlayLayer.batchDraw();
    selectOverlay(textNode);
    AppState.overlays.push({ id: textNode.id(), type: 'text', node: textNode });
    updateLayers();
    addHistory('Agregar texto: ' + config.text);
    EventBus.emit('overlayAdded', { type: 'text' });
    return textNode;
  }

  function addShape(type, config = {}) {
    const base = {
      x: stage.width() / 2, y: stage.height() / 2,
      fill: config.fill || '#ff4757',
      stroke: config.stroke || '#ffffff',
      strokeWidth: config.strokeWidth || 2,
      opacity: config.opacity != null ? config.opacity : 1,
      blur: config.blur || 0,
      draggable: true,
      id: 'overlay_' + Date.now(),
      name: 'overlay',
    };
    let shape;
    if (type === 'rect')      shape = new Konva.Rect({ ...base, width:150, height:80, offsetX:75, offsetY:40, cornerRadius:6 });
    else if (type === 'roundrect') shape = new Konva.Rect({ ...base, width:160, height:90, offsetX:80, offsetY:45, cornerRadius:20 });
    else if (type === 'circle')   shape = new Konva.Circle({ ...base, radius:60 });
    else if (type === 'star')     shape = new Konva.Star({ ...base, numPoints:5, innerRadius:30, outerRadius:60 });
    else if (type === 'arrow')    shape = new Konva.Arrow({ ...base, points:[0,0,120,0], pointerLength:15, pointerWidth:12 });
    else if (type === 'line')     shape = new Konva.Line({ ...base, points:[0,0,120,0], strokeWidth:config.strokeWidth||4 });
    else if (type === 'triangle') shape = new Konva.RegularPolygon({ ...base, sides:3, radius:60 });
    else if (type === 'hexagon')  shape = new Konva.RegularPolygon({ ...base, sides:6, radius:60 });
    if (!shape) return null;

    shape.on('click tap', () => selectOverlay(shape));
    shape.on('dragstart', () => selectOverlay(shape));
    overlayLayer.add(shape);
    overlayLayer.batchDraw();
    selectOverlay(shape);
    AppState.overlays.push({ id: shape.id(), type, node: shape });
    updateLayers();
    addHistory('Agregar forma: ' + type);
    return shape;
  }

  function addSticker(emoji, size = 60) {
    const text = new Konva.Text({
      x: stage.width() / 2, y: stage.height() / 2,
      text: emoji, fontSize: size,
      draggable: true, id: 'overlay_' + Date.now(), name: 'overlay',
    });
    text.offsetX(text.width() / 2);
    text.offsetY(text.height() / 2);
    text.on('click tap', () => selectOverlay(text));
    text.on('dragstart', () => selectOverlay(text));
    overlayLayer.add(text);
    overlayLayer.batchDraw();
    selectOverlay(text);
    AppState.overlays.push({ id: text.id(), type: 'sticker', node: text });
    updateLayers();
    addHistory('Agregar sticker');
    return text;
  }

  function selectOverlay(node) {
    tr.nodes([node]);
    AppState.selectedOverlay = node;
    const sc = $('selectedControls');
    if (sc) sc.classList.remove('hidden');
    overlayLayer.batchDraw();
    EventBus.emit('overlaySelected', node);
  }

  function deleteSelected() {
    if (!AppState.selectedOverlay) return;
    const id = AppState.selectedOverlay.id();
    AppState.selectedOverlay.destroy();
    tr.nodes([]);
    AppState.selectedOverlay = null;
    AppState.overlays = AppState.overlays.filter(o => o.id !== id);
    AppState.keyframes = AppState.keyframes.filter(kf => kf.overlayId !== id);
    const sc = $('selectedControls');
    if (sc) sc.classList.add('hidden');
    overlayLayer.batchDraw();
    updateLayers();
    refreshKFList();
    addHistory('Eliminar overlay');
  }

  function duplicateSelected() {
    if (!AppState.selectedOverlay) return;
    const clone = AppState.selectedOverlay.clone({
      x: AppState.selectedOverlay.x() + 20,
      y: AppState.selectedOverlay.y() + 20,
      id: 'overlay_' + Date.now(),
    });
    clone.on('click tap', () => selectOverlay(clone));
    clone.on('dragstart', () => selectOverlay(clone));
    overlayLayer.add(clone);
    overlayLayer.batchDraw();
    selectOverlay(clone);
    AppState.overlays.push({ id: clone.id(), type: 'clone', node: clone });
    updateLayers();
    addHistory('Duplicar overlay');
  }

  function bringToFront() {
    if (!AppState.selectedOverlay) return;
    AppState.selectedOverlay.moveToTop();
    tr.moveToTop();
    overlayLayer.batchDraw();
    addHistory('Traer al frente');
  }

  function sendToBack() {
    if (!AppState.selectedOverlay) return;
    AppState.selectedOverlay.moveToBottom();
    overlayLayer.batchDraw();
    addHistory('Enviar atrás');
  }

  function enableTextEdit(textNode) {
    const absPos = textNode.getAbsolutePosition();
    const stageBox = stage.container().getBoundingClientRect();
    const ta = document.createElement('textarea');
    ta.value = textNode.text();
    ta.style.cssText = `
      position:fixed; top:${stageBox.top + absPos.y}px; left:${stageBox.left + absPos.x}px;
      font-size:${textNode.fontSize() * textNode.scaleX()}px;
      font-family:${textNode.fontFamily()}; color:${textNode.fill()};
      background:rgba(0,0,0,0.8); border:1px solid #f59e0b;
      border-radius:4px; padding:4px; outline:none;
      min-width:120px; z-index:9999; resize:none;
    `;
    document.body.appendChild(ta);
    textNode.hide();
    overlayLayer.batchDraw();
    ta.focus();
    const finish = () => {
      textNode.text(ta.value);
      textNode.show();
      overlayLayer.batchDraw();
      ta.remove();
      addHistory('Editar texto');
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) finish();
    });
    ta.addEventListener('blur', finish);
  }

  function getStage()  { return stage; }
  function getLayer()  { return overlayLayer; }

  function resizeKonva(w, h) {
    if (!stage) return;
    stage.width(w); stage.height(h);
    overlayLayer.batchDraw();
  }

  function exportAsDataURL() {
    return stage ? stage.toDataURL({ pixelRatio: 2 }) : null;
  }

  // Aplica keyframes en tiempo t
  function applyKeyframesAtTime(t) {
    if (!stage || AppState.keyframes.length === 0) return;
    AppState.overlays.forEach(ov => {
      const node = ov.node;
      if (!node) return;
      const props = ['x','y','scale','opacity','rotation'];
      props.forEach(prop => {
        const kfs = AppState.keyframes
          .filter(kf => kf.overlayId === ov.id && kf.prop === prop)
          .sort((a,b) => a.time - b.time);
        if (kfs.length === 0) return;

        let val = null;
        if (t <= kfs[0].time) {
          val = kfs[0].value;
        } else if (t >= kfs[kfs.length-1].time) {
          val = kfs[kfs.length-1].value;
        } else {
          for (let i = 0; i < kfs.length - 1; i++) {
            if (t >= kfs[i].time && t < kfs[i+1].time) {
              const prog = (t - kfs[i].time) / (kfs[i+1].time - kfs[i].time);
              val = interpolate(kfs[i].value, kfs[i+1].value, prog, kfs[i].interp || 'linear');
              break;
            }
          }
        }

        if (val !== null) {
          if (prop === 'scale') { node.scaleX(val); node.scaleY(val); }
          else node[prop](val);
        }
      });
    });
    overlayLayer.batchDraw();
  }

  function interpolate(a, b, t, mode) {
    let et = t;
    if (mode === 'ease')    et = t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
    if (mode === 'easeIn')  et = t * t * t;
    if (mode === 'easeOut') et = 1 - Math.pow(1-t, 3);
    if (mode === 'bounce') {
      const n1 = 7.5625, d1 = 2.75;
      if (t < 1/d1)      et = n1*t*t;
      else if (t < 2/d1) et = n1*(t-=1.5/d1)*t+0.75;
      else if (t < 2.5/d1) et = n1*(t-=2.25/d1)*t+0.9375;
      else               et = n1*(t-=2.625/d1)*t+0.984375;
    }
    return a + (b - a) * et;
  }

  return {
    init, addText, addShape, addSticker, deleteSelected, duplicateSelected,
    bringToFront, sendToBack, getStage, getLayer, resizeKonva,
    exportAsDataURL, applyKeyframesAtTime,
  };
})();

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 6: MOTOR DE AUDIO (Web Audio API)
════════════════════════════════════════════════════════════════ */
const AudioEngine = (() => {
  let ctx = null;
  let sourceNode = null;
  let gainNode = null;
  let pannerNode = null;
  let reverbNode = null;
  let compressorNode = null;
  let eqNodes = {};
  let musicSource = null;
  let musicGain = null;
  let analyser = null;

  function init() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    gainNode       = ctx.createGain();
    pannerNode     = ctx.createStereoPanner();
    compressorNode = ctx.createDynamicsCompressor();
    analyser       = ctx.createAnalyser();
    analyser.fftSize = 512;

    // Reverb (ConvolverNode simulado con delay)
    reverbNode = ctx.createDelay(0.5);
    reverbNode.delayTime.value = 0;

    // EQ de 7 bandas
    const bands = [
      { freq:60,    type:'lowshelf' },
      { freq:150,   type:'peaking'  },
      { freq:400,   type:'peaking'  },
      { freq:1000,  type:'peaking'  },
      { freq:2400,  type:'peaking'  },
      { freq:6000,  type:'peaking'  },
      { freq:16000, type:'highshelf'},
    ];
    let prev = gainNode;
    bands.forEach(({ freq, type }) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.gain.value = 0;
      eqNodes[freq] = f;
      prev.connect(f);
      prev = f;
    });
    prev.connect(pannerNode);
    pannerNode.connect(compressorNode);
    compressorNode.connect(analyser);
    analyser.connect(ctx.destination);
    markModule('mod-audio', true);
  }

  function connectVideo(videoEl) {
    if (!ctx) init();
    try {
      if (sourceNode) sourceNode.disconnect();
      sourceNode = ctx.createMediaElementSource(videoEl);
      sourceNode.connect(gainNode);
    } catch(e) { console.warn('Audio connect:', e); }
  }

  function setMasterVolume(val) {
    if (!gainNode) return;
    gainNode.gain.setTargetAtTime(val / 100, ctx.currentTime, 0.01);
  }

  function setPan(val) {
    if (!pannerNode) return;
    pannerNode.pan.setTargetAtTime(val / 100, ctx.currentTime, 0.01);
  }

  function setEqBand(freq, gain) {
    const node = eqNodes[freq];
    if (node) node.gain.setTargetAtTime(gain, ctx.currentTime, 0.01);
  }

  function setReverb(val) {
    if (!reverbNode) return;
    reverbNode.delayTime.setTargetAtTime(val / 100 * 0.4, ctx.currentTime, 0.01);
  }

  function setCompress(val) {
    if (!compressorNode) return;
    compressorNode.threshold.setTargetAtTime(-60 + val * 0.54, ctx.currentTime, 0.01);
    compressorNode.ratio.setTargetAtTime(1 + val * 0.19, ctx.currentTime, 0.01);
  }

  function getAnalyser() { return analyser; }

  function connectMusic(audioEl) {
    if (!ctx) init();
    if (musicSource) try { musicSource.disconnect(); } catch(e) {}
    musicGain = ctx.createGain();
    musicSource = ctx.createMediaElementSource(audioEl);
    musicSource.connect(musicGain);
    musicGain.connect(ctx.destination);
    setMusicVolume(AppState.musicVolume);
  }

  function setMusicVolume(val) {
    if (musicGain) musicGain.gain.setTargetAtTime(val / 100, ctx.currentTime, 0.01);
  }

  function resume() {
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  return { init, connectVideo, setMasterVolume, setPan, setEqBand, setReverb, setCompress, getAnalyser, connectMusic, setMusicVolume, resume };
})();

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 7: FILTROS CSS + VIÑETA + GRANO
════════════════════════════════════════════════════════════════ */
const FilterEngine = (() => {
  const filterPresets = {
    none:        {},
    vivid:       { saturation:60, contrast:10, brightness:5 },
    cinematic:   { contrast:20, saturation:-30, brightness:-5, temperature:-20 },
    teal_orange: { saturation:10, temperature:-10, contrast:15 },
    vintage:     { saturation:-50, contrast:10, brightness:5, temperature:30, hue:10 },
    bw:          { saturation:-100 },
    summer:      { saturation:40, brightness:6, temperature:30 },
    cool:        { saturation:10, temperature:-30 },
    drama:       { contrast:40, saturation:-40, brightness:-10, vignette:60 },
    haze:        { brightness:10, saturation:-20, blur:1 },
    cyberpunk:   { saturation:80, contrast:20, hue:270 },
    golden:      { saturation:30, brightness:4, temperature:40 },
  };

  function applyToVideo(video, filters) {
    const f = filters;
    const brightness = (100 + f.brightness + f.exposure * 0.5) / 100;
    const contrast   = (100 + f.contrast) / 100;
    const saturation = (100 + f.saturation) / 100;
    const hue        = f.hue;
    const blur       = f.blur;

    let css = `brightness(${Math.max(0, brightness).toFixed(3)}) contrast(${contrast.toFixed(3)}) saturate(${Math.max(0, saturation).toFixed(3)})`;
    if (hue !== 0)  css += ` hue-rotate(${hue}deg)`;
    if (blur > 0)   css += ` blur(${(blur * 0.5).toFixed(1)}px)`;
    if (f.temperature > 0) css += ` sepia(${(f.temperature * 0.003).toFixed(3)})`;

    // Highlights & Shadows (simulados con brightness por capas)
    if (f.highlights !== 0 || f.shadows !== 0) {
      const hl = 1 + f.highlights * 0.003;
      const sh = 1 + f.shadows    * 0.003;
      css += ` brightness(${((hl + sh) / 2).toFixed(3)})`;
    }

    video.style.filter = css;

    // Viñeta
    const vigOp = f.vignette / 100;
    DOM.vignetteOverlay.style.boxShadow = vigOp > 0
      ? `inset 0 0 ${vigOp * 140}px ${vigOp * 70}px rgba(0,0,0,${(vigOp * 0.85).toFixed(2)})`
      : 'none';

    // Film grain en canvas
    applyGrain(f.filmGrain);
  }

  let grainAnim = null;
  function applyGrain(amount) {
    const canvas = DOM.grainCanvas;
    if (!canvas) return;
    if (amount <= 0) {
      canvas.style.opacity = '0';
      if (grainAnim) { cancelAnimationFrame(grainAnim); grainAnim = null; }
      return;
    }
    canvas.style.opacity = (amount / 100 * 0.5).toFixed(2);
    if (grainAnim) return; // ya corriendo

    const ctx = canvas.getContext('2d');
    function drawGrain() {
      grainAnim = requestAnimationFrame(drawGrain);
      const w = canvas.width || 640;
      const h = canvas.height || 360;
      if (!w || !h) return;
      const imageData = ctx.createImageData(w, h);
      const buf = imageData.data;
      for (let i = 0; i < buf.length; i += 4) {
        const v = (Math.random() * 2 - 1) * 255;
        buf[i] = buf[i+1] = buf[i+2] = 128 + v;
        buf[i+3] = 255;
      }
      ctx.putImageData(imageData, 0, 0);
    }
    drawGrain();
  }

  function loadPreset(name) {
    const p = filterPresets[name] || {};
    Object.keys(AppState.filters).forEach(k => {
      if (k !== 'preset') AppState.filters[k] = p[k] !== undefined ? p[k] : 0;
    });
    AppState.filters.preset = name;
    syncSliderUI();
    applyToVideo(DOM.video, AppState.filters);
  }

  function resetFilters() {
    Object.keys(AppState.filters).forEach(k => { AppState.filters[k] = k === 'preset' ? 'none' : 0; });
    syncSliderUI();
    applyToVideo(DOM.video, AppState.filters);
    addHistory('Restablecer colores');
    showToast('Colores restablecidos', 'info');
  }

  function syncSliderUI() {
    const f = AppState.filters;
    const set = (id, val, dispId, sfx='') => {
      const el = $(id); const d = $(dispId);
      if (el) el.value = val;
      if (d) d.textContent = val + sfx;
    };
    set('brightness','brightnessVal', f.brightness);
    set('contrast',  'contrastVal',   f.contrast);
    set('saturation','saturationVal', f.saturation);
    set('hue',       'hueVal',        f.hue,        '°');
    set('temperature','temperatureVal',f.temperature);
    set('exposure',  'exposureVal',   f.exposure);
    set('highlights','highlightsVal', f.highlights);
    set('shadows',   'shadowsVal',    f.shadows);
    set('vignette',  'vignetteVal',   f.vignette,   '%');
    set('blurAmount','blurVal',       f.blur,       'px');
    set('filmGrain', 'filmGrainVal',  f.filmGrain,  '%');
  }
  // Fix the set call args order
  function _set(id, val, dispId, sfx = '') {
    const el = $(id); const d = $(dispId);
    if (el) el.value = val;
    if (d) d.textContent = val + sfx;
  }

  return { applyToVideo, loadPreset, resetFilters, syncSliderUI };
})();

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 8: TIMELINE ENGINE (profesional)
════════════════════════════════════════════════════════════════ */
const TimelineEngine = (() => {
  const PX_PER_SEC_BASE = 80;
  let isDraggingPlayhead = false;

  function getPPS() { return PX_PER_SEC_BASE * AppState.timelineZoom; }

  function buildRuler() {
    const ruler = DOM.tlRuler;
    if (!ruler) return;
    ruler.innerHTML = '';
    const duration = Math.max(AppState.videoDuration, 60);
    const pps = getPPS();
    ruler.style.width = (duration * pps + 300) + 'px';

    const interval = pps >= 200 ? 0.5 : pps >= 100 ? 1 : pps >= 40 ? 2 : pps >= 20 ? 5 : 10;
    for (let t = 0; t <= duration + interval; t += interval / 5) {
      const isMajor = (Math.round(t / (interval / 5)) % 5) === 0;
      const tick = document.createElement('div');
      tick.className = 'ruler-tick' + (isMajor ? ' major' : ' minor');
      tick.style.left = (t * pps) + 'px';
      ruler.appendChild(tick);
      if (isMajor) {
        const label = document.createElement('div');
        label.className = 'ruler-label';
        label.textContent = formatTimeShort(t);
        label.style.left = (t * pps) + 'px';
        ruler.appendChild(label);
      }
    }
  }

  function addClip(clip) {
    const trackMap = {
      video:'V1', v1:'V1', v2:'V2', v3:'V3',
      audio:'A1', a1:'A1', a2:'A2',
      text:'Text', music:'A2',
    };
    const trackSuffix = trackMap[clip.type] || 'V1';
    const trackEl = $('clipTrack' + trackSuffix);
    if (!trackEl) return;

    const pps = getPPS();
    const el = document.createElement('div');
    el.className = 'tl-clip tl-' + (clip.type === 'video' ? 'v1' : clip.type);
    el.id = 'tlclip_' + clip.id;
    el.style.left    = (clip.start * pps) + 'px';
    el.style.width   = (clip.duration * pps) + 'px';
    el.textContent   = clip.name;
    el.title         = clip.name;

    // Thumbnails visuales dentro del clip
    if (clip.type === 'video' && DOM.video.src) {
      const thumbRow = document.createElement('div');
      thumbRow.className = 'clip-thumbnail';
      const cols = Math.min(8, Math.floor(clip.duration * pps / 28));
      for (let i = 0; i < cols; i++) thumbRow.innerHTML += '🎞';
      el.appendChild(thumbRow);
    }

    const lh = document.createElement('div'); lh.className = 'clip-handle left';
    const rh = document.createElement('div'); rh.className = 'clip-handle right';
    el.appendChild(lh); el.appendChild(rh);

    makeDraggable(el, clip);
    makeResizable(el, clip, lh, 'left');
    makeResizable(el, clip, rh, 'right');

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      $$('.tl-clip.selected').forEach(c => c.classList.remove('selected'));
      el.classList.add('selected');
      EventBus.emit('clipSelected', clip);
    });

    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, clip, el);
    });

    trackEl.appendChild(el);
  }

  function showContextMenu(x, y, clip, el) {
    const menu = $('contextMenu');
    if (!menu) return;
    menu.style.left    = x + 'px';
    menu.style.top     = y + 'px';
    menu.classList.remove('hidden');

    const onAction = (action) => {
      menu.classList.add('hidden');
      if (action === 'delete') {
        el.remove();
        AppState.clips = AppState.clips.filter(c => c.id !== clip.id);
        addHistory('Eliminar clip');
        showToast('Clip eliminado', 'info');
      } else if (action === 'split') {
        splitClipAt(clip, el);
      } else if (action === 'cut') {
        AppState._clipboard = clip;
        showToast('Clip copiado al portapapeles', 'info');
      }
    };

    $$('.ctx-item').forEach(item => {
      const newItem = item.cloneNode(true);
      newItem.addEventListener('click', () => onAction(item.dataset.action));
      item.parentNode.replaceChild(newItem, item);
    });

    document.addEventListener('click', () => menu.classList.add('hidden'), { once: true });
  }

  function splitClipAt(clip, el) {
    const t = AppState.currentTime;
    if (t <= clip.start || t >= clip.start + clip.duration) {
      showToast('El cursor está fuera del clip', 'warning');
      return;
    }
    const dur1 = t - clip.start;
    const dur2 = clip.duration - dur1;
    clip.duration = dur1;
    el.style.width = (dur1 * getPPS()) + 'px';

    const clip2 = { ...clip, id: 'clip_' + Date.now(), start: t, duration: dur2 };
    AppState.clips.push(clip2);
    addClip(clip2);
    addHistory('Dividir clip');
    showToast('Clip dividido en ' + formatTime(t), 'success');
  }

  function makeDraggable(el, clip) {
    let startX, startLeft;
    el.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('clip-handle')) return;
      e.preventDefault();
      startX    = e.clientX;
      startLeft = parseInt(el.style.left) || 0;

      const onMove = (e2) => {
        const pps = getPPS();
        let newLeft = Math.max(0, startLeft + (e2.clientX - startX));

        // Snap magnético
        if (AppState.snapEnabled) {
          const snapT = snapToGrid(newLeft / pps, pps);
          newLeft = snapT * pps;
        }

        el.style.left   = newLeft + 'px';
        clip.start      = newLeft / getPPS();
        updatePlayhead(AppState.currentTime);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        addHistory('Mover clip');
        EventBus.emit('timelineChanged');
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function snapToGrid(time, pps) {
    // Snap a marcadores de tiempo (1s, 0.5s, etc.)
    const interval = pps >= 100 ? 0.5 : 1;
    let snapped = Math.round(time / interval) * interval;

    // Snap a otros clips
    if (AppState.snapToClips) {
      AppState.clips.forEach(c => {
        [c.start, c.start + c.duration].forEach(edge => {
          if (Math.abs(time - edge) < 0.15) snapped = edge;
        });
      });
    }
    return snapped;
  }

  function makeResizable(el, clip, handle, side) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const startX = e.clientX;
      const startW = parseInt(el.style.width);
      const startL = parseInt(el.style.left);

      const onMove = (e2) => {
        const dx = e2.clientX - startX;
        if (side === 'right') {
          const newW = Math.max(20, startW + dx);
          el.style.width   = newW + 'px';
          clip.duration    = newW / getPPS();
        } else {
          const newW = Math.max(20, startW - dx);
          const newL = Math.max(0, startL + dx);
          el.style.width  = newW + 'px';
          el.style.left   = newL + 'px';
          clip.start      = newL / getPPS();
          clip.duration   = newW / getPPS();
        }
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        addHistory('Redimensionar clip');
        EventBus.emit('timelineChanged');
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function updatePlayhead(time) {
    if (!DOM.playhead) return;
    DOM.playhead.style.left = (time * getPPS()) + 'px';

    // Auto-scroll del timeline para seguir al playhead
    const container = DOM.tracksContainer;
    if (!container) return;
    const phX = time * getPPS();
    const scrollLeft = container.scrollLeft;
    const width = container.clientWidth;
    if (phX > scrollLeft + width - 80) {
      container.scrollLeft = phX - width * 0.3;
    }
  }

  function initPlayheadDrag() {
    DOM.tlRuler.addEventListener('mousedown', (e) => {
      isDraggingPlayhead = true;
      seekFromRuler(e);
    });
    document.addEventListener('mousemove', (e) => {
      if (!isDraggingPlayhead) return;
      seekFromRuler(e);
    });
    document.addEventListener('mouseup', () => { isDraggingPlayhead = false; });
  }

  function seekFromRuler(e) {
    const rect = DOM.tlRuler.getBoundingClientRect();
    const x = Math.max(0, e.clientX - rect.left);
    const t = Math.min(AppState.videoDuration || 999, x / getPPS());
    AppState.currentTime = t;
    if (DOM.video.src) DOM.video.currentTime = t;
    updatePlayhead(t);
    DOM.currentTime.textContent = formatTime(t);
    KonvaEngine.applyKeyframesAtTime(t);
  }

  function refreshClips() {
    $$('.tl-clip').forEach(el => el.remove());
    AppState.clips.forEach(c => addClip(c));
  }

  function fitTimeline() {
    if (!AppState.videoDuration) return;
    const container = DOM.tracksContainer;
    const targetZoom = (container.clientWidth * 0.9) / (AppState.videoDuration * PX_PER_SEC_BASE);
    AppState.timelineZoom = Math.max(0.5, Math.min(20, targetZoom));
    const zoomSlider = $('timelineZoom');
    if (zoomSlider) zoomSlider.value = AppState.timelineZoom;
    $('timelineZoomVal').textContent = AppState.timelineZoom.toFixed(1) + 'x';
    buildRuler();
    refreshClips();
  }

  return { buildRuler, addClip, updatePlayhead, initPlayheadDrag, getPPS, refreshClips, fitTimeline, splitClipAt };
})();

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 9: KEYFRAME ENGINE
════════════════════════════════════════════════════════════════ */
function addKeyframe(prop) {
  const node = AppState.selectedOverlay;
  if (!node) { showToast('Selecciona un overlay primero', 'warning'); return; }

  const t = AppState.currentTime;
  let value;
  if (prop === 'x')        value = node.x();
  else if (prop === 'y')   value = node.y();
  else if (prop === 'scale')    value = node.scaleX();
  else if (prop === 'opacity')  value = node.opacity();
  else if (prop === 'rotation') value = node.rotation();
  else return;

  const existing = AppState.keyframes.findIndex(kf =>
    kf.overlayId === node.id() && kf.prop === prop && Math.abs(kf.time - t) < 0.01
  );
  if (existing >= 0) {
    AppState.keyframes[existing].value = value;
    showToast(`KF actualizado — ${prop}`, 'info');
  } else {
    AppState.keyframes.push({
      id: 'kf_' + Date.now(),
      overlayId: node.id(),
      prop, time: t, value,
      interp: AppState.kfInterpolation,
    });
    showToast(`Keyframe añadido — ${prop} @ ${formatTime(t)}`, 'success');
  }

  addHistory(`KF: ${prop} @ ${formatTime(t)}`);
  refreshKFList();
  renderKFDiamonds();
}

function refreshKFList() {
  const list = DOM.kfList;
  if (!list) return;
  list.innerHTML = '';
  if (AppState.keyframes.length === 0) {
    list.innerHTML = '<div class="layer-empty">Sin keyframes</div>';
    return;
  }
  AppState.keyframes.forEach(kf => {
    const div = document.createElement('div');
    div.className = 'kf-entry';
    div.innerHTML = `<div class="kf-entry-dot"></div>
      <span style="flex:1">${kf.prop}</span>
      <span style="font-family:var(--font-mono);font-size:9px;color:var(--accent-cyan)">${formatTime(kf.time)}</span>
      <span style="color:var(--accent-amber);margin-left:6px">${typeof kf.value === 'number' ? kf.value.toFixed(2) : kf.value}</span>`;
    div.addEventListener('click', () => {
      if (DOM.video.src) DOM.video.currentTime = kf.time;
    });
    list.appendChild(div);
  });
}

function renderKFDiamonds() {
  const track = DOM.kfTrack;
  if (!track) return;
  track.innerHTML = '';
  const pps = TimelineEngine.getPPS();
  AppState.keyframes.forEach(kf => {
    const diamond = document.createElement('div');
    diamond.className = 'kf-diamond';
    diamond.style.left = (kf.time * pps) + 'px';
    diamond.title = `${kf.prop} @ ${formatTime(kf.time)}: ${typeof kf.value === 'number' ? kf.value.toFixed(2) : kf.value}`;
    diamond.addEventListener('click', () => {
      if (DOM.video.src) DOM.video.currentTime = kf.time;
    });
    track.appendChild(diamond);
  });
}

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 10: TRANSICIONES ENGINE
════════════════════════════════════════════════════════════════ */
function previewTransition(type, duration) {
  const canvas = $('transPreviewCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  let frame = 0;
  const totalFrames = 40;

  const prev = () => {
    ctx.clearRect(0, 0, w, h);
    const t = frame / totalFrames;

    if (type === 'cut') {
      ctx.fillStyle = frame < totalFrames / 2 ? '#2244aa' : '#aa4422';
      ctx.fillRect(0, 0, w, h);
    } else if (type === 'crossdissolve') {
      ctx.fillStyle = '#2244aa'; ctx.globalAlpha = 1 - t;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#aa4422'; ctx.globalAlpha = t;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    } else if (type === 'fade') {
      const fade = t < 0.5 ? 1 - t * 2 : (t - 0.5) * 2;
      ctx.fillStyle = '#2244aa'; ctx.globalAlpha = fade < 0.5 ? 1 : 0;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#000'; ctx.globalAlpha = t < 0.5 ? t * 2 : 1 - (t - 0.5) * 2;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#aa4422'; ctx.globalAlpha = t > 0.5 ? (t - 0.5) * 2 : 0;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    } else if (type === 'zoom') {
      const scale = 1 + t * 1.5;
      ctx.save(); ctx.translate(w/2, h/2); ctx.scale(scale, scale);
      ctx.fillStyle = t < 0.5 ? '#2244aa' : '#aa4422';
      ctx.fillRect(-w/2, -h/2, w, h);
      ctx.restore();
      ctx.globalAlpha = t < 0.5 ? t * 2 : 1;
    } else if (type === 'wipe') {
      ctx.fillStyle = '#2244aa'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#aa4422'; ctx.fillRect(0, 0, w * t, h);
    } else if (type === 'glitch') {
      ctx.fillStyle = t < 0.5 ? '#2244aa' : '#aa4422'; ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 6; i++) {
        const gy = Math.random() * h;
        const gh = Math.random() * 20 + 5;
        const gx = (Math.random() - 0.5) * 40;
        ctx.drawImage(canvas, gx, gy, w, gh, 0, gy, w, gh);
      }
    } else if (type === 'rgbsplit') {
      ctx.fillStyle = t < 0.5 ? '#2244aa' : '#aa4422'; ctx.fillRect(0, 0, w, h);
      const split = t * 20;
      ctx.fillStyle = 'rgba(255,0,0,0.5)';   ctx.fillRect(split, 0, w, h);
      ctx.fillStyle = 'rgba(0,255,0,0.5)';   ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(0,0,255,0.5)';   ctx.fillRect(-split, 0, w, h);
    } else if (type === 'motionblur') {
      for (let i = 0; i < 5; i++) {
        ctx.globalAlpha = 0.2;
        ctx.fillStyle = t < 0.5 ? '#2244aa' : '#aa4422';
        ctx.fillRect(i * t * 8, 0, w, h);
      }
      ctx.globalAlpha = 1;
    } else {
      // Fallback
      ctx.fillStyle = '#333'; ctx.fillRect(0, 0, w, h);
    }

    // Borde de tiempo
    ctx.fillStyle = 'rgba(245,158,11,0.8)';
    ctx.fillRect(0, h - 4, w * t, 4);

    frame++;
    if (frame <= totalFrames) requestAnimationFrame(prev);
    else {
      setTimeout(() => {
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#141720'; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.font = '11px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`Preview: ${type}`, w/2, h/2);
      }, 400);
    }
  };
  requestAnimationFrame(prev);
}

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 11: HISTOGRAMA + VECTORSCOPE
════════════════════════════════════════════════════════════════ */
const ScopeEngine = (() => {
  let animId = null;
  const offscreen = document.createElement('canvas');
  offscreen.width = 64; offscreen.height = 36;

  function start(videoEl) {
    if (animId) cancelAnimationFrame(animId);
    const offCtx = offscreen.getContext('2d');

    function draw() {
      animId = requestAnimationFrame(draw);
      if (!videoEl.src || (videoEl.paused && videoEl.readyState < 3)) return;
      try {
        offCtx.drawImage(videoEl, 0, 0, 64, 36);
        const pixels = offCtx.getImageData(0, 0, 64, 36).data;
        renderHistogram(pixels);
        renderVectorscope(pixels);
      } catch(e) {}
    }
    draw();
  }

  function renderHistogram(pixels) {
    const canvas = DOM.histogramCanvas;
    if (!canvas) return;
    const c = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    c.clearRect(0, 0, w, h);
    c.fillStyle = '#0c0e18'; c.fillRect(0, 0, w, h);

    const bins = 64;
    const rH = new Uint32Array(bins), gH = new Uint32Array(bins), bH = new Uint32Array(bins);
    for (let i = 0; i < pixels.length; i += 4) {
      rH[Math.floor(pixels[i]   / 256 * bins)]++;
      gH[Math.floor(pixels[i+1] / 256 * bins)]++;
      bH[Math.floor(pixels[i+2] / 256 * bins)]++;
    }
    const max = Math.max(...rH, ...gH, ...bH, 1);
    const bw = w / bins;

    [{ h: rH, c: 'rgba(239,68,68,0.65)' }, { h: gH, c: 'rgba(34,197,94,0.65)' }, { h: bH, c: 'rgba(34,211,238,0.65)' }]
    .forEach(({ h, c: color }) => {
      c.beginPath(); c.moveTo(0, h.length ? w : 0);
      h.forEach((v, i) => {
        const x = i * bw;
        const barH = (v / max) * (h - 4);
        c.lineTo(x, h - barH);
      });
      c.lineTo(w, h); c.closePath(); c.fillStyle = color; c.fill();
    });

    c.strokeStyle = 'rgba(255,255,255,0.06)'; c.lineWidth = 1;
    [0.25, 0.5, 0.75].forEach(f => {
      c.beginPath(); c.moveTo(f * w, 0); c.lineTo(f * w, h); c.stroke();
    });
  }

  function renderVectorscope(pixels) {
    const canvas = DOM.vectorscopeCanvas;
    if (!canvas) return;
    const c = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    c.clearRect(0, 0, w, h);
    c.fillStyle = '#0c0e18'; c.fillRect(0, 0, w, h);

    // Círculo guía
    c.strokeStyle = 'rgba(255,255,255,0.08)';
    c.lineWidth = 1;
    c.beginPath(); c.arc(w/2, h/2, Math.min(w,h)/2 - 4, 0, Math.PI*2); c.stroke();

    // Plotear Cb vs Cr
    for (let i = 0; i < pixels.length; i += 16) {
      const r = pixels[i], g = pixels[i+1], b = pixels[i+2];
      const cb = (b - 128) / 128;
      const cr = (r - 128) / 128;
      const x = w/2 + cr * (w/2 - 6);
      const y = h/2 - cb * (h/2 - 6);
      const lum = 0.299*r + 0.587*g + 0.114*b;
      c.fillStyle = `rgba(${r},${g},${b},0.4)`;
      c.fillRect(x, y, 2, 2);
    }
  }

  return { start };
})();

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 12: FPS MONITOR
════════════════════════════════════════════════════════════════ */
const FPSMonitor = (() => {
  let frames = 0, lastTime = performance.now();
  function start() {
    function tick() {
      requestAnimationFrame(tick);
      frames++;
      const now = performance.now();
      if (now - lastTime >= 1000) {
        const fps = Math.round(frames * 1000 / (now - lastTime));
        if (DOM.fpsBadge) {
          DOM.fpsBadge.textContent = fps + ' FPS';
          DOM.fpsBadge.style.color = fps >= 55 ? '#22c55e' : fps >= 30 ? '#f59e0b' : '#ef4444';
        }
        frames = 0; lastTime = now;
      }
    }
    requestAnimationFrame(tick);
  }
  return { start };
})();

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 13: SISTEMA DE PROYECTOS
════════════════════════════════════════════════════════════════ */
const ProjectManager = (() => {
  function save() {
    const project = {
      version: '2.0',
      name: AppState.projectName,
      savedAt: new Date().toISOString(),
      filters: { ...AppState.filters },
      audio: { ...AppState.audio },
      clips: AppState.clips.map(c => ({ ...c })),
      keyframes: [...AppState.keyframes],
      activeTransition: AppState.activeTransition,
      transitionDuration: AppState.transitionDuration,
      timelineZoom: AppState.timelineZoom,
      overlays: AppState.overlays.map(o => ({
        id: o.id, type: o.type,
        attrs: o.node ? o.node.getAttrs() : {},
      })),
    };
    const json = JSON.stringify(project, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (AppState.projectName || 'proyecto').replace(/\s+/g,'_') + '.vfproj';
    a.click();
    URL.revokeObjectURL(url);
    showToast('Proyecto guardado', 'success');
    addHistory('Guardar proyecto');
  }

  function autoSave() {
    try {
      const mini = {
        name: AppState.projectName,
        filters: AppState.filters,
        clips: AppState.clips.length,
        keyframes: AppState.keyframes.length,
        savedAt: Date.now(),
      };
      localStorage.setItem('vidforge_autosave', JSON.stringify(mini));
      const ind = $('saveIndicator');
      if (ind) { ind.style.color = '#22c55e'; setTimeout(() => { ind.style.color = ''; }, 1500); }
    } catch(e) {}
  }

  function startAutoSave() {
    if (AppState.autoSaveInterval) clearInterval(AppState.autoSaveInterval);
    AppState.autoSaveInterval = setInterval(autoSave, 30000);
  }

  return { save, autoSave, startAutoSave };
})();

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 14: IA — Gemini API (real) + procesamiento local
════════════════════════════════════════════════════════════════ */

// ── Configuración Gemini ──────────────────────────────────────
const GEMINI_API_KEY = 'AIzaSyB8T_fsnRQihHZpsHXl6mrV79qxGPnUpa4';
const GEMINI_MODEL   = 'gemini-2.5-flash';

/**
 * Helper genérico para llamar a Gemini generateContent.
 * Devuelve el objeto JSON parseado de la respuesta del modelo.
 */
async function geminiGenerate(prompt, extraParts = []) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{
      parts: [{ text: prompt }, ...extraParts],
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  try {
    return JSON.parse(text);
  } catch {
    // Si el modelo devolvió texto con backticks, limpiar y reintentar
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  }
}

// ── Funciones con Gemini ──────────────────────────────────────

async function runGeminiSubtitles() {
  setAIProgress(true, 'Preparando análisis de audio con Gemini…', 10);

  if (!AppState.videoFile) {
    throw new Error('No hay video cargado.');
  }

  // Convertir el archivo a base64 para enviarlo a Gemini
  const base64 = await fileToBase64(AppState.videoFile);
  const mimeType = AppState.videoFile.type || 'video/mp4';

  setAIProgress(true, 'Enviando video a Gemini para transcripción…', 30);

  const prompt = `Analiza el audio de este video y genera una transcripción en segmentos.
Devuelve ÚNICAMENTE un objeto JSON con esta estructura exacta:
{
  "segments": [
    { "start": 0.0, "end": 3.5, "text": "Texto del segmento" },
    ...
  ],
  "language": "es"
}
Si no hay habla detectable, devuelve { "segments": [], "language": "unknown" }.`;

  const result = await geminiGenerate(prompt, [{
    inline_data: { mime_type: mimeType, data: base64 },
  }]);

  setAIProgress(true, 'Procesando segmentos de subtítulos…', 80);

  const segments = result.segments || [];
  if (segments.length === 0) {
    showToast('No se detectó habla en el video', 'warning');
  } else {
    // Agregar cada segmento como clip de texto en el timeline
    segments.forEach((seg, i) => {
      const clip = {
        id: 'subtitle_' + Date.now() + '_' + i,
        name: `💬 ${seg.text.slice(0, 30)}${seg.text.length > 30 ? '…' : ''}`,
        start: seg.start,
        duration: Math.max(0.5, seg.end - seg.start),
        type: 'text',
        subtitleText: seg.text,
      };
      AppState.clips.push(clip);
      TimelineEngine.addClip(clip);
    });
    showToast(`${segments.length} subtítulos agregados al timeline`, 'success');
  }
  addHistory('IA Gemini: subtítulos');
}

async function runGeminiHighlights() {
  setAIProgress(true, 'Analizando contenido del video con Gemini…', 15);

  if (!AppState.videoFile) throw new Error('No hay video cargado.');

  const base64   = await fileToBase64(AppState.videoFile);
  const mimeType = AppState.videoFile.type || 'video/mp4';
  const dur      = AppState.videoDuration || 10;

  setAIProgress(true, 'Gemini detectando momentos clave…', 40);

  const prompt = `Analiza este video e identifica los segmentos más interesantes o relevantes (highlights).
Devuelve ÚNICAMENTE un objeto JSON con esta estructura:
{
  "highlights": [
    { "start": 0.0, "end": 5.0, "score": 0.9, "reason": "Descripción breve" },
    ...
  ]
}
Máximo 5 highlights. Si el video es muy corto o no hay momentos destacables, devuelve { "highlights": [] }.`;

  const result = await geminiGenerate(prompt, [{
    inline_data: { mime_type: mimeType, data: base64 },
  }]);

  setAIProgress(true, 'Marcando highlights en el timeline…', 85);

  const highlights = result.highlights || [];
  if (highlights.length === 0) {
    showToast('No se detectaron highlights en el video', 'warning');
  } else {
    highlights.forEach((hl, i) => {
      const clip = {
        id: 'hl_' + Date.now() + '_' + i,
        name: `⭐ ${hl.reason?.slice(0, 25) || 'Highlight ' + (i+1)}`,
        start: Math.min(hl.start, dur),
        duration: Math.min(hl.end - hl.start, dur - hl.start),
        type: 'v2',
      };
      AppState.clips.push(clip);
      TimelineEngine.addClip(clip);
    });
    showToast(`${highlights.length} highlights marcados`, 'success');
  }
  addHistory('IA Gemini: highlights');
}

async function runGeminiReframe() {
  setAIProgress(true, 'Gemini analizando composición visual…', 20);

  if (!AppState.videoFile) throw new Error('No hay video cargado.');

  const base64   = await fileToBase64(AppState.videoFile);
  const mimeType = AppState.videoFile.type || 'video/mp4';

  setAIProgress(true, 'Detectando sujeto principal…', 50);

  const prompt = `Analiza la composición visual de este video para aplicar auto-reframe a formato 9:16 (vertical).
Devuelve ÚNICAMENTE un objeto JSON con esta estructura:
{
  "subject_position": "center|left|right",
  "crop_x_percent": 25,
  "crop_width_percent": 50,
  "recommended_ratio": "9:16",
  "notes": "Descripción breve de la recomendación"
}`;

  const result = await geminiGenerate(prompt, [{
    inline_data: { mime_type: mimeType, data: base64 },
  }]);

  setAIProgress(true, 'Aplicando reframe…', 90);

  // Aplicar el reframe localmente con los datos de Gemini
  AppState.aspectRatio = result.recommended_ratio || '9:16';
  const inner = $('previewInner');
  if (inner) inner.style.maxWidth = '200px';

  $$('[id^=btnAspect]').forEach(b => b.classList.remove('active'));
  const btn916 = $('btnAspect916');
  if (btn916) btn916.classList.add('active');

  const notes = result.notes || `Sujeto ${result.subject_position || 'centrado'}`;
  showToast(`Auto reframe 9:16 — ${notes}`, 'success');
  addHistory('IA Gemini: reframe 9:16');
}

// ── Funciones locales (sin Gemini) ────────────────────────────

function detectSilenceLocally() {
  // Detección de silencio usando Web Audio API
  if (!AppState.videoFile) {
    showToast('Carga un video primero', 'warning');
    return Promise.resolve();
  }

  setAIProgress(true, 'Analizando pista de audio…', 30);

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioCtx.decodeAudioData(e.target.result.slice(0), (buffer) => {
        const data   = buffer.getChannelData(0);
        const sr     = buffer.sampleRate;
        const thresh = 0.02;
        const minSilenceSec = 0.5;
        const minSilenceSamples = minSilenceSec * sr;

        setAIProgress(true, 'Detectando silencios…', 60);

        const silences = [];
        let silStart = null;
        for (let i = 0; i < data.length; i++) {
          const isSilent = Math.abs(data[i]) < thresh;
          if (isSilent && silStart === null) silStart = i;
          if (!isSilent && silStart !== null) {
            if (i - silStart > minSilenceSamples) {
              silences.push({ start: silStart / sr, end: i / sr });
            }
            silStart = null;
          }
        }

        setAIProgress(true, 'Marcando silencios en el timeline…', 85);

        if (silences.length === 0) {
          showToast('No se detectaron silencios significativos', 'info');
        } else {
          silences.forEach((s, i) => {
            const dur = s.end - s.start;
            const clip = {
              id: 'silence_' + Date.now() + '_' + i,
              name: `🔇 Silencio ${(dur).toFixed(1)}s`,
              start: s.start,
              duration: dur,
              type: 'a2',
            };
            AppState.clips.push(clip);
            TimelineEngine.addClip(clip);
          });
          showToast(`${silences.length} silencios detectados`, 'success');
        }

        addHistory('Local: detección de silencios');
        audioCtx.close();
        resolve();
      }, () => {
        showToast('No se pudo analizar el audio', 'error');
        resolve();
      });
    };
    reader.readAsArrayBuffer(AppState.videoFile);
  });
}

function applyLocalAutoColor() {
  // Corrección de color automática local — análisis de histograma
  if (!DOM.video.src) {
    showToast('Carga un video primero', 'warning');
    return Promise.resolve();
  }

  setAIProgress(true, 'Analizando fotograma para corrección de color…', 40);

  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 36;
    const ctx = canvas.getContext('2d');

    try {
      ctx.drawImage(DOM.video, 0, 0, 64, 36);
      const pixels = ctx.getImageData(0, 0, 64, 36).data;

      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        rSum += pixels[i]; gSum += pixels[i+1]; bSum += pixels[i+2];
        count++;
      }
      const rAvg = rSum / count, gAvg = gSum / count, bAvg = bSum / count;
      const lum  = (rAvg + gAvg + bAvg) / 3;

      setAIProgress(true, 'Aplicando ajustes automáticos…', 75);

      // Ajustar brightness si el video está muy oscuro o muy brillante
      AppState.filters.brightness = lum < 80 ? 15 : lum > 180 ? -10 : 3;
      AppState.filters.contrast   = 15;
      AppState.filters.saturation = 10;

      // Corrección de balance de blancos básica
      const maxCh = Math.max(rAvg, gAvg, bAvg);
      if (bAvg === maxCh) AppState.filters.temperature = 20;  // azulado → calentar
      else if (rAvg === maxCh) AppState.filters.temperature = -15; // rojizo → enfriar

      FilterEngine.syncSliderUI();
      FilterEngine.applyToVideo(DOM.video, AppState.filters);
      showToast('Color corregido automáticamente', 'success');
      addHistory('Local: auto corrección de color');
    } catch (e) {
      showToast('No se pudo leer el fotograma (¿video CORS?)', 'warning');
    }
    resolve();
  });
}

function applyFallbackBlur() {
  // Sin segmentación real disponible en frontend puro: blur global honesto
  AppState.filters.blur = 6;
  FilterEngine.syncSliderUI();
  FilterEngine.applyToVideo(DOM.video, AppState.filters);
  showToast('Blur global aplicado (segmentación de sujeto no disponible en el navegador)', 'info');
  addHistory('Local: blur de fondo (global)');
  return Promise.resolve();
}

// ── Dispatcher principal ──────────────────────────────────────

async function runAITool(tool) {
  const prog   = $('aiProgress');
  const fill   = $('aiProgFill');
  const status = $('aiProgStatus');

  if (prog) prog.classList.remove('hidden');

  try {
    switch (tool) {
      case 'subtitles':  await runGeminiSubtitles();  break;
      case 'highlights': await runGeminiHighlights(); break;
      case 'reframe':    await runGeminiReframe();    break;
      case 'silence':    await detectSilenceLocally(); break;
      case 'color':      await applyLocalAutoColor();  break;
      case 'bgblur':     await applyFallbackBlur();    break;
      default:
        showToast('Herramienta desconocida: ' + tool, 'warning');
    }
  } catch (err) {
    console.error('AI tool error:', err);
    showToast('Error en IA: ' + err.message, 'error');
  } finally {
    setAIProgress(false);
  }
}

/** Helpers de progreso y conversión */
function setAIProgress(visible, msg = '', pct = 0) {
  const prog   = $('aiProgress');
  const fill   = $('aiProgFill');
  const status = $('aiProgStatus');
  if (prog)   prog.classList.toggle('hidden', !visible);
  if (fill)   fill.style.width = pct + '%';
  if (status) status.textContent = msg;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 15: UTILIDADES
════════════════════════════════════════════════════════════════ */
function formatTime(seconds) {
  if (isNaN(seconds) || seconds < 0) return '0:00.000';
  const m  = Math.floor(seconds / 60);
  const s  = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${m}:${String(s).padStart(2,'0')}.${String(ms).padStart(3,'0')}`;
}

function formatTimeShort(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}:${String(s).padStart(2,'0')}` : `${s}s`;
}

function formatFileSize(bytes) {
  if (bytes < 1024)    return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function showToast(msg, type = 'info', duration = 3000) {
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  const icons = { success:'✓ ', error:'✕ ', info:'ℹ ', warning:'⚠ ' };
  toast.textContent = (icons[type] || '') + msg;
  DOM.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// Undo / Redo real
function addHistory(action) {
  AppState.history.splice(AppState.historyIndex + 1);
  AppState.history.push({ action, time: Date.now(), filters: { ...AppState.filters } });
  if (AppState.history.length > 60) AppState.history.shift();
  AppState.historyIndex = AppState.history.length - 1;
  updateHistoryPanel();
  ProjectManager.autoSave();
}

function undo() {
  if (AppState.historyIndex <= 0) { showToast('Nada que deshacer', 'info'); return; }
  AppState.historyIndex--;
  const state = AppState.history[AppState.historyIndex];
  if (state.filters) {
    Object.assign(AppState.filters, state.filters);
    FilterEngine.syncSliderUI();
    FilterEngine.applyToVideo(DOM.video, AppState.filters);
  }
  showToast('Deshacer: ' + state.action, 'info');
  updateHistoryPanel();
}

function redo() {
  if (AppState.historyIndex >= AppState.history.length - 1) { showToast('Nada que rehacer', 'info'); return; }
  AppState.historyIndex++;
  const state = AppState.history[AppState.historyIndex];
  if (state.filters) {
    Object.assign(AppState.filters, state.filters);
    FilterEngine.syncSliderUI();
    FilterEngine.applyToVideo(DOM.video, AppState.filters);
  }
  showToast('Rehacer: ' + state.action, 'info');
  updateHistoryPanel();
}

function updateHistoryPanel() {
  const panel = DOM.historyPanel;
  if (!panel) return;
  panel.innerHTML = '';
  const recent = AppState.history.slice(-10).reverse();
  if (recent.length === 0) { panel.innerHTML = '<div class="layer-empty">Sin acciones</div>'; return; }
  recent.forEach((h, i) => {
    const div = document.createElement('div');
    div.className = 'history-entry';
    div.textContent = (i === 0 ? '→ ' : '') + h.action;
    panel.appendChild(div);
  });
}

function updateLayers() {
  const panel = DOM.layersPanel;
  if (!panel) return;
  if (AppState.overlays.length === 0) {
    panel.innerHTML = '<div class="layer-empty">Sin capas</div>';
    return;
  }
  panel.innerHTML = '';
  [...AppState.overlays].reverse().forEach(ov => {
    const div = document.createElement('div');
    div.className = 'layer-item' + (ov.node === AppState.selectedOverlay ? ' active' : '');
    div.innerHTML = `<span class="layer-vis">👁</span><span>${ov.type}: ${ov.id.slice(-6)}</span>`;
    div.addEventListener('click', () => {
      KonvaEngine.getLayer().getChildren().forEach(n => {
        if (n.id() === ov.id) n.fire('click');
      });
    });
    panel.appendChild(div);
  });
}

function updateSplash(pct, msg) {
  if (DOM.splashFill)   DOM.splashFill.style.width = pct + '%';
  if (DOM.splashStatus) DOM.splashStatus.textContent = msg;
}

function markModule(id, loaded) {
  const el = $(id);
  if (el) el.classList.toggle('loaded', loaded);
}

function syncVideoInfo() {
  const v = DOM.video;
  if (!v.src) return;
  DOM.videoInfo.textContent = `${AppState.videoWidth}×${AppState.videoHeight} · ${AppState.videoFps}fps · ${formatTime(v.duration)}`;
  const setInfo = (id, val) => { const el = $(id); if (el) el.textContent = val; };
  setInfo('infoDuration',   formatTime(v.duration));
  setInfo('infoResolution', `${AppState.videoWidth}×${AppState.videoHeight}`);
  setInfo('infoFps',        AppState.videoFps);
  setInfo('infoFormat',     AppState.videoFile?.type?.split('/')[1]?.toUpperCase() || '—');
  setInfo('infoSize',       AppState.videoFile ? formatFileSize(AppState.videoFile.size) : '—');
  setInfo('infoBitrate',    AppState.videoFile ? Math.round(AppState.videoFile.size * 8 / v.duration / 1000) + ' kbps' : '—');
}

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 16: CARGA DE VIDEO
════════════════════════════════════════════════════════════════ */
function loadVideoFile(file) {
  if (!file || !file.type.startsWith('video/')) {
    showToast('Archivo de video no válido', 'error');
    return;
  }
  AppState.videoFile = file;
  const url = URL.createObjectURL(file);
  DOM.video.src = url;
  DOM.dropOverlay.classList.remove('active');

  DOM.video.onloadedmetadata = () => {
    AppState.videoDuration = DOM.video.duration;
    AppState.videoWidth    = DOM.video.videoWidth;
    AppState.videoHeight   = DOM.video.videoHeight;
    AppState.videoFps      = 30;

    DOM.totalTime.textContent = formatTime(DOM.video.duration);
    const trimEnd = $('trimEnd');   if (trimEnd) trimEnd.value = DOM.video.duration.toFixed(2);
    const expEnd  = $('exportEnd'); if (expEnd)  expEnd.value  = DOM.video.duration.toFixed(2);
    syncVideoInfo();

    // Inicializar Konva
    requestAnimationFrame(() => {
      const rect = DOM.video.getBoundingClientRect();
      KonvaEngine.init(rect.width || 640, rect.height || 360);
    });

    // Sincronizar canvas de grano y WebGL
    requestAnimationFrame(() => {
      const rect = DOM.video.getBoundingClientRect();
      if (DOM.grainCanvas) { DOM.grainCanvas.width = rect.width; DOM.grainCanvas.height = rect.height; }
      GPUEngine.init(DOM.glCanvas, DOM.video);
    });

    // Clips de timeline
    const clip = {
      id: 'clip_' + Date.now(),
      name: file.name.replace(/\.[^.]+$/, ''),
      start: 0, duration: DOM.video.duration, type: 'video',
    };
    const audioClip = { ...clip, type: 'audio', id: 'clip_audio_' + Date.now() };
    AppState.clips = [clip, audioClip];
    TimelineEngine.buildRuler();
    TimelineEngine.refreshClips();

    // Thumbnail en biblioteca
    addClipThumbnail(file, url);

    // Scopes
    ScopeEngine.start(DOM.video);

    // Audio
    AudioEngine.connectVideo(DOM.video);

    addHistory('Cargar video: ' + file.name);
    showToast('Video cargado: ' + file.name, 'success');
    EventBus.emit('videoLoaded', { file, duration: DOM.video.duration });
  };
}

function addClipThumbnail(file, url) {
  const grid = $('clipsGrid');
  if (!grid) return;
  const wrapper = document.createElement('div');
  wrapper.className = 'clip-thumb';

  const v = document.createElement('video');
  v.src = url; v.muted = true; v.currentTime = 0.5; v.preload = 'metadata';

  const overlay = document.createElement('div');
  overlay.className = 'clip-thumb-overlay';
  overlay.textContent = '▶';

  wrapper.appendChild(v);
  wrapper.appendChild(overlay);
  wrapper.addEventListener('click', () => {
    $$('.clip-thumb').forEach(c => c.classList.remove('active'));
    wrapper.classList.add('active');
    DOM.video.currentTime = 0;
  });
  grid.appendChild(wrapper);
}

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 17: GPU LOOP (efectos en tiempo real)
════════════════════════════════════════════════════════════════ */
function startGPULoop() {
  let t = 0;
  function frame() {
    requestAnimationFrame(frame);
    t += 0.016;
    if (AppState.gpuEffect && DOM.video.src && !DOM.video.paused) {
      GPUEngine.applyEffect(AppState.gpuEffect, DOM.video, AppState.gpuIntensity, t);
    } else if (!AppState.gpuEffect) {
      GPUEngine.clear();
    }
    // Keyframes
    if (AppState.isPlaying && AppState.keyframes.length > 0) {
      KonvaEngine.applyKeyframesAtTime(DOM.video.currentTime);
    }
  }
  requestAnimationFrame(frame);
}

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 18: CONTROLES DE REPRODUCCIÓN
════════════════════════════════════════════════════════════════ */
function setupPlaybackControls() {
  const video = DOM.video;

  DOM.btnPlayPause.addEventListener('click', () => {
    AudioEngine.resume();
    video.paused ? video.play() : video.pause();
  });

  video.addEventListener('play',  () => { DOM.btnPlayPause.textContent = '⏸'; AppState.isPlaying = true; });
  video.addEventListener('pause', () => { DOM.btnPlayPause.textContent = '▶'; AppState.isPlaying = false; });
  video.addEventListener('ended', () => {
    if (AppState.isLooping) { video.currentTime = 0; video.play(); }
    else { DOM.btnPlayPause.textContent = '▶'; AppState.isPlaying = false; }
  });

  video.addEventListener('timeupdate', () => {
    AppState.currentTime = video.currentTime;
    DOM.currentTime.textContent = formatTime(video.currentTime);
    TimelineEngine.updatePlayhead(video.currentTime);
    KonvaEngine.applyKeyframesAtTime(video.currentTime);
  });

  $('btnSkipStart').addEventListener('click', () => { video.currentTime = 0; });
  $('btnSkipEnd').addEventListener('click',   () => { video.currentTime = video.duration || 0; });
  $('btnBack5').addEventListener('click',     () => { video.currentTime = Math.max(0, video.currentTime - 5); });
  $('btnFwd5').addEventListener('click',      () => { video.currentTime = Math.min(video.duration, video.currentTime + 5); });

  // Frame a frame preciso
  $('btnBack1').addEventListener('click', () => {
    const fps = AppState.videoFps || 30;
    video.currentTime = Math.max(0, video.currentTime - 1 / fps);
  });
  $('btnFwd1').addEventListener('click', () => {
    const fps = AppState.videoFps || 30;
    video.currentTime = Math.min(video.duration, video.currentTime + 1 / fps);
  });

  $('btnLoop').addEventListener('click', () => {
    AppState.isLooping = !AppState.isLooping;
    $('btnLoop').classList.toggle('active', AppState.isLooping);
    video.loop = AppState.isLooping;
  });

  $('btnMute').addEventListener('click', () => {
    AppState.isMuted = !AppState.isMuted;
    video.muted = AppState.isMuted;
    $('btnMute').textContent = AppState.isMuted ? '🔇' : '🔊';
  });

  // Velocidad
  $('speedSlider').addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    AppState.playbackSpeed = val;
    video.playbackRate = val;
    $('speedVal').textContent = val.toFixed(2) + 'x';
    $$('.speed-btn').forEach(b => b.classList.toggle('active', parseFloat(b.dataset.speed) === val));
  });
  $$('.speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const speed = parseFloat(btn.dataset.speed);
      AppState.playbackSpeed = speed;
      video.playbackRate = speed;
      $('speedSlider').value = speed;
      $('speedVal').textContent = speed + 'x';
      $$('.speed-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Aspect ratio
  [['btnAspect169','16:9',''], ['btnAspect11','1:1','400px'], ['btnAspect916','9:16','200px'], ['btnAspect43','4:3','480px']]
  .forEach(([id, ratio, maxW]) => {
    $(id).addEventListener('click', () => {
      AppState.aspectRatio = ratio;
      $$('[id^=btnAspect]').forEach(b => b.classList.remove('active'));
      $(id).classList.add('active');
      $('previewInner').style.maxWidth = maxW;
    });
  });

  // Safe areas / Grid
  $('btnSafeArea').addEventListener('click', () => {
    AppState.showSafeArea = !AppState.showSafeArea;
    DOM.safeAreaOverlay.classList.toggle('hidden', !AppState.showSafeArea);
    $('btnSafeArea').classList.toggle('active', AppState.showSafeArea);
  });
  $('btnGrid').addEventListener('click', () => {
    AppState.showGrid = !AppState.showGrid;
    DOM.gridOverlay.classList.toggle('hidden', !AppState.showGrid);
    $('btnGrid').classList.toggle('active', AppState.showGrid);
  });

  // Fullscreen
  $('btnFullscreen').addEventListener('click', () => {
    const container = $('previewContainer');
    if (!document.fullscreenElement) {
      container.requestFullscreen().catch(e => showToast('Fullscreen: ' + e.message, 'error'));
    } else {
      document.exitFullscreen();
    }
  });

  // Zoom de preview
  $('btnZoomIn').addEventListener('click', () => {
    const cur = parseFloat($('zoomLabel').textContent) / 100;
    const next = Math.min(4, cur + 0.25);
    $('zoomLabel').textContent = Math.round(next * 100) + '%';
    video.style.transform = `scale(${next})`;
  });
  $('btnZoomOut').addEventListener('click', () => {
    const cur = parseFloat($('zoomLabel').textContent) / 100;
    const next = Math.max(0.25, cur - 0.25);
    $('zoomLabel').textContent = Math.round(next * 100) + '%';
    video.style.transform = `scale(${next})`;
  });
}

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 19: CONTROLES DE COLOR
════════════════════════════════════════════════════════════════ */
function setupColorControls() {
  const params = [
    ['brightness','brightnessVal',''],
    ['contrast','contrastVal',''],
    ['saturation','saturationVal',''],
    ['hue','hueVal','°'],
    ['temperature','temperatureVal',''],
    ['exposure','exposureVal',''],
    ['highlights','highlightsVal',''],
    ['shadows','shadowsVal',''],
    ['vignette','vignetteVal','%'],
    ['blurAmount','blurVal','px'],
    ['filmGrain','filmGrainVal','%'],
  ];

  params.forEach(([sliderId, valId, suffix]) => {
    const slider = $(sliderId);
    if (!slider) return;
    slider.addEventListener('input', () => {
      const val = parseFloat(slider.value);
      const key = sliderId === 'blurAmount' ? 'blur' : sliderId;
      AppState.filters[key] = val;
      $(valId).textContent = val + suffix;
      FilterEngine.applyToVideo(DOM.video, AppState.filters);
    });
  });

  $$('.filter-thumb').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.filter-thumb').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      FilterEngine.loadPreset(btn.dataset.filter);
      addHistory('Filtro: ' + btn.dataset.filter);
    });
  });

  $('btnResetColor').addEventListener('click', FilterEngine.resetFilters);

  const copyBtn = $('btnCopyColor');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const json = JSON.stringify(AppState.filters, null, 2);
      navigator.clipboard.writeText(json).then(() => showToast('Ajustes de color copiados', 'success'));
    });
  }

  // GPU Effects
  $$('.gpu-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const effect = btn.dataset.effect;
      if (AppState.gpuEffect === effect) {
        AppState.gpuEffect = null;
        GPUEngine.clear();
        btn.classList.remove('active');
        showToast('Efecto GPU desactivado', 'info');
      } else {
        AppState.gpuEffect = effect;
        $$('.gpu-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        showToast('Efecto GPU: ' + effect, 'success');
      }
      addHistory('GPU Effect: ' + (AppState.gpuEffect || 'ninguno'));
    });
  });

  const gpuIntSlider = $('gpuIntensity');
  if (gpuIntSlider) {
    gpuIntSlider.addEventListener('input', (e) => {
      AppState.gpuIntensity = parseInt(e.target.value);
      $('gpuIntensityVal').textContent = AppState.gpuIntensity + '%';
    });
  }
}

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 20: CONTROLES DE AUDIO
════════════════════════════════════════════════════════════════ */
function setupAudioControls() {
  const vol = $('masterVolume');
  if (vol) vol.addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    AppState.audio.masterVolume = val;
    $('masterVolumeVal').textContent = val + '%';
    AudioEngine.setMasterVolume(val);
    DOM.video.volume = Math.min(1, val / 100);
  });

  $('fadeIn').addEventListener('input', (e) => {
    AppState.audio.fadeIn = parseFloat(e.target.value);
    $('fadeInVal').textContent = AppState.audio.fadeIn.toFixed(1) + 's';
  });
  $('fadeOut').addEventListener('input', (e) => {
    AppState.audio.fadeOut = parseFloat(e.target.value);
    $('fadeOutVal').textContent = AppState.audio.fadeOut.toFixed(1) + 's';
  });
  $('audioPan').addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    AppState.audio.pan = val;
    $('audioPanVal').textContent = val === 0 ? 'Centro' : val > 0 ? `Dcha ${val}%` : `Izq ${Math.abs(val)}%`;
    AudioEngine.setPan(val);
  });
  $('audioPitch').addEventListener('input', (e) => {
    AppState.audio.pitch = parseInt(e.target.value);
    $('audioPitchVal').textContent = (AppState.audio.pitch > 0 ? '+' : '') + AppState.audio.pitch;
  });
  $('audioReverb').addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    AppState.audio.reverb = val;
    $('audioReverbVal').textContent = val + '%';
    AudioEngine.setReverb(val);
  });
  $('audioCompress').addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    AppState.audio.compress = val;
    $('audioCompressVal').textContent = val + '%';
    AudioEngine.setCompress(val);
  });

  // EQ 7 bandas
  $$('.eq-slider').forEach(slider => {
    slider.addEventListener('input', () => {
      const freq = parseInt(slider.dataset.freq);
      const gain = parseFloat(slider.value);
      AppState.audio.eq[freq] = gain;
      AudioEngine.setEqBand(freq, gain);
    });
  });

  // Track mute/solo
  $$('.track-mute').forEach(btn => {
    btn.addEventListener('click', () => {
      const track = btn.dataset.track;
      AppState.audio.tracks[track].muted = !AppState.audio.tracks[track].muted;
      btn.classList.toggle('active', AppState.audio.tracks[track].muted);
      if (track === 'a1') DOM.video.muted = AppState.audio.tracks[track].muted;
    });
  });
  $$('.track-solo').forEach(btn => {
    btn.addEventListener('click', () => {
      const track = btn.dataset.track;
      AppState.audio.tracks[track].solo = !AppState.audio.tracks[track].solo;
      btn.classList.toggle('active', AppState.audio.tracks[track].solo);
    });
  });
  $$('.mini-vol').forEach(slider => {
    slider.addEventListener('input', (e) => {
      const track = slider.dataset.track;
      const val = parseInt(slider.value);
      AppState.audio.tracks[track].vol = val;
      if (track === 'a1') DOM.video.volume = Math.min(1, val / 100);
    });
  });

  // Música de fondo
  $('musicZone').addEventListener('click', () => $('musicInput').click());
  $('musicInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    AppState.musicFile = file;
    const musicAudio = new Audio(URL.createObjectURL(file));
    musicAudio.loop = true;
    AudioEngine.connectMusic(musicAudio);
    $('musicVolumeRow').style.display = 'flex';
    musicAudio.play().catch(()=>{});

    const clip = {
      id: 'music_' + Date.now(),
      name: '🎵 ' + file.name.replace(/\.[^.]+$/, ''),
      start: 0, duration: AppState.videoDuration || 30, type: 'music',
    };
    AppState.clips.push(clip);
    TimelineEngine.addClip(clip);
    showToast('Música: ' + file.name, 'success');
    addHistory('Agregar música');
  });

  $('musicVolume').addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    AppState.musicVolume = val;
    $('musicVolumeVal').textContent = val + '%';
    AudioEngine.setMusicVolume(val);
  });
}

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 21: CONTROLES DE OVERLAY
════════════════════════════════════════════════════════════════ */
function setupOverlayControls() {
  $$('.ov-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.ov-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      $$('.ov-section').forEach(s => s.classList.add('hidden'));
      $('ov-' + tab.dataset.ov).classList.remove('hidden');
    });
  });

  $('btnAddText').addEventListener('click', () => {
    const text = $('overlayText').value.trim();
    if (!text) { showToast('Escribe un texto primero', 'warning'); return; }
    const node = KonvaEngine.addText({
      text,
      fontSize:    parseInt($('fontSize').value),
      fontFamily:  $('fontFamily').value,
      fill:        $('fontColor').value,
      stroke:      $('strokeColor').value,
      strokeWidth: parseInt($('strokeWidth').value),
      opacity:     parseFloat($('textOpacity').value),
    });

    const clip = {
      id: node.id(),
      name: '💬 ' + text.slice(0, 20),
      start: AppState.currentTime,
      duration: Math.min(5, (AppState.videoDuration - AppState.currentTime) || 5),
      type: 'text',
    };
    AppState.clips.push(clip);
    TimelineEngine.addClip(clip);
    showToast('Texto agregado', 'success');
  });

  // Sliders de texto
  $('fontSize').addEventListener('input', (e) => {
    $('fontSizeVal').textContent = e.target.value + 'px';
    if (AppState.selectedOverlay?.className === 'Text') {
      AppState.selectedOverlay.fontSize(parseInt(e.target.value));
      KonvaEngine.getLayer().batchDraw();
    }
  });
  $('textOpacity').addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    $('textOpacityVal').textContent = Math.round(val * 100) + '%';
    if (AppState.selectedOverlay) {
      AppState.selectedOverlay.opacity(val);
      KonvaEngine.getLayer().batchDraw();
    }
  });
  $('strokeWidth').addEventListener('input', (e) => {
    $('strokeVal').textContent = e.target.value;
    if (AppState.selectedOverlay?.className === 'Text') {
      AppState.selectedOverlay.strokeWidth(parseInt(e.target.value));
      KonvaEngine.getLayer().batchDraw();
    }
  });
  $('elemRotation').addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    $('elemRotationVal').textContent = val + '°';
    if (AppState.selectedOverlay) {
      AppState.selectedOverlay.rotation(val);
      KonvaEngine.getLayer().batchDraw();
    }
  });

  // Estilo texto
  let bold = false, italic = false, underline = false;
  const applyFontStyle = () => {
    if (!AppState.selectedOverlay?.className === 'Text') return;
    const style = [(italic ? 'italic' : ''), (bold ? 'bold' : '')].filter(Boolean).join(' ') || 'normal';
    AppState.selectedOverlay.fontStyle(style);
    KonvaEngine.getLayer().batchDraw();
  };
  $('btnBold').addEventListener('click', () => {
    bold = !bold; $('btnBold').classList.toggle('active', bold); applyFontStyle();
  });
  $('btnItalic').addEventListener('click', () => {
    italic = !italic; $('btnItalic').classList.toggle('active', italic); applyFontStyle();
  });
  $('btnUnderline').addEventListener('click', () => {
    underline = !underline;
    $('btnUnderline').classList.toggle('active', underline);
    if (AppState.selectedOverlay?.className === 'Text') {
      AppState.selectedOverlay.textDecoration(underline ? 'underline' : '');
      KonvaEngine.getLayer().batchDraw();
    }
  });
  $('btnUppercase').addEventListener('click', () => {
    if (AppState.selectedOverlay?.className === 'Text') {
      const t = AppState.selectedOverlay.text();
      AppState.selectedOverlay.text(t === t.toUpperCase() ? t.toLowerCase() : t.toUpperCase());
      KonvaEngine.getLayer().batchDraw();
    }
  });

  // Animaciones de texto
  $$('.anim-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.anim-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const anim = btn.dataset.anim;
      if (AppState.selectedOverlay && anim !== 'none') applyTextAnimation(AppState.selectedOverlay, anim);
    });
  });

  // Formas
  $$('.shape-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      KonvaEngine.addShape(btn.dataset.shape, {
        fill:        $('shapeFill').value,
        stroke:      $('shapeBorder').value,
        strokeWidth: parseInt($('shapeStroke').value),
        opacity:     parseFloat($('shapeOpacity').value),
        blur:        parseInt($('shapeBlur').value),
      });
    });
  });
  $('shapeStroke').addEventListener('input', (e) => { $('shapeStrokeVal').textContent = e.target.value; });
  $('shapeOpacity').addEventListener('input', (e) => { $('shapeOpacityVal').textContent = Math.round(e.target.value * 100) + '%'; });
  $('shapeBlur').addEventListener('input', (e) => { $('shapeBlurVal').textContent = e.target.value; });

  // Stickers
  const STICKERS_FULL = ['😊','🔥','⭐','💯','🎬','🎵','❤️','✨','🚀','💎','⚡','🎯','🏆','🌟','👑','💪','🎉','🌊','🎮','📸',
    '👏','🤩','😎','🦋','🌈','🎸','🎭','🍕','🏖','🦄','💫','🧠','🎪','👾','🤖','🌙','☀️','🎲','🎨','🎻'];

  const renderStickers = (filter = '') => {
    const grid = $('stickerGrid');
    if (!grid) return;
    grid.innerHTML = '';
    STICKERS_FULL.filter(e => !filter || e.includes(filter)).forEach(emoji => {
      const item = document.createElement('div');
      item.className = 'sticker-item';
      item.dataset.emoji = emoji;
      item.textContent = emoji;
      item.addEventListener('click', () => KonvaEngine.addSticker(emoji, parseInt($('stickerSize').value)));
      grid.appendChild(item);
    });
  };
  renderStickers();
  $('stickerSearch').addEventListener('input', (e) => renderStickers(e.target.value));
  $('stickerSize').addEventListener('input', (e) => { $('stickerSizeVal').textContent = e.target.value + 'px'; });

  // Subtítulos
  $('btnAutoSubtitles').addEventListener('click', () => runAITool('subtitles'));
  const subSize = $('subSize'); if (subSize) subSize.addEventListener('input', (e) => { $('subSizeVal').textContent = e.target.value + 'px'; });
  $('btnAddSubtitle').addEventListener('click', () => {
    const text = $('subText').value.trim();
    if (!text) { showToast('Escribe el texto del subtítulo', 'warning'); return; }
    const node = KonvaEngine.addText({
      text: text.replace(/^\d{2}:\d{2}:\d{2}.*\n/, '').trim(),
      fontSize:   parseInt($('subSize').value) || 24,
      fontFamily: $('subFont').value,
      fill:       $('subColor').value,
    });
    showToast('Subtítulo agregado', 'success');
  });

  // Controles de selección
  $('btnDeleteSelected').addEventListener('click', KonvaEngine.deleteSelected);
  $('btnDuplicateSelected').addEventListener('click', KonvaEngine.duplicateSelected);
  $('btnBringFront').addEventListener('click', KonvaEngine.bringToFront);
  $('btnSendBack').addEventListener('click', KonvaEngine.sendToBack);
}

function applyTextAnimation(node, anim) {
  if (anim === 'fadeIn') {
    node.opacity(0);
    new Konva.Tween({ node, opacity: 1, duration: 0.5, easing: Konva.Easings.EaseIn }).play();
  } else if (anim === 'slideUp') {
    const origY = node.y();
    node.y(origY + 80); node.opacity(0);
    new Konva.Tween({ node, y: origY, opacity: 1, duration: 0.5, easing: Konva.Easings.EaseOut }).play();
  } else if (anim === 'slideLeft') {
    const origX = node.x();
    node.x(origX + 100); node.opacity(0);
    new Konva.Tween({ node, x: origX, opacity: 1, duration: 0.5, easing: Konva.Easings.EaseOut }).play();
  } else if (anim === 'bounceIn') {
    node.scaleX(0); node.scaleY(0); node.opacity(0);
    new Konva.Tween({ node, scaleX: 1, scaleY: 1, opacity: 1, duration: 0.7, easing: Konva.Easings.BounceEaseOut }).play();
  } else if (anim === 'scaleIn') {
    node.scaleX(0.1); node.scaleY(0.1);
    new Konva.Tween({ node, scaleX: 1, scaleY: 1, duration: 0.4, easing: Konva.Easings.EaseOut }).play();
  } else if (anim === 'typewriter') {
    const full = node.text();
    node.text('');
    let i = 0;
    const interval = setInterval(() => {
      node.text(full.slice(0, ++i));
      KonvaEngine.getLayer().batchDraw();
      if (i >= full.length) clearInterval(interval);
    }, 60);
  } else if (anim === 'glitch') {
    const origX = node.x();
    let count = 0;
    const interval = setInterval(() => {
      node.x(origX + (Math.random()-0.5)*20);
      node.offsetX(node.offsetX() + (Math.random()-0.5)*4);
      KonvaEngine.getLayer().batchDraw();
      if (++count > 12) { clearInterval(interval); node.x(origX); KonvaEngine.getLayer().batchDraw(); }
    }, 60);
  }
}

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 22: KEYFRAME CONTROLS
════════════════════════════════════════════════════════════════ */
function setupKeyframeControls() {
  $$('.kf-add-btn').forEach(btn => {
    btn.addEventListener('click', () => addKeyframe(btn.dataset.prop));
  });

  $$('.interp-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.interp-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      AppState.kfInterpolation = btn.dataset.interp;
    });
  });

  $('btnClearKeyframes').addEventListener('click', () => {
    AppState.keyframes = [];
    refreshKFList();
    renderKFDiamonds();
    addHistory('Limpiar keyframes');
    showToast('Keyframes eliminados', 'info');
  });

  $('btnPreviewKeyframes').addEventListener('click', () => {
    if (!DOM.video.src) { showToast('Carga un video primero', 'warning'); return; }
    DOM.video.currentTime = 0;
    DOM.video.play();
    showToast('Reproduciendo con keyframes', 'info');
  });
}

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 23: CONTROLES DE TRANSICIONES
════════════════════════════════════════════════════════════════ */
function setupTransitionControls() {
  $$('.transition-card').forEach(card => {
    card.addEventListener('click', () => {
      $$('.transition-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      AppState.activeTransition = card.dataset.transition;
    });
  });

  const durSlider = $('transDuration');
  if (durSlider) {
    durSlider.addEventListener('input', (e) => {
      AppState.transitionDuration = parseFloat(e.target.value);
      $('transDurationVal').textContent = AppState.transitionDuration.toFixed(2) + 's';
    });
  }

  $('btnApplyTransition').addEventListener('click', () => {
    showToast(`Transición '${AppState.activeTransition}' aplicada (${AppState.transitionDuration.toFixed(1)}s)`, 'success');
    addHistory('Transición: ' + AppState.activeTransition);
  });

  $('btnPreviewTrans').addEventListener('click', () => {
    previewTransition(AppState.activeTransition, AppState.transitionDuration);
  });
}

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 24: CONTROLES IA
════════════════════════════════════════════════════════════════ */
function setupAIControls() {
  $$('.ai-run-btn').forEach(btn => {
    btn.addEventListener('click', () => runAITool(btn.dataset.ai));
  });
}

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 25: EXPORTACIÓN
════════════════════════════════════════════════════════════════ */
function setupExportControls() {
  // Presets de exportación
  const exportPresets = {
    youtube:   { format:'mp4', quality:'4k',    fps:'60', bitrate:'50000k' },
    tiktok:    { format:'mp4', quality:'high',  fps:'30', bitrate:'8000k'  },
    instagram: { format:'mp4', quality:'high',  fps:'30', bitrate:'4000k'  },
    cinema:    { format:'mp4', quality:'4k',    fps:'24', bitrate:'50000k' },
    web:       { format:'webm',quality:'medium',fps:'30', bitrate:'2000k'  },
  };

  $$('.export-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.export-preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const preset = exportPresets[btn.dataset.preset];
      if (!preset) return;
      const set = (id, val) => { const el = $(id); if (el) el.value = val; };
      set('exportFormat',  preset.format);
      set('exportQuality', preset.quality);
      set('exportFps',     preset.fps);
      set('exportBitrate', preset.bitrate);
    });
  });

  $('btnExport').addEventListener('click', async () => {
    if (!AppState.videoFile) { showToast('No hay video cargado', 'error'); return; }
    if (AppState.isRendering) return;

    // Mostrar error claro si FFmpeg no está disponible
    if (!AppState.ffmpegLoaded) {
      const errMsg = AppState._ffmpegError || 'FFmpeg no está disponible.';
      showToast(errMsg + ' No se puede exportar.', 'error', 7000);
      // También mostrar en el panel de exportación
      const exportPanel = $('panel-export');
      if (exportPanel) {
        let errBanner = $('ffmpegErrorBanner');
        if (!errBanner) {
          errBanner = document.createElement('div');
          errBanner.id = 'ffmpegErrorBanner';
          errBanner.style.cssText = 'background:#ef444433;border:1px solid #ef4444;border-radius:6px;padding:10px 14px;color:#fca5a5;font-size:12px;margin-bottom:12px;';
          exportPanel.insertBefore(errBanner, exportPanel.firstChild);
        }
        errBanner.textContent = '⚠ ' + errMsg + ' La exportación real no está disponible en este entorno.';
      }
      return;
    }

    AppState.isRendering = true;
    DOM.modalRender.classList.remove('hidden');
    DOM.modalStatus.textContent = 'Iniciando renderizado…';

    try {
      const opts = {
        format:   $('exportFormat').value,
        quality:  $('exportQuality').value,
        fps:      parseInt($('exportFps').value),
        bitrate:  $('exportBitrate').value,
        startSec: parseFloat($('exportStart').value) || 0,
        endSec:   parseFloat($('exportEnd').value) || AppState.videoDuration,
      };
      DOM.modalStatus.textContent = 'Aplicando filtros y efectos…';
      const result = await FFmpegEngine.applyFiltersAndExport(AppState.videoFile, AppState.filters, opts);

      if (result && result.length > 0) {
        const mimes = { mp4:'video/mp4', webm:'video/webm', gif:'image/gif' };
        const blob = new Blob([result], { type: mimes[opts.format] || 'video/mp4' });
        const url  = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const title = $('metaTitle').value || 'vidforge_pro_export';
        a.download = title.replace(/\s+/g,'_') + '.' + opts.format;
        a.click();
        URL.revokeObjectURL(url);
        showToast('¡Video exportado!', 'success', 5000);
        addHistory('Exportar video');
      } else {
        showToast('El video exportado está vacío. Verifica el archivo de entrada.', 'error');
      }
    } catch(e) {
      console.error('Export error:', e);
      showToast('Error al exportar: ' + e.message, 'error');
    } finally {
      AppState.isRendering = false;
      DOM.modalRender.classList.add('hidden');
      FFmpegEngine.updateRenderProgress(0);
    }
  });

  // Exportar frame
  $('btnExportFrame').addEventListener('click', () => {
    const canvas = document.createElement('canvas');
    canvas.width  = AppState.videoWidth  || 1280;
    canvas.height = AppState.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(DOM.video, 0, 0, canvas.width, canvas.height);

    const konvaURL = KonvaEngine.exportAsDataURL();
    const save = () => {
      canvas.toBlob(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'frame_' + Date.now() + '.png';
        a.click(); URL.revokeObjectURL(url);
        showToast('Fotograma exportado', 'success');
      });
    };
    if (konvaURL) {
      const img = new Image();
      img.onload = () => { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); save(); };
      img.src = konvaURL;
    } else { save(); }
  });

  // Exportar GIF (simulado)
  $('btnExportGif').addEventListener('click', async () => {
    showToast('Generando GIF…', 'info');
    await delay(2000);
    showToast('GIF listo (demo)', 'success');
  });

  $('btnCancelRender').addEventListener('click', () => {
    AppState.isRendering = false;
    DOM.modalRender.classList.add('hidden');
    FFmpegEngine.updateRenderProgress(0);
    showToast('Renderizado cancelado', 'warning');
  });
}

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 26: CONTROLES DE TIMELINE
════════════════════════════════════════════════════════════════ */
function setupTimelineControls() {
  $('timelineZoom').addEventListener('input', (e) => {
    AppState.timelineZoom = parseFloat(e.target.value);
    $('timelineZoomVal').textContent = AppState.timelineZoom.toFixed(1) + 'x';
    TimelineEngine.buildRuler();
    TimelineEngine.refreshClips();
    renderKFDiamonds();
  });

  $('btnApplyTrim').addEventListener('click', () => {
    const start = parseFloat($('trimStart').value);
    const end   = parseFloat($('trimEnd').value);
    if (isNaN(start) || isNaN(end) || start >= end) {
      showToast('Rango inválido', 'error'); return;
    }
    DOM.video.currentTime = start;
    showToast(`Recorte: ${start.toFixed(2)}s → ${end.toFixed(2)}s`, 'success');
    addHistory(`Recortar: ${start.toFixed(1)}–${end.toFixed(1)}s`);
  });

  $('btnSetInPoint').addEventListener('click', () => {
    AppState.markIn = AppState.currentTime;
    $('trimStart').value = AppState.currentTime.toFixed(2);
    showToast('In point marcado: ' + formatTime(AppState.currentTime), 'info');
  });

  $('btnMarkIn').addEventListener('click', () => {
    AppState.markIn = AppState.currentTime;
    showToast('In: ' + formatTime(AppState.currentTime), 'info');
  });

  $('btnMarkOut').addEventListener('click', () => {
    AppState.markOut = AppState.currentTime;
    showToast('Out: ' + formatTime(AppState.currentTime), 'info');
  });

  $('btnFitTimeline').addEventListener('click', TimelineEngine.fitTimeline);

  $('btnClearTimeline').addEventListener('click', () => {
    $$('.tl-clip').forEach(el => el.remove());
    AppState.clips = [];
    addHistory('Limpiar timeline');
    showToast('Timeline limpiado', 'info');
  });

  $('btnSnap').addEventListener('click', () => {
    AppState.snapEnabled = !AppState.snapEnabled;
    $('btnSnap').classList.toggle('active', AppState.snapEnabled);
    showToast('Snap ' + (AppState.snapEnabled ? 'activado' : 'desactivado'), 'info');
  });

  // Snap toggle del panel
  const snapToggle = $('snapToggle');
  if (snapToggle) {
    snapToggle.addEventListener('click', () => {
      AppState.snapEnabled = !AppState.snapEnabled;
      snapToggle.classList.toggle('active-toggle', AppState.snapEnabled);
      snapToggle.querySelector('.toggle-thumb') && (snapToggle.querySelector('.toggle-thumb').style.left = AppState.snapEnabled ? '18px' : '2px');
    });
  }
  const snapClipsToggle = $('snapClipsToggle');
  if (snapClipsToggle) {
    snapClipsToggle.addEventListener('click', () => {
      AppState.snapToClips = !AppState.snapToClips;
      snapClipsToggle.classList.toggle('active-toggle', AppState.snapToClips);
    });
  }

  // Track lock/vis/mute/solo en labels
  $$('.tl-btn-lock').forEach(btn => {
    btn.addEventListener('click', () => {
      const track = btn.dataset.track;
      AppState.tracks[track].locked = !AppState.tracks[track].locked;
      btn.textContent = AppState.tracks[track].locked ? '🔒' : '🔓';
      showToast(`Track ${track.toUpperCase()} ${AppState.tracks[track].locked ? 'bloqueado' : 'desbloqueado'}`, 'info');
    });
  });
  $$('.tl-btn-vis').forEach(btn => {
    btn.addEventListener('click', () => {
      const track = btn.dataset.track;
      AppState.tracks[track].visible = !AppState.tracks[track].visible;
      btn.style.opacity = AppState.tracks[track].visible ? '1' : '0.3';
      const trackEl = $('track' + capitalize(track));
      if (trackEl) trackEl.style.opacity = AppState.tracks[track].visible ? '1' : '0.3';
    });
  });
  $$('.tl-btn-mute').forEach(btn => {
    btn.addEventListener('click', () => {
      const track = btn.dataset.track;
      AppState.tracks[track].muted = !AppState.tracks[track].muted;
      btn.classList.toggle('active', AppState.tracks[track].muted);
      if (track === 'a1') DOM.video.muted = AppState.tracks[track].muted;
    });
  });
  $$('.tl-btn-solo').forEach(btn => {
    btn.addEventListener('click', () => {
      const track = btn.dataset.track;
      AppState.tracks[track].solo = !AppState.tracks[track].solo;
      btn.classList.toggle('active', AppState.tracks[track].solo);
    });
  });

  // Resize del timeline
  const handle = $('timelineResizeHandle');
  const wrapper = $('timelineWrapper');
  if (handle && wrapper) {
    let startY, startH;
    handle.addEventListener('mousedown', (e) => {
      startY = e.clientY;
      startH = wrapper.offsetHeight;
      const onMove = (e2) => {
        const dy = startY - e2.clientY;
        const newH = Math.max(120, Math.min(400, startH + dy));
        wrapper.style.height = newH + 'px';
        document.documentElement.style.setProperty('--timeline-h', newH + 'px');
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  TimelineEngine.initPlayheadDrag();
}

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 27: DRAG & DROP GLOBAL
════════════════════════════════════════════════════════════════ */
function setupDragAndDrop() {
  ['dragenter','dragover'].forEach(evt => {
    document.addEventListener(evt, (e) => { e.preventDefault(); DOM.dropOverlay.classList.add('active'); });
  });
  ['dragleave','drop'].forEach(evt => {
    document.addEventListener(evt, () => DOM.dropOverlay.classList.remove('active'));
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    files.forEach(file => {
      if (file.type.startsWith('video/')) loadVideoFile(file);
      else if (file.type.startsWith('audio/')) {
        // Simular carga de audio en A2
        AppState.musicFile = file;
        showToast('Audio cargado en A2: ' + file.name, 'success');
      }
    });
  });

  DOM.uploadZone.addEventListener('click', () => DOM.fileInput.click());
  DOM.fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) loadVideoFile(e.target.files[0]);
  });
}

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 28: ATAJOS DE TECLADO
════════════════════════════════════════════════════════════════ */
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement.tagName;
    if (['INPUT','TEXTAREA','SELECT'].includes(tag)) return;

    switch(e.key) {
      case ' ':
        e.preventDefault();
        DOM.btnPlayPause.click();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        DOM.video.currentTime = Math.max(0, DOM.video.currentTime - (e.shiftKey ? 1/30 : e.ctrlKey ? 5 : 1));
        break;
      case 'ArrowRight':
        e.preventDefault();
        DOM.video.currentTime = Math.min(DOM.video.duration||0, DOM.video.currentTime + (e.shiftKey ? 1/30 : e.ctrlKey ? 5 : 1));
        break;
      case 'j': DOM.video.playbackRate = Math.max(0.1, DOM.video.playbackRate - 0.5); break;
      case 'k': DOM.video.playbackRate = 1; break;
      case 'l': DOM.video.playbackRate = Math.min(4, DOM.video.playbackRate + 0.5); break;
      case 'i':
        if (!e.ctrlKey) { AppState.markIn = AppState.currentTime; $('trimStart').value = AppState.currentTime.toFixed(2); showToast('In: ' + formatTime(AppState.currentTime), 'info'); }
        break;
      case 'o':
        if (!e.ctrlKey) { AppState.markOut = AppState.currentTime; $('trimEnd').value = AppState.currentTime.toFixed(2); showToast('Out: ' + formatTime(AppState.currentTime), 'info'); }
        break;
      case 'c': AppState.activeTool = 'cut'; showToast('Herramienta: Cortar', 'info'); break;
      case 'v': AppState.activeTool = 'select'; break;
      case 'm': $('btnMute').click(); break;
      case 'f': $('btnCinema').click(); break;
      case 'g': $('btnGrid').click(); break;
      case 'Delete':
      case 'Backspace':
        KonvaEngine.deleteSelected();
        break;
      case 'z':
        if (e.ctrlKey||e.metaKey) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
        break;
      case 'y':
        if (e.ctrlKey||e.metaKey) { e.preventDefault(); redo(); }
        break;
      case 'd':
        if (e.ctrlKey||e.metaKey) { e.preventDefault(); KonvaEngine.duplicateSelected(); }
        break;
      case 'e':
        if (e.ctrlKey||e.metaKey) { e.preventDefault(); $('btnExport').click(); }
        break;
      case 's':
        if (e.ctrlKey||e.metaKey) { e.preventDefault(); ProjectManager.save(); }
        break;
      case 'Escape':
        if (document.fullscreenElement) document.exitFullscreen();
        $('contextMenu').classList.add('hidden');
        break;
      case '=':
      case '+':
        if (e.ctrlKey) { e.preventDefault(); $('btnZoomIn').click(); }
        break;
      case '-':
        if (e.ctrlKey) { e.preventDefault(); $('btnZoomOut').click(); }
        break;
    }
  });

  $('btnUndo').addEventListener('click', undo);
  $('btnRedo').addEventListener('click', redo);
}

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 29: TABS DE PANEL
════════════════════════════════════════════════════════════════ */
function setupPanelTabs() {
  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      $$('.panel-section').forEach(s => s.classList.add('hidden'));
      const panel = $('panel-' + btn.dataset.panel);
      if (panel) panel.classList.remove('hidden');
    });
  });

  // Herramientas
  ['toolSelect','toolCut','toolSplit','toolTrim','toolRazor'].forEach(id => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('click', () => {
      $$('.tool-btn').forEach(b => b.classList.remove('active'));
      el.classList.add('active');
      AppState.activeTool = id.replace('tool','').toLowerCase();
    });
  });
}

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 30: BOTÓN RENDER + MODO CINEMA + PROYECTO
════════════════════════════════════════════════════════════════ */
function setupTopbarControls() {
  // Botón render → panel exportar
  $('btnRender').addEventListener('click', () => {
    $$('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('[data-panel="export"]').classList.add('active');
    $$('.panel-section').forEach(s => s.classList.add('hidden'));
    $('panel-export').classList.remove('hidden');
    showToast('Panel de exportación abierto', 'info');
  });

  // Modo cinema
  $('btnCinema').addEventListener('click', () => {
    AppState.cinemaMode = !AppState.cinemaMode;
    DOM.cinemaBars.classList.toggle('hidden', !AppState.cinemaMode);
    DOM.cinemaBars.classList.toggle('active', AppState.cinemaMode);
    $('btnCinema').classList.toggle('active', AppState.cinemaMode);
    showToast('Modo cinema ' + (AppState.cinemaMode ? 'activado' : 'desactivado'), 'info');
  });

  // Guardar proyecto
  $('btnSaveProject').addEventListener('click', ProjectManager.save);

  // Nombre del proyecto
  const nameEl = $('projectName');
  if (nameEl) {
    nameEl.addEventListener('input', () => {
      AppState.projectName = nameEl.textContent.trim();
      ProjectManager.autoSave();
    });
  }

  // GPU Badge click → toggle info
  const gpuBadge = $('gpuBadge');
  if (gpuBadge) {
    gpuBadge.addEventListener('click', () => {
      showToast('GPU: WebGL ' + (document.createElement('canvas').getContext('webgl') ? 'disponible ✓' : 'no disponible ✗'), 'info');
    });
  }
}

/* ═══════════════════════════════════════════════════════════════
   MÓDULO 31: RESIZE OBSERVER
════════════════════════════════════════════════════════════════ */
function setupResizeObserver() {
  if (!window.ResizeObserver) return;
  const ro = new ResizeObserver(() => {
    if (!DOM.video.src) return;
    const rect = DOM.video.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      KonvaEngine.resizeKonva(rect.width, rect.height);
      if (DOM.grainCanvas) { DOM.grainCanvas.width = rect.width; DOM.grainCanvas.height = rect.height; }
      if (DOM.glCanvas)    { DOM.glCanvas.width = rect.width;    DOM.glCanvas.height = rect.height; }
    }
  });
  ro.observe(DOM.video);
}

/* ═══════════════════════════════════════════════════════════════
   INICIALIZACIÓN PRINCIPAL
════════════════════════════════════════════════════════════════ */
async function init() {
  updateSplash(5, 'Iniciando VidForge Pro v2.0…');
  await delay(200);

  // FFmpeg
  await FFmpegEngine.init();

  updateSplash(82, 'Inicializando WebGL…');
  GPUEngine.init(DOM.glCanvas, DOM.video);
  markModule('mod-webgl', true);

  updateSplash(88, 'Cargando Web Audio API…');
  AudioEngine.init();
  markModule('mod-konva', true);

  updateSplash(93, 'Montando interfaz…');
  await delay(150);

  // Setup de todos los módulos
  setupPanelTabs();
  setupPlaybackControls();
  setupColorControls();
  setupAudioControls();
  setupOverlayControls();
  setupKeyframeControls();
  setupTransitionControls();
  setupAIControls();
  setupExportControls();
  setupTimelineControls();
  setupDragAndDrop();
  setupKeyboardShortcuts();
  setupTopbarControls();
  setupResizeObserver();

  // Iniciar monitores
  FPSMonitor.start();
  startGPULoop();
  ProjectManager.startAutoSave();

  // Ruler vacío inicial
  AppState.videoDuration = 60;
  TimelineEngine.buildRuler();
  AppState.videoDuration = 0;

  // EventBus subscriptions
  EventBus.on('videoLoaded', (data) => {
    AppState.videoDuration = data.duration;
    TimelineEngine.buildRuler();
    TimelineEngine.fitTimeline();
  });
  EventBus.on('timelineChanged', () => {
    renderKFDiamonds();
  });

  updateSplash(100, '¡Listo para editar!');
  await delay(350);

  // Transición splash → app
  DOM.splash.style.opacity = '0';
  DOM.splash.style.transition = 'opacity 0.6s ease';
  await delay(600);
  DOM.splash.classList.add('hidden');
  DOM.app.classList.remove('hidden');

  // Konva por defecto
  KonvaEngine.init(640, 360);

  showToast('VidForge Pro v2.0 listo 🎬', 'success', 4000);
  console.log('%cVidForge Pro v2.0 inicializado ✓', 'color:#f59e0b;font-size:15px;font-weight:bold;text-shadow:0 0 10px rgba(245,158,11,0.5)');
}

// Arrancar
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
