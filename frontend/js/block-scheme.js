/* ===================================================================
   block-scheme.js  —  Block Scheme renderer  v3
   Pipeline: parseCode → layoutTree → renderSVG
   =================================================================== */

const BS = {
  ASSIGN_W: 150, ASSIGN_H: 56, ASSIGN_SKEW: 22,
  ACTION_W: 140, ACTION_H: 50, ACTION_RX:   10,
  COND_W:   130, COND_H:   72,
  LOOP_W:   160, LOOP_H:   62, LOOP_FLAT:   36,
  V_GAP:     56,
  H_OFF:    130,   // branch x-offset for if-else
  BACK_PAD:  50,   // extra left padding for back arrows
  EXIT_PAD:  50,   // extra right padding for exit arrows
  WRAP_PAD:  90,   // extra right padding for "Нет" wrap inside loop
  SVG_PAD:   50,
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
    if      (l.s.startsWith('for ')) { const r = parseLoop(lines, i, indent);      nodes.push(r.node); i = r.next; }
    else if (l.s.startsWith('if '))  { const r = parseCond(lines, i, indent);      nodes.push(r.node); i = r.next; }
    else                              { nodes.push(parseStmt(l)); i++; }
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

function parseCond(lines, i, indent) {
  const m = lines[i].s.match(/^if\s+(.+)\s*:$/);
  const label = m ? m[1].trim() : lines[i].s.replace(/^if\s+/,'').replace(/:$/,'');
  const { nodes: yes, next: ay } = parseBlock(lines, i + 1, indent + 4);
  let no = [], next = ay, hasElse = false;
  if (ay < lines.length && lines[ay].ind === indent && lines[ay].s === 'else:') {
    const r = parseBlock(lines, ay + 1, indent + 4);
    no = r.nodes; next = r.next; hasElse = true;
  }
  return { node: { id: uid(), type: 'condition', label, yes, no, hasElse }, next };
}

/* ═══════════════════════════════════════════════════════════════════
   LAYER 2 — LAYOUT
   ═══════════════════════════════════════════════════════════════════ */

function layoutTree(tree) {
  const lnodes = [], edges = [];
  layoutSeq(tree, BS.SVG_PAD + 200, BS.SVG_PAD, null, lnodes, edges);
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
        // Loop exit arrow: right point → right bend → down → this node top
        const rx = lastLoop.cx + lastLoop.w / 2;
        const bx = lastLoop.exitBendX !== undefined ? lastLoop.exitBendX : rx + BS.EXIT_PAD;
        edges.push(ePath([P(rx, lastLoop.cy), P(bx, lastLoop.cy), P(bx, top), P(ln.cx, top)]));
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
  return { w: BS.ACTION_W, h: BS.ACTION_H };
}

/* ── Condition ────────────────────────────────────────────────────── */
function layoutCond(node, cx, topY, loopCtx, lnodes, edges) {
  const { w, h } = bsz('condition');
  const cy = topY + h / 2;
  lnodes.push({ ...node, cx, cy, w, h });

  const condBot   = cy + h / 2;
  const branchTop = condBot + BS.V_GAP;
  const yesCX     = cx - BS.H_OFF;
  const noCX      = cx + BS.H_OFF;

  /* ── INSIDE LOOP ── */
  if (loopCtx) {
    const loopLX = loopCtx.cx - loopCtx.w / 2;
    const loopCY = loopCtx.cy;

    // YES → left column
    const yesOut = [];
    if (node.yes.length > 0) {
      linSeq(node.yes, yesCX, branchTop, yesOut);
      yesOut.forEach(n => lnodes.push(n));
      edges.push(ePath([P(cx - w/2, cy), P(yesCX, cy), P(yesCX, branchTop)], 'Да', 'left'));
    } else {
      edges.push(ePath([P(cx - w/2, cy), P(cx - w/2, loopCY)], 'Да', 'left'));
      edges.push(ePath([P(cx - w/2, loopCY), P(loopLX, loopCY)]));
    }

    if (node.hasElse && node.no.length > 0) {
      // if/else inside loop: both branches merge at join, ONE back arrow to loop
      const noOut = [];
      linSeq(node.no, noCX, branchTop, noOut);
      noOut.forEach(n => lnodes.push(n));
      edges.push(ePath([P(cx + w/2, cy), P(noCX, cy), P(noCX, branchTop)], 'Нет', 'right'));

      const yesBot = yesOut.length > 0
        ? yesOut[yesOut.length - 1].cy + yesOut[yesOut.length - 1].h / 2
        : condBot;
      const noBot  = noOut[noOut.length - 1].cy + noOut[noOut.length - 1].h / 2;
      const joinY  = Math.max(yesBot, noBot) + Math.round(BS.V_GAP / 2);

      // Merge lines (no arrowhead) from branch bottoms to join point
      if (yesOut.length > 0) {
        edges.push({ points: [P(yesCX, yesBot), P(yesCX, joinY), P(cx, joinY)], noArrow: true });
      }
      edges.push({ points: [P(noCX, noBot), P(noCX, joinY), P(cx, joinY)], noArrow: true });

      // Single back arrow from join → loop left point
      const joinBackX = Math.min(yesCX - BS.ACTION_W / 2 - 8, loopLX - BS.BACK_PAD);
      edges.push(ePath([P(cx, joinY), P(joinBackX, joinY), P(joinBackX, loopCY), P(loopLX, loopCY)]));

      // Tell layoutSeq that exit arrow must clear the right-column branch
      loopCtx.exitBendX = noCX + BS.ACTION_W / 2 + BS.EXIT_PAD;

    } else {
      // if without else inside loop: YES back arrow + NO wraps right to loop
      if (yesOut.length > 0) {
        const last = yesOut[yesOut.length - 1];
        edges.push(ePath(backPath(yesCX, last.cy + last.h / 2, loopLX, loopCY)));
      }
      const wrapX = cx + w/2 + BS.WRAP_PAD;
      edges.push(ePath([P(cx + w/2, cy), P(wrapX, cy), P(wrapX, loopCY), P(loopLX, loopCY)],
                       'Нет', 'right'));
    }

    return condBot;  // caller is placeLoop; it uses the visual bottom separately
  }

  /* ── TOP LEVEL ── */
  // YES branch
  const yesOut = [];
  let yesBot = branchTop;
  if (node.yes.length > 0) {
    linSeq(node.yes, yesCX, branchTop, yesOut);
    yesOut.forEach(n => lnodes.push(n));
    edges.push(ePath([P(cx - w/2, cy), P(yesCX, cy), P(yesCX, branchTop)], 'Да', 'left'));
    const last = yesOut[yesOut.length - 1];
    yesBot = last.cy + last.h / 2;
  }

  // NO branch
  const noOut = [];
  let noBot = branchTop;
  const bpX = noCX + BS.ACTION_W / 2 + 8; // bypass stub right edge
  if (node.hasElse && node.no.length > 0) {
    linSeq(node.no, noCX, branchTop, noOut);
    noOut.forEach(n => lnodes.push(n));
    edges.push(ePath([P(cx + w/2, cy), P(noCX, cy), P(noCX, branchTop)], 'Нет', 'right'));
    const last = noOut[noOut.length - 1];
    noBot = last.cy + last.h / 2;
  } else {
    edges.push(ePath([P(cx + w/2, cy), P(bpX, cy)], 'Нет', 'right', true));
  }

  // Join Y
  const joinY = Math.max(yesBot, noBot) + BS.V_GAP;

  // Merge arrows (no arrowhead — they lead into the next block below)
  const merge = (fx, fy, tx, ty) => {
    const pts = Math.abs(fx - tx) < 2
      ? [P(fx, fy), P(tx, ty)]
      : [P(fx, fy), P(fx, ty), P(tx, ty)];
    edges.push({ points: pts, noArrow: true });
  };

  if (yesOut.length > 0) {
    const last = yesOut[yesOut.length - 1];
    merge(yesCX, last.cy + last.h/2, cx, joinY);
  } else {
    merge(cx - w/2, cy, cx, joinY);
  }

  if (node.hasElse && noOut.length > 0) {
    const last = noOut[noOut.length - 1];
    merge(noCX, last.cy + last.h/2, cx, joinY);
  } else {
    edges.push({ points: [P(bpX, cy), P(bpX, joinY), P(cx, joinY)], noArrow: true });
  }

  return joinY;
}

/* Linear sequence → fills outArr, returns bottom Y */
function linSeq(nodes, cx, y, outArr) {
  for (const n of nodes) {
    const ln = mkNode(n, cx, y);
    outArr.push(ln);
    y = ln.cy + ln.h / 2 + BS.V_GAP;
  }
  return outArr.length
    ? outArr[outArr.length-1].cy + outArr[outArr.length-1].h/2
    : y;
}

/* ── Loop ─────────────────────────────────────────────────────────── */
function placeLoop(node, cx, topY, lnodes, edges) {
  const { w, h } = bsz('loop');
  const cy = topY + h / 2;
  const ln = { ...node, cx, cy, w, h };
  lnodes.push(ln);

  const loopBot = cy + h / 2;
  const bodyY   = loopBot + BS.V_GAP;
  const loopLX  = cx - w / 2;

  edges.push(ePath([P(cx, loopBot), P(cx, bodyY)]));

  let bodyBot  = bodyY;
  let visBot   = bodyY;   // max Y of any element (incl. branches)

  for (let bi = 0; bi < node.body.length; bi++) {
    const bn = node.body[bi];

    if (bn.type === 'condition') {
      // layoutCond pushes condNode and all branch nodes
      const beforeLen = lnodes.length;
      layoutCond(bn, cx, bodyBot, ln, lnodes, edges);

      // Update visBot to include all newly added nodes (including branch sub-trees)
      for (let j = beforeLen; j < lnodes.length; j++) {
        const added = lnodes[j];
        visBot = Math.max(visBot, added.cy + added.h / 2);
      }

      // Advance bodyBot past this condition block (main axis only)
      const { h: ch } = bsz('condition');
      bodyBot += ch;   // topY → condCY was bodyBot+ch/2, condBot = bodyBot+ch

    } else {
      const bln = mkNode(bn, cx, bodyBot);
      lnodes.push(bln);
      bodyBot = bln.cy + bln.h / 2;
      visBot  = Math.max(visBot, bodyBot);

      // Back arrow only for the last body element
      // (if a condition follows, its branch paths handle all returns to the loop)
      if (bi === node.body.length - 1) {
        edges.push(ePath(backPath(cx, bodyBot, loopLX, cy)));
      }
    }

    if (bi < node.body.length - 1) { bodyBot += BS.V_GAP; visBot = Math.max(visBot, bodyBot); }
  }

  return visBot;   // caller (layoutSeq) uses this to position post-loop content
}

/* ── Helpers ──────────────────────────────────────────────────────── */
function P(x, y) { return { x, y }; }

function ePath(points, label, labelSide, noArrow) {
  return { points, label, labelSide, noArrow: !!noArrow };
}

/* Back-arrow path from (fromX, fromY) to left point of loop at (loopLX, loopCY) */
function backPath(fromX, fromY, loopLX, loopCY) {
  const outerX = Math.min(fromX - BS.ACTION_W/2 - 8, loopLX - BS.BACK_PAD);
  return [P(fromX, fromY), P(outerX, fromY), P(outerX, loopCY), P(loopLX, loopCY)];
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
  <defs><marker id="ar" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
    <polygon points="0 0,8 3,0 6" fill="#333"/>
  </marker></defs>`;

  edges.forEach(e  => { s += drawEdge(e); });
  lnodes.forEach(n => { s += drawBlock(n); });
  return s + '</svg>';
}

function drawEdge(e) {
  if (!e.points || e.points.length < 2) return '';
  const d = e.points.map((p,i) => (i?'L':'M')+` ${f(p.x)} ${f(p.y)}`).join(' ');
  const mk = e.noArrow ? '' : ' marker-end="url(#ar)"';
  let r = `<path d="${d}" fill="none" stroke="#333" stroke-width="1.5"${mk}/>`;
  if (e.label) {
    const lp = labelPos(e.points, e.labelSide);
    r += `<text x="${f(lp.x)}" y="${f(lp.y)}" font-size="12"
      font-family="Inter,sans-serif" fill="#333"
      text-anchor="${lp.anc}" dominant-baseline="middle">${e.label}</text>`;
  }
  return r;
}

function labelPos(pts, side) {
  const p0=pts[0], p1=pts[1];
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
    default:           return drawRect(n);
  }
}

const SF = 'fill="#fff" stroke="#333" stroke-width="1.5"';

function drawPara(n) {
  const {cx,cy,w,h}=n, sk=BS.ASSIGN_SKEW;
  const pts=`${f(cx-w/2+sk)},${f(cy-h/2)} ${f(cx+w/2+sk)},${f(cy-h/2)} ${f(cx+w/2-sk)},${f(cy+h/2)} ${f(cx-w/2-sk)},${f(cy+h/2)}`;
  return `<polygon points="${pts}" ${SF}/>${drawTxt(n)}`;
}
function drawRect(n) {
  const {cx,cy,w,h}=n;
  return `<rect x="${f(cx-w/2)}" y="${f(cy-h/2)}" width="${w}" height="${h}" rx="${BS.ACTION_RX}" ry="${BS.ACTION_RX}" ${SF}/>${drawTxt(n)}`;
}
function drawDiam(n) {
  const {cx,cy,w,h}=n;
  const pts=`${f(cx)},${f(cy-h/2)} ${f(cx+w/2)},${f(cy)} ${f(cx)},${f(cy+h/2)} ${f(cx-w/2)},${f(cy)}`;
  return `<polygon points="${pts}" ${SF}/>${drawTxt(n)}`;
}
function drawHex(n) {
  const {cx,cy,w,h}=n, fl=BS.LOOP_FLAT/2;
  const pts=`${f(cx-fl)},${f(cy-h/2)} ${f(cx+fl)},${f(cy-h/2)} ${f(cx+w/2)},${f(cy)} ${f(cx+fl)},${f(cy+h/2)} ${f(cx-fl)},${f(cy+h/2)} ${f(cx-w/2)},${f(cy)}`;
  return `<polygon points="${pts}" ${SF}/>${drawTxt(n)}`;
}
function drawTxt(n) {
  const fs = n.label.length > 18 ? 11 : 13;
  return `<text x="${f(n.cx)}" y="${f(n.cy)}" font-size="${fs}" font-family="Inter,sans-serif"
    fill="#222" text-anchor="middle" dominant-baseline="middle">${xe(n.label)}</text>`;
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
    addColArrows(lnodes, edges);
    document.getElementById('bs-canvas').innerHTML = renderSVG(lnodes, edges);
  } catch (err) {
    document.getElementById('bs-canvas').innerHTML =
      `<div style="color:red;padding:16px">Ошибка построения схемы: ${xe(err.message)}</div>`;
    console.error('[BlockScheme]', err);
  }
}
