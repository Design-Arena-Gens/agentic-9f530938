"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Bubble, BubbleColor, BubbleKind, LevelConfig, PowerupState } from '../lib/types';
import { BASE_COLORS, LEVELS } from '../lib/levels';
import { playCombo, playLose, playPop } from '../lib/audio';

interface Props {
  level: LevelConfig;
  lives: number;
  muted: boolean;
  onWin: (levelScore: number) => void;
  onLoseLife: () => void;
  onShot: () => void;
  onCombo: () => void;
}

// Visual palette mapping
const COLOR_TO_HEX: Record<BubbleColor, string> = {
  red: '#ef4444', blue: '#3b82f6', green: '#22c55e', yellow: '#eab308',
  purple: '#a855f7', orange: '#fb923c', cyan: '#06b6d4', pink: '#ec4899', gray: '#475569'
};

// Grid constants
const BUBBLE_RADIUS = 16;
const BUBBLE_DIAMETER = BUBBLE_RADIUS * 2;
const ROW_V_SPACING = Math.sqrt(3) * BUBBLE_RADIUS * 0.98; // hex vertical spacing
const COL_H_SPACING = BUBBLE_DIAMETER * 0.98;
const MAX_COLS = 12;
const MAX_ROWS = 18;

// Shooter
const SHOOT_SPEED = 520; // px/s
const MAX_AIM_BOUNCES = 6;

// Utility
function randId() { return Math.random().toString(36).slice(2, 9); }
function clamp(n: number, a: number, b: number) { return Math.max(a, Math.min(b, n)); }

