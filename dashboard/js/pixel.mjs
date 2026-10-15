// Pixel art: authored 9×9 icons, Orchy's sprite (traced from assets/images/lilorchy_svg.svg),
// and a generator that gives every agent its own robot sibling of Orchy.
import { esc, wsInk } from './util.mjs';

/** Turn rows of '#' into an SVG path, merging horizontal runs. */
export function bitmapPath(rows, ch = '#', ox = 0, oy = 0) {
  let d = '';
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] === ch) {
        let w = 1;
        while (row[x + w] === ch) w++;
        d += `M${x + ox} ${y + oy}h${w}v1h-${w}z`;
        x += w;
      } else x++;
    }
  });
  return d;
}

// ── Icons (9×9, authored) ──
const I = {
  phone: ['.##......', '###......', '###......', '.##......', '..##.....', '...##..##', '....#####', '.....####', '.......#.'],
  mic: ['...###...', '...###...', '...###...', '...###...', '.#.###.#.', '.#.....#.', '..#####..', '....#....', '..#####..'],
  send: ['.....#...', '.....##..', '.....###.', '#########', '#########', '.....###.', '.....##..', '.....#...', '.........'],
  logs: ['.#######.', '.#.....#.', '.#.###.#.', '.#.....#.', '.#.###.#.', '.#.....#.', '.#.##..#.', '.#.....#.', '.#######.'],
  plug: ['..#...#..', '..#...#..', '.#######.', '.#######.', '.#######.', '..#####..', '...###...', '....#....', '....#....'],
  gear: ['....#....', '.#.###.#.', '..#####..', '.###.###.', '###...###', '.###.###.', '..#####..', '.#.###.#.', '....#....'],
  close: ['##.....##', '###...###', '.###.###.', '..#####..', '...###...', '..#####..', '.###.###.', '###...###', '##.....##'],
  min: ['.........', '.........', '.........', '.........', '.........', '.........', '.........', '#########', '#########'],
  plus: ['...###...', '...###...', '...###...', '#########', '#########', '#########', '...###...', '...###...', '...###...'],
  play: ['.#.......', '.##......', '.###.....', '.####....', '.#####...', '.####....', '.###.....', '.##......', '.#.......'],
  stop: ['.........', '.#######.', '.#######.', '.#######.', '.#######.', '.#######.', '.#######.', '.#######.', '.........'],
  check: ['.........', '........#', '.......##', '......##.', '#....##..', '##..##...', '.####....', '..##.....', '.........'],
  bang: ['...###...', '...###...', '...###...', '...###...', '...###...', '.........', '...###...', '...###...', '.........'],
  ask: ['..#####..', '.##...##.', '......##.', '.....##..', '....##...', '....##...', '.........', '....##...', '....##...'],
  clock: ['..#####..', '.#.....#.', '#...#...#', '#...#...#', '#...###.#', '#.......#', '#.......#', '.#.....#.', '..#####..'],
  term: ['#########', '#.......#', '#.#.....#', '#..#....#', '#...#...#', '#..#....#', '#.#..##.#', '#.......#', '#########'],
  chat: ['#########', '#.......#', '#.#####.#', '#.......#', '#.###...#', '#.......#', '#########', '..##.....', '.#.......'],
  user: ['...###...', '..#####..', '..#####..', '...###...', '.........', '.#######.', '#########', '#########', '#########'],
  refresh: ['..####.#.', '.#....##.', '#....###.', '#........', '#.......#', '........#', '.###....#', '.##....#.', '.#.####..'],
  trash: ['...###...', '#########', '.........', '.#######.', '.#.#.#.#.', '.#.#.#.#.', '.#.#.#.#.', '.#.#.#.#.', '.#######.'],
  edit: ['......##.', '.....####', '....####.', '...####..', '..####...', '.####....', '.###.....', '##.......', '#........'],
  sun: ['#...#...#', '.#.....#.', '...###...', '..#####..', '#.#####.#', '..#####..', '...###...', '.#.....#.', '#...#...#'],
  moon: ['...###...', '..##.....', '.##......', '.##......', '.##......', '.##......', '.##....#.', '..##..##.', '...####..'],
  speaker: ['....#....', '...##..#.', '#####...#', '#####.#.#', '#####.#.#', '#####...#', '...##..#.', '....#....', '.........'],
  mute: ['....#....', '...##....', '#####.#.#', '#####..#.', '#####.#.#', '#####....', '...##....', '....#....', '.........'],
  bolt: ['.....##..', '....##...', '...##....', '..######.', '.....##..', '....##...', '...##....', '..##.....', '.#.......'],
  x: ['.........', '.#.....#.', '..#...#..', '...#.#...', '....#....', '...#.#...', '..#...#..', '.#.....#.', '.........'],
  clip: ['...###...', '..#...#..', '..#.#.#..', '..#.#.#..', '..#.#.#..', '..#.#.#..', '..#.#.#..', '..#...#..', '...###...'],
  doc: ['######...', '#....##..', '#....###.', '#......#.', '#.####.#.', '#......#.', '#.####.#.', '#......#.', '########.'],
  key: ['.###.....', '#...#....', '#...#####', '#...#.#.#', '.###..#.#', '.........', '.........', '.........', '.........'],
  eye: ['.........', '..#####..', '.#.....#.', '#..###..#', '#..###..#', '.#.....#.', '..#####..', '.........', '.........'],
  hand: ['...#.#...', '.#.#.#.#.', '.#.#.#.#.', '.#######.', '########.', '#.######.', '..#####..', '...###...', '...###...'],
  spark: ['....#....', '....#....', '...###...', '#########', '...###...', '....#....', '....#....', '.........', '.........'],
  home: ['....#....', '...###...', '..##.##..', '.##...##.', '##.....##', '.#.....#.', '.#.###.#.', '.#.#.#.#.', '.###.###.'],
  huddle: ['.##...##.', '####.####', '####.####', '.##...##.', '.........', '###.#.###', '####.####', '####.####', '####.####'],
  team: ['....#....', '..#####..', '.#######.', '.##.#.##.', '.#######.', '#.#...#.#', '#.#####.#', '..##.##..', '..##.##..'],
  left: ['.....##..', '....###..', '...###...', '..###....', '.###.....', '..###....', '...###...', '....###..', '.....##..'],
  right: ['..##.....', '..###....', '...###...', '....###..', '.....###.', '....###..', '...###...', '..###....', '..##.....'],
  popout: ['.....####', '.......##', '####..#.#', '#....#..#', '#...#....', '#.....#..', '#.....#..', '#.....#..', '#######..'],
  popin: ['........#', '.......#.', '#####.#..', '#....#...', '#.#.#....', '#.##....#', '#.###...#', '#.......#', '#########'],
};

