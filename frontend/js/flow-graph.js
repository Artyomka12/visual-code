/* ===== Flow Graph — Experimental Mode ===== */

/* --- Layout constants (JS source of truth; CSS mirrors these) --- */
const FG_NODE_W   = 160;
const FG_NODE_H   = 80;
const FG_GAP_X    = 60;
const FG_CENTER_Y = 130;
const FG_TOKEN_W  = 100;
const FG_TOKEN_H  = 32;

/* ===================================================
   Node type registry
   To add a future node type (LoopNode, ConditionNode…):
     1. Add an entry here.
     2. Emit an op with that type from parseOps().
   No other changes needed.
   =================================================== */
const FG_NODE_TYPES = {
  assignment: {
    typeLabel: 'ASSIGN',
    makeLabel: (op) => `${op.varName} = ${fgFmtVal(op.value)}`,
  },
  compute: {
    typeLabel: 'COMPUTE',
    // expression is stored as a plain string (e.g. "x + 2"); future work can
    // replace it with an AST to support nested/grouped expressions.
    makeLabel: (op) => `${op.target} = ${op.expression}`,
  },
  print: {
    typeLabel: 'PRINT',
    makeLabel: (op) => op.label,
  },
  console: {
    typeLabel: 'CONSOLE',
    makeLabel: (_op) => '', // content filled at runtime by revealConsole()
  },
  loop: {
    typeLabel: 'LOOP',
    makeLabel: (op) => `${op.variable} : ${op.start} → ${op.end}`,
  },
  // Reserved for future:
  // condition: { typeLabel: 'IF',        makeLabel: (op) => ... },
  // function:  { typeLabel: 'CALL',      makeLabel: (op) => ... },
};

/* --- Accent colors per node type (add entry here for each new type) --- */
const FG_COLORS = {
  assignment: { border:'#2D5CB8', glow:'rgba(79,126,247,0.55)', outer:'rgba(79,126,247,0.20)', pulse:'#3B6FD4' },
  compute:    { border:'#92400E', glow:'rgba(245,158,11,0.45)', outer:'rgba(245,158,11,0.18)', pulse:'#F59E0B' },
  print:      { border:'#176A42', glow:'rgba(34,197,94,0.45)',  outer:'rgba(34,197,94,0.18)',  pulse:'#22C55E' },
  console:    { border:'#5B35A8', glow:'rgba(139,92,246,0.45)', outer:'rgba(139,92,246,0.18)', pulse:'#8B5CF6' },
  loop:       { border:'#0E7490', glow:'rgba(6,182,212,0.50)',  outer:'rgba(6,182,212,0.18)',  pulse:'#06B6D4' },
};
function fgColors(type) { return FG_COLORS[type] || FG_COLORS.assignment; }

/* Detects binary arithmetic: var = operand OP operand
   At least one operand must be a variable name (starts with a letter) so that
   pure-literal expressions like "y = 5 + 3" are treated as plain assignments.
   Supports all four arithmetic operators. Future work: extend to support
   parenthesised and multi-operator expressions at the AST level. */
const BINARY_ASSIGN_RE = /^(\w+)\s*=\s*(\w+|\d+\.?\d*)\s*([-+*/])\s*(\w+|\d+\.?\d*)\s*$/;
const FOR_RANGE_RE     = /^for\s+(\w+)\s+in\s+range\s*\(\s*(\d+)\s*\)\s*:/;

/* ===== DOM refs ===== */
const fgView    = document.getElementById('flow-graph-view');
const fgCanvas  = document.getElementById('fg-canvas-wrap');
const fgNodesEl = document.getElementById('fg-nodes');
const fgArrowEl = document.getElementById('fg-arrows');
const fgTokEl   = document.getElementById('fg-tokens');
const fgBackBtn = document.getElementById('fg-back-btn');
const fgTitleEl = document.getElementById('fg-title');

let fgTimers  = [];
const fgNodeReg = new Map(); // nodeId → { el, node }

/* ===== Back button ===== */
fgBackBtn.addEventListener('click', () => {
  stopFlowAnimation();
  fgView.classList.remove('active');
  document.getElementById('input-view').classList.add('active');
});

