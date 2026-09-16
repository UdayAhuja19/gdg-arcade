// "server": the fair laptop, scores go to MySQL through the Node server.
// "static": the GitHub Pages demo, no server, each browser keeps its own scores.
// scripts/build-static.js rewrites this file to "static" when building the demo.
export const MODE = "server";
