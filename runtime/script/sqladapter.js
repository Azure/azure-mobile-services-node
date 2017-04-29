// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// Adapts the sqlserver module for direct use from ZUMO scripts

var core = require('../core');

var sqlserver = require('sqlserver');
var scriptErrors = require('./scripterror');
var util = require('util');

module.exports.create = (connectionString, logger, metrics, source, responseCallback) => {
    var adapter = new SqlAdapter(connectionString, logger, metrics, source, responseCallback);
    return adapter.createMSSQLModule();
};

var logSource = 'SqlAdapter';

function SqlAdapter(connectionString, logger, metrics, source, responseCallback) {
    this.connectionString = connectionString;
    this.logger = logger;
    this.source = source;
    this.responseCallback = responseCallback;
    this.metrics = metrics;
}

SqlAdapter.prototype.createMSSQLModule = function () {
    var self = this;

    self.logger.trace(logSource, 'Creating MSSQL Module', self.getTraceDetails());
    return {
        open(callbackOptions) {
            var traceDetails = self.getTraceDetails("open");
            var args = self.prepareArgs('open', null, callbackOptions, traceDetails, "Unable to open connection: ");
            self.executeSqlServerFunction(traceDetails, () => sqlserver.open(self.connectionString, args.callback));
        },
        query(query, paramsOrCallback, callbackOptions) {
            var traceDetails = self.getTraceDetails("query", query);
            var args = self.prepareArgs('query', paramsOrCallback, callbackOptions, traceDetails, "Error occurred executing query: ");

            self.executeSqlServerFunction(traceDetails, () => sqlserver.query(self.connectionString, query, args.params, args.callback));
        },
        queryRaw(query, paramsOrCallback, callbackOptions) {
            var traceDetails = self.getTraceDetails("queryRaw", query);
            var args = self.prepareArgs('queryRaw', paramsOrCallback, callbackOptions, traceDetails, "Error occurred executing query: ");

            self.executeSqlServerFunction(traceDetails, () => sqlserver.queryRaw(self.connectionString, query, args.params, args.callback));
        }
    };
};

SqlAdapter.prototype.prepareArgs = function (method, paramsOrCallbackOptions, callbackOptions, traceDetails, errormsg) {
    var params;
    if (!callbackOptions) {
        if (core.isObject(paramsOrCallbackOptions)) {
            // We have only one argument but it is an object indicating callback parameters
            callbackOptions = paramsOrCallbackOptions;
            params = [];
        } else if (core.isFunction(paramsOrCallbackOptions)) {
            // We have only one argument but it is a function. The user probably misread the documentation
            // and is trying to pass a callback as a single function. We will set it as the callback so that it gets
            // validated as a callback and a better error message is given than a SQL error saying "bad parameters"
            callbackOptions = paramsOrCallbackOptions;
            params = [];
        }
    }

    // If nothing above is hit, it means that we either have:
    //  - Both params and callbackOptions
    //  - A single argument that is most likely a parameter
    if (!params) {
        params = paramsOrCallbackOptions;
    }

    // Validate callback
    try {
        core.validateCallbackOptions(callbackOptions, method);
    }
    catch (exception) {
        this.logger.trace(logSource, 'Call into MSSQL Module failed - Invalid callbackOptions', traceDetails);
        throw exception;
    }

    // normalize the parameters by arrayifying single values
    if (params && !core.isArray(params)) {
        params = [params];
    }

    return { params, callback: this.constructCallback(callbackOptions, traceDetails, errormsg) };
};

SqlAdapter.prototype.executeSqlServerFunction = function (traceDetails, sqlServerFunction) {
    this.metrics.event('api.mssql.' + traceDetails.sqlFunction);
    this.logger.trace(logSource, 'Calling into MSSQL Module', traceDetails);
    try {
        return sqlServerFunction();
    }
    catch (exception) {
        this.logger.trace(logSource, 'Call into MSSQL Module failed - Exception thrown', traceDetails);
        throw exception;
    }
};

SqlAdapter.prototype.constructCallback = function (callbackOptions, traceDetails, errormsg) {
    var self = this;

    return function (err) {
        if (err) {
            // wrap the sql error in our own type
            err = new core.MobileServiceError(err, core.ErrorCodes.ScriptError);

            traceDetails.error = err.toString();
            if (callbackOptions && callbackOptions.error) {
                self.logger.trace(logSource, 'Call into MSSQL Module failed - Calling user error callback', traceDetails);
                self.executeUserCallback(traceDetails, () => {
                    callbackOptions.error(scriptErrors.prepareUserError(err));
                });
            } else {
                self.logger.trace(logSource, 'Call into MSSQL Module failed - Calling default error callback', traceDetails);
                scriptErrors.handleScriptError(err, self.source, self.logger, self.responseCallback, errormsg);
            }
        } else {
            self.logger.trace(logSource, 'Call into MSSQL Module was successful', traceDetails);
            if (callbackOptions && callbackOptions.success) {
                // Skip the error argument, pass the rest.
                var args = Array.prototype.slice.call(arguments).slice(1);

                self.executeUserCallback(traceDetails, () => {
                    callbackOptions.success.apply(null, args);
                });
            }
        }
    };
};

SqlAdapter.prototype.executeUserCallback = function (traceDetails, callback) {
    try {
        this.logger.trace(logSource, 'Executing user callback', traceDetails);
        callback();
        this.logger.trace(logSource, 'Execution of user callback was successful', traceDetails);
    }
    catch (exception) {
        this.logger.trace(logSource, 'Execution of user callback threw an exception', traceDetails);
        scriptErrors.handleScriptError(new core.MobileServiceError(exception, core.ErrorCodes.ScriptError), this.source, this.logger, this.responseCallback);
    }
};

SqlAdapter.prototype.getTraceDetails = function (sqlFunction, query) {
    // need to be sure not to log any sensitive information here,
    // for example connection string, etc.
    var traceDetails = {
        source: this.source,
        sqlFunction
    };

    if (query) {
        traceDetails.query = query;
    }

    return traceDetails;
};
