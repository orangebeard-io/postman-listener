const testPatterns = [/\s*pm.test\(["'](.*?)["'],/, /\s*tests\[["'](.*?)["']\]/];
const pmVariablesTestCaseIdPatterns = [
  /\s*pm.variables.set\("orangebeard.testCaseId", "(.*?)"\)/,
  /\s*pm.variables.set\("orangebeard.testCaseId","(.*?)"\)/,
];
const pmVariablesStatusPatterns = [
  /\s*pm.variables.set\("orangebeard.status", "(.*?)"\)/,
  /\s*pm.variables.set\("orangebeard.status","(.*?)"\)/,
];

module.exports = { testPatterns, pmVariablesTestCaseIdPatterns, pmVariablesStatusPatterns };
