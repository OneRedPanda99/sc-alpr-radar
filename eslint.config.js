import js from "@eslint/js";
import tseslint from "typescript-eslint";

const browserGlobals = {
  window: "readonly",
  document: "readonly",
  navigator: "readonly",
  fetch: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  AudioContext: "readonly",
  requestAnimationFrame: "readonly",
};

const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  fetch: "readonly",
  setTimeout: "readonly",
  URL: "readonly",
};

export default tseslint.config(
  { ignores: ["dist", "dev-dist", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: browserGlobals,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: nodeGlobals,
    },
  },
);
