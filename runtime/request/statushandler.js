// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module is for handling requests to http://myapp.azure-mobile.net/status
// which is used by the availability monitoring feature. This endpoint is not
// secured - it can be accessed anonymously.

var StatusCodes = require('../statuscodes').StatusCodes;

exports = module.exports = StatusHandler;

var logSource = 'StatusHandler';

function StatusHandler() {
}

StatusHandler.prototype.handle = function (req, res) {
    var logger = req._context.logger,
        responseCallback = req._context.responseCallback;

    logger.trace(logSource, 'Processing request');

    responseCallback(null, null, StatusCodes.OK);
};