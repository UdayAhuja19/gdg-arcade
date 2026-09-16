// The five games: names, colours, controls and scoring text.
// Shared by the server, the pages and the browser-only demo.
export const GAME_LIST = [
  {
    key: "dino",
    title: "DINO RUN",
    color: "green",
    shape: "triangle",
    blurb: "JUMP THE CACTI. DUCK THE FLOWERS.",
    controls: [
      ["SPACE", "JUMP"],
      ["↓", "DUCK"],
    ],
    scoring: ["POINTS FOR DISTANCE", "SPEEDS UP EVERY 100 POINTS", "FASTER = MORE POINTS"],
  },
  {
    key: "flappy",
    title: "FLAPPY BYTE",
    color: "yellow",
    shape: "blob",
    blurb: "FLAP THROUGH THE GAPS.",
    controls: [
      ["SPACE", "FLAP"],
      ["CLICK", "FLAP"],
    ],
    scoring: ["+10 PER PIPE", "+5 THROUGH THE MIDDLE"],
  },
  {
    key: "snake",
    title: "SNAKE",
    color: "blue",
    shape: "flower",
    blurb: "EAT AND GROW. DON'T HIT THE WALLS OR YOURSELF.",
    controls: [
      ["ARROWS", "TURN"],
      ["WASD", "TURN"],
    ],
    scoring: ["+10 PER FOOD", "+30 YELLOW BONUS"],
  },
  {
    key: "memory",
    title: "MEMORY MATCH",
    color: "red",
    shape: "circle",
    blurb: "FIND ALL 8 PAIRS, FAST.",
    controls: [["CLICK", "FLIP A CARD"]],
    scoring: ["+100 PER PAIR", "+50 STREAK BONUS", "TIME BONUS"],
  },
  {
    key: "stack",
    title: "STACK TOWER",
    color: "ink",
    shape: "capsule",
    blurb: "DROP BLOCKS. BUILD HIGH.",
    controls: [
      ["SPACE", "DROP"],
      ["CLICK", "DROP"],
    ],
    scoring: ["+10 PER BLOCK", "+15 PERFECT DROP", "SPEEDS UP EVERY 5 BLOCKS"],
  },
];
