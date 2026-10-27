import tsPlugin from "@typescript-eslint/eslint-plugin"
import tsParser from "@typescript-eslint/parser"

/**
 * Native ESLint 9 flat config. Avoid FlatCompat — @eslint/eslintrc needs ajv@6
 * which collides with Expo's ajv@8 in this workspace.
 *
 * ESLint 9 only matches js/mjs/cjs unless a config object sets `files`.
 * `tailwind.ts` sits at the package root, outside `src/`, so it is listed too.
 */
const sourceFiles = ["src/**/*.{js,mjs,cjs,ts,tsx}", "tailwind.ts"]

export default [
  {
    files: sourceFiles,
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
  },
  {
    files: sourceFiles,
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    ignores: ["node_modules/**", "dist/**", "*.config.*", "*.d.ts"],
  },
]