export function icon(name, cls = 'ico') {
  const rows = I[name] || I.bang;
  return `<svg class="${cls} px-art" viewBox="0 0 9 9" aria-hidden="true" focusable="false"><path d="${bitmapPath(rows)}"/></svg>`;
}

// ── Orchy ──
// 11 wide × 13 tall robot; placed on a 15×15 tile with pixel-rounded corners.
const ORCHY = [
  '...#...#...', // 0 antenna tips
  '....#.#....', // 1 antenna
  '....###....', // 2 dome
  '.#########.', // 3 head top
  '.#########.', // 4
  '.##.###.##.', // 5 eyes
  '###########', // 6 arms
  '###########', // 7 arms
  '.###.#.###.', // 8 mouth corners
  '.####.####.', // 9 mouth middle
  '.#########.', // 10
  '..##...##..', // 11 legs
  '..##...##..', // 12 legs
];

function setPx(rows, x, y, ch) {
  if (y < 0 || y >= rows.length || x < 0 || x >= rows[y].length) return;
  rows[y] = rows[y].slice(0, x) + ch + rows[y].slice(x + 1);
}

/** Orchy frame for a state + tick. Returns {robot, accent} bitmap rows. */
export function orchyFrame(state = 'idle', tick = 0) {
  const r = ORCHY.slice();
  const accent = r.map(() => '.'.repeat(11)); // pixels drawn in --decide
  const eyes = (dy = 0, dx = 0) => {
    for (const ex of [3, 7]) { setPx(r, ex, 5, '#'); }
    for (const ex of [3, 7]) setPx(r, ex + dx, 5 + dy, '.');
  };
  if (state === 'idle') {
    const blink = tick % 28 === 0 || tick % 28 === 1;
    if (blink) { setPx(r, 3, 5, '#'); setPx(r, 7, 5, '#'); setPx(r, 3, 6, '#'); setPx(r, 7, 6, '#'); }
  }
  if (state === 'listening') {
    eyes(-1, 0);
    if (tick % 4 < 2) { setPx(accent, 3, 0, 'y'); setPx(accent, 7, 0, 'y'); }
  }
  if (state === 'routing' || state === 'thinking') {
    eyes(0, tick % 6 < 3 ? -1 : 1);
    setPx(accent, tick % 2 ? 3 : 7, 0, 'y');
  }
  if (state === 'speaking') {
    if (tick % 2) {
      // open mouth
      r[8] = '.###...###.';
      r[9] = '.###...###.';
    }
    setPx(accent, 3, 0, 'y'); setPx(accent, 7, 0, 'y');
  }
  if (state === 'alert') {
    setPx(r, 3, 4, '.'); setPx(r, 7, 4, '.');
    if (tick % 4 < 2) { setPx(accent, 3, 0, 'y'); setPx(accent, 7, 0, 'y'); setPx(accent, 4, 1, 'y'); setPx(accent, 6, 1, 'y'); }
  }
  if (state === 'happy') {
    setPx(r, 3, 5, '#'); setPx(r, 7, 5, '#');
    for (const ex of [3, 7]) { setPx(r, ex, 4, '.'); setPx(r, ex - 1, 5, '.'); setPx(r, ex + 1, 5, '.'); }
    r[8] = '.##.....##.';
    r[9] = '.###...###.';
  }
  // accent pixels are punched out of the robot layer
  accent.forEach((row, y) => [...row].forEach((c, x) => { if (c === 'y') setPx(r, x, y, '.'); }));
  return { robot: r, accent };
}

