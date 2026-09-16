import { createApp } from "./app.js";
import { getPool } from "./db.js";

const PORT = Number(process.env.PORT) || 3000;
// Booth laptop only: listen on this machine, not the network.
const HOST = "127.0.0.1";

createApp().listen(PORT, HOST, () => {
  console.log(`GDG Arcade running at http://localhost:${PORT}`);
  console.log(`Design sheet:        http://localhost:${PORT}/design-sheet`);
  console.log(`Admin:               http://localhost:${PORT}/admin`);
  getPool();
});
