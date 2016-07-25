// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This middleware handler will return a 405 "Method Not Allowed" for the specified request,
// setting the Allow header to the specified methods. Express doesn't seem to provide any support
// like this out of the box, so this middleware must be applied to each route with an 'all' specifier.

var StatusCodes = require('../../statuscodes').StatusCodes,
    _ = require('underscore');

// pass in as parameters one or more HTTP methods
// e.g. allowHandler('get', 'post') or allowHandler(['get', 'post'])
exports = module.exports = function allowHandler() {
    var methods;
    if (arguments.length === 1 && _.isArray(arguments[0])) {
        methods = arguments[0];
    }
    else {
        methods = arguments;
    }

    // ensure the methods are all uppercase
     methods = _.map(methods, function (method) {
        return method.toUpperCase();
    });

    var allowHeader  = { 'Allow': methods.join(', ') };

    return function (req, res) {
        req._context.responseCallback(null, null, StatusCodes.METHOD_NOT_ALLOWED, allowHeader);
    };
};