export default function BubbleShooterCanvas({ level, lives, muted, onWin, onLoseLife, onShot, onCombo }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const [dimensions, setDimensions] = useState({ w: 600, h: 800 });
  const [aimAngle, setAimAngle] = useState(-Math.PI / 2);
  const [reducedAim, setReducedAim] = useState(!!level.reducedAim);

  // Game state
  const gridRef = useRef<(Bubble | null)[][]>([]);
  const movingRef = useRef<Bubble | null>(null);
  const dirRef = useRef<{ dx: number; dy: number } | null>(null);
  const scoreRef = useRef(0);
  const comboChainRef = useRef(0);
  const descentOffsetRef = useRef(0);
  const startMsRef = useRef<number | null>(null);
  const powerRef = useRef<PowerupState>({ freezeUntil: 0, aimBoostUntil: 0 });
  const nextQueueRef = useRef<BubbleKind[]>([]);

  const colors = useMemo(() => BASE_COLORS.slice(0, level.colorsCount), [level.colorsCount]);

  const computeGridSize = useCallback((w: number, h: number) => {
    const cols = Math.min(MAX_COLS, Math.max(8, Math.floor(w / COL_H_SPACING)));
    const rows = MAX_ROWS; // logical rows; canvas height defines how many visible
    return { cols, rows };
  }, []);

  const gridToXY = useCallback((row: number, col: number, w: number) => {
    const { cols } = computeGridSize(w, dimensions.h);
    const rowOffset = (row % 2 === 0) ? 0 : COL_H_SPACING / 2;
    const x = rowOffset + BUBBLE_RADIUS + col * COL_H_SPACING;
    const y = BUBBLE_RADIUS + row * ROW_V_SPACING - descentOffsetRef.current;
    return { x, y };
  }, [computeGridSize, dimensions.h]);

  const xyToGridGuess = useCallback((x: number, y: number, w: number) => {
    const row = Math.round((y + descentOffsetRef.current - BUBBLE_RADIUS) / ROW_V_SPACING);
    const rowOffset = (row % 2 === 0) ? 0 : COL_H_SPACING / 2;
    const col = Math.round((x - rowOffset - BUBBLE_RADIUS) / COL_H_SPACING);
    return { row, col };
  }, []);

  const initGrid = useCallback((w: number, h: number) => {
    const { cols, rows } = computeGridSize(w, h);
    const grid: (Bubble | null)[][] = Array.from({ length: rows }, () => Array(cols).fill(null));

    // Seed top rows based on pattern
    function seedColor(): BubbleColor {
      return colors[Math.floor(Math.random() * colors.length)];
    }

    const topRows = level.doubleLayer ? 8 : 6;
    for (let r = 0; r < topRows; r++) {
      for (let c = 0; c < cols - (r % 2 === 1 ? 1 : 0); c++) {
        const kind: BubbleKind = 'normal';
        const color: BubbleColor = seedColor();
        const { x, y } = gridToXY(r, c, w);
        if (level.startingPattern === 'simple' && r > 3) continue;
        if (level.startingPattern === 'alternating' && (r + c) % 2 === 1) continue;
        if (level.startingPattern === 'random' && Math.random() < 0.25) continue;
        grid[r][c] = { id: randId(), row: r, col: c, x, y, color, kind, stationary: true };
      }
    }

    // Unbreakable gray obstacles
    let placedGray = 0;
    while (placedGray < level.unbreakableGrayCount) {
      const r = Math.floor(Math.random() * Math.min(topRows + 4, rows));
      const c = Math.floor(Math.random() * (cols - (r % 2 === 1 ? 1 : 0)));
      if (!grid[r][c]) {
        const { x, y } = gridToXY(r, c, w);
        grid[r][c] = { id: randId(), row: r, col: c, x, y, color: 'gray', kind: 'normal', stationary: true };
        placedGray++;
      }
    }

    gridRef.current = grid;
  }, [colors, computeGridSize, gridToXY, level.doubleLayer, level.startingPattern, level.unbreakableGrayCount]);

  const refillNextQueue = useCallback(() => {
    const q: BubbleKind[] = [];
    // Mix a small chance of power-ups based on level
    for (let i = 0; i < 3; i++) {
      const roll = Math.random();
      if (level.rainbowEnabled && roll < 0.08) q.push('rainbow');
      else if (roll < 0.11) q.push('bomb');
      else if (roll < 0.135) q.push('freeze');
      else if (roll < 0.16) q.push('aim');
      else q.push('normal');
    }
    nextQueueRef.current = q;
  }, [level.rainbowEnabled]);

  const currentShooterBubble = useMemo(() => {
    const kind = nextQueueRef.current[0] ?? 'normal';
    return { kind };
  }, [dimensions.w]);

  const addNewDescendingRow = useCallback((w: number, h: number) => {
    const grid = gridRef.current;
    const { cols } = computeGridSize(w, h);
    // shift all rows down (implicit via descentOffset), but periodically add a new top row
    // Create new row at virtual row 0 positions
    const newRowIndex = 0;
    const newRow: (Bubble | null)[] = Array(cols).fill(null);
    for (let c = 0; c < cols - (newRowIndex % 2 === 1 ? 1 : 0); c++) {
      const useRandomColor = Math.random() < level.randomColorChance;
      const color: BubbleColor = useRandomColor ? BASE_COLORS[Math.floor(Math.random() * BASE_COLORS.length)] : (colors[Math.floor(Math.random() * colors.length)] as BubbleColor);
      const { x, y } = gridToXY(0, c, w);
      newRow[c] = { id: randId(), row: 0, col: c, x, y, color, kind: 'normal', stationary: true };
    }
    // push existing bubbles down one row index (logical)
    for (let r = grid.length - 1; r >= 0; r--) {
      for (let c = 0; c < grid[r].length; c++) {
        const b = grid[r][c];
        if (b) b.row = b.row + 1;
      }
    }
    grid.unshift(newRow);
    grid.pop();
  }, [colors, computeGridSize, gridToXY, level.randomColorChance]);

  const neighbors = useCallback((r: number, c: number, w: number) => {
    const grid = gridRef.current;
    const res: { r: number; c: number; b: Bubble | null }[] = [];
    const { cols } = computeGridSize(w, dimensions.h);
    const odd = r % 2 === 1;
    const candidates = [
      [r, c - 1], [r, c + 1],
      [r - 1, c + (odd ? 0 : -1)], [r - 1, c + (odd ? 1 : 0)],
      [r + 1, c + (odd ? 0 : -1)], [r + 1, c + (odd ? 1 : 0)],
    ];
    for (const [rr, cc] of candidates) {
      if (rr < 0 || rr >= grid.length) continue;
      if (cc < 0 || cc >= cols - (rr % 2 === 1 ? 1 : 0)) continue;
      res.push({ r: rr, c: cc, b: grid[rr][cc] });
    }
    return res;
  }, [computeGridSize, dimensions.h]);

  const floodMatch = useCallback((r: number, c: number, targetColor: BubbleColor, w: number) => {
    const grid = gridRef.current;
    const visited = new Set<string>();
    const res: { r: number; c: number }[] = [];
    const key = (rr: number, cc: number) => rr + ':' + cc;
    const stack: { r: number; c: number }[] = [{ r, c }];
    while (stack.length) {
      const cur = stack.pop()!;
      if (visited.has(key(cur.r, cur.c))) continue;
      visited.add(key(cur.r, cur.c));
      const b = grid[cur.r][cur.c];
      if (!b) continue;
      const isRainbow = b.kind === 'rainbow';
      if (b.color === targetColor || isRainbow) {
        res.push(cur);
        const nbrs = neighbors(cur.r, cur.c, w);
        for (const n of nbrs) {
          if (!n.b) continue;
          const nbRainbow = n.b.kind === 'rainbow';
          if (n.b.color === targetColor || nbRainbow) stack.push({ r: n.r, c: n.c });
        }
      }
    }
    return res;
  }, [neighbors]);

  const removeDisconnected = useCallback((w: number) => {
    // Remove any bubbles not connected to top row (floating)
    const grid = gridRef.current;
    const { cols } = computeGridSize(w, dimensions.h);
    const visited = new Set<string>();
    const key = (rr: number, cc: number) => rr + ':' + cc;
    const stack: { r: number; c: number }[] = [];
    for (let c = 0; c < cols; c++) {
      if (grid[0]?.[c]) stack.push({ r: 0, c });
    }
    while (stack.length) {
      const cur = stack.pop()!;
      if (visited.has(key(cur.r, cur.c))) continue;
      visited.add(key(cur.r, cur.c));
      const b = grid[cur.r][cur.c];
      if (!b) continue;
      for (const n of neighbors(cur.r, cur.c, w)) {
        if (n.b && !visited.has(key(n.r, n.c)) && n.b.color !== 'gray') stack.push({ r: n.r, c: n.c });
      }
    }
    let dropCount = 0;
    for (let r = 0; r < grid.length; r++) {
      const row = grid[r];
      for (let c = 0; c < row.length; c++) {
        const b = row[c];
        if (b && b.color !== 'gray' && !visited.has(key(r, c))) {
          row[c] = null;
          dropCount++;
        }
      }
    }
    if (dropCount > 0 && !muted) playCombo(Math.min(5, 1 + Math.floor(dropCount / 3)));
    return dropCount;
  }, [computeGridSize, dimensions.h, neighbors, muted]);

  const placeBubbleAt = useCallback((row: number, col: number, b: Bubble, w: number) => {
    const grid = gridRef.current;
    if (row < 0) row = 0;
    if (row >= grid.length) row = grid.length - 1;
    const maxCols = computeGridSize(w, dimensions.h).cols - (row % 2 === 1 ? 1 : 0);
    if (col < 0) col = 0;
    if (col >= maxCols) col = maxCols - 1;
    if (grid[row][col]) return false;
    const { x, y } = gridToXY(row, col, w);
    b.row = row; b.col = col; b.x = x; b.y = y; b.stationary = true;
    grid[row][col] = b;
    return true;
  }, [computeGridSize, dimensions.h, gridToXY]);

  const trySnapAndResolve = useCallback((b: Bubble, w: number, h: number) => {
    // Snap near collision point
    const guess = xyToGridGuess(b.x, b.y, w);
    const candidates = [
      { r: guess.row, c: guess.col },
      { r: guess.row, c: guess.col - 1 },
      { r: guess.row, c: guess.col + 1 },
      { r: guess.row - 1, c: guess.col },
      { r: guess.row + 1, c: guess.col },
      { r: guess.row - 1, c: guess.col - 1 },
      { r: guess.row + 1, c: guess.col + 1 },
    ];
    let placed = false;
    for (const cand of candidates) {
      if (placeBubbleAt(cand.r, cand.c, b, w)) { placed = true; break; }
    }
    if (!placed) return;

    // Resolve special kinds
    if (b.kind === 'bomb') {
      // Remove neighbors within distance 2 (grid steps)
      const around = new Set<string>();
      const queue = [{ r: b.row, c: b.col, d: 0 }];
      const seen = new Set<string>();
      const key = (r: number, c: number) => r + ':' + c;
      while (queue.length) {
        const cur = queue.shift()!;
        if (cur.d > 2) continue;
        const k = key(cur.r, cur.c);
        if (seen.has(k)) continue;
        seen.add(k);
        around.add(k);
        for (const n of neighbors(cur.r, cur.c, w)) {
          queue.push({ r: n.r, c: n.c, d: cur.d + 1 });
        }
      }
      let removed = 0;
      const grid = gridRef.current;
      for (const k of around) {
        const [rr, cc] = k.split(':').map(Number);
        const bb = grid[rr]?.[cc];
        if (bb && bb.color !== 'gray') { grid[rr][cc] = null; removed++; }
      }
      if (removed > 0 && !muted) playPop(Math.min(1.5, 0.5 + removed * 0.1));
      removeDisconnected(w);
      return;
    }
    if (b.kind === 'freeze') {
      powerRef.current.freezeUntil = Date.now() + 5000;
      // remove itself for fairness
      gridRef.current[b.row][b.col] = null;
      if (!muted) playPop(1);
      return;
    }
    if (b.kind === 'aim') {
      powerRef.current.aimBoostUntil = Date.now() + 6000;
      gridRef.current[b.row][b.col] = null;
      if (!muted) playPop(1);
      return;
    }

    // Normal or rainbow matching
    const targetColor = b.color;
    const group = floodMatch(b.row, b.col, targetColor, w);
    if (group.length >= 3) {
      // Remove matched
      const grid = gridRef.current;
      for (const cell of group) {
        grid[cell.r][cell.c] = null;
      }
      scoreRef.current += 10 * group.length;
      comboChainRef.current += 1;
      !muted && playPop(Math.min(1.5, 0.6 + group.length * 0.05));
      const dropped = removeDisconnected(w);
      if (dropped > 0) {
        scoreRef.current += 5 * dropped;
        onCombo();
      }
    } else {
      comboChainRef.current = 0;
    }
  }, [floodMatch, muted, neighbors, onCombo, placeBubbleAt, removeDisconnected, xyToGridGuess]);

  const shoot = useCallback((w: number, h: number) => {
    if (movingRef.current) return;
    const kind = nextQueueRef.current.shift() ?? 'normal';
    if (nextQueueRef.current.length < 2) refillNextQueue();

    const color: BubbleColor = (kind === 'rainbow' || kind === 'bomb' || kind === 'freeze' || kind === 'aim')
      ? colors[Math.floor(Math.random() * colors.length)] as BubbleColor
      : colors[Math.floor(Math.random() * colors.length)] as BubbleColor;

    const sx = w / 2;
    const sy = h - BUBBLE_RADIUS - 8;
    const dx = Math.cos(aimAngle);
    const dy = Math.sin(aimAngle);
    movingRef.current = { id: randId(), row: -1, col: -1, x: sx, y: sy, color, kind, stationary: false };
    dirRef.current = { dx, dy };
    onShot();
  }, [aimAngle, colors, onShot, refillNextQueue]);

  // Input handling
  useEffect(() => {
    const canvas = canvasRef.current!;
    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const ang = Math.atan2(y - (canvas.height - BUBBLE_RADIUS - 8), x - (canvas.width / 2));
      const clamped = clamp(ang, -Math.PI + 0.1, -0.1);
      setAimAngle(clamped);
    };
    const onTouch = (e: TouchEvent) => {
      if (!e.touches[0]) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.touches[0].clientX - rect.left;
      const y = e.touches[0].clientY - rect.top;
      const ang = Math.atan2(y - (canvas.height - BUBBLE_RADIUS - 8), x - (canvas.width / 2));
      const clamped = clamp(ang, -Math.PI + 0.1, -0.1);
      setAimAngle(clamped);
    };
    const onClick = () => shoot(canvas.width, canvas.height);
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('touchmove', onTouch, { passive: true });
    canvas.addEventListener('click', onClick);
    canvas.addEventListener('touchend', onClick);
    return () => {
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('touchmove', onTouch);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('touchend', onClick);
    };
  }, [shoot]);

  // Resize observer
  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(entries => {
      const cr = entries[0].contentRect;
      const w = Math.floor(cr.width);
      const h = Math.floor(cr.height);
      setDimensions({ w, h });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Init grid + next queue
  useEffect(() => {
    refillNextQueue();
  }, [refillNextQueue]);

  useEffect(() => {
    initGrid(dimensions.w, dimensions.h);
    scoreRef.current = 0;
    comboChainRef.current = 0;
    descentOffsetRef.current = 0;
    startMsRef.current = Date.now();
  }, [dimensions.h, dimensions.w, initGrid, level]);

  // Main loop
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;

    let last = performance.now();

    const loop = (now: number) => {
      const dt = Math.min(0.033, (now - last) / 1000);
      last = now;

      // Update descent
      const frozen = Date.now() < powerRef.current.freezeUntil;
      const descent = (frozen ? level.descentSpeed * 0.35 : level.descentSpeed) * dt;
      descentOffsetRef.current += descent;

      const addRowThreshold = ROW_V_SPACING;
      if (descentOffsetRef.current > addRowThreshold) {
        descentOffsetRef.current -= addRowThreshold;
        addNewDescendingRow(canvas.width, canvas.height);
      }

      // Update moving bubble
      const moving = movingRef.current;
      if (moving && dirRef.current) {
        moving.x += dirRef.current.dx * SHOOT_SPEED * dt;
        moving.y += dirRef.current.dy * SHOOT_SPEED * dt;
        // Bounce walls
        if (moving.x <= BUBBLE_RADIUS) { moving.x = BUBBLE_RADIUS; dirRef.current.dx *= -1; }
        if (moving.x >= canvas.width - BUBBLE_RADIUS) { moving.x = canvas.width - BUBBLE_RADIUS; dirRef.current.dx *= -1; }
        // Hit top
        if (moving.y <= BUBBLE_RADIUS + 2) {
          trySnapAndResolve(moving, canvas.width, canvas.height);
          movingRef.current = null;
          dirRef.current = null;
        } else {
          // Check collision with any stationary bubble (simple grid proximity scan)
          const grid = gridRef.current;
          outer: for (let r = 0; r < grid.length; r++) {
            for (let c = 0; c < grid[r].length; c++) {
              const b = grid[r][c];
              if (!b) continue;
              const dx = moving.x - b.x;
              const dy = moving.y - (b.y - 0); // descent already in y positions
              const dist = Math.hypot(dx, dy);
              if (dist < BUBBLE_DIAMETER - 1) {
                trySnapAndResolve(moving, canvas.width, canvas.height);
                movingRef.current = null;
                dirRef.current = null;
                break outer;
              }
            }
          }
        }
      }

      // Lose condition: any bubble near bottom
      const dangerLine = canvas.height - 64;
      const grid = gridRef.current;
      let lose = false;
      for (let r = 0; r < grid.length && !lose; r++) {
        for (let c = 0; c < grid[r].length && !lose; c++) {
          const b = grid[r][c];
          if (!b) continue;
          if (b.y + BUBBLE_RADIUS >= dangerLine) lose = true;
        }
      }
      if (lose) {
        gridRef.current = grid.map(row => row.map(() => null));
        if (!muted) playLose();
        onLoseLife();
        initGrid(canvas.width, canvas.height);
      }

      // Win condition: no colored bubbles except gray obstacles
      const remaining = gridRef.current.flat().filter(b => b && b.color !== 'gray');
      if (remaining.length === 0) {
        const elapsed = startMsRef.current ? Math.floor((Date.now() - startMsRef.current) / 1000) : 0;
        const timeBonus = Math.max(0, 500 - elapsed * 5);
        const levelScore = scoreRef.current + timeBonus + lives * 50;
        onWin(levelScore);
        return; // pause loop until re-init
      }

      // Time limit for certain levels
      if (level.timeLimitSec) {
        const elapsed = startMsRef.current ? (Date.now() - startMsRef.current) / 1000 : 0;
        if (elapsed > level.timeLimitSec) {
          if (!muted) playLose();
          onLoseLife();
          startMsRef.current = Date.now();
          initGrid(canvas.width, canvas.height);
        }
      }

      // Render
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // Draw guide
      const aimBoost = Date.now() < powerRef.current.aimBoostUntil;
      const guideLen = (reducedAim && !aimBoost) ? 60 : 220;
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = '#38bdf8';
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      const sx = canvas.width / 2;
      const sy = canvas.height - BUBBLE_RADIUS - 8;
      ctx.moveTo(sx, sy);
      let px = sx, py = sy, pdx = Math.cos(aimAngle), pdy = Math.sin(aimAngle);
      let remaining = guideLen;
      for (let i = 0; i < MAX_AIM_BOUNCES && remaining > 0; i++) {
        const t = remaining;
        let nx = px + pdx * t;
        let ny = py + pdy * t;
        if (nx < BUBBLE_RADIUS) { const over = BUBBLE_RADIUS - nx; nx = BUBBLE_RADIUS + over; pdx *= -1; }
        if (nx > canvas.width - BUBBLE_RADIUS) { const over = nx - (canvas.width - BUBBLE_RADIUS); nx = (canvas.width - BUBBLE_RADIUS) - over; pdx *= -1; }
        ctx.lineTo(nx, ny);
        remaining -= Math.hypot(nx - px, ny - py);
        px = nx; py = ny;
      }
      ctx.stroke();
      ctx.restore();

      // Draw bubbles
      for (let r = 0; r < grid.length; r++) {
        for (let c = 0; c < grid[r].length; c++) {
          const b = grid[r][c];
          if (!b) continue;
          drawBubble(ctx, b);
        }
      }
      if (movingRef.current) drawBubble(ctx, movingRef.current);

      // HUD
      ctx.save();
      ctx.font = 'bold 14px ui-sans-serif, system-ui';
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(`Score: ${scoreRef.current}`, 12, 20);
      if (level.timeLimitSec) {
        const elapsed = startMsRef.current ? (Date.now() - startMsRef.current) / 1000 : 0;
        const remain = Math.max(0, Math.ceil(level.timeLimitSec - elapsed));
        ctx.fillText(`Time: ${remain}s`, 12, 40);
      }
      if (Date.now() < powerRef.current.freezeUntil) ctx.fillText('Freeze active', 12, 60);
      if (Date.now() < powerRef.current.aimBoostUntil) ctx.fillText('Aim boost', 12, 80);
      ctx.restore();

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [addNewDescendingRow, initGrid, level, muted, onLoseLife, onWin, reducedAim]);

  const drawBubble = (ctx: CanvasRenderingContext2D, b: Bubble) => {
    const color = COLOR_TO_HEX[b.color];
    ctx.save();
    ctx.translate(b.x, b.y);
    const grad = ctx.createRadialGradient(-6, -6, 4, 0, 0, BUBBLE_RADIUS);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.15, color);
    grad.addColorStop(1, '#0b1220');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, BUBBLE_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    if (b.kind !== 'normal') {
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = 'bold 14px ui-sans-serif, system-ui';
      const label = b.kind === 'bomb' ? 'B' : b.kind === 'rainbow' ? '?' : b.kind === 'freeze' ? '?' : '?';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 0, 1);
    }
    if (b.color === 'gray') {
      ctx.strokeStyle = 'rgba(15,23,42,0.9)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, BUBBLE_RADIUS - 2, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  };

  return (
    <div ref={wrapRef} className="canvasWrap">
      <div className="hud">
        <span className="badge levelBadge">Level {level.level} ? {level.difficulty}</span>
        <span className="badge">Colors: {level.colorsCount}</span>
        {level.rainbowEnabled && <span className="badge">Rainbow On</span>}
        {level.timeLimitSec && <span className="badge">Timer</span>}
      </div>
      <canvas ref={canvasRef} className="canvas" width={dimensions.w} height={dimensions.h} />
      <div className="toast">Click/Tap to shoot ? Move to aim</div>
    </div>
  );
}
