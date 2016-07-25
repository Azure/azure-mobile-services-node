// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module is the handler for Microsoft Account login operations.  Like all 
// provider login modules, it implements a very specific interface that is 
// documented in ../loginhandler.js.
// 
// The server authentication flow is documented at:
// http://msdn.microsoft.com/en-us/library/live/hh243647.aspx#authcodegrant

var core = require('../../core'),
    jsonWebToken = require('../../jsonwebtoken'),
    LoginHandler = require('../loginhandler'),
    _ = require('underscore'),
    _str = require('underscore.string');

_.mixin(_str.exports());

exports = module.exports = MicrosoftAccountLoginHandler;

function MicrosoftAccountLoginHandler(authenticationCredentials, logger) {
    this.authenticationCredentials = authenticationCredentials;
    this.name = 'MicrosoftAccount';
    this.logger = logger;
}

MicrosoftAccountLoginHandler.prototype.isNewServerFlowRequest = function (request) {
    var isNewFlow = true;

    // If the query includes either a 'code' parameter or an 'error' parameter
    // then this is the continuation of a server authentication flow already in progress.
    if (request.query && (request.query.error || request.query.code)) {
        isNewFlow = false;
    }

    return isNewFlow;
};

MicrosoftAccountLoginHandler.prototype.getNewServerFlowResponseHeaders = function (request, currentUri, callback, options) {
    // when users feature is not enabled we can not ask for wl.signin scope because it results in a bigger token that can't fit in jwt
    // wl.signin scope is required for single sign-on
    var defaultScope = options.usersEnabled ? 'wl.basic wl.signin': 'wl.basic';
    var scope = request.query.scope || this._normalizeScope(defaultScope);

    var display = request.query.display || this.authenticationCredentials.microsoftaccount.display || 'touch';

    var microsoftAccountUri =
        _.sprintf('https://login.live.com/oauth20_authorize.srf?client_id=%s&display=%s&response_type=code&scope=%s&redirect_uri=%s',
        encodeURIComponent(this.authenticationCredentials.microsoftaccount.clientId),
        display,
        scope,
        currentUri);

    callback(null, { Location: microsoftAccountUri });
};

MicrosoftAccountLoginHandler.prototype.getProviderTokenFromClientFlowRequest = function (request, callback) {

    var error = null;
    var providerToken = null;

    // Ensure that the request body has the unparsed token
    if (!request.body || typeof request.body.authenticationToken !== "string") {
        error = new Error('The POST Microsoft Account login request must specify the authentication token in the body of the request.');
    }
    else {
        // Return the complete request.data, which will have the authenticationToken and
        // a possible access_token
        providerToken = request.body;
    }

    callback(error, providerToken);
};

MicrosoftAccountLoginHandler.prototype.getProviderTokenFromServerFlowRequest = function (request, currentUri, callback) {

    // Ensure that the request doesn't contain an error reported by Microsoft
    if (request.query.error) {
        var errorMessage = request.query.error;
        if (request.query.error_description) {
            errorMessage = errorMessage + ': ' + request.query.error_description;
        }
        var error = new Error(errorMessage);
        callback(error, null);
        return;
    }

    // If there was not an error, there must be a code, otherwise this request would have been
    // considered a new server flow request
    var code = request.query.code;

    // Send Microsoft their access code in order to get an access token from them
    var data = _.sprintf('client_id=%s&client_secret=%s&code=%s&redirect_uri=%s&grant_type=authorization_code',
            encodeURIComponent(this.authenticationCredentials.microsoftaccount.clientId),
            encodeURIComponent(this.authenticationCredentials.microsoftaccount.clientSecret),
            encodeURIComponent(code), currentUri);

    var options = {
        host: 'login.live.com',
        port: 443,
        path: '/oauth20_token.srf',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(data, 'utf8').toString()
        }
    };

    LoginHandler.makeSecureRequest(options, data, function (error, res, body) {

        var providerToken = null;

        // Ensure that the request was successful
        if (!error && res.statusCode !== 200) {
            error = new Error('The Microsoft Account authentication request failed with HTTP status code ' + res.statusCode);
        }

        // Parse the body into the providerToken
        if (!error) {
            try {
                providerToken = JSON.parse(body);
            }
            catch (err) {
                error = err;
            }
        }

        // Validate the providerToken
        if (!error) {
            if (!providerToken) {
                error = new Error('The Microsoft Account authentication request failed to return an access token.');
            }
            else if (typeof providerToken !== 'object' || typeof providerToken.access_token !== 'string') {
                providerToken = null;
                error = new Error('The Microsoft Account authentication request returned an invalid access token.');
            }
        }

        // Normalize the providerToken
        if (!error) {
            providerToken.authenticationToken = providerToken.authentication_token;
        }

        callback(error, providerToken);
    });
};

MicrosoftAccountLoginHandler.prototype.getAuthorizationDetailsFromProviderToken = function (request, providerToken, callback, options) {
    var self = this,
        // Parse the authentication token portion of the providerToken
        unparsedToken = providerToken.authenticationToken,
        key = this.authenticationCredentials.microsoftaccount.clientSecret,
        parsedToken = null,
        error = null,
        authorizationDetails = null;

    try {
        parsedToken = jsonWebToken.parse(unparsedToken, key, jsonWebToken.windowsLiveSigningSuffix);
    }
    catch (err) {
        error = err;
    }

    if (!error) {
        authorizationDetails = {
            providerId: parsedToken.claims.uid,
            claims: {
                // name: parsedToken.claims.name
            },
            secrets: {}
        };

        if (providerToken.access_token) {
            authorizationDetails.secrets.accessToken = providerToken.access_token;
        }
    }

    if (authorizationDetails && authorizationDetails.secrets.accessToken && options.usersEnabled) {
        var microsftUri = '/v5.0/me?access_token=' + encodeURIComponent(authorizationDetails.secrets.accessToken),
            graphApi = {
                host: 'apis.live.net',
                port: 443,
                path: microsftUri,
                method: 'GET'
            };

        LoginHandler.makeSecureRequest(graphApi, null, function (error, res, body) {
            if (error || res.statusCode !== 200) {
                callback(new Error('Failed to retrieve user info for microsoft account due to error: ' + error));
            }
            else {
                try {
                    var me = JSON.parse(body);
                    var claims = authorizationDetails.claims;
                    var moreClaims = _.pick(me, ['id', 'name', 'first_name', 
                                                 'last_name', 'link', 'gender', 
                                                 'locale', 'emails']);
                    authorizationDetails.claims = _.extend(claims, moreClaims);
                }
                catch (err) {
                    self.logger.log(LogLevel.Warning, LogType.Warning, 'Failed to parse the me graph api response for microsoft account due to error: ' + err.toString());
                }
            }

            callback(null, authorizationDetails);
        });
    }
    else {
        callback(error, authorizationDetails);
    }
};

MicrosoftAccountLoginHandler.prototype._normalizeScope = function (defaultScope) {
    if (this._scope === undefined) {
        var scope = (this.authenticationCredentials.microsoftaccount.scope || defaultScope).trim();

        scope = scope.split(/[, ]/)
                     .map(encodeURIComponent) // prevent url parameter injection and proper encoding of scope values
                     .join('%20'); // microsoft account scopes are space separated

        this._scope = scope;
    }

    return this._scope;
};