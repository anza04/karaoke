// "Face snow": round face pictures falling gently from the top of the screen, like snowflakes.
// Drawn on a full-screen canvas behind the app, so lyrics stay readable.

const FACE_URLS = [1, 2, 3, 4, 5, 6].map((i) => `assets/faces/face${i}.png`);
const COUNT = 26;

const rand = (a, b) => a + Math.random() * (b - a);

export function createFaceSnow(canvas) {
  const ctx = canvas.getContext('2d');
  const faces = FACE_URLS.map((src) => Object.assign(new Image(), { src }));
  let flakes = [];
  let running = false;   // spawning new flakes
  let looping = false;   // animation loop alive (keeps going until the last flake has fallen)
  let last = 0;
  let w = 0;
  let h = 0;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const hadNoSize = !w || !h;
    w = window.innerWidth;
    h = window.innerHeight;
    // Started while the window had no size (e.g. minimised): spread the flakes out now.
    if (hadNoSize && w && h) for (const f of flakes) Object.assign(f, makeFlake(true), { img: f.img });
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function makeFlake(startAbove = true) {
    // Scale with the screen, so it looks the same on a phone and on a TV.
    const unit = Math.min(w, h) / 900;
    const size = rand(42, 120) * Math.max(unit, 0.55);
    return {
      img: faces[Math.floor(Math.random() * faces.length)],
      size,
      x: rand(0, w),
      y: startAbove ? rand(-h, -size) : -size,
      speed: rand(35, 75) + size * 0.35,     // bigger (closer) flakes fall a bit faster
      swayAmp: rand(15, 55),
      swayFreq: rand(0.4, 1.1),
      phase: rand(0, Math.PI * 2),
      rot: rand(-0.4, 0.4),
      rotSpeed: rand(-0.6, 0.6),
      alpha: rand(0.75, 1),
    };
  }

  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.1);  // avoid a jump after the tab was hidden
    last = now;
    ctx.clearRect(0, 0, w, h);

    for (const f of flakes) {
      f.y += f.speed * dt;
      f.phase += f.swayFreq * dt;
      f.rot += f.rotSpeed * dt;
      if (!f.img.complete || !f.img.naturalWidth) continue;
      const x = f.x + Math.sin(f.phase) * f.swayAmp;
      ctx.save();
      ctx.globalAlpha = f.alpha;
      ctx.translate(x, f.y);
      ctx.rotate(f.rot);
      ctx.drawImage(f.img, -f.size / 2, -f.size / 2, f.size, f.size);
      ctx.restore();
    }

    // Recycle flakes that left the screen; when switched off, let them fall away instead.
    flakes = flakes.flatMap((f) => (f.y - f.size > h ? (running ? [makeFlake(false)] : []) : [f]));

    if (flakes.length) requestAnimationFrame(frame);
    else {
      looping = false;
      ctx.clearRect(0, 0, w, h);
    }
  }

  function start() {
    if (running) return;
    running = true;
    resize();
    flakes.push(...Array.from({ length: COUNT - flakes.length }, () => makeFlake(true)));
    if (!looping) {
      looping = true;
      last = performance.now();
      requestAnimationFrame(frame);
    }
  }

  function stop() {
    running = false;  // existing flakes finish their fall
  }

  window.addEventListener('resize', resize);

  return {
    start,
    stop,
    get running() { return running; },
    toggle(on = !running) { (on ? start : stop)(); return running; },
  };
}
