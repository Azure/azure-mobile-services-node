// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module provides a way to asynchronously get Google certs to validate Google id tokens

var LoginHandler = require('../loginhandler.js'),
    certCacheHelper = require('./certcachehelper');

exports = module.exports = GoogleCert;

function GoogleCert(logger) {
    this.logger = logger;
    this.minRefreshIntervalMinutes = 5;
}

// This method returns certs if they are cached. If not cached, it retrieves them from Google
// and caches them. If callback is passed in, certs are returned via the callback.
// Callers can force a cache refresh by specifying refresh = true via the options.
GoogleCert.prototype.getCerts = function (callback, options) {
    if (!callback) {
        throw new Error("GoogleCert.getCerts requires a callback");
    }   
    
    options = options || {};

    if (this.certs) {
        var shouldRefresh = options.refresh && certCacheHelper.refreshIntervalExpired(this.minRefreshIntervalMinutes, this.lastRefresh);
        if (!shouldRefresh) {
            // returned the cached certs
            callback(null, this.certs);
            return;
        }
    }

    var requestOptions = {
        host: 'www.googleapis.com',
        path: '/oauth2/v1/certs',
        method: 'GET'
    };

    var self = this;

    // Make call to get the certs
    LoginHandler.makeSecureRequest(requestOptions, null, function (error, res, body) {
        var result = null;

        // Ensure that the request was successful
        if (!error && res.statusCode !== 200) {
            error = new Error('Bad HTTP status code ' + res.statusCode);
        }
        
        if (error) {            
            callback(new Error('Error retrieving Google public certificates. ' + error), null);     
            return;
        }

        try {
            var parsedCerts = JSON.parse(body);

            self.certs = parsedCerts;
            result = parsedCerts;

            self.lastRefresh = new Date();
        } catch (e) {
            error = new Error('Error retrieving Google public certificates. Cert schema has changed or googlecert.js has a bug. ' + e);
            self.logger.error('googlecert.js', error);
        }

        callback(error, result);
    });
};