/** n×n tile with 2-pixel rounded corners, offset o pixels. */
function tilePathAt(n, o) {
  const rows = [];
  for (let y = 0; y < n; y++) {
    let r = '';
    for (let x = 0; x < n; x++) {
      const cx = Math.min(x, n - 1 - x), cy = Math.min(y, n - 1 - y);
      r += (cx === 0 && cy < 2) || (cy === 0 && cx < 2) ? '.' : '#';
    }
    rows.push(r);
  }
  return bitmapPath(rows, '#', o, o);
}

/** Orchy as the brand tile: black tile, white robot, a one-pixel keyline so it reads on any ground. */
export function orchySVG(state = 'idle', tick = 0, { label = 'Orchy' } = {}) {
  const { robot, accent } = orchyFrame(state, tick);
  return `<svg class="px-art" viewBox="0 0 17 17" role="img" aria-label="${esc(label)}">
    <path d="${tilePathAt(17, 0)}" fill="var(--on-shell)"/>
    <path d="${tilePathAt(15, 1)}" fill="var(--shell)"/>
    <path d="${bitmapPath(robot, '#', 3, 2)}" fill="var(--on-shell)"/>
    <path d="${bitmapPath(accent, 'y', 3, 2)}" fill="var(--decide)"/>
  </svg>`;
}

/** Top bar Orchy: the same brand tile, labelled with its state. */
export function orchyTopbarSVG(state, tick) {
  return orchySVG(state, tick, { label: `Orchy is ${state}` });
}

// ── Orchy's stage: the brand tile grown to 21×21 so Orchy has headroom to hop ──
// pose: 'stand' | 'crouch' | 'up' (arms raised).  dy: tile pixels up (negative) from standing.
const STAGE = 21;
const OX = 5;          // robot x on the stage
const OY = 5;          // robot y when standing (feet on row 17, floor on row 18)
const SPARKS = [[2, 11], [18, 10], [3, 16], [17, 15]]; // clear of the raised arms at the peak

