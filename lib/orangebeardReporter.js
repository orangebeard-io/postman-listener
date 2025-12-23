const OrangebeardAsyncV3Client = require('@orangebeard-io/javascript-client');
const StringDecoder = require('string_decoder').StringDecoder;
const xmlFormat = require('xml-formatter');
const _ = require('lodash');
const utils = require('./utils');
const { testPatterns, pmVariablesStatusPatterns } = require('./constants/patterns');
const TestStatus = require('./constants/types').TestStatus;

class OrangebeardReporter {
  constructor(newman, reporterConfig, collectionRunOptions) {
    const projects = this.parseProjects(reporterConfig);
    
    this.clients = projects.map(project => {
      const config = !Object.keys(reporterConfig).length
        ? {}
        : { ...utils.getOrangebeardParameters(reporterConfig), project };
      return !Object.keys(config).length
        ? new OrangebeardAsyncV3Client()
        : new OrangebeardAsyncV3Client(config);
    });
    
    this.orangebeardConfig = this.clients[0].config;
    this.collectionRunOptions = collectionRunOptions;
    this.decoder = new StringDecoder('utf8');

    this.testRuns = [];
    this.activeSuites = projects.map(() => []);
    this.activeTests = projects.map(() => []);
    this.activeSteps = projects.map(() => []);
    this.consoleLogs = [];

    newman.on('console', this.onConsole.bind(this));
    newman.on('script', this.onScript.bind(this));
    newman.on('start', this.onStart.bind(this));
    newman.on('beforeRequest', this.onBeforeRequest.bind(this));
    newman.on('beforeTest', this.onBeforeTest.bind(this));
    newman.on('item', this.finishTest.bind(this));
    newman.on('assertion', this.finishStep.bind(this));
    newman.on('test', this.finishTestSteps.bind(this));
    newman.on('request', this.onRequest.bind(this));
    newman.on('beforeDone', this.onBeforeDone.bind(this));
    newman.on('done', this.onDone.bind(this));
  }

  parseProjects(reporterConfig) {
    if (!Object.keys(reporterConfig).length) {
      return [''];
    }
    const projectString = reporterConfig.orangebeardIoOrangebeardProject;
    if (!projectString) {
      return [''];
    }
    const projects = projectString.split(';').map(p => p.trim()).filter(p => p.length > 0);
    return projects.length > 0 ? projects : [''];
  }

  onConsole(err, args) {
    if (err) {
      throw err;
    }

    args.messages
      .slice(1)
      .forEach((message) =>
        this.consoleLogs.push({ level: args.level, message, time: utils.getTime() }),
      );
  }

  onStart() {
    this.testRuns = this.clients.map(client => 
      client.startTestRun(utils.getStartTestRun(client.config))
    );
  }

  onBeforeRequest(err, result) {
    if (err) {
      throw err;
    }

    const name = this.getTestName(result);
    if (!name) {
      return;
    }

    this.clients.forEach((client, clientIndex) => {
      this.synchronizeSuiteState(result.item, clientIndex);
      const description = result.request.description?.content;
      const parentId = this.getCurrentSuite(clientIndex);

      const test = client.startTest({
        testRunUUID: this.testRuns[clientIndex],
        suiteUUID: parentId,
        testName: name,
        testType: 'TEST',
        description,
        attributes: utils.getAttributes(this.collectionRunOptions.environment.values),
        startTime: utils.getTime(),
      });

      this.activeTests[clientIndex].push({
        suite: parentId,
        testId: test,
        name,
        status: TestStatus.PASSED,
      });

      this.sendRequestLogs(test, result.request, clientIndex);
      this.sendConsoleAndErrorLogs(test, undefined, clientIndex);
    });
  }

  onBeforeTest(err, result) {
    if (err) {
      throw err;
    }

    const testSteps = _.filter(result.events, 'script')
      .flatMap((event) => event.script.exec) // Get script as string
      .flatMap((exec) => {
        const stepName = utils.getStepParameterByPatterns(exec, testPatterns)[0];
        const status = utils.getStepParameterByPatterns(exec, pmVariablesStatusPatterns)[0];

        return {
          ...(stepName ? { stepName } : {}),
          ...(status ? { status } : {}),
        };
      })
      .groupBySpecificField('stepName', ['testCaseId', 'status']);

    this.clients.forEach((client, clientIndex) => {
      const testId = this.getCurrentTest(clientIndex);
      
      testSteps.forEach((testStep) => {
        const stepName = testStep.stepName;
        const newStep = client.startStep({
          testRunUUID: this.testRuns[clientIndex],
          testUUID: testId,
          stepName,
          startTime: utils.getTime(),
        });

        this.activeSteps[clientIndex].push({
          id: newStep,
          name: stepName,
          status: testStep.status,
          parent: testId,
        });
      });
    });
  }

