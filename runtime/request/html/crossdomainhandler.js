// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// Returns files that support cross-domain communication for older browsers. Specifically,
//
// * /crossdomain/bridge 
//   A page that, when hosted in an iframe, will accept postMessage messages from whitelisted
//   origins and will forward them as a same-domain ajax request to the runtime. This is needed
//   for the IframeBridge transport in MobileServices.Web.js, as used by IE8-9.
// * /crossdomain/loginreceiver
//   A page that, when hosted in an iframe, exposes a function that can be invoked from the popup
//   that hosts the login prompt. The function receives the auth token/error and then uses
//   postMessage to pass it back to MobileServices.Web.js in the original page. This is needed
//   for IE (all versions, including 10) because it doesn't otherwise support popup->opener
//   postMessage calls.

exports = module.exports = CrossDomainHandler;

var core = require('../../core'),
    templating = require('./templating'),
    StatusCodes = require('../../statuscodes').StatusCodes,
    logSource = 'CrossDomainHandler';

function CrossDomainHandler(corsHelper) {
    this.corsHelper = corsHelper;
}

CrossDomainHandler.prototype.handle = function (req, res) {
    var logger = req._context.logger,
        responseCallback = req._context.responseCallback;
    
    logger.trace(logSource, 'Processing request');

    switch (req.params.crossDomainItem) {
        case 'bridge':
            var allowedPostMessageOrigin = this._getAllowedOriginFromQueryParams(req, 'origin', responseCallback);
            if (allowedPostMessageOrigin) {
                templating.render(responseCallback, 'crossdomainbridge.html', {
                    origin: allowedPostMessageOrigin
                });
            }
            break;

        case 'loginreceiver':
            // It isn't strictly necessary to validate this origin here, because the receiver frame
            // will only post to its parent when its transferLoginResult function is called, and
            // third-party origins can't call that function. But we validate anyway just in case
            // there is some unanticipated scenario.
            var allowedCompletionOrigin = this._getAllowedOriginFromQueryParams(req, 'completion_origin', responseCallback);
            if (allowedCompletionOrigin) {
                templating.render(responseCallback, 'loginviaiframereceiver.html', {
                    origin: allowedCompletionOrigin
                });
            }
            break;

        default:
            responseCallback(new core.MobileServiceError('Not Found'), null, StatusCodes.NOT_FOUND);
            break;
    }
};

CrossDomainHandler.prototype._getAllowedOriginFromQueryParams = function (request, queryParamName, responseCallback) {
    // This function returns a truthy value only if it satisfies the whitelist
    var queryParams = request.query,
        attemptedOrigin = queryParams && queryParams[queryParamName];

    if (attemptedOrigin && this.corsHelper.isAllowedOrigin(attemptedOrigin)) {
        return attemptedOrigin;
    }
    
    responseCallback(new core.MobileServiceError('Not a whitelisted origin: ' + attemptedOrigin), null, StatusCodes.UNAUTHORIZED);
    return null;
};