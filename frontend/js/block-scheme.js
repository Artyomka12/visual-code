/* ===================================================================
   block-scheme.js  —  Block Scheme renderer  v3
   Pipeline: parseCode → layoutTree → renderSVG
   =================================================================== */

const BS = {
  ASSIGN_W: 150, ASSIGN_H: 56, ASSIGN_SKEW: 22,
  ACTION_W: 140, ACTION_H: 50, ACTION_RX:   10,
  COND_W:   130, COND_H:   72,
  LOOP_W:   160, LOOP_H:   62, LOOP_FLAT:   36,
  TERM_W:   120, TERM_H:   44,
  V_GAP:     56,
  H_OFF:    130,   // branch x-offset for if-else
  BACK_PAD:  50,   // extra left padding for back arrows
  EXIT_PAD:  50,   // extra right padding for exit arrows
  WRAP_PAD:  90,   // extra right padding for "Нет" wrap inside loop
  SVG_PAD:   50,
  FRAME_NEST:  35,  // extra gap per side between nested loop frames
  FRAME_PAD_X: 25,  // x-padding from widest node to frame border
  FRAME_PAD_Y: 10,  // y-padding above loop top / below body bottom
  BACK_DOWN:   10,  // px down before turning left on back arrow
};

let _uid = 0;
const uid = () => 'b' + (++_uid);

/* ═══════════════════════════════════════════════════════════════════
   LAYER 1 — PARSER
   ═══════════════════════════════════════════════════════════════════ */

function parseCode(src) {
  _uid = 0;
  const lines = src.split('\n')
    .map((t, i) => ({ s: t.trimStart(), ind: t.length - t.trimStart().length, i }))
    .filter(l => l.s.length > 0);
  return parseBlock(lines, 0, 0).nodes;
}

function parseBlock(lines, si, indent) {
  const nodes = [];
  let i = si;
  while (i < lines.length) {
    const l = lines[i];
    if (l.ind < indent) break;
    if (l.ind > indent) { i++; continue; }
    if (l.s === 'else:' || l.s.startsWith('elif ')) break;
    if      (l.s.startsWith('for '))   { const r = parseLoop(lines, i, indent);  nodes.push(r.node); i = r.next; }
    else if (l.s.startsWith('while ')) { const r = parseWhile(lines, i, indent); nodes.push(r.node); i = r.next; }
    else if (l.s.startsWith('if '))    { const r = parseCond(lines, i, indent);  nodes.push(r.node); i = r.next; }
    else                               { nodes.push(parseStmt(l)); i++; }
  }
  return { nodes, next: i };
}

function parseStmt(l) {
  const s = l.s;
  const m = !s.startsWith('print') && s.match(/^(\w+)\s*=\s*(.+)$/);
  if (m) {
    const rhs = m[2].trim();
    const lit = /^-?\d+(\.\d+)?$/.test(rhs) || /^["'].*["']$/.test(rhs)
              || ['True','False','None'].includes(rhs);
    return { id: uid(), type: lit ? 'assignment' : 'action', label: s };
  }
  return { id: uid(), type: 'action', label: s };
}

function parseLoop(lines, i, indent) {
  const m = lines[i].s.match(/^for\s+(\w+)\s+in\s+(range\([^)]+\))\s*:/);
  const label = m ? `${m[1]} in ${m[2]}` : lines[i].s.replace(/^for\s+/,'').replace(/:$/,'');
  const { nodes: body, next } = parseBlock(lines, i + 1, indent + 4);
  return { node: { id: uid(), type: 'loop', label, body }, next };
}

function parseWhile(lines, i, indent) {
  const m = lines[i].s.match(/^while\s+(.+?)\s*:$/);
  const label = m ? m[1].trim() : lines[i].s.replace(/^while\s+/, '').replace(/:$/, '');
  const { nodes: body, next } = parseBlock(lines, i + 1, indent + 4);
  return { node: { id: uid(), type: 'loop', label, body }, next };
}

