// MEMORY MATCH: find all 8 pairs. Every card is shown for 2 seconds first.
// +100 per pair, +50 for each pair in a row, and a time bonus for finishing under 90s.
import { createLoop, TICK_HZ } from "../engine/loop.js";
import { formatScore } from "../ui/format.js";

const PEEK_MS = 2000;
const MISMATCH_MS = 750;
const TIME_LIMIT_SEC = 120;
const BONUS_UNDER_SEC = 90;
const PAIR_POINTS = 100;
const STREAK_POINTS = 50;
const TIME_POINTS = 10;

const SYMBOLS = [
  { id: "triangle", shape: "triangle", color: "green" },
  { id: "flower", shape: "flower", color: "blue" },
  { id: "blob", shape: "blob", color: "yellow" },
  { id: "circle", shape: "circle", color: "red" },
  { id: "tag", text: "</>", color: "ink" },
  { id: "braces", text: "{ }", color: "blue" },
  { id: "hash", text: "#", color: "red" },
  { id: "semi", text: ";", color: "green" },
];

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function faceHtml(symbol) {
  if (symbol.shape) {
    return `<svg class="shape shape--${symbol.color} memory-card__shape" aria-hidden="true"><use href="assets/shapes.svg#${symbol.shape}"/></svg>`;
  }
  return `<span class="memory-card__glyph memory-card__glyph--${symbol.color}" aria-hidden="true">${symbol.text}</span>`;
}

export function mount(root, { onScore, onGameOver }) {
  const el = document.createElement("div");
  el.className = "memory";
  el.innerHTML = `
    <div class="memory__hud">
      <span class="memory__stat"><span class="t-small">SCORE</span> <span class="t-score" data-hud="score">0</span></span>
      <span class="memory__stat"><span class="t-small">STREAK</span> <span class="t-score" data-hud="streak">0</span></span>
      <span class="memory__stat"><span class="t-small">TIME LEFT</span> <span class="t-score" data-hud="time">2:00</span></span>
    </div>
    <div class="memory__grid" role="group" aria-label="Memory cards"></div>
    <p class="t-small memory__tip">FINISH IN UNDER 90 SECONDS FOR A TIME BONUS.</p>`;
  root.append(el);

  const grid = el.querySelector(".memory__grid");
  const hud = {
    score: el.querySelector("[data-hud=score]"),
    streak: el.querySelector("[data-hud=streak]"),
    time: el.querySelector("[data-hud=time]"),
  };

  const deck = shuffle([...SYMBOLS, ...SYMBOLS]).map((symbol, i) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "memory-card";
    button.setAttribute("aria-label", "Hidden card");
    button.innerHTML = `
      <span class="memory-card__inner">
        <span class="memory-card__face memory-card__back" aria-hidden="true">&lt; &gt;</span>
        <span class="memory-card__face memory-card__front">${faceHtml(symbol)}</span>
      </span>`;
    grid.append(button);
    const card = { symbol, button, index: i, open: false, matched: false };
    button.addEventListener("click", () => flip(card));
    return card;
  });

  let phase = "idle";
  let open = [];
  let locked = false;
  let score = 0;
  let streak = 0;
  let matches = 0;
  let playTicks = 0;
  let shownSecond = -1;
  const timers = new Set();

  function later(fn, ms) {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  }

  function setOpen(card, isOpen) {
    card.open = isOpen;
    card.button.classList.toggle("is-open", isOpen);
    card.button.setAttribute("aria-label", isOpen || card.matched ? `Card ${card.symbol.id}` : "Hidden card");
  }

  function pop(text, card, color = "yellow") {
    const badge = document.createElement("span");
    badge.className = `badge pop-in memory__pop memory__pop--${color}`;
    badge.textContent = text;
    if (card) {
      badge.style.left = `${card.button.offsetLeft + card.button.offsetWidth / 2}px`;
      badge.style.top = `${card.button.offsetTop + 10}px`;
    } else {
      badge.style.left = "50%";
      badge.style.top = "45%";
    }
    grid.append(badge);
    later(() => badge.remove(), 1100);
  }

  function addScore(points) {
    score += points;
    hud.score.textContent = formatScore(score);
    onScore(score);
  }

  function flip(card) {
    if (phase !== "play" || locked || card.open || card.matched) return;
    setOpen(card, true);
    open.push(card);
    if (open.length < 2) return;

    const [a, b] = open;
    open = [];
    if (a.symbol.id === b.symbol.id) {
      a.matched = true;
      b.matched = true;
      a.button.classList.add("is-matched");
      b.button.classList.add("is-matched");
      streak += 1;
      matches += 1;
      const points = PAIR_POINTS + STREAK_POINTS * (streak - 1);
      addScore(points);
      hud.streak.textContent = String(streak);
      pop(`+${points}`, b, streak > 1 ? "green" : "yellow");
      if (matches === SYMBOLS.length) finish(true);
    } else {
      streak = 0;
      hud.streak.textContent = "0";
      locked = true;
      a.button.classList.add("is-wrong");
      b.button.classList.add("is-wrong");
      later(() => {
        a.button.classList.remove("is-wrong");
        b.button.classList.remove("is-wrong");
        setOpen(a, false);
        setOpen(b, false);
        locked = false;
      }, MISMATCH_MS);
    }
  }

  function finish(cleared) {
    phase = "done";
    loop.stop();
    let delay = 500;
    if (cleared) {
      const seconds = Math.floor(playTicks / TICK_HZ);
      const bonus = Math.max(0, BONUS_UNDER_SEC - seconds) * TIME_POINTS;
      if (bonus > 0) {
        addScore(bonus);
        pop(`TIME BONUS +${bonus}`, null, "green");
        delay = 1300;
      }
    } else {
      for (const card of deck) if (!card.matched) setOpen(card, true);
      delay = 1200;
    }
    later(() => onGameOver(score), delay);
  }

  function update() {
    if (phase !== "play") return;
    playTicks += 1;
    if (playTicks >= TIME_LIMIT_SEC * TICK_HZ) finish(false);
  }

  function render() {
    const left = Math.max(0, TIME_LIMIT_SEC - Math.floor(playTicks / TICK_HZ));
    if (left !== shownSecond) {
      shownSecond = left;
      hud.time.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
      hud.time.classList.toggle("is-low", left <= 15);
    }
  }

  const loop = createLoop({ update, render });

  return {
    start() {
      phase = "peek";
      deck.forEach((card) => setOpen(card, true));
      later(() => {
        deck.forEach((card) => setOpen(card, false));
        phase = "play";
        loop.start();
        deck[0].button.focus({ preventScroll: true });
      }, PEEK_MS);
    },
    input() {},
    get ticks() {
      return loop.ticks;
    },
    destroy() {
      timers.forEach(clearTimeout);
      loop.destroy();
      el.remove();
    },
  };
}
