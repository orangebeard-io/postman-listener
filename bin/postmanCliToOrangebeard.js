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
  const parentSuiteUUID =
    parentPath.length > 0
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

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.pdf': 'application/pdf',
    '.csv': 'text/csv',
    '.log': 'text/plain',
    '.bat': 'text/plain',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

function findAttachmentFiles(attachmentsPath, requestId, assertionName) {
  if (!attachmentsPath || !fs.existsSync(attachmentsPath)) {
    return [];
  }

  const searchPattern = `${requestId}_${assertionName}`;

  try {
    const files = fs.readdirSync(attachmentsPath);
    const matchingFiles = files.filter((file) => {
      // Case-insensitive matching: check if filename (without extension) matches the pattern
      const fileNameWithoutExt = path.parse(file).name;
      return fileNameWithoutExt.toLowerCase() === searchPattern.toLowerCase();
    });

    return matchingFiles.map((file) => path.join(attachmentsPath, file));
  } catch (err) {
    console.error(`Error reading attachments directory: ${err.message}`);
    return [];
  }
}

function wrapLongLines(message, maxLineLength = 255) {
  if (!message) return '';

  // Split message into lines
  const lines = message.split('\n');
  const wrappedLines = [];

  for (const line of lines) {
    // If line is shorter than max length, keep as is
    if (line.length <= maxLineLength) {
      wrappedLines.push(line);
    } else {
      // Break long line into chunks of maxLineLength
      let remainingLine = line;
      while (remainingLine.length > 0) {
        wrappedLines.push(remainingLine.substring(0, maxLineLength));
        remainingLine = remainingLine.substring(maxLineLength);
      }
    }
  }

  return wrappedLines.join('\n');
}

function buildErrorMessage(error) {
  if (!error) return 'Unknown error';

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
    message = `**${error.code}${error.errno ? ` (${error.errno})` : ''}**\n\n${message}`;
  }

  return message;
}

function attachFile(client, filePath, testRunUUID, testUUID, stepUUID, logUUID, logTime) {
  try {
    const fileContent = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const mimeType = getMimeType(filePath);

    client.sendAttachment({
      file: {
        name: fileName,
        content: fileContent,
        contentType: mimeType,
      },
      metaData: {
        testRunUUID,
        testUUID,
        stepUUID,
        logUUID,
        attachmentTime: logTime.toString(),
      },
    });
  } catch (err) {
    console.error(`Failed to attach file ${filePath}: ${err.message}`);
  }
}

function logError(client, testRunUUID, testUUID, error, logTime, stepUUID = undefined) {
  if (!error) return;

  const message = buildErrorMessage(error);

  client.log({
    testRunUUID,
    testUUID,
    stepUUID,
    logTime: logTime.toString(),
    message: wrapLongLines(message),
    logLevel: 'ERROR',
    logFormat: 'MARKDOWN',
  });
}