function parseCond(lines, i, indent) {
  const raw = lines[i].s;
  const m = raw.match(/^(?:if|elif)\s+(.+?)\s*:$/);
  const label = m ? m[1].trim() : raw.replace(/^(?:if|elif)\s+/, '').replace(/:$/, '');
  const { nodes: yes, next: ay } = parseBlock(lines, i + 1, indent + 4);
  let no = [], next = ay, hasElse = false;
  if (ay < lines.length && lines[ay].ind === indent) {
    if (lines[ay].s === 'else:') {
      const r = parseBlock(lines, ay + 1, indent + 4);
      no = r.nodes; next = r.next; hasElse = true;
    } else if (lines[ay].s.startsWith('elif ')) {
      // elif → рекурсивно превращается во вложенный if в no-ветви
      const r = parseCond(lines, ay, indent);
      no = [r.node]; next = r.next; hasElse = true;
    }
  }
  return { node: { id: uid(), type: 'condition', label, yes, no, hasElse }, next };
}

/* ═══════════════════════════════════════════════════════════════════
   LAYER 2 — LAYOUT
   ═══════════════════════════════════════════════════════════════════ */

function layoutTree(tree) {
  const lnodes = [], edges = [];
  const startNode = { id: uid(), type: 'terminal', label: 'Начало' };
  const endNode   = { id: uid(), type: 'terminal', label: 'Конец'  };
  layoutSeq([startNode, ...tree, endNode], BS.SVG_PAD + 200, BS.SVG_PAD, null, lnodes, edges);
  return { lnodes, edges };
}

/* Lay out a sequence of siblings. loopCtx = enclosing LayoutNode or null.
   Returns bottom Y of the last placed item (no trailing V_GAP). */
function layoutSeq(nodes, cx, y0, loopCtx, lnodes, edges) {
  let y        = y0;
  let lastLoop = null;    // LayoutNode of last loop, for exit arrow
  let joinY    = null;    // Y of condition join point, for join→next arrow

  const addFromJoin = (toY) => {
    if (joinY !== null) {
      edges.push(ePath([P(cx, joinY), P(cx, toY)]));
      joinY = null;
    }
  };

  for (let i = 0; i < nodes.length; i++) {
    const node    = nodes[i];
    const hasNext = i + 1 < nodes.length;

    if (node.type === 'loop') {
      addFromJoin(y);   // connect condition join → loop top (if applicable)
      const visBot = placeLoop(node, cx, y, lnodes, edges);
      lastLoop = lnodes.find(n => n.id === node.id);
      y = visBot;
      if (hasNext) y += BS.V_GAP;

    } else if (node.type === 'condition') {
      addFromJoin(y);   // connect prior condition join → this condition top
      const j = layoutCond(node, cx, y, loopCtx, lnodes, edges);
      if (!loopCtx) joinY = j;   // track join for top-level conditions
      lastLoop = null;
      y = j;
      if (hasNext) y += BS.V_GAP;

    } else {
      const ln  = mkNode(node, cx, y);
      lnodes.push(ln);
      const top = ln.cy - ln.h / 2;

      if (lastLoop) {
        // Loop exit arrow: right tip → frameRight border → down → above node → down into node top
        const rx = lastLoop.cx + lastLoop.w / 2;
        const D  = BS.BACK_DOWN;
        edges.push(ePath([P(rx, lastLoop.cy), P(lastLoop.frameRight, lastLoop.cy),
                          P(lastLoop.frameRight, top - D), P(ln.cx, top - D), P(ln.cx, top)]));
        lastLoop = null;
      } else {
        addFromJoin(top);   // connect condition join → this node top
        // (remaining down arrows added by addColArrows)
      }

      y = ln.cy + ln.h / 2;
      if (hasNext) y += BS.V_GAP;
    }
  }
  return y;
}

/* Place a single non-structural node at (cx, topY), return LayoutNode. */
function mkNode(node, cx, topY) {
  const { w, h } = bsz(node.type);
  return { ...node, cx, cy: topY + h / 2, w, h };
}

function bsz(type) {
  if (type === 'assignment') return { w: BS.ASSIGN_W, h: BS.ASSIGN_H };
  if (type === 'condition')  return { w: BS.COND_W,   h: BS.COND_H   };
  if (type === 'loop')       return { w: BS.LOOP_W,   h: BS.LOOP_H   };
  if (type === 'terminal')   return { w: BS.TERM_W,   h: BS.TERM_H   };
  return { w: BS.ACTION_W, h: BS.ACTION_H };
}

