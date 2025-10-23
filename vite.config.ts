import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
    allowedHosts: ["9906e4f9657f.ngrok-free.app"]
  }
});
