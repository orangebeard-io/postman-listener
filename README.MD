<h1 align="center">
  <a href="https://github.com/orangebeard-io/postman-listener">
    <img src="https://raw.githubusercontent.com/orangebeard-io/postman-listener/master/.github/logo.svg" alt="Orangebeard.io postman Listener" height="200">
  </a>
  <br>Orangebeard.io postman Listener<br>
</h1>

<h4 align="center">Orangebeard listener for <a href="https://github.com/postmanlabs/newman" target="_blank" rel="noopener">Newman</a> (Postman CLI).)</h4>

<p align="center">
  <a href="https://www.npmjs.com/package/@orangebeard-io/newman-reporter-orangebeard">
    <img src="https://img.shields.io/npm/v/@orangebeard-io/newman-reporter-orangebeard.svg?style=flat-square"
      alt="NPM Version" />
  </a>
  <a href="https://github.com/orangebeard-io/postman-listener/actions">
    <img src="https://img.shields.io/github/workflow/status/orangebeard-io/postman-listener/release?style=flat-square"
      alt="Build Status" />
  </a>
  <a href="https://github.com/orangebeard-io/postman-listener/blob/master/LICENSE">
    <img src="https://img.shields.io/github/license/orangebeard-io/postman-listener?style=flat-square"
      alt="License" />
  </a>
</p>

<div align="center">
  <h4>
    <a href="https://orangebeard.io">Orangebeard</a> |
    <a href="#installation">Installation</a> |
    <a href="#configuration">Configuration</a>
  </h4>
</div>

## Installation

### Install the npm package

```shell
npm install @orangebeard-io/newman-reporter-orangebeard
```

## Configuration

Create orangebeard.json (in your collection's folder (or above))

```JSON
{
	"endpoint": "https://XXX.orangebeard.app",
	"accessToken": "00000000-0000-0000-0000-00000000",
	"project": "my_project_name",
	"testset": "My Test Set Name"
}
```

### Running

From the command line:

```shell
newman run ./postman-collection.json -r @orangebeard-io/orangebeard
```

Or configure using the CLI (without orangebeard.json):

```shell
newman run ./collection.json -r @orangebeard-io/orangebeard \
--reporter-@orangebeard-io/orangebeard-endpoint=https://my.orangebeard.app \
--reporter-@orangebeard-io/orangebeard-token=00000000-0000-0000-00000000 \
--reporter-@orangebeard-io/orangebeard-testset=testset_name \
--reporter-@orangebeard-io/orangebeard-project=project_name \
--reporter-@orangebeard-io/orangebeard-description=description \
--reporter-@orangebeard-io/orangebeard-attributes=key:value;secondkey:secondvalue;singleTag
```
Note: Description and attributes are optional.

Or programmatically:

```js
const newman = require('newman');

newman.run(
  {
    collection: './collection.json',
    reporters: '@orangebeard-io/orangebeard',
    reporter: {
      '@orangebeard-io/orangebeard': {
        endpoint: 'https://my.orangebeard.app',
        token: '00000000-0000-0000-0000-000000000000',
        testset: 'testset_name',
        project: 'project_name',
        description: 'description',
        attributes: [
          {
            key: 'key',
            value: 'val',
          },
          {
            value: 'singleTag',
          },
        ],
      },
    },
  },
  function (err) {
    if (err) {
      throw err;
    }
    console.log('collection run complete!');
  },
);
```

### Using Postman CLI JSON reports

If you use the Postman CLI with its JSON reporter, you can import those JSON reports into Orangebeard using the CLI utility that ships with this package.

#### 1. Generate a JSON report with Postman CLI

From your API project, run the Postman CLI with JSON output enabled (example):

```shell
postman collection run ./VAmPI.postman_collection.json \
  --reporters json \
  --reporter-json-export ./postman-cli-reports/VAmPI-report.json
```

This produces a JSON file containing a `run` object with `executions`, similar to the examples under `example_pm_collection/postman-cli-reports/` in this repository.

#### 2. Report the JSON run to Orangebeard

From this package's directory (with your Orangebeard configuration already set up, e.g. via `orangebeard.json` or environment):

```shell
npm run report:postman-cli-json -- ./example_pm_collection/postman-cli-reports/VAmPI-report.json
```

Or, if the package is installed globally or as a project dependency:

```shell
postman-cli-to-orangebeard ./example_pm_collection/postman-cli-reports/VAmPI-report.json
```

The utility also works with the following arguments:
```shell
postman-cli-to-orangebeard ./example_pm_collection/postman-cli-reports/VAmPI-report.json \
--endpoint=https://my.orangebeard.app \
--token=00000000-0000-0000-00000000 \
--testset=testset_name \
--project=project_name \
--description=description \
--attributes=key:value;secondkey:secondvalue;singleTag \
--attachments-path=path_to_attachments
```

The utility will:

- Create an Orangebeard test run in either Postman or Newman style, which is automatically detected by the reporter.
- Create one Orangebeard test per request in the JSON report and in case of Newman it will also copy the folder structure.
- Log request and response metadata in Markdown, including headers and JSON/XML bodies in fenced code blocks.
- Map Postman tests/assertions to Orangebeard steps, attaching error messages and stack traces when they fail.
- Use the timing information from the report to reconstruct start/end timestamps per test and for the entire run.
- * Adding attachments requires the files to be in the following format: {pm.info.requestId}_{pm.test.name}.anyextension