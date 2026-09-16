import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createApi } from "./api.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function createApp() {
  const app = express();
  app.disable("x-powered-by");

  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    next();
  });

  app.use("/api", createApi());
  app.use(express.static(path.join(root, "public"), { extensions: ["html"] }));
  app.use((req, res) => {
    res.status(404).sendFile(path.join(root, "public/index.html"));
  });

  return app;
}
