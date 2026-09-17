// SNAKE BATTLE, the second party game: up to 4 snakes on one board. Eat food to grow.
// Run your head into a wall, yourself or another snake and you're out, and your body
// turns into food. The last snake left wins.
// The laptop runs the board (server/party/snake-round.js) and draws it on the big
// screen; phones only send turns. Pure logic: no timers, and randomness is passed in.

export const COLS = 32;
export const ROWS = 20;
export const START_LENGTH = 4;
export const SPAWN_MARGIN = 3; // cells between a spawn and the walls

// Speed in steps a second. It creeps up so a round can't stall forever.
export const START_STEPS_PER_SEC = 7;
export const SPEED_UP_BY = 0.5; // 0 keeps a steady speed
export const SPEED_UP_EVERY_MS = 20_000;
export const MAX_STEPS_PER_SEC = 10;

// Turns pressed faster than the snake moves wait their turn, up to this many.
export const MAX_QUEUED_TURNS = 2;
// Food on the board: one more than this per snake in the round (corpse food counts).
export const EXTRA_FOOD = 2;

export const DIRECTIONS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

// Where each slot starts, by colour: red, blue, yellow, green.
export const SPAWN_NAMES = ["TOP LEFT", "TOP RIGHT", "BOTTOM RIGHT", "BOTTOM LEFT"];

export function stepsPerSec(playedMs) {
  const ups = Math.floor(Math.max(0, playedMs) / SPEED_UP_EVERY_MS);
  return Math.min(MAX_STEPS_PER_SEC, START_STEPS_PER_SEC + ups * SPEED_UP_BY);
}

export const stepMsAt = (playedMs) => 1000 / stepsPerSec(playedMs);
export const foodTarget = (snakeCount) => snakeCount + EXTRA_FOOD;

// A slot's starting snake, head first. Slots 2 and 3 are slots 0 and 1 turned 180°,
// so every corner is the same distance from the walls and the snake ahead of it.
export function spawn(slot, cols = COLS, rows = ROWS) {
  const m = SPAWN_MARGIN;
  const cells = (fn) => Array.from({ length: START_LENGTH }, (_, i) => fn(START_LENGTH - 1 - i));
  switch (slot) {
    case 0:
      return { dir: "right", body: cells((i) => ({ x: m + i, y: m })) };
    case 1:
      return { dir: "down", body: cells((i) => ({ x: cols - 1 - m, y: m + i })) };
    case 2:
      return { dir: "left", body: cells((i) => ({ x: cols - 1 - m - i, y: rows - 1 - m })) };
    case 3:
      return { dir: "up", body: cells((i) => ({ x: m, y: rows - 1 - m - i })) };
    default:
      throw new Error(`no spawn for slot ${slot}`);
  }
}

const isReverse = (a, b) => DIRECTIONS[a].x === -DIRECTIONS[b].x && DIRECTIONS[a].y === -DIRECTIONS[b].y;

