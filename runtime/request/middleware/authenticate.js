// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This middleware authenticates requests by validating any auth tokens or
// headers provided on the request and setting the corresponding user login
// level on the request. If the request is unauthenticated, this handler will
// end the request.

var StatusCodes = require('../../statuscodes').StatusCodes,
    jsonWebToken = require('../../jsonwebtoken'),
    User = require('../user'),
    UserService = require('../../users/userservice'),
    core = require('../../core'),    
    _ = require('underscore'),
    _str = require('underscore.string');

_.mixin(_str.exports());

function authenticate(logSource, keys, userService) {
    return function (req, res, next) {
        var requestContext = req._context,
            responseCallback = requestContext.responseCallback,
            logger = requestContext.logger,
            metrics = requestContext.metrics,
            parsedRequest = requestContext.parsedRequest;

        logger.trace(logSource, 'Authenticating request');
        
        if (parsedRequest.authenticationKey) {
            // determine the key to use, based on operation type
            var key = (parsedRequest.operation === 'jobs') ? keys.systemKey : keys.masterKey;

            // Parse and validate the token. Note: regardless of the required permission level of
            // the request (e.g. a table operation), if there is a token on the request,
            // it must be valid.
            var parsedToken = null;
            try {
                parsedToken = jsonWebToken.parse(parsedRequest.authenticationKey, key, jsonWebToken.windowsLiveSigningSuffix);
            }
            catch (err) {
                logger.log(LogLevel.Information, LogType.Information, logSource, err.message + ' Token: ' + parsedRequest.authenticationKey);
                responseCallback(new core.MobileServiceError(err), null, StatusCodes.UNAUTHORIZED);
                return;
            }

            // set the valid token on the request
            parsedRequest.authenticationToken = parsedToken;

            if (parsedToken && parsedToken.claims) {
                if (parsedToken.claims.id) {
                    parsedRequest.userId = parsedToken.claims.id;
                }
                else {
                    parsedRequest.userId = parsedToken.claims.uid;
                }
                parsedRequest.authenticationProvider = UserService.getProviderNameByUserId(parsedToken.claims.uid);
            }
        }

        // build the user object based on the request credentials
        req.user = User.create(requestContext, keys, userService);

        metrics.event('login.level.' + req.user.level);

        next();
    };
}

exports = module.exports = authenticate;