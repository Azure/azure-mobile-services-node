// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module has helper functions for transforming exceptions to http errors

var core = require('../core.js'),
    StatusCodes = require('../statuscodes').StatusCodes;

ErrorHelper = {};

ErrorHelper.formatError = function (err, statusCode, requestID) {
    if (err) {
        var formattedErr;
        
        if (statusCode === StatusCodes.INTERNAL_SERVER_ERROR) {
            // all internal server errors should result in a generic
            // error that doesn't reveal any internals to the client
            formattedErr = ErrorHelper.createInternalServerError();
        }        
        else if (err.code === undefined && statusCode) {
            // If the error doesn't have a code but
            // an HTTP status code is given, use that.
            formattedErr = {
                code: statusCode,
                error: err.toString()
            };
        } else if (err.code === core.ErrorCodes.ScriptError) {
            // An error with the user's script cause an error to occur.
            // In these cases, we need to return a generic 500.
            formattedErr = ErrorHelper.createInternalServerError();
        } else if (err.code === core.ErrorCodes.BadInput) {
            // The user specified bad input and we need to return a 400.
            formattedErr = {
                code: StatusCodes.BAD_REQUEST,
                error: err.toString()
            };
        } else if (err.code === core.ErrorCodes.ItemNotFound || err.code == core.ErrorCodes.ItemSoftDeleted) {
            // A record requested by the user could not be found. Return 404.
            formattedErr = {
                code: StatusCodes.NOT_FOUND,
                error: err.toString()
            };
        } else if (err.code === core.ErrorCodes.MethodNotAllowed) {
            // Incorrect method used on an endpoint. Return 405.
            formattedErr = {
                code: StatusCodes.METHOD_NOT_ALLOWED,
                error: err.toString()
            };
        } else if (err.code === core.ErrorCodes.Conflict) {
            formattedErr = {
                code: StatusCodes.CONFLICT,
                error: err.toString()
            };
        } else {
            // Something really bad happened.
            // Return a generic 500.
            formattedErr = ErrorHelper.createInternalServerError();
        }

        if (requestID && !(err instanceof core.MobileServiceError)) {
            // For general unhandled exceptions, we include the
            // request id for log tracing.
            formattedErr.id = requestID;
        }

        if (process.isTestEnvironment) {
            // if we're testing, add detailed error information
            formattedErr.internalDetails = err.toString();
        }

        err = formattedErr;
    }

    return err;
};

ErrorHelper.createInternalServerError = function () {
    return {
        code: StatusCodes.INTERNAL_SERVER_ERROR,
        error: 'Error: Internal Server Error'
    };
};

exports = module.exports = ErrorHelper;