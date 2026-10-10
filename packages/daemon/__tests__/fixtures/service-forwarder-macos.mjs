// Fixture-only: exercise the macOS service branch on Linux CI. The spawned
// daemon remains native; this preload only changes the forwarder entry.
if ((process.argv[1] ?? '').endsWith('mcp-forwarder.js')) {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
}
