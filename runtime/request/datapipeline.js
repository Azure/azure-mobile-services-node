// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module is responsible for execution of data operations including invoking user script
// if defined for the operation. Script services are exposed to scripts via the context argument
// passed to the script function. A separate dataPipeline instance is created per request.

var core = require('../core'),
    DataOperation = require('./dataoperation'),
    scriptErrors = require('../script/scripterror'),
    ScriptState = require('../script/scriptstate'),
    ScriptManager = require('../script/scriptmanager'),
    resource = require('../resources'),
    Query = require('../Zumo.Node').Query,
    _ = require('underscore'),
    _str = require('underscore.string');

 _.mixin(_str.exports());

require('../storage/sqlhelpers');

exports = module.exports = DataPipeline;

var logSource = 'Pipeline';

function DataPipeline(storage, scriptManager, request, user, logger, metrics) {
    this.storage = storage;
    this.scriptManager = scriptManager;
    this.table = request.table;
    this.request = request;
    this.systemParameters = {
        systemProperties: request.query && request.query.systemProperties || [],
        undelete: false,
        includeDeleted: request.query && request.query.includeDeleted
    };
    this.requestParameters = request.query && request.query.parameters || {};
    this.user = user;
    this.logger = logger;
    this.metrics = metrics;
    this.noScript = request.noScript;
}

DataPipeline.prototype.insert = function (item, responseCallback) {
    this._executePipelineOperation('insert', item, responseCallback);
};

DataPipeline.prototype.read = function (query, responseCallback) {
    var self = this;

    // if this is a query by id, we wrap the response callback
    // so we can do result validation to make sure only a singleton is returned
    if (query.id) {
        responseCallback = _.wrap(responseCallback, function (originalCallback, err, results, statusCode) {
            if (results && core.isArray(results)) {
                if (results.length === 1) {
                    results = results[0];
                } else if (results.length > 1) {
                    err = new core.MobileServiceError("Cannot return more than one item for a query by id.", core.ErrorCodes.ScriptError);

                    var source = scriptErrors.getTableScriptSource(self.table, 'read');
                    scriptErrors.handleScriptError(err, source, self.logger, originalCallback);
                    return;
                }
            }
            originalCallback(err, results, statusCode);
        });
    }

    if (!core.isNumber(query.top)) {
        // Set default limit of 50 if no top is specified. Note that we're only
        // imposing this limit on queries originating externally, not on server side
        // initiated queries.
        query.top = 50;
    }

    if (this.scriptManager.hasTableScript(this.table, 'read') && !this.noScript) {
        // if we're going to execute user script, transform the query
        // into a query builder
        query = this.getQueryBuilder(query);
    }

    this._executePipelineOperation('read', query, responseCallback);
};

DataPipeline.prototype.update = function (item, responseCallback) {
    var self = this;
    var originalId = item.id;

    // define a pre-execute callback to do validation of the operation
    // prior to actually executing the data opration
    var executeCallback = function (scriptArg) {
        if (scriptArg.id !== originalId) {
            var error = new core.MobileServiceError("Update scripts cannot modify the id of the item to be updated.", core.ErrorCodes.ScriptError);

            var source = scriptErrors.getTableScriptSource(self.table, 'update');
            scriptErrors.handleScriptError(error, source, self.logger, responseCallback);
            return false;
        }
        return true;
    };

    this._executePipelineOperation('update', item, responseCallback, executeCallback);
};

DataPipeline.prototype.del = function (itemOrId, responseCallback) {
    this._executePipelineOperation('del', itemOrId, responseCallback);
};

DataPipeline.prototype._executePipelineOperation = function (operationName, scriptArg, responseCallback, executeCallback) {
    if (!this.scriptManager.hasTableScript(this.table, operationName) || this.noScript) {
        responseCallback = this._wrapWithNoScriptErrorTransforms(responseCallback);        
        responseCallback = this._wrapWithUserLogging(responseCallback, operationName);
        // if there is no script to execute, perform the operation directly
        var dataOperation = this._createDataOperation(operationName);
        var options = this.systemParameters;
        dataOperation[operationName](this.table, scriptArg, options, responseCallback, null);
    }
    else {
        responseCallback = this._wrapWithUserLogging(responseCallback, operationName);
        this._executeScript(operationName, scriptArg, responseCallback, executeCallback);
    }
};