/* ===================================================
   STEP 1 — parseOps
   Converts execution steps into an ordered list of
   abstract operations. This is the only place that
   reads execution steps. All other functions work
   purely on ops/nodes/edges/tokens.

   sourceLines: source code split by '\n', 0-indexed.
   Used to distinguish compute ops from simple assignments.
   =================================================== */
function parseOps(steps, sourceLines = []) {
  const ops = [];
  let prevVars = {}, prevOutput = [], prevLineIdx = 0;

  // Pre-scan: detect for-range loops and their body line numbers.
  // sourceLines must be the ORIGINAL (non-trimmed) lines for indentation detection.
  // loopInfo[varName] = { end, emitted, op, printLabel }
  const loopInfo        = {};
  const loopBodyLineNums = new Set(); // 1-based line numbers that are loop body lines

  sourceLines.forEach((line, i) => {
    const m = FOR_RANGE_RE.exec(line.trim());
    if (m) {
      loopInfo[m[1]] = { end: parseInt(m[2]), emitted: false, op: null, printLabel: null };
      const forIndent = line.length - line.trimStart().length;
      for (let j = i + 1; j < sourceLines.length; j++) {
        const bl = sourceLines[j];
        if (bl.trim() === '') continue;
        if (bl.length - bl.trimStart().length > forIndent) {
          loopBodyLineNums.add(j + 1); // 1-based
        } else {
          break;
        }
      }
    }
  });

  // Return the most recently emitted loop op (if any).
  const activeLoop = () => Object.values(loopInfo).find(li => li.emitted && li.op) || null;

  for (const step of steps) {
    if ((step.event || 'line') !== 'line') continue;

    const vars       = step.variables || {};
    const output     = step.output    || [];
    // prevLineIdx = the line that JUST RAN (producing current vars state).
    const isBodyLine = loopBodyLineNums.has(prevLineIdx);
    const sourceLine = (sourceLines[prevLineIdx - 1] || '').trim();

    // Detect variable changes
    for (const [k, v] of Object.entries(vars)) {
      if (JSON.stringify(v) !== JSON.stringify(prevVars[k])) {
        if (loopInfo[k]) {
          // Loop variable: emit one loop op on first encounter; suppress all others.
          if (!loopInfo[k].emitted) {
            const loopOp = {
              type: 'loop', variable: k, start: 0, end: loopInfo[k].end,
              outputs: [], bodyOps: [],
            };
            loopInfo[k].op      = loopOp;
            loopInfo[k].emitted = true;
            ops.push(loopOp);
          }
        } else if (isBodyLine) {
          // Variable changed on a loop body line → it's a body op, not a standalone op.
          const li = activeLoop();
          if (li) {
            let bodyOp = li.op.bodyOps.find(bo => bo.target === k);
            if (!bodyOp) {
              const m   = BINARY_ASSIGN_RE.exec(sourceLine);
              const expr = (m && m[1] === k) ? `${m[2]} ${m[3]} ${m[4]}` : k;
              bodyOp = { type: 'compute', target: k, expression: expr, values: [] };
              li.op.bodyOps.push(bodyOp);
            }
            bodyOp.values.push(v);
          } else {
            // Body line but no active loop (shouldn't happen, fall back to normal)
            ops.push({ type: 'assignment', varName: k, value: v });
          }
        } else {
          // Normal variable change (pre-loop or post-loop)
          const m = BINARY_ASSIGN_RE.exec(sourceLine);
          const isCompute = m && m[1] === k &&
            (/^[a-zA-Z_]/.test(m[2]) || /^[a-zA-Z_]/.test(m[4]));
          if (isCompute) {
            ops.push({ type: 'compute', target: k, value: v, expression: `${m[2]} ${m[3]} ${m[4]}` });
          } else {
            ops.push({ type: 'assignment', varName: k, value: v });
          }
        }
      }
    }

    // Detect print() outputs (output buffer grew)
    const newLines = output.slice(prevOutput.length);
    for (const line of newLines) {
      const matchEntry = Object.entries(vars).find(([, v]) => String(v) === line);
      const printLabel = matchEntry ? `print(${matchEntry[0]})` : 'print(…)';

      if (matchEntry && loopInfo[matchEntry[0]]) {
        // Print of a loop variable — accumulate in the loop op; don't emit a separate op.
        const li = loopInfo[matchEntry[0]];
        if (li.op) li.op.outputs.push(line);
        if (!li.printLabel) li.printLabel = printLabel;
      } else {
        ops.push({ type: 'print', label: printLabel, text: line });
      }
    }

    prevVars    = { ...vars };
    prevOutput  = [...output];
    prevLineIdx = step.line || prevLineIdx;
  }

  // Post-pass: insert one PRINT node op right after each loop op that has body outputs.
  const finalOps = [];
  for (const op of ops) {
    finalOps.push(op);
    if (op.type === 'loop' && op.outputs.length > 0) {
      const li = Object.values(loopInfo).find(l => l.op === op);
      finalOps.push({
        type:       'print',
        label:      li?.printLabel || `print(${op.variable})`,
        text:       null,
        isLoopBody: true,
      });
    }
  }

  return finalOps;
}

