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