  finishStep(error, testAssertion) {
    const errorInfo = error || testAssertion.error;

    this.clients.forEach((client, clientIndex) => {
      let stepIndex = this.activeSteps[clientIndex].findIndex((step) => step.name === testAssertion.assertion);

      if (stepIndex < 0) {
        const testId = this.getCurrentTest(clientIndex);
        const stepName = testAssertion.assertion;

        const newStepId = client.startStep({
          testRunUUID: this.testRuns[clientIndex],
          testUUID: testId,
          stepName,
          startTime: utils.getTime(),
        });

        this.activeSteps[clientIndex].push({
          id: newStepId,
          name: stepName,
          status: TestStatus.PASSED,
          parent: testId,
        });

        stepIndex = this.activeSteps[clientIndex].length - 1;
      }

      const step = this.activeSteps[clientIndex][stepIndex];

      if (errorInfo) {
        this.logMessage(this.getCurrentTest(clientIndex), errorInfo.message, 'ERROR', step.id, clientIndex);
        this.activeTests[clientIndex][this.activeTests[clientIndex].length - 1].status = TestStatus.FAILED;
        step.status = TestStatus.FAILED;
      }

      client.finishStep(step.id, {
        testRunUUID: this.testRuns[clientIndex],
        status: step.status || (errorInfo ? TestStatus.FAILED : TestStatus.PASSED),
        endTime: utils.getTime(),
      });

      this.activeSteps[clientIndex].splice(stepIndex, 1);
    });
  }

  sendConsoleAndErrorLogs(testId, stepId, clientIndex) {
    this.consoleLogs?.forEach((log) => {
      let logLevel = log.level;
      if (log.level === 'ERROR') {
        const testIndex = this.activeTests[clientIndex].findIndex((t) => t.testId === testId);
        if (testIndex !== -1) {
          this.activeTests[clientIndex][testIndex].status = TestStatus.FAILED;
        } else {
          this.activeTests[clientIndex][this.activeTests[clientIndex].length - 1].status = TestStatus.FAILED;
        }
      }
      if (!(logLevel in ['INFO', 'WARNING', 'ERROR', 'DEBUG'])) {
        logLevel = 'INFO';
      }
      this.logMessage(testId, log.message, logLevel, stepId, clientIndex, log.time);
    });
    if (clientIndex === this.clients.length - 1) {
      this.consoleLogs = [];
    }
  }

  finishTestSteps(err, result) {
    if (err) {
      throw err;
    }

    const testWithError = result.executions.find((item) => item.error);

    this.clients.forEach((client, clientIndex) => {
      const testId = this.getCurrentTest(clientIndex);
      this.markUnfinishedStepsSkipped(testId, clientIndex);

      if (testWithError) {
        this.activeTests[clientIndex][this.activeTests[clientIndex].length - 1].status = TestStatus.FAILED;
      }
    });
  }

  onRequest(error, result) {
    this.clients.forEach((client, clientIndex) => {
      this.activeTests[clientIndex][this.activeTests[clientIndex].length - 1].response = result?.response;
      this.activeTests[clientIndex][this.activeTests[clientIndex].length - 1].error = error;
    });
  }

  finishTest(err) {
    if (err) {
      throw err;
    }

    this.clients.forEach((client, clientIndex) => {
      const test = this.activeTests[clientIndex][this.activeTests[clientIndex].length - 1];
      this.markUnfinishedStepsSkipped(test.testId, clientIndex);

      if (test.error) {
        this.logMessage(test.testId, test.error.message, 'ERROR', undefined, clientIndex);
        this.activeTests[clientIndex][this.activeTests[clientIndex].length - 1].status = TestStatus.FAILED;
        this.activeSuites[clientIndex].forEach((suite, idx) => {
          this.activeSuites[clientIndex][idx].status = TestStatus.FAILED;
        });

        const status = test.status !== undefined ? test.status : TestStatus.PASSED;

        client.finishTest(test.testId, {
          testRunUUID: this.testRuns[clientIndex],
          status,
          endTime: utils.getTime(),
        });

        this.activeTests[clientIndex].pop();
        return;
      }
      this.sendConsoleAndErrorLogs(test.testId, undefined, clientIndex);

      if (test.response) {
        this.sendResponseLogs(test.testId, test.response, clientIndex);
      }

      const status = test.status !== undefined ? test.status : TestStatus.PASSED;

      client.finishTest(test.testId, {
        testRunUUID: this.testRuns[clientIndex],
        status,
        endTime: utils.getTime(),
      });
      this.activeTests[clientIndex].pop();
    });
  }

  onScript(err) {
    if (err) {
      let message = `${err.type}: ${err.message}`;
      const stackLines = Array.isArray(err.stacktrace) ? err.stacktrace : [];

      if (stackLines.length !== 0) {
        const formattedStack = stackLines.map((line) => `    ${line}`).join('\n');
        message += `\n${formattedStack}`;
      }
      this.consoleLogs.push({ level: 'ERROR', message, time: utils.getTime() });
    }
  }

