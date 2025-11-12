const OrangebeardAsyncV3Client = require('@orangebeard-io/javascript-client');
const StringDecoder = require('string_decoder').StringDecoder;
const xmlFormat = require('xml-formatter');
const _ = require('lodash');
const utils = require('./utils');
const { testPatterns, pmVariablesStatusPatterns } = require('./constants/patterns');
const TestStatus = require('./constants/types').TestStatus;

class OrangebeardReporter {
  constructor(newman, reporterConfig, collectionRunOptions) {
    this.client = !Object.keys(reporterConfig).length
      ? new OrangebeardAsyncV3Client()
      : new OrangebeardAsyncV3Client(utils.getOrangebeardParameters(reporterConfig));
    this.orangebeardConfig = this.client.config;
    this.collectionRunOptions = collectionRunOptions;
    this.decoder = new StringDecoder('utf8');

    this.testRun = undefined;
    this.activeSuites = [];
    this.activeTests = [];
    this.activeSteps = [];
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
    this.testRun = this.client.startTestRun(utils.getStartTestRun(this.orangebeardConfig));
  }

  onBeforeRequest(err, result) {
    if (err) {
      throw err;
    }

    const name = this.getTestName(result);
    if (!name) {
      return;
    }

    this.synchronizeSuiteState(result.item);
    const description = result.request.description?.content;
    const parentId = this.getCurrentSuite();

    const test = this.client.startTest({
      testRunUUID: this.testRun,
      suiteUUID: parentId,
      testName: name,
      testType: 'TEST',
      description,
      attributes: utils.getAttributes(this.collectionRunOptions.environment.values),
      startTime: utils.getTime(),
    });

    this.activeTests.push({
      suite: parentId,
      testId: test,
      name,
      status: TestStatus.PASSED,
    });

    this.sendRequestLogs(test, result.request);
    this.sendConsoleAndErrorLogs(test, undefined);
  }

  onBeforeTest(err, result) {
    if (err) {
      throw err;
    }
    const testId = this.getCurrentTest();

    _.filter(result.events, 'script')
      .flatMap((event) => event.script.exec) // Get script as string
      .flatMap((exec) => {
        const stepName = utils.getStepParameterByPatterns(exec, testPatterns)[0];
        const status = utils.getStepParameterByPatterns(exec, pmVariablesStatusPatterns)[0];

        return {
          ...(stepName ? { stepName } : {}),
          ...(status ? { status } : {}),
        };
      })
      .groupBySpecificField('stepName', ['testCaseId', 'status'])
      .forEach((testStep) => {
        const stepName = testStep.stepName;
        const newStep = this.client.startStep({
          testRunUUID: this.testRun,
          testUUID: testId,
          stepName,
          startTime: utils.getTime(),
        });

        this.activeSteps.push({
          id: newStep,
          name: stepName,
          status: testStep.status,
          parent: testId,
        });
      });
  }

  finishStep(error, testAssertion) {
    let stepIndex = this.activeSteps.findIndex((step) => step.name === testAssertion.assertion);

    if (stepIndex < 0) {
      const testId = this.getCurrentTest();
      const stepName = testAssertion.assertion;

      const newStepId = this.client.startStep({
        testRunUUID: this.testRun,
        testUUID: testId,
        stepName,
        startTime: utils.getTime(),
      });

      this.activeSteps.push({
        id: newStepId,
        name: stepName,
        status: TestStatus.PASSED,
        parent: testId,
      });

      stepIndex = this.activeSteps.length - 1;
    }

    const step = this.activeSteps[stepIndex];
    const errorInfo = error || testAssertion.error;

    if (errorInfo) {
      this.logMessage(this.getCurrentTest(), errorInfo.message, 'ERROR', step.id);
      this.activeTests[this.activeTests.length - 1].status = TestStatus.FAILED;
      step.status = TestStatus.FAILED;
    }

    this.client.finishStep(step.id, {
      testRunUUID: this.testRun,
      status: step.status || (errorInfo ? TestStatus.FAILED : TestStatus.PASSED),
      endTime: utils.getTime(),
    });

    this.activeSteps.splice(stepIndex, 1);
  }