/* ── Condition ────────────────────────────────────────────────────── */
function layoutCond(node, cx, topY, loopCtx, lnodes, edges, isLastInLoop = true) {
  const { w, h } = bsz('condition');
  const cy = topY + h / 2;
  lnodes.push({ ...node, cx, cy, w, h });

  const condBot   = cy + h / 2;
  const branchTop = condBot + BS.V_GAP;
  const yesCX     = cx - BS.H_OFF;
  const noCX      = cx + BS.H_OFF;

  /* ── INSIDE LOOP, NOT LAST ── */
  if (loopCtx && !isLastInLoop) {
    const D = BS.BACK_DOWN;

    let yesBot = branchTop;
    if (node.yes.length > 0) {
      edges.push(ePath([P(cx - w/2, cy), P(cx - w/2, cy + D), P(yesCX, cy + D), P(yesCX, branchTop)], 'Да', 'left'));
      yesBot = linSeq(node.yes, yesCX, branchTop, loopCtx, lnodes, edges);
    }

    if (node.hasElse && node.no.length > 0) {
      edges.push(ePath([P(cx + w/2, cy), P(cx + w/2, cy + D), P(noCX, cy + D), P(noCX, branchTop)], 'Нет', 'right'));
      const noBot = linSeq(node.no, noCX, branchTop, loopCtx, lnodes, edges);

      const yesJoin = node.yes.length > 0 ? yesBot : condBot;
      const joinY   = Math.max(yesJoin, noBot) + Math.round(BS.V_GAP / 2);

      if (node.yes.length > 0) {
        edges.push({ points: [P(yesCX, yesBot), P(yesCX, joinY), P(cx, joinY)], noArrow: true });
      }
      edges.push({ points: [P(noCX, noBot), P(noCX, joinY), P(cx, joinY)], noArrow: true });
      return joinY;

    } else {
      const stubX = cx + w / 2 + 8;
      const joinY = (node.yes.length > 0 ? yesBot : condBot) + Math.round(BS.V_GAP / 2);

      if (node.yes.length > 0) {
        edges.push({ points: [P(yesCX, yesBot), P(yesCX, joinY), P(cx, joinY)], noArrow: true });
      } else {
        edges.push({ points: [P(cx - w/2, cy), P(cx - w/2, joinY), P(cx, joinY)],
                     label: 'Да', labelSide: 'left', noArrow: true });
      }
      edges.push(ePath([P(cx + w/2, cy), P(cx + w/2, cy + D), P(stubX, cy + D)], 'Нет', 'right', true));
      edges.push({ points: [P(stubX, cy + D), P(stubX, joinY), P(cx, joinY)], noArrow: true });
      return joinY;
    }
  }

  /* ── INSIDE LOOP, LAST ── */
  if (loopCtx) {
    const D = BS.BACK_DOWN;

    let yesBot = branchTop;
    if (node.yes.length > 0) {
      edges.push(ePath([P(cx - w/2, cy), P(cx - w/2, cy + D), P(yesCX, cy + D), P(yesCX, branchTop)], 'Да', 'left'));
      yesBot = linSeq(node.yes, yesCX, branchTop, loopCtx, lnodes, edges);
    }

    if (node.hasElse && node.no.length > 0) {
      edges.push(ePath([P(cx + w/2, cy), P(cx + w/2, cy + D), P(noCX, cy + D), P(noCX, branchTop)], 'Нет', 'right'));
      const noBot = linSeq(node.no, noCX, branchTop, loopCtx, lnodes, edges);

      const yesJoin = node.yes.length > 0 ? yesBot : condBot;
      const joinY   = Math.max(yesJoin, noBot) + Math.round(BS.V_GAP / 2);

      if (node.yes.length > 0) {
        edges.push({ points: [P(yesCX, yesBot), P(yesCX, joinY), P(cx, joinY)], noArrow: true });
      }
      edges.push({ points: [P(noCX, noBot), P(noCX, joinY), P(cx, joinY)], noArrow: true });
      edges.push(backArrow(cx, joinY, loopCtx));
      return joinY;

    } else {
      const stubX = cx + w / 2 + 8;
      const joinY = (node.yes.length > 0 ? yesBot : condBot) + Math.round(BS.V_GAP / 2);

      if (node.yes.length > 0) {
        edges.push({ points: [P(yesCX, yesBot), P(yesCX, joinY), P(cx, joinY)], noArrow: true });
      } else {
        edges.push({ points: [P(cx - w/2, cy), P(cx - w/2, joinY), P(cx, joinY)],
                     label: 'Да', labelSide: 'left', noArrow: true });
      }
      edges.push(ePath([P(cx + w/2, cy), P(cx + w/2, cy + D), P(stubX, cy + D)], 'Нет', 'right', true));
      edges.push({ points: [P(stubX, cy + D), P(stubX, joinY), P(cx, joinY)], noArrow: true });
      edges.push(backArrow(cx, joinY, loopCtx));
      return joinY;
    }
  }

  /* ── TOP LEVEL ── */
  // YES branch
  let yesBot = branchTop;
  if (node.yes.length > 0) {
    edges.push(ePath([P(cx - w/2, cy), P(yesCX, cy), P(yesCX, branchTop)], 'Да', 'left'));
    yesBot = linSeq(node.yes, yesCX, branchTop, null, lnodes, edges);
  }

  // NO branch
  let noBot = branchTop;
  const bpX = noCX + BS.ACTION_W / 2 + 8;
  if (node.hasElse && node.no.length > 0) {
    edges.push(ePath([P(cx + w/2, cy), P(noCX, cy), P(noCX, branchTop)], 'Нет', 'right'));
    noBot = linSeq(node.no, noCX, branchTop, null, lnodes, edges);
  } else {
    edges.push(ePath([P(cx + w/2, cy), P(bpX, cy)], 'Нет', 'right', true));
  }

  // Join Y
  const joinY = Math.max(yesBot, noBot) + BS.V_GAP;

  // Merge arrows (no arrowhead)
  const merge = (fx, fy, tx, ty) => {
    const pts = Math.abs(fx - tx) < 2
      ? [P(fx, fy), P(tx, ty)]
      : [P(fx, fy), P(fx, ty), P(tx, ty)];
    edges.push({ points: pts, noArrow: true });
  };

  if (node.yes.length > 0) {
    merge(yesCX, yesBot, cx, joinY);
  } else {
    merge(cx - w/2, cy, cx, joinY);
  }

  if (node.hasElse && node.no.length > 0) {
    merge(noCX, noBot, cx, joinY);
  } else {
    edges.push({ points: [P(bpX, cy), P(bpX, joinY), P(cx, joinY)], noArrow: true });
  }

  return joinY;
}

