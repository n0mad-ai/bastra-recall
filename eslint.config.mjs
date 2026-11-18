import tseslint from "typescript-eslint";
import { CODE_PATTERN, codeIgnores } from "./scripts/lint-scope.mjs";

const correctnessRules = {
  "no-duplicate-case": "error",
  "no-dupe-keys": "error",
  "no-unreachable": "error",
  "no-unsafe-finally": "error",
  "no-unused-vars": "off",
  "@typescript-eslint/no-unused-vars": [
    "error",
    {
      args: "after-used",
      argsIgnorePattern: "^_",
      caughtErrors: "none",
      ignoreRestSiblings: true,
    },
  ],
};

export default [
  {
    // Generated output, upstream code, and frozen test inputs have other owners.
    ignores: codeIgnores,
  },
  {
    files: [CODE_PATTERN],
    // Existing directives for rules outside this small set remain meaningful.
    linterOptions: { reportUnusedDisableDirectives: "off" },
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      ...correctnessRules,
      complexity: ["error", { max: 15, variant: "classic" }],
      "max-depth": ["error", 4],
      "max-lines-per-function": ["warn", { max: 100, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ["**/*.{[cC][jJ][sS],[cC][tT][sS]}"],
    languageOptions: { sourceType: "commonjs" },
  },
  {
    files: ["packages/daemon/__tests__/gate-lane-wiring.test.ts"],
    // Preserve the existing inline exception: this request-draining binding is intentionally unread.
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { ...correctnessRules["@typescript-eslint/no-unused-vars"][1], varsIgnorePattern: "^_$" },
      ],
    },
  },
];