  sendConsoleAndErrorLogs(testId, stepId) {
    this.consoleLogs?.forEach((log) => {
      let logLevel = log.level;
      if (log.level === 'ERROR') {
        const testIndex = this.activeTests.findIndex((t) => t.testId === testId);
        if (testIndex !== -1) {
          this.activeTests[testIndex].status = TestStatus.FAILED;
        } else {
          this.activeTests[this.activeTests.length - 1].status = TestStatus.FAILED;
        }
      }
      if (!(logLevel in ['INFO', 'WARNING', 'ERROR', 'DEBUG'])) {
        logLevel = 'INFO';
      }
      this.logMessage(testId, log.message, logLevel, stepId, log.time);
    });
    this.consoleLogs = [];
  }

  finishTestSteps(err, result) {
    if (err) {
      throw err;
    }

    const testId = this.getCurrentTest();
    this.markUnfinishedStepsSkipped(testId);

    const testWithError = result.executions.find((item) => item.error);

    if (testWithError) {
      this.activeTests[this.activeTests.length - 1].status = TestStatus.FAILED;
    }
  }

  onRequest(error, result) {
    this.activeTests[this.activeTests.length - 1].response = result?.response;
    this.activeTests[this.activeTests.length - 1].error = error;
  }

  finishTest(err) {
    if (err) {
      throw err;
    }

    const test = this.activeTests[this.activeTests.length - 1];
    this.markUnfinishedStepsSkipped(test.testId);

    if (test.error) {
      this.logMessage(test.testId, test.error.message, 'ERROR');
      this.activeTests[this.activeTests.length - 1].status = TestStatus.FAILED;
      this.activeSuites.forEach((suite) => {
        this.activeSuites[this.activeSuites.findIndex((s) => s === suite)].status =
          TestStatus.FAILED;
      });

      const status = test.status !== undefined ? test.status : TestStatus.PASSED;

      this.client.finishTest(test.testId, {
        testRunUUID: this.testRun,
        status,
        endTime: utils.getTime(),
      });

      this.activeTests.pop();
      return;
    }
    this.sendConsoleAndErrorLogs(test.testId, undefined);

    if (test.response) {
      this.sendResponseLogs(test.testId, test.response);
    }

    const status = test.status !== undefined ? test.status : TestStatus.PASSED;

    this.client.finishTest(test.testId, {
      testRunUUID: this.testRun,
      status,
      endTime: utils.getTime(),
    });
    this.activeTests.pop();
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

    this.client.finishTestRun(this.testRun, {
      endTime: utils.getTime(),
    });
  }

  // ------------------
  //  HELPER FUNCTIONS
  // ------------------

  getCurrentSuite() {
    return this.activeSuites.length ? this.activeSuites[this.activeSuites.length - 1].id : null;
  }

  getCurrentTest() {
    return this.activeTests[this.activeTests.length - 1].testId;
  }

