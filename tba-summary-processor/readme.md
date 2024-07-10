# Time based availability - Metric processor
This script calculates daily time based availability and records as metrics in New Relic. It can also generate rolling weekly and monthly summarise of the TBA data. It is intended to run daily, from a VM or Lambda, to process the data.

Daily metrics are recorded in the event `syntheticTBABot`.
Weekly/Monthly Summaryy data is recorded in `syntheticTBABot`.

## Configuration
There are a number of configurable options at the top of the script. Set as necessary.

## Running
Run with:

`node main.js`

## Running as a synthetic
You can run this script in a New Relic synthetic. Setup the necessary  API keys as secure credentials.