export function orchyStageSVG({ state = 'idle', tick = 0, pose = 'stand', dy = 0, floor = 9, sparkle = false, accentAntenna = false, label = 'Orchy' } = {}) {
  const face = pose === 'stand' ? state : 'happy';
  let { robot, accent } = orchyFrame(face, tick);
  robot = robot.slice(); accent = accent.slice();
  let extra = '';
  if (pose === 'crouch') {
    // knees bend: head drops one pixel, legs fold to one row
    robot = ['.'.repeat(11), ...robot.slice(0, 11), robot[12]];
    accent = ['.'.repeat(11), ...accent.slice(0, 11), accent[12]];
  }
  const y0 = OY + dy;
  if (pose === 'up') {
    // \o/ : arms leave the sides and go up past the head
    setPx(robot, 0, 7, '.'); setPx(robot, 10, 7, '.');
    for (const [x, y] of [[-1, 5], [-1, 4], [-1, 3], [-2, 2], [11, 5], [11, 4], [11, 3], [12, 2]]) extra += `M${OX + x} ${y0 + y}h1v1h-1z`;
  }
  if (accentAntenna) { setPx(accent, 3, 0, 'y'); setPx(accent, 7, 0, 'y'); setPx(robot, 3, 0, '.'); setPx(robot, 7, 0, '.'); }
  // the floor shadow: a dithered strip that shrinks while Orchy is in the air
  let fl = '';
  const half = Math.floor(floor / 2);
  for (let x = 10 - half; x <= 10 + half; x++) if ((x + 18) % 2 === 0) fl += `M${x} 18h1v1h-1z`;
  let sp = '';
  if (sparkle) for (const [i, [x, y]] of SPARKS.entries()) {
    if ((i + tick) % 2) sp += `M${x - 1} ${y}h3v1h-3zM${x} ${y - 1}h1v3h-1z`;
    else sp += `M${x} ${y}h1v1h-1z`;
  }
  return `<svg class="px-art" viewBox="0 0 ${STAGE} ${STAGE}" role="img" aria-label="${esc(label)}">
    <path d="${tilePathAt(STAGE, 0)}" fill="var(--on-shell)"/>
    <path d="${tilePathAt(STAGE - 2, 1)}" fill="var(--shell)"/>
    <path d="${fl}" fill="var(--on-shell)"/>
    <path d="${sp}" fill="var(--on-shell)"/>
    <path d="${bitmapPath(robot, '#', OX, y0)}${extra}" fill="var(--on-shell)"/>
    <path d="${bitmapPath(accent, 'y', OX, y0)}" fill="var(--decide)"/>
  </svg>`;
}

// ── Agent sprites: deterministic Orchy siblings ──
function hash(str) {
  let h = 2166136261;
  for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let s = seed || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 10000) / 10000; };
}

// The Chief of AI Agents: Orchy's body wearing a crown instead of the antenna.
const CHIEF = [
  '.#...#...#.',
  '.##.###.##.',
  '.#########.',
  '...........',
  '.#########.',
  '.##.###.##.',
  '###########',
  '###########',
  '.###.#.###.',
  '.####.####.',
  '.#########.',
  '..##...##..',
  '..##...##..',
];