function main() {
  const args = process.argv.slice(2);
  const reportPath = args[0];

  if (!reportPath) {
    console.error(
      'Usage: postman-cli-to-orangebeard <path-to-report.json> [--endpoint <url>] [--token <token>] [--testset <name>] [--project <name>] [--attributes <attrs>] [--description <desc>] [--attachments-path <path>]',
    );
    process.exit(1);
  }

  // Parse command-line arguments into a reporterConfig object
  const reporterConfig = {};
  let attachmentsPath = null;
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
      const value = args[++i];
      if (value) {
        reporterConfig.orangebeardIoOrangebeardAttributes = value;
      }
    } else if (args[i] === '--description' && args[i + 1]) {
      const value = args[++i];
      if (value) {
        reporterConfig.orangebeardIoOrangebeardDescription = value;
      }
    } else if (args[i] === '--attachments-path' && args[i + 1]) {
      const value = args[++i];
      if (value) {
        attachmentsPath = path.resolve(value);
      }
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

  const projects = utils.parseProjects(reporterConfig);

  const clients = projects.map((project) => {
    const config = !Object.keys(reporterConfig).length
      ? {}
      : { ...utils.getOrangebeardParameters(reporterConfig), project };
    return !Object.keys(config).length
      ? new OrangebeardAsyncV3Client()
      : new OrangebeardAsyncV3Client(config);
  });

  const orangebeardConfig = clients[0].config || {};

  const meta = run.meta || {};

  // Base time for the run and first test; other timestamps are derived from durations.
  // Prefer the Postman CLI "meta.started" timestamp when available (epoch millis).
  const runStartEpochMs = typeof meta.started === 'number' ? meta.started : Date.now();
  let currentOffsetMs = 0;

  const runStartIso = new Date(runStartEpochMs).toISOString();
  const runStartZoned = ZonedDateTime.parse(runStartIso);

  const startTestRunPayload = utils.getStartTestRun(orangebeardConfig);
  startTestRunPayload.startTime = runStartZoned.toString();

  const testRunUUIDs = clients.map((client) => client.startTestRun(startTestRunPayload));

  const suiteName =
    meta.collectionName ||
    (run.info && run.info.name) ||
    (run.collection && run.collection.info && run.collection.info.name) ||
    'Postman CLI run';

  // Build item hierarchy if collection structure is available
  const itemMap = buildItemHierarchy(json.collection);
  const suiteCaches = clients.map(() => new Map());

  // Create root suite for each client
  const rootSuiteUUIDs = clients.map((client, clientIndex) => {
    const rootSuiteUUIDs = client.startSuite({
      testRunUUID: testRunUUIDs[clientIndex],
      parentSuiteUUID: null,
      suiteNames: [suiteName],
    });

    const rootSuiteUUID = Array.isArray(rootSuiteUUIDs) ? rootSuiteUUIDs[0] : rootSuiteUUIDs;

    suiteCaches[clientIndex].set('', rootSuiteUUID);

    return rootSuiteUUID;
  });

  executions.forEach((execution) => {
    const request = getRequestFromExecution(execution);
    const response = getResponseFromExecution(execution);

    const requestName =
      (request && request.name) || (execution.item && execution.item.name) || 'Unnamed request';

    const durationMs = getDurationMs(execution);

    const testStartEpochMs = runStartEpochMs + currentOffsetMs;
    const testEndEpochMs = testStartEpochMs + durationMs;
    currentOffsetMs += durationMs;

    const testStartIso = new Date(testStartEpochMs).toISOString();
    const testEndIso = new Date(testEndEpochMs).toISOString();
    const testStart = ZonedDateTime.parse(testStartIso);
    const testEnd = ZonedDateTime.parse(testEndIso);

    const testUUIDs = clients.map((client, clientIndex) => {
      let suiteUUID = rootSuiteUUIDs[clientIndex];

      const itemId = execution.item && execution.item.id;
      if (itemId && itemMap.has(itemId)) {
        const itemInfo = itemMap.get(itemId);
        if (itemInfo.path.length > 0) {
          suiteUUID = getOrCreateSuiteForPath(
            client,
            testRunUUIDs[clientIndex],
            itemInfo.path,
            suiteCaches[clientIndex],
          );
        }
      }

      return client.startTest({
        testRunUUID: testRunUUIDs[clientIndex],
        suiteUUID,
        testName: requestName,
        testType: 'TEST',
        description:
          (request && request.description && request.description.content) ||
          (request && request.description) ||
          undefined,
        startTime: testStart.toString(),
      });
    });

    // Log request headers and body
    if (request) {
      const headersArray = request.header || request.headers;
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
          const pathSegments = Array.isArray(urlObj.path)
            ? urlObj.path.join('/')
            : urlObj.path || '';
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

      clients.forEach((client, clientIndex) => {
        client.log({
          testRunUUID: testRunUUIDs[clientIndex],
          testUUID: testUUIDs[clientIndex],
          logTime: testStart.toString(),
          message: wrapLongLines(message),
          logLevel: 'INFO',
          logFormat: 'MARKDOWN',
        });
      });
    }

    const testStatuses = clients.map(() => TestStatus.PASSED);
    const assertions = getAssertionsFromExecution(execution);

    // Get the request ID for attachment file matching
    const requestId = execution.id || (execution.item && execution.item.id);

    assertions.forEach((assertion) => {
      const stepName = assertion.assertion || assertion.name || 'Assertion';
      const stepStart = testStart;
      const stepEnd = testEnd;

      clients.forEach((client, clientIndex) => {
        const stepUUID = client.startStep({
          testRunUUID: testRunUUIDs[clientIndex],
          testUUID: testUUIDs[clientIndex],
          stepName,
          startTime: stepStart.toString(),
        });

        let stepStatus = TestStatus.PASSED;
        const error = assertion.error;
        const status = (assertion.status || '').toLowerCase();

        // Check for attachment files before logging
        let attachmentFiles = [];
        if (attachmentsPath && requestId) {
          attachmentFiles = findAttachmentFiles(attachmentsPath, requestId, stepName);
        }

        if (error || status === 'failed') {
          stepStatus = TestStatus.FAILED;
          testStatuses[clientIndex] = TestStatus.FAILED;

          if (error) {
            const errorMsg = buildErrorMessage(error);

            const logId = client.log({
              testRunUUID: testRunUUIDs[clientIndex],
              testUUID: testUUIDs[clientIndex],
              stepUUID,
              logTime: stepEnd.toString(),
              message: wrapLongLines(errorMsg),
              logLevel: 'ERROR',
              logFormat: 'MARKDOWN',
            });

            // Attach files to the error log if any exist
            attachmentFiles.forEach((filePath) => {
              attachFile(
                client,
                filePath,
                testRunUUIDs[clientIndex],
                testUUIDs[clientIndex],
                stepUUID,
                logId,
                stepEnd,
              );
            });
          } else {
            // If no error object but status is failed, log a generic failure message
            const logId = client.log({
              testRunUUID: testRunUUIDs[clientIndex],
              testUUID: testUUIDs[clientIndex],
              stepUUID,
              logTime: stepEnd.toString(),
              message: wrapLongLines('Assertion failed'),
              logLevel: 'ERROR',
              logFormat: 'MARKDOWN',
            });

            // Attach files to the failure log if any exist
            attachmentFiles.forEach((filePath) => {
              attachFile(
                client,
                filePath,
                testRunUUIDs[clientIndex],
                testUUIDs[clientIndex],
                stepUUID,
                logId,
                stepEnd,
              );
            });
          }
        } else if (attachmentFiles.length > 0) {
          // Assertion passed but has evidence files - log them at INFO level
          const logId = client.log({
            testRunUUID: testRunUUIDs[clientIndex],
            testUUID: testUUIDs[clientIndex],
            stepUUID,
            logTime: stepEnd.toString(),
            message: wrapLongLines(`Assertion evidence`),
            logLevel: 'INFO',
            logFormat: 'PLAIN_TEXT',
          });

          attachmentFiles.forEach((filePath) => {
            attachFile(
              client,
              filePath,
              testRunUUIDs[clientIndex],
              testUUIDs[clientIndex],
              stepUUID,
              logId,
              stepEnd,
            );
          });
        }

        client.finishStep(stepUUID, {
          testRunUUID: testRunUUIDs[clientIndex],
          status: stepStatus,
          endTime: stepEnd.toString(),
        });
      });
    });

    // Log response headers and body
    if (response) {
      const headersArray = response.header || response.headers;
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

      clients.forEach((client, clientIndex) => {
        client.log({
          testRunUUID: testRunUUIDs[clientIndex],
          testUUID: testUUIDs[clientIndex],
          logTime: testEnd.toString(),
          message: wrapLongLines(message),
          logLevel: 'INFO',
          logFormat: 'MARKDOWN',
        });
      });
    }

    // Handle Newman-style requestError (network/connection errors)
    if (execution.requestError) {
      clients.forEach((client, clientIndex) => {
        testStatuses[clientIndex] = TestStatus.FAILED;
        logError(
          client,
          testRunUUIDs[clientIndex],
          testUUIDs[clientIndex],
          execution.requestError,
          testEnd,
        );
      });
    }

    // Handle Newman-style testScript errors (script execution errors)
    if (Array.isArray(execution.testScript)) {
      execution.testScript.forEach((scriptResult) => {
        if (scriptResult.error) {
          clients.forEach((client, clientIndex) => {
            testStatuses[clientIndex] = TestStatus.FAILED;
            logError(
              client,
              testRunUUIDs[clientIndex],
              testUUIDs[clientIndex],
              scriptResult.error,
              testEnd,
            );
          });
        }
      });
    }

    // Top-level execution error, if any
    if (execution.error) {
      clients.forEach((client, clientIndex) => {
        testStatuses[clientIndex] = TestStatus.FAILED;
        logError(
          client,
          testRunUUIDs[clientIndex],
          testUUIDs[clientIndex],
          execution.error,
          testEnd,
        );
      });
    }

    // Handle errors array (from Postman CLI JSON format)
    if (Array.isArray(execution.errors) && execution.errors.length) {
      clients.forEach((client, clientIndex) => {
        testStatuses[clientIndex] = TestStatus.FAILED;
        execution.errors.forEach((err) => {
          logError(client, testRunUUIDs[clientIndex], testUUIDs[clientIndex], err, testEnd);
        });
      });
    }

    clients.forEach((client, clientIndex) => {
      client.finishTest(testUUIDs[clientIndex], {
        testRunUUID: testRunUUIDs[clientIndex],
        status: testStatuses[clientIndex],
        endTime: testEnd.toString(),
      });
    });
  });

  const runEndEpochMs =
    typeof meta.completed === 'number' ? meta.completed : runStartEpochMs + currentOffsetMs;
  const runEndIso = new Date(runEndEpochMs).toISOString();
  const runEndZoned = ZonedDateTime.parse(runEndIso);

  clients.forEach((client, clientIndex) => {
    client.finishTestRun(testRunUUIDs[clientIndex], {
      endTime: runEndZoned.toString(),
    });
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
