// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This middleware handler will redirect clients to use encrypted HTTPS if specified
// As Azure Websites sit behind a reverse proxy based on Application Request Routing (ARR),
// the request will look to express as an HTTP request. ARR will add a HTTP request header
// named x-arr-ssl to indicate to the web server that the request was made over an
// encrypted SSL channel. The request protocol is also checked to enable HTTPS connections
// in a local environment.

// The middleware should be registered very early in the pipeline.

module.exports = function () {
    return function (req, res, next) {
        var secure = req.secure || req.headers['x-arr-ssl'];

        if (!secure) {
            res.status(403).send('HTTPS connections are required for this service. Please update your endpoint to use the https protocol.').end();
        } else {
            next();
        }
    };
};