  // Finishes suite
  onBeforeDone(err) {
    if (err) {
      throw err;
    }
  }

  // Finishes launch
  onDone(err) {
    if (err) {
      throw err;
    }

    this.clients.forEach((client, clientIndex) => {
      client.finishTestRun(this.testRuns[clientIndex], {
        endTime: utils.getTime(),
      });
    });
  }

  // ------------------
  //  HELPER FUNCTIONS
  // ------------------

  getCurrentSuite(clientIndex = 0) {
    return this.activeSuites[clientIndex].length ? this.activeSuites[clientIndex][this.activeSuites[clientIndex].length - 1].id : null;
  }

  getCurrentTest(clientIndex = 0) {
    return this.activeTests[clientIndex][this.activeTests[clientIndex].length - 1].testId;
  }

  getCurrentStep(clientIndex = 0) {
    return this.activeSteps[clientIndex].length ? this.activeSteps[clientIndex][this.activeSteps[clientIndex].length - 1].id : null;
  }

  getTestName(result) {
    if (result.item.name === undefined) {
      return null;
    }
    const iteration =
      this.collectionRunOptions.iterationCount === undefined
        ? ''
        : ` #${result.cursor.iteration + 1}`;

    return `${result.item.name}${iteration}`;
  }

  logMessage(testId, message, level = 'INFO', stepId = undefined, clientIndex = 0, time = utils.getTime()) {
    if (testId === undefined) {
      return; // don't log if no test id can be determined
    }

    const messageStr = typeof message === 'object' ? JSON.stringify(message, null, 2) : message;

    this.clients[clientIndex].log({
      testRunUUID: this.testRuns[clientIndex],
      testUUID: testId,
      stepUUID: stepId !== undefined ? stepId : undefined,
      logTime: time,
      message: messageStr,
      logLevel: level,
      logFormat: 'MARKDOWN',
    });
  }

  sendRequestLogs(testId, request, clientIndex = 0) {
    let message = '### Request\n\n';

    message += '**Meta**\n\n';
    message += `- **URL:** ${request.url.toString()}\n`;
    message += `- **Method:** ${request.method}\n\n`;

    const headers = request.headers.members;

    if (headers.length) {
      message += '**Headers**\n\n';
      message += '| Key | Value |\n';
      message += '| --- | ----- |\n';
      headers.forEach((header) => {
        if (!header || !header.key) return;
        message += `| ${header.key} | ${header.value} |\n`;
      });
      message += '\n';
    }

    if (request.body?.toString()) {
      const rawBody = request.body.toString();
      let formattedBody = rawBody;
      let fenced = false;

      const contentTypeHeader = request.headers.members.find((x) => x.key === 'Content-Type');
      const contentType = contentTypeHeader?.value?.toLowerCase?.() || '';

      if (contentType.includes('json')) {
        try {
          formattedBody = JSON.stringify(JSON.parse(rawBody), null, 2);
          message += '**Body (JSON)**\n```json\n';
          message += `${formattedBody}\n`;
          message += '```\n';
          fenced = true;
        } catch (e) {
          // fall back to plain text below
        }
      } else if (contentType.includes('xml')) {
        try {
          formattedBody = xmlFormat(rawBody);
          message += '**Body (XML)**\n```xml\n';
          message += `${formattedBody}\n`;
          message += '```\n';
          fenced = true;
        } catch (e) {
          // fall back to plain text below
        }
      }

      if (!fenced) {
        message += '**Body**\n```text\n';
        message += `${formattedBody}\n`;
        message += '```\n';
      }
    }

    this.logMessage(testId, message, 'INFO', undefined, clientIndex);
  }

  sendResponseLogs(testId, response, clientIndex = 0) {
    const headers = response.headers.members;
    const body = this.formattedBody(response.headers.members, this.decoder.write(response.stream));
    let message = '### Response\n\n';

    message += '**Meta**\n\n';
    message += `- **Code:** ${response.code}\n`;
    message += `- **Status:** ${response.status}\n\n`;

    if (headers.length) {
      message += '**Headers**\n\n';
      message += '| Key | Value |\n';
      message += '| --- | ----- |\n';
      headers.forEach((header) => {
        if (!header || !header.key) return;
        message += `| ${header.key} | ${header.value} |\n`;
      });
      message += '\n';
    }

    const contentTypeHeader = response.headers.members.find((x) => x.key === 'Content-Type');
    const contentType = contentTypeHeader?.value?.toLowerCase?.() || '';

    if (body) {
      if (contentType.includes('json')) {
        message += '**Body (JSON)**\n```json\n';
        message += `${body}\n`;
        message += '```\n';
      } else if (contentType.includes('xml')) {
        message += '**Body (XML)**\n```xml\n';
        message += `${body}\n`;
        message += '```\n';
      } else {
        message += '**Body**\n```text\n';
        message += `${body}\n`;
        message += '```\n';
      }
    }

    this.logMessage(testId, message, 'INFO', undefined, clientIndex);
  }

