// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module has helper functions for working with etags

var resource = require('../resources');

var core = require('../core.js');

ETagHelper = {};

ETagHelper.doesIfNoneMatchHeaderMatchesEtag = (ifNoneMatch, etag) => {
    // an if-none-match header can be a '*' or a comma-seperated list
    // of etage values
    var doesMatch = false;
    if (ifNoneMatch) {

        // check for the wildcard '*' that matches all
        ifNoneMatch = ifNoneMatch.trim();
        if (ifNoneMatch === '*') {
            doesMatch = true;
        }
        else {

            // check each etag in the if-none-match header against
            // the response etag
            ifNoneMatch.split(",").forEach(ifNoneMatchValue => {
                if (ifNoneMatchValue.trim() === etag) {
                    doesMatch = true;
                }
            });
        }
    }

    return doesMatch;
};

ETagHelper.setVersionFromIfMatchHeader = (request, item, tableMetadata, responseCallback) => {
    // check for an if-match header and set the body version
    if (!tableMetadata.supportsConflict) {
        return true;
    }

    try {
        var etag = ETagHelper.parseIfMatchHeader(request);
        if (etag) {
            item.__version = etag;
        }
    }
    catch (err) {
        responseCallback(err);
        return false;
    }

    return true;
};

ETagHelper.parseIfMatchHeader = request => {
    var ifMatch = request.headers["if-match"];
    if (!ifMatch || ifMatch.trim() === '*') {
        return null;
    }

    var etags = [];
    try {
        ifMatch.split(",")
                .forEach(etag => {
                    etag = JSON.parse(etag.trim());
                    if (!core.isString(etag)) {
                        throw new core.MobileServiceError(resource.invalidIfMatchHeader, core.ErrorCodes.BadInput);
                    }
                    etags.push(etag);
                });
    }
    catch (error) {
        throw new core.MobileServiceError(resource.invalidIfMatchHeader, core.ErrorCodes.BadInput);
    }

    if (etags.length > 1) {
        throw new core.MobileServiceError(resource.onlySingleIfMatchHeaderSupported, core.ErrorCodes.BadInput);
    }

    return etags[0];
};

exports = module.exports = ETagHelper;
