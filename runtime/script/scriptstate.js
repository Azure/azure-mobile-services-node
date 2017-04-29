// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// State machine for orchestrating script callback execution

var core = require('../core');

var resources = require('../resources');
var scriptErrors = require('./scripterror');
var StatusCodes = require('../statuscodes').StatusCodes;
var _ = require('underscore');
var _str = require('underscore.string');

_.mixin(_str.exports());

exports = module.exports = ScriptState;

function ScriptState(operation, scriptArg, tableMetadata, responseCallback, logger, scriptLogSource) {
    var self = this;
    this.delayResponse = false;
    this.respondCalled = false;
    this.tableMetadata = tableMetadata;
    this.scriptArg = scriptArg;
    this.operation = operation;
    this.conflictCalled = false;

    // Define an interceptor response callback which will allow us to
    // capture and save results until respond has been called
    this.responseCallback = _.wrap(responseCallback, (oldCallback, err, results, statusCode, byUser) => {
        if (self.responseComplete) {
            if (byUser) {
                var stack = new core.MobileServiceError(resources.responseAlreadySent, core.ErrorCodes.ScriptError).stack;
                logger.logUser(scriptLogSource, LogType.Warning, stack);
            }
            // The response has already completed, so do nothing. This can
            // happen in cases where the user callback called respond directly
            // with a result; in that case we need to ignore the default response.
            return;
        }

        if (!self.delayResponse) {
            self.responseComplete = true;
            oldCallback(err, results, statusCode);
        } else {
            // save the response data which also indicates
            // that there is a pending response ready
            self._saveResponseData(err, results, statusCode);
        }
    });
}

// when script calls this method, we invoke the actual data operation
ScriptState.prototype.execute = function (callbackOptions) {

    var options = {
        supportsConflict: (this.operation === 'update' || this.operation === 'del') &&
                           this.tableMetadata.supportsConflict,

        supportsIncludeDeleted: (this.operation == 'read' &&
                                 this.tableMetadata.supportsSoftDelete)
    };
    
    core.validateCallbackOptions(callbackOptions, 'execute', options);

    if (this.executeCalled) {
        throw new core.MobileServiceError('Execute cannot be called more than once.', core.ErrorCodes.ScriptError);
    }

    if (this.respondCalled) {
        throw new core.MobileServiceError('Execute cannot be called after respond has been called.', core.ErrorCodes.ScriptError);
    }

    this.executeCalled = true;

    // Define the callback that the data operation will call back
    // when it completes. We'll receive the error/result data from the
    // runtime, which we then dispatch to any callback functions
    // provided by the script.
    var self = this;
    var scriptCallback = (err, results) => {

        // Because the conflict handler can call back into context.execute()
        // we need to update the saved data (from the original conflict). Also,
        // the second (or third, forth, etc.) call into context.execute() need
        // not have callback options, and if not, we need to unblock the
        // delayed response.
        if (self.conflictCalled) {
            var statusCode = err ? err.code || StatusCodes.INTERNAL_SERVER_ERROR : StatusCodes.OK;
            self._saveResponseData(err, results, statusCode);
            self.conflictCalled = false;
            if (!callbackOptions) {
                self.delayResponse = false;
            }
        }

        if (callbackOptions) {
            var operationIsDeleteOrUpdate = self.operation === 'update' || self.operation === 'del';
            if (!err) {
                var args = [results];
                if (self.operation == 'insert' || operationIsDeleteOrUpdate) {
                    // callbacks for these operations don't take arguments
                    args = [];
                }

                self._executeCallbackOption(callbackOptions.success, args);
            }
            else {
                if (operationIsDeleteOrUpdate && err.isMergeConflict && callbackOptions.conflict) {
                    // allow execute to be called again
                    self.executeCalled = false;

                    // update the original item version with the version from the server's item
                    self.scriptArg.__version = err.item.__version;

                    self.conflictCalled = true;
                    self._executeCallbackOption(callbackOptions.conflict, [err.item]);
                }
                else {
                    self._executeCallbackOption(callbackOptions.error, [scriptErrors.prepareUserError(err)]);
                }
            }
        }
    };
    // invoke the actual data operation
    var systemParameters = callbackOptions ? _.pick(callbackOptions, 'systemProperties', 'includeDeleted') : null;
    this.executeCallback(scriptCallback, systemParameters);
};

// execute a user script success/error callback, with proper error handling
// and state management.
ScriptState.prototype._executeCallbackOption = function (callback, args) {

    // delayResponse could have been set by a previous execution of a conflict
    // handler, so delayResponse should be cleared in case this callback does
    // not exist
    this.delayResponse = false;

    if (!callback) {
        return;
    }

    // If we call into a script success/error callback, we mark the response
    // as delayed, only completing when respond() is called.
    this.delayResponse = true;

    try {
        callback(...args);
    }
    catch (err) {
        // If an exception occurred in the handler, we need to unblock the response,
        // since the user's code will never be able to call respond.
        this.delayResponse = false;
        
        throw err;
    }
};

// when a script calls this method, we complete any outstanding response,
// returning either the captured default operation results, or using the
// specified status code and body.
ScriptState.prototype.respond = function (statusCodeOrError, body) {
    ScriptState.validateRespondParameters.apply(null, arguments);

    if (this.respondCalled) {
        throw new core.MobileServiceError('Respond cannot be called more than once.', core.ErrorCodes.ScriptError);
    }
    this.respondCalled = true;

    this.delayResponse = false;
    var byUser = true;

    if (statusCodeOrError) {
        if (core.isError(statusCodeOrError)) {
            // if the first parameter is an error, set the body,
            // and use the error's status code if present
            body = statusCodeOrError;
            statusCodeOrError = body.statusCode || StatusCodes.INTERNAL_SERVER_ERROR;
        }
        this.responseCallback(null, body, statusCodeOrError, byUser);
    }
    else {
        // If to here, we're completing the request with the default response.
        if (!this.executeCalled && !this.conflictCalled) {            
            throw new core.MobileServiceError('Execute must be called before respond.', core.ErrorCodes.ScriptError);
        }

        if (this.responseData) {
            // there was a pending response ready that we can release now
            this.responseCallback(this.responseData.err, this.responseData.results, this.responseData.statusCode, byUser);
        }
    }
};

ScriptState.validateRespondParameters = function (statusOrError, body) {
    // The first parameter cannot be null if multiple parameters are specified
    if (!statusOrError && arguments.length !== 0) {
        throw new core.MobileServiceError('Invalid parameters passed to respond. The first parameter must be a valid status code.', core.ErrorCodes.ScriptError);
    } 

    // If the first parameter is not a number or an error, it is invalid
    if (statusOrError && !core.isNumber(statusOrError) && !core.isError(statusOrError)) {
        throw new core.MobileServiceError('Invalid parameters passed to respond. The first parameter must be a valid status code.', core.ErrorCodes.ScriptError);
    }
};

ScriptState.prototype._saveResponseData = function (error, results, statusCode) {
    this.responseData = {
        err: error,
        results,
        statusCode: statusCode || null
    };
};
