/* ===== Animator state ===== */
let steps       = [];
let currentStep = 0;
let isPlaying   = false;
let playTimer   = null;
let prevVars    = {};
let prevOutput  = [];

/* ===== Timing constants ===== */
const BALL_DELAY    = 200;  // ms: pause between line highlight and ball launch
const BALL_FLY_MS   = 480;  // ms: matches GSAP DURATION (0.45s) + small buffer
const NO_BALL_PAUSE = 250;  // ms: pause when step has no changes (no ball fires)

/* ===== DOM refs ===== */
const memoryBody  = document.getElementById('memory-body');
const consoleBody = document.getElementById('console-body');
const stepCurrent = document.getElementById('step-current');
const stepTotal   = document.getElementById('step-total');
const ctrlFirst   = document.getElementById('ctrl-first');
const ctrlPrev    = document.getElementById('ctrl-prev');
const ctrlPlay    = document.getElementById('ctrl-play');
const ctrlNext    = document.getElementById('ctrl-next');
const ctrlLast    = document.getElementById('ctrl-last');
const speedSelect    = document.getElementById('speed-select');
const ballLayer      = document.getElementById('ball-layer');
const consoleAnchor  = document.getElementById('console-anchor'); // ghost target for console ball

/* ===== Init ===== */
function startAnimation(stepsData, errorData) {
  steps = stepsData;
  currentStep = stepsData.length; // set beyond end so togglePlay triggers restart from step 0
  prevVars = {};
  prevOutput = [];
  isPlaying = false;

  stepTotal.textContent = stepsData.length;
  clearPanels();
  updateControls();

  togglePlay();
}

function stopAnimation() {
  clearTimeout(playTimer);
  isPlaying = false;
  updatePlayBtn();
}

/* ===== Render step ===== */
// Highlights the line, updates panels, calls onDone immediately.
// Ball logic lives in scheduleNextStep so balls fire while the current line is still highlighted.
function renderStep(index, onDone) {
  if (index < 0 || index >= steps.length) return;

  const step = steps[index];
  currentStep = index;
  stepCurrent.textContent = index + 1;

  setActiveLine(step.line);

  const newVars   = step.variables || {};
  const newOutput = step.output    || [];

  const changedVars = [];
  for (const k of Object.keys(newVars)) {
    if (JSON.stringify(newVars[k]) !== JSON.stringify(prevVars[k])) changedVars.push(k);
  }
  const newLines = newOutput.slice(prevOutput.length);

  renderMemory(newVars, changedVars);
  renderConsole(newOutput, newLines.length);
  prevVars   = { ...newVars };
  prevOutput = [...newOutput];
  updateControls();

  if (onDone) onDone();
}

/* ===== Memory panel ===== */
function renderMemory(vars, changedKeys) {
  const keys = Object.keys(vars);
  if (keys.length === 0) {
    memoryBody.innerHTML = '<span class="empty-hint">Переменных пока нет</span>';
    return;
  }
  memoryBody.innerHTML = '';
  for (const k of keys) {
    const card = document.createElement('div');
    card.className = 'var-card' + (changedKeys.includes(k) ? ' changed' : '');
    card.dataset.varName = k;

    const nameEl = document.createElement('div');
    nameEl.className = 'var-name';
    nameEl.textContent = k;

    const valEl = document.createElement('div');
    const displayVal = formatValue(vars[k]);
    valEl.className = 'var-value' + (displayVal.length > 8 ? ' long' : '');
    valEl.textContent = displayVal;

    card.appendChild(nameEl);
    card.appendChild(valEl);
    memoryBody.appendChild(card);
  }
}

function formatValue(v) {
  if (v === null) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') return `"${v}"`;
  if (Array.isArray(v)) return '[' + v.map(formatValue).join(', ') + ']';
  if (typeof v === 'object') {
    const entries = Object.entries(v).map(([k, val]) => `${k}: ${formatValue(val)}`);
    return '{' + entries.join(', ') + '}';
  }
  return String(v);
}