/* Lay out a branch sequence — pushes directly to lnodes/edges, returns bottom Y */
function linSeq(nodes, cx, y, loopCtx, lnodes, edges) {
  let bot      = y;
  let lastLoop = null;
  let joinY    = null;

  const flushJoin = (toY) => {
    if (joinY !== null) { edges.push(ePath([P(cx, joinY), P(cx, toY)])); joinY = null; }
  };

  for (let i = 0; i < nodes.length; i++) {
    const n       = nodes[i];
    const hasNext = i + 1 < nodes.length;

    if (n.type === 'loop') {
      flushJoin(bot);
      const visBot = placeLoop(n, cx, bot, lnodes, edges);
      lastLoop = lnodes.find(ln => ln.id === n.id);
      bot = visBot;
      if (hasNext) bot += BS.V_GAP;

    } else if (n.type === 'condition') {
      flushJoin(bot);
      const j = layoutCond(n, cx, bot, loopCtx, lnodes, edges, false);
      joinY    = j;
      lastLoop = null;
      bot = j;
      if (hasNext) bot += BS.V_GAP;

    } else {
      const ln  = mkNode(n, cx, bot);
      lnodes.push(ln);
      const top = ln.cy - ln.h / 2;

      if (lastLoop) {
        const rx = lastLoop.cx + lastLoop.w / 2;
        const D  = BS.BACK_DOWN;
        edges.push(ePath([P(rx, lastLoop.cy), P(lastLoop.frameRight, lastLoop.cy),
                          P(lastLoop.frameRight, top - D), P(cx, top - D), P(cx, top)]));
        lastLoop = null;
      } else {
        flushJoin(top);
      }

      bot = ln.cy + ln.h / 2;
      if (hasNext) bot += BS.V_GAP;
    }
  }

  return bot;
}