// slots: the slots (0-3) playing this round.
// layout (for tests): { snakes: { [slot]: { dir, body } }, food: [{ x, y }] } instead of the spawns.
export function createArena(slots, { cols = COLS, rows = ROWS, random = Math.random, layout = null } = {}) {
  const key = (c) => c.y * cols + c.x;
  const inside = (c) => c.x >= 0 && c.x < cols && c.y >= 0 && c.y < rows;
  const same = (a, b) => a.x === b.x && a.y === b.y;

  // slot -> { slot, dir, queue, body (head first), alive, cause }
  const snakes = new Map(
    slots.map((slot) => {
      const { dir, body } = layout?.snakes?.[slot] ?? spawn(slot, cols, rows);
      return [slot, { slot, dir, queue: [], body: body.map((c) => ({ x: c.x, y: c.y })), alive: true, cause: null }];
    })
  );
  // cell key -> { x, y, from } where `from` is the slot whose body it was, or null
  const food = new Map((layout?.food ?? []).map((c) => [key(c), { x: c.x, y: c.y, from: null }]));

  function liveCells() {
    const taken = new Set();
    for (const s of snakes.values()) if (s.alive) for (const c of s.body) taken.add(key(c));
    return taken;
  }

  function topUpFood() {
    const target = foodTarget(snakes.size);
    if (food.size >= target) return;
    const taken = liveCells();
    const free = [];
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const k = y * cols + x;
        if (!taken.has(k) && !food.has(k)) free.push({ x, y });
      }
    }
    while (food.size < target && free.length > 0) {
      const i = Math.min(free.length - 1, Math.floor(random() * free.length));
      const [cell] = free.splice(i, 1);
      food.set(key(cell), { x: cell.x, y: cell.y, from: null });
    }
  }

  // A dead snake's body becomes food, except where a live snake is or food already is.
  function dropCorpse(snake, covered) {
    for (const c of snake.body) {
      const k = key(c);
      if (!covered.has(k) && !food.has(k)) food.set(k, { x: c.x, y: c.y, from: snake.slot });
    }
  }

  topUpFood();

  return {
    // Queues a turn. Ignored when it repeats or reverses the last queued direction.
    turn(slot, dir) {
      const s = snakes.get(slot);
      if (!s || !s.alive || !Object.hasOwn(DIRECTIONS, dir)) return false;
      const last = s.queue.at(-1) ?? s.dir;
      if (dir === last || isReverse(dir, last) || s.queue.length >= MAX_QUEUED_TURNS) return false;
      s.queue.push(dir);
      return true;
    },

    // Moves every live snake one cell at the same time.
    step() {
      const moves = [...snakes.values()]
        .filter((s) => s.alive)
        .map((s) => {
          if (s.queue.length > 0) s.dir = s.queue.shift();
          const d = DIRECTIONS[s.dir];
          const head = { x: s.body[0].x + d.x, y: s.body[0].y + d.y };
          const onBoard = inside(head);
          // Growing keeps the tail, so the snake is one longer after this step.
          const grows = onBoard && food.has(key(head));
          const body = [head, ...(grows ? s.body : s.body.slice(0, -1))];
          return { s, head, onBoard, grows, body };
        });

      // Where everything is once every snake has moved: cell -> [{ slot, index }]
      const occupied = new Map();
      for (const m of moves) {
        m.body.forEach((c, index) => {
          if (index === 0 && !m.onBoard) return;
          const k = key(c);
          if (!occupied.has(k)) occupied.set(k, []);
          occupied.get(k).push({ slot: m.s.slot, index });
        });
      }

      const deaths = [];
      for (const m of moves) {
        const slot = m.s.slot;
        let cause = null;
        if (!m.onBoard) {
          cause = { type: "wall" };
        } else {
          const others = occupied.get(key(m.head)).filter((o) => !(o.slot === slot && o.index === 0));
          const headOn = others.find((o) => o.index === 0);
          // Two heads moving into each other's cells pass through each other unless caught here.
          const swap = moves.find((o) => o !== m && o.onBoard && same(o.head, m.s.body[0]) && same(m.head, o.s.body[0]));
          const own = others.find((o) => o.slot === slot);
          const other = others.find((o) => o.slot !== slot);
          if (headOn) cause = { type: "head", slot: headOn.slot };
          else if (swap) cause = { type: "head", slot: swap.s.slot };
          else if (own) cause = { type: "self" };
          else if (other) cause = { type: "body", slot: other.slot };
        }
        if (cause) deaths.push({ slot, cause });
      }

      const dying = new Set(deaths.map((d) => d.slot));
      const grew = [];
      const covered = new Set();
      for (const m of moves) {
        if (dying.has(m.s.slot)) continue;
        m.s.body = m.body;
        for (const c of m.body) covered.add(key(c));
        if (m.grows) {
          food.delete(key(m.head));
          grew.push(m.s.slot);
        }
      }
      for (const { slot, cause } of deaths) {
        const s = snakes.get(slot);
        s.alive = false;
        s.cause = cause;
        s.queue = [];
        // The body from before the fatal move: the snake never got into the wall.
        dropCorpse(s, covered);
      }
      topUpFood();
      return { deaths, grew };
    },

    // Takes a snake out without a crash (its player left). `leaveFood` is false before GO.
    kill(slot, cause, { leaveFood = true } = {}) {
      const s = snakes.get(slot);
      if (!s || !s.alive) return false;
      s.alive = false;
      s.cause = cause;
      s.queue = [];
      if (leaveFood) dropCorpse(s, liveCells());
      return true;
    },

    snake(slot) {
      const s = snakes.get(slot);
      return s ? { slot, dir: s.dir, alive: s.alive, length: s.body.length, cause: s.cause, body: s.body } : null;
    },

    get alive() {
      let n = 0;
      for (const s of snakes.values()) if (s.alive) n += 1;
      return n;
    },

    // Compact, for the big screen: bodies as flat [x, y, x, y, …], head first.
    snakes() {
      return [...snakes.values()].map((s) => ({
        slot: s.slot,
        dir: s.dir,
        alive: s.alive,
        length: s.body.length,
        body: s.alive ? s.body.flatMap((c) => [c.x, c.y]) : [],
      }));
    },

    // Flat [x, y, from, …]; `from` is -1 for ordinary food.
    food() {
      return [...food.values()].flatMap((f) => [f.x, f.y, f.from ?? -1]);
    },
  };
}
