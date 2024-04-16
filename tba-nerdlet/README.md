# Time Based Availability App
This app visualises availability for a synthetic based upon time rather than events. Once installed access the app via the sub-navigation on any Synthetic entity.

If you intend to visualise mute status then consider adding the [mute status](https://github.com/jsbnr/nr-synthetic-mute-status) code to your synhtetic script. 

## Getting started

To install to you account run the following scripts. You will need NodeJs and the [New Relic One CLI](https://developer.newrelic.com/build-apps/set-up-dev-env) installed.

```
# install dependencies
npm install

# Set GUID for your account
nr1 nerdpack:uuid -gf
```

To run locally:
```
nr1 nerdpack:serve
```

To publish to your account:
```
# Publish
nr1 nerdpack:publish

# Subscribe account to 
nr1 subscription:set
```