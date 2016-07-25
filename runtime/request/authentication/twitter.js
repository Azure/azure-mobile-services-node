// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module is the handler for Twitter login operations.  Like all provider
// login modules, it implements a very specific interface that is documented in
// ../loginhandler.js.
//
// This server authentication flow is documented at:
// https://dev.twitter.com/docs/auth/implementing-sign-twitter
//
// An Example of this flow can be found at:
// https://gist.github.com/555607

var core = require('../../core'),
    jsonWebToken = require('../../jsonwebtoken'),
    OAuth = require('oauth').OAuth,
    LoginHandler = require('../loginhandler'),
    Encryptor = require('../../encryptor'),
    _ = require('underscore'),
    _str = require('underscore.string');

_.mixin(_str.exports());

exports = module.exports = TwitterLoginHandler;

function TwitterLoginHandler(authenticationCredentials, logger) {
    this.authenticationCredentials = authenticationCredentials;
    this.name = 'Twitter';
    this.logger = logger;
}

// Twitter does not return the OAuth state query parameter so this must be set to true.
TwitterLoginHandler.prototype.oAuthStateNotSupported = true;

// Cookie to store an encrypted request token, which must generated with the first request of
// the server auth flow but is also needed with the second request.  Note: the 'wams_' prefix
// is important.  This ensures that the LoginHandler.js will clean up this cookie for us.
TwitterLoginHandler.RequestTokenCookieName = 'wams_rt';

TwitterLoginHandler.prototype.isNewServerFlowRequest = function (request) {
    var isNewFlow = true;

    // If the query includes an 'oauth_verifier' parameter then this is the 
    // continuation of a server authentication flow already in progress.
    if (request.query && request.query.oauth_verifier) {
        isNewFlow = false;
    }

    return isNewFlow;
};

TwitterLoginHandler.prototype.getNewServerFlowResponseHeaders = function (request, currentUri, callback, options) {

    var consumerSecret = this.authenticationCredentials.twitter.consumerSecret;
    var oauth = _getOAuthInstance(this.authenticationCredentials.twitter.consumerKey,
                                  consumerSecret,
                                  currentUri);

    oauth.getOAuthRequestToken(function (error, requestToken, requestTokenSecret, results) {

        if (error) {
            error = new Error('Unable to obtain OAuth request token from Twitter.');
            callback(error, null);
            return;
        }

        var twitterUri = 'https://api.twitter.com/oauth/authenticate?oauth_token=' + encodeURIComponent(requestToken);

        var headers = { Location: twitterUri };

        // We'll need the requestToken when the client is redirected back here to continue
        // the server authentication flow, so we'll pass it along as an encrypted cookie.
        var cookiePayload = {
            rt: requestToken,
            rts: requestTokenSecret
        };
        var cookiePayloadEncrypted = Encryptor.encrypt(consumerSecret, JSON.stringify(cookiePayload));
        LoginHandler.addCookieToHeaders(TwitterLoginHandler.RequestTokenCookieName,
                                        cookiePayloadEncrypted,
                                        headers);

        callback(null, headers);
    });
};

TwitterLoginHandler.prototype.getProviderTokenFromClientFlowRequest = function (request, callback) {
    var error = new core.MobileServiceError('POST of Twitter token is not supported.', core.ErrorCodes.MethodNotAllowed);
    callback(error, null);
};

TwitterLoginHandler.prototype.getProviderTokenFromServerFlowRequest = function (request, currentUri, callback) {
    // The providerToken (or requestToken in this case) is encrypted within the cookies
    var error = null;
    var requestToken = null;

    // Get the cookie
    var cookieValue = LoginHandler.getCookieFromHeaders(TwitterLoginHandler.RequestTokenCookieName,
                                                        request.headers);
    if (!cookieValue) {
        error = new Error('OAuth request token is not present in the HTTP cookies of the request.');
    }

    // Decrypt and parse the cookie value
    if (!error) {
        try {

            var cookieSecret = this.authenticationCredentials.twitter.consumerSecret;
            var cookieValueDecrypted = Encryptor.decrypt(cookieSecret, cookieValue);
            requestToken = JSON.parse(cookieValueDecrypted);
        }
        catch (err) {
            error = new Error('Invalid OAuth request token in the HTTP cookies of the request.');
        }
    }

    // Validate the token
    if (!error) {
        if (typeof requestToken !== 'object' ||
            typeof requestToken.rt !== 'string' ||
            typeof requestToken.rts !== 'string') {
            requestToken = null;
            error = new Error('Invalid OAuth request token in the HTTP cookies of the request.');
        }
    }

    // If anything went wrong, return now;
    if (error) {
        callback(error, null);
        return;
    }

    // Otherwise, use the requestToken to get the provider's access token 
    var oauth = _getOAuthInstance(this.authenticationCredentials.twitter.consumerKey,
                                  this.authenticationCredentials.twitter.consumerSecret,
                                  currentUri);

    oauth.getOAuthAccessToken(requestToken.rt,
                              requestToken.rts,
                              request.query.oauth_verifier,
                              function (error, accessToken, accessTokenSecret, results) {
                                  var providerToken = null;

                                  if (error) {
                                      error = new Error('Unable to obtain OAuth access token from Twitter.');
                                  }

                                  // Create a 'providerToken' out of the accessToken, accessTokenSecret and results       
                                  if (!error) {
                                      providerToken = {
                                          accessToken: accessToken,
                                          accessTokenSecret: accessTokenSecret,
                                          results: results
                                      };
                                  }

                                  callback(error, providerToken);
                              });
};

TwitterLoginHandler.prototype.getAuthorizationDetailsFromProviderToken = function (request, providerToken, callback, options) {

    var error = null;
    var authorizationDetails = null;

    if (typeof providerToken.results !== 'object' ||
        typeof providerToken.results.user_id !== 'string') {
        error = new Error('Unable to extract Twitter user name from OAuth access token response from Twitter.');
    }
    else {
        var providerId = providerToken.results.user_id;
        authorizationDetails = {
            providerId: providerId,
            claims: {
                // name: providerToken.results.name
            },
            secrets: {
                accessToken: providerToken.accessToken,
                accessTokenSecret: providerToken.accessTokenSecret
            }
        };

        if (options.usersEnabled) {
            authorizationDetails.claims.id = providerId;
            if (providerToken.results.screen_name !== undefined) {
                authorizationDetails.claims.screen_name = providerToken.results.screen_name;
            }
        }
    }

    callback(error, authorizationDetails);
};

function _getOAuthInstance(consumerKey, consumerSecret, redirectUri) {
    return new OAuth(
        'https://api.twitter.com/oauth/request_token',
        'https://api.twitter.com/oauth/access_token',
        consumerKey,
        consumerSecret,
        '1.0',
        redirectUri,
        'HMAC-SHA1');
}