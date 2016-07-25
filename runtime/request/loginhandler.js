// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module is the handler for login operations. The loginHandler works with
// a collection of provider-specific login handlers.  These provider-specific
// login handlers are found at: ./authentication/*.
//
// To add a new provider, you must create a provider-specific login handler that
// implements the following interface:
//
// prototype.oAuthStateNotSupported = false; // or true, of course.  If not 
//                                           // implemented, assumed to be false.
//                                           // Only set to true if the provider
//                                           // will not return the oAuth state parameter. 
//
// provider.isNewServerFlowRequest = function (request) {
//      return true; // or false, of course
// }
//
// provider.getNewServerFlowResponseHeaders = function (request, currentUri, callback, options) {
//   callback(error, headers);
// }
// 
// provider.getProviderTokenFromClientFlowRequest = function (request, callback) {
//     callback(error, providerToken);
// }
// 
// provider.getProviderTokenFromServerFlowRequest = function (request, currentUri, callback) {
//     callback(error, providerToken);
// }
// 
// provider.getAuthorizationDetailsFromProviderToken = function(request, providerToken, callback, options) {
//     callback(error, authorizationDetails);
// }
//
// authorizationDetails = {
//      providerId: '1234',
//      claims: {                          // these claims contain logged in user details but not access tokens and sensitive identity information.
//          name: 'First name',
//          email: 'user@contoso.com'
//      }
//      secrets: {                          // these claims must be encrypted if stored in persistent storage for increased security.
//           accessToken: 'as23kdl234'
//      }
// }
//
// See any of the existing provider-specific login handlers for examples of how to
// implement this interface.

exports = module.exports = LoginHandler;

var core = require('../core'),
    UserService = require('../users/userService'),
    jsonWebToken = require('../jsonwebtoken'),
    StatusCodes = require('../statuscodes').StatusCodes,
    templating = require('./html/templating'),
    https = require('https'),
    Encryptor = require('../encryptor'),
    Twitter = require('./authentication/twitter'),
    Google = require('./authentication/google'),
    Facebook = require('./authentication/facebook'),
    MicrosoftAccount = require('./authentication/microsoftaccount'),
    Aad = require('./authentication/aad'),
    resources = require('../resources'),
    _ = require('underscore'),
    _str = require('underscore.string');

_.mixin(_str.exports());

var logSource = 'LoginHandler';

function LoginHandler(authenticationCredentials, masterKey, corsHelper, logger, userService, domainSuffix) {
    this.authenticationCredentials = authenticationCredentials;
    this.masterKey = masterKey;
    this.corsHelper = corsHelper;
    this.userService = userService || UserService.nullService;    

    this.providers = {
        twitter: new Twitter(authenticationCredentials, logger),
        google: new Google(authenticationCredentials, logger),
        facebook: new Facebook(authenticationCredentials, logger),
        microsoftaccount: new MicrosoftAccount(authenticationCredentials, logger),
        aad: new Aad(authenticationCredentials, logger, domainSuffix)
    };
}

// Cookie used to ensure against some cross-site scripting attacks.  The state is
// returned both as a cookie and in the redirect URL query string from the provider.  
// We check to ensure that the two agree. Note: the 'wams_' prefix is important.  
// This ensures that the LoginHandler.js will clean up this cookie.
LoginHandler.OAuthStateCookieName = 'wams_state';

// Cookie used to indicate that the client requested single sign-on. If single sign-on
// is being used, the final redirect has to be the Package SID (ms-app://blah-blah-blah)
// and not the traditional final URL.  This is to work around the limitation of the 
// WebAuthenticationBroker used in the Win8 clients. Note: the 'wams_' prefix
// is important.  This ensures that the LoginHandler.js will clean up this cookie.
LoginHandler.SingleSignOnCookieName = 'wams_singleSignOn';

// Cookie used to preserve state for login flows launched from a browser. We have to
// track the fact that the login is from a browser so that, on completion, we know to
// return the correct JavaScript code to return the token to the calling frame. Note:
// the 'wams_' prefix is important. This ensures that the LoginHandler.js will clean 
// up this cookie.
LoginHandler.CompletionActionCookieName = 'wams_completionAction';

// Scheme used to construct RedirectUrls
LoginHandler.RedirectUrlScheme = 'https';

