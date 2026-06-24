/* ===== Flow Graph — Experimental Mode ===== */

/* --- Layout constants (JS source of truth; CSS mirrors these) --- */
const FG_NODE_W    = 160;
const FG_NODE_H    = 80;
const FG_GAP_X     = 60;
const FG_CENTER_Y  = 130;
const FG_BRANCH_Y  = 70;   // vertical offset for if/else branch nodes above/below centre
const FG_TOKEN_W   = 100;
const FG_TOKEN_H   = 32;

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
  condition: {
    typeLabel: 'IF',
    makeLabel: (op) => op.expression,
  },
  // Reserved for future:
  // function:  { typeLabel: 'CALL',      makeLabel: (op) => ... },
};

/* --- Accent colors per node type (add entry here for each new type) --- */
const FG_COLORS = {
  assignment: { border:'#2D5CB8', glow:'rgba(79,126,247,0.55)', outer:'rgba(79,126,247,0.20)', pulse:'#3B6FD4' },
  compute:    { border:'#92400E', glow:'rgba(245,158,11,0.45)', outer:'rgba(245,158,11,0.18)', pulse:'#F59E0B' },
  print:      { border:'#176A42', glow:'rgba(34,197,94,0.45)',  outer:'rgba(34,197,94,0.18)',  pulse:'#22C55E' },
  console:    { border:'#5B35A8', glow:'rgba(139,92,246,0.45)', outer:'rgba(139,92,246,0.18)', pulse:'#8B5CF6' },
  loop:       { border:'#0E7490', glow:'rgba(6,182,212,0.50)',  outer:'rgba(6,182,212,0.18)',  pulse:'#06B6D4' },
  condition:  { border:'#B45309', glow:'rgba(251,146,60,0.50)', outer:'rgba(251,146,60,0.18)', pulse:'#F97316' },
};
function fgColors(type) { return FG_COLORS[type] || FG_COLORS.assignment; }

/* Evaluates a simple two-operand condition using current variable snapshot.
   operands can be variable names (looked up in vars) or numeric literals. */
function evaluateCondition(op1, operator, op2, vars) {
  const lhsIsVar = /^[a-zA-Z_]/.test(op1);
  const rhsIsVar = /^[a-zA-Z_]/.test(op2);
  if (lhsIsVar && !Object.prototype.hasOwnProperty.call(vars, op1)) return false;
  if (rhsIsVar && !Object.prototype.hasOwnProperty.call(vars, op2)) return false;
  const lhs = lhsIsVar ? Number(vars[op1]) : parseFloat(op1);
  const rhs = rhsIsVar ? Number(vars[op2]) : parseFloat(op2);
  switch (operator) {
    case '>':  return lhs > rhs;
    case '<':  return lhs < rhs;
    case '>=': return lhs >= rhs;
    case '<=': return lhs <= rhs;
    case '==': return lhs === rhs;
    case '!=': return lhs !== rhs;
    default:   return false;
  }
}

/* Detects binary arithmetic: var = operand OP operand
   At least one operand must be a variable name (starts with a letter) so that
   pure-literal expressions like "y = 5 + 3" are treated as plain assignments.
   Supports all four arithmetic operators. Future work: extend to support
   parenthesised and multi-operator expressions at the AST level. */
