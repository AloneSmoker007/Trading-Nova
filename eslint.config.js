import js from "@eslint/js";
import { defineConfig } from "eslint/config";

const nodeGlobals = {
  AbortController: "readonly",
  Buffer: "readonly",
  console: "readonly",
  process: "readonly",
  structuredClone: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  URL: "readonly",
  fetch: "readonly",
  WebSocket: "readonly"
};

export default defineConfig([
  {
    files: ["src/**/*.js", "server/**/*.js", "scripts/**/*.js", "tests/**/*.js", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: nodeGlobals
    },
    plugins: { js },
    rules: {
      "no-undef": "error",
      "no-unreachable": "error",
      "no-constant-condition": "error",
      "no-duplicate-case": "error",
      "no-unsafe-finally": "error",
      "no-unreachable-loop": "error",
      "no-throw-literal": "error"
    }
  }
]);