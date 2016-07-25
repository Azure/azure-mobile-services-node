// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module is responsible for execution of a script including exposing capabilities to scripts via globals
// and any arguments that need to be passed to user-defined functions.

var vm = require('vm'),
    core = require('../core'),
    util = require('util'),
    scriptErrors = require('./scripterror'),
    StatusCodes = require('../statuscodes').StatusCodes,
    sqlAdapter = require('./sqladapter'),
    tripwire = require('tripwire'),
    Table = require('./table'),
    ScriptLoader = require('./scriptloader'),
    path = require('path'),
    _ = require('underscore'),
    _str = require('underscore.string'),
    config = require('mobileservice-config');

_.mixin(_str.exports());

exports = module.exports = ScriptManager;

var logSource = 'ScriptManager';

// define globals we want to provide user
// scripts access to
statusCodes = StatusCodes;

function ScriptManager(configPath, storage, logger, metrics, pushAdapter) {
    this.configPath = configPath;
    this.scriptLoader = new ScriptLoader(configPath, null, logger);
    this.metrics = metrics;
    this.storage = storage;
    this.logger = logger;
    this.pushAdapter = pushAdapter;
}

ScriptManager.prototype.initialize = function (done) {
    this.scriptLoader.load(done);
};

ScriptManager.prototype.getDataModel = function () {
    return this.scriptLoader.getDataModel();
};

// Return the required permission level for the specified table operation
ScriptManager.prototype.getTablePermission = function (tableName, operation) {
    var permission = this.getRoutePermission('table', tableName, '/', operation);
    if (permission) {
        return permission;
    }

    // otherwise default to the datamodel permissions
    var dataModel = this.getDataModel(),
        table = dataModel.getTable(tableName);

    if (table && table.permissions) {
        permission = table.permissions[operation];
        if (permission) {
            return permission.toLowerCase();
        }
    }

    return null;
};

ScriptManager.prototype.getRoutePermission = function (scriptType, rootFileName, path, operation) {
    // first see if there is a permissions file in the script directory
    // if so, that takes precedence

    var metadata = this.scriptLoader.getMetadata(scriptType, rootFileName);

    if (metadata) {
        var operationMetadata = metadata.getRouteMetadata(path, operation);
        if (operationMetadata) {
            return operationMetadata.permission;
        }
    }

    return null;
};

ScriptManager.prototype.hasTableScript = function (table, operation) {
    return this.scriptLoader.getTableScript(table, scriptErrors.normalizeOperationName(operation)) !== null;
};

ScriptManager.prototype.getLogSourceName = function (table, operation) {
    var normalizedOperationName = scriptErrors.normalizeOperationName(operation);
    var source = scriptErrors.getTableScriptSource(table, normalizedOperationName);
    return source;
};

ScriptManager.prototype.runTableScript = function (table, operation, scriptArgs, logger, options) {
    var normalizedOperationName = scriptErrors.normalizeOperationName(operation);
    var script = this.scriptLoader.getTableScript(table, normalizedOperationName);
    var source = this.getLogSourceName(table, operation);
    var scriptFileName = '<' + source + '>';

    options.currentTableName = table;

    this._run(script, scriptFileName, 'table', source, operation, scriptArgs, logger, options);
};

ScriptManager.prototype.runFeedbackScript = function (interval) {
    var self = this;

    // Set the feedback script to run every interval ms
    this.feedbackInterval = setInterval(function () {
        self._runFeedbackScript();
    }, interval);

    // Run the feedback script right now on runtime startup
    self._runFeedbackScript();
};

ScriptManager.prototype._runFeedbackScript = function () {
    var feedbackScriptName = 'apnsfeedback';
    if (!this.scriptLoader.getScript('shared', feedbackScriptName)) {
        // it's not an error if there is no feedback script
        return;
    }
    this.runSharedScript(feedbackScriptName, 'processFeedback', [], this.logger, {});
};

ScriptManager.prototype.runSharedScript = function (scriptName, scriptFunction, scriptArgs, logger, options) {
    var script = this.scriptLoader.getScript('shared', scriptName);

    var source = _.sprintf('/shared/%s.js', scriptName);
    var scriptFileName = _.sprintf('<%s>', source);

    this._run(script, scriptFileName, 'shared', source, scriptFunction, scriptArgs, logger, options);
};

ScriptManager.prototype.runSchedulerScript = function (jobName, logger) {
    var script = this.scriptLoader.getScript('scheduler', jobName);

    var source = _.sprintf('/scheduler/%s.js', jobName);
    var scriptFileName = _.sprintf('<%s>', source);

    this._run(script, scriptFileName, 'scheduler', source, jobName, [], logger, {});
};