/* ── Loop ─────────────────────────────────────────────────────────── */
function placeLoop(node, cx, topY, lnodes, edges) {
  const { w, h } = bsz('loop');
  const cy = topY + h / 2;
  const ln = { ...node, cx, cy, w, h };
  lnodes.push(ln);
  const frameStartIdx = lnodes.length - 1;  // index of this loop node in lnodes

  const loopBot = cy + h / 2;
  const bodyY   = loopBot + BS.V_GAP;
  const loopLX  = cx - w / 2;

  edges.push(ePath([P(cx, loopBot), P(cx, bodyY)]));

  let bodyBot      = bodyY;
  let visBot       = bodyY;
  let pendingJoinY  = null;   // join Y from a non-last condition → arrow to next element
  let lastInnerLoop = null;   // nested loop node → exit arrow to next element

  for (let bi = 0; bi < node.body.length; bi++) {
    const bn     = node.body[bi];
    const isLast = bi === node.body.length - 1;

    // Flush pending condition join
    if (pendingJoinY !== null) {
      edges.push(ePath([P(cx, pendingJoinY), P(cx, bodyBot)]));
      pendingJoinY = null;
    }

    // Flush exit arrow from previous nested loop
    if (lastInnerLoop !== null) {
      const rx = lastInnerLoop.cx + lastInnerLoop.w / 2;
      const D  = BS.BACK_DOWN;
      edges.push(ePath([P(rx, lastInnerLoop.cy), P(lastInnerLoop.frameRight, lastInnerLoop.cy),
                        P(lastInnerLoop.frameRight, bodyBot - D), P(cx, bodyBot - D), P(cx, bodyBot)]));
      lastInnerLoop = null;
    }

    if (bn.type === 'condition') {
      const beforeLen = lnodes.length;

      if (isLast) {
        const condJoinY = layoutCond(bn, cx, bodyBot, ln, lnodes, edges);
        const { h: ch } = bsz('condition');
        bodyBot += ch;
        visBot = Math.max(visBot, condJoinY);
      } else {
        const joinY = layoutCond(bn, cx, bodyBot, ln, lnodes, edges, false);
        pendingJoinY = joinY;
        bodyBot = joinY;
      }

      for (let j = beforeLen; j < lnodes.length; j++) {
        visBot = Math.max(visBot, lnodes[j].cy + lnodes[j].h / 2);
      }

    } else if (bn.type === 'loop') {
      // Nested loop — recurse into placeLoop
      const innerVisBot = placeLoop(bn, cx, bodyBot, lnodes, edges);
      visBot   = Math.max(visBot, innerVisBot);
      bodyBot  = innerVisBot;

      if (isLast) {
        // Outer back arrow starts below the full visual extent of the nested loop
        edges.push(backArrow(cx, innerVisBot, ln));
      } else {
        // Track for exit arrow to next body element
        lastInnerLoop = lnodes.find(n => n.id === bn.id);
      }

    } else {
      const bln = mkNode(bn, cx, bodyBot);
      lnodes.push(bln);
      bodyBot = bln.cy + bln.h / 2;
      visBot  = Math.max(visBot, bodyBot);

      if (isLast) {
        edges.push(backArrow(cx, bodyBot, ln));
      }
    }

    if (!isLast) { bodyBot += BS.V_GAP; visBot = Math.max(visBot, bodyBot); }
  }

  // ── Frame bounds ───────────────────────────────────────────────────
  // Expand from the loop hexagon outward, treating nested loop frames
  // as wider anchors so outer frames always enclose inner ones.
  let fL = cx - w / 2, fR = cx + w / 2;
  for (let j = frameStartIdx; j < lnodes.length; j++) {
    const nd = lnodes[j];
    if (nd.type === 'loop' && nd.frameLeft != null) {
      fL = Math.min(fL, nd.frameLeft  - BS.FRAME_NEST);
      fR = Math.max(fR, nd.frameRight + BS.FRAME_NEST);
    } else {
      fL = Math.min(fL, nd.cx - nd.w / 2);
      fR = Math.max(fR, nd.cx + nd.w / 2);
    }
  }
  ln.frameLeft  = fL - BS.FRAME_PAD_X;
  ln.frameRight = fR + BS.FRAME_PAD_X;
  ln.frameTop   = topY   - BS.FRAME_PAD_Y;
  ln.frameBot   = visBot + BS.FRAME_PAD_Y;
  // ───────────────────────────────────────────────────────────────────

  return visBot;   // caller (layoutSeq) uses this to position post-loop content
}

/* ── Helpers ──────────────────────────────────────────────────────── */
function P(x, y) { return { x, y }; }

function ePath(points, label, labelSide, noArrow) {
  return { points, label, labelSide, noArrow: !!noArrow };
}

/* Lazy back-arrow: stores a reference to the loop node.
   Resolved after all frames are computed via resolveBackArrows(). */
function backArrow(fromX, fromY, loopNode) {
  return { isBackArrow: true, fromX, fromY, loopNode };
}