/* ===== Console panel ===== */
function renderConsole(output, newCount) {
  if (output.length === 0) {
    consoleBody.innerHTML = '<span class="empty-hint">Вывода пока нет</span>';
    consoleBody.appendChild(consoleAnchor); // restore anchor after innerHTML wipe
    return;
  }
  const existingLines = consoleBody.querySelectorAll('.console-line').length;
  if (existingLines === 0) {
    consoleBody.innerHTML = ''; // anchor removed here — re-appended below
  }

  // Add only new lines
  const startIdx = consoleBody.querySelectorAll('.console-line').length;
  for (let i = startIdx; i < output.length; i++) {
    const line = document.createElement('div');
    line.className = 'console-line' + (i >= output.length - newCount ? ' new' : '');
    line.textContent = output[i];
    consoleBody.appendChild(line);
  }

  consoleBody.appendChild(consoleAnchor); // anchor always stays at the end
}

function clearPanelsUI() {
  memoryBody.innerHTML  = '<span class="empty-hint">Переменных пока нет</span>';
  consoleBody.innerHTML = '<span class="empty-hint">Вывода пока нет</span>';
  consoleBody.appendChild(consoleAnchor); // restore anchor after innerHTML wipe
}

function clearPanels() {
  clearPanelsUI();
  prevVars = {};
  prevOutput = [];
}

/* ===== Ball animation ===== */
function animateBall(fromEl, toEl, color, onComplete) {
  if (!fromEl || !toEl) return;

  const fromRect = fromEl.getBoundingClientRect();
  const toRect   = toEl.getBoundingClientRect();

  const startX = fromRect.right;
  const startY = fromRect.top + fromRect.height / 2;
  const endX   = toRect.left + toRect.width / 2;
  const endY   = toRect.top  + toRect.height / 2;

  const DURATION = 0.45;

  // Main ball
  const ball = document.createElement('div');
  ball.className = 'anim-ball';
  Object.assign(ball.style, {
    width: '14px', height: '14px',
    left:  startX + 'px',
    top:   (startY - 7) + 'px',
    background: color,
    boxShadow: `0 0 8px ${color}80`,
  });
  ballLayer.appendChild(ball);

  gsap.to(ball, {
    left: endX - 7,
    top:  endY - 7,
    duration: DURATION,
    ease: 'power2.inOut',
    onComplete: () => {
      if (onComplete) onComplete(); // notify caller that ball has landed
      gsap.to(ball, {
        scale: 0, opacity: 0, duration: 0.2,
        onComplete: () => ball.remove(),
      });
    },
  });

  // Trail dots (3 dots following with delay)
  for (let i = 1; i <= 3; i++) {
    const dot = document.createElement('div');
    dot.className = 'anim-trail';
    const size = 14 - i * 3;
    Object.assign(dot.style, {
      width:  size + 'px',
      height: size + 'px',
      left:   startX + 'px',
      top:    (startY - size / 2) + 'px',
      background: color,
      opacity: (0.4 - i * 0.1).toFixed(2),
    });
    ballLayer.appendChild(dot);

    gsap.to(dot, {
      left: endX - size / 2,
      top:  endY - size / 2,
      duration: DURATION,
      delay: i * 0.06,
      ease: 'power2.inOut',
      onComplete: () => {
        gsap.to(dot, {
          scale: 0, opacity: 0, duration: 0.15,
          onComplete: () => dot.remove(),
        });
      },
    });
  }
}

/* ===== Playback controls ===== */
function stepNext() {
  if (currentStep < steps.length - 1) renderStep(currentStep + 1);
  else stopAnimation();
}
function stepPrev() {
  if (currentStep > 0) {
    clearPanelsUI();
    prevVars   = currentStep > 1 ? (steps[currentStep - 2].variables || {}) : {};
    prevOutput = currentStep > 1 ? (steps[currentStep - 2].output    || []) : [];
    renderStep(currentStep - 1);
  }
}

