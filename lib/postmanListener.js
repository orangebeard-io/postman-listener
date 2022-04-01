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

/**
 * Possible test execution statuses.
 *
 * @enum {string}
 */
const TestStatus = Object.freeze({
  PASSED: 'PASSED',
  FAILED: 'FAILED',
});

class PostmanListener {
  constructor(newman, options, collectionRunOptions) {
    this.client = !Object.keys(options).length
      ? new OrangebeardClient()
      : new OrangebeardClient(utils.getClientSettings(options));
    this.launchObj = this.client.startLaunch(utils.getStartTestRun(options));
    this.collectionMap = new Map();
    this.suitesInfoStack = [];
    this.decoder = new StringDecoder('utf8');
    this.collectionRunOptions = collectionRunOptions;
    this.options = options;
    this.collectionPath = utils.getCollectionPath(this.collectionRunOptions.workingDir);
    this.logItems = [];

    newman.on('console', this.onConsole.bind(this));
    newman.on('start', this.onStart.bind(this));
    newman.on('beforeRequest', this.onBeforeRequest.bind(this));
    newman.on('beforeTest', this.onBeforeTest.bind(this));
    newman.on('item', this.finishTest.bind(this));
    newman.on('assertion', this.finishStep.bind(this));
    newman.on('test', this.finishAllSteps.bind(this));
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
        this.logItems.push({ level: args.level, message, time: this.getTime() }),
      );
  }

  getCurrentSuiteTempId() {
    const tempId = this.suitesInfoStack.length
      ? this.suitesInfoStack[this.suitesInfoStack.length - 1].tempId
      : null;

    return tempId;
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

  // Starts an item as suite
  onStart(err, result) {
    if (err) {
      throw err;
    }

    const name = this.collectionRunOptions.collection.name;
    const description =
      this.collectionRunOptions.collection.description &&
      this.collectionRunOptions.collection.description.content;
    const codeRef = utils.getCodeRef(this.collectionPath, name);

    const suiteObj = this.client.startTestItem(
      {
        type: 'SUITE',
        name,
        description,
        codeRef,
        testCaseId: utils.getCollectionVariablesByKey(
          'testCaseId',
          this.collectionRunOptions.collection.variables,
        ),
        attributes: utils.getAttributes(this.collectionRunOptions.collection.variables),
      },
      this.launchObj.tempId,
    );

    suiteObj.promise.catch(errorHandler);

    this.suitesInfoStack.push({ tempId: suiteObj.tempId, ref: result.cursor.ref });
  }

  // Starts a request as test
  onBeforeRequest(err, result) {
    if (err) {
      throw err;
    }
    const name = this.getTestName(result);
    if (!name) {
      return;
    }
    const parentId = this.getCurrentSuiteTempId();
    const description = result.request.description && result.request.description.content;
    const codeRefTitle = `${this.collectionRunOptions.collection.name}/${result.item.name}`;
    const codeRef = utils.getCodeRef(this.collectionPath, codeRefTitle);
    const parameters = utils.getParameters(
      this.collectionRunOptions.iterationData,
      result.cursor.iteration,
    );

    const testObj = this.client.startTestItem(
      {
        name,
        type: 'TEST',
        description,
        codeRef,
        parameters,
        testCaseId: utils.getCollectionVariablesByKey(
          'testCaseId',
          this.collectionRunOptions.environment.values,
        ),
        attributes: utils.getAttributes(this.collectionRunOptions.environment.values),
      },
      this.launchObj.tempId,
      parentId,
    );

    testObj.promise.catch(errorHandler);

    this.sendRequestLogs(testObj.tempId, result.request);
    this.collectionMap.set(result.cursor.ref, {
      testId: testObj.tempId,
      requestId: result.cursor.httpRequestId || result.item.id,
      steps: [],
      status: utils.getCollectionVariablesByKey(
        'status',
        this.collectionRunOptions.environment.values,
      ),
    });

    this.logItems &&
      this.logItems.forEach((log) =>
        this.logMessage(testObj.tempId, log.message, log.level, log.time),
      );
    this.logItems = [];
  }

  // Starts test scripts as test steps
  onBeforeTest(err, result) {
    if (err) {
      throw err;
    }
    const testObj = this.collectionMap.get(result.cursor.ref);

    _.filter(result.events, 'script')
      .flatMap((event) => event.script.exec) // Extracts test script's strings
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
      .forEach((stepInfoObj) => {
        // Starts a new step for every test in a test script
        const stepName = stepInfoObj.stepName;
        const codeRefTitle = `${this.collectionRunOptions.collection.name}/${result.item.name}/${stepName}`;
        const parameters = utils.getParameters(
          this.collectionRunOptions.iterationData,
          result.cursor.iteration,
        );
        const codeRef = utils.getCodeRef(this.collectionPath, codeRefTitle);
        const stepObj = this.client.startTestItem(
          Object.assign(
            {
              name: stepName,
              type: 'STEP',
              parameters,
              codeRef,
              hasStats: false,
            },
            stepInfoObj.testCaseId ? { testCaseId: stepInfoObj.testCaseId } : {},
          ),
          this.launchObj.tempId,
          testObj.testId,
        );

        stepObj.promise.catch(errorHandler);

        testObj.steps.push({
          stepId: stepObj.tempId,
          name: stepName,
          status: stepInfoObj.status,
        });
      });
  }

  finishStep(error, testAssertion) {
    const testObj = this.collectionMap.get(testAssertion.cursor.ref);
    if (!testObj) {
      return;
    }
    const currentStepIndex = testObj.steps.findIndex(
      (step) => step.name === testAssertion.assertion,
    );
    const currentStep = testObj.steps[currentStepIndex];
    testObj.steps.splice(currentStepIndex, 1);

    if (!currentStep) {
      return;
    }
    const actualError = error || testAssertion.error;
    if (actualError) {
      // Logs error message for the failed steps
      this.logMessage(currentStep.stepId, actualError.message, 'ERROR');
      testObj.status = TestStatus.FAILED;
    }

    this.client
      .finishTestItem(currentStep.stepId, {
        status: currentStep.status || (actualError ? TestStatus.FAILED : TestStatus.PASSED),
      })
      .promise.catch(errorHandler);
    this.collectionMap.set(testAssertion.cursor.ref, testObj);
  }

  finishAllSteps(err, testResult) {
    if (err) {
      throw err;
    }

    const testObj = this.collectionMap.get(testResult.cursor.ref);
    const testWithError = testResult.executions.find((item) => item.error);

    if (testWithError) {
      // Fails all steps with the same error if there is an error in a test-script
      this.failAllSteps(testObj, testWithError.error.message);
    }
  }

  onRequest(error, result) {
    const testObj = this.collectionMap.get(result.cursor.ref);

    if (testObj) {
      this.collectionMap.set(result.cursor.ref, {
        ...testObj,
        response: result && result.response,
        error,
      });
    }
  }

  finishTest(err, result) {
    if (err) {
      throw err;
    }

    const testObj = this.collectionMap.get(result.cursor.ref);
    if (!testObj) {
      return;
    }
    const status = testObj.status;

    if (testObj.error) {
      this.logMessage(testObj.testId, testObj.error.message, 'ERROR');

      this.client
        .finishTestItem(testObj.testId, {
          status: status || TestStatus.FAILED,
        })
        .promise.catch(errorHandler);

      return;
    }

    if (testObj.response) {
      this.sendResponseLogs(testObj.testId, testObj.response);
    }

    this.client
      .finishTestItem(testObj.testId, {
        status: status || TestStatus.PASSED,
      })
      .promise.catch(errorHandler);
  }

  // Finishes suite
  onBeforeDone(err) {
    if (err) {
      throw err;
    }

    this.finishSuite();
    this.suitesInfoStack.pop();
  }

  // Finishes launch
  onDone(err, result) {
    if (err) {
      throw err;
    }
    const status =
      this.collectionRunOptions.collection &&
      utils.getCollectionVariablesByKey(
        'launchStatus',
        this.collectionRunOptions.collection.variables,
      );

    this.client
      .finishLaunch(this.launchObj.tempId, {
        status: status || (result.run.failures ? TestStatus.FAILED : TestStatus.PASSED),
      })
      .promise.catch(errorHandler);
  }

  // eslint-disable-next-line class-methods-use-this
  getTime() {
    return new Date().valueOf();
  }

  /**
   * Sends log message
   *
   * @param  {string} id item id.
   * @param  {string} value Message value.
   * @param  {string} [level="INFO"] Log level.
   * @param  {number} time when the log was started.
   */
  logMessage(id, value, level = 'INFO', time = this.getTime()) {
    this.client
      .sendLog(id, {
        level,
        message: value,
        time,
      })
      .promise.catch(errorHandler);
  }

  /**
   * Sends request data logs for a specific request: URL, method, headers, body.
   *
   * @param  {string} stepId Id of request's step.
   * @param  {Object} request Http request.
   */
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

  /**
   * Sends response data logs for a specific request: response code, status, headers, body.
   *
   * @param  {string} stepId Id of request's step.
   * @param  {Object} response Http response.
   */
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

  /**
   * Formats the response to a (pretty-printed) string in case of xml or json content types.
   *
   * @param {Map} headers The response headers
   * @param {string} body The raw body String
   * @returns a formatted string, or the original raw body
   */
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

  /**
   * Fails all steps of the given test object with sending the same error message for each of them.
   *
   * @param  {Object} testObj Test object with steps to fail.
   * @param  {string} message Error message to log.
   */
  failAllSteps(testObj, message) {
    _.forEach(testObj.steps, (step) => {
      this.logMessage(step.stepId, message, 'ERROR');

      this.client
        .finishTestItem(step.stepId, {
          status: TestStatus.FAILED,
        })
        .promise.catch(errorHandler);
    });
  }

  finishSuite() {
    const currentSuiteTempId = this.getCurrentSuiteTempId();
    const status =
      this.collectionRunOptions.collection &&
      utils.getCollectionVariablesByKey('status', this.collectionRunOptions.collection.variables);

    this.client.finishTestItem(currentSuiteTempId, { status }).promise.catch(errorHandler);
  }
}

module.exports = PostmanListener;
