// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// Provides functionality for loading the New Relic module if found, and setting the appropriate configuration defaults

var path = require('path');

var resource = require('./resources');
var core = require('./core');
var _ = require('underscore');
var source = 'NewRelicAdapter';

exports = module.exports = NewRelicAdapter;

function NewRelicAdapter() {
    this.loaded = false;    
    this.userLogs = [];
    this.systemTraceLogs = [];
    this.newRelic = null;
}

NewRelicAdapter.prototype.initialize = function (configPath, environment, moduleLoader, fs) {
    core.ensureParamNotNull(configPath, 'configPath');

    this.configPath = configPath;
    environment = environment || process.env;
    moduleLoader = moduleLoader || require;
    fs = fs || require('fs');    

    // Skip initialization if there is no license key specified
    if (environment.NEW_RELIC_LICENSE_KEY) {
        var userdirectory = path.join(this.configPath, core.getScriptsDirName(configPath));
        var configFilePath = path.join(environment.NEW_RELIC_HOME || userdirectory, 'newrelic.js');
        var useConfigFile = fs.existsSync(configFilePath);

        // Allow the user to drop a 'newrelic.js' file into their service folder to configure the agent.
        // If no such file is found, provide default settings
        if (useConfigFile) {
            environment.NEW_RELIC_HOME = environment.NEW_RELIC_HOME || userdirectory;
        } else {
            environment.NEW_RELIC_NO_CONFIG_FILE = "1";
            environment.NEW_RELIC_APP_NAME = environment.NEW_RELIC_APP_NAME || environment.MS_MobileServiceName;
            environment.NEW_RELIC_LOG_LEVEL = environment.NEW_RELIC_LOG_LEVEL || 'info';
            environment.NEW_RELIC_LOG = environment.NEW_RELIC_LOG || path.join(environment.TEMP, "newrelic_agent.log");
        }

        var newRelicPath = path.join(userdirectory, 'node_modules', 'newrelic');

        try {
            this.newRelic = moduleLoader(newRelicPath);            
            this.loaded = true;
            var traceDetails = useConfigFile ? "Config file found at: " + configFilePath
                : "No config file found at: " + configFilePath + " - using default New Relic settings";
            this.systemTraceLogs.push({ source, summary: 'New Relic agent loaded successfully', details: traceDetails });
        }
        catch (ex) {
            this.systemTraceLogs.push({ source, summary: 'Failed to load New Relic module', details: ex.toString() });
            this.userLogs.push({ source: '', type: 'error', message: resource.newRelicError });
        }
    }
};

NewRelicAdapter.prototype.complete = function (logger, metrics) {
    core.ensureParamNotNull(logger, 'logger');
    core.ensureParamNotNull(metrics, 'metrics');

    this.userLogs.forEach(log => {
        logger.logUser(log.source, log.type, log.message);
    });

    this.systemTraceLogs.forEach(log => {
        logger.trace(log.source, log.summary, log.details);
    });

    if (this.loaded) {
        metrics.event('module.newrelic');
    }
};

NewRelicAdapter.prototype.nameTransaction = function (traceData) {
    core.ensureParamNotNull(traceData, 'traceData');

    if (this.loaded) {
        // If the traceData has target, then its a table script or job and the transaction needs to be named.
        if (traceData.target) {
            var transactionName = _.sprintf('%s /%s/%s', traceData.verb.toLowerCase(), traceData.operation, traceData.target);
            this.newRelic.setTransactionName(transactionName);
        }
    }
};