/* Resolve all lazy back arrows once every loop has its frameLeft set. */
function resolveBackArrows(edges) {
  for (const e of edges) {
    if (!e.isBackArrow) continue;
    const ln  = e.loopNode;
    const lx  = ln.cx - ln.w / 2;   // loop hexagon left tip
    const D   = BS.BACK_DOWN;
    e.points  = [
      P(e.fromX, e.fromY),          // start at bottom of element
      P(e.fromX, e.fromY + D),      // go down a little first
      P(ln.frameLeft, e.fromY + D), // go left to frame border
      P(ln.frameLeft, ln.cy),       // go up along frame border
      P(lx, ln.cy),                 // go right into loop hexagon
    ];
    delete e.isBackArrow;
    delete e.loopNode;
    delete e.fromX;
    delete e.fromY;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   LAYER 3 — SVG RENDERER
   ═══════════════════════════════════════════════════════════════════ */

function renderSVG(lnodes, edges) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (x, y) => {
    if (x < x0) x0=x; if (y < y0) y0=y; if (x > x1) x1=x; if (y > y1) y1=y;
  };
  lnodes.forEach(n => { grow(n.cx-n.w/2,n.cy-n.h/2); grow(n.cx+n.w/2,n.cy+n.h/2); });
  edges.forEach(e => (e.points||[]).forEach(p => grow(p.x, p.y)));

  const pad = BS.SVG_PAD;
  x0-=pad; y0-=pad; x1+=pad; y1+=pad;
  const W=x1-x0, H=y1-y0;

  let s = `<svg id="bs-svg" xmlns="http://www.w3.org/2000/svg"
    width="${W}" height="${H}" viewBox="${x0} ${y0} ${W} ${H}">
  <defs>
    <style>
      .bs-terminal  {fill:var(--bs-terminal-fill);stroke:var(--bs-terminal-stroke);stroke-width:1.5}
      .bs-assignment{fill:var(--bs-assign-fill);stroke:var(--bs-assign-stroke);stroke-width:1.5}
      .bs-action    {fill:var(--bs-action-fill);stroke:var(--bs-action-stroke);stroke-width:1.5}
      .bs-condition {fill:var(--bs-cond-fill);stroke:var(--bs-cond-stroke);stroke-width:1.5}
      .bs-loop      {fill:var(--bs-loop-fill);stroke:var(--bs-loop-stroke);stroke-width:1.5}
      .bs-terminal-txt  {fill:var(--bs-terminal-text)}
      .bs-assignment-txt{fill:var(--bs-assign-text)}
      .bs-action-txt    {fill:var(--bs-action-text)}
      .bs-condition-txt {fill:var(--bs-cond-text)}
      .bs-loop-txt      {fill:var(--bs-loop-text)}
      .bs-edge      {fill:none;stroke:var(--bs-edge);stroke-width:1.5}
      .bs-arrowhead {fill:var(--bs-edge)}
      .bs-label-yes {fill:var(--bs-yes);font-size:12px;font-weight:600;font-family:Inter,sans-serif}
      .bs-label-no  {fill:var(--bs-no);font-size:12px;font-weight:600;font-family:Inter,sans-serif}
      .bs-loop-frame{display:none}
    </style>
    <marker id="ar" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <polygon class="bs-arrowhead" points="0 0,8 3,0 6"/>
    </marker>
  </defs>`;

  // Loop frames — rendered behind edges and blocks
  lnodes.forEach(n => {
    if (n.type === 'loop' && n.frameLeft != null) {
      const fw = f(n.frameRight - n.frameLeft);
      const fh = f(n.frameBot   - n.frameTop);
      s += `<rect class="bs-loop-frame" x="${f(n.frameLeft)}" y="${f(n.frameTop)}" width="${fw}" height="${fh}" rx="12"/>`;
    }
  });
  edges.forEach(e  => { s += drawEdge(e); });
  lnodes.forEach(n => { s += drawBlock(n); });
  return s + '</svg>';
}

function drawEdge(e) {
  if (!e.points || e.points.length < 2) return '';
  const d = e.points.map((p,i) => (i?'L':'M')+` ${f(p.x)} ${f(p.y)}`).join(' ');
  const mk = e.noArrow ? '' : ' marker-end="url(#ar)"';
  let r = `<path class="bs-edge" d="${d}"${mk}/>`;
  if (e.label) {
    const lp  = labelPos(e.points, e.labelSide);
    const cls = e.label === 'Да' ? 'bs-label-yes' : e.label === 'Нет' ? 'bs-label-no' : 'bs-label';
    r += `<text class="${cls}" x="${f(lp.x)}" y="${f(lp.y)}"
      text-anchor="${lp.anc}" dominant-baseline="middle">${e.label}</text>`;
  }
  return r;
}

function labelPos(pts, side) {
  let p0 = pts[0], p1 = pts[1];
  // If the first segment is a tiny exit-step (< 20px), use the next segment for the label
  if (pts.length > 2 && Math.abs(p1.x - p0.x) + Math.abs(p1.y - p0.y) < 20) {
    p0 = pts[1]; p1 = pts[2];
  }
  const mx=(p0.x+p1.x)/2, my=(p0.y+p1.y)/2;
  if (side==='left')  return { x: mx-12, y: my-8, anc: 'end'    };
  if (side==='right') return { x: mx+12, y: my-8, anc: 'start'  };
  return { x: mx, y: my-10, anc: 'middle' };
}

function drawBlock(n) {
  switch (n.type) {
    case 'assignment': return drawPara(n);
    case 'condition':  return drawDiam(n);
    case 'loop':       return drawHex(n);
    case 'terminal':   return drawOval(n);
    default:           return drawRect(n);
  }
}

/* ── Block shapes — colours via CSS classes / SVG <style> ─────────── */
const TYPE_CLS = {
  terminal: 'bs-terminal', assignment: 'bs-assignment',
  action: 'bs-action', condition: 'bs-condition', loop: 'bs-loop',
};
const TXT_CLS = {
  terminal: 'bs-terminal-txt', assignment: 'bs-assignment-txt',
  action: 'bs-action-txt', condition: 'bs-condition-txt', loop: 'bs-loop-txt',
};

function drawOval(n) {
  const {cx,cy,w,h}=n;
  return `<ellipse class="${TYPE_CLS[n.type]||'bs-action'}" cx="${f(cx)}" cy="${f(cy)}" rx="${f(w/2)}" ry="${f(h/2)}"/>${drawTxt(n)}`;
}
function drawPara(n) {
  const {cx,cy,w,h}=n, sk=BS.ASSIGN_SKEW;
  const pts=`${f(cx-w/2+sk)},${f(cy-h/2)} ${f(cx+w/2+sk)},${f(cy-h/2)} ${f(cx+w/2-sk)},${f(cy+h/2)} ${f(cx-w/2-sk)},${f(cy+h/2)}`;
  return `<polygon class="${TYPE_CLS[n.type]||'bs-action'}" points="${pts}"/>${drawTxt(n)}`;
}
function drawRect(n) {
  const {cx,cy,w,h}=n;
  return `<rect class="${TYPE_CLS[n.type]||'bs-action'}" x="${f(cx-w/2)}" y="${f(cy-h/2)}" width="${w}" height="${h}" rx="${BS.ACTION_RX}" ry="${BS.ACTION_RX}"/>${drawTxt(n)}`;
}
function drawDiam(n) {
  const {cx,cy,w,h}=n;
  const pts=`${f(cx)},${f(cy-h/2)} ${f(cx+w/2)},${f(cy)} ${f(cx)},${f(cy+h/2)} ${f(cx-w/2)},${f(cy)}`;
  return `<polygon class="${TYPE_CLS[n.type]||'bs-action'}" points="${pts}"/>${drawTxt(n)}`;
}
function drawHex(n) {
  const {cx,cy,w,h}=n, fl=BS.LOOP_FLAT/2;
  const pts=`${f(cx-fl)},${f(cy-h/2)} ${f(cx+fl)},${f(cy-h/2)} ${f(cx+w/2)},${f(cy)} ${f(cx+fl)},${f(cy+h/2)} ${f(cx-fl)},${f(cy+h/2)} ${f(cx-w/2)},${f(cy)}`;
  return `<polygon class="${TYPE_CLS[n.type]||'bs-action'}" points="${pts}"/>${drawTxt(n)}`;
}
/* ── Typography helpers ───────────────────────────────────────────── */

// Max chars per line and max lines per block type
const TYPE_WRAP = {
  terminal:   { maxChars: 12, maxLines: 1 },
  assignment: { maxChars: 20, maxLines: 2 },
  action:     { maxChars: 18, maxLines: 2 },
  condition:  { maxChars: 15, maxLines: 2 },
  loop:       { maxChars: 22, maxLines: 2 },
};

// Split into "words" for wrapping, but spaces inside ( ) or [ ] never split
// a word — arr[j + 1] and range(n - i - 1) stay whole.
function splitWords(label) {
  const words = [];
  let cur = '';
  let depth = 0;
  for (const ch of label) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);

    if (/\s/.test(ch) && depth === 0) {
      if (cur) words.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) words.push(cur);
  return words;
}

