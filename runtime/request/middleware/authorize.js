// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This middleware performs authorization on requests by comparing the required
// permisison of the request with the current auth level of the request. If
// the request is not authorized, it will be rejected.

var StatusCodes = require('../../statuscodes').StatusCodes;

var LoginHandler = require('../loginhandler');
var core = require('../../core');
var _ = require('underscore');

exports = module.exports = function authorize(logSource, keys) {
    return (req, res, next) => {
        var requestContext = req._context;
        var responseCallback = requestContext.responseCallback;
        var logger = requestContext.logger;
        var parsedRequest = requestContext.parsedRequest;

        logger.trace(logSource, 'Authorizing request');

        if (!isAuthorized(parsedRequest, keys)) {
            responseCallback(new core.MobileServiceError("Unauthorized"), null, StatusCodes.UNAUTHORIZED);
            return;
        }

        next();
    };
};

function isAuthorized (request, keys) {
    // if the request has specified a valid master key, then we have admin access
    var adminAccess = request.masterKey && keys.masterKey &&
                      (request.masterKey == keys.masterKey);

    if (adminAccess) {
        // admins are always allowed
        return true;
    }

    if (request.noScript) {
        // if noScript option was requested, admin access is required
        return false;
    }

    var requiredPermission = request.requiredPermission || 'admin';
    if (requiredPermission == 'admin') {
        // since we already returned for admins, if we're here,
        // we don't have the required admin access
        return false;
    }
    else if (
        (requiredPermission == 'user' || requiredPermission == 'authenticated') &&
         !request.authenticationToken) {
        // note that user and authenticated are synonyms
        return false;
    }
    else if (requiredPermission == 'application') {
        return request.applicationKey && keys.applicationKey &&
               (request.applicationKey == keys.applicationKey);
    }

    return true;
}