// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This middleware sits at the end of the pipeline to catch errors and create a suitable response
// If the previous middleware gracefully sent the response then errorHandler won't be called.

var core = require('../../core');

var StatusCodes = require('../../statuscodes').StatusCodes;
var scriptErrors = require('../../script/scripterror');
var _ = require('underscore');
var _str = require('underscore.string');

_.mixin(_str.exports());

exports.ErrorHandler = ErrorHandler;

function ErrorHandler(logSource) {
    this._logSource = logSource;
}

ErrorHandler.prototype.handle = function (err, req, res, next) {
    var context = req._context;
    var logger = context.logger;
    var writeResponse = context.responseCallback;
    var parsedRequest = context.parsedRequest;

    try {
        var statusCode = StatusCodes.INTERNAL_SERVER_ERROR;
        if (err.timeout && err.status == 503) {
            // if this is a timeout error, just log the error to user log
            statusCode = err.status;
            var msg = _.sprintf("The request '%s %s' has timed out. This could be caused by a script that fails to write to the response, or otherwise fails to return from an asynchronous call in a timely manner.", parsedRequest.verb, parsedRequest.url);
            err = new core.MobileServiceError('The request has timed out.');
            this._writeUserLog(parsedRequest, LogType.Error, msg, logger);
        }
        else if (err.status === 400) {
            statusCode = err.status;
        }
        else {
            if (core.isRuntimeError(err)) {
                logger.error(this._logSource, err);
                this._writeUserLog(parsedRequest, LogType.Error, _.sprintf('A system error has occurred. Request: %s, Id: %s', parsedRequest.url, logger.requestID), logger);
            } else {
                this._writeUserLog(parsedRequest, LogType.Error, err.toString(), logger);
            }
        }

        writeResponse(err, null, statusCode);
    }
    catch (e) {
        // ensure that even if we have an error above in our own error handling code, we produce a proper error
        logger.error(this._logSource, e);
        err = new core.MobileServiceError('Internal Server Error');
        writeResponse(err, null, StatusCodes.INTERNAL_SERVER_ERROR);
    }
};

ErrorHandler.prototype._writeUserLog = function (request, logType, message, logger) {
    // Determine if this error is for a request that we don't
    // want to log to user log
    var skipUserLog = false;
    if (request && request.url && request.url.indexOf('/diagnostics') === 0) {
        skipUserLog = true;
    }

    if (!skipUserLog) {
        if (request && request.operation == 'tables' && request.table) {
            var source = scriptErrors.getTableScriptSource(request.table, core.verbToOperation(request.verb));
            logger.logUser(source, logType, message);
        } else {
            // for other operation types we have no source, so these fields are empty 
            logger.logUser('', logType, message);
        }
    }

    // also trace the error as information to the system trace
    logger.trace(this._logSource, 'An unhandled error occurred.', message);
};

function middleware(logSource) {
    var handler = new ErrorHandler(logSource);
    return handler.handle.bind(handler);
}

// expose ErrorHandler for testing
middleware.ErrorHandler = ErrorHandler;

exports = module.exports = middleware;
