<h1 align="center">
  <a href="https://github.com/orangebeard-io/postman-listener">
    <img src="https://raw.githubusercontent.com/orangebeard-io/postman-listener/master/.github/logo.svg" alt="Orangebeard.io postman Listener" height="200">
  </a>
  <br>Orangebeard.io postman Listener<br>
</h1>

<h4 align="center">Orangebeard listener for <a href="https://github.com/postmanlabs/newman" target="_blank" rel="noopener">Newman</a> (Postman CLI).)</h4>

<p align="center">
  <a href="https://www.npmjs.com/package/@orangebeard-io/postman-listener">
    <img src="https://img.shields.io/npm/v/@orangebeard-io/postman-listener.svg?style=flat-square"
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
	"testset": "My Test Set Name",
	"listenerMode": "DEFAULT", 
	"restClientConfig": {
		"timeout": 0
	}
}
``` 

### Running

From the command line:
```shell
newman run ./postman-collection.json -r @orangebeard-io/orangebeard
```

Or programmatically:

```shell
const newman = require("newman");

newman.run(
    {
        collection: "./postman-collection.json",
        reporters: "@orangebeard-io/orangebeard",
    },
    function(err) {
        if (err) {
            throw err;
        }
        console.log("collection run complete!");
    }
);
```