// Perform any required async startup initialization
LoginHandler.prototype.initialize = function (done) {
    this.providers.aad.initialize(done);
};

LoginHandler.prototype.handle = function (req, res) {
    var logger = req._context.logger,
        metrics = req._context.metrics,
        responseCallback = req._context.responseCallback,
        request = req._context.parsedRequest;

    request.query = req.query;  // login needs the raw query
    request.authenticationProvider = req.params.authenticationProvider;
    request.body = req.body;

    logger.trace(logSource, 'Processing request');

    var error = null;

    // Normalize the request to support legacy Microsoft Account login and to
    // better manage cookies
    _normalizeRequest(request);

    // Create a loginContext to avoid passing lots of parameters around
    var loginContext = {
        loginHandler: this,
        corsHelper: this.corsHelper,
        request: request,
        responseCallback: responseCallback,
        logger: logger,
        metrics: metrics
    };

    // If this is a completed server flow, just return OK
    if (_isCompletedServerFlow(request)) {
        _respondWithSuccess(loginContext, null);
        return;
    }

    // Get the provider instance to handle the provider specific authentication flow
    // or return an error if there is no such provider.
    var provider = this.providers[request.authenticationProvider];
    if (!provider) {
        error = new Error(_.sprintf("Authentication with '%s' is not supported.", request.authenticationProvider));
        _respondWithError(loginContext, error);
        return;
    }
    loginContext.provider = provider;

    // ensure that the metric is logged only after we've validated the provider
    metrics.event('login.provider.' + request.authenticationProvider);

    // The request method determines if this is a client or server authentication flow
    if (request.verb === 'POST') {
        this._handleClientFlowRequest(loginContext);
    } else if (request.verb === 'GET') {
        this._handleServerFlowRequest(loginContext);
    } else {
        error = new Error(_.sprintf("%s requests are not supported.", request.verb));
        _respondWithError(loginContext, error);
        return;
    }
};

LoginHandler.prototype._handleClientFlowRequest = function (loginContext) {
    // A client authentication flow will consist of a single request.  The client,
    // having already gotten a provider-specific access token from the provider, will
    // send a POST request that includes the provider's token. We'll execute the
    // following steps:
    //
    //  (1) We'll ask the provider-specific login handler to extract the provider's
    //      access token from the request. (How the provider's access token is
    //      sent in the POST request varies across providers).
    //  (2) We'll then create a new claims instance and ask the provider-specific
    //      login-handler to exchange the provider's token for a userId to add to
    //      the claims instance.
    //  (3) We'll then use the claims to create a new Mobile Services token (loginToken)
    //      that we'll return to the client in the response body.
    // 
    //  If any error occurrs, we'll send the error in the body of the response.

    var provider = loginContext.provider;
    var providerName = loginContext.request.authenticationProvider;
    var request = loginContext.request;
    var logger = loginContext.logger;
    var handler = loginContext.loginHandler;
    var self = this;

    logger.trace(logSource, _.sprintf('Getting the %s provider token from the client flow request.', providerName));

    // Get the provider's token out of the request
    provider.getProviderTokenFromClientFlowRequest(request, function (error, providerToken) {
        if (error) {
            _respondWithError(loginContext, error);
            return;
        }

        logger.trace(logSource, _.sprintf('Getting the %s provider token from the client flow request succeeded.', providerName));
        logger.trace(logSource, _.sprintf('Exchanging the %s provider token for a Windows Azure Mobile Services token.', providerName));

        handler.userService.isEnabled(function (err, usersEnabled) {
            var options = {
                usersEnabled: usersEnabled
            };
            provider.getAuthorizationDetailsFromProviderToken(request, providerToken, function (innerError, authorizationDetails) {

                if (innerError) {
                    _respondWithError(loginContext, innerError);
                    return;
                }

                self._createResponseForLoginToken(logger, loginContext, authorizationDetails, providerName, function (err, responseBody) {
                    if (err) {
                        _respondWithError(loginContext, err);
                        return;
                    }

                    _respondWithSuccess(loginContext, responseBody);
                });
            }, options);
        });
    });
};