export function agentBitmap(seedText, { chief = false } = {}) {
  if (chief) return CHIEF.slice();
  const R = rng(hash(seedText));
  const pick = arr => arr[Math.floor(R() * arr.length)];
  const blank = () => Array.from({ length: 13 }, () => '.'.repeat(11));
  const g = blank();
  const fill = (x0, x1, y) => { for (let x = x0; x <= x1; x++) setPx(g, x, y, '#'); };
  const narrow = R() < 0.4;
  const [hx0, hx1] = narrow ? [2, 8] : [1, 9];
  const top = pick([3, 3, 4]);
  // head/body
  for (let y = top; y <= 10; y++) fill(hx0, hx1, y);
  // antenna
  const ant = pick(['v', 'single', 'bulb', 'none', 'triple', 'bent']);
  if (ant === 'v') { setPx(g, 3, top - 3, '#'); setPx(g, 7, top - 3, '#'); setPx(g, 4, top - 2, '#'); setPx(g, 6, top - 2, '#'); fill(4, 6, top - 1); }
  if (ant === 'single') { setPx(g, 5, top - 3, '#'); setPx(g, 5, top - 2, '#'); fill(4, 6, top - 1); }
  if (ant === 'bulb') { fill(4, 6, top - 3); setPx(g, 5, top - 2, '#'); setPx(g, 5, top - 1, '#'); }
  if (ant === 'triple') { for (const x of [3, 5, 7]) { setPx(g, x, top - 2, '#'); setPx(g, x, top - 1, '#'); } }
  if (ant === 'bent') { setPx(g, 7, top - 3, '#'); setPx(g, 6, top - 3, '#'); setPx(g, 6, top - 2, '#'); setPx(g, 5, top - 1, '#'); }
  // arms
  const arms = pick(['stub', 'stub', 'none', 'up', 'down']);
  const ay = top + 3;
  if (arms === 'stub') { for (const y of [ay, ay + 1]) { setPx(g, hx0 - 1, y, '#'); setPx(g, hx1 + 1, y, '#'); } }
  if (arms === 'up') { for (const y of [ay - 2, ay - 1, ay]) { setPx(g, hx0 - 1, y, '#'); setPx(g, hx1 + 1, y, '#'); } }
  if (arms === 'down') { for (const y of [ay, ay + 1, ay + 2, ay + 3]) { setPx(g, hx0 - 1, y, '#'); setPx(g, hx1 + 1, y, '#'); } }
  // eyes (holes)
  const ey = top + 2;
  const eyes = pick(['dots', 'dots', 'wide', 'visor', 'cyclops', 'tall']);
  if (eyes === 'dots') { setPx(g, 3, ey, '.'); setPx(g, 7, ey, '.'); }
  if (eyes === 'wide') { setPx(g, 3, ey, '.'); setPx(g, 4, ey, '.'); setPx(g, 6, ey, '.'); setPx(g, 7, ey, '.'); }
  if (eyes === 'visor') { for (let x = hx0 + 1; x <= hx1 - 1; x++) setPx(g, x, ey, '.'); setPx(g, 5, ey, '#'); }
  if (eyes === 'cyclops') { for (const x of [4, 5, 6]) setPx(g, x, ey, '.'); setPx(g, 5, ey - 1, '.'); }
  if (eyes === 'tall') { for (const y of [ey - 1, ey]) { setPx(g, 3, y, '.'); setPx(g, 7, y, '.'); } }
  // mouth (holes)
  const my = Math.min(top + 5, 9);
  const mouth = pick(['smile', 'smile', 'flat', 'o', 'teeth', 'grin']);
  if (mouth === 'smile') { setPx(g, 4, my, '.'); setPx(g, 6, my, '.'); setPx(g, 5, my + 1, '.'); }
  if (mouth === 'flat') { for (const x of [4, 5, 6]) setPx(g, x, my, '.'); }
  if (mouth === 'o') { setPx(g, 5, my, '.'); setPx(g, 5, my + 1, '.'); }
  if (mouth === 'teeth') { for (const x of [3, 5, 7]) setPx(g, x, my, '.'); }
  if (mouth === 'grin') { for (const x of [3, 4, 5, 6, 7]) setPx(g, x, my, '.'); setPx(g, 3, my - 1, '.'); setPx(g, 7, my - 1, '.'); }
  // legs
  const legs = pick(['two', 'two', 'tread', 'one']);
  if (legs === 'two') { for (const y of [11, 12]) { fill(hx0 + 1, hx0 + 2, y); fill(hx1 - 2, hx1 - 1, y); } }
  if (legs === 'tread') { fill(hx0, hx1, 12); for (let x = hx0 + 1; x <= hx1 - 1; x += 2) setPx(g, x, 11, '#'); }
  if (legs === 'one') { fill(4, 6, 11); fill(3, 7, 12); }
  return g;
}

/** Agent sprite SVG on its workspace's ink tile (each workspace its own tint, from its `color`). */
export function agentSVG(seedText, ws, { chief = false, label = '' } = {}) {
  const g = agentBitmap(seedText, { chief });
  const { bg: tile, fg } = wsInk(ws);
  return `<svg class="px-art" viewBox="0 0 15 15" role="img" aria-label="${esc(label)}">
    <path d="${tilePathAt(15, 0)}" fill="${tile}"/>
    <path d="${bitmapPath(g, '#', 2, 1)}" fill="${fg}"/>
  </svg>`;
}

/** Reveal a sprite row by row (the "hatch"). */
export function hatch(svgEl) {
  if (!svgEl || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let row = 0;
  svgEl.style.clipPath = 'inset(100% 0 0 0)';
  const t = setInterval(() => {
    row++;
    svgEl.style.clipPath = `inset(${Math.max(0, 100 - row * (100 / 15))}% 0 0 0)`;
    if (row >= 15) { clearInterval(t); svgEl.style.clipPath = ''; }
  }, 50);
}

export function createEl(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
