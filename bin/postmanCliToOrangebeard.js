#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const OrangebeardAsyncV3Client = require('@orangebeard-io/javascript-client');
const { ZonedDateTime } = require('@js-joda/core');
const utils = require('../lib/utils');
const { TestStatus } = require('../lib/constants/types');

function parseJsonReport(report) {
  // Postman CLI JSON exports a top-level "run" with "executions".
  const run = report.run;
  if (!run) {
    throw new Error('Unsupported report format: missing "run" property');
  }

  const executions = run.executions || [];
  if (!Array.isArray(executions)) {
    throw new Error('Unsupported report format: expected run.executions to be an array');
  }

  return { run, executions };
}

function getDurationMs(execution) {
  if (execution.response && typeof execution.response.responseTime === 'number') {
    return execution.response.responseTime;
  }
  if (typeof execution.duration === 'number') {
    return execution.duration;
  }
  // Fallback to 1 second if no timing info is available.
  return 1000;
}

function getRequestFromExecution(execution) {
  // Postman CLI JSON uses "requestExecuted" for the actual request metadata.
  return (
    execution.requestExecuted ||
    execution.request ||
    (execution.item && execution.item.request) ||
    null
  );
}

function getResponseFromExecution(execution) {
  return execution.response || null;
}

function getAssertionsFromExecution(execution) {
  if (Array.isArray(execution.assertions)) {
    return execution.assertions;
  }
  if (Array.isArray(execution.tests)) {
    return execution.tests;
  }
  return [];
}

function buildHeadersList(headersLike) {
  if (!headersLike) return [];

  if (Array.isArray(headersLike)) {
    return headersLike
      .filter(Boolean)
      .map((h) => `${h.key || h.name}: ${h.value}`);
  }

  if (headersLike.members && Array.isArray(headersLike.members)) {
    return headersLike.members.map((h) => `${h.key}:${h.value}`);
  }

  return Object.keys(headersLike).map((k) => `${k}:${headersLike[k]}`);
}

function getBodyStringFromRequest(req) {
  if (!req || !req.body) return '';

  if (typeof req.body === 'string') return req.body;
  if (req.body.raw) return req.body.raw;
  if (req.body.mode && req.body[req.body.mode]) {
    try {
      return JSON.stringify(req.body[req.body.mode], null, 2);
    } catch (e) {
      return String(req.body[req.body.mode]);
    }
  }

  try {
    return JSON.stringify(req.body, null, 2);
  } catch (e) {
    return String(req.body);
  }
}

function getBodyStringFromResponse(res) {
  if (!res) return '';

  if (typeof res.body === 'string') return res.body;

  // Postman CLI JSON: response.stream is a Buffer-like object: { type: 'Buffer', data: [ ... ] }.
  if (res.stream && Array.isArray(res.stream.data)) {
    try {
      return Buffer.from(res.stream.data).toString('utf8');
    } catch (e) {
      // fall through to other formats
    }
  }

  if (typeof res.stream === 'string') return res.stream;

  if (res.json) {
    try {
      return JSON.stringify(res.json, null, 2);
    } catch (e) {
      return String(res.json);
    }
  }

  return '';
}

function buildItemHierarchy(collection) {
  const itemMap = new Map();
  
  function traverse(items, parentPath = []) {
    if (!Array.isArray(items)) return;
    
    items.forEach((item) => {
      const itemName = item.name || 'Unnamed';
      
      if (Array.isArray(item.item) && item.item.length > 0) {
        const currentPath = [...parentPath, itemName];
        itemMap.set(item.id, { path: currentPath, isFolder: true });
        traverse(item.item, currentPath); // Recurse into folder items
      } else {
        itemMap.set(item.id, { path: parentPath, isFolder: false });
      }
    });
  }
  
  if (collection && collection.item) {
    traverse(collection.item);
  }
  
  return itemMap;
}

function getOrCreateSuiteForPath(client, testRunUUID, path, suiteCache) {
  if (path.length === 0) return null;
  
  const pathKey = path.join('/');
  
  if (suiteCache.has(pathKey)) {
    return suiteCache.get(pathKey);
  }
  
  // Get or create parent suite first
  const parentPath = path.slice(0, -1);
  const parentSuiteUUID = parentPath.length > 0 
    ? getOrCreateSuiteForPath(client, testRunUUID, parentPath, suiteCache)
    : null;
  
  // Create this suite
  const suiteUUIDs = client.startSuite({
    testRunUUID,
    parentSuiteUUID,
    suiteNames: [path[path.length - 1]],
  });
  
  const suiteUUID = Array.isArray(suiteUUIDs) ? suiteUUIDs[0] : suiteUUIDs;
  suiteCache.set(pathKey, suiteUUID);
  
  return suiteUUID;
}

