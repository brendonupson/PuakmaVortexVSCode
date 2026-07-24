import typescriptEslint from "typescript-eslint";

export default typescriptEslint.config(
  {
    files: ["src/**/*.ts"],
  },
  ...typescriptEslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/naming-convention": [
        "warn",
        {
          selector: "import",
          format: ["camelCase", "PascalCase"],
        },
      ],
      curly: "warn",
      eqeqeq: "warn",
      "no-throw-literal": "warn",
      semi: "warn",
    },
  },
);
