// V2 directory-plugin CLI (TUI) entrypoint. OpenCode V2 resolves `<dir>/tui.mjs`
// for the terminal plugin (the `./tui` export counterpart when loaded as a
// directory). Re-export the real TUI entrypoint so local-path installs load the
// `ctrl+alt+m` memory browser.
export { default } from './.opencode/plugins/ocl-memory-tui.mjs';