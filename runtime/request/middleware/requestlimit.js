
// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This middleware ensures the request size is under the specified byte limit

var StatusCodes = require('../../statuscodes').StatusCodes,
    resources = require('../../resources'),
    core = require('../../core');

var logSource = 'RequestLimit';

exports = module.exports = function requestLimit(maxByteLength) {
    return function (req, res, next) {
        var logger = req._context.logger,
            contentLength = req.headers['content-length'] ? parseInt(req.headers['content-length'], 10) : null,
            responseCallback = req._context.responseCallback,
            receivedByteLength = 0;

        // limit by content-length
        if (contentLength && contentLength > maxByteLength) {
            logError(logger);
            responseCallback(new core.MobileServiceError(resources.maxBodySizeExceeded), null, StatusCodes.REQUEST_ENTITY_TOO_LARGE);
            return;
        }

        // final catch-all limit, in case a content-length
        // hasn't been sent
        req.on('data', function (chunk) {
            receivedByteLength += chunk.length;
            if (receivedByteLength > maxByteLength) {
                logError(logger);
                req.connection.destroy();
            }
        });

        next();
    };
};

function logError(logger) {
    logger.logUser('', 'error', resources.maxBodySizeExceeded);
    logger.trace(logSource, 'Request aborted: ' + resources.maxBodySizeExceeded);
}