/* ===================================================
   STEP 2 — buildNodes
   Creates one FlowNode per op plus a shared Console
   node at the end (if any prints exist).
   Positions are computed here; no hardcoded coords.
   =================================================== */
function buildNodes(expandedOps, canvasW) {
  const hasPrints  = expandedOps.some(o => o.type === 'print');
  const totalCount = expandedOps.length + (hasPrints ? 1 : 0);

  const totalW = totalCount * FG_NODE_W + Math.max(0, totalCount - 1) * FG_GAP_X;
  let curX     = Math.max(40, Math.round((canvasW - totalW) / 2));

  const nodes = [];

  expandedOps.forEach((op, i) => {
    const typeDef = FG_NODE_TYPES[op.type] || FG_NODE_TYPES.assignment;
    nodes.push({
      id:    `node_${i}`,
      type:  op.type,
      label: typeDef.makeLabel(op),
      x:     curX,
      y:     FG_CENTER_Y,
      _op:   op,
    });
    curX += FG_NODE_W + FG_GAP_X;
  });

  if (hasPrints) {
    nodes.push({
      id:    'node_console',
      type:  'console',
      label: '',
      x:     curX,
      y:     FG_CENTER_Y,
      _op:   { type: 'console' },
    });
  }

  return nodes;
}

/* ===================================================
   STEP 3 — buildEdges
   Linear chain: node[0] → node[1] → … → node[n]
   Replace this function to get a different topology
   (tree, DAG, etc.) in the future.
   =================================================== */
function buildEdges(nodes) {
  const edges = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push({ id: `e_${i}`, from: nodes[i].id, to: nodes[i + 1].id });
  }
  return edges;
}

/* ===================================================
   STEP 4 — buildTokens
   One DataToken per assignment op.
   Each token carries the cumulative console output
   that should be revealed when it arrives at Console.
   =================================================== */
function buildTokens(ops, nodes) {
  const tokens    = [];
  const consoleId = nodes.find(n => n.type === 'console')?.id;

  // Map op object references → node.id.
  // This works because expandLoopBodyOps pushes the same object references,
  // and buildNodes stores node._op = that same object.
  const opToNodeId = new Map();
  for (const node of nodes) {
    if (node._op) opToNodeId.set(node._op, node.id);
  }

  // Collect all output texts in order (loop outputs first, then regular prints).
  const allPrintTexts = [];
  for (const op of ops) {
    if (op.type === 'loop'  && op.outputs)           allPrintTexts.push(...op.outputs);
    else if (op.type === 'print' && op.text != null) allPrintTexts.push(op.text);
  }

  const assignCount   = ops.filter(o => o.type === 'assignment').length;
  let tokenIdx        = 0;
  let printIdx        = 0;
  let loopPrintOffset = 0;

  ops.forEach((op, i) => {
    const startNodeId = opToNodeId.get(op) || `node_${i}`;

    if (op.type === 'assignment') {
      const label  = FG_NODE_TYPES.assignment.makeLabel(op);
      const isLast = (++tokenIdx === assignCount);
      const consoleLines = isLast
        ? [...allPrintTexts]
        : allPrintTexts.slice(0, Math.min(++printIdx, allPrintTexts.length));
      tokens.push({
        id:            `tok_${i}`,
        label,
        startNodeId,
        consoleNodeId: consoleId,
        consoleLines,
        currentVar:    op.varName,
      });

    } else if (op.type === 'loop' && op.outputs && op.outputs.length > 0) {
      // for i in range(N): print(i) — one iteration token per loop pass.
      const { variable, start, end, outputs } = op;
      for (let iter = 0; iter < end - start; iter++) {
        tokens.push({
          id:            `tok_loop_${i}_${iter}`,
          label:         `${variable} = ${start + iter}`,
          startNodeId,
          consoleNodeId: consoleId,
          consoleLines:  allPrintTexts.slice(0, loopPrintOffset + iter + 1),
          currentVar:    variable,
          iterValue:     start + iter,
        });
      }
      loopPrintOffset += outputs.length;
    }
    // Loops with bodyOps (no outputs) don't generate their own tokens;
    // the preceding assignment token travels through the loop node.
  });

  return tokens;
}