  getCurrentStep() {
    return this.activeSteps.length ? this.activeSteps[this.activeSteps.length - 1].id : null;
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

  logMessage(testId, message, level = 'INFO', stepId = undefined, time = utils.getTime()) {
    if (testId === undefined) {
      return; // don't log if no test id can be determined
    }

    const messageStr = typeof message === 'object' ? JSON.stringify(message, null, 2) : message;

    this.client.log({
      testRunUUID: this.testRun,
      testUUID: testId,
      stepUUID: stepId !== undefined ? stepId : undefined,
      logTime: time,
      message: messageStr,
      logLevel: level,
      logFormat: 'PLAIN_TEXT',
    });
  }

  sendRequestLogs(testId, request) {
    let message = 'Request:\n\n';

    message += `URL: ${request.url.toString()}\n`;
    message += `Method: ${request.method}\n`;

    const headers = request.headers.members.map((header) => `${header.key}:${header.value}`);

    if (headers.length) {
      message += `Headers:\n`;
      headers.forEach((header) => {
        message += `  ${header}\n`;
      });
    }

    if (request.body?.toString()) {
      message += `Body:\n${request.body.toString()}`;
    }
    this.logMessage(testId, message);
  }

  sendResponseLogs(testId, response) {
    const headers = response.headers.members.map((header) => `${header.key}:${header.value}`);
    const body = this.formattedBody(response.headers.members, this.decoder.write(response.stream));
    let message = 'Response:\n\n';
    message += `Code: ${response.code}\n`;
    message += `Status: ${response.status}\n`;
    message += `Headers:\n`;
    headers.forEach((header) => {
      message += `  ${header}\n`;
    });
    message += `Body:\n${body}`;
    this.logMessage(testId, message);
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

  synchronizeSuiteState(testItem) {
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
      this.activeSuites.length &&
      this.activeSuites.length > 0 &&
      testFolderPath[testFolderPath.length - 1].id ===
        this.activeSuites[this.activeSuites.length - 1].postmanId
    ) {
      return; // The current suite is the current structure element
    }

    if (!this.activeSuites.length && testFolderPath.length > 0) {
      testFolderPath.forEach((f) => {
        const newSuite = this.client.startSuite({
          testRunUUID: this.testRun,
          parentSuiteUUID: this.getCurrentSuite(),
          suiteNames: [f.name],
        });

        this.activeSuites.push({
          id: newSuite[0],
          name: f.name,
          postmanId: f.id,
        });
      });
      return; // Created new suite (and sub-suite(s)) under the testrun
    }

    const folderIndex = this.activeSuites.length
      ? testFolderPath.findIndex(
          (folder) => folder.id === this.activeSuites[this.activeSuites.length - 1].postmanId,
        )
      : -1;

    if (folderIndex >= 0) {
      // start new struct from index
      for (let i = folderIndex + 1; i < testFolderPath.length; i++) {
        const newSuite = this.client.startSuite({
          testRunUUID: this.testRun,
          parentSuiteUUID: this.getCurrentSuite(),
          suiteNames: [testFolderPath[i].name],
        });

        this.activeSuites.push({
          id: newSuite[0],
          name: testFolderPath[i].name,
          postmanId: testFolderPath[i].id,
        });
      }
      return; // new sub suite(s) of current (last suite is in the testFolderPath)
    }

    // new subfolder(s) of ancestor (other than last from state is in folderpath)
    // check before last index and then lower until an existing folder was found, then close all deeper suites and self-call

    for (let i = this.activeSuites.length - 1; i >= 0; i--) {
      const folderIndex = testFolderPath.findIndex(
        (folder) => folder.id === this.activeSuites[i].postmanId,
      );
      if (folderIndex >= 0) {
        for (let j = 0; j < folderIndex; j++) {
          this.activeSuites.pop();
        }
        break;
      } else {
        this.activeSuites.pop();
      }
    }
    this.synchronizeSuiteState(testItem);
  }

  failAllStepsForTestId(testId, message) {
    this.activeSteps
      .filter((step) => step.parent === testId)
      .forEach((step) => {
        if (message) {
          this.logMessage(testId, message, 'ERROR', step.id);
        }
        this.client.finishStep(step.id, {
          testRunUUID: this.testRun,
          status: 'FAILED',
          endTime: utils.getTime(),
        });

        this.activeSteps.splice(this.activeSteps.indexOf(step), 1);
      });
  }

  markUnfinishedStepsSkipped(testId) {
    this.activeSteps
      .filter((step) => step.parent === testId)
      .forEach((step) => {
        this.client.finishStep(step.id, {
          testRunUUID: this.testRun,
          status: 'SKIPPED',
          endTime: utils.getTime(),
        });
        this.activeSteps.splice(this.activeSteps.indexOf(step), 1);
      });
  }
}

module.exports = OrangebeardReporter;
