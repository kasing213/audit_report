// ts-node bootstrap for the node:test suite.
//
// The root tsconfig pins rootDir to ./src, so loading a file under tests/ with
// the default project is a rootDir violation. Point ts-node at tsconfig.test.json
// instead. Done from a .js shim rather than TS_NODE_PROJECT= in the npm script
// because npm runs scripts through cmd.exe on Windows, where an inline env
// assignment is not portable.
const path = require('path');

require('ts-node').register({
  project: path.join(__dirname, '..', 'tsconfig.test.json'),
});
