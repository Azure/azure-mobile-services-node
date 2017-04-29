// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module is the handler for Facebook login operations.  Like all provider
// login modules, it implements a very specific interface that is documented in
// ../loginhandler.js.

var core = require('../../core');

var jsonWebToken = require('../../jsonwebtoken');
var url = require('url');
var LoginHandler = require('../loginhandler.js');
var _ = require('underscore');
var _str = require('underscore.string');

_.mixin(_str.exports());

var urls = {
    prod: {
        clientFlowUrl: 'https://www.facebook.com/dialog/oauth?client_id=%s&redirect_uri=%s',
        graphHost: 'graph.facebook.com'
    },
    beta: {
        clientFlowUrl: 'https://www.beta.facebook.com/dialog/oauth?client_id=%s&redirect_uri=%s',
        graphHost: 'graph.beta.facebook.com'
    }
};


exports = module.exports = FacebookLoginHandler;

function FacebookLoginHandler(authenticationCredentials, logger) {
    this.authenticationCredentials = authenticationCredentials;    
    this.name = 'Facebook';
    this.logger = logger;
}

FacebookLoginHandler.prototype.isNewServerFlowRequest = request => {
    var isNewFlow = true;

    // If the query includes either a 'code' parameter or an 'error' parameter
    // then this is the continuation of a server authentication flow already in progress.
    if (request.query && (request.query.error || request.query.code)) {
        isNewFlow = false;
    }

    return isNewFlow;
};

FacebookLoginHandler.prototype.getNewServerFlowResponseHeaders = function (request, currentUri, callback, options) {
    var clientFlowUrl = this._getUrlByRequestMode(request, 'clientFlowUrl');

    var display = request.query.display || this.authenticationCredentials.facebook.display || 'touch';
    clientFlowUrl += '&display=' + display;

    var facebookUri = _.sprintf(clientFlowUrl, encodeURIComponent(this.authenticationCredentials.facebook.appId), currentUri);
    var scope = request.query.scope || this._normalizeScope();
    if (scope) {
        facebookUri = facebookUri + '&scope=' + scope;
    }

    callback(null, { Location: facebookUri });
};

FacebookLoginHandler.prototype.getProviderTokenFromClientFlowRequest = function (request, callback) {

    if (typeof request.body !== 'object' || typeof request.body.access_token !== 'string') {
        var error = new Error('The POST Facebook login request must specify the access token in the body of the request.');
        callback(error, null);
    } else {
        // Follow Facebook's recommendation from https://developers.facebook.com/docs/facebook-login/access-tokens/#extending
        // This ensures the short term access token given to us has not expired and was granted by a request to the Zumo service's Facebook app
        var facebookValidateUri = _.sprintf('/oauth/access_token?grant_type=fb_exchange_token&client_id=%s&client_secret=%s&fb_exchange_token=%s',
        encodeURIComponent(this.authenticationCredentials.facebook.appId),
        encodeURIComponent(this.authenticationCredentials.facebook.appSecret),
        encodeURIComponent(request.body.access_token));

        var validationOptions = {
            host: this._getUrlByRequestMode(request, 'graphHost'),
            port: 443,
            path: facebookValidateUri,
            method: 'GET'
        };

        _retrieveLongLivedAccessToken(validationOptions, 'The Facebook Graph API access token authorization request', callback);
    }
};

FacebookLoginHandler.prototype.getProviderTokenFromServerFlowRequest = function (request, currentUri, callback) {

    // Ensure that the request doesn't contain an error reported by facebook
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

    // Send Facebook their access code in order to get an access token from them
    var facebookUri =
        _.sprintf('/oauth/access_token?client_id=%s&client_secret=%s&code=%s&redirect_uri=%s',
            encodeURIComponent(this.authenticationCredentials.facebook.appId),
            encodeURIComponent(this.authenticationCredentials.facebook.appSecret), encodeURIComponent(code), currentUri);

    var graphHost = this._getUrlByRequestMode(request, 'graphHost');
    var options = {
        host: graphHost,
        port: 443,
        path: facebookUri,
        method: 'GET'
    };

    _retrieveLongLivedAccessToken(options, 'The Facebook Graph API request', callback);
};

FacebookLoginHandler.prototype.getAuthorizationDetailsFromProviderToken = function (request, providerToken, callback, options) {

    // Send facebook their provider token in order to get the associated userId to add to the
    // claims.
    var facebookUri = '/me?access_token=' + encodeURIComponent(providerToken);
    var graphHost = this._getUrlByRequestMode(request, 'graphHost');

    var graphApi = {
        host: graphHost,
        port: 443,
        path: facebookUri,
        method: 'GET'
    };

    LoginHandler.makeSecureRequest(graphApi, null, (error, res, body) => {
        var authorizationDetails = null;

        // Ensure that the request was successful
        if (!error && res.statusCode !== 200) {
            error = new Error('The Facebook Graph API request failed with HTTP status code ' + res.statusCode);
        }

        // Parse the body into the facebook me instance
        var me = null;
        if (!error) {
            try {
                me = JSON.parse(body);
            }
            catch (err) {
                error = err;
            }
        }

        // Validate the me instance 
        if (!error) {
            if ('object' !== typeof (me) || 'string' !== typeof (me.id)) {
                error = new Error('Unexpected content in the response from the Facebook Graph API');
            }
        }

        if (!error) {
            authorizationDetails = {
                providerId: me.id,
                claims: {
                    // name: me.name
                },
                secrets: {
                    accessToken: providerToken
                }
            };

            if (options.usersEnabled) {
                var claims = authorizationDetails.claims;
                var moreClaims = _.pick(me, ['id', 'username', 'email', 'name', 
                                             'gender', 'first_name', 'last_name', 
                                             'link', 'locale']);

                authorizationDetails.claims = _.extend(claims, moreClaims);
            }
        }

        callback(error, authorizationDetails);
    });
};

FacebookLoginHandler.prototype._getUrlByRequestMode = (request, urlName) => {
    var providerMode = request.query.useBeta ? 'beta' : 'prod';
    var url = urls[providerMode][urlName];    
    return url;
};

FacebookLoginHandler.prototype._normalizeScope = function () {
    if (this._scope === undefined) {
        var scope = (this.authenticationCredentials.facebook.scope || '').trim();
        if (scope.length > 0) {
            scope = scope.split(/[, ]/)
                         .map(encodeURIComponent) // prevent url parameter injection and proper encoding of scope values
                         .join('%2C'); // facebook scopes are comma separated
        }
        this._scope = scope;
    }
    return this._scope;
};

function _retrieveLongLivedAccessToken(options, errorPrefix, callback) {
    LoginHandler.makeSecureRequest(options, null, (error, res, body) => {

        var providerToken = null;

        // Ensure that the request was successful
        if (!error && res.statusCode !== 200) {
            error = new Error(errorPrefix + ' failed with HTTP status code ' + res.statusCode);
        }

        // Parse the body into the providerToken
        if (!error) {
            try {
              providerToken = JSON.parse(body).access_token;
            }
            catch (err) {
                error = err;
            }
        }

        if (!error && !providerToken) {
            error = new Error(errorPrefix + ' failed to return an access token.');
        }

        callback(error, providerToken);
    });
}