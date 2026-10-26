// Loads the esbuild bundle the way VS Code does, with a stub for the 'vscode' module.
// The unit tests run the tsc output with normal node_modules resolution, so they cannot
// catch dependencies that esbuild failed to bundle (see mainFields in esbuild.js).
const Module = require('module');
const path = require('path');

const bundle = path.join(__dirname, '..', 'dist', 'extension.js');
const load = Module._load;
Module._load = function (request, ...rest) {
	return request === 'vscode' ? {} : load.call(this, request, ...rest);
};

try {
	const extension = require(bundle);
	if (typeof extension.activate !== 'function') {
		throw new Error('activate() is not exported');
	}
	console.log(`${path.relative(process.cwd(), bundle)} loads`);
} catch (e) {
	console.error(`${path.relative(process.cwd(), bundle)} cannot be loaded: ${e.message}`);
	process.exit(1);
}
