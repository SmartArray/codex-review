module.exports = {
	packagerConfig: {
		name: 'Codex Explain',
		executableName: 'codex-explain',
		appBundleId: 'dev.codex-explain.app',
		asar: {
			unpack: '**/node_modules/@openai/codex-*/**'
		},
		osxSign: false,
		ignore: [
			/^\/docs($|\/)/,
			/^\/src($|\/)/,
			/^\/electron($|\/)/,
			/^\/scripts($|\/)/,
			/^\/test-results($|\/)/
		]
	},
	rebuildConfig: {},
	makers: [
		{
			name: '@electron-forge/maker-zip',
			platforms: ['darwin']
		},
		{
			name: '@electron-forge/maker-dmg',
			config: {
				format: 'ULFO'
			}
		}
	]
};