function scheduleNextStep() {
  if (!isPlaying) return;
  if (currentStep >= steps.length - 1) { stopAnimation(); return; }

  const curIdx    = currentStep;
  const nextIdx   = currentStep + 1;
  const curStep   = steps[curIdx];
  const nextStep  = steps[nextIdx];

  // Look ahead: what will the CURRENT highlighted line produce?
  const curVars    = curStep.variables  || {};
  const nextVars   = nextStep.variables || {};
  const curOutput  = curStep.output     || [];
  const nextOutput = nextStep.output    || [];

  const changedVars = Object.keys(nextVars).filter(
    k => JSON.stringify(nextVars[k]) !== JSON.stringify(curVars[k])
  );
  const newLines = nextOutput.slice(curOutput.length);

  const ballSrcEl = document.querySelector(`.code-line[data-line="${curStep.line}"]`);
  const hasMem    = changedVars.length > 0 && ballSrcEl;
  const hasCon    = newLines.length > 0    && ballSrcEl;
  const ballCount = (hasMem ? 1 : 0) + (hasCon ? 1 : 0);

  const postPause = parseInt(speedSelect.value, 10);

  if (ballCount === 0) {
    // No changes from current line: short pause then highlight next line
    playTimer = setTimeout(() => renderStep(nextIdx, scheduleNextStep), NO_BALL_PAUSE);
    return;
  }

  // Fire ball(s) from the CURRENTLY HIGHLIGHTED line after BALL_DELAY
  playTimer = setTimeout(() => {
    let landed = 0;
    const onBallLand = () => {
      landed++;
      if (landed < ballCount) return;

      // Update panels when ball(s) land — while current line is still highlighted
      renderMemory(nextVars, changedVars);
      renderConsole(nextOutput, newLines.length);
      prevVars   = { ...nextVars };
      prevOutput = [...nextOutput];

      // After postPause: highlight the NEXT line (panels already show new data)
      playTimer = setTimeout(() => {
        if (!isPlaying) return;
        renderStep(nextIdx, scheduleNextStep);
      }, postPause);
    };

    if (hasMem) {
      const varCard = memoryBody.querySelector(`[data-var-name="${changedVars[0]}"]`)
                      || document.getElementById('memory-panel');
      animateBall(ballSrcEl, varCard, '#4F7EF7', onBallLand);
    }
    if (hasCon) {
      const conTarget = consoleAnchor || document.getElementById('console-panel');
      setTimeout(() => animateBall(ballSrcEl, conTarget, '#059669', onBallLand), hasMem ? 100 : 0);
    }
  }, BALL_DELAY);
}

function togglePlay() {
  if (isPlaying) {
    clearTimeout(playTimer);
    isPlaying = false;
    updatePlayBtn();
    return;
  }

  isPlaying = true;
  updatePlayBtn();

  if (currentStep >= steps.length - 1) {
    // Restart: reset state, render step 0, then immediately start the chain
    prevVars = {};
    prevOutput = [];
    clearPanels();
    renderStep(0, scheduleNextStep);
  } else {
    scheduleNextStep();
  }
}

function updatePlayBtn() {
  ctrlPlay.textContent = isPlaying ? '⏸' : '▶';
}

function updateControls() {
  ctrlFirst.disabled = currentStep === 0;
  ctrlPrev.disabled  = currentStep === 0;
  ctrlNext.disabled  = currentStep >= steps.length - 1;
  ctrlLast.disabled  = currentStep >= steps.length - 1;
  updatePlayBtn();
}

/* ===== Control listeners ===== */
ctrlFirst.addEventListener('click', () => {
  stopAnimation();
  prevVars = {};
  prevOutput = [];
  clearPanels();
  renderStep(0);
});
ctrlPrev.addEventListener('click', () => { stopAnimation(); stepPrev(); });
ctrlPlay.addEventListener('click', togglePlay);
ctrlNext.addEventListener('click', () => { stopAnimation(); stepNext(); });
ctrlLast.addEventListener('click', () => {
  stopAnimation();
  // Fast-forward: rebuild from scratch
  prevVars = {};
  prevOutput = [];
  clearPanels();
  // Render all intermediate steps silently, then show last
  const last = steps.length - 1;
  prevVars   = last > 0 ? (steps[last - 1].variables || {}) : {};
  prevOutput = last > 0 ? (steps[last - 1].output    || []) : [];
  renderStep(last);
});
// Speed change takes effect automatically: scheduleNextStep reads speedSelect.value each call