ScriptManager.prototype._run = function (script, scriptFileName, scriptDirectoryName, source, scriptFunction, scriptArgs, logger, options) {
    if (script === null || script === undefined) {
        // we should only ever be called with a valid script to run
        throw new core.MobileServiceError(_.sprintf('Expected script %s not found.'), scriptFileName);
    }

    this.metrics.event('script.execute');

    // Define the script execution sandbox. Sandbox functionality that is relatively expensive to
    // create or less often used is defined below as create on-demand property getters.
    var sandbox = {
        _args: scriptArgs,
        Buffer: Buffer,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        setInterval: setInterval,
        clearInterval: clearInterval,
        statusCodes: StatusCodes,
        process: process
    };
    sandbox.require = this._createRequire(scriptDirectoryName);

    var servicesOptions = {
        responseCallback: options.responseCallback,
        currentTableName: options.currentTableName
    };

    if (options.request && options.request._context) {
        // set the executing script on request context
        options.request._context.script = source;
    }

    this._createServicesForSandbox(sandbox, source, logger, servicesOptions);

    logger.trace(logSource, "Executing script: '" + scriptFileName);

    // Go async before executing the user script to create a new call stack; this ensures
    // we don't have to check for and re-throw tripwire exceptions.
    process.nextTick(function () {
        try {
            // first run the user script to define the operation in the context
            var context = vm.createContext(sandbox);
            vm.runInContext('"use strict";' + script, context, scriptFileName);

            // finally run the actual user function
            vm.runInContext(scriptFunction + '.apply(null, _args);', context, scriptFileName);
        }
        catch (e) {
            if (undefined !== tripwire.getContext()) {
                // the script blocked the node.js event loop for longer than the threshold configured in server.js
                throw e;
            }

            // If the caught error isn't a MobileServiceError, then wrap it
            var error = e;
            if (e.constructor !== core.MobileServiceError) {
                error = new core.MobileServiceError(e, core.ErrorCodes.ScriptError);
            }
            //all sync script errors die here
            scriptErrors.handleScriptError(error, source, logger, options.responseCallback);
        }
    });
};

// API and ExtensionManager
ScriptManager.prototype.buildScriptService = function(source, logger, options) {
    var service = {};
    this._createServicesForSandbox(service, source, logger, options);
    delete service.console;
    service.config = config;
    return service;
};

// Table, Scheduler and ApnsFeedback
ScriptManager.prototype._createServicesForSandbox = function (services, source, logger, options) {
    var self = this;

    // if no response callback has been specified, use an empty function
    // to ignore any responses. For example, cron and apnsfeedback scripts
    // don't pass a response callback.
    var responseCallback = options && options.responseCallback ? options.responseCallback : function () { };

    services.tables = {
        getTable: function (tableName) {
            if (!core.isString(tableName)) {
                throw new core.MobileServiceError("Table name cannot be null or empty.", core.ErrorCodes.ScriptError);
            }

            return new Table(self.storage, tableName, source, logger, self.metrics, responseCallback);
        }
    };

    // expose the current table name programmatically in server scripts as tables.current.
    if (options.currentTableName !== undefined) {
        core.createLazyProperty(services.tables, 'current', function () {
            return new Table(self.storage, options.currentTableName, source, logger, self.metrics, responseCallback);
        });
    }

    services.console = this._createConsoleObject(source, logger);

    services.push = this.pushAdapter.createPushForScripts(source, logger, this.metrics, responseCallback);

    // define lazy property for mssql wrapper
    core.createLazyProperty(services, 'mssql', function () {
        return sqlAdapter.create(self.storage.connection, logger, self.metrics, source, responseCallback);
    });
};

ScriptManager.prototype._createRequire = function (scriptDirectoryName) {
    var self = this;

    return function (moduleOrPath) {
        var fxUtil;
        try {
            // we need to use fxUtil.require to simulate origin of script to be inside scripts directory
            fxUtil = require(path.join(self.configPath, core.getScriptsDirName(self.configPath), scriptDirectoryName, '__fxutil'));
        }
        catch (e) {
            // this will only happen if __fxutil is deleted somehow
            return require(moduleOrPath);
        }

        var resolved = false;

        try {
            resolved = fxUtil.resolve(moduleOrPath);
        } catch (e) { }

        // first search in App_Data/config/scripts/table|shared|scheduler hierarchy
        if (resolved) {
            return fxUtil.require(moduleOrPath);
        }
        return require(moduleOrPath);
    };
};

ScriptManager.prototype._createConsoleObject = function (source, logger) {
    var self = this;

    // simplify the interface of logUser by defaulting the table, operation, etc.
    var logUser = function (logType) {
        try {
            self.metrics.event('api.console');
            var message = util.format.apply(null, Array.prototype.slice.call(arguments, 1));
            logger.logUser(source, logType, message);
        } catch (ex) {
            // If util.format throws an exception, report it as an error.
            logger.logUser(source, LogType.Error, "Error logging message: " + util.inspect(ex));
        }
    };

    return {
        log: core.curry(logUser, LogType.Information),
        info: core.curry(logUser, LogType.Information),
        warn: core.curry(logUser, LogType.Warning),
        error: core.curry(logUser, LogType.Error)
    };
};
