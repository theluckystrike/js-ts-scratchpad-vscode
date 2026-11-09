# Changelog

## 0.1.0

- First release. JavaScript playground and TypeScript scratchpad with inline values: the value of each line, `console.log` output and errors at the end of their lines while you type.
- New JavaScript Scratchpad and New TypeScript Scratchpad commands, Start Inline Values for any `.js`, `.mjs`, `.cjs`, `.ts`, `.mts` or `.cts` file.
- Each run is a fresh process with a time limit and a memory limit; a new edit stops the old run. VS Code's own Node.js or your node.
- TypeScript with no tsconfig and no install. ES modules, CommonJS, top-level await; imports resolve from the file's folder and node_modules.
- A million console.log calls are throttled to the first 100 values per line and a count.
- No network calls, no telemetry, no popups. Restricted Mode runs nothing.
