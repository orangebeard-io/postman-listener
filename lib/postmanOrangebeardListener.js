const OrangebeardClient = require('@orangebeard-io/javascript-client');
const StringDecoder = require('string_decoder').StringDecoder;
const xmlFormat = require('xml-formatter');
const _ = require('lodash');
const utils = require('./utils');
const {
  testPatterns,
  pmVariablesTestCaseIdPatterns,
  pmVariablesStatusPatterns,
} = require('./constants/patterns');
const { TestStatus } = require('./constants/types');

/**
 * Basic error handler for promises. Just prints errors.
 *
 * @param {Object} err Promise's error
 */
const errorHandler = (err) => {
  if (err) {
    console.error(err);
  }
};

class PostmanOrangebeardListener {
  constructor(newman, options, collectionRunOptions) {
    this.client = !Object.keys(options).length
      ? new OrangebeardClient()
      : new OrangebeardClient(utils.getClientSettings(options));
    this.options = options;
    this.collectionRunOptions = collectionRunOptions;
    this.decoder = new StringDecoder('utf8');

    this.testRun;
    this.activeSuites = [];
    this.activeTests = [];
    this.activeSteps = [];
    this.consoleLogs = [];

    newman.on('console', this.onConsole.bind(this));
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
        this.consoleLogs.push({ level: args.level, message, time: this.getTime() }),
      );
  }

  onStart(err, result) {
    this.testRun = this.client.startLaunch(utils.getStartTestRun(this.options));
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
    const description = result.request.description && result.request.description.content;
    const parentTempId = this.getCurrentSuiteTempId();

    const test = this.client.startTestItem(
      {
        name: name,
        type: 'TEST',
        description,
        attributes: utils.getAttributes(this.collectionRunOptions.environment.values),
      },
      this.testRun.tempId,
      parentTempId,
    );
    test.promise.catch(errorHandler);
    this.activeTests.push({
      parent: parentTempId,
      tempId: test.tempId,
      name: name,
      status: TestStatus.PASSED,
    });

    this.sendRequestLogs(test.tempId, result.request);

    this.consoleLogs &&
      this.consoleLogs.forEach((log) =>
        this.logMessage(test.tempId, log.message, log.level, log.time),
      );
    this.consoleLogs = [];
  }

  onBeforeTest(err, result) {
    if (err) {
      throw err;
    }
    const testTempId = this.getCurrentTestTempId();

    _.filter(result.events, 'script')
      .flatMap((event) => event.script.exec) // Get script as string
      .flatMap((exec) => {
        const stepName = utils.getStepParameterByPatterns(exec, testPatterns)[0];
        const testCaseId = utils.getStepParameterByPatterns(exec, pmVariablesTestCaseIdPatterns)[0];
        const status = utils.getStepParameterByPatterns(exec, pmVariablesStatusPatterns)[0];

        return Object.assign(
          {},
          stepName ? { stepName } : {},
          testCaseId ? { testCaseId } : {},
          status ? { status } : {},
        );
      })
      .groupBySpecificField('stepName', ['testCaseId', 'status'])
      .forEach((testStep) => {

        const stepName = testStep.stepName;
        const newStep = this.client.startTestItem(
          {
            name: stepName,
            type: 'STEP',
            hasStats: false,
          },
          this.testRun.tempId,
          testTempId,
        );

        newStep.promise.catch(errorHandler);

        this.activeSteps.push({
          tempId: newStep.tempId,
          name: stepName,
          status: testStep.status,
          parent: testTempId,
        });
      });
  }

  finishStep(error, testAssertion) {
    const stepIndex = this.activeSteps.findIndex((step) => step.name === testAssertion.assertion);
    const step = this.activeSteps[stepIndex];
    if (!step) {
      return;
    }

    const errorInfo = error || testAssertion.error;
    if (errorInfo) {
      this.logMessage(step.tempId, errorInfo.message, 'ERROR');
      this.activeTests[this.activeTests.length - 1].status = TestStatus.FAILED;
      step.status = TestStatus.FAILED;
    }

    this.client
      .finishTestItem(step.tempId, {
        status: step.status || (errorInfo ? TestStatus.FAILED : TestStatus.PASSED),
      })
      .promise.catch(errorHandler);
      console.log('fail');

    this.activeSteps.splice(stepIndex, 1);
  }

  finishTestSteps(err, result) {
    if (err) {
      throw err;
    }

    const testTempId = this.getCurrentTestTempId();
    const testWithError = result.executions.find((item) => item.error);

    if (testWithError) {
      // Fails all steps with the same error if there is an error in a test-script
      this.failAllStepsForTestId(testTempId, testWithError.error.message);
    }
  }

  onRequest(error, result) {
    const response = result && result.response;
    this.activeTests[this.activeTests.length - 1].response = response;
    this.activeTests[this.activeTests.length - 1].error = error;
  }

  finishTest(err, result) {
    if (err) {
      throw err;
    }

    const test = this.activeTests[this.activeTests.length - 1];

    if (test.error) {
      this.logMessage(test.tempId, test.error.message, 'ERROR');
      this.activeSuites.forEach(
        (suite) =>
          (this.activeSuites[this.activeSuites.findIndex((s) => s == suite)].status = TestStatus.FAILED),
      );
      this.client
        .finishTestItem(test.tempId, {
          status: test.status || TestStatus.FAILED,
        })
        .promise.catch(errorHandler);

        this.activeTests.pop();
      return;
    }

    if (test.response) {
      this.sendResponseLogs(test.tempId, test.response);
    }

    this.client
      .finishTestItem(test.tempId, {
        status: test.status || TestStatus.PASSED,
      })
      .promise.catch(errorHandler);
      this.activeTests.pop();
  }

  // Finishes suite
  onBeforeDone(err) {
    if (err) {
      throw err;
    }

    this.finishSuite();
  }

  // Finishes launch
  onDone(err, result) {
    if (err) {
      throw err;
    }

    this.client
      .finishLaunch(this.testRun.tempId, {
        status: result.run.failures.length > 0 ? TestStatus.FAILED : TestStatus.PASSED,
      })
      .promise.catch(errorHandler);
  }

  // ------------------
  //  HELPER FUNCTIONS
  // ------------------

  getCurrentSuiteTempId() {
    return this.activeSuites.length
      ? this.activeSuites[this.activeSuites.length - 1].tempId
      : null;
  }

  getCurrentTestTempId() {
    return this.activeTests[this.activeTests.length - 1].tempId;
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

  getTime() {
    return new Date().valueOf();
  }

  logMessage(id, value, level = 'INFO', time = this.getTime()) {
    this.client
      .sendLog(id, {
        level,
        message: value,
        time,
      })
      .promise.catch(errorHandler);
  }

  sendRequestLogs(stepId, request) {
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

    if (request.body && request.body.toString()) {
      message += `Body:\n${request.body.toString()}`;
    }
    this.logMessage(stepId, message);
  }

  sendResponseLogs(stepId, response) {
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
    this.logMessage(stepId, message);
  }

  formattedBody(headers, body) {
    if (headers.find((x) => x.key === 'Content-Type')) {
      var contentType = headers.find((x) => x.key === 'Content-Type').value.toLowerCase();
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

  finishSuite() {
    const currentSuiteTempId = this.getCurrentSuiteTempId();
    const currentSuiteStatus = this.activeSuites[this.activeSuites.length - 1].status || TestStatus.PASSED;
    this.client.finishTestItem(currentSuiteTempId, currentSuiteStatus).promise.catch(errorHandler);
    const stopped = this.activeSuites.pop();
  }

  synchronizeSuiteState(testItem) {
    var testFolderPath = [];
    var structEl = testItem;
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
      testFolderPath[testFolderPath.length - 1].id ==
        this.activeSuites[this.activeSuites.length - 1].postmanId
    ) {
      return; //The current suite is the current structure element
    }

    if (!this.activeSuites.length && testFolderPath.length > 0) {
      
      testFolderPath.forEach((f) => {
        const newSuite = this.client.startTestItem(
          {
            type: 'SUITE',
            name: f.name,
          },
          this.testRun.tempId,
          this.getCurrentSuiteTempId(),
        );

        newSuite.promise.catch(errorHandler);

        this.activeSuites.push({
          tempId: newSuite.tempId,
          name: f.name,
          postmanId: f.id,
        });
      });
      return; // Created new suite (and sub-suite(s)) under the testrun
    }

    var folderIndex = this.activeSuites.length
      ? testFolderPath.findIndex(
          (folder) => folder.id == this.activeSuites[this.activeSuites.length - 1].postmanId,
        )
      : -1;

    if (folderIndex >= 0) {
      //start new struct from index
      for (var i = folderIndex + 1; i < testFolderPath.length; i++) {
        const newSuite = this.client.startTestItem(
          {
            type: 'SUITE',
            name: testFolderPath[i].name,
          },
          this.testRun.tempId,
          this.getCurrentSuiteTempId(),
        );

        newSuite.promise.catch(errorHandler);

        this.activeSuites.push({
          tempId: newSuite.tempId,
          name: testFolderPath[i].name,
          postmanId: testFolderPath[i].id,
        });
      }
      return; //new sub suite(s) of current (last suite is in the testFolderPath)
    }

    //new subfolder(s) of ancestor (other than last from state is in folderpath)
    //check before last index and then lower until an existing folder was found, then close all deeper suites and self-call

    for (var i = this.activeSuites.length - 1; i >= 0; i--) {
      var folderIndex = testFolderPath.findIndex(
        (folder) => folder.id == this.activeSuites[i].postmanId,
      );
      if (folderIndex >= 0) {
        for (var j = 0; j < folderIndex; j++) {
          this.finishSuite();
        }
        break;
      } else {
        this.finishSuite();
      }
    }
    this.synchronizeSuiteState(testItem);
  }

  failAllStepsForTestId(tempId, message) {
    
    this.activeSteps
      .filter((step) => step.parent == tempId)
      .forEach((step) => {
        if (message) {
        this.logMessage(step.tempId, message, 'ERROR');
        }
        this.client
          .finishTestItem(step.tempId, {
            status: TestStatus.FAILED,
          })
          .promise.catch(errorHandler);

        this.activeSteps.splice(this.activeSteps.indexOf(step), 1);
      });
    }
  
}

module.exports = PostmanOrangebeardListener;