LoginHandler.prototype._handleServerFlowRequest = function (loginContext) {
    // A server authentication flow will consist of two requests.  The client will first
    // send a request to initiate the flow for a particular provider and we'll redirect 
    // the client to the provider's login page. After the user logs in with the provider, 
    // the client will get redirected back here with an access code (or something similiar).
    var provider = loginContext.provider;
    var providerName = loginContext.request.authenticationProvider;
    var providerCredentials = loginContext.loginHandler.authenticationCredentials;
    var hostName = loginContext.request.headers.host;
    var request = loginContext.request;

    // Ensure credentials for the provider are available and enabled
    var credentials = providerCredentials[providerName];
    if (!credentials || !credentials.enabled) {
        var error = new Error(_.sprintf('Logging in with %s is not enabled.', providerName));
        _respondWithError(loginContext, error);
        return;
    }

    // Create the URI for this current operation so that providers can be redirected back here.
    var currentUri = _.sprintf("%s://%s/login/%s", LoginHandler.RedirectUrlScheme, hostName, providerName);

    // Have the provider determine if this is a new server authentication flow or
    // the continuation of one already in process.
    if (provider.isNewServerFlowRequest(request)) {
        _handleNewServerFlowRequest(loginContext, currentUri);
    } else {
        _handleContinuedServerFlowRequest(loginContext, currentUri);
    }
};

// Simplifies making HTTPS requests for the provider-specific login handlers.
// Any errors that might occur when making the request or getting the response are
// marshalled to the callback, which has the following signature:
//   callback(error, response, responseBody)
LoginHandler.makeSecureRequest = function (requestOptions, requestBody, callback) {

    var request = https.request(requestOptions, function (response) {
        var responseBody = '';
        response.on('data', function (data) {
            responseBody += data;
        });

        response.on('end', function () {
            callback(null, response, responseBody);
        });
    });

    request.on('error', function (error) {
        callback(error, null, null);
    });

    request.end(requestBody);
};

// Simplifies reading a value for a cookie from request/response headers.
// RETURNS: cookie value or null if there was no such cookie
LoginHandler.getCookieFromHeaders = function (name, headers) {
    // Get the cookie value and decode it
    var cookies = _parseCookies(headers);
    var value = cookies[name];
    if (value) {
        value = decodeURIComponent(value);
    }

    return value;
};

