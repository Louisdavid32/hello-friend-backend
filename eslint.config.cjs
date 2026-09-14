const eslint = require("@eslint/js");
const eslintConfigPrettier = require("eslint-config-prettier");
const globals = require("globals");
const tsdoc = require("eslint-plugin-tsdoc");
const tseslint = require("typescript-eslint");

module.exports = tseslint.config(
  {
    ignores: ["coverage/**", "dist/**", "node_modules/**", "eslint.config.cjs"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ["**/*.module.ts"],
    rules: {
      "@typescript-eslint/no-extraneous-class": "off",
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    plugins: {
      tsdoc,
    },
    rules: {
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports", prefer: "type-imports" },
      ],
      "@typescript-eslint/explicit-function-return-type": ["error", { allowExpressions: true }],
      "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/prefer-readonly": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "tsdoc/syntax": "error",
    },
  },
  {
    files: ["tests/**/*.ts", "vitest.config.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },
  eslintConfigPrettier,
);
