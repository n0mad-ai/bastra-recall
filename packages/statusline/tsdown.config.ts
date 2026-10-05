import { defineConfig } from 'tsdown';

export default defineConfig([
	{
		entry: ['src/index.ts', 'src/codex-statusline.ts', 'src/recall-panel.ts', 'src/claude-panel-feed.ts'],
		format: 'esm',
		target: 'node18',
		platform: 'node',
		clean: true,
		minify: true,
		nodeProtocol: true,
	},
	{
		entry: ['src/browser.ts'],
		format: 'esm',
		target: 'es2022',
		platform: 'browser',
		clean: false,
		minify: true,
		dts: true,
		deps: { neverBundle: [/^node:/] },
	},
]);