// Greedy word-wrap: returns array of lines
function wrapLabel(label, type) {
  const { maxChars, maxLines } = TYPE_WRAP[type] || { maxChars: 18, maxLines: 2 };
  if (label.length <= maxChars) return [label];

  const words = splitWords(label);
  if (words.length <= 1) return [label];   // single word, can't wrap

  const lines = [];
  let cur = words[0];

  for (let i = 1; i < words.length; i++) {
    if (cur.length + 1 + words[i].length <= maxChars) {
      cur += ' ' + words[i];
    } else {
      lines.push(cur);
      if (lines.length >= maxLines - 1) {
        cur = words.slice(i).join(' ');   // last line gets all remaining words
        break;
      }
      cur = words[i];
    }
  }
  lines.push(cur);
  return lines;
}

// Scale font size: larger for short labels, smaller for long / multi-line
function bsFontSize(label, numLines) {
  if (numLines > 1) return 10;
  const len = label.length;
  if (len <= 6)  return 14;
  if (len <= 12) return 13;
  if (len <= 18) return 12;
  if (len <= 24) return 11;
  return 10;
}

function drawTxt(n) {
  const lines  = wrapLabel(n.label, n.type);
  const fs     = bsFontSize(n.label, lines.length);
  const lineH  = Math.round(fs * 1.3);
  const cls    = TXT_CLS[n.type] || 'bs-action-txt';
  const common = `font-size="${fs}" font-family="Inter,sans-serif" font-weight="500" text-anchor="middle" dominant-baseline="middle"`;

  if (lines.length === 1) {
    return `<text class="${cls}" x="${f(n.cx)}" y="${f(n.cy)}" ${common}>${xe(lines[0])}</text>`;
  }

  // Multi-line: first tspan anchored so the whole block is vertically centred at n.cy
  const y0 = f(n.cy - (lines.length - 1) * lineH / 2);
  const tspans = lines.map((l, i) =>
    i === 0
      ? `<tspan x="${f(n.cx)}" y="${y0}">${xe(l)}</tspan>`
      : `<tspan x="${f(n.cx)}" dy="${lineH}">${xe(l)}</tspan>`
  ).join('');

  return `<text class="${cls}" ${common}>${tspans}</text>`;
}

