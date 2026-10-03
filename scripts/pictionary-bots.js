// Fills a PICTIONARY game with pretend phones, for rehearsing on the projector or testing
// how many phones the network can take. Bots join, guess random words from the list every
// few seconds (so some get lucky), and pick a word when it's their turn to draw.
//
//   node scripts/pictionary-bots.js                 60 bots on this laptop (npm run pictionary -- --local)
//   node scripts/pictionary-bots.js 100             100 bots
//   node scripts/pictionary-bots.js 100 https://xyz.trycloudflare.com   through the tunnel
//   add --smart: when a bot draws, the other bots "see" its word and some guess it right,
//   so turns end with real points (only works when a bot is the drawer)
import WebSocket from "ws";
import { EASY, MEDIUM, HARD } from "../server/pictionary/words.js";

const args = process.argv.slice(2).filter((a) => a !== "--smart");
const smart = process.argv.includes("--smart");
const count = Number(args[0]) || 60;
const base = args[1] ?? "http://localhost:3200";
const url = new URL("ws", base.endsWith("/") ? base : `${base}/`);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

const WORDS = [...EASY, ...MEDIUM, ...HARD];
const FIRST = ["AISHA", "OMAR", "SARA", "RAYYAN", "NOOR", "ALI", "MARIAM", "ZAID", "HANA", "YUSUF", "LAYLA", "ADAM", "RIYA", "ARJUN", "MAYA", "KHALID", "FATIMA", "DEV", "ZARA", "SAM"];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

let joined = 0;
let correct = 0;
// --smart: the word a bot is drawing, by turn number.
const words = new Map();

function bot(i) {
  const ws = new WebSocket(url);
  const id = `bot-${String(i).padStart(4, "0")}-${Math.random().toString(36).slice(2, 8)}`;
  let view = null;
  let seq = 0;
  let timer = 0;
  ws.on("open", () => ws.send(JSON.stringify({ t: "join", clientId: id, name: `${pick(FIRST)} ${i}` })));
  ws.on("message", (data) => {
    const msg = JSON.parse(data);
    if (msg.t === "ping") ws.send(JSON.stringify({ t: "pong" }));
    if (msg.t === "joined") joined += 1;
    if (msg.t === "guessed" && msg.status === "correct") correct += 1;
    if (msg.t !== "view") return;
    view = msg;
    const turn = view.turn;
    if (smart && turn?.isDrawer && turn.word) words.set(turn.number, turn.word);
    if (view.phase === "pick" && turn?.isDrawer && turn.choices) {
      setTimeout(() => ws.send(JSON.stringify({ t: "pick", index: Math.floor(Math.random() * 3), turn: turn.number })), 1500);
    }
  });
  ws.on("close", () => clearInterval(timer));
  ws.on("error", () => {});
  // A guess every 3–9 seconds while it's allowed.
  timer = setInterval(() => {
    if (view?.phase !== "draw" || !view.turn?.canGuess || Math.random() < 0.5) return;
    seq += 1;
    const known = words.get(view.turn.number);
    const text = known && Math.random() < 0.35 ? known : pick(WORDS);
    ws.send(JSON.stringify({ t: "guess", text, turn: view.turn.number, seq }));
  }, 3000 + Math.random() * 6000);
}

for (let i = 1; i <= count; i += 1) setTimeout(() => bot(i), i * 40);
setInterval(() => console.log(`${joined}/${count} bots in · ${correct} lucky guesses`), 5000);
console.log(`Sending ${count} bots to ${url}. Ctrl+C to stop.`);
