// Sokoban solver: per-room push-optimal A*.
//
// The level is a hallway with one to four small rooms off it. Boxes never
// leave their room (a box pushed into the hallway is lost), so each room is
// solved on its own with a push-based A* search, and the room solutions are
// stitched together with plain walks along the hallway. Push-optimal per
// room means push-optimal for the whole level, since the level optimum is
// the sum of the room optima.
//
// Deterministic by construction: fixed direction order, a stable priority
// queue, and fixed work budgets (node-expansion caps). No clock is read,
// no randomness is used, nothing outside /input and /output is read.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Directions in fixed order: up, down, left, right.
const DIRS = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
];

// Fixed work budgets (node expansions). These bound the whole run without
// ever looking at the clock, so two runs produce byte-identical output.
const ROOM_EXPANSION_CAP = 400000;
const TOTAL_EXPANSION_CAP = 3000000;
let totalExpansions = 0;

type Level = {
  w: number;
  h: number;
  wall: Uint8Array;
  goal: Uint8Array;
  player: number;
  boxes: number[];
  goals: number[];
};

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goal = new Uint8Array(w * h);
  let player = -1;
  const boxes: number[] = [];
  const goals: number[] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') {
        goal[i] = 1;
        goals.push(i);
      }
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goal, player, boxes, goals };
}

function rowOf(i: number, w: number): number {
  return Math.floor(i / w);
}

// Breadth-first search from `from` over cells where pass[i] is 1.
// Returns the parent array (-1 unvisited, -2 the root) and visit order.
function bfs(from: number, pass: Uint8Array, w: number, h: number): { parent: Int32Array; order: number[] } {
  const parent = new Int32Array(pass.length).fill(-1);
  const order: number[] = [from];
  parent[from] = -2;
  for (let qi = 0; qi < order.length; qi++) {
    const cur = order[qi];
    const cx = cur % w;
    const cy = rowOf(cur, w);
    for (let k = 0; k < 4; k++) {
      const nx = cx + DIRS[k].dx;
      const ny = cy + DIRS[k].dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (pass[n] && parent[n] === -1) {
        parent[n] = cur;
        order.push(n);
      }
    }
  }
  return { parent, order };
}

// The move string walking from `from` to `to` along a BFS parent array,
// or null when `to` is unreachable. The parent array must come from a BFS
// rooted at `from` over the same passable set.
function pathFromParent(parent: Int32Array, from: number, to: number, w: number): string | null {
  if (parent[to] === -1) return null;
  const steps: string[] = [];
  let cur = to;
  while (cur !== from) {
    const p = parent[cur];
    if (p < 0) return null;
    const d = cur - p;
    if (d === 1) steps.push('r');
    else if (d === -1) steps.push('l');
    else if (d === w) steps.push('d');
    else if (d === -w) steps.push('u');
    else return null;
    cur = p;
  }
  steps.reverse();
  return steps.join('');
}

// A plain walk on the whole level from `from` to `to`, treating the given
// box cells as obstacles. Returns the move string or null.
function walkPath(level: Level, from: number, to: number, boxes: number[]): string | null {
  if (from === to) return '';
  const pass = new Uint8Array(level.w * level.h);
  for (let i = 0; i < pass.length; i++) pass[i] = level.wall[i] ? 0 : 1;
  for (const b of boxes) pass[b] = 0;
  pass[from] = 1;
  pass[to] = 1;
  const { parent } = bfs(from, pass, level.w, level.h);
  return pathFromParent(parent, from, to, level.w);
}

type Room = {
  floor: number[];
  floorSet: Uint8Array;
  entry: number;
  door: number;
  boxes: number[];
  goals: number[];
};