// Simplifies writing a value for a cookie to response headers.
// RETURNS: nothing
LoginHandler.addCookieToHeaders = function (name, value, headers) {
    // Create the cookie
    var encodedValue = encodeURIComponent(value);
    if (encodedValue === 'deleted') {
        encodedValue = encodedValue + '; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    }
    var cookieToAdd = name + '=' + encodedValue + '; HttpOnly; Secure';

    // Check for any existing cookies and include the cookie to add
    var currentCookies = headers['Set-Cookie'];
    if (!currentCookies) {
        currentCookies = cookieToAdd;
    } else if (core.isString(currentCookies)) {
        currentCookies = [currentCookies, cookieToAdd];
    } else {
        // Must be an array that already includes some cookies
        currentCookies.push(cookieToAdd);
    }

    headers['Set-Cookie'] = currentCookies;

    // Also, we'll add the cookie name to a private cache of parsed cookies
    // so that we know what cookies have been set without having to parse again.
    // The _parseCookies() function will rely on this _parsedCookies object.
    if (!headers._parsedCookies) {
        headers._parsedCookies = {};
    }
    headers._parsedCookies[name] = value;
};

LoginHandler.createOAuthRedirectState = function () {
    // Per OAuth 2, this function creates a unique per-request state that the 
    // authentication provider will echo back as a query parameter when redirecting 
    // client's browser back to the Zumo server. The server will then validate the 
    // value of the state. This state reflecting mechanism is meant to prevent certain 
    // class of cross-site scripting attacks.
    return Math.floor(Math.random() * 100000000000).toString(16) + (new Date()).getTime().toString(16);
};

function _handleNewServerFlowRequest(loginContext, currentUri) {
    // This function handles the first request of the two-request server authentication flow.
    // We'll simply redirect the client to the provider's login page. If there is any
    // error, we'll redirect back to this URI but with the error encoded in the URI.

    var request = loginContext.request;
    var providerName = loginContext.request.authenticationProvider;
    var provider = loginContext.provider;
    var logger = loginContext.logger;

    // Determine if single sign-on of windows 8 is being used and if so, validate
    var singleSignOnRedirectUri = _getSingleSignOnRedirectUriFromRequest(loginContext);
    if (singleSignOnRedirectUri && !_validateSingleSignOnRedirectUri(singleSignOnRedirectUri, loginContext)) {
        return;
    }

    // Determine if a completion action was specified (for browser-initiated flows) and if so, validate
    var completionAction = _getCompletionActionFromQueryString(loginContext.request.query);
    if (completionAction && !_validateCompletionOriginForNewServerFlow(completionAction, loginContext)) {
        return;
    }

    logger.trace(logSource, _.sprintf('Initializing a new server authentication flow with provider: %s.', providerName));

    loginContext.loginHandler.userService.isEnabled(function (err, usersEnabled) {
        // Get the location header and any others from the provider-specific login handler as
        // we're going to redirect the client to the login page for the given provider.
        var options = {
            usersEnabled: usersEnabled
        };
        provider.getNewServerFlowResponseHeaders(request, currentUri, function (error, headers) {

            if (error) {
                _redirectWithError(loginContext, error);
                return;
            }

            // If the provider supports oAuth state, then add it to the redirect URL and the cookies
            if (provider.oAuthStateNotSupported !== true) {
                // Create the oAuth state instance needed to ensure against replay attacks; we'll
                // validate this oAuth state in the second request.
                var oAuthState = LoginHandler.createOAuthRedirectState();
                LoginHandler.addCookieToHeaders(LoginHandler.OAuthStateCookieName, oAuthState, headers);
                headers.Location += '&state=' + encodeURIComponent(oAuthState);
            }

            // We'll need the single sign on redirect URI at the very end of the server authentication flow so
            // we need to send it as a cookie in order to get it back later. 
            if (singleSignOnRedirectUri) {
                _addSingleSignOnCookie(loginContext, singleSignOnRedirectUri, headers);
            }

            // We'll need the completion action information (if provided) at the end of the flow
            if (completionAction) {
                _addCompletionActionCookie(completionAction, headers);
            }

            _redirectWithSuccess(loginContext, headers);
        }, options);
    });
}

function _handleContinuedServerFlowRequest(loginContext, currentUri) {
    // This function handles the second request of the two-request server authentication flow.
    // The client has been redirected here from the provider, with a access code (or something 
    // like it). We'll execute the following steps:
    //
    //  (1) We'll ask the provider-specific login handler to get the provider's
    //      access code from the request and send a request to the provider to exchange the
    //      access code for the provider's access token.
    //  (2) We'll then create a new claims instance and ask the provider-specific
    //      login-handler to exchange the provider's token for a userId to add to
    //      the claims instance.
    //  (3) We'll then use the claims to create a new Mobile Services token (loginToken)
    //      that we'll return to the client by redirecting with the token encoded in the URI,
    //
    //  If any error occurrs, we'll redirect back to this URI but with the error encoded in the URI.
    var provider = loginContext.provider;
    var providerName = loginContext.request.authenticationProvider;
    var logger = loginContext.logger;
    var request = loginContext.request;
    var handler = loginContext.loginHandler;

    // Validate the oAuth State to ensure against cross-site scripting attacks
    if (provider.oAuthStateNotSupported !== true) {
        var error = _getAnyOAuthStateErrors(request);
        if (error) {
            _redirectWithError(loginContext, error);
            return;
        }
    }

    logger.trace(logSource, _.sprintf('Continuing a server authentication flow with provider: %s.', providerName));

    provider.getProviderTokenFromServerFlowRequest(request, currentUri, function (error1, providerToken) {

        if (error1) {
            _performFailedServerFlowAction(loginContext, error1);
            return;
        }

        logger.trace(logSource, _.sprintf('Retrieved a %s provider token in a server authentication flow.', providerName));
        logger.trace(logSource, _.sprintf('Exchanging the %s provider token for a Windows Azure Mobile Services token.', providerName));

        handler.userService.isEnabled(function (err, usersEnabled) {
            var options = {
                usersEnabled: usersEnabled
            };
            provider.getAuthorizationDetailsFromProviderToken(request, providerToken, function (error2, authorizationDetails) {

                if (error2) {
                    _performFailedServerFlowAction(loginContext, error2);
                    return;
                }

                handler._createResponseForLoginToken(logger, loginContext, authorizationDetails, providerName, function (err, responseBody) {
                    if (err) {
                        _respondWithError(loginContext, err);
                    }
                    else {
                        _performCompletedServerFlowAction(loginContext, responseBody);
                    }
                });
            }, options);
        });
    });
}

function _performCompletedServerFlowAction(loginContext, oAuthResponse) {
    var completionAction = _getCompletionActionFromCookie(loginContext.request.headers);

    if (!completionAction) {
        // Non-browser clients complete the flow by redirecting to a "done" URL
        // with the oAuthResponse encoded into the hash
        var encodedResponse = encodeURIComponent(JSON.stringify(oAuthResponse)),
            redirectUri = _getFinalRedirectUri(loginContext) + '#token=' + encodedResponse;
        _redirectWithSuccess(loginContext, { Location: redirectUri });
    } else {
        // Browser clients send back a script that posts the token to the window opener
        // as long as it is on a whitelisted origin
        _returnServerFlowCompletionScriptToBrowser(loginContext, completionAction, oAuthResponse, null);
    }
}

function _performFailedServerFlowAction(loginContext, error) {
    var completionAction = _getCompletionActionFromCookie(loginContext.request.headers);

    if (!completionAction) {
        // Non-browser clients complete the flow by redirecting to a "done" URL
        // with the error encoded into the hash
        _redirectWithError(loginContext, error);
    } else {
        // Browser clients send back a script that posts the error to the window opener
        // as long as it is on a whitelisted origin
        _returnServerFlowCompletionScriptToBrowser(loginContext, completionAction, null, error);
    }
}

function _returnServerFlowCompletionScriptToBrowser(loginContext, completionAction, oAuthResponse, oAuthError) {
    var responseCallback = loginContext.responseCallback,
        responseHeaders = {};

    // Ensure that all 'wams' cookies get cleaned up.
    _deleteAllUnsetWAMSCookies(loginContext, responseHeaders);

    // We validate the completion origin at the last moment before display to ensure that, if there will be a 
    // postMessage, it can't be picked up by third parties launching our login flow from their domains.
    var completionOriginError = _getAnyCompletionOriginErrors(loginContext, completionAction.origin);
    if (completionOriginError) {
        _respondWithError(loginContext, completionOriginError);
        return;
    }

    // Ensure any error object is serialized in a useful way and doesn't just render as "{}"
    var oAuthErrorAsString = oAuthError ? oAuthError.toString() : null;

    switch (completionAction.type) {
        case 'postMessage':
            // Browsers that support postMessage properly can use it to send the token back to the window opener
            var postMessageTemplateValues = { origin: completionAction.origin, oauth: oAuthResponse, error: oAuthErrorAsString };
            templating.render(responseCallback, 'loginviapostmessage.html', postMessageTemplateValues, responseHeaders);
            break;
        case 'iframe':
            // IE doesn't support postMessage from popups, so we have to route the message via a hidden iframe
            var iframeTemplateValues = { oauth: oAuthResponse, error: oAuthErrorAsString };
            templating.render(responseCallback, 'loginviaiframe.html', iframeTemplateValues, responseHeaders);
            break;
        default:
            throw new Error('Unknown completion type: ' + completionAction.type);
    }
}

function _validateSingleSignOnRedirectUri(singleSignOnRedirectUri, loginContext) {
    var logger = loginContext.logger,
        packageSid = _getPackageSid(loginContext),
        error = null,
        isValid = true;

    if (!packageSid) {
        error = new Error(resources.packageSidMissing);
        logger.logUser(logSource, LogType.Error, error.message);
    } else if (singleSignOnRedirectUri !== packageSid + '/') {
        error = new Error(resources.ssoRedirectMismatchError);
    }

    if (error) {
        _respondWithError(loginContext, error);
        isValid = false;
    }

    return isValid;
}

// Package sid is required for windows 8 push notifications as well as single sign-on.
// For both the places it is referenced from authenticationCredentials.microsoftaccount.
// microsoftaccount object is therefore not only for authentication provider. 
// It is merely a place to keep microsoft releated creds for push, auth and single sign-on.
function _getPackageSid(loginContext) {
    var microsoftCredentials = loginContext.loginHandler.authenticationCredentials.microsoftaccount;
    var packageSid = microsoftCredentials ? microsoftCredentials.packageSid : null;
    return packageSid;
}

function _validateSingleSignOnRedirectUri(singleSignOnRedirectUri, loginContext) {
    var logger = loginContext.logger,
        packageSid = _getPackageSid(loginContext),
        error = null,
        isValid = true;

    if (!packageSid) {
        error = new Error(resources.packageSidMissing);
        logger.logUser(logSource, LogType.Error, error.message);
    } else if (singleSignOnRedirectUri !== packageSid + '/') {
        error = new Error(resources.ssoRedirectMismatchError);
    }

    if (error) {
        _respondWithError(loginContext, error);
        isValid = false;
    }

    return isValid;
}

// Package sid is required for windows 8 push notifications as well as single sign-on.
// For both the places it is referenced from authenticationCredentials.microsoftaccount.
// microsoftaccount object is therefore not only for authentication provider. 
// It is merely a place to keep microsoft releated creds for push, auth and single sign-on.
function _getPackageSid(loginContext) {
    var microsoftCredentials = loginContext.loginHandler.authenticationCredentials.microsoftaccount;
    var packageSid = microsoftCredentials ? microsoftCredentials.packageSid : null;
    return packageSid;
}

LoginHandler.prototype._createResponseForLoginToken = function (logger, loginContext, authorizationDetails, providerName, callback) {
    this.userService.isEnabled(function (err, usersEnabled) {
        if (err) {
            callback(err);
            return;
        }

        logger.trace(logSource, _.sprintf('Exchanging the %s provider token for a Windows Azure Mobile Services token succeeded.', providerName));
        
        authorizationDetails.userId = _.sprintf('%s:%s', loginContext.provider.name, authorizationDetails.providerId);

        if (usersEnabled) {
            var properties = {
                secrets: authorizationDetails.secrets,
                claims: authorizationDetails.claims
            };

            var providerKey = UserService.getProviderKeyByName(loginContext.provider.name);

            this.userService.addUserIdentity(providerKey, authorizationDetails.providerId, properties, function (err, user) {
                if (err) {
                    callback(err);
                    return;
                }

                authorizationDetails.id = user.id;
                var responseBody = this._createResponseBodyForLoginToken(loginContext, authorizationDetails, usersEnabled);
                responseBody.user.id = user.id;
                callback(null, responseBody);

            }.bind(this));
        }
        else {
            var loginToken = _createLoginTokenFromAuthorizationDetails(loginContext, authorizationDetails, usersEnabled);
            var responseBody = this._createResponseBodyForLoginToken(loginContext, authorizationDetails, usersEnabled);
            callback(null, responseBody);
        }
    }.bind(this));
};

LoginHandler.prototype._createResponseBodyForLoginToken = function (loginContext, authorizationDetails, usersEnabled) {
    var loginToken = _createLoginTokenFromAuthorizationDetails(loginContext, authorizationDetails, usersEnabled);
    var responseBody = {
        user: {
            userId: loginToken.claims.uid
        },
        authenticationToken: loginToken.toString()
    };

    return responseBody;
};

function _createLoginTokenFromAuthorizationDetails(loginContext, authorizationDetails, usersEnabled) {
    var masterKey = loginContext.loginHandler.masterKey;

    var claims = {
        exp: jsonWebToken.createIntDateExpiryFromDays(30),
        iss: 'urn:microsoft:windows-azure:zumo',
        ver: 2, // this claim represents version of the jwt structure and needs to be incremented everytime jwt structure changes.
        aud: loginContext.provider.name,
        uid: authorizationDetails.userId
    };

    if (usersEnabled) {
        claims.id = authorizationDetails.id;
    }
    else {
        var credentialsClaim = _.extend(authorizationDetails.claims, authorizationDetails.secrets);
        claims[jsonWebToken.credentialsClaimName] = credentialsClaim;
    }

    var envelope = {
        alg: 'HS256',
        typ: 'JWT',
        kid: '0'
    };

    return jsonWebToken.create(claims, envelope, masterKey, jsonWebToken.windowsLiveSigningSuffix);
}

function _normalizeRequest(request) {
    // Normalizes the request to support legacy Microsoft Account login
    if (request.verb === 'POST' && !request.authenticationProvider) {
        request.authenticationProvider = 'microsoftaccount';
    } else {
        request.authenticationProvider = request.authenticationProvider.toLowerCase();
    }
}

function _respondWithSuccess(loginContext, body) {
    var responseCallback = loginContext.responseCallback;

    // Ensure that all 'wams' cookies get cleaned up.
    var headers = {};
    _deleteAllUnsetWAMSCookies(loginContext, headers);

    responseCallback(null, body, StatusCodes.OK, headers);
}

function _redirectWithSuccess(loginContext, headers) {
    var responseCallback = loginContext.responseCallback;

    // Ensure that all 'wams' cookies get cleaned up.
    _deleteAllUnsetWAMSCookies(loginContext, headers);

    responseCallback(null, null, StatusCodes.FOUND, headers);
}

function _respondWithError(loginContext, error) {
    var providerName = loginContext.request.authenticationProvider,
        headers = {};

    if (loginContext.provider) {
        // ensure that the metric is logged only after we've validated the provider
        loginContext.metrics.event(_.sprintf('login.provider.%s.error', providerName));
    }

    // Ensure that all 'wams' cookies get cleaned up.
    _deleteAllUnsetWAMSCookies(loginContext, headers);

    if (!(error instanceof core.MobileServiceError)) {
        error = new core.MobileServiceError(error);
    }

    loginContext.responseCallback(error, null, StatusCodes.UNAUTHORIZED, headers);
}

function _redirectWithError(loginContext, error) {
    // Create a redirect URL that includes the error
    var redirectUri = _getFinalRedirectUri(loginContext) + '#error=' + encodeURIComponent(error),
        headers = { Location: redirectUri },
        providerName = loginContext.request.authenticationProvider;

    // Ensure that all 'wams' cookies get cleaned up.
    _deleteAllUnsetWAMSCookies(loginContext, headers);

    // Log the error since we're not returning a MobileServiceError
    var logEntry = 'Error being returned via a redirect URL: ' + error.toString();
    loginContext.logger.log(LogLevel.Verbose, LogType.Information, logSource, logEntry);

    if (loginContext.provider) {
        // ensure that the metric is logged only after we've validated the provider
        loginContext.metrics.event(_.sprintf('login.provider.%s.error', providerName));
    }

    loginContext.responseCallback(null, null, StatusCodes.FOUND, headers);
}

function _parseCookies(headers) {
    // Parse the cookies header if it hasn't been parsed already
    // and cached
    if (!headers._parsedCookies) {
        var cookies = headers.cookie;
        var result = {};
        if (cookies) {
            cookies.split(';').forEach(function (cookie) {
                cookie = cookie.replace(/ /g, '');
                var i = cookie.indexOf('=');
                if (i > 0) {
                    result[cookie.substring(0, i)] = cookie.substring(i + 1);
                }
            });
        }

        headers._parsedCookies = result;
    }

    return headers._parsedCookies;
}

function _deleteAllUnsetWAMSCookies(loginContext, responseHeaders) {
    // Looks at the request to get a list of 'wams_' cookies that were sent with the request and
    // for each cookie, adds to the response headers an explicit delete unless the response
    // headers already have an explicit set for the cookie. So, any cookie sent back to the
    // client from request A will be deleted with request A + 1, unless it was explicitly 
    // set again with request A + 1.

    // Get the cookies sent by the client
    var cookies = _parseCookies(loginContext.request.headers);

    Object.getOwnPropertyNames(cookies).forEach(function (cookieName) {

        // Only delete cookies that begin with 'wams_'
        if (cookieName.indexOf('wams_') === 0) {
            // If the cookie wasn't explicitly set already in the response headers
            if (!LoginHandler.getCookieFromHeaders(cookieName, responseHeaders)) {

                // Set the cookie to deleted
                LoginHandler.addCookieToHeaders(cookieName, 'deleted', responseHeaders);
            }
        }
    });
}

function _isCompletedServerFlow(request) {
    return request.verb === 'GET' && request.authenticationProvider === 'done';
}

function _getFinalRedirectUri(loginContext) {
    // Determine if single sign-on is being used
    var singleSignOnRedirectUri = _getSingleSignOnRedirectUriFromRequest(loginContext);

    // Construct the final redirect URI based on if single sign-on is being used or not.
    return singleSignOnRedirectUri ?
        singleSignOnRedirectUri :
        LoginHandler.RedirectUrlScheme + '://' +
        loginContext.request.headers.host + '/login/done';
}

function _getSingleSignOnRedirectUriFromRequest(loginContext) {
    // Returns the single sign-on redirect URL if the client provided one. The URL Could
    // be in the query string if this request is the first of the two part server flow,
    // or it could be in a cookie if this is the second request in the two-part server flow.
    var request = loginContext.request;
    var redirectUri = null;

    if (request.query && request.query.sso_end_uri) {
        redirectUri = request.query.sso_end_uri;
    } else {
        var encryptedRedirectUri = LoginHandler.getCookieFromHeaders(LoginHandler.SingleSignOnCookieName, request.headers);
        if (encryptedRedirectUri) {
            redirectUri = Encryptor.decrypt(loginContext.loginHandler.masterKey, encryptedRedirectUri);
        }
    }

    if (redirectUri) {
        // Decode the redirectURI and remove any quotes around the value that may
        // have been added by the client (cause cookies are supposed to be quoted).
        redirectUri = decodeURIComponent(redirectUri).replace(/^"|"$/g, "");
    }

    return redirectUri;
}

function _addSingleSignOnCookie(loginContext, singleSignOnRedirectUri, headers) {

    var encryptedRedirectUri = Encryptor.encrypt(loginContext.loginHandler.masterKey, JSON.stringify(singleSignOnRedirectUri));
    LoginHandler.addCookieToHeaders(LoginHandler.SingleSignOnCookieName, encryptedRedirectUri, headers);
}

function _addCompletionActionCookie(completionAction, headers) {
    // We don't need to protect this cookie's data from being seen or tampered with by the user,
    // because it's not secret (they already know the URL they are calling from) and it will
    // be validated at the end of the process before any action is taken on it.
    var cookieValue = JSON.stringify(completionAction);
    LoginHandler.addCookieToHeaders(LoginHandler.CompletionActionCookieName, cookieValue, headers);
}

function _getCompletionActionFromQueryString(query) {
    var completionType = query.completion_type,
        completionOrigin = query.completion_origin;
    if (completionType && completionOrigin) {
        return { type: completionType, origin: completionOrigin };
    } else {
        return null;
    }
}

function _getCompletionActionFromCookie(requestHeaders) {
    // Only browser-initiated flows will have any state to return here
    var cookieValue = LoginHandler.getCookieFromHeaders(LoginHandler.CompletionActionCookieName, requestHeaders);
    return cookieValue ? JSON.parse(cookieValue) : null;
}

// Validates the OAuth redirect state and returns any errors
// RETURNS: An error if the OAuth redirect state wasn't valid, or null if it was valid.
function _getAnyOAuthStateErrors(request) {

    var providerName = request.authenticationProvider;
    var error = null;

    var cookieState = LoginHandler.getCookieFromHeaders(LoginHandler.OAuthStateCookieName, request.headers);
    var queryState = null;
    if (request.query) {
        queryState = request.query.state;
    }

    if (queryState && !cookieState) {
        error = new Error(_.sprintf('Redirect from %s does not contain the required %s cookie.', providerName, LoginHandler.OAuthStateCookieName));
    } else if (!queryState) {
        error = new Error(_.sprintf('Redirect from %s does not contain the required state parameter.', providerName));
    } else {
        queryState = decodeURIComponent(queryState);
        if (cookieState !== queryState) {
            error = new Error(_.sprintf('Redirect from %s does not contain a valid state parameter.', providerName));
        }
    }

    return error;
}

function _validateCompletionOriginForNewServerFlow(completionAction, loginContext) {
    var completionOriginError = _getAnyCompletionOriginErrors(loginContext, completionAction.origin);
    if (completionOriginError) {
        _respondWithError(loginContext, completionOriginError);
        return false;
    }

    return true;
}

function _getAnyCompletionOriginErrors(loginContext, origin) {
    if (!loginContext.corsHelper.isAllowedOrigin(origin)) {
        return new Error("Not a whitelisted origin: " + origin);
    } else {
        // OK
        return null;
    }
}