/* Expands loop ops that have bodyOps into a flat list:
   loop op → loop op + body compute op(s)
   This drives buildNodes so each body op gets its own graph node. */
function expandLoopBodyOps(ops) {
  const result = [];
  for (const op of ops) {
    result.push(op);
    if (op.type === 'loop' && op.bodyOps && op.bodyOps.length > 0) {
      for (const bodyOp of op.bodyOps) result.push(bodyOp);
    }
  }
  return result;
}

/* ===================================================
   PUBLIC: buildFlowGraph — single entry for graph data
   =================================================== */
function buildFlowGraph(steps, sourceCode = '') {
  const canvasW     = fgCanvas.offsetWidth || 900;
  // Keep original (non-trimmed) lines so parseOps can detect indentation.
  const sourceLines = sourceCode.split('\n');
  const ops         = parseOps(steps, sourceLines);
  if (ops.length === 0) return { nodes: [], edges: [], tokens: [] };

  // Expand loop body ops into a flat sequence for node creation.
  const expandedOps = expandLoopBodyOps(ops);
  const nodes       = buildNodes(expandedOps, canvasW);
  const edges       = buildEdges(nodes);
  const tokens      = buildTokens(ops, nodes);

  return { nodes, edges, tokens };
}

function fgFmtVal(v) {
  if (v === null)            return 'None';
  if (v === true)            return 'True';
  if (v === false)           return 'False';
  if (typeof v === 'string') return `"${v}"`;
  if (Array.isArray(v))      return '[…]';
  if (typeof v === 'object') return '{…}';
  return String(v);
}

/* ===================================================
   Renderer
   =================================================== */
function renderFlowGraph(graph) {
  fgNodesEl.innerHTML = '';
  fgArrowEl.innerHTML = '';
  fgTokEl.innerHTML   = '';
  fgNodeReg.clear();

  const { nodes, edges } = graph;

  // Expand canvas to fit content (allows scroll when needed)
  if (nodes.length > 0) {
    const maxR = Math.max(...nodes.map(n => n.x + FG_NODE_W)) + 60;
    const maxB = Math.max(...nodes.map(n => n.y + FG_NODE_H)) + 100;
    fgCanvas.style.minWidth  = maxR + 'px';
    fgCanvas.style.minHeight = Math.max(340, maxB) + 'px';
  }

  /* --- Nodes --- */
  nodes.forEach((node, i) => {
    const isConsole = node.type === 'console';
    const c         = fgColors(node.type);
    const typeDef   = FG_NODE_TYPES[node.type] || FG_NODE_TYPES.assignment;

    const el = document.createElement('div');
    el.className = `fg-node fg-node--${node.type}`;
    el.id = `fn-${node.id}`;
    // Sizes driven by JS constants (CSS has matching defaults)
    el.style.left   = node.x   + 'px';
    el.style.top    = node.y   + 'px';
    el.style.width  = FG_NODE_W + 'px';

    el.innerHTML = `
      <div class="fg-node-header">
        <span class="fg-node-type">${typeDef.typeLabel}</span>
        <span class="fg-node-dot" style="background:${c.pulse}"></span>
      </div>
      <div class="fg-node-label${isConsole ? ' fg-console-output' : ''}"
           ${isConsole ? 'style="opacity:0"' : ''}>
        ${isConsole ? '' : fgEsc(node.label)}
      </div>`;

    fgNodesEl.appendChild(el);
    fgNodeReg.set(node.id, { el, node });

    // Staggered entrance
    gsap.from(el, {
      opacity: 0, scale: 0.85, y: 8,
      duration: 0.28, ease: 'back.out(1.6)',
      delay: 0.04 + i * 0.055,
    });
  });

  /* --- SVG Arrows --- */
  const svgNS   = 'http://www.w3.org/2000/svg';
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  const defs = document.createElementNS(svgNS, 'defs');
  defs.innerHTML = `
    <marker id="fga-head" markerWidth="9" markerHeight="7"
            refX="8" refY="3.5" orient="auto">
      <polygon points="0 0,9 3.5,0 7" fill="#3B6FD4"/>
    </marker>`;
  fgArrowEl.appendChild(defs);

  for (const edge of edges) {
    const fn = nodeMap.get(edge.from);
    const tn = nodeMap.get(edge.to);
    if (!fn || !tn) continue;

    const x1 = fn.x + FG_NODE_W;
    const y1 = fn.y + FG_NODE_H / 2;
    const x2 = tn.x;
    const y2 = tn.y + FG_NODE_H / 2;
    const mx = (x1 + x2) / 2;
    const d  = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;

    // Glow layer
    const glow = document.createElementNS(svgNS, 'path');
    glow.setAttribute('d', d);
    glow.setAttribute('stroke', '#3B6FD4');
    glow.setAttribute('stroke-width', '4');
    glow.setAttribute('stroke-opacity', '0.15');
    glow.setAttribute('fill', 'none');
    fgArrowEl.appendChild(glow);

    // Main line
    const line = document.createElementNS(svgNS, 'path');
    line.setAttribute('d', d);
    line.setAttribute('stroke', '#2D5CB8');
    line.setAttribute('stroke-width', '2');
    line.setAttribute('stroke-opacity', '0.75');
    line.setAttribute('fill', 'none');
    line.setAttribute('marker-end', 'url(#fga-head)');
    fgArrowEl.appendChild(line);
  }
}