// Find the rooms: the player starts on the hallway row; each room opens
// onto it through one door cell in the neighbouring row. A room's floor is
// the flood fill from its door away from the hallway, plus the door itself.
// Returns null when the decomposition does not account for every box and
// every goal exactly once.
function findRooms(level: Level): Room[] | null {
  const { w, h, wall, player } = level;
  const hallRow = rowOf(player, w);
  const rooms: Room[] = [];
  const seenBox = new Uint8Array(w * h);
  const seenGoal = new Uint8Array(w * h);
  for (let side = -1; side <= 1; side += 2) {
    const doorRow = hallRow + side;
    if (doorRow < 0 || doorRow >= h) continue;
    for (let x = 0; x < w; x++) {
      const door = doorRow * w + x;
      if (wall[door]) continue;
      const entry = hallRow * w + x;
      if (wall[entry]) continue;
      // Flood the room interior: the door cell, plus floor cells on the
      // far side of the door row. Never step into the hallway row.
      const floorSet = new Uint8Array(w * h);
      const stack: number[] = [door];
      floorSet[door] = 1;
      while (stack.length > 0) {
        const cur = stack.pop() as number;
        const cx = cur % w;
        const cy = rowOf(cur, w);
        for (let k = 0; k < 4; k++) {
          const nx = cx + DIRS[k].dx;
          const ny = cy + DIRS[k].dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = ny * w + nx;
          if (wall[n] || floorSet[n]) continue;
          const beyond = side === -1 ? ny < doorRow : ny > doorRow;
          if (!beyond) continue;
          floorSet[n] = 1;
          stack.push(n);
        }
      }
      const floor: number[] = [];
      for (let i = 0; i < floorSet.length; i++) if (floorSet[i]) floor.push(i);
      if (floor.length < 2) continue;
      const boxes = level.boxes.filter((b) => floorSet[b]);
      const goals = level.goals.filter((g) => floorSet[g]);
      if (boxes.length === 0) continue;
      for (const b of boxes) {
        if (seenBox[b]) return null;
        seenBox[b] = 1;
      }
      for (const g of goals) {
        if (seenGoal[g]) return null;
        seenGoal[g] = 1;
      }
      rooms.push({ floor, floorSet, entry, door, boxes, goals });
    }
  }
  for (const b of level.boxes) if (!seenBox[b]) return null;
  for (const g of level.goals) if (!seenGoal[g]) return null;
  rooms.sort((a, b) => a.entry - b.entry);
  return rooms;
}

// All permutations of [0..n-1], in lexicographic order.
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Uint8Array(n);
  const rec = (): void => {
    if (cur.length === n) {
      out.push(cur.slice());
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = 1;
      cur.push(i);
      rec();
      cur.pop();
      used[i] = 0;
    }
  };
  rec();
  return out;
}

type HeapItem = { f: number; h: number; g: number; seq: number; key: string };

function heapLess(a: HeapItem, b: HeapItem): boolean {
  if (a.f !== b.f) return a.f < b.f;
  if (a.h !== b.h) return a.h < b.h;
  return a.seq < b.seq;
}

function heapPush(heap: HeapItem[], item: HeapItem): void {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!heapLess(heap[i], heap[p])) break;
    const t = heap[i];
    heap[i] = heap[p];
    heap[p] = t;
    i = p;
  }
}

function heapPop(heap: HeapItem[]): HeapItem {
  const top = heap[0];
  const last = heap.pop() as HeapItem;
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < heap.length && heapLess(heap[l], heap[m])) m = l;
      if (r < heap.length && heapLess(heap[r], heap[m])) m = r;
      if (m === i) break;
      const t = heap[i];
      heap[i] = heap[m];
      heap[m] = t;
      i = m;
    }
  }
  return top;
}

type Rec = {
  key: string;
  boxes: number[];
  player: number;
  g: number;
  h: number;
  parent: string | null;
  moves: string;
};

