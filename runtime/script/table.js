// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module provides access to CRUD storage operations from within
// user's server side scripts. A table object is returned when a user
// runs tables.getTable passing in the name of a table.

var DataOperation = require('../request/dataoperation'),
    core = require('../core'),
    scriptErrors = require('./scripterror'),
    Query = require('../Zumo.Node').Query,
    _ = require('underscore'),
    _str = require('underscore.string');

 _.mixin(_str.exports());

exports = module.exports = Table;

function Table(storage, table, source, logger, metrics, responseCallback) {

    var validateItemForTableOperation = function (item, operation, mustHaveId) {
        if (!core.isObject(item)) {
            throw new core.MobileServiceError(_.sprintf("Operation '%s' on table '%s' failed. The parameter 'item' must be an object.", scriptErrors.normalizeOperationName(operation), table), core.ErrorCodes.ScriptError);
        }
        if (mustHaveId && item.id === undefined) {
            throw new core.MobileServiceError(_.sprintf("Operation '%s' on table '%s' failed. The parameter 'item' must be an object with an 'id' property.", scriptErrors.normalizeOperationName(operation), table), core.ErrorCodes.ScriptError);
        }
    };

    var handleError = function (error, callback, callbackOptions) {
        if (error.loggedToUser) {
            callback(error);
        } else if (!callbackOptions || !callbackOptions.error) {

            // All errors that pass through this code path must come from user script errors
            error.code = core.ErrorCodes.ScriptError;

            // If we are here is means that there was an error with a table operation and
            // the user did not specify an error handler. We need to log the error and return the error.
            scriptErrors.handleScriptError(error, source, logger, callback);
        }
    };

    this.getTableName = function () {
        return table;
    };

    this.read = function (queryOrCallbackOptions, callbackOptions) {
        var query = null;
        
        if (queryOrCallbackOptions && queryOrCallbackOptions.constructor == Query) {
            var queryTableName = queryOrCallbackOptions.getComponents().table;
            if (queryOrCallbackOptions !== null && queryTableName !== table) {
                throw new core.MobileServiceError(_.sprintf("Cannot get the results of a query for table '%s' via table '%s'.", queryTableName, table), core.ErrorCodes.ScriptError);
            } else {
                query = queryOrCallbackOptions;
            }
        } else {
            query = new Query(table);
            callbackOptions = queryOrCallbackOptions;
        }

        _executeTableOperation('read', table, query, callbackOptions);
    };

    this.insert = function (item, callbackOptions) {
        validateItemForTableOperation(item, 'insert', false);
        _executeTableOperation('insert', table, item, callbackOptions);
    };
    this.update = function (item, callbackOptions) {
        validateItemForTableOperation(item, 'update', true);
        _executeTableOperation('update', table, item, callbackOptions);
    };
    this.del = function (itemOrId, callbackOptions) {
        if (core.isObject(itemOrId)) {
            validateItemForTableOperation(itemOrId, 'del', true);
        }
        _executeTableOperation('del', table, itemOrId, callbackOptions);
    };

    this.lookup = function (id, callbackOptions) {
        if (!id) {
            throw new core.MobileServiceError(_.sprintf("Operation 'lookup' on table '%s' failed. The id argument is invalid.", table), core.ErrorCodes.ScriptError);
        }
        
        var query = { id: id };
        var newCallbackOptions = _.clone(callbackOptions);

        if (callbackOptions && callbackOptions.success) {
            newCallbackOptions.success = function (results) {
                callbackOptions.success(results[0]);
            };
        }

        _executeTableOperation('read', table, query, newCallbackOptions);
    };

    function _executeTableOperation(operationName, table, operationArg, callbackOptions) {
        metrics.event('api.table.' + operationName);

        // The operationArg cannot be undefined or null for any operation
        if (operationArg === undefined || operationArg === null) {
            throw new core.MobileServiceError(_.sprintf("Operation '%s' on table '%s' failed. Arguments to table operations cannot be null or undefined.", scriptErrors.normalizeOperationName(operationName), table), core.ErrorCodes.ScriptError);
        }

        storage.getTableMetadata(table, logger, function (error, tableMetadata) {

            if (error) {
                handleError(error, responseCallback, callbackOptions);
                return;
            }
            
            var systemProperties = [],
                validateOptions = {
                    supportsConflict: (operationName === 'update' || operationName === 'del') &&                                    
                                      tableMetadata.supportsConflict,

                    supportsIncludeDeleted: (operationName == 'read' &&
                                            tableMetadata.supportsSoftDelete)
                };

            try {
                // callback options aren't required for a table operation, but if specified, must
                // be valid
                core.validateCallbackOptions(callbackOptions, operationName, validateOptions);
                
                if (callbackOptions) {
                    systemProperties = core.validateAndNormalizeSystemProperties(callbackOptions.systemProperties);
                }
            }
            catch (err) {
                handleError(err, responseCallback, callbackOptions);
                return;
            }

            var includeDeleted = callbackOptions && callbackOptions.includeDeleted;
            
            // Define the callback that the data operation will call back
            // when it completes. We'll receive the error/result data from the
            // runtime, which we then dispatch to any callback functions
            // provided by the script.
            var scriptCallback = function (error, results) {
                if (callbackOptions) {
                    if (!error) {
                        if (callbackOptions.success) {
                            callbackOptions.success(results);
                        }
                    }
                    else {
                        if (error.isMergeConflict && callbackOptions.conflict) {
                            operationArg.__version = error.item.__version;
                            callbackOptions.conflict(error.item);
                        }
                        else if (callbackOptions.error) {
                            callbackOptions.error(scriptErrors.prepareUserError(error));
                        }
                    }
                }
            };

            // Take over the existing response callback to facilitate with error handling
            responseCallback = _.wrap(responseCallback, function (oldCallback, error) {
                // If there is not an error or there is an error and callbackOptions.error exists, don't do anything because it has already been handled by the user.
                if (error) {
                    handleError(error, oldCallback, callbackOptions);
                }
            });

            var dataOperation = new DataOperation(storage, source, logger);
            var options = { systemProperties: systemProperties, includeDeleted: includeDeleted };
            dataOperation[operationName](table, operationArg, options, responseCallback, scriptCallback);
        });
    }
}

// Copy select Query operators to Table so queries can be created
// compactly.  We'll just add them to the Table prototype and then
// forward on directly to a new Query instance.
var queryOperators = ['where', 'select', 'orderBy', 'orderByDescending', 'skip', 'take', 'includeTotalCount'];

var copyOperator = function (operator) {
    Table.prototype[operator] = function () {
        var self = this;

        // Creates a new query.
        var query = new Query(self.getTableName());

        query.read = function (callbackOptions) {
            self.read(query, callbackOptions);
        };

        return query[operator].apply(query, arguments);
    };
};
var i = 0;
for (; i < queryOperators.length; i++) {
    // Avoid unintended closure capture
    copyOperator(queryOperators[i]);
}