function fgEsc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ===================================================
   Lit effect — GSAP-animated glow (generic, works for
   any node type present in FG_COLORS)
   =================================================== */
function litNode(nodeId) {
  const entry = fgNodeReg.get(nodeId);
  if (!entry) return;
  const c = fgColors(entry.node.type);
  gsap.killTweensOf(entry.el, 'boxShadow');
  gsap.to(entry.el, {
    boxShadow: `0 0 0 2px ${c.border}, 0 0 22px ${c.glow}, 0 0 48px ${c.outer}`,
    duration: 0.18, ease: 'power2.out',
    onComplete: () => {
      gsap.to(entry.el, { boxShadow: 'none', duration: 0.65, ease: 'power2.in' });
    },
  });
}

/* ===================================================
   Pulse — expanding ring on departure (generic)
   =================================================== */
function pulseNode(nodeId) {
  const entry = fgNodeReg.get(nodeId);
  if (!entry) return;
  const c = fgColors(entry.node.type);

  const pulse = document.createElement('div');
  pulse.className = 'fg-pulse';
  Object.assign(pulse.style, {
    left:        entry.node.x + 'px',
    top:         entry.node.y + 'px',
    width:       FG_NODE_W + 'px',
    height:      FG_NODE_H + 'px',
    borderColor: c.pulse,
  });
  fgNodesEl.appendChild(pulse);

  gsap.fromTo(pulse,
    { scale: 1, opacity: 0.65 },
    { scale: 1.5, opacity: 0, duration: 0.52, ease: 'power2.out',
      onComplete: () => pulse.remove() }
  );
}

/* ===================================================
   Console: accumulates output lines one by one.
   Each call adds ONLY the new lines since last call.
   =================================================== */
function revealConsole(consoleNodeId, lines) {
  const entry = fgNodeReg.get(consoleNodeId);
  if (!entry) return;

  const outEl = entry.el.querySelector('.fg-console-output');
  if (!outEl) return;

  // Make container visible on first call
  if (parseFloat(getComputedStyle(outEl).opacity) < 0.5) {
    gsap.set(outEl, { opacity: 1 });
  }

  // Append only new lines
  const existing = outEl.querySelectorAll('.fg-console-line').length;
  const newLines  = lines.slice(existing);

  newLines.forEach((text, i) => {
    const lineEl = document.createElement('div');
    lineEl.className   = 'fg-console-line';
    lineEl.textContent = text;
    outEl.appendChild(lineEl);
    gsap.fromTo(lineEl,
      { opacity: 0, y: 5 },
      { opacity: 1, y: 0, duration: 0.32, ease: 'power2.out', delay: 0.06 + i * 0.08 }
    );
  });
}