DataPipeline.prototype._executeScript = function (operationName, scriptArg, responseCallback, executeCallback) {
    var self = this;

    this.operationContext = {
        operation: operationName,
        parameters: this.requestParameters,
        systemProperties: this.systemParameters.systemProperties,
        includeDeleted: this.systemParameters.includeDeleted,
        undelete: this.systemParameters.undelete
    };

    this.storage.getTableMetadata(this.table, this.logger, function (error, tableMetadata) {
        if (error) {
            responseCallback(error);
            return;
        }
        var logSourceName = self.scriptManager.getLogSourceName(this.table, operationName);
        // Create a small state machine which will manage script execution.
        var scriptState = new ScriptState(operationName, scriptArg, tableMetadata, responseCallback, self.logger, logSourceName);
        scriptState.executeCallback = function (scriptCallback, systemParameters) {
            // If the callback doesn't exist or returns true, run the data operation
            if (!executeCallback || executeCallback(scriptArg)) {
                var dataOperation = self._createDataOperation(operationName);
                var options = _.isEmpty(systemParameters) ? self.systemParameters : systemParameters;
                dataOperation[operationName](self.table, scriptArg, options, scriptState.responseCallback, scriptCallback);
            }
        };

        self.operationContext.execute = function (callbackOptions) {
            self.logger.trace(logSource, 'Script called execute');
            scriptState.execute(callbackOptions);
        };

        self.operationContext.respond = function (statusCode, result) {
            self.logger.trace(logSource, 'Script called respond');
            scriptState.respond.apply(scriptState, arguments);
        };

        var runnerOptions = {
            responseCallback: scriptState.responseCallback,
            request: self.request
        };

        var runnerScriptArg = scriptArg;
        // delete script should only see the item id rather than the object with id and version
        if (operationName === 'del' && core.isObject(runnerScriptArg)) {
            runnerScriptArg = runnerScriptArg.id;
        }

        var runnerArgs = [runnerScriptArg, self.user, self.operationContext];

        self.scriptManager.runTableScript(self.table, operationName, runnerArgs, self.logger, runnerOptions);
    });
};

DataPipeline.prototype._createDataOperation = function (operationName) {
    var source = scriptErrors.getTableScriptSource(this.table, scriptErrors.normalizeOperationName(operationName));
    return new DataOperation(this.storage, source, this.logger);
};

DataPipeline.prototype.getQueryBuilder = function (query) {
    // Convert a query object we were passed via a request into a QueryJS query
    // building object so users can easily manipulate incoming queries
    var queryBuilder = query;
    if (query && query.constructor !== Query) {
        queryBuilder = Query.Providers.OData.fromOData(
           query.table || this.table,
           query.filter,
           query.orderBy,
           query.skip,
           query.top,
           query.select,
           query.inlineCount === 'allpages');
        queryBuilder.id = query.id;
    }

    if (query._parsed) {
        // if we have already parsed the query, save the parsed query
        // so it flows through the pipeline for use later
        queryBuilder._parsed = query._parsed;

        // save the version so we can detect later if the query
        // was modified
        queryBuilder._parsed.version = queryBuilder.getComponents().version;
    }

    return queryBuilder;
};

DataPipeline.prototype._wrapWithNoScriptErrorTransforms = function (responseCallback) {
    return _.wrap(responseCallback, function (oldCallback, err, result, statusCode) {
        // There is no script. Any non application level sql error will be treated
        // as an end user input error.
        if (SqlHelpers.isSqlError(err) && !SqlHelpers.isApplicationError(err)) {
            oldCallback(new core.MobileServiceError(resource.badRequest, core.ErrorCodes.BadInput));
        } else {
            oldCallback(err, result, statusCode);
        }
    });
};

DataPipeline.prototype._wrapWithUserLogging = function (responseCallback, operationName) {
    var self = this;

    return _.wrap(responseCallback, function (oldCallback, err, result, statusCode) {
        // This callback pass-through will log any unhandled/unlogged SQL error messages
        // that are about to be passed up stack and returned to the user.
        // This block of code will log all unhandled SQL errors regardless of
        // if they are due to client or server errors.
        if (err && !err.loggedToUser && SqlHelpers.isSqlError(err)) {
            var source = scriptErrors.getTableScriptSource(self.table, scriptErrors.normalizeOperationName(operationName));
            self.logger.logUser(source, LogType.Error, err.toString());
        }

        oldCallback(err, result, statusCode);
    });
};