function logError(client, testRunUUID, testUUID, error, logTime, stepUUID = undefined) {
  if (!error) return;

  let message = '';
  
  // Handle different error formats
  if (error.type && error.name) {
    message = `${error.type}: ${error.name}`;
    if (error.message) {
      message += ` - ${error.message}`;
    }
  } else if (error.message) {
    message = error.message;
  } else {
    message = 'Unknown error';
  }

  // Add error source context if available
  if (error.source) {
    message = `**${error.source}**\n\n${message}`;
  }

  // Add error code/errno if available
  if (error.code) {
    message = `**${error.code}${error.errno ? ` (${error.errno})**` : ''}\n\n${message}`;
  }

  client.log({
    testRunUUID,
    testUUID,
    stepUUID,
    logTime: logTime.toString(),
    message,
    logLevel: 'ERROR',
    logFormat: 'MARKDOWN',
  });
}

function main() {
  const args = process.argv.slice(2);
  const reportPath = args[0];

  if (!reportPath) {
    console.error('Usage: postman-cli-to-orangebeard <path-to-report.json> [--endpoint <url>] [--token <token>] [--testset <name>] [--project <name>] [--attributes <attrs>] [--description <desc>]');
    process.exit(1);
  }

  // Parse command-line arguments into a reporterConfig object
  const reporterConfig = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--endpoint' && args[i + 1]) {
      reporterConfig.orangebeardIoOrangebeardEndpoint = args[++i];
    } else if (args[i] === '--token' && args[i + 1]) {
      reporterConfig.orangebeardIoOrangebeardToken = args[++i];
    } else if (args[i] === '--testset' && args[i + 1]) {
      reporterConfig.orangebeardIoOrangebeardTestset = args[++i];
    } else if (args[i] === '--project' && args[i + 1]) {
      reporterConfig.orangebeardIoOrangebeardProject = args[++i];
    } else if (args[i] === '--attributes' && args[i + 1]) {
      reporterConfig.orangebeardIoOrangebeardAttributes = args[++i];
    } else if (args[i] === '--description' && args[i + 1]) {
      reporterConfig.orangebeardIoOrangebeardDescription = args[++i];
    }
  }

  const absolutePath = path.resolve(process.cwd(), reportPath);
  const raw = fs.readFileSync(absolutePath, 'utf8');
  const json = JSON.parse(raw);

  const { run, executions } = parseJsonReport(json);

  if (!Array.isArray(executions) || executions.length === 0) {
    console.error('No executions found in report');
    process.exit(1);
  }

  const config = Object.keys(reporterConfig).length > 0 
    ? utils.getOrangebeardParameters(reporterConfig)
    : {};
  
  const client = Object.keys(config).length > 0
    ? new OrangebeardAsyncV3Client(config)
    : new OrangebeardAsyncV3Client();
  const orangebeardConfig = client.config || {};

  const meta = run.meta || {};

  // Base time for the run and first test; other timestamps are derived from durations.
  // Prefer the Postman CLI "meta.started" timestamp when available (epoch millis).
  const runStartEpochMs =
    typeof meta.started === 'number' ? meta.started : Date.now();
  let currentOffsetMs = 0;

  const runStartIso = new Date(runStartEpochMs).toISOString();
  const runStartZoned = ZonedDateTime.parse(runStartIso);

  const startTestRunPayload = utils.getStartTestRun(orangebeardConfig);
  startTestRunPayload.startTime = runStartZoned.toString();

  const testRunUUID = client.startTestRun(startTestRunPayload);

  const suiteName =
    meta.collectionName ||
    (run.info && run.info.name) ||
    (run.collection && run.collection.info && run.collection.info.name) ||
    'Postman CLI run';

  // Build item hierarchy if collection structure is available
  const itemMap = buildItemHierarchy(json.collection);
  const suiteCache = new Map();
  
  // Create root suite
  const rootSuiteUUIDs = client.startSuite({
    testRunUUID,
    parentSuiteUUID: null,
    suiteNames: [suiteName],
  });

  const rootSuiteUUID = Array.isArray(rootSuiteUUIDs) ? rootSuiteUUIDs[0] : rootSuiteUUIDs;
  
  suiteCache.set('', rootSuiteUUID);

  executions.forEach((execution) => {
    const request = getRequestFromExecution(execution);
    const response = getResponseFromExecution(execution);

    const requestName =
      (request && request.name) ||
      (execution.item && execution.item.name) ||
      'Unnamed request';

    let suiteUUID = rootSuiteUUID;
    
    const itemId = execution.item && execution.item.id;
    if (itemId && itemMap.has(itemId)) {
      const itemInfo = itemMap.get(itemId);
      if (itemInfo.path.length > 0) {
        suiteUUID = getOrCreateSuiteForPath(client, testRunUUID, itemInfo.path, suiteCache);
      }
    }

    const durationMs = getDurationMs(execution);

    const testStartEpochMs = runStartEpochMs + currentOffsetMs;
    const testEndEpochMs = testStartEpochMs + durationMs;
    currentOffsetMs += durationMs;

    const testStartIso = new Date(testStartEpochMs).toISOString();
    const testEndIso = new Date(testEndEpochMs).toISOString();
    const testStart = ZonedDateTime.parse(testStartIso);
    const testEnd = ZonedDateTime.parse(testEndIso);

    const testUUID = client.startTest({
      testRunUUID,
      suiteUUID,
      testName: requestName,
      testType: 'TEST',
      description:
        (request && request.description && request.description.content) ||
        (request && request.description) ||
        undefined,
      startTime: testStart.toString(),
    });

    // Log request headers and body
    if (request) {
      const headersArray = request.header || request.headers;
      const headers = buildHeadersList(headersArray);
      let message = '### Request\n\n';

      // Meta section with clear spacing and bullet points
      message += '**Meta**\n\n';

      if (request.url) {
        const urlObj = request.url;
        let url = '';
        if (typeof urlObj === 'string') {
          url = urlObj;
        } else {
          const protocol = urlObj.protocol ? `${urlObj.protocol}://` : '';
          const host = Array.isArray(urlObj.host) ? urlObj.host.join('.') : urlObj.host || '';
          const port = urlObj.port ? `:${urlObj.port}` : '';
          const pathSegments = Array.isArray(urlObj.path) ? urlObj.path.join('/') : urlObj.path || '';
          const path = pathSegments ? `/${pathSegments}` : '';
          url = `${protocol}${host}${port}${path}`;
        }
        message += `- **URL:** ${url}\n`;
      }

      if (request.method) {
        message += `- **Method:** ${request.method}\n`;
      }

      // Include absolute timing info in millis for log correlation.
      message += `- **Start (epoch ms):** ${testStartEpochMs}\n`;
      message += `- **End (epoch ms):** ${testEndEpochMs}\n`;
      message += `- **Duration (ms):** ${durationMs}\n\n`;

      if (headersArray && headersArray.length) {
        message += '**Headers**\n\n';
        message += '| Key | Value |\n';
        message += '| --- | ----- |\n';
        headersArray.forEach((h) => {
          if (!h || !h.key) return;
          message += `| ${h.key} | ${h.value} |\n`;
        });
        message += '\n';
      }

      const bodyStr = getBodyStringFromRequest(request);
      if (bodyStr) {
        const contentTypeHeader =
          Array.isArray(headersArray) && headersArray.find((h) => h.key === 'Content-Type');
        const contentType = contentTypeHeader?.value?.toLowerCase?.() || '';

        if (contentType.includes('json')) {
          let formatted = bodyStr;
          try {
            formatted = JSON.stringify(JSON.parse(bodyStr), null, 2);
          } catch (e) {
            // keep original if parse fails
          }
          message += '**Body (JSON)**\n```json\n';
          message += `${formatted}\n`;
          message += '```\n';
        } else if (contentType.includes('xml')) {
          let formatted = bodyStr;
          try {
            // xml-formatter is only used in the reporter; here we send raw XML as-is.
            formatted = bodyStr;
          } catch (e) {
            // keep original
          }
          message += '**Body (XML)**\n```xml\n';
          message += `${formatted}\n`;
          message += '```\n';
        } else {
          message += '**Body**\n```text\n';
          message += `${bodyStr}\n`;
          message += '```\n';
        }
      }

      client.log({
        testRunUUID,
        testUUID,
        logTime: testStart.toString(),
        message,
        logLevel: 'INFO',
        logFormat: 'MARKDOWN',
      });
    }

    let testStatus = TestStatus.PASSED;
    const assertions = getAssertionsFromExecution(execution);

    assertions.forEach((assertion) => {
      const stepName = assertion.assertion || assertion.name || 'Assertion';
      const stepStart = testStart;
      const stepEnd = testEnd;

      const stepUUID = client.startStep({
        testRunUUID,
        testUUID,
        stepName,
        startTime: stepStart.toString(),
      });

      let stepStatus = TestStatus.PASSED;
      const error = assertion.error;
      const status = (assertion.status || '').toLowerCase();

      if (error || status === 'failed') {
        stepStatus = TestStatus.FAILED;
        testStatus = TestStatus.FAILED;

        if (error) {
          logError(client, testRunUUID, testUUID, error, stepEnd, stepUUID);
        } else {
          // If no error object but status is failed, log a generic failure message
          client.log({
            testRunUUID,
            testUUID,
            stepUUID,
            logTime: stepEnd.toString(),
            message: 'Assertion failed',
            logLevel: 'ERROR',
            logFormat: 'MARKDOWN',
          });
        }
      }

      client.finishStep(stepUUID, {
        testRunUUID,
        status: stepStatus,
        endTime: stepEnd.toString(),
      });
    });

    // Log response headers and body
    if (response) {
      const headersArray = response.header || response.headers;
      const headers = buildHeadersList(headersArray);
      const bodyStr = getBodyStringFromResponse(response);

      let message = '### Response\n\n';

      message += '**Meta**\n\n';

      if (response.code != null) {
        message += `- **Code:** ${response.code}\n`;
      }

      if (response.status) {
        message += `- **Status:** ${response.status}\n`;
      }

      message += '\n';

      if (headersArray && headersArray.length) {
        message += '**Headers**\n\n';
        message += '| Key | Value |\n';
        message += '| --- | ----- |\n';
        headersArray.forEach((h) => {
          if (!h || !h.key) return;
          message += `| ${h.key} | ${h.value} |\n`;
        });
        message += '\n';
      }

      if (bodyStr) {
        const contentTypeHeader =
          Array.isArray(headersArray) && headersArray.find((h) => h.key === 'Content-Type');
        const contentType = contentTypeHeader?.value?.toLowerCase?.() || '';

        if (contentType.includes('json')) {
          let formatted = bodyStr;
          try {
            formatted = JSON.stringify(JSON.parse(bodyStr), null, 2);
          } catch (e) {
            // keep original if parse fails
          }
          message += '**Body (JSON)**\n```json\n';
          message += `${formatted}\n`;
          message += '```\n';
        } else if (contentType.includes('xml')) {
          const formatted = bodyStr;
          message += '**Body (XML)**\n```xml\n';
          message += `${formatted}\n`;
          message += '```\n';
        } else {
          message += '**Body**\n```text\n';
          message += `${bodyStr}\n`;
          message += '```\n';
        }
      }

      client.log({
        testRunUUID,
        testUUID,
        logTime: testEnd.toString(),
        message,
        logLevel: 'INFO',
        logFormat: 'MARKDOWN',
      });
    }

    // Handle Newman-style requestError (network/connection errors)
    if (execution.requestError) {
      testStatus = TestStatus.FAILED;
      logError(client, testRunUUID, testUUID, execution.requestError, testEnd);
    }

    // Handle Newman-style testScript errors (script execution errors)
    if (Array.isArray(execution.testScript)) {
      execution.testScript.forEach((scriptResult) => {
        if (scriptResult.error) {
          testStatus = TestStatus.FAILED;
          logError(client, testRunUUID, testUUID, scriptResult.error, testEnd);
        }
      });
    }

    // Top-level execution error, if any
    if (execution.error) {
      testStatus = TestStatus.FAILED;
      logError(client, testRunUUID, testUUID, execution.error, testEnd);
    }

    // Handle errors array (from Postman CLI JSON format)
    if (Array.isArray(execution.errors) && execution.errors.length) {
      testStatus = TestStatus.FAILED;
      execution.errors.forEach((err) => {
        logError(client, testRunUUID, testUUID, err, testEnd);
      });
    }

    client.finishTest(testUUID, {
      testRunUUID,
      status: testStatus,
      endTime: testEnd.toString(),
    });
  });

  const runEndEpochMs =
    typeof meta.completed === 'number'
      ? meta.completed
      : runStartEpochMs + currentOffsetMs;
  const runEndIso = new Date(runEndEpochMs).toISOString();
  const runEndZoned = ZonedDateTime.parse(runEndIso);

  client.finishTestRun(testRunUUID, {
    endTime: runEndZoned.toString(),
  });
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('Failed to report Postman CLI JSON to Orangebeard:');
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
}