/* ===================================================
   Loop body animation — Variant B (no physical back-arrow).
   When a token arrives at a LOOP node that has bodyOps,
   this function runs N iterations:
     each: LOOP highlights i=k → token slides to COMPUTE → in-place
           transform → token snaps back to LOOP (instant)
   After the last iteration the token stays at COMPUTE and
   walkPath continues from there.
   =================================================== */
function animateLoopIterations(el, loopNode, path, nodeMap, curIdx, token, onComplete) {
  const loopOp = loopNode._op;
  const bodyOp = loopOp.bodyOps && loopOp.bodyOps[0];
  const N      = loopOp.end - loopOp.start;

  // Fall through if no body ops (shouldn't happen in practice)
  if (!bodyOp || N === 0) {
    walkPath(el, path, nodeMap, curIdx, token, onComplete);
    return;
  }

  // path[curIdx] = LOOP; path[curIdx+1] = COMPUTE body node
  const computeId   = path[curIdx + 1];
  const computeNode = nodeMap.get(computeId);
  if (!computeNode) { if (onComplete) onComplete(); return; }

  function runIteration(iter) {
    if (iter >= N) {
      // All iterations finished; token is at COMPUTE → continue along path
      walkPath(el, path, nodeMap, curIdx + 1, token, onComplete);
      return;
    }

    highlightLoopIteration(loopNode.id, loopOp.start + iter);
    pulseNode(loopNode.id);

    gsap.to(el, {
      left: tokenLeft(computeNode), top: tokenTop(computeNode),
      duration: 0.52, delay: 0.08, ease: 'power2.inOut',
      onComplete: () => {
        litNode(computeId);

        const newLabel = `${bodyOp.target} = ${fgFmtVal(bodyOp.values[iter])}`;

        // Squish → swap text → bounce (in-place self-update animation)
        gsap.to(el, {
          scale: 0.72, duration: 0.16, ease: 'power2.in',
          onComplete: () => {
            el.textContent = `[ ${newLabel} ]`;
            token.currentVar = bodyOp.target;

            // Bounce back to full size
            gsap.to(el, {
              scale: 1, duration: 0.26, ease: 'back.out(1.9)',
              onComplete: () => {
                if (iter < N - 1) {
                  // Snap token back to LOOP position (instant) then run next iteration
                  const t = setTimeout(() => {
                    gsap.set(el, { left: tokenLeft(loopNode), top: tokenTop(loopNode) });
                    runIteration(iter + 1);
                  }, 220);
                  fgTimers.push(t);
                } else {
                  // Last iteration: continue forward
                  runIteration(N);
                }
              },
            });
            // Amber glow in parallel with the bounce
            gsap.fromTo(el,
              { boxShadow: '0 0 0 2px rgba(245,158,11,0.9), 0 0 20px rgba(245,158,11,0.55)' },
              { boxShadow: 'none', duration: 0.50, ease: 'power2.out' }
            );
          },
        });
      },
    });
  }

  runIteration(0);
}

/* Updates the LoopNode label to show which iteration is currently running. */
function highlightLoopIteration(nodeId, iterVal) {
  const entry = fgNodeReg.get(nodeId);
  if (!entry || entry.node.type !== 'loop') return;
  const labelEl = entry.el.querySelector('.fg-node-label');
  if (!labelEl) return;
  const op = entry.node._op;
  labelEl.innerHTML =
    `<span class="fg-loop-range">${fgEsc(op.variable)} : ${op.start} → ${op.end}</span>` +
    `<br><span class="fg-loop-iter">= ${iterVal}</span>`;
}

/* ===================================================
   Token Animation — SEQUENTIAL execution order
   =================================================== */
function startFlowAnimation(graph) {
  fgTokEl.innerHTML = '';

  const { nodes, edges, tokens } = graph;
  if (tokens.length === 0) return;

  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const edgeMap = buildEdgeMap(edges);

  // Kick off token chain: each token starts only after previous finishes
  function runToken(idx) {
    if (idx >= tokens.length) return;
    launchToken(tokens[idx], nodeMap, edgeMap, () => runToken(idx + 1));
  }

  const t = setTimeout(() => runToken(0), 200);
  fgTimers.push(t);
}