const BINARY_ASSIGN_RE = /^(\w+)\s*=\s*(\w+|\d+\.?\d*)\s*([-+*/])\s*(\w+|\d+\.?\d*)\s*$/;
const FOR_RANGE_RE     = /^for\s+(\w+)\s+in\s+range\s*\(\s*(\d+)\s*\)\s*:/;
// Detects: if VAR_OR_NUM OP VAR_OR_NUM: (multi-char ops listed first to prevent partial match)
const IF_COND_RE       = /^if\s+(\w+|\d+\.?\d*)\s*(>=|<=|!=|==|>|<)\s*(\w+|\d+\.?\d*)\s*:/;

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

  // Pre-scan: detect for-range loops, if conditions, and else clauses.
  // sourceLines must be the ORIGINAL (non-trimmed) lines for indentation detection.
  // loopInfo[varName] = { end, emitted, op, printLabel }
  const loopInfo         = {};
  const loopBodyLineNums = new Set(); // 1-based line numbers that are loop body lines

  // ifLineInfo[1-based lineNum] = { expression, op1, operator, op2, ifPrintLabel }
  const ifLineInfo     = {};
  const emittedIfLines = new Set();

  // elseInfo[ifLine_1based] = { elseBodyLines: Set<1based>, elsePrintLabel: string|null }
  const elseInfo = {};

  sourceLines.forEach((line, i) => {
    const trimmed = line.trim();

    const mLoop = FOR_RANGE_RE.exec(trimmed);
    if (mLoop) {
      loopInfo[mLoop[1]] = { end: parseInt(mLoop[2]), emitted: false, op: null, printLabel: null };
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

    const mIf = IF_COND_RE.exec(trimmed);
    if (mIf) {
      const ifLine   = i + 1; // 1-based
      const ifIndent = line.length - line.trimStart().length;
      // Scan if-body to find the print label
      let ifPrintLabel = null;
      for (let j = i + 1; j < sourceLines.length; j++) {
        const bl = sourceLines[j];
        if (bl.trim() === '') continue;
        if (bl.length - bl.trimStart().length > ifIndent) {
          if (!ifPrintLabel) {
            const pm = /^(print\s*\([^)]*\))/.exec(bl.trim());
            if (pm) ifPrintLabel = pm[1];
          }
        } else { break; }
      }
      ifLineInfo[ifLine] = {
        expression: `${mIf[1]} ${mIf[2]} ${mIf[3]}`,
        op1: mIf[1], operator: mIf[2], op2: mIf[3],
        ifPrintLabel,
      };
    }

    // Detect else: — link to the nearest preceding if at the same indentation.
    if (trimmed === 'else:') {
      const elseIndent = line.length - line.trimStart().length;
      for (let j = i - 1; j >= 0; j--) {
        const jl = sourceLines[j];
        if (jl.trim() === '') continue;
        const jIndent = jl.length - jl.trimStart().length;
        if (jIndent === elseIndent && IF_COND_RE.test(jl.trim())) {
          const ifLine = j + 1; // 1-based
          // Scan else-body lines
          const elseBodyLines = new Set();
          let elsePrintLabel  = null;
          for (let k = i + 1; k < sourceLines.length; k++) {
            const kl = sourceLines[k];
            if (kl.trim() === '') continue;
            if (kl.length - kl.trimStart().length > elseIndent) {
              elseBodyLines.add(k + 1); // 1-based
              if (!elsePrintLabel) {
                const pm = /^(print\s*\([^)]*\))/.exec(kl.trim());
                if (pm) elsePrintLabel = pm[1];
              }
            } else { break; }
          }
          elseInfo[ifLine] = { elseBodyLines, elsePrintLabel };
          break;
        }
      }
    }
  });

  // Build reverse-lookup maps for output attribution.
  // ifBodyLineOfElse[bodyLine_1based] = ifLine — only for ifs that have an else clause.
  const ifBodyLineOfElse     = {};
  const elseBodyLineToIfLine = {};
  Object.entries(elseInfo).forEach(([ifLineStr, info]) => {
    const ifLine   = parseInt(ifLineStr);
    const srcIdx   = ifLine - 1; // 0-based index into sourceLines
    const ifIndent = sourceLines[srcIdx].length - sourceLines[srcIdx].trimStart().length;
    for (let j = srcIdx + 1; j < sourceLines.length; j++) {
      const bl = sourceLines[j];
      if (bl.trim() === '') continue;
      if (bl.length - bl.trimStart().length > ifIndent) {
        ifBodyLineOfElse[j + 1] = ifLine; // 1-based
      } else { break; }
    }
    info.elseBodyLines.forEach(l => { elseBodyLineToIfLine[l] = ifLine; });
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

    // Detect if-condition line (prevLineIdx = the line that just ran before this step)
    if (ifLineInfo[prevLineIdx] && !emittedIfLines.has(prevLineIdx)) {
      const info = ifLineInfo[prevLineIdx];
      if (isBodyLine) {
        // Inside a loop body: record on the loop op, don't emit a standalone condition op.
        // The per-iteration result is evaluated at animation time from token.conditionResult.
        const li = activeLoop();
        if (li && li.op && !li.op.bodyCondition) {
          li.op.bodyCondition = { expression: info.expression, op1: info.op1, operator: info.operator, op2: info.op2 };
        }
      } else {
        // Standalone if (with or without else).
        const hasElse  = !!elseInfo[prevLineIdx];
        const condOp = {
          type:       'condition',
          expression: info.expression,
          result:     evaluateCondition(info.op1, info.operator, info.op2, prevVars),
          hasElse,
          _ifLine:    prevLineIdx,
        };
        if (hasElse) {
          condOp.truePrintLabel  = info.ifPrintLabel                      || 'print(…)';
          condOp.falsePrintLabel = elseInfo[prevLineIdx].elsePrintLabel    || 'print(…)';
        }
        ops.push(condOp);
      }
      emittedIfLines.add(prevLineIdx);
    }

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
    for (const lineText of newLines) {
      const matchEntry = Object.entries(vars).find(([, v]) => String(v) === lineText);
      const printLabel = matchEntry ? `print(${matchEntry[0]})` : 'print(…)';

      if (matchEntry && loopInfo[matchEntry[0]]) {
        // Print of a loop variable — accumulate in the loop op; don't emit a separate op.
        const li = loopInfo[matchEntry[0]];
        if (li.op) li.op.outputs.push(lineText);
        if (!li.printLabel) li.printLabel = printLabel;
      } else if (ifBodyLineOfElse[prevLineIdx] !== undefined) {
        // Output came from the true-body of an if/else — attach to the condition op.
        const ifLine  = ifBodyLineOfElse[prevLineIdx];
        const condOp  = ops.slice().reverse().find(o => o.type === 'condition' && o._ifLine === ifLine);
        if (condOp) condOp._trueText = lineText;
        // Don't emit a standalone print op.
      } else if (elseBodyLineToIfLine[prevLineIdx] !== undefined) {
        // Output came from the false-body (else) of an if/else — attach to the condition op.
        const ifLine  = elseBodyLineToIfLine[prevLineIdx];
        const condOp  = ops.slice().reverse().find(o => o.type === 'condition' && o._ifLine === ifLine);
        if (condOp) condOp._falseText = lineText;
        // Don't emit a standalone print op.
      } else {
        ops.push({ type: 'print', label: printLabel, text: lineText });
      }
    }

    prevVars    = { ...vars };
    prevOutput  = [...output];
    prevLineIdx = step.line || prevLineIdx;
  }

  // Post-pass 1: if the very last step's line was the if-line (condition never reached its
  // body — e.g. standalone FALSE without else), emit the condition op now.
  if (ifLineInfo[prevLineIdx] && !emittedIfLines.has(prevLineIdx)) {
    const info    = ifLineInfo[prevLineIdx];
    const hasElse = !!elseInfo[prevLineIdx];
    const condOp  = {
      type:       'condition',
      expression: info.expression,
      result:     evaluateCondition(info.op1, info.operator, info.op2, prevVars),
      hasElse,
      _ifLine:    prevLineIdx,
    };
    if (hasElse) {
      condOp.truePrintLabel  = info.ifPrintLabel                      || 'print(…)';
      condOp.falsePrintLabel = elseInfo[prevLineIdx].elsePrintLabel    || 'print(…)';
    }
    ops.push(condOp);
  }

  // Post-pass 2: expand ops into the flat node sequence used by buildNodes.
  const finalOps = [];
  for (const op of ops) {
    finalOps.push(op);

    if (op.type === 'condition' && op.hasElse) {
      // Y-split: insert one PRINT node for the true branch and one for the false branch.
      // buildNodes positions them above / below FG_CENTER_Y; buildEdges creates two edges
      // from CONDITION and two edges converging back into CONSOLE.
      finalOps.push({
        type:   'print',
        label:  op.truePrintLabel  || 'print(…)',
        text:   op._trueText  || null,
        branch: 'true',
      });
      finalOps.push({
        type:   'print',
        label:  op.falsePrintLabel || 'print(…)',
        text:   op._falseText || null,
        branch: 'false',
      });
    } else if (op.type === 'loop') {
      const li = Object.values(loopInfo).find(l => l.op === op);
      if (op.bodyCondition) {
        // Loop with conditional print body → LOOP → CONDITION → PRINT (if any output)
        finalOps.push({
          type:           'condition',
          expression:     op.bodyCondition.expression,
          result:         false,       // placeholder; overridden per-token via token.conditionResult
          isLoopBodyCond: true,
        });
        if (op.outputs.length > 0) {
          finalOps.push({
            type:       'print',
            label:      li?.printLabel || `print(${op.variable})`,
            text:       null,
            isLoopBody: true,
          });
        }
      } else if (op.outputs.length > 0) {
        // Loop with simple print body → LOOP → PRINT
        finalOps.push({
          type:       'print',
          label:      li?.printLabel || `print(${op.variable})`,
          text:       null,
          isLoopBody: true,
        });
      }
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
  const hasPrints = expandedOps.some(o => o.type === 'print');
  // Branch pairs (true+false) share one X column, so subtract one slot per true-branch node.
  const branchTrueCount = expandedOps.filter(o => o.branch === 'true').length;
  const totalCount      = expandedOps.length - branchTrueCount + (hasPrints ? 1 : 0);

  const totalW = totalCount * FG_NODE_W + Math.max(0, totalCount - 1) * FG_GAP_X;
  let curX     = Math.max(40, Math.round((canvasW - totalW) / 2));

  const nodes = [];

  expandedOps.forEach((op, i) => {
    const typeDef = FG_NODE_TYPES[op.type] || FG_NODE_TYPES.assignment;

    // Branch nodes are offset vertically to create the Y-split visual.
    let nodeY = FG_CENTER_Y;
    if (op.branch === 'true')  nodeY = FG_CENTER_Y - FG_BRANCH_Y;
    if (op.branch === 'false') nodeY = FG_CENTER_Y + FG_BRANCH_Y;

    nodes.push({
      id:    `node_${i}`,
      type:  op.type,
      label: typeDef.makeLabel(op),
      x:     curX,
      y:     nodeY,
      _op:   op,
    });

    // True-branch shares the X column with the following false-branch → don't advance curX.
    if (op.branch !== 'true') curX += FG_NODE_W + FG_GAP_X;
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
   Mostly linear chain, but detects if/else Y-split pairs
   and creates two edges from CONDITION plus two converging
   edges back into CONSOLE.

   edge.branch: 'true' | 'false' | 'default'
   =================================================== */
function buildEdges(nodes) {
  const edges = [];
  let skip = 0;   // remaining nodes to skip after handling a branch pair

  for (let i = 0; i < nodes.length - 1; i++) {
    if (skip > 0) { skip--; continue; }

    const n    = nodes[i];
    const next = nodes[i + 1];

    if (next._op && next._op.branch === 'true' && i + 2 < nodes.length) {
      // n = CONDITION-with-else, nodes[i+1] = PRINT_TRUE, nodes[i+2] = PRINT_FALSE
      const pt = nodes[i + 1];
      const pf = nodes[i + 2];
      edges.push({ id: `e_${i}_t`,  from: n.id,  to: pt.id, branch: 'true'    });
      edges.push({ id: `e_${i}_f`,  from: n.id,  to: pf.id, branch: 'false'   });
      // Both branch prints converge into the node that follows them (CONSOLE).
      if (i + 3 < nodes.length) {
        const con = nodes[i + 3];
        edges.push({ id: `e_${i+1}_c`, from: pt.id, to: con.id, branch: 'default' });
        edges.push({ id: `e_${i+2}_c`, from: pf.id, to: con.id, branch: 'default' });
        skip = 3; // skip PRINT_TRUE, PRINT_FALSE, CONSOLE from normal loop processing
      } else {
        skip = 2; // skip PRINT_TRUE, PRINT_FALSE (no node after)
      }
    } else {
      edges.push({ id: `e_${i}`, from: n.id, to: next.id, branch: 'default' });
    }
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

    } else if (op.type === 'loop' && op.bodyCondition) {
      // for i in range(N): if VAR OP VAL: print(VAR)
      // N iteration tokens; each knows its own condition result.
      const { variable, start, end, outputs, bodyCondition } = op;
      const N = end - start;
      let outputConsumed = 0;

      for (let iter = 0; iter < N; iter++) {
        const iterValue  = start + iter;
        const condVars   = { [variable]: iterValue };
        const condResult = evaluateCondition(
          bodyCondition.op1, bodyCondition.operator, bodyCondition.op2, condVars
        );

        // TRUE tokens progressively accumulate console output; FALSE tokens get [].
        let consoleLines = [];
        if (condResult) {
          outputConsumed++;
          consoleLines = outputs.slice(0, outputConsumed);
        }

        tokens.push({
          id:              `tok_loop_${i}_${iter}`,
          label:           `${variable} = ${iterValue}`,
          startNodeId,
          consoleNodeId:   consoleId,
          consoleLines,
          currentVar:      variable,
          iterValue,
          conditionResult: condResult,  // animateCondition reads this to decide TRUE/FALSE
        });
      }
      loopPrintOffset += outputs.length;

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

    // Staggered entrance — fallback to instant-visible if GSAP unavailable
    try {
      gsap.from(el, {
        opacity: 0, scale: 0.85, y: 8,
        duration: 0.28, ease: 'back.out(1.6)',
        delay: 0.04 + i * 0.055,
      });
    } catch (_) {
      el.style.opacity = '1';
    }
  });

  /* --- SVG Arrows --- */
  const svgNS   = 'http://www.w3.org/2000/svg';
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  const defs = document.createElementNS(svgNS, 'defs');
  defs.innerHTML = `
    <marker id="fga-head"       markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">
      <polygon points="0 0,9 3.5,0 7" fill="#3B6FD4"/>
    </marker>
    <marker id="fga-head-true"  markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">
      <polygon points="0 0,9 3.5,0 7" fill="#16A34A"/>
    </marker>
    <marker id="fga-head-false" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">
      <polygon points="0 0,9 3.5,0 7" fill="#B91C1C"/>
    </marker>`;
  fgArrowEl.appendChild(defs);

  for (const edge of edges) {
    const fn = nodeMap.get(edge.from);
    const tn = nodeMap.get(edge.to);
    if (!fn || !tn) continue;

    const isTrueBranch  = edge.branch === 'true';
    const isFalseBranch = edge.branch === 'false';

    const strokeColor = isTrueBranch  ? '#16A34A'
                      : isFalseBranch ? '#B91C1C'
                      : '#2D5CB8';
    const glowColor   = isTrueBranch  ? 'rgba(22,163,74,0.18)'
                      : isFalseBranch ? 'rgba(185,28,28,0.18)'
                      : 'rgba(59,111,212,0.15)';
    const markerId    = isTrueBranch  ? 'fga-head-true'
                      : isFalseBranch ? 'fga-head-false'
                      : 'fga-head';

    const x1 = fn.x + FG_NODE_W;
    const y1 = fn.y + FG_NODE_H / 2;
    const x2 = tn.x;
    const y2 = tn.y + FG_NODE_H / 2;
    const mx = (x1 + x2) / 2;
    const d  = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;

    // Glow layer
    const glow = document.createElementNS(svgNS, 'path');
    glow.setAttribute('d', d);
    glow.setAttribute('stroke', strokeColor);
    glow.setAttribute('stroke-width', '5');
    glow.setAttribute('stroke-opacity', '0.22');
    glow.setAttribute('fill', 'none');
    fgArrowEl.appendChild(glow);

    // Main line
    const line = document.createElementNS(svgNS, 'path');
    line.setAttribute('d', d);
    line.setAttribute('stroke', strokeColor);
    line.setAttribute('stroke-width', '2');
    line.setAttribute('stroke-opacity', '0.80');
    line.setAttribute('fill', 'none');
    line.setAttribute('marker-end', `url(#${markerId})`);
    fgArrowEl.appendChild(line);

    // Branch edge labels (TRUE / FALSE)
    if (isTrueBranch || isFalseBranch) {
      const labelX = (x1 + mx) / 2;         // roughly 1/4 along the curve
      const labelY = (y1 + y2) / 2 - 5;
      const text = document.createElementNS(svgNS, 'text');
      text.setAttribute('x', String(Math.round(labelX)));
      text.setAttribute('y', String(Math.round(labelY)));
      text.setAttribute('fill',         strokeColor);
      text.setAttribute('font-size',    '10');
      text.setAttribute('font-family',  'monospace, monospace');
      text.setAttribute('font-weight',  '700');
      text.setAttribute('text-anchor',  'middle');
      text.setAttribute('opacity',      '0.85');
      text.textContent = isTrueBranch ? 'TRUE' : 'FALSE';
      fgArrowEl.appendChild(text);
    }
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

/* Updates the ConditionNode label to show TRUE / FALSE after token arrives. */
function showConditionResult(nodeId, result) {
  const entry = fgNodeReg.get(nodeId);
  if (!entry) return;
  const labelEl = entry.el.querySelector('.fg-node-label');
  if (!labelEl) return;
  const op  = entry.node._op;
  const cls  = result ? 'fg-cond-true' : 'fg-cond-false';
  const text = result ? 'TRUE' : 'FALSE';
  labelEl.innerHTML =
    `<span class="fg-cond-expr">${fgEsc(op.expression)}</span>` +
    `<span class="${cls}">${text}</span>`;
}

/* ===================================================
   ConditionNode animation.

   Token arrives at the IF node, the result (TRUE/FALSE)
   is revealed inside the node.

   TRUE  → short pause, then token continues along path.
   FALSE → token dissolves at the condition node;
           the walk stops here (Console is never updated).
   =================================================== */
function animateCondition(el, conditionNode, path, nodeMap, curIdx, token, onComplete) {
  const op = conditionNode._op;
  // Loop-body conditions evaluate per-token; standalone conditions use op.result.
  const result = (token.conditionResult !== undefined) ? token.conditionResult : op.result;

  // Scale-in bounce (matches other node arrival animations)
  gsap.fromTo(el,
    { scale: 1.2 },
    { scale: 1, duration: 0.20, ease: 'back.out(1.3)',
      onComplete: () => {
        showConditionResult(conditionNode.id, result);

        if (result || op.hasElse) {
          // TRUE → continue along the true path.
          // FALSE with else → tracePath already routed us to the false branch; just continue.
          const t = setTimeout(() => walkPath(el, path, nodeMap, curIdx, token, onComplete), 380);
          fgTimers.push(t);
        } else {
          // FALSE with no else: token dissolves; Console is never updated.
          const t = setTimeout(() => {
            gsap.to(el, {
              opacity: 0, scale: 0.55, duration: 0.34, ease: 'power2.in',
              onComplete: () => {
                el.remove();
                const t2 = setTimeout(() => { if (onComplete) onComplete(); }, 260);
                fgTimers.push(t2);
              },
            });
          }, 440);
          fgTimers.push(t);
        }
      },
    }
  );
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
      const path = tracePath(token.startNodeId, edgeMap, nodeMap);
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
      } else if (nextNode.type === 'condition') {
        // Arriving at a ConditionNode: evaluate and either continue or dissolve
        animateCondition(el, nextNode, path, nodeMap, idx + 1, token, onComplete);
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
// Returns Map<fromId, [{to, branch}]> — preserves branch metadata for tracePath.
function buildEdgeMap(edges) {
  const map = new Map();
  for (const e of edges) {
    if (!map.has(e.from)) map.set(e.from, []);
    map.get(e.from).push({ to: e.to, branch: e.branch || 'default' });
  }
  return map;
}

// Follows edges from startId, picking the correct branch at CONDITION nodes with else.
function tracePath(startId, edgeMap, nodeMap) {
  const path    = [startId];
  const visited = new Set([startId]);
  let   cur     = startId;
  while (edgeMap.has(cur)) {
    const edgeList = edgeMap.get(cur);
    let   next;

    if (edgeList.length > 1) {
      // Branching point: pick the edge whose branch matches the condition result.
      const curNode = nodeMap ? nodeMap.get(cur) : null;
      const result  = curNode?._op?.result;
      const target  = edgeList.find(e => e.branch === (result ? 'true' : 'false'));
      next = target?.to;
    } else {
      const e = edgeList.find(e => !visited.has(e.to));
      next = e?.to;
    }

    if (!next || visited.has(next)) break;
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

  try {
    console.log('[FG] startFlowGraph — steps:', steps?.length, '| code:', sourceCode?.slice(0,40));
    const graph = buildFlowGraph(steps, sourceCode);
    console.log('[FG] graph — nodes:', graph.nodes.length, '| tokens:', graph.tokens.length, '| edges:', graph.edges.length);
    if (graph.nodes.length > 0) {
      console.log('[FG] nodes:', graph.nodes.map(n => `${n.id}(${n.type}@${n.x},${n.y})`).join(' → '));
      console.log('[FG] tokens:', graph.tokens.map(t => `${t.id}[${t.startNodeId}→${t.consoleNodeId}] lines=${JSON.stringify(t.consoleLines)}`).join(', '));
    }

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
  } catch (err) {
    console.error('[FlowGraph]', err);
    fgNodesEl.innerHTML = `
      <div class="fg-empty" style="color:#F87171">
        Ошибка построения графа: ${err.message || err}<br>
        <small style="opacity:0.6">Подробности в консоли браузера (F12)</small>
      </div>`;
  }
}
