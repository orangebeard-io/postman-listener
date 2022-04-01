## Example PostMan Collection

### Prerequisites
 - Docker
 - Run [[VAmPi][https://github.com/erev0s/VAmPI]]
 - Install newman `npm install newman`
 - Install the listener (in the same location) `npm install @orangebeard-io/newman-reporter-orangebeard`
  
### Run and report
 - Create orangebeard.json (in this folder)

```json
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
 - Run the collection `newman run .\VAmPI.postman_collection.json -r @orangebeard-io/orangebeard`

Alternatively, provide options from the commandline:
```shell
newman run ./collection.json -r @orangebeard-io/orangebeard \
--reporter-@orangebeard-io/orangebeard-endpoint=https://my.orangebeard.app \
--reporter-@orangebeard-io/orangebeard-token=00000000-0000-0000-00000000 \
--reporter-@orangebeard-io/orangebeard-testset=testset_name \
--reporter-@orangebeard-io/orangebeard-project=project_name
```


