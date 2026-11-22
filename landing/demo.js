const demo = document.querySelector('.demo');
const controls = demo.querySelector('.demo-controls');
const pins = demo.querySelector('.demo-pins');
const noteTitle = demo.querySelector('#note-title');
const noteCopy = demo.querySelector('#note-copy');
const orb = demo.querySelector('.demo-orb');
const handoff = demo.querySelector('.handoff-demo');
const copy = demo.querySelector('.copy-demo');
const terminal = demo.querySelector('.terminal');
const result = demo.querySelector('.terminal-result');
const paste = demo.querySelector('.paste-demo');
const captureScene = controls.querySelector('[data-scene="capture"]');
const revisit = controls.querySelector('[data-scene="revisit"]');
const handoffScene = controls.querySelector('[data-scene="handoff"]');
const sceneGuide = demo.querySelector('#scene-guide');
const sceneGuides = {
  capture: '框选时的画面和评注会一起保存。',
  revisit: sceneGuide.textContent,
  handoff: '复制本页评注，再把示例引用粘贴到终端。',
};
const notes = [
  '保留这段留白，标题会更容易读。',
  '保留这张海岸图，色调和本期主题一致。',
  '页尾的小字可以放大一点。',
];
let markingScene = revisit;

function setScene(button) {
  controls.querySelector('[aria-pressed="true"]').setAttribute('aria-pressed', 'false');
  button.setAttribute('aria-pressed', 'true');
  const scene = button.dataset.scene;
  const handoffOpen = scene === 'handoff';
  demo.dataset.mode = scene;
  sceneGuide.textContent = sceneGuides[scene];
  handoff.hidden = !handoffOpen;
  orb.setAttribute('aria-expanded', String(handoffOpen));
  pins.hidden = scene === 'capture';
  if (!handoffOpen) markingScene = button;
  if (scene === 'capture') {
    noteTitle.textContent = '区域评注';
    noteCopy.textContent = notes[0];
  } else if (scene === 'revisit') {
    selectPin(pins.children[Number(demo.dataset.pin)]);
  }
}

function selectPin(pin) {
  for (const button of pins.children) button.setAttribute('aria-pressed', String(button === pin));
  demo.dataset.pin = pin.dataset.pin;
  noteTitle.textContent = `评注 ${pin.textContent}`;
  noteCopy.textContent = notes[Number(pin.dataset.pin)];
}

controls.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-scene]');
  if (button) setScene(button);
});

orb.addEventListener('click', () => {
  setScene(handoff.hidden ? handoffScene : markingScene);
});

pins.addEventListener('click', (event) => {
  const pin = event.target.closest('[data-pin]');
  if (!pin) return;
  if (!handoff.hidden) setScene(revisit);
  selectPin(pin);
});

function showPastePrompt() {
  terminal.hidden = false;
  result.hidden = true;
  paste.hidden = false;
  copy.textContent = '重新复制示例';
}

copy.addEventListener('click', () => {
  showPastePrompt();
  paste.focus();
});

function showTerminalResult() {
  paste.hidden = true;
  result.hidden = false;
}

paste.addEventListener('click', () => {
  showTerminalResult();
  copy.focus();
});

demo.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !handoff.hidden) {
    setScene(markingScene);
    orb.focus();
  }
});

controls.addEventListener('keydown', (event) => {
  const buttons = [...controls.querySelectorAll('[data-scene]')];
  const index = buttons.indexOf(event.target);
  if (index < 0) return;
  const offset = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
  if (!offset) return;
  event.preventDefault();
  const next = buttons[(index + offset + buttons.length) % buttons.length];
  setScene(next);
  next.focus();
});

const mascotStage = document.querySelector('.mascot-stage');
const motionAllowed = matchMedia('(prefers-reduced-motion: no-preference)');
mascotStage.addEventListener('pointermove', (event) => {
  if (event.pointerType !== 'mouse' || !motionAllowed.matches) return;
  const { left, top, width, height } = mascotStage.getBoundingClientRect();
  mascotStage.style.setProperty('--tilt-x', `${(0.5 - (event.clientY - top) / height) * 14}deg`);
  mascotStage.style.setProperty('--tilt-y', `${((event.clientX - left) / width - 0.5) * 16}deg`);
});
mascotStage.addEventListener('pointerleave', () => {
  mascotStage.style.removeProperty('--tilt-x');
  mascotStage.style.removeProperty('--tilt-y');
});

if (motionAllowed.matches) {
  const cues = [
    [1200, () => setScene(captureScene)],
    [3100, () => { setScene(revisit); selectPin(pins.children[1]); }],
    [5100, () => setScene(handoffScene)],
    [6400, showPastePrompt],
    [7800, showTerminalResult],
    [10400, () => setScene(revisit)],
  ];
  const timers = [];
  let started = false;
  function stopPreview() {
    for (const timer of timers) clearTimeout(timer);
    delete demo.dataset.playing;
    observer.disconnect();
  }
  const observer = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) {
      if (started) stopPreview();
      return;
    }
    if (started) return;
    started = true;
    for (const [delay, cue] of cues) {
      timers.push(setTimeout(() => {
        demo.dataset.playing = 'true';
        cue();
      }, delay));
    }
    timers.push(setTimeout(stopPreview, 10400));
  }, { threshold: 0.35 });

  for (const type of ['pointerdown', 'focusin']) {
    demo.addEventListener(type, stopPreview, { once: true });
  }
  motionAllowed.addEventListener('change', stopPreview, { once: true });
  observer.observe(demo);
}

const storyLines = document.querySelectorAll('.story-line');
let readingLine = storyLines[0];
let readingFrame = null;

function updateReadingLine() {
  readingFrame = null;
  const top = window.innerHeight * 0.28;
  const bottom = window.innerHeight * 0.57;
  const middle = (top + bottom) / 2;
  let nearest = null;
  let distance = Infinity;

  for (const line of storyLines) {
    const bounds = line.getBoundingClientRect();
    if (bounds.bottom <= top || bounds.top >= bottom) continue;
    const offset = Math.abs((bounds.top + bounds.bottom) / 2 - middle);
    if (offset < distance) {
      nearest = line;
      distance = offset;
    }
  }

  if (nearest && nearest !== readingLine) {
    readingLine.classList.remove('is-current');
    nearest.classList.add('is-current');
    readingLine = nearest;
  }
}

function scheduleReadingUpdate() {
  if (readingFrame === null) readingFrame = requestAnimationFrame(updateReadingLine);
}

window.addEventListener('scroll', scheduleReadingUpdate, { passive: true });
window.addEventListener('resize', scheduleReadingUpdate);
scheduleReadingUpdate();
