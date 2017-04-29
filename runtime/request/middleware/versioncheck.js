// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This middleware handler will error out requests from newer clients using the
// new Zumo API Version header and/or querystring
//
// The middleware should be registered early in the pipeline.

module.exports = () => (req, res, next) => {
    var version;

    // Find any casing of zumo-api-version in querystring
    for (var param in req.query) {
        if (param.toLowerCase() === 'zumo-api-version') {
            version = req.query[param];
            break;
        }
    }

    // Fall back to header if not present in querystring
    if (!version) {
        version = req.headers['zumo-api-version'];
    }

    if (version) {
        res.status(400).send('This version (1.0.0) of the server does not support the use of the zumo-api-version in the request.  For more information and supported clients see: http://go.microsoft.com/fwlink/?LinkID=690568#1.0.0').end();
    } else {
        next();            
    }
};