# Inline values in your own files

Open a `.js`, `.mjs`, `.cjs`, `.ts`, `.mts` or `.cts` file and click Inline Values in the status bar, or right-click the file and choose Start Inline Values.

- `import` and `require` resolve from the file's folder, its `node_modules` and the workspace `node_modules`.
- Top-level `await` works, in ES modules and in CommonJS files.
- The run uses the text in the editor, so you do not need to save.
- In a folder you have not trusted (Restricted Mode), nothing runs and the editor says why.
