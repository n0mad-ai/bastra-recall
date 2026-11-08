# Assistant address before protocol 2

`gateway.js` freezes `src/assistant-address-gateway.ts` from commit
`53a0117e85d70e7d6e298936aeddac46c14da4ff` (`cf0c2c28^`), transpiled with
TypeScript to ES2022/ESNext. It intentionally contains the old inetd startup
without bootstrap, current.json, or a runtime watcher. Pure import dependencies
are supplied by the isolated runtime test.

`legacyFixture()` in `assistant-address-runtime.test.ts` reconstructs that
version's pinned `exec node <version>/assistant-address-gateway.js` launcher,
owner marker and Wait=true / BASTRA_ASSISTANT_ADDRESS_LISTEN=1 plist shape.
The old updater path is represented by directly starting the newly installed
HTTP daemon, without invoking a new updater hook. Tests hand off an actual
unprivileged listening socket, never load launchd jobs or touch system config.
