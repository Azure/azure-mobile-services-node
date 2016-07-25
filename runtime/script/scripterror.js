// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------

var _ = require('underscore'),
    _str = require('underscore.string'),
    core = require('../core');

_.mixin(_str.exports());

exports.handleScriptError = function (error, source, logger, responseCallback, message) {
    if (error instanceof core.MobileServiceError && !error.loggedToUser && (error.code === core.ErrorCodes.ScriptError || error.code === undefined)) {
        if (!message) {
            message = _.sprintf("Error in script '%s'.", source);
        }
        message += ' ' + core.sanitizeUserCallStack(error);
        logger.logUser(source, LogType.Error, message);
        error.loggedToUser = true;
    }

    if (responseCallback !== undefined) {
        responseCallback(error);
    }
};

// for the specified JS friendly operation name (read/insert/update/del),
// convert to human preferred form (e.g. del -> delete)
function normalizeOperationName(operation) {
    return (operation == 'del') ? 'delete' : operation;
}
exports.normalizeOperationName = normalizeOperationName;

function prepareUserError(err) {
    // Prepare any caught error to be sent into the user's callback.
    if (err.constructor === core.MobileServiceError) {
        // If this is a MobileServiceError with an innerError, return the innerError.
        // The MobileServiceError ctor will already strip the stack trace.
        if (err.innerError) {
            return err.innerError;
        } else {
            return err; // Just return the whole MobileServiceError
        }
    } else { // Anything else, sanitize the stack and return the error
        if (err.stack) {
            err.stack = core.sanitizeUserCallStack(err);
        }
        return err;
    }
}
exports.prepareUserError = prepareUserError;

function getTableScriptSource(table, operation) {
    return _.sprintf('/table/%s.%s.js', table, operation);
}
exports.getTableScriptSource = getTableScriptSource;