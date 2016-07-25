// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module is the handler for Google login operations.  Like all provider
// login modules, it implements a very specific interface that is documented in
// ../loginhandler.js.

var core = require('../../core'),
    jsonWebToken = require('../../jsonwebtoken'),
    LoginHandler = require('../loginhandler'),
    _ = require('underscore'),
    _str = require('underscore.string'),
    GoogleCert = require('./googlecert'),
    certCacheHelper = require('./certcachehelper');

_.mixin(_str.exports());

exports = module.exports = GoogleLoginHandler;

function GoogleLoginHandler(authenticationCredentials, logger) {
    this.authenticationCredentials = authenticationCredentials;
    this.name = 'Google';
    this.googleCert = new GoogleCert(logger);
    this.logger = logger;
}

GoogleLoginHandler.prototype.isNewServerFlowRequest = function (request) {
    var isNewFlow = true;

    // If the query includes either a 'code' parameter or an 'error' parameter
    // then this is the continuation of a server authentication flow already in progress.
    if (request.query && (request.query.error || request.query.code)) {
        isNewFlow = false;
    }

    return isNewFlow;
};

GoogleLoginHandler.prototype.getNewServerFlowResponseHeaders = function (request, currentUri, callback, options) {
    var scope = request.query.scope || this._normalizeScope();
    var accessType = request.query.access_type || encodeURIComponent(this.authenticationCredentials.google.accessType || 'online');

    var googleUri =
        _.sprintf('https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=%s&redirect_uri=%s&scope=%s&access_type=%s&approval_prompt=auto',
        encodeURIComponent(this.authenticationCredentials.google.clientId),
        currentUri,
        scope,
        accessType);

    callback(null, { Location: googleUri });
};

GoogleLoginHandler.prototype.getProviderTokenFromClientFlowRequest = function (request, callback) {
    var body = request.body,
        self = this;

    if (_.isObject(body) && _.isString(body.id_token)) {
        certCacheHelper.validateToken(this.googleCert, body.id_token, function (error, validatedIdToken) {
            if (error) {
                callback(error);
                return;
            }

            // Follow Google's recommendations from https://developers.google.com/accounts/docs/CrossClientAuth
            // To validate the id token
            if (validatedIdToken.claims.aud !== self.authenticationCredentials.google.clientId) {
                callback(new Error('The id_token audience does not match the configured clientId.'));
                return;
            }
            if (validatedIdToken.claims.iss !== 'accounts.google.com') {
                callback(new Error('The id_token issuer is invalid.'));
                return;
            }

            var providerInformation = {
                id_token: validatedIdToken
            };

            callback(null, providerInformation);
        });
    }
    else {
        callback(new Error('The POST Google login request must contain an id_token in the body of the request.'), null);
    }
};

GoogleLoginHandler.prototype.getProviderTokenFromServerFlowRequest = function (request, currentUri, callback) {
    // Ensure that the request doesn't contain an error reported by Google
    if (request.query.error) {
        var errorMessage = request.query.error;
        var error = new Error(errorMessage);
        callback(error, null);
        return;
    }

    // If there was not an error, there must be a code, otherwise this request would have been
    // considered a new server flow request
    var code = request.query.code;

    this._getProviderToken(code, currentUri, null, callback);
};

GoogleLoginHandler.prototype.getAuthorizationDetailsFromProviderToken = function (request, providerInformation, callback, options) {
    var self = this,
        providerId = providerInformation.id_token.claims.sub,
        authorizationDetails = {
            providerId: providerId,
            claims: {
            },
            secrets: {
            }
        };
    
    var accessToken = providerInformation.access_token;
    if (accessToken) {
        // in the client flow, we won't have an access_token
        authorizationDetails.secrets.accessToken = accessToken;
    }

    if (accessToken && options.usersEnabled) {
        var googleUri = '/oauth2/v3/userinfo?access_token=' + encodeURIComponent(accessToken),
            graphApi = {
                host: 'www.googleapis.com',
                port: 443,
                path: googleUri,
                method: 'GET'
            };

        LoginHandler.makeSecureRequest(graphApi, null, function (error, res, body) {
            if (error || res.statusCode !== 200) {
                callback(new Error('Failed to retrieve user info for google due to error: ' + error));
            }
            else {
                try {
                    var userinfo = JSON.parse(body);
                    var claims = authorizationDetails.claims;
                    claims.id = providerId;
                    var moreClaims = _.pick(userinfo, ['email', 'family_name', 'given_name', 
                                                       'locale', 'name', 'picture', 'sub']);
                    authorizationDetails.claims = _.extend(claims, moreClaims);
                }
                catch (err) {
                    error = new Error('Failed to parse the userinfo api response for google due to error: ' + err.toString());
                    self.logger.log(LogLevel.Warning, LogType.Warning, error.toString());
                    callback(error);
                    return;
                }
            }

            callback(null, authorizationDetails);
        });
    }
    else {
        callback(null, authorizationDetails);
    }
};

GoogleLoginHandler.prototype._getProviderToken = function (code, currentUri, idTokenFromClient, callback) {
    // Send Google their access code in order to get an access token from them
    var authParams = _.sprintf('client_id=%s&client_secret=%s&code=%s&grant_type=authorization_code',
            encodeURIComponent(this.authenticationCredentials.google.clientId),
            encodeURIComponent(this.authenticationCredentials.google.clientSecret),
            encodeURIComponent(code));

    if (currentUri) {
        authParams = authParams + _.sprintf('&redirect_uri=%s', currentUri);
    }

    var options = {
        host: 'accounts.google.com',
        port: 443,
        path: '/o/oauth2/token',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
            }
        },
        self = this;

    LoginHandler.makeSecureRequest(options, authParams, function (error, res, authBody) {
        // Ensure that the request was successful
        if (!error && res.statusCode !== 200) {
            error = new Error('The Google API request failed with HTTP status code ' + res.statusCode);
        }

        if (error) {
            callback(error);
            return;
        }

        // Response should contain accessToken and id_token. (If we change initial redirect 
        // to offline, it would also contain refresh_token)
        var parsedResponse = JSON.parse(authBody),
            idToken = parsedResponse.id_token;

        // Ensure the id_token returned is valid and stash the parsed response to re-use within getAuthorizationDetailsFromProviderToken
        certCacheHelper.validateToken(self.googleCert, idToken, function (innerError, responseIdToken) {
            if (innerError) {
                callback(innerError);
                return;
            }

            // If this was called from client flow, validate the sub claims match
            if (idTokenFromClient && (responseIdToken.claims.sub !== idTokenFromClient.claims.sub)) {
                callback(new Error("The Google API request failed to return matching id_token"));
                return;
            }

            var providerInformation = {
                id_token: responseIdToken,
                access_token: parsedResponse.access_token
            };

            callback(null, providerInformation);
        });
    });
};

GoogleLoginHandler.prototype._normalizeScope = function () {
    if (this._scope === undefined) {
        var scope = (this.authenticationCredentials.google.scope || 'https://www.googleapis.com/auth/userinfo.profile').trim();

        scope = scope.split(/[, ]/)
                     .map(encodeURIComponent)
                     .join('%20'); // google scopes are space separated

        this._scope = scope;
    }

    return this._scope;
};