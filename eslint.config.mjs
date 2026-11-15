import tseslint from "typescript-eslint";

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
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/vendor/**",
      "packages/eval/fixtures/**",
      "**/__fixtures__/**",
      "**/stress-fixtures/**",
      "**/goldset/**",
      "packages/daemon/stub/build-info.ts",
      "tools/model-compare/data/**",
      "tools/model-compare/results/**",
      "tools/probes/convention-e2e/fixtures.mjs",
    ],
  },
  {
    files: ["{packages,scripts,tools}/**/*.{ts,mts,js,mjs}"],
    // Existing directives for rules outside this small set remain meaningful.
    linterOptions: { reportUnusedDisableDirectives: "off" },
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: "latest",
      sourceType: "module",
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
    files: ["packages/daemon/__tests__/gate-lane-wiring.test.ts"],
    // Preserve the existing inline exception: this request-draining binding is intentionally unread.
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { ...correctnessRules["@typescript-eslint/no-unused-vars"][1], varsIgnorePattern: "^_$" },
      ],
    },
  },
  {
    files: ["packages/daemon/webui/v22/**/*.{ts,mts,js,mjs}"],
    // Concurrent UI work: report all findings, but do not rewrite this tree.
    rules: Object.fromEntries(
      Object.entries(correctnessRules).map(([name, setting]) => [
        name,
        Array.isArray(setting) ? ["warn", ...setting.slice(1)] : setting === "error" ? "warn" : setting,
      ])
    ),
  },
];
