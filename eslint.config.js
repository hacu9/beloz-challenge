import js from "@eslint/js";
import tseslint from "typescript-eslint";

// OPS-01: the injectable clock is the only source of time.
const noWallClock = [
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: "Read the time from the injectable Clock (OPS-01).",
  },
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: "Read the time from the injectable Clock (OPS-01).",
  },
];

// MONEY-03: no floating-point helpers on amounts.
const noFloatMoney = [
  {
    selector: "CallExpression[callee.name='parseFloat']",
    message: "Amounts are integer centavos (MONEY-03).",
  },
  {
    selector: "CallExpression[callee.property.name='parseFloat']",
    message: "Amounts are integer centavos (MONEY-03).",
  },
  {
    selector: "CallExpression[callee.property.name='toFixed']",
    message: "Amounts are integer centavos (MONEY-03).",
  },
];

export default tseslint.config(
  { ignores: ["dist", "coverage", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/platform/clock.ts"],
    rules: { "no-restricted-syntax": ["error", ...noWallClock, ...noFloatMoney] },
  },
  {
    // supertest response bodies are typed `any`; the assertions check their shape.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
    },
  },
  {
    files: ["eslint.config.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
