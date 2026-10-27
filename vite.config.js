import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

const root = path.resolve(".");
const projectDir = path.resolve("public/project");
const FACE_ID = /^[A-Za-z]+$/;

function lanHosts(port, protocol) {
  const hosts = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      const ipv4 = net.family === "IPv4" || net.family === 4;
      if (!ipv4 || net.internal) continue;
      hosts.push(`${protocol}://${net.address}:${port}`);
    }
  }
  hosts.sort((a, b) => Number(b.includes("192.168.")) - Number(a.includes("192.168.")));
  return hosts;
}

function attachProjectApi(server) {
  server.middlewares.use((req, res, next) => {
    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && url.pathname === "/api/hosts") {
      const forwarded = req.headers["x-forwarded-proto"];
      const protocol = forwarded === "https" || req.socket?.encrypted ? "https" : "http";
      let port = "5173";
      try {
        port = new URL(`${protocol}://${req.headers.host}`).port || (protocol === "https" ? "443" : "80");
      } catch {
        /* keep default */
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ storage: "fs", hosts: lanHosts(port, protocol) }));
      return;
    }

    if (url.pathname === "/api/model" && (req.method === "PUT" || req.method === "DELETE")) {
      const face = url.searchParams.get("face") || "letterA";
      if (!FACE_ID.test(face)) {
        res.statusCode = 400;
        res.end("bad face");
        return;
      }
      fs.mkdirSync(projectDir, { recursive: true });
      const filePath = path.join(projectDir, `${face}.glb`);
      if (req.method === "DELETE") {
        fs.rmSync(filePath, { force: true });
        res.statusCode = 204;
        res.end();
        return;
      }
      const file = fs.createWriteStream(filePath);
      req.pipe(file);
      file.on("finish", () => {
        res.statusCode = 204;
        res.end();
      });
      file.on("error", next);
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/meta") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        fs.mkdirSync(projectDir, { recursive: true });
        fs.writeFileSync(path.join(projectDir, "meta.json"), Buffer.concat(chunks));
        res.statusCode = 204;
        res.end();
      });
      req.on("error", next);
      return;
    }

    next();
  });
}

export default defineConfig({
  plugins: [
    basicSsl(),
    {
      name: "project-api",
      configureServer: attachProjectApi,
      configurePreviewServer: attachProjectApi,
    },
  ],
  server: {
    host: true,
    https: true,
    headers: { "Permissions-Policy": "camera=(self)" },
  },
  preview: {
    host: true,
    https: true,
    headers: { "Permissions-Policy": "camera=(self)" },
  },
  build: {
    rollupOptions: {
      input: {
        main: path.join(root, "index.html"),
        ar: path.join(root, "ar.html"),
        print: path.join(root, "print.html"),
        help: path.join(root, "help.html"),
      },
    },
  },
});