function f(v)  { return Math.round(v*10)/10; }
function xe(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

/* ─── Add implicit vertical arrows between consecutive same-column nodes ─── */
function addColArrows(lnodes, edges) {
  const cols = {};
  lnodes.forEach(n => { const k=Math.round(n.cx); (cols[k]=cols[k]||[]).push(n); });
  Object.values(cols).forEach(col => {
    col.sort((a,b)=>a.cy-b.cy);
    for (let i=0; i<col.length-1; i++) {
      const a=col[i], b=col[i+1];
      const aBot=a.cy+a.h/2, bTop=b.cy-b.h/2;
      const gap=bTop-aBot;
      if (gap<=0 || gap>BS.V_GAP*2.2) continue;
      // Skip if an edge already starts near aBot (back arrow, explicit edge, etc.)
      const used = edges.some(e => e.points && e.points.length>0
        && Math.abs(e.points[0].x - a.cx)<4
        && Math.abs(e.points[0].y - aBot)<4);
      if (!used) edges.push({ points:[P(a.cx,aBot),P(b.cx,bTop)] });
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════
   PUBLIC API
   ═══════════════════════════════════════════════════════════════════ */

function startBlockScheme(code) {
  try {
    const tree = parseCode(code);
    const { lnodes, edges } = layoutTree(tree);
    resolveBackArrows(edges);   // must run before addColArrows
    addColArrows(lnodes, edges);
    document.getElementById('bs-canvas').innerHTML = renderSVG(lnodes, edges);
  } catch (err) {
    document.getElementById('bs-canvas').innerHTML =
      `<div style="color:red;padding:16px">Ошибка построения схемы: ${xe(err.message)}</div>`;
    console.error('[BlockScheme]', err);
  }
}