/* Launch a single token and call onComplete when it finishes its journey */
function launchToken(token, nodeMap, edgeMap, onComplete) {
  const startNode = nodeMap.get(token.startNodeId);
  if (!startNode) { if (onComplete) onComplete(); return; }

  const el = document.createElement('div');
  el.className   = 'data-token';
  el.textContent = `[ ${token.label} ]`;
  Object.assign(el.style, {
    left:    tokenLeft(startNode) + 'px',
    top:     tokenTop(startNode)  + 'px',
    opacity: '0',
  });
  fgTokEl.appendChild(el);

  gsap.to(el, {
    opacity: 1, scale: 1,
    duration: 0.24, ease: 'back.out(1.5)',
    onComplete: () => {
      litNode(token.startNodeId);
      if (token.iterValue !== undefined) highlightLoopIteration(token.startNodeId, token.iterValue);
      const path = tracePath(token.startNodeId, edgeMap);
      walkPath(el, path, nodeMap, 0, token, onComplete);
    },
  });
}

/* Walk token along edge path step by step */
function walkPath(el, path, nodeMap, idx, token, onComplete) {
  if (idx >= path.length - 1) {
    const lastId   = path[idx];
    const lastNode = nodeMap.get(lastId);

    if (lastNode && lastNode.type === 'console') {
      // Token dissolves into Console, which reveals accumulated output
      gsap.to(el, {
        opacity: 0, scale: 0.55,
        duration: 0.26, ease: 'power2.in',
        onComplete: () => {
          el.remove();
          revealConsole(token.consoleNodeId, token.consoleLines);
          litNode(token.consoleNodeId || lastId);
          const t = setTimeout(() => { if (onComplete) onComplete(); }, 480);
          fgTimers.push(t);
        },
      });
      return;
    }

    // Terminus that isn't Console: settle in place
    gsap.fromTo(el,
      { scale: 1.18 },
      { scale: 1, duration: 0.26, ease: 'back.out(1.4)',
        onComplete: () => { if (onComplete) onComplete(); } }
    );
    return;
  }

  const nextId   = path[idx + 1];
  const nextNode = nodeMap.get(nextId);
  if (!nextNode) { if (onComplete) onComplete(); return; }

  // Pulse fires on departure
  pulseNode(path[idx]);

  // Token slides to next node — travels horizontally along the edge line
  gsap.to(el, {
    left:     tokenLeft(nextNode),
    top:      tokenTop(nextNode),
    duration: 0.62,
    delay:    0.10,
    ease:     'power2.inOut',
    onComplete: () => {
      litNode(nextId);

      if (nextNode.type === 'compute') {
        // Arriving at a standalone ComputeNode: transform token (or replace)
        transformAtCompute(el, nextNode, path, nodeMap, idx + 1, token, onComplete);
      } else if (nextNode.type === 'loop') {
        // Arriving at a LoopNode that has body ops: run N iterations
        animateLoopIterations(el, nextNode, path, nodeMap, idx + 1, token, onComplete);
      } else {
        gsap.fromTo(el,
          { scale: 1.2 },
          { scale: 1, duration: 0.20, ease: 'back.out(1.3)',
            onComplete: () => walkPath(el, path, nodeMap, idx + 1, token, onComplete),
          }
        );
      }
    },
  });
}

/* ===================================================
   Token transformation at ComputeNode.

   Two distinct animations depending on whether the
   compute target is the SAME variable the token already
   carries (self-update: x = x + 1) or a DIFFERENT one
   (rename: y = x + 2).

   Self-update  — "value changed in place":
     squish → update text → bounce back + amber glow.
     The same DOM element lives on. Signals that the
     variable still exists but its value was mutated.

   New variable — "data flows to a new binding":
     fade-out-and-remove + new element fades in.
     Signals that the computation produced a new result
     that belongs to a different name.

   token.currentVar is mutated in both branches so that
   the next COMPUTE node in the chain gets the correct
   value for its own self-update check.
   This makes the pattern work for any chain length:
     [x=0] → [x=1] → [x=2] → … (all self-updates)
   =================================================== */