// Solve one room push-optimally with A* over pushes.
// floorSet: the room's floor cells plus the entry cell (the hallway square
// outside the door). Boxes may never be pushed onto the entry cell.
// startPlayer: where the player stands at the start (the entry cell for a
// room). The returned move string ends with the player standing on the
// entry cell again, so rooms stitch by hallway walks. entry -1 means no
// entry cell (the whole-level fallback): then no exit walk is appended.
// Returns null when no solution is found within the work budget.
function solveRoom(
  level: Level,
  floorSet: Uint8Array,
  entry: number,
  startPlayer: number,
  startBoxes: number[],
  roomGoals: number[],
): string | null {
  const { w, h, goal } = level;
  const size = w * h;
  const n = startBoxes.length;
  if (n !== roomGoals.length) return null;
  // The working floor is the room's floor plus the entry cell, so the
  // player can stand on it (to push a box off the door, and to walk out).
  // Boxes are still never pushed onto it: the dest === entry check below.
  const floor = floorSet.slice();
  if (entry >= 0) floor[entry] = 1;

  // Dead squares: a floor cell is live when a box there can still reach a
  // goal by pushes, ignoring other boxes. Reverse BFS from the goals: a
  // box on cell c can be pushed to a live neighbour n when the player can
  // stand on the far side of c (c - d must be floor).
  const live = new Uint8Array(size);
  const liveQueue: number[] = [];
  for (const g of roomGoals) {
    live[g] = 1;
    liveQueue.push(g);
  }
  for (let qi = 0; qi < liveQueue.length; qi++) {
    const cur = liveQueue[qi];
    const cx = cur % w;
    const cy = rowOf(cur, w);
    for (let k = 0; k < 4; k++) {
      const nx = cx - DIRS[k].dx;
      const ny = cy - DIRS[k].dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const c = ny * w + nx;
      if (!floor[c] || live[c]) continue;
      const sx = nx - DIRS[k].dx;
      const sy = ny - DIRS[k].dy;
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      const stance = sy * w + sx;
      if (!floor[stance]) continue;
      live[c] = 1;
      liveQueue.push(c);
    }
  }
  for (const b of startBoxes) {
    if (!live[b] && !goal[b]) return null;
  }

  // All-pairs walking distances over the room floor (boxes ignored).
  const floorCells: number[] = [];
  for (let i = 0; i < size; i++) if (floor[i]) floorCells.push(i);
  const dist = new Map<number, Int32Array>();
  for (const f of floorCells) {
    const d = new Int32Array(size).fill(-1);
    const { parent, order } = bfs(f, floor, w, h);
    // BFS order lists parents before children, so depths follow in one pass.
    d[f] = 0;
    for (const cell of order) {
      if (cell === f) continue;
      const p = parent[cell];
      d[cell] = d[p] + 1;
    }
    dist.set(f, d);
  }

  const perms = permutations(n);
  const hCache = new Map<string, number>();
  function heuristic(boxes: number[]): number {
    const key = boxes.join(',');
    const cached = hCache.get(key);
    if (cached !== undefined) return cached;
    let best = Infinity;
    for (const perm of perms) {
      let sum = 0;
      let ok = true;
      for (let i = 0; i < n; i++) {
        const dd = (dist.get(boxes[i]) as Int32Array)[roomGoals[perm[i]]];
        if (dd < 0) {
          ok = false;
          break;
        }
        sum += dd;
      }
      if (ok && sum < best) best = sum;
    }
    const value = best === Infinity ? 1000000 : best;
    hCache.set(key, value);
    return value;
  }

  function boxesKey(boxes: number[], canonPlayer: number): string {
    return boxes.join(',') + '|' + canonPlayer;
  }

  // Canonical player: the smallest cell of the player's reachable region.
  // Two player squares in one region are equivalent for future pushes, so
  // the region's minimum identifies the region exactly.
  function regionOf(player: number, boxes: number[]): { parent: Int32Array; order: number[]; min: number } {
    const pass = new Uint8Array(size);
    for (let i = 0; i < size; i++) pass[i] = floor[i] ? 1 : 0;
    for (const b of boxes) pass[b] = 0;
    pass[player] = 1;
    const { parent, order } = bfs(player, pass, w, h);
    let min = order[0];
    for (const cell of order) if (cell < min) min = cell;
    return { parent, order, min };
  }

  function solved(boxes: number[]): boolean {
    for (const b of boxes) if (!goal[b]) return false;
    return true;
  }

  // A 2x2 block of boxes can never be broken apart; it is a deadlock
  // unless every box in it already sits on a goal.
  function frozenBlock(boxes: number[], moved: number): boolean {
    const blocked = new Uint8Array(size);
    for (const b of boxes) blocked[b] = 1;
    const mx = moved % w;
    const my = rowOf(moved, w);
    for (let ox = -1; ox <= 0; ox++) {
      for (let oy = -1; oy <= 0; oy++) {
        const x0 = mx + ox;
        const y0 = my + oy;
        if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) continue;
        const cells = [y0 * w + x0, y0 * w + x0 + 1, (y0 + 1) * w + x0, (y0 + 1) * w + x0 + 1];
        let allBox = true;
        let allGoal = true;
        for (const c of cells) {
          if (!blocked[c]) allBox = false;
          if (!goal[c]) allGoal = false;
        }
        if (allBox && !allGoal) return true;
      }
    }
    return false;
  }

  const start = startBoxes.slice().sort((a, b) => a - b);
  const startRegion = regionOf(startPlayer, start);
  const startKey = boxesKey(start, startRegion.min);
  const h0 = heuristic(start);
  const records = new Map<string, Rec>();
  records.set(startKey, { key: startKey, boxes: start, player: startPlayer, g: 0, h: h0, parent: null, moves: '' });
  const bestG = new Map<string, number>();
  bestG.set(startKey, 0);
  const closed = new Set<string>();
  const heap: HeapItem[] = [];
  let seq = 0;
  heapPush(heap, { f: h0, h: h0, g: 0, seq: seq++, key: startKey });
  let expansions = 0;

  while (heap.length > 0) {
    const item = heapPop(heap);
    if (closed.has(item.key)) continue;
    const rec = records.get(item.key) as Rec;
    if (bestG.get(item.key) !== item.g) continue;
    closed.add(item.key);
    expansions++;
    totalExpansions++;
    if (expansions > ROOM_EXPANSION_CAP || totalExpansions > TOTAL_EXPANSION_CAP) return null;

    if (solved(rec.boxes)) {
      // With an entry cell, walk back out to it; if it is unreachable the
      // room is not finished from this state, so keep searching. Without
      // one (the whole-level fallback) the state itself is the answer.
      let exit = '';
      if (entry >= 0) {
        const region = regionOf(rec.player, rec.boxes);
        const walk = pathFromParent(region.parent, rec.player, entry, w);
        if (walk === null) continue;
        exit = walk;
      }
      const chain: string[] = [];
      let cur: Rec | undefined = rec;
      while (cur && cur.parent !== null) {
        chain.push(cur.moves);
        cur = records.get(cur.parent);
      }
      chain.reverse();
      return chain.join('') + exit;
    }

    const region = regionOf(rec.player, rec.boxes);
    const blocked = new Uint8Array(size);
    for (const b of rec.boxes) blocked[b] = 1;
    for (const b of rec.boxes) {
      const bx = b % w;
      const by = rowOf(b, w);
      for (let k = 0; k < 4; k++) {
        const d = DIRS[k];
        const sx = bx - d.dx;
        const sy = by - d.dy;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        const stance = sy * w + sx;
        if (region.parent[stance] === -1) continue;
        const dx2 = bx + d.dx;
        const dy2 = by + d.dy;
        if (dx2 < 0 || dy2 < 0 || dx2 >= w || dy2 >= h) continue;
        const dest = dy2 * w + dx2;
        if (!floor[dest] || (entry >= 0 && dest === entry) || blocked[dest]) continue;
        if (!live[dest] && !goal[dest]) continue;
        const nextBoxes = rec.boxes.slice();
        nextBoxes[nextBoxes.indexOf(b)] = dest;
        nextBoxes.sort((a, b2) => a - b2);
        if (frozenBlock(nextBoxes, dest)) continue;
        const walk = pathFromParent(region.parent, rec.player, stance, w);
        if (walk === null) continue;
        const nextRegion = regionOf(b, nextBoxes);
        const key = boxesKey(nextBoxes, nextRegion.min);
        const g2 = rec.g + 1;
        if (closed.has(key)) continue;
        const prevG = bestG.get(key);
        if (prevG !== undefined && prevG <= g2) continue;
        const h2 = heuristic(nextBoxes);
        bestG.set(key, g2);
        records.set(key, {
          key,
          boxes: nextBoxes,
          player: b,
          g: g2,
          h: h2,
          parent: rec.key,
          moves: walk + d.ch,
        });
        heapPush(heap, { f: g2 + h2, h: h2, g: g2, seq: seq++, key });
      }
    }
  }
  return null;
}