  formattedBody(headers, body) {
    if (headers.find((x) => x.key === 'Content-Type')) {
      const contentType = headers.find((x) => x.key === 'Content-Type').value.toLowerCase();
      try {
        if (contentType.includes('json')) {
          return JSON.stringify(JSON.parse(body), null, '    ');
        } else if (contentType.includes('xml')) {
          return xmlFormat(body);
        }
      } catch (error) {
        return body;
      }
    }
    return body;
  }

  synchronizeSuiteState(testItem, clientIndex = 0) {
    let testFolderPath = [];
    let structEl = testItem;
    while (structEl.__parent) {
      if (structEl.__parent.name) {
        testFolderPath.push({ name: structEl.__parent.name, id: structEl.__parent.id });
      }
      structEl = structEl.__parent;
    }
    testFolderPath = testFolderPath.reverse();

    if (
      this.activeSuites[clientIndex].length &&
      this.activeSuites[clientIndex].length > 0 &&
      testFolderPath[testFolderPath.length - 1].id ===
        this.activeSuites[clientIndex][this.activeSuites[clientIndex].length - 1].postmanId
    ) {
      return; // The current suite is the current structure element
    }

    if (!this.activeSuites[clientIndex].length && testFolderPath.length > 0) {
      testFolderPath.forEach((f) => {
        const newSuite = this.clients[clientIndex].startSuite({
          testRunUUID: this.testRuns[clientIndex],
          parentSuiteUUID: this.getCurrentSuite(clientIndex),
          suiteNames: [f.name],
        });

        this.activeSuites[clientIndex].push({
          id: newSuite[0],
          name: f.name,
          postmanId: f.id,
        });
      });
      return; // Created new suite (and sub-suite(s)) under the testrun
    }

    const folderIndex = this.activeSuites[clientIndex].length
      ? testFolderPath.findIndex(
          (folder) => folder.id === this.activeSuites[clientIndex][this.activeSuites[clientIndex].length - 1].postmanId,
        )
      : -1;

    if (folderIndex >= 0) {
      // start new struct from index
      for (let i = folderIndex + 1; i < testFolderPath.length; i++) {
        const newSuite = this.clients[clientIndex].startSuite({
          testRunUUID: this.testRuns[clientIndex],
          parentSuiteUUID: this.getCurrentSuite(clientIndex),
          suiteNames: [testFolderPath[i].name],
        });

        this.activeSuites[clientIndex].push({
          id: newSuite[0],
          name: testFolderPath[i].name,
          postmanId: testFolderPath[i].id,
        });
      }
      return; // new sub suite(s) of current (last suite is in the testFolderPath)
    }

    // new subfolder(s) of ancestor (other than last from state is in folderpath)
    // check before last index and then lower until an existing folder was found, then close all deeper suites and self-call

    for (let i = this.activeSuites[clientIndex].length - 1; i >= 0; i--) {
      const folderIndex = testFolderPath.findIndex(
        (folder) => folder.id === this.activeSuites[clientIndex][i].postmanId,
      );
      if (folderIndex >= 0) {
        for (let j = 0; j < folderIndex; j++) {
          this.activeSuites[clientIndex].pop();
        }
        break;
      } else {
        this.activeSuites[clientIndex].pop();
      }
    }
    this.synchronizeSuiteState(testItem, clientIndex);
  }

  failAllStepsForTestId(testId, message, clientIndex = 0) {
    this.activeSteps[clientIndex]
      .filter((step) => step.parent === testId)
      .forEach((step) => {
        if (message) {
          this.logMessage(testId, message, 'ERROR', step.id, clientIndex);
        }
        this.clients[clientIndex].finishStep(step.id, {
          testRunUUID: this.testRuns[clientIndex],
          status: 'FAILED',
          endTime: utils.getTime(),
        });

        this.activeSteps[clientIndex].splice(this.activeSteps[clientIndex].indexOf(step), 1);
      });
  }

  markUnfinishedStepsSkipped(testId, clientIndex = 0) {
    this.activeSteps[clientIndex]
      .filter((step) => step.parent === testId)
      .forEach((step) => {
        this.clients[clientIndex].finishStep(step.id, {
          testRunUUID: this.testRuns[clientIndex],
          status: 'SKIPPED',
          endTime: utils.getTime(),
        });
        this.activeSteps[clientIndex].splice(this.activeSteps[clientIndex].indexOf(step), 1);
      });
  }
}

module.exports = OrangebeardReporter;
