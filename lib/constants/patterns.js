const testPatterns = [/\s*pm.test\(["'](.*?)["'],/, /\s*tests\[["'](.*?)["']]/];
const pmVariablesStatusPatterns = [
  /\s*pm.variables.set\("orangebeard.status", "(.*?)"\)/,
  /\s*pm.variables.set\("orangebeard.status","(.*?)"\)/,
];

module.exports = { testPatterns, pmVariablesStatusPatterns };