// Solve one whole level. Returns the move string, or '' when unsolved
// (an empty answer is valid and scores 0, never illegal).
function solveInstance(level: Level): string {
  const rooms = findRooms(level);
  if (rooms !== null) {
    let moves = '';
    let cur = level.player;
    const curBoxes = level.boxes.slice();
    for (const room of rooms) {
      const sol = solveRoom(level, room.floorSet, room.entry, room.entry, room.boxes, room.goals);
      if (sol === null) return '';
      const walk = walkPath(level, cur, room.entry, curBoxes);
      if (walk === null) return '';
      moves += walk + sol;
      cur = room.entry;
      for (let i = 0; i < curBoxes.length; i++) {
        if (room.boxes.includes(curBoxes[i])) curBoxes[i] = room.goals[room.boxes.indexOf(curBoxes[i])];
      }
      curBoxes.sort((a, b) => a - b);
    }
    return moves;
  }
  // Decomposition failed: fall back to solving the whole level as one
  // room (entry -1: no entry cell, so boxes are free everywhere on the
  // floor and no exit walk is needed). This is far too big to finish
  // within budget on a multi-room level, so it normally just returns an
  // empty answer, but it is correct on small levels.
  const floorSet = new Uint8Array(level.w * level.h);
  for (let i = 0; i < floorSet.length; i++) floorSet[i] = level.wall[i] ? 0 : 1;
  const sol = solveRoom(level, floorSet, -1, level.player, level.boxes, level.goals);
  return sol === null ? '' : sol;
}

function main(): void {
  let ids: string[] = [];
  try {
    ids = readdirSync(INPUT_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    ids = ['i001', 'i002', 'i003', 'i004', 'i005'];
  }
  if (ids.length === 0) ids = ['i001', 'i002', 'i003', 'i004', 'i005'];
  for (const id of ids) {
    let moves = '';
    try {
      const text = readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8');
      const level = parseLevel(text);
      moves = solveInstance(level);
    } catch {
      moves = '';
    }
    if (moves.length > 65536) moves = '';
    try {
      mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
      writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), moves, 'utf8');
    } catch {
      // Nothing else to do: the run still answers the other instances.
    }
  }
}

main();