function transformAtCompute(el, computeNode, path, nodeMap, curIdx, token, onComplete) {
  const op          = computeNode._op;
  const newLabel    = `${op.target} = ${fgFmtVal(op.value)}`;
  const isSelfUpdate = op.target === token.currentVar;

  if (isSelfUpdate) {
    /* ── In-place update animation ── */
    gsap.to(el, {
      scale: 0.72, duration: 0.16, ease: 'power2.in',
      onComplete: () => {
        // Swap the text while squished (the swap is invisible at small scale)
        el.textContent = `[ ${newLabel} ]`;
        token.currentVar = op.target; // stays the same, but explicit is clearer

        // Bounce back to full size
        gsap.to(el, {
          scale: 1, duration: 0.26, ease: 'back.out(1.9)',
          onComplete: () => walkPath(el, path, nodeMap, curIdx, token, onComplete),
        });

        // Amber glow in parallel (compute color) — fades on its own
        gsap.fromTo(el,
          { boxShadow: '0 0 0 2px rgba(245,158,11,0.9), 0 0 20px rgba(245,158,11,0.55)' },
          { boxShadow: 'none', duration: 0.50, ease: 'power2.out' }
        );
      },
    });

  } else {
    /* ── Replace animation: old token out, new token in ── */
    gsap.to(el, {
      scale: 0.60, opacity: 0, duration: 0.22, ease: 'power2.in',
      onComplete: () => {
        el.remove();

        token.currentVar = op.target; // update tracking BEFORE creating new element

        const newEl = document.createElement('div');
        newEl.className   = 'data-token';
        newEl.textContent = `[ ${newLabel} ]`;
        Object.assign(newEl.style, {
          left:    tokenLeft(computeNode) + 'px',
          top:     tokenTop(computeNode)  + 'px',
          opacity: '0',
        });
        fgTokEl.appendChild(newEl);

        gsap.to(newEl, {
          opacity: 1, scale: 1,
          duration: 0.30, ease: 'back.out(1.6)',
          onComplete: () => walkPath(newEl, path, nodeMap, curIdx, token, onComplete),
        });
      },
    });
  }
}

/* Token is centered inside the node both horizontally and vertically.
   Because all nodes share the same Y (FG_CENTER_Y), the token travels
   horizontally — exactly along the arrow line. */
function tokenLeft(node) { return node.x + Math.round((FG_NODE_W - FG_TOKEN_W) / 2); }
function tokenTop(node)  { return node.y + Math.round((FG_NODE_H - FG_TOKEN_H) / 2); }

/* ===================================================
   Utilities
   =================================================== */
function buildEdgeMap(edges) {
  const map = new Map();
  for (const e of edges) {
    if (!map.has(e.from)) map.set(e.from, []);
    map.get(e.from).push(e.to);
  }
  return map;
}

function tracePath(startId, edgeMap) {
  const path    = [startId];
  const visited = new Set([startId]);
  let   cur     = startId;
  while (edgeMap.has(cur)) {
    const next = edgeMap.get(cur).find(n => !visited.has(n));
    if (!next) break;
    visited.add(next);
    path.push(next);
    cur = next;
  }
  return path;
}

function stopFlowAnimation() {
  fgTimers.forEach(t => clearTimeout(t));
  fgTimers = [];
  gsap.killTweensOf('.data-token');
  gsap.killTweensOf('.fg-node');
  gsap.killTweensOf('.fg-pulse');
}

/* ===================================================
   Entry point — called from editor.js
   sourceCode is the raw program text; it is used by
   parseOps to distinguish compute ops from plain assigns.
   =================================================== */
function startFlowGraph(steps, sourceCode = '') {
  stopFlowAnimation();
  fgTitleEl.textContent = 'Flow Graph';

  const graph = buildFlowGraph(steps, sourceCode);

  if (graph.nodes.length === 0) {
    fgNodesEl.innerHTML = `
      <div class="fg-empty">
        Граф не удалось построить для этого кода.<br>
        Попробуй: <code style="color:#93C5FD">x = 5<br>print(x)</code>
      </div>`;
    return;
  }

  renderFlowGraph(graph);
  setTimeout(() => startFlowAnimation(graph), 360);
}
