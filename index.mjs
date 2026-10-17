// V2 directory-plugin server entrypoint. When this repo is referenced as a
// plugin path (e.g. "plugins": ["/path/to/openclaude-memory"]), OpenCode V2
// resolves `<dir>/index.mjs` as the server plugin (NOT the package.json
// `exports`). Re-export the real entrypoint so local-path installs work the
// same as the published npm package.
export { default } from './.opencode/plugins/ocl-memory.mjs';